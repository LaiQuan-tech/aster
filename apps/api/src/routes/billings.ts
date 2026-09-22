import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import {
  BILLING_COLS,
  contractTotal,
  loadBillings,
  recomputeBillings,
  toScheduleInput,
  num,
  type BillingRow,
} from "../services/billing-store.js"
import { taipeiToday } from "../services/project-status.js"
import { loadProjectScope } from "../services/project-scope.js"
import { BILLING_KINDS, computeSchedule, effectiveBillingAmount } from "../services/project-money.js"
import { serializeBilling } from "../services/project-application-store.js"
import { writeAuditLog } from "../services/audit.js"
import { recomputeDraftRegularRuns } from "../services/bonus-run-store.js"
import { logger } from "../lib/logger.js"

export const billingsRouter = Router()

/**
 * 分期請款期程（模組四第 4 條）＋ P3 的開票／入帳兩個事件。
 *
 * 請款 ≠ 開票 ≠ 收款（模組四第 1 條）：三件事各有日期，各自可撤銷（必填理由）。
 * **順序不阻擋**——先開票再請款、先收到錢再開票在工程業都真實發生
 * （業主付訂金、公會制先撥款），系統只回 `warnings` 提醒，不擋。
 *
 * 權限：讀寫都是 finance（HR／該案 lead／該案部門主管，見 services/project-scope.ts）。
 * 期程金額是錢，不是知識庫，basic 使用者不該看到。
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const installmentSchema = z.object({
  /** 既有期別帶 id；新增的不帶。 */
  id: z.string().uuid().optional(),
  installmentNo: z.number().int().min(1).max(999),
  /** 'installment' 一般分期（進尾差）| 'guild_advance' 公會制估驗預付款（只是一筆金額）。 */
  kind: z.enum(BILLING_KINDS).optional(),
  percentage: z.number().min(0).max(100).nullish(),
  milestone: z.string().trim().max(200).nullish(),
  plannedOn: z.string().regex(dateRe).nullish(),
  overrideAmount: z.number().nullish(),
  overrideReason: z.string().trim().max(1000).nullish(),
  note: z.string().trim().max(1000).nullish(),
})

const saveSchema = z.object({
  installments: z.array(installmentSchema).max(100),
})

const billSchema = z.object({
  billedOn: z.string().regex(dateRe).optional(),
  /** 省略時取試算／覆寫金額。實際請款金額與試算不同時要明確帶。 */
  billedAmount: z.number().nullish(),
})

const reasonSchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

const invoiceSchema = z.object({
  invoiceNo: z.string().trim().min(1).max(40),
  invoicedOn: z.string().regex(dateRe).optional(),
})

const receiveSchema = z.object({
  receivedOn: z.string().regex(dateRe).optional(),
  /** 省略時＝該期有效金額（未稅）。部分收款／折讓要明確帶。 */
  receivedAmount: z.number().nonnegative().nullish(),
})

type Warning = "invoiced_before_billed" | "received_before_invoiced" | "received_before_billed"

/**
 * M22：入帳／撤銷入帳成功後，把該租戶所有 draft 的一般獎金批次重算一次。
 * best-effort——錢已經入帳了，獎金重算失敗不能讓入帳看起來沒成功；失敗只 log，
 * 回應裡的 `bonusRunsRecomputed` 讓前端（與測試）看得到重算了幾批。
 */
async function recomputeBonusRuns(tenantId: string, context: string): Promise<string[]> {
  try {
    const result = await recomputeDraftRegularRuns(tenantId)
    if (result.failed.length > 0) {
      logger.warn({ tenantId, context, failed: result.failed }, "draft 獎金批次重算失敗（入帳已完成）")
    }
    return result.recomputed
  } catch (err) {
    logger.warn({ tenantId, context, err }, "draft 獎金批次重算失敗（入帳已完成）")
    return []
  }
}

async function respondSchedule(
  tenantId: string,
  projectId: string,
  res: Response,
  extra: { status?: number; warnings?: Warning[]; bonusRunsRecomputed?: string[] } = {},
) {
  const [{ total, base, changeOrders }, rows] = await Promise.all([
    contractTotal(tenantId, projectId),
    loadBillings(tenantId, projectId),
  ])
  const result = computeSchedule(rows.map(toScheduleInput), total)
  const installments = rows.map(serializeBilling)
  const billedTotal = installments.reduce((s, r) => s + (r.billedOn ? (r.billedAmount ?? 0) : 0), 0)
  const invoicedTotal = installments.reduce((s, r) => s + (r.invoicedOn ? (r.effectiveAmount ?? 0) : 0), 0)
  const receivedTotal = installments.reduce((s, r) => s + (r.receivedOn ? (r.receivedAmount ?? 0) : 0), 0)

  res.status(extra.status ?? 200).json({
    // 分母的組成攤開顯示，不藏起來——看不到組成就會有人去試算表對帳。
    contract: { total, base, changeOrders },
    installments,
    summary: {
      /** 只算 installment；guild_advance 不進百分比。 */
      percentageTotal: result.percentageTotal,
      /** installment 的有效金額合計（分母有值時＝合約總額）。 */
      effectiveTotal: result.effectiveTotal,
      /** 尾差沒地方放時的餘額。非 0 代表所有期別都已請款或已覆寫。 */
      unallocatedResidue: result.unallocatedResidue,
      /** 公會制估驗預付款合計（另計，不在 effectiveTotal 裡）。 */
      guildAdvanceTotal: result.guildAdvanceTotal,
      billedTotal,
      /** 尚未請款的有效金額合計（installment）。 */
      unbilledTotal: result.effectiveTotal - installments.reduce((s, r) => s + (r.kind === "installment" && r.billedOn ? (r.billedAmount ?? 0) : 0), 0),
      invoicedTotal,
      receivedTotal,
      /** 已請款但未入帳（未稅）。 */
      unreceivedTotal: billedTotal - receivedTotal,
    },
    warnings: extra.warnings ?? [],
    /** M22：這次入帳事件連帶重算的 draft 獎金批次 id（非入帳端點一律空陣列）。 */
    bonusRunsRecomputed: extra.bonusRunsRecomputed ?? [],
  })
}

/** 載入單一期別並檢查 finance 權限；四個事件端點共用。 */
async function loadBillingForWrite(tenantId: string, userId: string, billingId: string) {
  const { data: current, error } = await supabaseAdmin
    .from("project_billings")
    .select(BILLING_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", billingId)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`loadBillingForWrite: ${error.message}`)
  if (!current) return { ok: false as const, status: 404, error: "not_found" }
  const row = current as BillingRow
  const scope = await loadProjectScope(tenantId, userId, row.project_id)
  if (!scope.ok) return scope
  if (!scope.finance) return { ok: false as const, status: 403, error: "forbidden" }
  return { ok: true as const, row, self: scope.self }
}

/** 撤銷事件的理由附在備註後面：欄位本身被清掉，稽核 trigger 留得住舊值，但人要看得到原因。 */
function appendNote(note: string | null, line: string): string {
  return [note, line].filter(Boolean).join("\n")
}

// ── GET /projects/:id/billings ────────────────────────────────────────
billingsRouter.get(
  "/projects/:id/billings",
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
      const scope = await loadProjectScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.finance) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      await respondSchedule(tenantId, req.params.id as string, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /projects/:id/billings — 整批存期程 ───────────────────────────
/**
 * 整批存而不是逐筆 CRUD：改一期的百分比會牽動尾差落點，逐筆存會讓
 * 中間狀態出現「合計不等於合約金額」的假象。整批存一次算完。
 *
 * 語意：
 *   • 有 id → 更新
 *   • 無 id → 新增
 *   • 既有列不在 payload 裡 → 軟刪除；**已請款的不可移除**（409）
 *   • **已入帳的期別不可改金額也不可移除**（409 `received`）——錢已經進來了，
 *     那一期的金額就是對帳的依據，改了等於改歷史。
 */
billingsRouter.put(
  "/projects/:id/billings",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const projectId = req.params.id as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = saveSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadProjectScope(tenantId, userId, projectId)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.finance) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const payload = parsed.data.installments
      const seen = new Set<number>()
      for (const item of payload) {
        if (seen.has(item.installmentNo)) {
          res.status(400).json({ error: "duplicate_installment_no", installmentNo: item.installmentNo })
          return
        }
        seen.add(item.installmentNo)
        // 人工覆寫必須說明理由——偏離期程的金額是談出來的，要留得下痕跡。
        if (item.overrideAmount !== null && item.overrideAmount !== undefined && !item.overrideReason) {
          res.status(400).json({ error: "override_reason_required", installmentNo: item.installmentNo })
          return
        }
      }

      const existing = await loadBillings(tenantId, projectId)
      const byId = new Map(existing.map((r) => [r.id, r]))
      const keepIds = new Set(payload.map((p) => p.id).filter(Boolean) as string[])

      // 已請款的期別不可移除：帳已經出去了，移掉等於讓那筆請款憑空消失。
      const removing = existing.filter((r) => !keepIds.has(r.id))
      const receivedRemoval = removing.find((r) => r.received_on !== null)
      if (receivedRemoval) {
        res.status(409).json({ error: "received", installmentNo: receivedRemoval.installment_no })
        return
      }
      const billedRemoval = removing.find((r) => r.billed_on !== null)
      if (billedRemoval) {
        res.status(409).json({
          error: "billed_installment_not_removable",
          installmentNo: billedRemoval.installment_no,
        })
        return
      }
      // 已入帳的期別金額凍結：百分比／覆寫金額任一與現況不同就擋。
      for (const item of payload) {
        if (!item.id) continue
        const row = byId.get(item.id)
        if (!row || row.received_on === null) continue
        const pctChanged = (item.percentage ?? null) !== num(row.percentage)
        const overrideChanged = (item.overrideAmount ?? null) !== num(row.override_amount)
        if (pctChanged || overrideChanged) {
          res.status(409).json({ error: "received", installmentNo: row.installment_no })
          return
        }
      }

      // 先軟刪除要移除的，避免期別編號與新增的相撞。
      for (const row of removing) {
        await supabaseAdmin
          .from("project_billings")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by_emp_id: scope.self.id,
            delete_reason: "期程調整",
          })
          .eq("tenant_id", tenantId)
          .eq("id", row.id)
      }

      for (const item of payload) {
        // kind 省略時：既有列維持原樣（UI 沒帶不該把預付款變回一般期），新列預設 installment。
        const existingKind = item.id ? byId.get(item.id)?.kind : undefined
        const fields = {
          kind: item.kind ?? existingKind ?? "installment",
          percentage: item.percentage ?? null,
          milestone: item.milestone ?? null,
          planned_on: item.plannedOn ?? null,
          override_amount: item.overrideAmount ?? null,
          override_reason: item.overrideReason ?? null,
          note: item.note ?? null,
        }
        if (item.id) {
          await supabaseAdmin
            .from("project_billings")
            .update({ ...fields, installment_no: item.installmentNo })
            .eq("tenant_id", tenantId)
            .eq("id", item.id)
        } else {
          const { error } = await supabaseAdmin.from("project_billings").insert({
            tenant_id: tenantId,
            project_id: projectId,
            installment_no: item.installmentNo,
            ...fields,
            created_by_emp_id: scope.self.id,
          })
          if (error) {
            if (error.code === "23505") {
              res.status(409).json({ error: "installment_no_taken", installmentNo: item.installmentNo })
              return
            }
            next(new Error(`PUT /projects/${projectId}/billings: ${error.message}`))
            return
          }
        }
      }

      await recomputeBillings(tenantId, projectId)
      await respondSchedule(tenantId, projectId, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /billings/:id/bill — 標記已請款（金額凍結） ──────────────────
billingsRouter.post(
  "/billings/:id/bill",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = billSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const loaded = await loadBillingForWrite(tenantId, userId, req.params.id as string)
      if (!loaded.ok) {
        res.status(loaded.status).json({ error: loaded.error })
        return
      }
      const row = loaded.row
      if (row.billed_on) {
        res.status(409).json({ error: "already_billed" })
        return
      }

      // 沒帶金額就用目前的有效金額（覆寫 ?? 試算）。**凍結在這一刻**——
      // 之後追加減帳改變分母，這一期不再跟著變。
      const fallback = num(row.override_amount) ?? num(row.calculated_amount)
      const billedAmount = parsed.data.billedAmount ?? fallback
      if (billedAmount === null) {
        // 沒有合約就算不出金額，硬記一筆 0 元請款是錯的。
        res.status(400).json({ error: "amount_unknown" })
        return
      }

      const { error } = await supabaseAdmin
        .from("project_billings")
        .update({
          billed_on: parsed.data.billedOn ?? taipeiToday(),
          billed_amount: billedAmount,
        })
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/bill: ${error.message}`))
        return
      }
      // 這一期凍結後，尾差要改落到下一個未請款的期別。
      await recomputeBillings(tenantId, row.project_id)
      await respondSchedule(tenantId, row.project_id, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /billings/:id/unbill — 取消請款標記，必填理由 ────────────────
billingsRouter.post(
  "/billings/:id/unbill",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = reasonSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required" })
      return
    }
    try {
      const loaded = await loadBillingForWrite(tenantId, userId, req.params.id as string)
      if (!loaded.ok) {
        res.status(loaded.status).json({ error: loaded.error })
        return
      }
      const row = loaded.row
      if (!row.billed_on) {
        res.status(409).json({ error: "not_billed" })
        return
      }

      const note = appendNote(row.note, `取消請款（原 ${row.billed_on}）：${parsed.data.reason}`)
      const { error } = await supabaseAdmin
        .from("project_billings")
        .update({ billed_on: null, billed_amount: null, note })
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/unbill: ${error.message}`))
        return
      }
      await recomputeBillings(tenantId, row.project_id)
      await respondSchedule(tenantId, row.project_id, res)
    } catch (err) {
      next(err)
    }
  },
)

/* ──────────────────────────────────────────────────────────────────
 * P3：開票／入帳
 * ────────────────────────────────────────────────────────────────── */

// ── POST /billings/:id/invoice — 記錄開票（發票號碼＋日期） ──────────
billingsRouter.post(
  "/billings/:id/invoice",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = invoiceSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const loaded = await loadBillingForWrite(tenantId, userId, req.params.id as string)
      if (!loaded.ok) {
        res.status(loaded.status).json({ error: loaded.error })
        return
      }
      const row = loaded.row
      if (row.invoiced_on) {
        res.status(409).json({ error: "already_invoiced" })
        return
      }
      const warnings: Warning[] = []
      // 順序不擋只提醒：先開票再請款在工程業真的會發生。
      if (!row.billed_on) warnings.push("invoiced_before_billed")

      const patch = { invoice_no: parsed.data.invoiceNo, invoiced_on: parsed.data.invoicedOn ?? taipeiToday() }
      const { error } = await supabaseAdmin
        .from("project_billings")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/invoice: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "project_billings",
        recordId: row.id,
        action: "UPDATE",
        oldRow: { invoice_no: row.invoice_no, invoiced_on: row.invoiced_on },
        newRow: patch,
        actorEmpId: loaded.self.id,
        context: "POST /billings/:id/invoice",
      })
      await respondSchedule(tenantId, row.project_id, res, { warnings })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /billings/:id/uninvoice — 撤銷開票（作廢／重開），必填理由 ──
billingsRouter.post(
  "/billings/:id/uninvoice",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = reasonSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required" })
      return
    }
    try {
      const loaded = await loadBillingForWrite(tenantId, userId, req.params.id as string)
      if (!loaded.ok) {
        res.status(loaded.status).json({ error: loaded.error })
        return
      }
      const row = loaded.row
      if (!row.invoiced_on) {
        res.status(409).json({ error: "not_invoiced" })
        return
      }
      const note = appendNote(
        row.note,
        `撤銷開票（原 ${row.invoiced_on} 發票 ${row.invoice_no ?? "-"}）：${parsed.data.reason}`,
      )
      const { error } = await supabaseAdmin
        .from("project_billings")
        .update({ invoice_no: null, invoiced_on: null, note })
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/uninvoice: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "project_billings",
        recordId: row.id,
        action: "UPDATE",
        oldRow: { invoice_no: row.invoice_no, invoiced_on: row.invoiced_on },
        newRow: { invoice_no: null, invoiced_on: null, reason: parsed.data.reason },
        actorEmpId: loaded.self.id,
        context: "POST /billings/:id/uninvoice",
      })
      await respondSchedule(tenantId, row.project_id, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /billings/:id/receive — 記錄入帳（日期＋實收金額） ──────────
billingsRouter.post(
  "/billings/:id/receive",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = receiveSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const loaded = await loadBillingForWrite(tenantId, userId, req.params.id as string)
      if (!loaded.ok) {
        res.status(loaded.status).json({ error: loaded.error })
        return
      }
      const row = loaded.row
      if (row.received_on) {
        res.status(409).json({ error: "already_received" })
        return
      }
      // 預設實收＝該期有效金額（已請款 ?? 覆寫 ?? 試算，未稅）。
      const receivedAmount = parsed.data.receivedAmount ?? effectiveBillingAmount(row)
      if (receivedAmount === null) {
        res.status(400).json({ error: "amount_unknown" })
        return
      }
      const warnings: Warning[] = []
      if (!row.invoiced_on) warnings.push("received_before_invoiced")
      if (!row.billed_on) warnings.push("received_before_billed")

      const patch = { received_on: parsed.data.receivedOn ?? taipeiToday(), received_amount: receivedAmount }
      const { error } = await supabaseAdmin
        .from("project_billings")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/receive: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "project_billings",
        recordId: row.id,
        action: "UPDATE",
        oldRow: { received_on: row.received_on, received_amount: row.received_amount },
        newRow: patch,
        actorEmpId: loaded.self.id,
        context: "POST /billings/:id/receive",
      })
      // M22：入帳改變了每個人的應得金額，draft 獎金批次跟著重算（best-effort）。
      const bonusRunsRecomputed = await recomputeBonusRuns(tenantId, "POST /billings/:id/receive")
      await respondSchedule(tenantId, row.project_id, res, { warnings, bonusRunsRecomputed })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /billings/:id/unreceive — 撤銷入帳（退票／誤登），必填理由 ──
billingsRouter.post(
  "/billings/:id/unreceive",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = reasonSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required" })
      return
    }
    try {
      const loaded = await loadBillingForWrite(tenantId, userId, req.params.id as string)
      if (!loaded.ok) {
        res.status(loaded.status).json({ error: loaded.error })
        return
      }
      const row = loaded.row
      if (!row.received_on) {
        res.status(409).json({ error: "not_received" })
        return
      }
      const note = appendNote(
        row.note,
        `撤銷入帳（原 ${row.received_on} 實收 ${num(row.received_amount) ?? "-"}）：${parsed.data.reason}`,
      )
      const { error } = await supabaseAdmin
        .from("project_billings")
        .update({ received_on: null, received_amount: null, note })
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/unreceive: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "project_billings",
        recordId: row.id,
        action: "UPDATE",
        oldRow: { received_on: row.received_on, received_amount: row.received_amount },
        newRow: { received_on: null, received_amount: null, reason: parsed.data.reason },
        actorEmpId: loaded.self.id,
        context: "POST /billings/:id/unreceive",
      })
      // M22：撤銷入帳同樣要讓 draft 批次退回去（不然帳撤了、獎金還照舊算）。
      const bonusRunsRecomputed = await recomputeBonusRuns(tenantId, "POST /billings/:id/unreceive")
      await respondSchedule(tenantId, row.project_id, res, { bonusRunsRecomputed })
    } catch (err) {
      next(err)
    }
  },
)
