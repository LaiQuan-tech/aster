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
import { scheduleBonusRecompute } from "../services/bonus-run-store.js"
import { logger } from "../lib/logger.js"
import {
  BILLING_HAS_SHARES_ERRCODE,
  billingIdsWithBonusShares,
  billingsOverShareLimit,
  isAdvanceBillingKind,
} from "../services/billing-shares.js"

const BONUS_SHARES_REMOVE_MESSAGE = "此期已設定獎金分潤，請老闆先移除後再刪"
const BONUS_SHARES_KIND_MESSAGE = "此期已設定獎金分潤，請老闆先移除後再改"

/** DB 觸發器（migration 0093）擋下「刪除／改成代墊款，但該期還有分潤或發獎金日」。 */
function isBillingHasSharesDbError(error: { code?: string | null }): boolean {
  return error.code === BILLING_HAS_SHARES_ERRCODE
}

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

type Warning =
  | "invoiced_before_billed"
  | "received_before_invoiced"
  | "received_before_billed"
  /** PUT 期程後某期金額變小、已設定的每期獎金分潤合計超過它（只提示，不擋會計改金額；2026-11-11）。 */
  | { billingId: string; code: "shares_exceed_amount" }
  /** PUT 期程時這一期的更新／軟刪除寫入失敗（非 BS409）：其他期照存，前端保留該期草稿並提示重試。 */
  | { billingId: string; code: "update_failed" }

/**
 * M22：入帳／撤銷入帳成功後，排程重算該租戶所有未發放的一般獎金批次（2026-10-26 起非同步：
 * 回應不等重算，同租戶短時間內多次觸發合併一次；見 bonus-run-store.ts scheduleBonusRecompute）。
 * `bonusRunsRecomputed` 保留欄位相容，固定回空陣列。
 */
async function recomputeBonusRuns(tenantId: string, context: string): Promise<string[]> {
  scheduleBonusRecompute(tenantId, context)
  return []
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

/**
 * 載入單一期別並檢查 finance 權限；四個事件端點共用。
 * 權限依「這一期自己的 project_id」判斷（不是從網址帶專案），所以不會被拿來改別案的期別；
 * 各端點寫入時仍再比對 project_id 當第二道防線。
 */
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

/**
 * 期程 PUT 寫到一半被擋（409）時，先把已寫入部分的試算金額與尾差重算一致。
 * 重算失敗只記 log——仍回原本的 409（不要把「期別有分潤」的明確錯誤蓋成 500）。
 */
async function recomputeAfterPartialWrite(tenantId: string, projectId: string): Promise<void> {
  try {
    await recomputeBillings(tenantId, projectId)
  } catch (err) {
    logger.warn({ projectId, err: err instanceof Error ? err.message : String(err) }, "PUT billings: recompute after partial write failed")
  }
}

/** 期別在讀取之後被刪除（含整個專案被刪除）：事件端點條件寫入 0 列時回這個（2026-11-12）。 */
const BILLING_GONE_BODY = { error: "not_found", message: "這一期已被刪除（或專案已刪除），請重新整理" }

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
 *   • 已設定每期獎金分潤／發獎金日的期別不可移除（409 `billing_has_bonus_shares`，2026-11-11）。
 *   • 存後若某期分潤合計超過新的期別金額：照存，回 `warnings: [{ billingId, code: "shares_exceed_amount" }]`。
 *   • 帶 id 但不是**本專案**現有未刪期別 → 整批 400 `unknown_billing`（任何寫入前；擋跨專案改期別，2026-11-11）。
 *   • payload 內同一期別 id 出現兩次（轉小寫後比）→ 整批 400 `duplicate_billing_id`（任何寫入前）。
 *   • 寫到一半被 DB 觸發器擋（BS409）、新增撞號（409 installment_no_taken）、其他新增錯誤（500）或拋例外
 *     → 提早返回前先重算已寫入部分；其他單期寫入錯誤照存其餘期別，
 *     回 `warnings: [{ billingId, code: "update_failed" }]`。
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
    // 開始寫入後才設 true：外層 catch 據此判斷要不要先把已寫入部分重算一致。
    let writesStarted = false
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

      // id 一律轉小寫比對（UUID 大小寫不同仍是同一期；不轉的話大寫 id 會被當成「不在 payload」而軟刪除）。
      const payload = parsed.data.installments.map((item) => (item.id ? { ...item, id: item.id.toLowerCase() } : item))
      // 同一期別 id 出現兩次（轉小寫後）→ 任何寫入前整批擋：否則同一列會被寫兩次、後者蓋前者。
      const seenIds = new Set<string>()
      for (const item of payload) {
        if (!item.id) continue
        if (seenIds.has(item.id)) {
          res.status(400).json({ error: "duplicate_billing_id", installmentNo: item.installmentNo })
          return
        }
        seenIds.add(item.id)
      }
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
      const byId = new Map(existing.map((r) => [r.id.toLowerCase(), r]))
      // 權限：帶 id 的項目必須是**本專案**現有（未刪）的期別。否則對 A 案有財務權的人可帶同租戶 B 案的
      // 期別 id 改掉它（還繞過已入帳凍結檢查）。在任何寫入前整批擋下。
      const unknown = payload.filter((p) => p.id && !byId.has(p.id))
      if (unknown.length > 0) {
        res.status(400).json({ error: "unknown_billing", installmentNos: unknown.map((p) => p.installmentNo) })
        return
      }
      const keepIds = new Set(payload.map((p) => p.id).filter(Boolean) as string[])

      // 已請款的期別不可移除：帳已經出去了，移掉等於讓那筆請款憑空消失。
      const removing = existing.filter((r) => !keepIds.has(r.id.toLowerCase()))
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

      // 已設定每期獎金分潤／發獎金日的期別不可移除（2026-11-11）：分潤是另外發的紀錄，期別刪掉就對不到了。
      // 也不可改成代墊款（guild_advance 不可設分潤）。會計看不到分潤，訊息只說「請老闆先移除」，不帶任何分潤內容。
      // 這裡是預檢；與分潤寫入同時發生的競態由 DB 觸發器（migration 0093）兜底，錯誤碼同樣對應成 409。
      const toAdvance = payload
        .filter((item) => item.id && item.kind && isAdvanceBillingKind(item.kind) && !isAdvanceBillingKind(byId.get(item.id)?.kind))
        .map((item) => byId.get(item.id as string))
        .filter((r): r is BillingRow => !!r)
      if (removing.length > 0 || toAdvance.length > 0) {
        const withShares = await billingIdsWithBonusShares(tenantId, [...removing, ...toAdvance].map((r) => r.id))
        const blockedRemoval = removing.find((r) => withShares.has(r.id.toLowerCase()))
        if (blockedRemoval) {
          res.status(409).json({
            error: "billing_has_bonus_shares",
            installmentNo: blockedRemoval.installment_no,
            message: BONUS_SHARES_REMOVE_MESSAGE,
          })
          return
        }
        const blockedKind = toAdvance.find((r) => withShares.has(r.id.toLowerCase()))
        if (blockedKind) {
          res.status(409).json({
            error: "billing_has_bonus_shares",
            installmentNo: blockedKind.installment_no,
            message: BONUS_SHARES_KIND_MESSAGE,
          })
          return
        }
      }

      const writeWarnings: Warning[] = []
      writesStarted = true
      // 先軟刪除要移除的，避免期別編號與新增的相撞。
      for (const row of removing) {
        const { error } = await supabaseAdmin
          .from("project_billings")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by_emp_id: scope.self.id,
            delete_reason: "期程調整",
          })
          .eq("tenant_id", tenantId)
          .eq("project_id", projectId)
          .eq("id", row.id)
        if (error) {
          if (isBillingHasSharesDbError(error)) {
            // 前面可能已寫入一部分：先重算，讓已寫入部分的試算金額與尾差一致，再回 409。
            await recomputeAfterPartialWrite(tenantId, projectId)
            res.status(409).json({ error: "billing_has_bonus_shares", installmentNo: row.installment_no, message: BONUS_SHARES_REMOVE_MESSAGE })
            return
          }
          // 其他錯誤不中斷整批，但回 warnings 讓前端保留這一期的草稿、提示重試。
          logger.warn({ projectId, billingId: row.id, code: error.code }, "PUT billings: soft delete failed")
          writeWarnings.push({ billingId: row.id, code: "update_failed" })
        }
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
          const { error } = await supabaseAdmin
            .from("project_billings")
            .update({ ...fields, installment_no: item.installmentNo })
            .eq("tenant_id", tenantId)
            .eq("project_id", projectId)
            .eq("id", item.id)
            .is("deleted_at", null)
          if (error) {
            if (isBillingHasSharesDbError(error)) {
              // 前面的期別可能已寫入：先重算，讓已寫入部分的試算金額與尾差一致，再回 409。
              await recomputeAfterPartialWrite(tenantId, projectId)
              res.status(409).json({ error: "billing_has_bonus_shares", installmentNo: item.installmentNo, message: BONUS_SHARES_KIND_MESSAGE })
              return
            }
            // 其他錯誤不中斷整批，但回 warnings 讓前端保留這一期的草稿、提示重試。
            logger.warn({ projectId, billingId: item.id, code: error.code }, "PUT billings: update failed")
            writeWarnings.push({ billingId: item.id, code: "update_failed" })
          }
        } else {
          const { error } = await supabaseAdmin.from("project_billings").insert({
            tenant_id: tenantId,
            project_id: projectId,
            installment_no: item.installmentNo,
            ...fields,
            created_by_emp_id: scope.self.id,
          })
          if (error) {
            // 前面的期別可能已寫入：不論哪種錯誤，提早返回前都先重算已寫入部分。
            await recomputeAfterPartialWrite(tenantId, projectId)
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
      // 期別金額變小 → 已設定的每期分潤可能超額：不擋（分潤只是紀錄），回 warnings 讓前端顯示黃色提示。
      const over = await billingsOverShareLimit(tenantId, projectId)
      await respondSchedule(tenantId, projectId, res, {
        warnings: [...writeWarnings, ...over.map((billingId) => ({ billingId, code: "shares_exceed_amount" as const }))],
      })
    } catch (err) {
      // 寫到一半拋例外：已寫入部分先重算（失敗只 log），再交給錯誤處理。
      if (writesStarted) await recomputeAfterPartialWrite(tenantId, projectId)
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

      const { data: updated, error } = await supabaseAdmin
        .from("project_billings")
        .update({
          billed_on: parsed.data.billedOn ?? taipeiToday(),
          billed_amount: billedAmount,
        })
        .eq("tenant_id", tenantId)
        .eq("project_id", row.project_id)
        .eq("id", row.id)
        // 讀到之後這一期（或整個專案）被刪除：不寫進已刪除的列（2026-11-12 驗收）。
        .is("deleted_at", null)
        .select("id")
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/bill: ${error.message}`))
        return
      }
      if (!updated || updated.length === 0) {
        res.status(404).json(BILLING_GONE_BODY)
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
      const { data: updated, error } = await supabaseAdmin
        .from("project_billings")
        .update({ billed_on: null, billed_amount: null, note })
        .eq("tenant_id", tenantId)
        .eq("project_id", row.project_id)
        .eq("id", row.id)
        // 讀到之後這一期（或整個專案）被刪除：不寫進已刪除的列（2026-11-12 驗收）。
        .is("deleted_at", null)
        .select("id")
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/unbill: ${error.message}`))
        return
      }
      if (!updated || updated.length === 0) {
        res.status(404).json(BILLING_GONE_BODY)
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
      const { data: updated, error } = await supabaseAdmin
        .from("project_billings")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("project_id", row.project_id)
        .eq("id", row.id)
        // 讀到之後這一期（或整個專案）被刪除：不寫進已刪除的列（2026-11-12 驗收）。
        .is("deleted_at", null)
        .select("id")
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/invoice: ${error.message}`))
        return
      }
      if (!updated || updated.length === 0) {
        res.status(404).json(BILLING_GONE_BODY)
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
      const { data: updated, error } = await supabaseAdmin
        .from("project_billings")
        .update({ invoice_no: null, invoiced_on: null, note })
        .eq("tenant_id", tenantId)
        .eq("project_id", row.project_id)
        .eq("id", row.id)
        // 讀到之後這一期（或整個專案）被刪除：不寫進已刪除的列（2026-11-12 驗收）。
        .is("deleted_at", null)
        .select("id")
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/uninvoice: ${error.message}`))
        return
      }
      if (!updated || updated.length === 0) {
        res.status(404).json(BILLING_GONE_BODY)
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
      const { data: updated, error } = await supabaseAdmin
        .from("project_billings")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("project_id", row.project_id)
        .eq("id", row.id)
        // 讀到之後這一期（或整個專案）被刪除：不寫進已刪除的列（2026-11-12 驗收）。
        .is("deleted_at", null)
        .select("id")
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/receive: ${error.message}`))
        return
      }
      if (!updated || updated.length === 0) {
        res.status(404).json(BILLING_GONE_BODY)
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
      const { data: updated, error } = await supabaseAdmin
        .from("project_billings")
        .update({ received_on: null, received_amount: null, note })
        .eq("tenant_id", tenantId)
        .eq("project_id", row.project_id)
        .eq("id", row.id)
        // 讀到之後這一期（或整個專案）被刪除：不寫進已刪除的列（2026-11-12 驗收）。
        .is("deleted_at", null)
        .select("id")
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/unreceive: ${error.message}`))
        return
      }
      if (!updated || updated.length === 0) {
        res.status(404).json(BILLING_GONE_BODY)
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
