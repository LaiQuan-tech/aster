import { describe, it, expect } from "vitest";
import { BEYOND_CAP_VOID_NOTE, isVoidedBeyondCapDraft } from "../overtime-void";

// 後端 apps/api/src/services/overtime-void.ts 的鏡像；常數字串由 api 端測試對照。
const voided = { status: "draft", source: "beyond_cap", minutes: 0, amount: 0, note: BEYOND_CAP_VOID_NOTE };

describe("isVoidedBeyondCapDraft（加班另計頁標「已作廢（月表重開）」）", () => {
  it("draft＋beyond_cap＋0 分鐘＋金額 0／null＋作廢註記 → 作廢", () => {
    expect(isVoidedBeyondCapDraft(voided)).toBe(true);
    expect(isVoidedBeyondCapDraft({ ...voided, amount: null })).toBe(true);
  });

  it("手動補登 0 分鐘固定金額、填了金額、沒註記、已付款 → 不是作廢", () => {
    expect(isVoidedBeyondCapDraft({ ...voided, source: "manual" })).toBe(false);
    expect(isVoidedBeyondCapDraft({ ...voided, amount: 800 })).toBe(false);
    expect(isVoidedBeyondCapDraft({ ...voided, note: "" })).toBe(false);
    expect(isVoidedBeyondCapDraft({ ...voided, status: "paid" })).toBe(false);
    expect(isVoidedBeyondCapDraft({ ...voided, minutes: 45 })).toBe(false);
  });
});
