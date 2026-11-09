/**
 * MoneyInput／lib/money 的單元測試（靜態渲染＋純函式，不需要 DOM）。假資料。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MoneyInput, moneyInputDisplay } from "../MoneyInput";
import { formatMoney, groupMoneyDigits, sanitizeMoneyInput, stripMoneyCommas } from "@/lib/money";

const noop = () => {};

describe("MoneyInput 顯示", () => {
  it("未聚焦：千分位", () => {
    const html = renderToStaticMarkup(<MoneyInput aria-label="未稅" value="1428571" onValueChange={noop} className="text-right" />);
    expect(html).toContain('value="1,428,571"');
    expect(html).toContain('type="text"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('class="text-right"');
  });

  it("數字型別的 value 也加千分位", () => {
    expect(renderToStaticMarkup(<MoneyInput value={1500000} onValueChange={noop} />)).toContain('value="1,500,000"');
  });

  it("聚焦：顯示純數字方便輸入", () => {
    expect(moneyInputDisplay("1428571", true)).toBe("1428571");
    expect(moneyInputDisplay("1428571", false)).toBe("1,428,571");
    expect(moneyInputDisplay(300000, true)).toBe("300000");
  });

  it("空值：空白", () => {
    expect(moneyInputDisplay("", false)).toBe("");
    expect(moneyInputDisplay(null, false)).toBe("");
    expect(moneyInputDisplay(undefined, true)).toBe("");
    expect(renderToStaticMarkup(<MoneyInput value={null} onValueChange={noop} />)).toContain('value=""');
  });

  it("負數與小數保留", () => {
    expect(moneyInputDisplay("-1234567.5", false)).toBe("-1,234,567.5");
    expect(moneyInputDisplay("0.5", false)).toBe("0.5");
  });

  it("不是數字的舊值原樣顯示，不吃掉內容", () => {
    expect(moneyInputDisplay("abc", false)).toBe("abc");
  });

  it("fieldStyle 套用共用外框 class", () => {
    const html = renderToStaticMarkup(<MoneyInput value="1" onValueChange={noop} fieldStyle className="mt-1" />);
    expect(html).toMatch(/class="[^"]*rounded-xl[^"]*mt-1"/);
  });
});

describe("sanitizeMoneyInput（打字／貼上）", () => {
  it("貼上「1,234,567」→ 1234567", () => {
    expect(sanitizeMoneyInput("1,234,567")).toBe("1234567");
  });

  it("非數字字元濾掉、全形數字轉半形", () => {
    expect(sanitizeMoneyInput("NT$ 30,000元")).toBe("30000");
    expect(sanitizeMoneyInput("１２３，４５６")).toBe("123456");
    expect(sanitizeMoneyInput("abc")).toBe("");
    expect(sanitizeMoneyInput("")).toBe("");
  });

  it("預設不收負號與小數點", () => {
    expect(sanitizeMoneyInput("-500")).toBe("500");
    expect(sanitizeMoneyInput("12.5")).toBe("12");
  });

  it("不收小數：小數點後捨去，不放大", () => {
    expect(sanitizeMoneyInput("12,000.00")).toBe("12000");
    expect(sanitizeMoneyInput("1234.56")).toBe("1234");
    expect(sanitizeMoneyInput(".5")).toBe("");
    // 只認第一個點為小數點，其後整段捨去。
    expect(sanitizeMoneyInput("1.2.3")).toBe("1");
    expect(sanitizeMoneyInput("1.2.3", { allowDecimal: true })).toBe("1.23");
    // 舊資料小數字串：未聚焦顯示不放大
    expect(moneyInputDisplay("1234.5", false)).toBe("1,234.5");
    expect(moneyInputDisplay(1500.75, false)).toBe("1,500.75");
  });

  it("allowNegative／allowDecimal", () => {
    expect(sanitizeMoneyInput("-1,200", { allowNegative: true })).toBe("-1200");
    expect(sanitizeMoneyInput("-", { allowNegative: true })).toBe("-");
    expect(sanitizeMoneyInput("1-2", { allowNegative: true })).toBe("12");
    expect(sanitizeMoneyInput("3,000.55.1", { allowDecimal: true })).toBe("3000.551");
    expect(sanitizeMoneyInput("12.", { allowDecimal: true })).toBe("12.");
  });
});

describe("formatMoney／stripMoneyCommas", () => {
  it("千分位、到元、空值", () => {
    expect(formatMoney(71429)).toBe("71,429");
    expect(formatMoney(1428571.4)).toBe("1,428,571");
    expect(formatMoney("1500000")).toBe("1,500,000");
    expect(formatMoney("1,500,000")).toBe("1,500,000");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined, { empty: "" })).toBe("");
    expect(formatMoney("")).toBe("—");
    expect(formatMoney("abc")).toBe("—");
    expect(formatMoney(-0.4)).toBe("0");
    expect(formatMoney(-1234.6)).toBe("-1,235");
  });

  it("小數位", () => {
    expect(formatMoney(1234.567, { maximumFractionDigits: 2 })).toBe("1,234.57");
    expect(formatMoney(1234, { maximumFractionDigits: 2 })).toBe("1,234");
  });

  it("驗證前去逗號", () => {
    expect(Number(stripMoneyCommas("1,234,567"))).toBe(1234567);
    expect(groupMoneyDigits("0001234")).toBe("1,234");
  });
});
