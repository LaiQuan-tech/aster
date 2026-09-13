import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"
import { toCsv } from "../lib/csv.js"

export const employeeMailboxesRouter = Router()

/**
 * 專屬 Email 配發（HR 專用）。台帳而非代建：信箱在 Google Workspace / Microsoft 365
 * 建，這裡記「給誰、什麼地址、建了沒」，並匯出供應商批次匯入用的 CSV。
 * 狀態機：planned（已配、待建）→ active（可用）→ suspended（停用）。
 * 網域與命名規則存 tenants.features.mail（見 tenant.ts），這裡只驗地址格式與唯一。
 */

const STATUSES = ["planned", "active", "suspended"] as const
const COLS =
  "id, tenant_id, employee_id, address, status, provider, activated_on, suspended_on, note, created_by_emp_id, created_at, updated_at"

const upsertSchema = z.object({
  address: z.string().trim().toLowerCase().email().max(200),
  status: z.enum(STATUSES).optional(),
  provider: z.string().trim().max(40).nullable().optional(),
  activatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  suspendedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
})

function serialize(r: Record<string, unknown>) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    address: r.address,
    status: r.status,
    provider: r.provider ?? null,
    activatedOn: r.activated_on ?? null,
    suspendedOn: r.suspended_on ?? null,
    note: r.note ?? null,
    updatedAt: r.updated_at,
  }
}

// ── GET /employee-mailboxes — HR：全租戶台帳 ───────────────────────────
employeeMailboxesRouter.get(
  "/employee-mailboxes",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("employee_mailboxes")
        .select(COLS)
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true })
      if (error) {
        next(new Error(`GET /employee-mailboxes: ${error.message}`))
        return
      }
      res.status(200).json({ mailboxes: (data ?? []).map((r) => serialize(r as Record<string, unknown>)) })
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /employee-mailboxes/:employeeId — HR：建立或更新該員工的信箱 ────
employeeMailboxesRouter.put(
  "/employee-mailboxes/:employeeId",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const employeeId = req.params.employeeId as string
    const parsed = upsertSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const { data: emp } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", employeeId)
        .maybeSingle()
      if (!emp) {
        res.status(404).json({ error: "employee_not_found" })
        return
      }
      // 同租戶內地址不可重複（唯一索引兜底，這裡先給明確錯誤）
      const { data: dup } = await supabaseAdmin
        .from("employee_mailboxes")
        .select("employee_id")
        .eq("tenant_id", tenantId)
        .eq("address", parsed.data.address)
        .neq("employee_id", employeeId)
        .maybeSingle()
      if (dup) {
        res.status(409).json({ error: "address_taken" })
        return
      }
      const self = userId ? await resolveSelf(tenantId, userId) : null
      const b = parsed.data
      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        employee_id: employeeId,
        address: b.address,
        updated_at: new Date().toISOString(),
      }
      if (b.status !== undefined) row.status = b.status
      if (b.provider !== undefined) row.provider = b.provider
      if (b.activatedOn !== undefined) row.activated_on = b.activatedOn
      if (b.suspendedOn !== undefined) row.suspended_on = b.suspendedOn
      if (b.note !== undefined) row.note = b.note
      // 狀態變 active／suspended 而沒給日期 → 補今天，台帳才有時間點
      const today = new Date().toISOString().slice(0, 10)
      if (b.status === "active" && b.activatedOn === undefined) row.activated_on = today
      if (b.status === "suspended" && b.suspendedOn === undefined) row.suspended_on = today
      const { data: existing } = await supabaseAdmin
        .from("employee_mailboxes")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("employee_id", employeeId)
        .maybeSingle()
      if (!existing) row.created_by_emp_id = self?.id ?? null
      const { data, error } = await supabaseAdmin
        .from("employee_mailboxes")
        .upsert(row, { onConflict: "tenant_id,employee_id" })
        .select(COLS)
        .single()
      if (error || !data) {
        next(new Error(`PUT /employee-mailboxes/${employeeId}: ${error?.message}`))
        return
      }
      res.status(200).json({ mailbox: serialize(data as Record<string, unknown>) })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /employee-mailboxes/export — HR：Google Workspace 批次匯入格式 CSV ─
// 欄位照 Google Admin「批次上傳使用者」範本；Microsoft 365 的欄位不同，
// 由 ?provider=microsoft 切換。只匯 planned（還沒建的）。
employeeMailboxesRouter.get(
  "/employee-mailboxes/export",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const provider = req.query.provider === "microsoft" ? "microsoft" : "google"
    try {
      const [{ data: boxes, error: e1 }, { data: emps, error: e2 }] = await Promise.all([
        supabaseAdmin.from("employee_mailboxes").select(COLS).eq("tenant_id", tenantId).eq("status", "planned"),
        supabaseAdmin.from("employees").select("id, name, emp_no, dept_id").eq("tenant_id", tenantId),
      ])
      if (e1 || e2) {
        next(new Error(`GET /employee-mailboxes/export: ${e1?.message ?? e2?.message}`))
        return
      }
      const empById = new Map((emps ?? []).map((e) => [e.id as string, e]))
      const rows = (boxes ?? []).map((b) => {
        const e = empById.get(b.employee_id as string)
        const name = (e?.name as string) ?? ""
        // 中文姓名：第一個字當姓、其餘當名；供應商欄位必填，之後可在後台改
        const last = name.slice(0, 1)
        const first = name.slice(1) || name
        return provider === "google"
          ? { "First Name [Required]": first, "Last Name [Required]": last, "Email Address [Required]": b.address, "Password [Required]": "", "Org Unit Path [Required]": "/" }
          : { "User name": b.address, "First name": first, "Last name": last, "Display name": name, "Job title": "", Department: "", "Office number": "", "Office phone": "", "Mobile phone": "", Fax: "", "Alternate email address": "", Address: "", City: "", "State or province": "", "ZIP or postal code": "", "Country or region": "" }
      })
      const columns = Object.keys(rows[0] ?? (provider === "google"
        ? { "First Name [Required]": "", "Last Name [Required]": "", "Email Address [Required]": "", "Password [Required]": "", "Org Unit Path [Required]": "" }
        : { "User name": "", "First name": "", "Last name": "", "Display name": "" })).map((k) => ({ key: k, label: k }))
      const csv = toCsv(rows as Array<Record<string, unknown>>, columns)
      res.setHeader("content-type", "text/csv; charset=utf-8")
      res.setHeader("content-disposition", `attachment; filename="mailboxes_${provider}.csv"`)
      res.status(200).send("﻿" + csv)
    } catch (err) {
      next(err)
    }
  },
)
