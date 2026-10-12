import { describe, it, expect } from "vitest";
import {
  STALE_WORKING_MS,
  needsAnnouncementHint,
  precheckPunch,
  punchDayChangedNotice,
  punchStateChangedNotice,
  punchUnverifiedNotice,
  shouldApplyPolledPunches,
  summarizePunches,
} from "../punch-state";

/** 2026-09-18 台北時間 hh:mm（UTC+8）的 ISO 字串。 */
function at(hhmm: string): string {
  return `2026-09-18T${hhmm}:00+08:00`;
}

/** 2026-09-19（隔天）台北時間 hh:mm 的 ISO 字串。 */
function nextDay(hhmm: string): string {
  return `2026-09-19T${hhmm}:00+08:00`;
}

/** ISO → ms since epoch（給 `now` 參數用）。 */
const ms = (iso: string) => Date.parse(iso);

/** 某個時刻之後 h 小時 m 分（ms）。 */
const after = (iso: string, h: number, m = 0) => ms(iso) + (h * 60 + m) * 60_000;

const IN_0902 = { type: "in", punch_at: at("09:02") };
const OUT_1205 = { type: "out", punch_at: at("12:05") };
const IN_1301 = { type: "in", punch_at: at("13:01") };
const OUT_1805 = { type: "out", punch_at: at("18:05") };

/** 同一天傍晚（畫面上的上班卡都還在 16 小時內）。 */
const EVENING = ms(at("18:30"));

describe("summarizePunches", () => {
  it("空清單 → none／尚未打卡，下一步送 in「上班打卡」，時間全 null", () => {
    expect(summarizePunches([])).toEqual({
      phase: "none",
      firstInAt: null,
      lastOutAt: null,
      workingSince: null,
      inOutCount: 0,
      nextType: "in",
      nextLabel: "上班打卡",
      statusLabel: "尚未打卡",
    });
  });

  it("只有 in → working／上班中，下一步送 out「下班打卡」，workingSince＝該筆 in", () => {
    const s = summarizePunches([IN_0902]);
    expect(s.phase).toBe("working");
    expect(s.firstInAt).toBe(at("09:02"));
    expect(s.lastOutAt).toBeNull();
    expect(s.workingSince).toBe(at("09:02"));
    expect(s.inOutCount).toBe(1);
    expect(s.nextType).toBe("out");
    expect(s.nextLabel).toBe("下班打卡");
    expect(s.statusLabel).toBe("上班中");
  });

  it("in＋out → done／今日已下班，下一步送 in「再次上班打卡」，workingSince 清空", () => {
    const s = summarizePunches([IN_0902, OUT_1805]);
    expect(s.phase).toBe("done");
    expect(s.firstInAt).toBe(at("09:02"));
    expect(s.lastOutAt).toBe(at("18:05"));
    expect(s.workingSince).toBeNull();
    expect(s.inOutCount).toBe(2);
    expect(s.nextType).toBe("in");
    expect(s.nextLabel).toBe("再次上班打卡");
    expect(s.statusLabel).toBe("今日已下班");
  });

  it("in＋out＋in → 又回到 working，workingSince＝最後一筆 in，firstIn 仍是第一筆", () => {
    const s = summarizePunches([IN_0902, OUT_1205, IN_1301]);
    expect(s.phase).toBe("working");
    expect(s.firstInAt).toBe(at("09:02"));
    expect(s.lastOutAt).toBe(at("12:05"));
    expect(s.workingSince).toBe(at("13:01"));
    expect(s.inOutCount).toBe(3);
    expect(s.nextType).toBe("out");
  });

  it("混入 break_*／outing_* 一律略過：不影響階段也不計入筆數", () => {
    const s = summarizePunches([
      IN_0902,
      { type: "break_start", punch_at: at("12:00") },
      { type: "break_end", punch_at: at("13:00") },
      { type: "outing_start", punch_at: at("15:00") },
      { type: "outing_end", punch_at: at("16:00") },
    ]);
    expect(s.phase).toBe("working");
    expect(s.inOutCount).toBe(1);
    expect(s.workingSince).toBe(at("09:02"));
    expect(s.lastOutAt).toBeNull();

    // 只有非 in/out 的紀錄 → 視同尚未打卡
    expect(summarizePunches([{ type: "break_start", punch_at: at("12:00") }]).phase).toBe("none");
  });

  it("多筆進出：firstIn＝最早的 in、lastOut＝最晚的 out、筆數＝4", () => {
    const s = summarizePunches([IN_0902, OUT_1205, IN_1301, OUT_1805]);
    expect(s.phase).toBe("done");
    expect(s.firstInAt).toBe(at("09:02"));
    expect(s.lastOutAt).toBe(at("18:05"));
    expect(s.inOutCount).toBe(4);
    expect(s.nextLabel).toBe("再次上班打卡");
  });

  it("亂序輸入：依 punch_at 升冪判斷，不看陣列順序", () => {
    const shuffled = [OUT_1805, IN_1301, IN_0902, OUT_1205];
    const s = summarizePunches(shuffled);
    expect(s.phase).toBe("done");
    expect(s.firstInAt).toBe(at("09:02"));
    expect(s.lastOutAt).toBe(at("18:05"));
    expect(s.workingSince).toBeNull();

    // 亂序且最後（時間上）一筆是 in → working，workingSince 取時間最晚的 in
    const s2 = summarizePunches([IN_1301, OUT_1205, IN_0902]);
    expect(s2.phase).toBe("working");
    expect(s2.workingSince).toBe(at("13:01"));

    // 不動呼叫端的陣列
    expect(shuffled[0]).toBe(OUT_1805);
  });

  it("UTC 與 +08:00 混寫也照真實時間排序（不是字串比較）", () => {
    // 01:02Z＝台北 09:02；10:05Z＝台北 18:05
    const s = summarizePunches([
      { type: "out", punch_at: "2026-09-18T10:05:00.000Z" },
      { type: "in", punch_at: at("09:02") },
    ]);
    expect(s.phase).toBe("done");
    expect(s.firstInAt).toBe(at("09:02"));
    expect(s.lastOutAt).toBe("2026-09-18T10:05:00.000Z");
  });

  it("只有 out（沒有 in）→ done，firstInAt 為 null，下一步仍送 in", () => {
    const s = summarizePunches([OUT_1805]);
    expect(s.phase).toBe("done");
    expect(s.firstInAt).toBeNull();
    expect(s.lastOutAt).toBe(at("18:05"));
    expect(s.nextType).toBe("in");
  });
});

describe("precheckPunch（打卡前確認最新狀態，2026-10-12）", () => {
  it("主管剛核准補上班卡：畫面還是「上班打卡」（今天 0 張）、最新紀錄已有 in → 中止不送，回最新紀錄與摘要", () => {
    const latest = [{ ...IN_0902, id: "fix-in" }];
    const r = precheckPunch([], latest, EVENING);
    expect(r.send).toBe(false);
    if (r.send || r.reason === "unverified") throw new Error("應該中止並帶回最新紀錄");
    expect(r.reason).toBe("changed");
    expect(r.latest).toBe(latest); // 呼叫端拿來換掉畫面，不另外複製
    expect(r.summary.phase).toBe("working");
    expect(r.summary.nextType).toBe("out");
    expect(r.summary.nextLabel).toBe("下班打卡");
    expect(r.summary.workingSince).toBe(at("09:02"));
    expect(r.notice).toBe("打卡狀態剛更新（可能主管已核准補卡），按鈕已改為「下班打卡」，請確認後再按一次");
  });

  it("畫面是「下班打卡」（out）但最新紀錄已有下班卡（例如補下班卡剛核准）→ 中止，下一步改回 in", () => {
    const r = precheckPunch([IN_0902], [IN_0902, OUT_1805], EVENING);
    expect(r.send).toBe(false);
    if (r.send || r.reason === "unverified") throw new Error("應該中止並帶回最新紀錄");
    expect(r.reason).toBe("changed");
    expect(r.summary.nextType).toBe("in");
    expect(r.summary.nextLabel).toBe("再次上班打卡");
  });

  it("最新紀錄跟畫面一樣 → 照畫面送（種類由畫面推出）", () => {
    expect(precheckPunch([], [], EVENING)).toEqual({ send: true, type: "in" });
    expect(precheckPunch([IN_0902], [IN_0902], EVENING)).toEqual({ send: true, type: "out" });
    expect(precheckPunch([IN_0902, OUT_1205, IN_1301], [IN_0902, OUT_1205, IN_1301], EVENING)).toEqual({
      send: true,
      type: "out",
    });
    // 已下班（in＋out）、最新也是 in＋out → 照送 in（「再次上班打卡」）
    expect(precheckPunch([IN_0902, OUT_1805], [IN_0902, OUT_1805], EVENING)).toEqual({ send: true, type: "in" });
    // break_*／outing_* 不影響判斷（最新多了休息卡也不算新的打卡紀錄）
    expect(precheckPunch([IN_0902], [IN_0902, { type: "break_start", punch_at: at("12:00") }], EVENING)).toEqual({
      send: true,
      type: "out",
    });
    expect(
      precheckPunch(
        [IN_0902],
        [IN_0902, { type: "outing_start", punch_at: at("14:00") }, { type: "outing_end", punch_at: at("15:00") }],
        EVENING,
      ),
    ).toEqual({ send: true, type: "out" });
  });

  it("【審查 1】畫面「上班打卡」（今天 0 張）、最新已是補上班＋補下班（下一步同為 in）→ 仍中止，按鈕改「再次上班打卡」", () => {
    const latest = [
      { ...IN_0902, id: "fix-in" },
      { ...OUT_1805, id: "fix-out" },
    ];
    const r = precheckPunch([], latest, EVENING);
    expect(r.send).toBe(false);
    if (r.send || r.reason === "unverified") throw new Error("應該中止並帶回最新紀錄");
    expect(r.reason).toBe("changed");
    expect(r.latest).toBe(latest);
    expect(r.summary.phase).toBe("done");
    expect(r.summary.nextType).toBe("in");
    expect(r.notice).toContain("按鈕已改為「再次上班打卡」");
  });

  it("【審查 1】下一步種類相同但多了畫面上沒有的 in／out（中間補了卡）→ 中止；按鈕沒變時提示「已有新的打卡紀錄」", () => {
    const r = precheckPunch([IN_0902], [IN_0902, OUT_1205, IN_1301], EVENING);
    expect(r.send).toBe(false);
    if (r.send || r.reason === "unverified") throw new Error("應該中止並帶回最新紀錄");
    expect(r.reason).toBe("changed");
    expect(r.summary.nextType).toBe("out");
    expect(r.summary.workingSince).toBe(at("13:01"));
    expect(r.notice).toBe("已有新的打卡紀錄（可能主管已核准補卡），畫面已更新，請確認後再按「下班打卡」");

    // 已下班的畫面、最新多了一組補卡（in＋out）→ 一樣中止
    const done = precheckPunch([IN_0902, OUT_1205], [IN_0902, OUT_1205, IN_1301, OUT_1805], EVENING);
    expect(done.send).toBe(false);
  });

  it("【審查 1】比對用 id；兩邊都有 id 時同一刻但不同 id 也算新的卡", () => {
    const screen = [{ ...IN_0902, id: "a" }];
    expect(precheckPunch(screen, [{ ...IN_0902, id: "a" }], EVENING)).toEqual({ send: true, type: "out" });
    expect(precheckPunch(screen, [{ ...IN_0902, id: "b" }], EVENING).send).toBe(false);
    // 主管改了時間但是同一張卡（同 id）→ 不算新的卡
    expect(precheckPunch(screen, [{ id: "a", type: "in", punch_at: at("08:58") }], EVENING)).toEqual({
      send: true,
      type: "out",
    });
  });

  it("不誤擋：成功打卡後的樂觀更新（畫面＝前一刻的紀錄＋POST 回的 record）與伺服器一致 → 照送", () => {
    const serverIn = { id: "p1", type: "in", punch_at: "2026-09-18T01:02:00+00:00" };
    const record = { id: "p2", type: "out", punch_at: "2026-09-18T10:05:00+00:00" };
    expect(precheckPunch([serverIn, record], [serverIn, { ...record }], EVENING)).toEqual({ send: true, type: "in" });
    // 舊 API 沒回 record、樂觀更新只有 { type, punch_at }（沒有 id）：比種類＋時刻，Z 與 +08:00 寫法不同也算同一張
    const optimistic = { type: "out", punch_at: "2026-09-18T10:05:00.000Z" };
    expect(precheckPunch([serverIn, optimistic], [serverIn, { id: "p2", type: "out", punch_at: at("18:05") }], EVENING)).toEqual({
      send: true,
      type: "in",
    });
  });

  it("不誤擋：過午夜下班後，樂觀更新還留著昨天的上班卡（今天的紀錄沒有它）→ 照送 in", () => {
    const yesterdayIn = { id: "y", type: "in", punch_at: at("17:00") };
    const lateOut = { id: "o", type: "out", punch_at: nextDay("00:40") };
    expect(precheckPunch([yesterdayIn, lateOut], [lateOut], ms(nextDay("00:45")))).toEqual({ send: true, type: "in" });
  });

  it("抓失敗或逾時（null／undefined）→ 照畫面上的種類送出，不擋打卡", () => {
    expect(precheckPunch([], null, EVENING)).toEqual({ send: true, type: "in" });
    expect(precheckPunch([IN_0902], undefined, EVENING)).toEqual({ send: true, type: "out" });
  });

  it("亂序的最新紀錄也照時間判斷（同 summarizePunches）", () => {
    const r = precheckPunch([], [OUT_1205, IN_1301, IN_0902], EVENING);
    expect(r.send).toBe(false);
    if (r.send || r.reason === "unverified") throw new Error("應該中止並帶回最新紀錄");
    expect(r.summary.nextType).toBe("out");
  });

  it("空紀錄＋畫面上班中（加班過午夜，新的一天還沒打卡）、上班卡在 16 小時內 → 沒有新證據，照送 out，不中止", () => {
    expect(precheckPunch([IN_0902], [], ms(nextDay("00:30")))).toEqual({ send: true, type: "out" });
  });

  it("空紀錄＋畫面下班／尚未打卡 → 照送 in（不論隔了多久）", () => {
    expect(precheckPunch([], [], EVENING)).toEqual({ send: true, type: "in" });
    expect(precheckPunch([IN_0902, OUT_1805], [], ms(nextDay("09:00")))).toEqual({ send: true, type: "in" });
  });

  it("只有休息／外出卡（沒有任何 in／out）也算空紀錄 → 照畫面送", () => {
    expect(precheckPunch([IN_0902], [{ type: "break_start", punch_at: nextDay("00:10") }], ms(nextDay("00:30")))).toEqual({
      send: true,
      type: "out",
    });
  });
});

describe("precheckPunch — 上班卡超過 16 小時（【審查 2】昨天忘了打下班卡）", () => {
  it("常數＝16 小時", () => {
    expect(STALE_WORKING_MS).toBe(16 * 3_600_000);
  });

  it("空紀錄＋上班中：上班卡後 15h59m 照送 out；剛好 16 小時也照送（「超過」才算）", () => {
    expect(precheckPunch([IN_0902], [], after(at("09:02"), 15, 59))).toEqual({ send: true, type: "out" });
    expect(precheckPunch([IN_0902], [], after(at("09:02"), 16))).toEqual({ send: true, type: "out" });
  });

  it("空紀錄＋上班中：上班卡後 16h01m → 中止（day_changed），畫面換成空的、按鈕回「上班打卡」並提示補卡", () => {
    const latest: { type: string; punch_at: string }[] = [];
    const r = precheckPunch([IN_0902], latest, after(at("09:02"), 16, 1));
    expect(r.send).toBe(false);
    if (r.send || r.reason === "unverified") throw new Error("應該中止並帶回最新紀錄");
    expect(r.reason).toBe("day_changed");
    expect(r.latest).toBe(latest);
    expect(r.summary.phase).toBe("none");
    expect(r.summary.nextLabel).toBe("上班打卡");
    expect(r.notice).toBe("已換日，按鈕已改為「上班打卡」；若昨天忘了打下班卡，請另送補卡申請");
  });

  it("桌機分頁開了一整夜、隔天早上按「下班打卡」→ 中止；只有休息卡也算空紀錄", () => {
    expect(precheckPunch([IN_0902], [], ms(nextDay("09:00"))).send).toBe(false);
    const r = precheckPunch([IN_0902], [{ type: "break_start", punch_at: nextDay("08:00") }], ms(nextDay("09:00")));
    expect(r.send).toBe(false);
    if (r.send) return;
    expect(r.reason).toBe("day_changed");
  });

  it("隔夜的畫面、今天已在別的裝置打過上班卡 → 一般的 changed（最新多了畫面上沒有的卡）", () => {
    const r = precheckPunch([IN_0902], [{ id: "today", type: "in", punch_at: nextDay("08:55") }], ms(nextDay("09:10")));
    expect(r.send).toBe(false);
    if (r.send) return;
    expect(r.reason).toBe("changed");
  });

  it("查不到最新紀錄（null）＋上班卡超過 16 小時 → 不送（unverified），提示已重新載入；16 小時內照送", () => {
    const r = precheckPunch([IN_0902], null, after(at("09:02"), 16, 1));
    expect(r).toEqual({ send: false, reason: "unverified", latest: null, summary: null, notice: punchUnverifiedNotice() });
    expect(punchUnverifiedNotice()).toContain("16 小時");
    expect(precheckPunch([IN_0902], undefined, after(at("09:02"), 15, 59))).toEqual({ send: true, type: "out" });
    // 畫面沒在上班（要送 in）→ 不論多久照送
    expect(precheckPunch([IN_0902, OUT_1805], null, ms(nextDay("12:00")))).toEqual({ send: true, type: "in" });
  });

  it("今天的最新紀錄確認了同一張上班卡（例如 00:30 上班、現在 17:00）→ 不套用 16 小時規則，照送 out", () => {
    const earlyIn = { id: "e", type: "in", punch_at: at("00:30") };
    expect(precheckPunch([earlyIn], [earlyIn], after(at("00:30"), 16, 30))).toEqual({ send: true, type: "out" });
  });

  it("上班卡時間解析不了 → 不當成過期（照舊）", () => {
    expect(precheckPunch([{ type: "in", punch_at: "壞掉的時間" }], [], ms(nextDay("12:00")))).toEqual({
      send: true,
      type: "out",
    });
  });
});

describe("預檢提示文字", () => {
  it("punchStateChangedNotice：說明可能是主管核准補卡、按鈕改成什麼、請再按一次", () => {
    expect(punchStateChangedNotice(summarizePunches([IN_0902]))).toBe(
      "打卡狀態剛更新（可能主管已核准補卡），按鈕已改為「下班打卡」，請確認後再按一次",
    );
    expect(punchStateChangedNotice(summarizePunches([IN_0902, OUT_1805]))).toContain("「再次上班打卡」");
    // 按鈕沒變（同一階段）→ 改說已有新的打卡紀錄
    expect(punchStateChangedNotice(summarizePunches([IN_0902, OUT_1205, IN_1301]), summarizePunches([IN_0902]))).toBe(
      "已有新的打卡紀錄（可能主管已核准補卡），畫面已更新，請確認後再按「下班打卡」",
    );
  });

  it("punchDayChangedNotice：已換日＋忘了下班卡要另送補卡申請", () => {
    expect(punchDayChangedNotice(summarizePunches([]))).toBe("已換日，按鈕已改為「上班打卡」；若昨天忘了打下班卡，請另送補卡申請");
  });
});

describe("shouldApplyPolledPunches（每 60 秒背景輪詢，只認正面證據）", () => {
  it("輪詢拿到空紀錄、畫面上班中（加班過午夜，上班卡 16 小時內）→ 不套用，按鈕維持「下班打卡」", () => {
    expect(shouldApplyPolledPunches([IN_0902], [], ms(nextDay("00:30")))).toBe(false);
    // 只有休息卡也算空
    expect(shouldApplyPolledPunches([IN_0902], [{ type: "break_start", punch_at: nextDay("00:10") }], ms(nextDay("00:30")))).toBe(
      false,
    );
  });

  it("【審查 2】空紀錄＋上班中：上班卡後 15h59m 不套用、16h01m 套用（多半是昨天忘了打下班卡，按鈕回「上班打卡」）", () => {
    expect(shouldApplyPolledPunches([IN_0902], [], after(at("09:02"), 15, 59))).toBe(false);
    expect(shouldApplyPolledPunches([IN_0902], [], after(at("09:02"), 16))).toBe(false);
    expect(shouldApplyPolledPunches([IN_0902], [], after(at("09:02"), 16, 1))).toBe(true);
    expect(shouldApplyPolledPunches([IN_0902], [{ type: "break_start", punch_at: nextDay("02:00") }], after(at("09:02"), 16, 1))).toBe(
      true,
    );
  });

  it("輪詢拿到非空且不同的狀態（主管剛核准補上班卡）→ 套用", () => {
    expect(shouldApplyPolledPunches([], [IN_0902], EVENING)).toBe(true);
    expect(shouldApplyPolledPunches([IN_0902], [IN_0902, OUT_1805], EVENING)).toBe(true);
  });

  it("輪詢拿到非空且相同 → 套用（沒有差別，照常對齊）", () => {
    expect(shouldApplyPolledPunches([IN_0902], [IN_0902], EVENING)).toBe(true);
  });

  it("空紀錄＋畫面沒在上班（尚未打卡／已下班）→ 照常套用", () => {
    expect(shouldApplyPolledPunches([], [], EVENING)).toBe(true);
    expect(shouldApplyPolledPunches([IN_0902, OUT_1805], [], ms(nextDay("00:30")))).toBe(true);
  });
});

describe("needsAnnouncementHint", () => {
  it("需簽收且 viewed_at 為 undefined／null 都算未查閱；有值不算；不需簽收一律不算", () => {
    expect(
      needsAnnouncementHint([
        { requires_signature: true }, // 舊 API 沒有 viewed_at → 未查閱
        { requires_signature: true, viewed_at: null },
        { requires_signature: true, viewed_at: "2026-09-17T01:00:00.000Z" },
        { requires_signature: false, viewed_at: null },
        { requires_signature: false },
      ]),
    ).toBe(2);
  });

  it("空清單或全部已查閱 → 0", () => {
    expect(needsAnnouncementHint([])).toBe(0);
    expect(
      needsAnnouncementHint([
        { requires_signature: true, viewed_at: "2026-09-17T01:00:00.000Z" },
        { requires_signature: false },
      ]),
    ).toBe(0);
  });
});
