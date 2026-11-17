import { describe, expect, it } from "vitest";
import { accountSegment, maskAccountTail, payeeAccountSummary, splitAccountSnapshot, taipeiDate, vendorBankStatus } from "../payee-account";

const base = { payeeName: "測試廠商甲", payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: null, payeeKind: "vendor" as const, vendorId: "v1" };

describe("payeeAccountSummary（核准畫面收款帳戶）", () => {
  it("用後端遮好的末 4 碼、照名冊；戶名＝後端 payeeAccountHolder", () => {
    const s = payeeAccountSummary({ ...base, payeeAccountMasked: "****1234", payeeAccountSource: "roster", payeeAccountHolder: "測試廠商甲" });
    expect(s).toMatchObject({ holder: "測試廠商甲", holderMismatchText: null, bankLine: "測試銀行（000）", masked: "****1234", sourceLabel: "照名冊", manual: false, changedText: null, pendingText: null });
  });
  it("收款名稱與帳戶戶名不同 → 提醒；沒有戶名退回收款名稱", () => {
    expect(payeeAccountSummary({ ...base, payeeAccountHolder: "王小明" }).holderMismatchText).toBe("收款名稱「測試廠商甲」與帳戶戶名「王小明」不同，請核對");
    expect(payeeAccountSummary({ ...base, payeeAccountHolder: null }).holder).toBe("測試廠商甲");
  });
  it("非登錄收款方＝手動輸入；舊 API 沒帶 masked 時自己遮", () => {
    const s = payeeAccountSummary({ ...base, payeeKind: "other", vendorId: null, payeeBankAccount: "1111-2222-3333 戶名9" });
    expect(s.masked).toBe("****3333");
    expect(s.sourceLabel).toBe("手動輸入（非登錄廠商）");
  });
  it("30 天內變更 → 黃色警示日期（台北時區）；待覆核、未確認 → 警示", () => {
    const s = payeeAccountSummary({ ...base, payeeAccountMasked: "****1", payeeBankChangedAt: "2026-11-16T17:30:00Z", vendorBankChangePending: true });
    expect(s.changedText).toBe("此廠商收款帳戶於 2026/11/17 變更或確認過");
    expect(s.pendingText).toMatch(/待覆核/);
    expect(payeeAccountSummary({ ...base, vendorBankVerified: false }).pendingText).toMatch(/尚未經老闆／平台管理員確認/);
  });
  it("驗收 A：戶名開頭是數字不混進末 4 碼", () => {
    expect(maskAccountTail("0001234567890 104人力銀行")).toBe("****7890");
    expect(maskAccountTail("0000 1111 2222 3M台灣", "3M台灣")).toBe("****2222");
    expect(maskAccountTail("0000111222 3M台灣")).toBe("****1222");
    expect(accountSegment("0001234567890 104人力銀行", "104人力銀行")).toBe("0001234567890");
    expect(maskAccountTail("")).toBeNull();
    expect(taipeiDate("2026-01-31T16:00:00Z")).toBe("2026/02/01");
  });
});

describe("F2：帳號含空白／連字號、戶名開頭數字", () => {
  it("帳號段與戶名段拆對", () => {
    expect(maskAccountTail("0123 4567 8901")).toBe("****8901");
    expect(payeeAccountSummary({ ...base, payeeBankAccount: "0123 4567 8901", payeeAccountHolder: undefined }).holder).toBe("測試廠商甲");
    expect(splitAccountSnapshot("0123 4567 8901")).toEqual({ account: "0123 4567 8901", holder: null });
    expect(splitAccountSnapshot("0123 4567 8901 王小明")).toEqual({ account: "0123 4567 8901", holder: "王小明" });
    expect(maskAccountTail("012-345 678")).toBe("****5678");
    expect(maskAccountTail("0001234567890 104人力銀行")).toBe("****7890");
    expect(maskAccountTail("0001234567890 3M台灣")).toBe("****7890");
    expect(maskAccountTail("0000000005678")).toBe("****5678");
  });
  it("S2 紅框、F6 現金無帳號不提示未確認", () => {
    expect(payeeAccountSummary({ ...base, payeeRebindWarning: { message: "曾解除綁定", subcontractIds: ["s"] } }).rebindText).toBe("曾解除綁定");
    expect(payeeAccountSummary({ ...base, vendorBankVerified: false, method: "cash", payeeAccountMasked: null }).pendingText).toBeNull();
    expect(payeeAccountSummary({ ...base, vendorBankVerified: false, method: "transfer", payeeAccountMasked: null }).pendingText).toMatch(/尚未經老闆／平台管理員確認/);
  });
  it("F7 名冊帳戶狀態", () => {
    expect(vendorBankStatus({ bankChangePending: true, bankVerified: true })?.label).toBe("帳戶變更覆核中");
    expect(vendorBankStatus({ bankVerified: true })?.label).toBe("帳戶已確認");
    expect(vendorBankStatus({ bankVerified: false, bankAccount: "123" })?.label).toBe("帳戶待確認");
    expect(vendorBankStatus({ bankVerified: false, bankAccount: null })).toBeNull();
  });
});

describe("驗收第三輪：與 API 同一套拆法（完整帳號後一律戶名、NFKC、連續空白）", () => {
  it.each([
    ["12345678 7-11", "12345678", "7-11"],
    ["0001234567890 104 人力銀行", "0001234567890", "104 人力銀行"],
    ["０１２３　４５６７　８９０１　王小明", "0123 4567 8901", "王小明"],
    ["0123   4567  8901", "0123 4567 8901", null],
    ["012-345 678", "012-345 678", null],
  ])("%s", (raw, account, holder) => {
    expect(splitAccountSnapshot(raw)).toEqual({ account, holder });
  });
  it("末 4 碼", () => {
    expect(maskAccountTail("12345678 7-11")).toBe("****5678");
    expect(maskAccountTail("０００１２３４５６７８９０ 104 人力銀行")).toBe("****7890");
  });
});

describe("終驗：舊快照非數字前綴（與 API 同一套）", () => {
  it("「郵局 0001234-5678901 丙印刷行」→ 帳號取數字段、前綴另回 prefix", () => {
    expect(splitAccountSnapshot("郵局 0001234-5678901 丙印刷行")).toEqual({ account: "0001234-5678901", holder: "丙印刷行", prefix: "郵局" });
    expect(maskAccountTail("郵局 0001234-5678901 丙印刷行")).toBe("****8901");
    expect(splitAccountSnapshot("TW-12345 丙印刷行")).toEqual({ account: "TW-12345", holder: "丙印刷行" });
  });
});
