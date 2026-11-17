import { describe, expect, it } from "vitest";
import { bankSnapshotDiffersFromVendor, initFromDisbursement, switchPayeeKind, type PayeeKindStash } from "../DisbursementForm";

/** 驗收第六輪：複驗 harness 情境的前端部分（init／種類切換／名冊比對）。後端部分在 apps/api vendor-bank-verified.test.ts。 */
const V1 = { id: "v1", name: "甲工程行", bankName: "測試銀行", bankCode: "000", bankAccount: "0000-1111-2222", accountHolder: "甲工程行" };
const V2 = { id: "v2", name: "乙企業社", bankName: "乙銀行", bankCode: "001", bankAccount: "A-0001-1111", accountHolder: "乙企業社" };
const vendors = [V1, V2];
const otherSplit = {
  id: "d1", payeeKind: "other" as const, vendorId: null, payeeName: "丙印刷", payeeBankName: "郵局", payeeBankCode: "700",
  payeeBankAccount: "00012345678901 丙印刷行", payeeBankAccountNumber: "00012345678901", payeeAccountHolder: "丙印刷行", payeeAccountSplit: true,
};
const ctx0 = { dirty: false, stash: null as PayeeKindStash, vendorPicked: false };

describe("initFromDisbursement：依 payeeAccountSplit 決定用分欄或解析舊快照", () => {
  it("分欄實存 → 用分欄；舊單（旗標 false）→ 解析舊快照；帳號空＋戶名有值的實存分欄 → 帳號空", () => {
    expect(initFromDisbursement(otherSplit)).toMatchObject({ payeeBankAccount: "00012345678901", payeeAccountHolder: "丙印刷行" });
    expect(initFromDisbursement({ ...otherSplit, payeeBankAccountNumber: null, payeeAccountHolder: "丙印刷行", payeeAccountSplit: false })).toMatchObject({
      payeeBankAccount: "00012345678901", payeeAccountHolder: "丙印刷行",
    });
    expect(initFromDisbursement({ ...otherSplit, payeeBankAccount: "王", payeeBankAccountNumber: null, payeeAccountHolder: "王", payeeAccountSplit: true })).toMatchObject({
      payeeBankAccount: "", payeeAccountHolder: "王",
    });
  });
});

describe("switchPayeeKind", () => {
  it("d1 既有其他單 → 廠商（未選）→ 其他：四欄與 dirty 還原（存檔送 {}，帳戶不動）", () => {
    const s0 = initFromDisbursement(otherSplit);
    const toVendor = switchPayeeKind(s0, "vendor", vendors, ctx0);
    expect(toVendor.stash).not.toBeNull();
    const back = switchPayeeKind(toVendor.state, "other", vendors, { dirty: toVendor.dirty, stash: toVendor.stash, vendorPicked: false });
    expect(back.state).toMatchObject({ payeeKind: "other", payeeBankName: "郵局", payeeBankCode: "700", payeeBankAccount: "00012345678901", payeeAccountHolder: "丙印刷行" });
    expect(back.dirty).toBe(false);
  });
  it("其他 → 廠商且選過廠商 → 其他：清空並 dirty（存檔送兩欄 null）", () => {
    const s0 = initFromDisbursement(otherSplit);
    const toVendor = switchPayeeKind(s0, "vendor", vendors, ctx0);
    const picked = { ...toVendor.state, vendorId: "v1" };
    const back = switchPayeeKind(picked, "other", vendors, { dirty: toVendor.dirty, stash: toVendor.stash, vendorPicked: true });
    expect(back.state).toMatchObject({ payeeBankName: "", payeeBankCode: "", payeeBankAccount: "", payeeAccountHolder: "" });
    expect(back.dirty).toBe(true);
  });
  it("d2／e 廠商單 → 其他 → 廠商 → 其他：每次切到其他都清空並 dirty；切回廠商帶名冊", () => {
    const s0 = initFromDisbursement({ id: "d2", payeeKind: "vendor", vendorId: "v1", payeeName: "甲工程行", payeeBankName: "測試銀行（000）", payeeBankCode: "000", payeeBankAccount: "000011112222 甲工程行", payeeBankAccountNumber: "000011112222", payeeAccountHolder: "甲工程行", payeeAccountSplit: true });
    const o1 = switchPayeeKind(s0, "other", vendors, ctx0);
    expect(o1.state).toMatchObject({ payeeBankAccount: "", payeeAccountHolder: "" });
    expect(o1.dirty).toBe(true);
    const v1 = switchPayeeKind(o1.state, "vendor", vendors, { dirty: o1.dirty, stash: o1.stash, vendorPicked: false });
    expect(v1.state).toMatchObject({ payeeKind: "vendor", payeeBankAccount: "0000-1111-2222", payeeAccountHolder: "甲工程行" });
    const o2 = switchPayeeKind(v1.state, "other", vendors, { dirty: v1.dirty, stash: v1.stash, vendorPicked: false });
    expect(o2.state).toMatchObject({ payeeBankAccount: "", payeeAccountHolder: "" }); // 有已選廠商 → 不還原
    expect(o2.dirty).toBe(true);
  });
});

describe("bankSnapshotDiffersFromVendor（f／i）", () => {
  it("f 名冊帳號含非數字的廠商單（舊快照解析）→ 不誤報；i 名冊改帳號 → 提示不同", () => {
    const f = initFromDisbursement({ id: "f", payeeKind: "vendor", vendorId: "v2", payeeName: "乙企業社", payeeBankName: "乙銀行（001）", payeeBankCode: "001", payeeBankAccount: "A00011111 乙企業社", payeeAccountSplit: false });
    expect(bankSnapshotDiffersFromVendor(f, V2)).toBe(false);
    const i = initFromDisbursement({ id: "i", payeeKind: "vendor", vendorId: "v1", payeeName: "甲工程行", payeeBankName: "測試銀行（000）", payeeBankCode: "000", payeeBankAccount: "000011112222 甲工程行", payeeBankAccountNumber: "000011112222", payeeAccountHolder: "甲工程行", payeeAccountSplit: true });
    expect(bankSnapshotDiffersFromVendor(i, { ...V1, bankAccount: "9999-8888-7777" })).toBe(true);
  });
  it("戶名比對前去控制字元、按字元截 120（與後端 cleanHolder 一致）", () => {
    const base = { payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: "000011112222" };
    expect(bankSnapshotDiffersFromVendor({ ...base, payeeAccountHolder: "甲工程​行" }, V1)).toBe(false);
    const long = "😀".repeat(130);
    expect(bankSnapshotDiffersFromVendor({ ...base, payeeAccountHolder: long }, { ...V1, accountHolder: "😀".repeat(120) })).toBe(false);
  });
});

describe("終驗：舊快照前綴當銀行名提示", () => {
  it("單上沒有銀行名 → 「郵局」帶進銀行名、帳號欄是數字段", () => {
    const s0 = initFromDisbursement({ id: "x", payeeKind: "other", vendorId: null, payeeName: "丙", payeeBankName: null, payeeBankCode: null, payeeBankAccount: "郵局 0001234-5678901 丙印刷行", payeeAccountSplit: false });
    expect(s0).toMatchObject({ payeeBankName: "郵局", payeeBankAccount: "0001234-5678901", payeeAccountHolder: "丙印刷行" });
  });
});
