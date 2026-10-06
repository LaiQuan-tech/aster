import { describe, it, expect } from "vitest";
import {
  PERSONAL_KEYS,
  bankDisplay,
  normalizeIdNumber,
  personalChanges,
  personalFormFrom,
  personalValueForSave,
} from "../employee-personal";

/**
 * lib/employee-personal.ts：員工管理頁個資欄位的顯示與列內編輯（純函式）。
 * 全部是明顯的假值，repo 是公開的。
 */
const FILLED = {
  birthday: "2000-01-01",
  idNumber: "A123456789",
  registeredAddress: "測試市測試區測試路1號",
  bankCode: "000",
  bankName: "測試銀行",
  bankAccount: "0000000000",
  accountHolder: "測試戶名",
};

describe("personalFormFrom", () => {
  it("有值照帶；null／沒回的鍵都變空字串（受控 input 不吃 null）", () => {
    expect(personalFormFrom(FILLED)).toEqual(FILLED);
    expect(personalFormFrom({})).toEqual(Object.fromEntries(PERSONAL_KEYS.map((key) => [key, ""])));
    expect(personalFormFrom({ birthday: null, bankCode: null }).birthday).toBe("");
  });
});

describe("normalizeIdNumber／personalValueForSave", () => {
  it("身分證：去頭尾空白＋轉大寫，不驗格式（居留證／護照照收）", () => {
    expect(normalizeIdNumber("  a123456789 ")).toBe("A123456789");
    expect(normalizeIdNumber("ab12345678")).toBe("AB12345678"); // 外籍居留證
    expect(personalValueForSave("idNumber", " x 9 ")).toBe("X 9"); // 內部空白不動、也不拒絕
  });

  it("其他欄位只 trim（不轉大寫）；空字串／純空白 → null＝清空", () => {
    expect(personalValueForSave("bankName", "  abc銀行 ")).toBe("abc銀行");
    expect(personalValueForSave("registeredAddress", "")).toBeNull();
    expect(personalValueForSave("bankAccount", "   ")).toBeNull();
    expect(personalValueForSave("idNumber", "  ")).toBeNull();
  });
});

describe("personalChanges — 只送有變更的欄位（partial PUT）", () => {
  it("完全沒動 → {}（呼叫端據此不打 PUT）", () => {
    expect(personalChanges(FILLED, personalFormFrom(FILLED))).toEqual({});
  });

  it("沒資料的員工、表單也維持空 → {}（null 與空字串視為相同）", () => {
    expect(personalChanges({}, personalFormFrom({}))).toEqual({});
    expect(personalChanges({ birthday: null, idNumber: null }, personalFormFrom({}))).toEqual({});
  });

  it("只改一個欄位 → 只有那一欄", () => {
    const form = { ...personalFormFrom(FILLED), bankAccount: "1111111111" };
    expect(personalChanges(FILLED, form)).toEqual({ bankAccount: "1111111111" });
  });

  it("改身分證：送出的是大寫、去空白後的值", () => {
    const form = { ...personalFormFrom(FILLED), idNumber: " b223456789 " };
    expect(personalChanges(FILLED, form)).toEqual({ idNumber: "B223456789" });
  });

  it("原本是小寫、沒動它：不算變更（不會為了轉大寫而重寫）", () => {
    const original = { ...FILLED, idNumber: "a123456789" };
    expect(personalChanges(original, personalFormFrom(original))).toEqual({});
  });

  it("清空既有值 → null；原本沒值而填入 → 該值", () => {
    const cleared = { ...personalFormFrom(FILLED), registeredAddress: "", accountHolder: "  " };
    expect(personalChanges(FILLED, cleared)).toEqual({ registeredAddress: null, accountHolder: null });

    const filled = { ...personalFormFrom({}), birthday: "1999-12-31", bankCode: " 007 " };
    expect(personalChanges({}, filled)).toEqual({ birthday: "1999-12-31", bankCode: "007" });
  });

  it("多欄同時改（含日期）→ 全部帶上，沒改的不帶", () => {
    const form = { ...personalFormFrom(FILLED), birthday: "2001-02-03", bankName: "測試銀行乙", bankCode: "001" };
    expect(personalChanges(FILLED, form)).toEqual({ birthday: "2001-02-03", bankName: "測試銀行乙", bankCode: "001" });
  });
});

describe("bankDisplay — 列表「匯款帳號」欄", () => {
  const base = { name: "測試員工" };

  it("第一行「代碼 銀行名稱」、第二行帳號；戶名與員工姓名不同才顯示", () => {
    expect(bankDisplay({ ...base, ...FILLED })).toEqual({ bank: "000 測試銀行", account: "0000000000", holder: "測試戶名" });
  });

  it("戶名與員工姓名相同（含空白差異）→ 不顯示戶名", () => {
    expect(bankDisplay({ ...base, bankCode: "000", bankAccount: "0000000000", accountHolder: "測試員工" }).holder).toBe("");
    expect(bankDisplay({ name: "測試 員工", accountHolder: "測試員工" }).holder).toBe("");
  });

  it("只有代碼或只有名稱：不多出空格；全空 → 三項都是空字串", () => {
    expect(bankDisplay({ ...base, bankCode: "000" }).bank).toBe("000");
    expect(bankDisplay({ ...base, bankName: "測試銀行" }).bank).toBe("測試銀行");
    expect(bankDisplay({ ...base })).toEqual({ bank: "", account: "", holder: "" });
    expect(bankDisplay({ ...base, bankCode: null, bankName: " ", bankAccount: null, accountHolder: null })).toEqual({
      bank: "",
      account: "",
      holder: "",
    });
  });

  it("只有帳號（沒銀行）：第一行空、帳號照顯示", () => {
    expect(bankDisplay({ ...base, bankAccount: "0000000000" })).toEqual({ bank: "", account: "0000000000", holder: "" });
  });
});
