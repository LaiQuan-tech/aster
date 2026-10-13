import { describe, expect, it } from "vitest";
import { hasWfhPunch, readWfhChoice, wfhPunchEnabled, writeWfhChoice, type StorageLike } from "../wfh-punch";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("wfhPunchEnabled — 只有 /me features.wfhPunch === true 才顯示勾選框", () => {
  it("開通／未開通／舊 API", () => {
    expect(wfhPunchEnabled({ features: { wfhPunch: true } })).toBe(true);
    expect(wfhPunchEnabled({ features: { wfhPunch: false } })).toBe(false);
    expect(wfhPunchEnabled({ features: null })).toBe(false);
    expect(wfhPunchEnabled({})).toBe(false);
    expect(wfhPunchEnabled(null)).toBe(false);
  });
});

describe("勾選狀態只記住當天", () => {
  it("今天勾 → 今天讀得到、明天讀不到；取消 → 清掉", () => {
    const s = memoryStorage();
    writeWfhChoice(s, "2026-10-13", true);
    expect(readWfhChoice(s, "2026-10-13")).toBe(true);
    expect(readWfhChoice(s, "2026-10-14")).toBe(false);
    writeWfhChoice(s, "2026-10-13", false);
    expect(readWfhChoice(s, "2026-10-13")).toBe(false);
  });

  it("storage 不能用（null／丟例外）→ 當沒勾、寫入不炸", () => {
    expect(readWfhChoice(null, "2026-10-13")).toBe(false);
    expect(readWfhChoice(throwing, "2026-10-13")).toBe(false);
    expect(() => writeWfhChoice(throwing, "2026-10-13", true)).not.toThrow();
    expect(() => writeWfhChoice(null, "2026-10-13", true)).not.toThrow();
  });
});

describe("hasWfhPunch — 今日狀態標「（在家）」", () => {
  it("任一筆 wfh === true 才算", () => {
    expect(hasWfhPunch([{ type: "in", punch_at: "x", wfh: true }])).toBe(true);
    expect(hasWfhPunch([{ type: "in", punch_at: "x", wfh: false }, { type: "out", punch_at: "y" }])).toBe(false);
    expect(hasWfhPunch([])).toBe(false);
  });
});
