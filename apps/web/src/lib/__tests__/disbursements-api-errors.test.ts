/** 放款單錯誤文案（2026-11-12 刪除專案驗收第六輪）：自動作廢／需人工確認要讓使用者看到單號。假資料。 */
import { describe, expect, it } from "vitest"
import { describeBatchPayError, humanizeDisbursementError } from "../disbursements-api"

const apiErr = (body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.error)), { body, serverMessage: typeof body.message === "string" ? body.message : undefined })

describe("humanizeDisbursementError", () => {
  it("已自動作廢：顯示後端含單號的說明", () => {
    const msg = "已建立單號 D-115-001，但分攤的專案已被刪除，系統已自動作廢這張單；請修正後重新建立"
    expect(humanizeDisbursementError(apiErr({ error: "project_deleted", autoVoided: true, message: msg }), "x")).toBe(msg)
  })
  it("需人工確認：顯示後端含單號的說明；沒有說明時用通用中文", () => {
    const msg = "單號 D-115-002 期款同步失敗，且放款單狀態無法退回，需人工確認"
    expect(humanizeDisbursementError(apiErr({ error: "manual_check_required", message: msg }), "x")).toBe(msg)
    expect(humanizeDisbursementError(apiErr({ error: "manual_check_required" }), "x")).toContain("需人工確認")
  })
  it("一般錯誤碼照舊對應中文（不被 serverMessage 蓋掉）", () => {
    expect(humanizeDisbursementError(apiErr({ error: "subcontract_deleted", message: "x" }), "y")).toContain("副委託已被刪除")
  })
  it("付錯人防線（2026-11-16）：分攤廠商不符／戶名不符有中文", () => {
    expect(humanizeDisbursementError(apiErr({ error: "allocation_vendor_mismatch" }), "x")).toContain("副委託廠商與收款廠商不同")
    expect(humanizeDisbursementError(apiErr({ error: "payee_name_mismatch" }), "x")).toContain("收款戶名與登錄廠商名稱不同")
    expect(humanizeDisbursementError(apiErr({ error: "payee_bank_mismatch" }), "x")).toContain("收款帳戶與登錄廠商名冊不同")
    expect(humanizeDisbursementError(apiErr({ error: "allocation_vendor_changed" }), "x")).toContain("分攤的副委託廠商已變更")
    expect(humanizeDisbursementError(apiErr({ error: "payee_is_registered_vendor" }), "x")).toContain("請改選登錄廠商")
  })
  it("批次付款逐筆：manual_check_required 帶 message 時顯示它", () => {
    expect(describeBatchPayError("manual_check_required", { message: "單號 D-115-003 需人工確認" })).toBe("單號 D-115-003 需人工確認")
  })
})
