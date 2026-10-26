import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CARRY_OVER_PUNCH_IN_LABEL,
  longCarryOverOutHours,
  needsReInConfirm,
  precheckForcedPunch,
  precheckPunch,
  punchCardActions,
  shouldApplyPolledPunches,
  summarizePunches,
  type PunchCardUi,
  type PunchLike,
} from "../punch-state";
import { summarizeWithPendingFixPunch, withPendingFixPunch } from "../pending-fix-punch";
import { showDinnerCheckbox } from "../dinner-prompt";
import { isPromiseTimeout, withTimeout } from "../with-timeout";

/**
 * 2026-10-26 正式站再次回報「下班時沒跑出打卡按鈕，只能補卡」：個人班別 14:30–22:30、開通在家上班打卡，
 * 常凌晨 01–03 在家再上一段、一天兩段班。用他 10/18–10/25 的實際打卡（台北）逐點斷言首頁按鈕。
 *
 * 伺服器的 /punch/today 用跟 API 相同的規則模擬（今天的紀錄＋前一天 16 小時內還開著的上班卡，截止＝今天 06:00
 * 與那天班別下班＋6h 取晚；班別只套週一～五）。API 端同一串序列另有真的路由測試
 * （apps/api/src/__tests__/punch-night-wfh-sequence.test.ts）。
 */

const tp = (s: string) => Date.parse(`${s.replace(" ", "T")}:00+08:00`);
const RAW: Array<[string, "in" | "out", boolean]> = [
  ["2026-10-18 19:39", "in", true],
  ["2026-10-18 23:49", "out", true],
  ["2026-10-19 14:14", "in", false],
  ["2026-10-19 23:47", "out", false],
  ["2026-10-20 14:19", "in", false],
  ["2026-10-21 00:18", "out", false],
  ["2026-10-21 01:18", "in", true],
  ["2026-10-21 03:22", "out", true],
  ["2026-10-21 14:34", "in", false],
  ["2026-10-21 23:47", "out", false],
  ["2026-10-22 01:40", "in", true],
  ["2026-10-22 03:50", "out", true],
  ["2026-10-22 14:17", "in", false],
  ["2026-10-22 23:48", "out", false],
  ["2026-10-24 01:32", "in", true],
  ["2026-10-24 03:38", "out", true],
  ["2026-10-25 14:22", "in", true],
  ["2026-10-25 17:30", "out", true],
  ["2026-10-25 18:59", "in", true],
  ["2026-10-25 23:35", "out", true],
];
type Rec = PunchLike & { wfh?: boolean };
const ALL: Rec[] = RAW.map(([s, type, wfh], i) => ({ id: `p${i}`, type, punch_at: new Date(tp(s)).toISOString(), wfh }));

/** 台北的今天 00:00（ms）。 */
const dayStart = (ms: number) => Date.parse(`${new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)}T00:00:00+08:00`);

/** 模擬 GET /punch/today 在 `now` 的 records（只看 `upTo` 之前寫進去的卡）。 */
function serverToday(now: number, all: ReadonlyArray<Rec> = ALL): Rec[] {
  const start = dayStart(now);
  const written = all.filter((r) => Date.parse(r.punch_at) <= now);
  const before = written.filter((r) => Date.parse(r.punch_at) < start && Date.parse(r.punch_at) >= now - 16 * 3_600_000);
  const last = before[before.length - 1];
  const today = written.filter((r) => Date.parse(r.punch_at) >= start);
  if (last && last.type === "in") {
    const inStart = dayStart(Date.parse(last.punch_at));
    const wd = new Date(inStart + 8 * 3_600_000).getUTCDay();
    const shiftEndPlus6 = wd >= 1 && wd <= 5 ? inStart + (22.5 + 6) * 3_600_000 : 0;
    if (now < Math.max(start + 6 * 3_600_000, shiftEndPlus6)) return [{ ...last, carry_over: true }, ...today];
  }
  return today;
}

const READY: PunchCardUi = { loading: false, loadFailed: false, punching: false, locked: false };
const firstAction = (records: ReadonlyArray<PunchLike>, ui: PunchCardUi = READY) =>
  punchCardActions(summarizeWithPendingFixPunch(withPendingFixPunch(records, null, "x")), ui)[0];
const expectedLabel = (i: number) => {
  if (RAW[i][1] === "out") return "下班打卡";
  const prev = summarizePunches(serverToday(tp(RAW[i][0]) - 30_000));
  return prev.phase === "done" ? "再次上班打卡" : "上班打卡";
};

describe("實際序列：每次打卡前 30 秒進頁（全新載入）", () => {
  it.each(RAW.map((r, i) => [r[0], r[1], i] as const))("%s 要打 %s → 第一顆按鈕就是它、可按、預檢照送", (_at, type, i) => {
    const now = tp(RAW[i][0]) - 30_000;
    const records = serverToday(now);
    const a = firstAction(records);
    expect(a.label).toBe(expectedLabel(i));
    expect(a.disabled).toBe(false);
    if (type === "out") expect(a.label).toBe("下班打卡");
    expect(precheckPunch(records, serverToday(now), now, dayStart(now))).toEqual({ send: true, type });
    // 一般確認框都不會擋：剛下班 10 分鐘內再上班、跨日 12 小時以上下班都不是他的情況。
    const s = summarizePunches(records);
    expect(needsReInConfirm(s, now)).toBe(false);
    expect(longCarryOverOutHours(s, now)).toBeNull();
  });
});

describe("實際序列：畫面停在上一筆打卡後（PWA 放背景），之後輪詢或完全沒輪詢", () => {
  it.each(RAW.slice(1).map((r, k) => [r[0], r[1], k + 1] as const))("%s 要打 %s", (_at, type, i) => {
    const prevAt = tp(RAW[i - 1][0]) + 60_000;
    const now = tp(RAW[i][0]) - 30_000;
    // ① 每 60 秒輪詢（只認正面證據）
    let screen = serverToday(prevAt);
    for (let t = prevAt + 60_000; t < now; t += 60_000) {
      const polled = serverToday(t);
      if (shouldApplyPolledPunches(screen, polled, t, dayStart(t))) screen = polled;
    }
    expect(summarizePunches(screen).nextType).toBe(type);
    expect(precheckPunch(screen, serverToday(now), now, dayStart(now))).toEqual({ send: true, type });
    // 預檢抓不到最新（逾時／斷線）也照畫面送
    expect(precheckPunch(screen, null, now, dayStart(now))).toEqual({ send: true, type });
    // ② 完全沒輪詢（背景）：畫面是上一筆後的樣子，按下時預檢對齊後送出正確的那一種
    const stale = serverToday(prevAt);
    const check = precheckPunch(stale, serverToday(now), now, dayStart(now));
    if (check.send) expect(check.type).toBe(type);
    else expect(check.summary?.nextType).toBe(type);
  });
});

describe("晚餐／在家勾選框不影響按鈕", () => {
  it("23:47 下班前晚餐勾選框顯示中，按鈕仍是可按的「下班打卡」，不必先勾", () => {
    const now = tp("2026-10-21 23:46");
    const records = serverToday(now);
    const s = summarizePunches(records);
    expect(showDinnerCheckbox({ optIn: true, fromAt: new Date(tp("2026-10-21 22:30")).toISOString(), workDate: "2026-10-21" }, s.phase, now)).toBe(true);
    const a = firstAction(records);
    expect(a).toMatchObject({ label: "下班打卡", disabled: false, force: null });
  });
});

describe("10/23 整天沒打卡：前一晚 23:48 已下班", () => {
  it("00:05～23:05 每小時：沒有 carry_over、按鈕「上班打卡」可按", () => {
    for (let h = 0; h < 24; h++) {
      const now = tp(`2026-10-23 ${String(h).padStart(2, "0")}:05`);
      const records = serverToday(now);
      expect(records).toEqual([]);
      expect(firstAction(records)).toMatchObject({ label: "上班打卡", disabled: false });
    }
  });
});

describe("凌晨在家那段與 carry_over", () => {
  it("10/22 01:39（前一天 23:47 已下班）→ 沒有 carry_over，「上班打卡」；01:40 上班後 03:49 →「下班打卡」", () => {
    expect(serverToday(tp("2026-10-22 01:39"))).toEqual([]);
    expect(firstAction(serverToday(tp("2026-10-22 01:39"))).label).toBe("上班打卡");
    const at0349 = serverToday(tp("2026-10-22 03:49"));
    expect(at0349.some((r) => r.carry_over)).toBe(false);
    expect(firstAction(at0349).label).toBe("下班打卡");
  });

  it("（假設）忘了打 10/21 23:47 下班卡 → 10/22 01:39 是跨日上班中：「下班打卡」＋「改打上班卡」出口，兩顆都可按", () => {
    const forgot = ALL.filter((r) => r.punch_at !== new Date(tp("2026-10-21 23:47")).toISOString());
    const now = tp("2026-10-22 01:39"); // 按下 01:40 上班卡之前
    const records = serverToday(now, forgot);
    expect(records[0]).toMatchObject({ carry_over: true });
    const actions = punchCardActions(summarizePunches(records), READY);
    expect(actions.map((a) => [a.label, a.force, a.disabled])).toEqual([
      ["下班打卡", null, false],
      [CARRY_OVER_PUNCH_IN_LABEL, "in", false],
    ]);
  });
});

describe("punchCardActions：除了送出中，永遠有可按的打卡鈕", () => {
  const working = summarizePunches(serverToday(tp("2026-10-25 23:30")));

  it("上班中 → 第一顆「下班打卡」可按", () => {
    expect(punchCardActions(working, READY)[0]).toMatchObject({ label: "下班打卡", disabled: false });
  });

  it("送出中 → 唯一的 disabled 狀態「打卡中…」", () => {
    expect(punchCardActions(working, { ...READY, punching: true })).toEqual([
      { key: "next", label: "打卡中…", force: null, disabled: true, variant: "primary" },
    ]);
  });

  it("載入失敗／逾時（以前：唯一的按鈕 disabled，只剩小小的「重試」）→「上班打卡」「下班打卡」兩顆都可按", () => {
    const actions = punchCardActions(summarizePunches([]), { ...READY, loadFailed: true });
    expect(actions.map((a) => [a.label, a.force, a.disabled])).toEqual([
      ["上班打卡", "in", false],
      ["下班打卡", "out", false],
    ]);
  });

  it("鎖定（成功後 3 秒）只是暫時 disabled，文案照常", () => {
    expect(punchCardActions(working, { ...READY, locked: true })[0]).toMatchObject({ label: "下班打卡", disabled: true });
  });

  it("首次載入中 →「載入中…」（有 10 秒上限，逾時轉成上面的二選一）", () => {
    expect(punchCardActions(summarizePunches([]), { ...READY, loading: true })[0]).toMatchObject({ label: "載入中…", disabled: true });
  });
});

describe("precheckForcedPunch：狀態不明時員工自己選", () => {
  const working = serverToday(tp("2026-10-25 23:30"));
  it("抓不到最新 → 照選的送", () => {
    expect(precheckForcedPunch("out", null)).toEqual({ send: true, type: "out" });
  });
  it("最新是上班中、選下班 → 送 out", () => {
    expect(precheckForcedPunch("out", working)).toEqual({ send: true, type: "out" });
  });
  it("最新是上班中、選了上班 → 不送，按鈕改為「下班打卡」", () => {
    const check = precheckForcedPunch("in", working);
    expect(check.send).toBe(false);
    if (!check.send) {
      expect(check.reason).toBe("changed");
      expect(check.summary?.nextLabel).toBe("下班打卡");
    }
  });
});

describe("withTimeout：請求卡住時按鈕一定會回來", () => {
  afterEach(() => vi.useRealTimers());

  it("永遠不結束的請求 → 逾時 reject PromiseTimeoutError", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => undefined), 10_000, "GET /punch/today");
    const settled = p.then(
      () => "resolved",
      (err: unknown) => (isPromiseTimeout(err) ? "timeout" : "other"),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(settled).resolves.toBe("timeout");
  });

  it("及時完成 → 原值；原本就失敗 → 原錯誤", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
    const boom = new TypeError("Load failed");
    await expect(withTimeout(Promise.reject(boom), 1_000)).rejects.toBe(boom);
  });
});
