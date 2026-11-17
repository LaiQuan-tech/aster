import { describe, expect, it } from "vitest";
import { maskAccountTail, payeeAccountSummary, taipeiDate } from "../payee-account";

const base = { payeeName: "測試廠商甲", payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: null, payeeKind: "vendor" as const, vendorId: "v1" };

describe("payeeAccountSummary（核准畫面收款帳戶）", () => {
  it("用後端遮好的末 4 碼、照名冊", () => {
    const s = payeeAccountSummary({ ...base, payeeAccountMasked: "****1234", payeeAccountSource: "roster" });
    expect(s).toMatchObject({ holder: "測試廠商甲", bankLine: "測試銀行（000）", masked: "****1234", sourceLabel: "照名冊", manual: false, changedText: null, pendingText: null });
  });
  it("非登錄收款方＝手動輸入；舊 API 沒帶 masked 時自己遮", () => {
    const s = payeeAccountSummary({ ...base, payeeKind: "other", vendorId: null, payeeBankAccount: "1111-2222-3333 戶名9" });
    expect(s.masked).toBe("****3333");
    expect(s.sourceLabel).toBe("手動輸入（非登錄廠商）");
  });
  it("30 天內變更 → 黃色警示日期（台北時區）；待覆核 → 警示", () => {
    const s = payeeAccountSummary({ ...base, payeeAccountMasked: "****1", payeeBankChangedAt: "2026-11-16T17:30:00Z", vendorBankChangePending: true });
    expect(s.changedText).toBe("此廠商收款帳戶於 2026/11/17 變更過");
    expect(s.pendingText).toMatch(/待覆核/);
  });
  it("maskAccountTail／taipeiDate", () => {
    expect(maskAccountTail("")).toBeNull();
    expect(maskAccountTail("0000000005678")).toBe("****5678");
    expect(taipeiDate("2026-01-31T16:00:00Z")).toBe("2026/02/01");
  });
});
