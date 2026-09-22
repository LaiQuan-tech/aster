import { describe, it, expect } from "vitest";
import { buildRemittanceText, formatBankLine } from "../remittance";

/**
 * lib/remittance.ts（M15 一鍵複製帳號；從 lib/disbursements-api.ts 抽出）：純函式部分。
 * copyText 碰 DOM／clipboard，不在這裡測。
 */
describe("formatBankLine", () => {
  it("代碼已內嵌就照原樣；否則用括號補在後面；只有代碼／只有名稱各自成立", () => {
    expect(formatBankLine("國泰世華（013）", "013")).toBe("國泰世華（013）");
    expect(formatBankLine("國泰世華", "013")).toBe("國泰世華（013）");
    expect(formatBankLine(null, "013")).toBe("013");
    expect(formatBankLine("國泰世華", null)).toBe("國泰世華");
    expect(formatBankLine(undefined, undefined)).toBe("");
  });
});

describe("buildRemittanceText", () => {
  it("四行：戶名／銀行（代號）／帳號／金額，金額千分位", () => {
    expect(
      buildRemittanceText({
        payeeName: "甲廠商",
        payeeBankName: "國泰世華",
        payeeBankCode: "013",
        payeeBankAccount: "1234567890",
        amount: 1_234_567,
      }),
    ).toBe("戶名：甲廠商\n銀行：國泰世華（013）\n帳號：1234567890\n金額：1,234,567");
  });

  it("廠商頁沒有金額 → 只有三行；空值顯示 —", () => {
    expect(buildRemittanceText({ payeeName: "", payeeBankName: null, payeeBankCode: null, payeeBankAccount: null })).toBe(
      "戶名：—\n銀行：—\n帳號：—",
    );
    expect(buildRemittanceText({ payeeName: "x", payeeBankName: null, payeeBankCode: null, payeeBankAccount: null, amount: 0 })).toContain(
      "金額：0",
    );
  });
});
