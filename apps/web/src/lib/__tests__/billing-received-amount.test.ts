import { describe, expect, it, vi } from "vitest";

vi.mock("../api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("../supabase-browser", () => ({ getSupabaseBrowser: () => ({}) }));

import { RECEIVED_AMOUNT_HINT, RECEIVED_AMOUNT_LABEL, receivedAmountPlaceholder } from "../projects-ext-api";

/**
 * 專案請款期程「標記入帳」的入帳金額輸入框（2026-10-11）：一律填**未稅**。
 * 收入以未稅計；有人把銀行入帳的含稅金額填進來，收入會多算 5%（集團總覽的資料品質提醒會抓「實收大於應收（未稅）」）。
 * 所以標籤、placeholder、說明都要明寫「未稅」——這裡釘住文字，免得改版時被悄悄拿掉。
 */

describe("入帳金額標示未稅", () => {
  it("標籤與說明都寫明「未稅」，說明提醒不要填含稅金額、也交代留空的意思", () => {
    expect(RECEIVED_AMOUNT_LABEL).toBe("入帳金額（未稅）");
    expect(RECEIVED_AMOUNT_HINT).toContain("未稅");
    expect(RECEIVED_AMOUNT_HINT).toContain("含稅");
    expect(RECEIVED_AMOUNT_HINT).toContain("留空");
  });

  it("placeholder：帶該期應收的未稅金額（千分位），金額未知只寫「未稅金額」", () => {
    expect(receivedAmountPlaceholder(120000)).toBe("未稅 120,000");
    expect(receivedAmountPlaceholder(0)).toBe("未稅 0");
    expect(receivedAmountPlaceholder(null)).toBe("未稅金額");
    expect(receivedAmountPlaceholder(undefined)).toBe("未稅金額");
  });
});
