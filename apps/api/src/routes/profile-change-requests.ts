import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf, isHrRole } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import { enqueue } from "../services/notify.js"
import { columnLabel, type ProfileChanges } from "../services/profile-fields.js"

/**
 * 員工自改資料的審核（W6；表 `employee_profile_change_requests`）。
 *
 *   GET  /profile-change-requests?status=        HR 看全部；一般員工只看自己的
 *   POST /profile-change-requests/:id/approve    HR：把 diff 套回 employee_profiles
 *   POST /profile-change-requests/:id/reject     HR：留退回理由
 *
 * 送審那一端在 `routes/employee-profile.ts` 的 `PUT /employees/:empId/profile`
 * （租戶 `features.formParameters.myDataRequiresApproval` 為 true 時）。
 *
 * 清單對一般員工不 403 而是**只回自己的**：ESS「我的資料」要顯示「待審中」
 * 橫幅就需要這個，另開一支 /my/... 只是同一件事多一條路徑。
 */
export const profileChangeRequestsRouter = Router()

const STATUSES = ["pending", "approved", "rejected"] as const
const rejectSchema = z.object({ reason: z.string().trim().min(1).max(500) })

const COLS =
  "id, employee_id, requested_by_emp_id, changes, status, reviewed_by_emp_id, reviewed_at, review_comment, created_at, updated_at"

interface ChangeRequestRow {
  id: string
  employee_id: string
  requested_by_emp_id: string | null
  changes: ProfileChanges | null
  status: string
  reviewed_by_emp_id: string | null
  reviewed_at: string | null
  review_comment: string | null
  created_at: string
  updated_at: string | null
}

/** 員工 id → 姓名（清單顯示用；一次撈完不做 N+1）。 */
async function namesOf(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return new Map()
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", unique)
  if (error) throw new Error(`profile change requests (names): ${error.message}`)
  return new Map((data ?? []).map((row) => [row.id as string, (row.name as string) ?? ""]))
}

function decorate(row: ChangeRequestRow, names: Map<string, string>) {
  const changes = (row.changes ?? {}) as ProfileChanges
  return {
    ...row,
    employeeName: names.get(row.employee_id) ?? null,
    reviewedByName: row.reviewed_by_emp_id ? (names.get(row.reviewed_by_emp_id) ?? null) : null,
    /** 給前端直接顯示，不必在 web 再抄一份欄位中文對照。 */
    fields: Object.entries(changes).map(([col, change]) => ({
      column: col,
      label: columnLabel(col),
      from: change?.from ?? null,
      to: change?.to ?? null,
    })),
  }
}

async function loadRequest(tenantId: string, id: string): Promise<ChangeRequestRow | null> {
  const { data, error } = await supabaseAdmin
    .from("employee_profile_change_requests")
    .select(COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`load profile change request: ${error.message}`)
  return (data as ChangeRequestRow | null) ?? null
}

/**
 * GET /profile-change-requests?status=pending|approved|rejected|all
 * 預設只回 pending（HR 進來就是要看待辦）。
 */
profileChangeRequestsRouter.get(
  "/profile-change-requests",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const statusParam = typeof req.query.status === "string" ? req.query.status : "pending"
      let query = supabaseAdmin
        .from("employee_profile_change_requests")
        .select(COLS)
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(200)
      if (statusParam !== "all") {
        const status = (STATUSES as readonly string[]).includes(statusParam) ? statusParam : "pending"
        query = query.eq("status", status)
      }
      // 一般員工只看得到自己的（ESS 的「待審中」橫幅）。
      if (!isHrRole(self.role)) query = query.eq("employee_id", self.id)

      const { data, error } = await query
      if (error) {
        next(new Error(`GET /profile-change-requests: ${error.message}`))
        return
      }
      const rows = (data ?? []) as ChangeRequestRow[]
      const names = await namesOf(
        tenantId,
        rows.flatMap((r) => [r.employee_id, r.reviewed_by_emp_id ?? ""]),
      )
      res.status(200).json({ requests: rows.map((r) => decorate(r, names)) })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /profile-change-requests/:id/approve — 套用 diff（HR）。
 *
 * 只寫 `changes` 裡的欄位（upsert 的 partial semantics 與 PUT profile 相同），
 * 所以同一段期間 HR 改了別的欄不會被這張單洗掉。`first_name`／`last_name`
 * 在正式庫可能還沒套，沿用 PUT profile 的「失敗就拿掉這兩欄重試」相容寫法。
 */
profileChangeRequestsRouter.post(
  "/profile-change-requests/:id/approve",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    try {
      const request = await loadRequest(tenantId, id)
      if (!request) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (request.status !== "pending") {
        res.status(409).json({ error: "already_reviewed", status: request.status })
        return
      }
      const changes = (request.changes ?? {}) as ProfileChanges
      const cols = Object.keys(changes)
      if (cols.length === 0) {
        res.status(409).json({ error: "empty_changes" })
        return
      }

      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        employee_id: request.employee_id,
        updated_at: new Date().toISOString(),
      }
      for (const col of cols) row[col] = changes[col]?.to ?? null

      let { error } = await supabaseAdmin
        .from("employee_profiles")
        .upsert(row, { onConflict: "tenant_id,employee_id" })
        .select("id")
        .single()
      if (error && ("first_name" in row || "last_name" in row)) {
        delete row.first_name
        delete row.last_name
        error = (
          await supabaseAdmin
            .from("employee_profiles")
            .upsert(row, { onConflict: "tenant_id,employee_id" })
            .select("id")
            .single()
        ).error
      }
      if (error) {
        next(new Error(`approve profile change ${id}: ${error.message}`))
        return
      }

      const reviewer = await resolveSelf(tenantId, req.auth?.userId ?? "")
      const { error: updErr } = await supabaseAdmin
        .from("employee_profile_change_requests")
        .update({
          status: "approved",
          reviewed_by_emp_id: reviewer?.id ?? null,
          reviewed_at: new Date().toISOString(),
          review_comment: typeof req.body?.comment === "string" ? req.body.comment : null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (updErr) {
        next(new Error(`approve profile change ${id} (status): ${updErr.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "employee_profile_change_requests",
        recordId: id,
        action: "UPDATE",
        oldRow: { status: "pending" },
        newRow: { status: "approved", applied: cols },
        actorEmpId: reviewer?.id ?? null,
        context: "POST /profile-change-requests/:id/approve",
      })

      await enqueue({
        tenantId,
        employeeIds: [request.employee_id],
        type: "profile_change_reviewed",
        title: "你的資料異動已核准",
        body: `已更新：${cols.map(columnLabel).join("、")}`,
        payload: { changeRequestId: id, status: "approved", fields: cols },
      })

      res.status(200).json({ id, status: "approved", applied: cols })
    } catch (err) {
      next(err)
    }
  },
)

/** POST /profile-change-requests/:id/reject {reason} — 退回（HR，理由必填）。 */
profileChangeRequestsRouter.post(
  "/profile-change-requests/:id/reject",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = rejectSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required", details: parsed.error.flatten() })
      return
    }
    try {
      const request = await loadRequest(tenantId, id)
      if (!request) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (request.status !== "pending") {
        res.status(409).json({ error: "already_reviewed", status: request.status })
        return
      }
      const reviewer = await resolveSelf(tenantId, req.auth?.userId ?? "")
      const { error } = await supabaseAdmin
        .from("employee_profile_change_requests")
        .update({
          status: "rejected",
          reviewed_by_emp_id: reviewer?.id ?? null,
          reviewed_at: new Date().toISOString(),
          review_comment: parsed.data.reason,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (error) {
        next(new Error(`reject profile change ${id}: ${error.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "employee_profile_change_requests",
        recordId: id,
        action: "UPDATE",
        oldRow: { status: "pending" },
        newRow: { status: "rejected", reason: parsed.data.reason },
        actorEmpId: reviewer?.id ?? null,
        context: "POST /profile-change-requests/:id/reject",
      })

      await enqueue({
        tenantId,
        employeeIds: [request.employee_id],
        type: "profile_change_reviewed",
        title: "你的資料異動被退回",
        body: parsed.data.reason,
        payload: { changeRequestId: id, status: "rejected" },
      })

      res.status(200).json({ id, status: "rejected" })
    } catch (err) {
      next(err)
    }
  },
)
