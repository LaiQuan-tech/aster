import { describe, expect, it } from "vitest";
import {
  ATTEMPT_REUSE_MS,
  LATE_CANCEL_BANNER,
  attemptFor,
  clearLateCancelled,
  isUncertainPunchError,
  markLateCancelled,
  newClientRequestId,
  readLateCancelled,
  showLateCancelBanner,
  uncertainBlocksPunch,
} from "../punch-attempt";
import { isPromiseTimeout, PromiseTimeoutError } from "../with-timeout";
import { precheckForcedPunchWithPending, summarizeWithPendingFixPunch, withPendingFixPunch } from "../pending-fix-punch";
import { needsReInConfirm, longCarryOverOutHours, type PunchLike } from "../punch-state";

/** API 的 clientRequestId 規則（apps/api/src/routes/punch.ts punchSchema）。 */
const API_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

describe("請求 id（打卡冪等）", () => {
  it("newClientRequestId 符合 API 格式；沒有 crypto.randomUUID 的退路也符合", () => {
    expect(newClientRequestId()).toMatch(API_ID_RE);
    const saved = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      expect(newClientRequestId(() => 0.5)).toMatch(API_ID_RE);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: saved, configurable: true });
    }
  });

  it("結果不明的同一種卡、10 分鐘內 → 沿用同一個 id；換種類、超過 10 分鐘、沒有上一次 → 新 id", () => {
    let n = 0;
    const gen = () => `id-${++n}-xxxxxxxx`;
    const first = attemptFor(null, "out", 1_000, gen);
    expect(first).toEqual({ id: "id-1-xxxxxxxx", type: "out", at: 1_000 });
    expect(attemptFor(first, "out", 1_000 + 30_000, gen)).toBe(first);
    expect(attemptFor(first, "in", 1_000 + 30_000, gen).id).toBe("id-2-xxxxxxxx");
    expect(attemptFor(first, "out", 1_000 + ATTEMPT_REUSE_MS, gen).id).toBe("id-3-xxxxxxxx");
  });

  it("逾時／斷線／5xx 算結果不明；4xx 不算", () => {
    expect(isUncertainPunchError(new PromiseTimeoutError(20_000), isPromiseTimeout)).toBe(true);
    expect(isUncertainPunchError(new TypeError("Load failed"), isPromiseTimeout)).toBe(true);
    expect(isUncertainPunchError(Object.assign(new Error("[502] bad"), { status: 502 }), isPromiseTimeout)).toBe(true);
    expect(isUncertainPunchError(Object.assign(new Error("[409] period_closed"), { status: 409 }), isPromiseTimeout)).toBe(false);
  });

  it("結果不明時：拿不到最新紀錄就擋；拿到了（含空陣列）放行；結果確定一律放行", () => {
    expect(uncertainBlocksPunch(true, null)).toBe(true);
    expect(uncertainBlocksPunch(true, [])).toBe(false);
    expect(uncertainBlocksPunch(false, null)).toBe(false);
  });
});

describe("遲到理由取消的橫幅", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it("取消後記住今天；今天沒有上班卡 → 顯示；打上班卡或換日 → 不顯示", () => {
    const s = mem();
    markLateCancelled(s, "2026-10-23");
    expect(readLateCancelled(s)).toBe("2026-10-23");
    expect(showLateCancelBanner("2026-10-23", "2026-10-23", { phase: "none", firstInAt: null })).toBe(true);
    expect(showLateCancelBanner("2026-10-23", "2026-10-23", { phase: "working", firstInAt: "2026-10-23T06:40:00Z" })).toBe(false);
    expect(showLateCancelBanner("2026-10-23", "2026-10-24", { phase: "none", firstInAt: null })).toBe(false);
    clearLateCancelled(s);
    expect(readLateCancelled(s)).toBeNull();
    expect(LATE_CANCEL_BANNER).toBe("上班卡尚未打成功（未填遲到原因），請再按一次上班打卡");
  });

  it("待核准的上班補卡也算有上班卡（firstInAt 用合併後摘要）；讀寫例外不丟出", () => {
    const pending = [{ id: "r1", kind: "fix_punch", status: "pending", segments: [{ date: "2026-10-23", startTime: "14:20", type: "in" }] }];
    const merged = summarizeWithPendingFixPunch(withPendingFixPunch([], pending, "2026-10-23"));
    expect(showLateCancelBanner("2026-10-23", "2026-10-23", merged)).toBe(false);
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(() => markLateCancelled(broken, "2026-10-23")).not.toThrow();
    expect(readLateCancelled(broken)).toBeNull();
    expect(() => clearLateCancelled(broken)).not.toThrow();
  });
});

describe("狀態不明時二選一：待核准的上班補卡算進去", () => {
  const today = "2026-10-23";
  const pending = [{ id: "r1", kind: "fix_punch", status: "pending", segments: [{ date: today, startTime: "14:20", type: "in" }] }];

  it("今天只有待核准的上班補卡、選下班 → 送 out", () => {
    expect(precheckForcedPunchWithPending("out", [], pending, today)).toEqual({ send: true, type: "out" });
  });
  it("同上、選上班 → 不送，按鈕改為「下班打卡」", () => {
    const check = precheckForcedPunchWithPending("in", [], pending, today);
    expect(check.send).toBe(false);
    if (!check.send) expect(check.summary?.nextLabel).toBe("下班打卡");
  });
  it("讀不到最新紀錄 → 照選的送", () => {
    expect(precheckForcedPunchWithPending("in", null, pending, today)).toEqual({ send: true, type: "in" });
  });
});

describe("拿到最新紀錄後用其摘要再確認（畫面是舊的）", () => {
  const tp = (s: string) => Date.parse(`${s.replace(" ", "T")}:00+08:00`);
  it("畫面停在上班中，最新紀錄 3 分鐘前已下班 → 再上班要確認", () => {
    const latest: PunchLike[] = [
      { id: "a", type: "in", punch_at: new Date(tp("2026-10-25 18:59")).toISOString() },
      { id: "b", type: "out", punch_at: new Date(tp("2026-10-25 23:35")).toISOString() },
    ];
    expect(needsReInConfirm(summarizeWithPendingFixPunch(latest), tp("2026-10-25 23:38"))).toBe(true);
  });
  it("最新紀錄是跨日 13 小時的上班卡 → 下班要確認", () => {
    const latest: PunchLike[] = [{ id: "c", type: "in", punch_at: new Date(tp("2026-10-21 14:34")).toISOString(), carry_over: true }];
    expect(longCarryOverOutHours(summarizeWithPendingFixPunch(latest), tp("2026-10-22 03:40"))).toBe(13);
  });
});
