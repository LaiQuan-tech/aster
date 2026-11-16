/** B3（2026-11-16）：編輯舊草稿時，單上的銀行快照與名冊不同要能被偵測（提示＋重新帶入）。假資料。 */
import { describe, expect, it } from "vitest"
import { bankSnapshotDiffersFromVendor } from "../DisbursementForm"

const vendor = { bankName: "測試銀行", bankCode: "999", bankAccount: "0000111", accountHolder: "測試甲工程行王小明" }

describe("bankSnapshotDiffersFromVendor", () => {
  it("名冊原始值 → 不提示", () => {
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行", payeeBankAccount: "000-0111", payeeBankCode: "999" }, vendor)).toBe(false)
  })
  it("系統快照格式（銀行名（代碼）／帳號 戶名）→ 不提示", () => {
    expect(
      bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行（999）", payeeBankAccount: "0000111 測試甲工程行王小明", payeeBankCode: "999" }, vendor),
    ).toBe(false)
  })
  it("名冊已改帳號／代碼 → 提示", () => {
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行", payeeBankAccount: "0000999", payeeBankCode: "999" }, vendor)).toBe(true)
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行", payeeBankAccount: "0000111", payeeBankCode: "" }, vendor)).toBe(true)
  })
})
