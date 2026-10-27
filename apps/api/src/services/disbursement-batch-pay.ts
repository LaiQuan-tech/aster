import { logger } from "../lib/logger.js"
import { num } from "./billing-store.js"
import {
  AMOUNT_TOLERANCE,
  DisbursementError,
  loadDisbursement,
  payDisbursement,
  type Actor,
  type SerializedDisbursement,
} from "./disbursements.js"

/**
 * 「請款與放款」頁的**打勾放款**（2026-10-27 業主：放款跟請款融合、會計打勾放款）。
 *
 * 只是把既有的單筆 `payDisbursement`（POST /disbursements/:id/pay）逐筆跑一遍，**規則一條都不放寬**：
 *   • 只收 `approved`（簽核完成）的放款單。草稿／送簽中／已匯款／作廢一律擋，錯誤碼與單筆付款相同
 *     （`approval_required`／`already_paid`／`void`）。
 *   • **不接受任何強制旗標**（`forceReason`／`forceAcceptance`）：HR 跳過簽核直接付款、強制放行未驗收
 *     這兩個例外只能在放款單明細頁逐張操作（要寫理由、留稽核），批次一律不走。
 *   • 未驗收的期款由 `payDisbursement` 內的 `assertPaymentsAccepted` 擋（409 `acceptance_required`）。
 *   • 實付金額：已核准單的金額是簽核的內容（`updateDisbursement` 對 approved 單凍結 amount），
 *     所以批次允許前端回送實付，但必須等於核准金額（±AMOUNT_TOLERANCE），不同 → 409 `amount_locked`，
 *     請撤回簽核改單後重簽。
 *
 * 每筆各自呼叫一次 `payDisbursement`（各自的寫入序列；supabase-js 沒有跨表交易，單筆的寫入順序
 * 與失敗處理見 services/disbursements.ts 檔頭「沒有交易」），任一筆失敗**不影響其他筆**，
 * 逐筆回傳成功或失敗原因。同一張單在同一批出現兩次只處理第一次（第二次回 `duplicate_item`）。
 * 已經付過的單再送一次會被 `already_paid` 擋下，所以前端重送失敗筆時不會重複付款。
 */

export const BATCH_PAY_MAX_ITEMS = 100

export type BatchPayItem = {
  id: string
  /** 放款日；省略＝用整批的 `paidOn`。 */
  paidOn?: string | null
  /** 前端畫面上的實付；省略＝不比對（用核准金額）。 */
  amount?: number | null
}

export type BatchPayResult =
  | { id: string; ok: true; disbursement: SerializedDisbursement }
  | { id: string; ok: false; status: number; error: string; details?: Record<string, unknown> }

export type BatchPayDeps = {
  load: typeof loadDisbursement
  pay: typeof payDisbursement
}

const defaultDeps: BatchPayDeps = { load: loadDisbursement, pay: payDisbursement }

/** 單筆的狀態前置檢查（純函式）：只有 approved 可以批次付款；錯誤碼沿用單筆付款端點。 */
export function batchPayStatusError(status: string): DisbursementError | null {
  if (status === "approved") return null
  if (status === "paid") return new DisbursementError(409, "already_paid")
  if (status === "void") return new DisbursementError(409, "void")
  if (status === "pending_approval") {
    return new DisbursementError(409, "approval_required", { hint: "簽核尚未完成，不能放款。" })
  }
  // draft：單筆端點 HR 可帶理由強制付款，批次一律不開這個例外。
  return new DisbursementError(409, "approval_required", { hint: "放款需經簽核核准後才能付款，請先送簽。" })
}

/** 實付與核准金額比對（純函式）。 */
export function batchPayAmountError(approvedAmount: number, requested: number | null | undefined): DisbursementError | null {
  if (requested === null || requested === undefined) return null
  if (Math.abs(requested - approvedAmount) <= AMOUNT_TOLERANCE) return null
  return new DisbursementError(409, "amount_locked", { approvedAmount, requestedAmount: requested })
}

export async function payDisbursementsBatch(
  tenantId: string,
  actor: Actor,
  input: { paidOn?: string | null; items: BatchPayItem[] },
  deps: BatchPayDeps = defaultDeps,
): Promise<BatchPayResult[]> {
  const seen = new Set<string>()
  const results: BatchPayResult[] = []
  for (const item of input.items) {
    if (seen.has(item.id)) {
      results.push({ id: item.id, ok: false, status: 400, error: "duplicate_item" })
      continue
    }
    seen.add(item.id)
    try {
      const current = await deps.load(tenantId, item.id)
      if (!current) {
        results.push({ id: item.id, ok: false, status: 404, error: "not_found" })
        continue
      }
      const statusErr = batchPayStatusError(current.status)
      if (statusErr) throw statusErr
      const amountErr = batchPayAmountError(num(current.amount) ?? 0, item.amount)
      if (amountErr) throw amountErr
      const paidOn = item.paidOn ?? input.paidOn ?? null
      // 刻意不傳 forceReason／forceAcceptance：批次不開任何強制例外。
      const disbursement = await deps.pay(tenantId, actor, item.id, { paidOn })
      if (!disbursement) {
        results.push({ id: item.id, ok: false, status: 404, error: "not_found" })
        continue
      }
      results.push({ id: item.id, ok: true, disbursement })
    } catch (err) {
      if (err instanceof DisbursementError) {
        results.push({ id: item.id, ok: false, status: err.httpStatus, error: err.code, ...(err.details ? { details: err.details } : {}) })
      } else {
        // 非預期錯誤（DB 斷線等）：這筆記失敗、繼續下一筆；訊息不外洩內部細節。
        logger.error({ err: err instanceof Error ? err.message : String(err), disbursementId: item.id }, "batch pay item failed")
        results.push({ id: item.id, ok: false, status: 500, error: "internal_error" })
      }
    }
  }
  return results
}
