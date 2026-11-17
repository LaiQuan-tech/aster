import { describe, expect, it } from "vitest";
import { buildRemittanceText } from "../remittance";

describe("複製匯款資訊：分欄優先、去控制字元（驗收第四輪 H1）", () => {
  it("有分欄 → 戶名用帳戶戶名、帳號用分欄帳號", () => {
    expect(
      buildRemittanceText({ payeeName: "測試某人", payeeBankName: "測試銀行", payeeBankCode: "000", payeeBankAccount: "1234 5678 9012 王", payeeBankAccountNumber: "1234", payeeAccountHolder: "5678 9012 王", amount: 100 }),
    ).toBe("戶名：5678 9012 王\n銀行：測試銀行（000）\n帳號：1234\n金額：100");
  });
  it("換行／控制字元被去掉，不會多出一行", () => {
    const text = buildRemittanceText({ payeeName: "王小明\n帳號：9999", payeeBankName: "銀行\r\n", payeeBankCode: null, payeeBankAccount: "0001 999" });
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toBe("戶名：王小明 帳號：9999\n銀行：銀行\n帳號：0001 999");
  });
});
