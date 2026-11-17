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
    expect(humanizeDisbursementError(apiErr({ error: "payee_is_registered_vendor" }), "x")).toContain("請先在副委託下拉選擇該廠商")
    expect(humanizeDisbursementError(apiErr({ error: "payee_bank_changed" }), "x")).toContain("重新帶入名冊帳戶")
    expect(humanizeDisbursementError(apiErr({ error: "purpose_required" }), "x")).toContain("請填寫用途")
    // 第五輪（2026-11-17）
    expect(humanizeDisbursementError(apiErr({ error: "payee_bank_changed" }), "x")).toContain("已核准的單請先撤回簽核再編輯")
    expect(humanizeDisbursementError(apiErr({ error: "invalid_payee_name" }), "x")).toContain("名稱含有不可見字元")
    expect(humanizeDisbursementError(apiErr({ error: "vendor_has_unpaid_installments" }), "x")).toContain("此廠商仍有未付期款")
    expect(humanizeDisbursementError(apiErr({ error: "cannot_clear_allocations" }), "x")).toContain("已分攤的放款單不能改成零分攤")
  })
  it("第六輪：撞名冊帶廠商名稱的後端訊息直接顯示；名冊沒帳戶有中文", () => {
    const msg = "收款對象與名冊廠商「測試甲工程行」視為同一家，請改選登錄廠商「測試甲工程行」；若專案副委託尚未綁定，請先在副委託下拉選擇該廠商"
    expect(humanizeDisbursementError(apiErr({ error: "payee_is_registered_vendor", message: msg }), "x")).toBe(msg)
    expect(describeBatchPayError("payee_is_registered_vendor", { message: msg })).toBe(msg)
    expect(humanizeDisbursementError(apiErr({ error: "vendor_bank_missing" }), "x")).toBe("名冊尚未登錄此廠商的收款帳戶，請先到廠商名冊補上帳戶。")
  })
  it("批次付款逐筆：manual_check_required 帶 message 時顯示它", () => {
    expect(describeBatchPayError("manual_check_required", { message: "單號 D-115-003 需人工確認" })).toBe("單號 D-115-003 需人工確認")
  })
})

describe("2026-11-17：conflict_retry 與找不到對照時顯示後端說明", () => {
  it("conflict_retry 有中文，不被 conflict 子字串蓋掉", () => {
    expect(humanizeDisbursementError(apiErr({ error: "conflict_retry" }), "x")).toBe("資料已被其他人更新，請重新整理後再試")
    expect(describeBatchPayError("conflict_retry")).toBe("資料已被其他人更新，請重新整理後再試")
  })
  it("未知錯誤碼 → 顯示後端 message／hint；都沒有才回原碼", () => {
    expect(humanizeDisbursementError(apiErr({ error: "some_new_code", message: "後端說明" }), "x")).toBe("後端說明")
    expect(humanizeDisbursementError(apiErr({ error: "some_new_code", hint: "後端提示" }), "x")).toBe("後端提示")
    expect(humanizeDisbursementError(apiErr({ error: "some_new_code" }), "x")).toBe("some_new_code")
    expect(describeBatchPayError("some_new_code", { message: "後端說明" })).toBe("後端說明")
    expect(describeBatchPayError("some_new_code", { hint: "後端提示" })).toBe("後端提示")
    expect(describeBatchPayError("some_new_code")).toBe("some_new_code")
  })
  it("已知錯誤碼仍用前端中文（不被後端 message 蓋掉）", () => {
    expect(describeBatchPayError("other_payee_approval_not_by_boss", { message: "英文" })).toContain("作廢後重開送簽")
  })
})

