import { describe, expect, it } from "vitest";
import { bankSnapshotDiffersFromVendor } from "../DisbursementForm";

const v = { bankName: "測試銀行", bankCode: "000", bankAccount: "0000-111", accountHolder: "測試甲工程行" };
describe("bankSnapshotDiffersFromVendor（驗收第五輪：帳號／戶名分欄）", () => {
  it("帳號（去連字號）與戶名都等於名冊 → 不算不同；戶名空（舊單）也不算不同", () => {
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行（000）", payeeBankCode: "000", payeeBankAccount: "0000111", payeeAccountHolder: "測試甲工程行" }, v)).toBe(false);
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: "0000-111", payeeAccountHolder: "" }, v)).toBe(false);
  });
  it("戶名或帳號不同 → 不同", () => {
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: "0000111", payeeAccountHolder: "別人" }, v)).toBe(true);
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: "0000999", payeeAccountHolder: "測試甲工程行" }, v)).toBe(true);
  });
  it("名冊帳號含非數字的廠商單（解析舊快照得到的帳號段）→ 不誤報", () => {
    const w = { ...v, bankAccount: "A-0001-1111" };
    expect(bankSnapshotDiffersFromVendor({ payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: "A00011111", payeeAccountHolder: "測試甲工程行" }, w)).toBe(false);
  });
});
