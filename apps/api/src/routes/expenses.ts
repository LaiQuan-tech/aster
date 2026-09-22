import crypto from "node:crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin, requireFinance } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { isFinanceRole } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"

export const expensesRouter = Router()

/** 憑證的私有 bucket。⚠️ 需先在 Supabase 建立（同 request-attachments）。 */
const RECEIPT_BUCKET = "expense-receipts"
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024

const NATURES = ["reimbursement", "allowance"] as const
const dateRe = /^\d{4}-\d{2}-\d{2}$/
const periodRe = /^\d{4}-\d{2}$/

const categorySchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(100),
  nature: z.enum(NATURES).optional(),
  requiresReceipt: z.boolean().optional(),
  crossCheckAttendance: z.boolean().optional(),
  requiresTripApproval: z.boolean().optional(),
  monthlyCap: z.number().nonnegative().optional(),
  active: z.boolean().optional(),
})

const claimSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().positive(),
  incurredOn: z.string().regex(dateRe),
  /** 省略時由 incurredOn 推導（發生月）。遲交的單可明確指定歸屬期。 */
  period: z.string().regex(periodRe).optional(),
  note: z.string().trim().max(250).optional(),
  /** HR 代填；非 HR 給了會 403。 */
  onBehalfOfEmployeeId: z.string().uuid().optional(),
  /**
   * 綁定的出差單（模組三第 2 條）。類別的 `requires_trip_approval` 為 true
   * 時必填，且該單須為本人、已核准的 business_trip。
   */
  tripRequestId: z.string().uuid().optional(),
  /**
   * 這筆費用用哪一筆預支的錢付的（模組三第 2、3 條的沖抵連結）。
   * 出差軌若該趟已有預支，省略時由系統自動綁上；零用金必須明指。
   */
  advanceId: z.string().uuid().optional(),
})

const claimPatchSchema = z.object({
  amount: z.number().positive().optional(),
  incurredOn: z.string().regex(dateRe).optional(),
  note: z.string().trim().max(250).optional(),
  status: z.enum(["cancelled", "rejected"]).optional(),
  statusReason: z.string().trim().min(1).max(250).optional(),
  /** 僅 HR：覆寫稅務性質（會進 audit_logs）。 */
  nature: z.enum(NATURES).optional(),
})

const receiptSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
})

const CLAIM_COLS =
  "id, tenant_id, employee_id, category_id, nature, amount, incurred_on, period, note, " +
  "status, status_reason, settlement_id, trip_request_id, advance_id, created_at, updated_at"

/**
 * Expense routes — 常態日常支出報銷（模組三第 1 條）。
 *
 * 客戶要的是「同仁線上勾選填報、月結一次性核銷、**不需逐筆事前審核**」。
 * 故本模組刻意沒有簽核鏈：單子送出即 `submitted`，月結時一次轉 `settled`。
 *
 * **省掉的是事前審核，不是憑證。** 稅上要主張「非所得的代墊費用」需要憑證，
 * 營所稅列費用也需要憑證，沒有憑證的給付國稅局傾向認定為薪資。
 * 月結時管理者核的是「這批有沒有問題」——`GET /expense-settlements/:period/review`
 * 就是讓那一次審得有意義的清單。
 */

async function resolveSelf(
  tenantId: string,
  userId?: string,
): Promise<{ id: string; role: string } | null> {
  if (!userId) return null
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`expenses resolve self: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

/**
 * 管理端視角（W4，2026-09-23）：HR／平台管理員**＋會計**。業主決策 3 明訂會計
 * 可用報銷與預支，所以這裡不再只看 HR——名稱保留 `isHr` 會誤導，改叫 isFinance。
 * 清單集中在 middleware/scope.ts 的 FINANCE_ROLES。
 */
function isFinance(role?: string): boolean {
  return isFinanceRole(role)
}

/** 該期是否已核銷（已核銷即鎖定，不得再增減）。 */
async function periodIsSettled(tenantId: string, period: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("expense_settlements")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .maybeSingle()
  if (error) throw new Error(`expenses period status: ${error.message}`)
  return data?.status === "settled"
}

// ── 類別目錄 ─────────────────────────────────────────────────────────

/** GET /expense-categories — 供填報畫面下拉；所有員工可讀。 */
expensesRouter.get(
  "/expense-categories",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("expense_categories")
        .select("id, code, name, nature, requires_receipt, cross_check_attendance, requires_trip_approval, monthly_cap, active")
        .eq("tenant_id", tenantId)
        .order("code", { ascending: true })
      if (error) {
        next(new Error(`GET /expense-categories: ${error.message}`))
        return
      }
      res.status(200).json({ categories: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PUT /expense-categories — HR 建立或更新一個類別（以 code 為鍵）。
 *
 * `nature` 是本模組最關鍵的欄位：'reimbursement' 實報實銷（非所得、
 * 不計投保薪資、不進 gross）vs 'allowance' 定額補貼（屬薪資所得、
 * 應計入投保薪資、進 gross）。設錯等於漏報薪資所得 ＋ 高薪低報，
 * 故變更一律進 audit_logs。
 */
expensesRouter.put(
  "/expense-categories",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = categorySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const { data: before } = await supabaseAdmin
        .from("expense_categories")
        .select("id, nature")
        .eq("tenant_id", tenantId)
        .eq("code", parsed.data.code)
        .maybeSingle()

      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        code: parsed.data.code,
        name: parsed.data.name,
      }
      if (parsed.data.nature !== undefined) row.nature = parsed.data.nature
      if (parsed.data.requiresReceipt !== undefined) row.requires_receipt = parsed.data.requiresReceipt
      if (parsed.data.crossCheckAttendance !== undefined)
        row.cross_check_attendance = parsed.data.crossCheckAttendance
      if (parsed.data.requiresTripApproval !== undefined)
        row.requires_trip_approval = parsed.data.requiresTripApproval
      if (parsed.data.monthlyCap !== undefined) row.monthly_cap = parsed.data.monthlyCap
      if (parsed.data.active !== undefined) row.active = parsed.data.active

      const { data, error } = await supabaseAdmin
        .from("expense_categories")
        .upsert(row, { onConflict: "tenant_id,code" })
        .select("id, code, nature")
        .single()
      if (error || !data) {
        next(new Error(`PUT /expense-categories: ${error?.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "expense_categories",
        recordId: data.id as string,
        action: before ? "UPDATE" : "INSERT",
        oldRow: before ? { nature: before.nature } : undefined,
        newRow: { code: data.code, nature: data.nature },
        actorEmpId: self?.id,
        context: "PUT /expense-categories",
      })

      res.status(200).json({ category: data })
    } catch (err) {
      next(err)
    }
  },
)

// ── 單筆填報 ─────────────────────────────────────────────────────────

/**
 * POST /expenses — 同仁填報一筆日常支出（無事前審核，送出即 submitted）。
 *
 * `nature` 由類別帶入並**凍結在單上**：類別的預設性質日後可能調整，
 * 但已送出的單必須保留當時的稅務認定，否則無從追溯。
 *
 * `period` 省略時由 `incurredOn` 推導。兩者刻意分開：上月的收據這月才交時，
 * 歸屬期是本月，但發生日仍是上月——發生日是「報銷 × 出勤交叉檢核」的比對鍵。
 */
expensesRouter.post(
  "/expenses",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = claimSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      if (parsed.data.onBehalfOfEmployeeId && !isFinance(self.role)) {
        res.status(403).json({ error: "hr_admin_required" })
        return
      }
      const employeeId = parsed.data.onBehalfOfEmployeeId ?? self.id
      const period = parsed.data.period ?? parsed.data.incurredOn.slice(0, 7)

      if (await periodIsSettled(tenantId, period)) {
        res.status(409).json({ error: "period_settled", period })
        return
      }

      const { data: cat, error: catErr } = await supabaseAdmin
        .from("expense_categories")
        .select("id, nature, active, requires_trip_approval")
        .eq("tenant_id", tenantId)
        .eq("id", parsed.data.categoryId)
        .maybeSingle()
      if (catErr) {
        next(new Error(`POST /expenses (category): ${catErr.message}`))
        return
      }
      if (!cat || cat.active === false) {
        res.status(400).json({ error: "invalid_category" })
        return
      }

      // ── 兩軌政策的閘門（模組三第 1 條 vs 第 2 條）────────────────────
      // 日常常態不事前審核；長途出差必須老闆簽核。**沒有這道檢查，出差費用
      // 可以拆成「日常」報銷繞過事前審核，第 2 條即形同虛設。**
      if (cat.requires_trip_approval === true) {
        if (!parsed.data.tripRequestId) {
          res.status(400).json({ error: "trip_request_required" })
          return
        }
        const { data: trip, error: tripErr } = await supabaseAdmin
          .from("leave_requests")
          .select("id, kind, status, employee_id")
          .eq("tenant_id", tenantId)
          .eq("id", parsed.data.tripRequestId)
          .is("deleted_at", null)
          .maybeSingle()
        if (tripErr) {
          next(new Error(`POST /expenses (trip): ${tripErr.message}`))
          return
        }
        // 不區分「不存在」「非出差單」「非本人」「未核准」——一律同一個錯誤，
        // 免得成為探測他人單號的管道。
        if (
          !trip ||
          trip.kind !== "business_trip" ||
          trip.status !== "approved" ||
          trip.employee_id !== employeeId
        ) {
          res.status(400).json({ error: "invalid_trip_request" })
          return
        }
      }

      // 沖抵連結：出差軌若該趟已開預支，未明指時自動綁上——同仁沒有理由
      // 記得自己的預支單號，而漏綁會讓核銷算不到這筆、差額算錯。
      let advanceId = parsed.data.advanceId ?? null
      if (!advanceId && parsed.data.tripRequestId) {
        const { data: adv, error: advErr } = await supabaseAdmin
          .from("advances")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("request_id", parsed.data.tripRequestId)
          .eq("employee_id", employeeId)
          .in("status", ["requested", "paid"])
          .maybeSingle()
        if (advErr) {
          next(new Error(`POST /expenses (advance): ${advErr.message}`))
          return
        }
        advanceId = (adv?.id as string | undefined) ?? null
      }

      const { data, error } = await supabaseAdmin
        .from("expense_claims")
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          category_id: parsed.data.categoryId,
          nature: cat.nature, // 凍結當時的稅務性質
          amount: parsed.data.amount,
          incurred_on: parsed.data.incurredOn,
          period,
          note: parsed.data.note ?? null,
          status: "submitted",
          trip_request_id: parsed.data.tripRequestId ?? null,
          advance_id: advanceId,
        })
        .select("id, period, nature")
        .single()
      if (error || !data) {
        next(new Error(`POST /expenses: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id, period: data.period, nature: data.nature })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /expenses?period=&employeeId=&status= — 非 HR 一律鎖定本人。 */
expensesRouter.get(
  "/expenses",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const q = z
      .object({
        period: z.string().regex(periodRe).optional(),
        employeeId: z.string().uuid().optional(),
        status: z.string().trim().optional(),
      })
      .safeParse(req.query)
    if (!q.success) {
      res.status(400).json({ error: "invalid_query", details: q.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      let query = supabaseAdmin.from("expense_claims").select(CLAIM_COLS).eq("tenant_id", tenantId)

      if (isFinance(self?.role)) {
        if (q.data.employeeId) query = query.eq("employee_id", q.data.employeeId)
      } else {
        // 非 HR：無論傳什麼 employeeId 都鎖定本人。
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }
      if (q.data.period) query = query.eq("period", q.data.period)
      if (q.data.status) query = query.eq("status", q.data.status)

      const { data, error } = await query.order("incurred_on", { ascending: false })
      if (error) {
        next(new Error(`GET /expenses: ${error.message}`))
        return
      }
      res.status(200).json({ claims: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PATCH /expenses/:id — 修改或撤回自己尚未核銷的單；HR 可改任何人的，
 * 且只有 HR 能覆寫 `nature`（稅務性質，變更進 audit_logs）。
 * 已核銷（settled）的單一律不可改——那一期的錢已經結出去了。
 */
expensesRouter.patch(
  "/expenses/:id",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = claimPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const { data: claim, error: loadErr } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id, status, nature, amount")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`PATCH /expenses/${id} (load): ${loadErr.message}`))
        return
      }
      if (!claim) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const hr = isFinance(self.role)
      if (!hr && claim.employee_id !== self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (claim.status === "settled") {
        res.status(409).json({ error: "already_settled" })
        return
      }
      if (parsed.data.nature !== undefined && !hr) {
        res.status(403).json({ error: "hr_admin_required" })
        return
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (parsed.data.amount !== undefined) patch.amount = parsed.data.amount
      if (parsed.data.incurredOn !== undefined) patch.incurred_on = parsed.data.incurredOn
      if (parsed.data.note !== undefined) patch.note = parsed.data.note
      if (parsed.data.status !== undefined) patch.status = parsed.data.status
      if (parsed.data.statusReason !== undefined) patch.status_reason = parsed.data.statusReason
      if (parsed.data.nature !== undefined) patch.nature = parsed.data.nature

      const { error } = await supabaseAdmin
        .from("expense_claims")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (error) {
        next(new Error(`PATCH /expenses/${id}: ${error.message}`))
        return
      }

      if (parsed.data.nature !== undefined && parsed.data.nature !== claim.nature) {
        // 稅務性質被改＝這筆錢的課稅與投保歸屬改變，必須留痕。
        await writeAuditLog({
          tenantId,
          tableName: "expense_claims",
          recordId: id,
          action: "UPDATE",
          oldRow: { nature: claim.nature },
          newRow: { nature: parsed.data.nature },
          actorEmpId: self.id,
          context: "PATCH /expenses/:id (nature override)",
        })
      }

      res.status(200).json({ id })
    } catch (err) {
      next(err)
    }
  },
)

// ── 憑證 ─────────────────────────────────────────────────────────────

/**
 * POST /expenses/:id/attachments — 上傳憑證（發票／收據／悠遊卡明細）。
 * 本人或 HR 皆可；已核銷的單不可再加。
 */
expensesRouter.post(
  "/expenses/:id/attachments",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const claimId = req.params.id as string
    const parsed = receiptSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      if (!self) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const { data: claim, error: loadErr } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id, status")
        .eq("tenant_id", tenantId)
        .eq("id", claimId)
        .maybeSingle()
      if (loadErr) {
        next(new Error(`POST receipts (load): ${loadErr.message}`))
        return
      }
      if (!claim) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!isFinance(self.role) && claim.employee_id !== self.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (claim.status === "settled") {
        res.status(409).json({ error: "already_settled" })
        return
      }

      let bytes: Buffer
      try {
        bytes = Buffer.from(parsed.data.dataBase64, "base64")
      } catch {
        res.status(400).json({ error: "invalid_base64" })
        return
      }
      if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_RECEIPT_BYTES })
        return
      }

      const ext = (parsed.data.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
      const path = `${tenantId}/${claimId}/${crypto.randomUUID()}${ext}`
      const { error: upErr } = await supabaseAdmin.storage
        .from(RECEIPT_BUCKET)
        .upload(path, bytes, { contentType: parsed.data.contentType })
      if (upErr) {
        next(new Error(`POST receipts (upload): ${upErr.message}`))
        return
      }

      const { data: row, error: insErr } = await supabaseAdmin
        .from("expense_claim_attachments")
        .insert({
          tenant_id: tenantId,
          claim_id: claimId,
          file_name: parsed.data.fileName,
          storage_path: path,
          size_bytes: bytes.length,
          content_type: parsed.data.contentType,
          content_hash: crypto.createHash("sha256").update(bytes).digest("hex"),
        })
        .select("id")
        .single()
      if (insErr || !row) {
        await supabaseAdmin.storage.from(RECEIPT_BUCKET).remove([path])
        next(new Error(`POST receipts (insert): ${insErr?.message}`))
        return
      }
      res.status(201).json({ id: row.id, sizeBytes: bytes.length })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /expenses/:id/attachments — 憑證清單（含短效期 signed URL）。 */
expensesRouter.get(
  "/expenses/:id/attachments",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const claimId = req.params.id as string
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const { data: claim } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id")
        .eq("tenant_id", tenantId)
        .eq("id", claimId)
        .maybeSingle()
      if (!claim) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!isFinance(self?.role) && claim.employee_id !== self?.id) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const { data, error } = await supabaseAdmin
        .from("expense_claim_attachments")
        .select("id, file_name, storage_path, size_bytes, content_type, content_hash, created_at")
        .eq("tenant_id", tenantId)
        .eq("claim_id", claimId)
        .order("created_at", { ascending: true })
      if (error) {
        next(new Error(`GET receipts: ${error.message}`))
        return
      }
      const attachments = await Promise.all(
        (data ?? []).map(async (r) => {
          const { data: signed } = await supabaseAdmin.storage
            .from(RECEIPT_BUCKET)
            .createSignedUrl(r.storage_path as string, 3600)
          return {
            id: r.id,
            fileName: r.file_name,
            sizeBytes: r.size_bytes,
            contentType: r.content_type,
            contentHash: r.content_hash,
            url: signed?.signedUrl ?? null,
          }
        }),
      )
      res.status(200).json({ attachments })
    } catch (err) {
      next(err)
    }
  },
)

// ── 月結核銷 ─────────────────────────────────────────────────────────

/**
 * GET /expense-settlements/:period/review — **月結前的審視清單**（HR）。
 *
 * 客戶要「不需逐筆事前審核」——那一次月結審核才有意義的前提，是系統先把
 * 該看的挑出來。三類異常：
 *
 *   1. `missingReceipt` — 類別要求憑證卻沒附。沒有憑證的給付，
 *      國稅局傾向認定為薪資，這批不處理掉，核銷等於埋雷。
 *   2. `overCap` — 該員該類別本期合計超過月限額。不擋填報，只標示。
 *   3. `attendanceMismatch` — **報銷 × 出勤交叉檢核**。類別設了
 *      `cross_check_attendance`（夜間計程車這類）而報銷當日該員無加班紀錄。
 *      報銷單據在勞檢與訴訟中會被用來證明實際工時：出勤顯示 18:00 下班、
 *      同日卻有 23:30 的車資，兩份紀錄互相矛盾，而矛盾比單純漏記更難解釋。
 *      標出來讓 HR 決定是補工時還是退件。
 */
expensesRouter.get(
  "/expense-settlements/:period/review",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const period = req.params.period as string
    if (!periodRe.test(period)) {
      res.status(400).json({ error: "invalid_period" })
      return
    }
    try {
      const { data: claims, error } = await supabaseAdmin
        .from("expense_claims")
        .select("id, employee_id, category_id, nature, amount, incurred_on, status")
        .eq("tenant_id", tenantId)
        .eq("period", period)
        .eq("status", "submitted")
      if (error) {
        next(new Error(`GET review (claims): ${error.message}`))
        return
      }
      const rows = claims ?? []
      if (rows.length === 0) {
        res.status(200).json({
          period,
          claimCount: 0,
          reimbursementTotal: 0,
          allowanceTotal: 0,
          issues: { missingReceipt: [], overCap: [], attendanceMismatch: [] },
        })
        return
      }

      const { data: cats } = await supabaseAdmin
        .from("expense_categories")
        .select("id, code, name, requires_receipt, cross_check_attendance, monthly_cap")
        .eq("tenant_id", tenantId)
      const catById = new Map((cats ?? []).map((c) => [c.id as string, c]))

      // 1) 缺憑證
      const claimIds = rows.map((r) => r.id as string)
      const { data: atts } = await supabaseAdmin
        .from("expense_claim_attachments")
        .select("claim_id")
        .eq("tenant_id", tenantId)
        .in("claim_id", claimIds)
      const withReceipt = new Set((atts ?? []).map((a) => a.claim_id as string))
      const missingReceipt = rows
        .filter((r) => catById.get(r.category_id as string)?.requires_receipt !== false)
        .filter((r) => !withReceipt.has(r.id as string))
        .map((r) => ({ claimId: r.id, employeeId: r.employee_id, amount: Number(r.amount) }))

      // 2) 超月限額（以 員工 × 類別 合計）
      const totalsByEmpCat = new Map<string, number>()
      for (const r of rows) {
        const key = `${r.employee_id}|${r.category_id}`
        totalsByEmpCat.set(key, (totalsByEmpCat.get(key) ?? 0) + Number(r.amount))
      }
      const overCap: Array<Record<string, unknown>> = []
      for (const [key, total] of totalsByEmpCat) {
        const [employeeId, categoryId] = key.split("|")
        const cap = catById.get(categoryId)?.monthly_cap
        if (cap !== null && cap !== undefined && total > Number(cap)) {
          overCap.push({ employeeId, categoryId, total, cap: Number(cap) })
        }
      }

      // 3) 報銷 × 出勤交叉檢核（見端點說明）
      const crossRows = rows.filter(
        (r) => catById.get(r.category_id as string)?.cross_check_attendance === true,
      )
      const attendanceMismatch: Array<Record<string, unknown>> = []
      if (crossRows.length > 0) {
        const dates = Array.from(new Set(crossRows.map((r) => r.incurred_on as string)))
        const empIds = Array.from(new Set(crossRows.map((r) => r.employee_id as string)))
        const { data: days } = await supabaseAdmin
          .from("attendance_days")
          .select("employee_id, work_date, overtime_minutes")
          .eq("tenant_id", tenantId)
          .in("employee_id", empIds)
          .in("work_date", dates)
        const otByKey = new Map(
          (days ?? []).map((d) => [
            `${d.employee_id}|${d.work_date}`,
            Number(d.overtime_minutes ?? 0),
          ]),
        )
        for (const r of crossRows) {
          const key = `${r.employee_id}|${r.incurred_on}`
          const ot = otByKey.get(key)
          if (ot === undefined || ot <= 0) {
            attendanceMismatch.push({
              claimId: r.id,
              employeeId: r.employee_id,
              incurredOn: r.incurred_on,
              amount: Number(r.amount),
              overtimeMinutes: ot ?? null,
              hint:
                ot === undefined
                  ? "該日無出勤結算紀錄"
                  : "該日結算的加班時數為 0",
            })
          }
        }
      }

      const reimbursementTotal = rows
        .filter((r) => r.nature === "reimbursement")
        .reduce((a, r) => a + Number(r.amount), 0)
      const allowanceTotal = rows
        .filter((r) => r.nature === "allowance")
        .reduce((a, r) => a + Number(r.amount), 0)

      res.status(200).json({
        period,
        claimCount: rows.length,
        reimbursementTotal,
        allowanceTotal,
        issues: { missingReceipt, overCap, attendanceMismatch },
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /expense-settlements/:period/settle — 管理者一次性核銷（HR）。
 *
 * 把該期所有 `submitted` 的單轉 `settled` 並掛上批次，該期即鎖定
 * （之後不得再增減，比照 payslips 的 finalized）。
 *
 * ⚠️ **順序**：報銷若隨薪資發放，本動作必須在 `POST /payroll/run` **之前**
 * 執行——核銷後才補的單不會進當期薪資。
 *
 * 兩個合計分開存，因為在薪資引擎走不同路徑：
 * reimbursement → `expenses`（不進 gross）；allowance → `allowances`（進 gross）。
 */
expensesRouter.post(
  "/expense-settlements/:period/settle",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const period = req.params.period as string
    if (!periodRe.test(period)) {
      res.status(400).json({ error: "invalid_period" })
      return
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : null

    try {
      if (await periodIsSettled(tenantId, period)) {
        res.status(409).json({ error: "already_settled", period })
        return
      }
      const self = await resolveSelf(tenantId, req.auth?.userId)

      const { data: claims, error } = await supabaseAdmin
        .from("expense_claims")
        .select("id, nature, amount")
        .eq("tenant_id", tenantId)
        .eq("period", period)
        .eq("status", "submitted")
      if (error) {
        next(new Error(`POST settle (claims): ${error.message}`))
        return
      }
      const rows = claims ?? []
      const reimbursementTotal = rows
        .filter((r) => r.nature === "reimbursement")
        .reduce((a, r) => a + Number(r.amount), 0)
      const allowanceTotal = rows
        .filter((r) => r.nature === "allowance")
        .reduce((a, r) => a + Number(r.amount), 0)

      const { data: settlement, error: setErr } = await supabaseAdmin
        .from("expense_settlements")
        .upsert(
          {
            tenant_id: tenantId,
            period,
            status: "settled",
            reimbursement_total: reimbursementTotal,
            allowance_total: allowanceTotal,
            claim_count: rows.length,
            note,
            settled_by_emp_id: self?.id ?? null,
            settled_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,period" },
        )
        .select("id")
        .single()
      if (setErr || !settlement) {
        next(new Error(`POST settle (settlement): ${setErr?.message}`))
        return
      }

      if (rows.length > 0) {
        const { error: upErr } = await supabaseAdmin
          .from("expense_claims")
          .update({
            status: "settled",
            settlement_id: settlement.id,
            updated_at: new Date().toISOString(),
          })
          .eq("tenant_id", tenantId)
          .eq("period", period)
          .eq("status", "submitted")
        if (upErr) {
          next(new Error(`POST settle (claims update): ${upErr.message}`))
          return
        }
      }

      await writeAuditLog({
        tenantId,
        tableName: "expense_settlements",
        recordId: settlement.id as string,
        action: "UPDATE",
        newRow: { period, reimbursementTotal, allowanceTotal, claimCount: rows.length },
        actorEmpId: self?.id,
        context: "POST /expense-settlements/:period/settle",
      })

      res.status(200).json({
        period,
        settlementId: settlement.id,
        claimCount: rows.length,
        reimbursementTotal,
        allowanceTotal,
      })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /expense-settlements?period= — 核銷批次狀態。 */
expensesRouter.get(
  "/expense-settlements",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      let query = supabaseAdmin
        .from("expense_settlements")
        .select("id, period, status, reimbursement_total, allowance_total, claim_count, note, settled_at")
        .eq("tenant_id", tenantId)
      const period = typeof req.query.period === "string" ? req.query.period : null
      if (period) query = query.eq("period", period)
      const { data, error } = await query.order("period", { ascending: false })
      if (error) {
        next(new Error(`GET /expense-settlements: ${error.message}`))
        return
      }
      res.status(200).json({ settlements: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

// ── 模組設定 ─────────────────────────────────────────────────────────

const settingsSchema = z.object({
  advanceThreshold: z.number().nonnegative().optional(),
  advanceOverdueDays: z.number().int().positive().optional(),
})

const DEFAULT_SETTINGS = { advanceThreshold: 5000, advanceOverdueDays: 30 }

/**
 * GET /expense-settings — 報銷模組的租戶級參數。
 *
 * 開放給所有員工讀取：ESS 端要用 `advanceThreshold` 顯示提示
 * （「此金額低於建議門檻，仍可申請」）。沒有設定列時回預設值，
 * 讓租戶不必先設定就能用。
 */
expensesRouter.get(
  "/expense-settings",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("expense_settings")
        .select("advance_threshold, advance_overdue_days")
        .eq("tenant_id", tenantId)
        .maybeSingle()
      if (error) {
        next(new Error(`GET /expense-settings: ${error.message}`))
        return
      }
      res.status(200).json({
        settings: {
          advanceThreshold: data
            ? Number(data.advance_threshold)
            : DEFAULT_SETTINGS.advanceThreshold,
          advanceOverdueDays: data
            ? Number(data.advance_overdue_days)
            : DEFAULT_SETTINGS.advanceOverdueDays,
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PUT /expense-settings — HR 調整門檻。
 *
 * **門檻是提示，不是閘門**（使用者裁示）：低於門檻的預支申請會被標示，
 * 但不擋——有人可能正當需要低於門檻的預支，由簽核者判斷。
 */
expensesRouter.put(
  "/expense-settings",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = await resolveSelf(tenantId, req.auth?.userId)
      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        updated_at: new Date().toISOString(),
      }
      if (parsed.data.advanceThreshold !== undefined)
        row.advance_threshold = parsed.data.advanceThreshold
      if (parsed.data.advanceOverdueDays !== undefined)
        row.advance_overdue_days = parsed.data.advanceOverdueDays

      const { data, error } = await supabaseAdmin
        .from("expense_settings")
        .upsert(row, { onConflict: "tenant_id" })
        .select("advance_threshold, advance_overdue_days")
        .single()
      if (error || !data) {
        next(new Error(`PUT /expense-settings: ${error?.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "expense_settings",
        action: "UPDATE",
        newRow: parsed.data,
        actorEmpId: self?.id,
        context: "PUT /expense-settings",
      })

      res.status(200).json({
        settings: {
          advanceThreshold: Number(data.advance_threshold),
          advanceOverdueDays: Number(data.advance_overdue_days),
        },
      })
    } catch (err) {
      next(err)
    }
  },
)
