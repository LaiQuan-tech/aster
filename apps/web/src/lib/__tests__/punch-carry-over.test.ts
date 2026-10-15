import { describe, it, expect } from "vitest";
import {
  CARRY_OVER_STATUS_LABEL,
  RECENT_OUT_CONFIRM_MS,
  longCarryOverOutHours,
  needsReInConfirm,
  precheckPunch,
  shouldApplyPolledPunches,
  summarizePunches,
  type PunchLike,
} from "../punch-state";
import { withPendingFixPunch } from "../pending-fix-punch";
import { hasWfhPunch } from "../wfh-punch";

/**
 * 2026-10-15 正式站回報「下班時間看不到打卡按鈕」：個人班別 14:30–22:30、常工作到半夜的員工，
 * 過了 00:00 打開首頁，`/punch/today`（租戶日曆日）是空的 → 只剩「上班打卡」，只好先按上班（01:28:41）
 * 再按下班（01:28:46），前一天 14:10 的上班卡因此配不到下班卡。
 */

const t = (iso: string) => Date.parse(iso);
// 10/13 14:10 台北＝06:10Z；10/14 01:28 台北＝10/13 17:28Z。
const carried: PunchLike = { id: "p-1410", type: "in", punch_at: "2026-10-13T06:10:00.000Z", carry_over: true };
const NOW_0128 = t("2026-10-13T17:28:41.000Z");

describe("重現：沒有 carry_over 時，過午夜進頁只剩「上班打卡」", () => {
  it("今天沒有任何 in／out → 上班打卡（修正前的根因）", () => {
    const s = summarizePunches([]);
    expect(s.nextType).toBe("in");
    expect(s.nextLabel).toBe("上班打卡");
  });
});

describe("summarizePunches — 前一天還開著的上班卡（carry_over）", () => {
  it("只有 carry_over 的上班卡 → 上班中（跨日）、下班打卡；不算今天的上班時間與筆數", () => {
    const s = summarizePunches([carried]);
    expect(s.phase).toBe("working");
    expect(s.nextType).toBe("out");
    expect(s.nextLabel).toBe("下班打卡");
    expect(s.statusLabel).toBe(CARRY_OVER_STATUS_LABEL);
    expect(s.workingCarriedOver).toBe(true);
    expect(s.workingSince).toBe(carried.punch_at);
    expect(s.firstInAt).toBeNull();
    expect(s.inOutCount).toBe(0);
  });

  it("按了下班之後 → 今日已下班、下班時間是今天那張、筆數 1", () => {
    const out: PunchLike = { id: "p-out", type: "out", punch_at: "2026-10-13T17:28:46.000Z" };
    const s = summarizePunches([carried, out]);
    expect(s.phase).toBe("done");
    expect(s.nextLabel).toBe("再次上班打卡");
    expect(s.lastOutAt).toBe(out.punch_at);
    expect(s.firstInAt).toBeNull();
    expect(s.inOutCount).toBe(1);
    expect(s.workingCarriedOver).toBe(false);
  });

  it("一般員工（沒有 carry_over）行為不變", () => {
    const s = summarizePunches([{ type: "in", punch_at: "2026-10-14T01:00:00Z" }]);
    expect(s.statusLabel).toBe("上班中");
    expect(s.workingCarriedOver).toBe(false);
    expect(s.inOutCount).toBe(1);
  });
});

describe("precheckPunch／輪詢 — carry_over 是正面證據", () => {
  it("畫面＝[carry]、最新＝[carry] → 照送 out", () => {
    expect(precheckPunch([carried], [carried], NOW_0128)).toEqual({ send: true, type: "out" });
  });

  it("畫面停在舊的「上班打卡」（空）、最新有 carry → 不送，按鈕改為下班打卡", () => {
    const check = precheckPunch([], [carried], NOW_0128);
    expect(check.send).toBe(false);
    if (!check.send) {
      expect(check.reason).toBe("changed");
      expect(check.summary?.nextLabel).toBe("下班打卡");
    }
  });

  it("前一晚開著分頁（畫面上是沒有標 carry 的同一張卡）、最新帶 carry → 照送 out", () => {
    const screen: PunchLike[] = [{ id: "p-1410", type: "in", punch_at: carried.punch_at }];
    expect(precheckPunch(screen, [carried], NOW_0128)).toEqual({ send: true, type: "out" });
  });

  it("背景輪詢拿到只有 carry 的紀錄 → 套用（畫面空的會翻成下班打卡）", () => {
    expect(shouldApplyPolledPunches([], [carried], NOW_0128)).toBe(true);
  });
});

describe("其他今日判斷不把 carry_over 當成今天的卡", () => {
  it("待核准的今天上班補卡照樣成立（carry 不算今天已有上班卡）", () => {
    const merged = withPendingFixPunch(
      [carried],
      [{ id: "r1", kind: "fix_punch", status: "pending", segments: [{ date: "2026-10-14", startTime: "00:30", type: "in" }] }],
      "2026-10-14",
    );
    expect(merged.some((r) => (r as { pendingFixPunch?: unknown }).pendingFixPunch)).toBe(true);
  });

  it("carry 的上班卡是在家 → 今天不標（在家）", () => {
    expect(hasWfhPunch([{ ...carried, wfh: true }])).toBe(false);
    expect(hasWfhPunch([{ type: "in", punch_at: "2026-10-14T01:00:00Z", wfh: true }])).toBe(true);
  });
});

describe("needsReInConfirm — 剛下班又按再次上班（10/14 23:20:42 out → 23:20:55 in）", () => {
  const out = "2026-10-14T15:20:42.000Z";
  it("13 秒後 → 要確認", () => {
    expect(needsReInConfirm({ phase: "done", lastOutAt: out }, t(out) + 13_000)).toBe(true);
  });
  it("超過 10 分鐘、上班中、沒有下班卡、時間解析不了 → 不用確認", () => {
    expect(needsReInConfirm({ phase: "done", lastOutAt: out }, t(out) + RECENT_OUT_CONFIRM_MS)).toBe(false);
    expect(needsReInConfirm({ phase: "working", lastOutAt: out }, t(out) + 1000)).toBe(false);
    expect(needsReInConfirm({ phase: "done", lastOutAt: null }, t(out))).toBe(false);
    expect(needsReInConfirm({ phase: "done", lastOutAt: "bad" }, t(out))).toBe(false);
  });
});

describe("longCarryOverOutHours — 跨日下班距上班超過 12 小時要確認", () => {
  it("14:10 上班、01:28 下班（11 小時多）→ 不用確認", () => {
    expect(longCarryOverOutHours(summarizePunches([carried]), NOW_0128)).toBeNull();
  });
  it("超過 12 小時 → 回傳小時數（無條件捨去）", () => {
    expect(longCarryOverOutHours(summarizePunches([carried]), t(carried.punch_at) + 13.5 * 3_600_000)).toBe(13);
  });
  it("不是跨日的上班中 → 不用確認", () => {
    const s = summarizePunches([{ type: "in", punch_at: carried.punch_at }]);
    expect(longCarryOverOutHours(s, t(carried.punch_at) + 13 * 3_600_000)).toBeNull();
  });
});

describe("複驗建議 A：畫面的上班卡在今天以前、API 最新回應沒有 carry_over → 已換日", () => {
  // 瀏覽器在台北：10/14 00:00 台北＝10/13T16:00Z。前晚 18:00 上班（10:00Z）、分頁開著，隔天 09:00（01:00Z）按下班。
  const TODAY_START = t("2026-10-13T16:00:00.000Z");
  const lastNight: PunchLike = { id: "p-1800", type: "in", punch_at: "2026-10-13T10:00:00.000Z" };
  const NOW_0900 = t("2026-10-14T01:00:00.000Z");

  it("預檢：最新是空的 → 不送（day_changed），按鈕改回上班打卡", () => {
    const check = precheckPunch([lastNight], [], NOW_0900, TODAY_START);
    expect(check.send).toBe(false);
    if (!check.send) {
      expect(check.reason).toBe("day_changed");
      expect(check.summary?.nextLabel).toBe("上班打卡");
    }
  });

  it("預檢：最新帶著 carry_over（API 還認它開著）→ 照送 out", () => {
    expect(precheckPunch([lastNight], [{ ...lastNight, carry_over: true }], NOW_0900, TODAY_START)).toEqual({ send: true, type: "out" });
  });

  it("預檢：上班卡是今天的、最新空的（抓到別的日界）→ 照舊照畫面送", () => {
    const todayIn: PunchLike = { id: "p-0100", type: "in", punch_at: "2026-10-13T17:00:00.000Z" };
    expect(precheckPunch([todayIn], [], t("2026-10-13T18:00:00Z"), TODAY_START)).toEqual({ send: true, type: "out" });
  });

  it("沒給 todayStartMs → 舊行為（照送）", () => {
    expect(precheckPunch([lastNight], [], NOW_0900)).toEqual({ send: true, type: "out" });
  });

  it("沒有 id 的上班卡（待核准補卡的暫定卡）→ 維持舊規則", () => {
    expect(precheckPunch([{ type: "in", punch_at: lastNight.punch_at }], [], NOW_0900, TODAY_START)).toEqual({ send: true, type: "out" });
  });

  it("輪詢：空紀錄 → 套用；帶 carry_over → 套用；今天的上班卡＋空紀錄 → 不套用", () => {
    expect(shouldApplyPolledPunches([lastNight], [], NOW_0900, TODAY_START)).toBe(true);
    expect(shouldApplyPolledPunches([lastNight], [{ ...lastNight, carry_over: true }], NOW_0900, TODAY_START)).toBe(true);
    const todayIn: PunchLike = { id: "p-0100", type: "in", punch_at: "2026-10-13T17:00:00.000Z" };
    expect(shouldApplyPolledPunches([todayIn], [], t("2026-10-13T18:00:00Z"), TODAY_START)).toBe(false);
    expect(shouldApplyPolledPunches([lastNight], [], NOW_0900)).toBe(false);
  });
});
