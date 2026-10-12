import { describe, it, expect } from "vitest";
import {
  PENDING_FIX_PUNCH_CELL_SUFFIX,
  PENDING_FIX_PUNCH_IN_NOTICE,
  forgotPunchInHref,
  isProvisionalPunch,
  pendingFixPunchInFor,
  pendingFixPunchStatusLabel,
  pendingFixPunchWithdrawn,
  precheckPendingFixPunch,
  summarizeWithPendingFixPunch,
  withPendingFixPunch,
  type PendingFixPunchRequestLike,
} from "../pending-fix-punch";
import { precheckPunch, shouldApplyPolledPunches, summarizePunches } from "../punch-state";

const TODAY = "2026-10-12";
const YESTERDAY = "2026-10-11";
const TOMORROW = "2026-10-13";

/**
 * 某天 hh:mm 的 ISO（以執行測試的機器時區解讀，跟 pendingFixPunchInFor 解讀補卡時間的方式相同），
 * 所以不管 CI 在哪個時區跑，先後順序都一樣。
 */
function local(hhmm: string, date = TODAY): string {
  return new Date(`${date}T${hhmm}:00`).toISOString();
}

/** 待簽核的補卡單（表單送的 segments 形狀）。 */
function fixPunch(
  over: Partial<{ id: string; date: string; time: string; type: string; status: string; kind: string }> = {},
): PendingFixPunchRequestLike {
  const date = over.date ?? TODAY;
  const time = over.time ?? "08:52";
  return {
    id: over.id ?? "req-1",
    kind: over.kind ?? "fix_punch",
    status: over.status ?? "pending",
    segments: [{ date, startTime: time, type: over.type ?? "in" }],
  };
}

describe("pendingFixPunchInFor", () => {
  it("今天、待簽核、補上班卡 → 取出補卡單上的時間", () => {
    expect(pendingFixPunchInFor([fixPunch()], TODAY)).toEqual({
      requestId: "req-1",
      date: TODAY,
      hm: "08:52",
      punchAt: local("08:52"),
    });
  });

  it("補卡是昨天的、明天的、或補下班卡 → null", () => {
    expect(pendingFixPunchInFor([fixPunch({ date: YESTERDAY })], TODAY)).toBeNull();
    expect(pendingFixPunchInFor([fixPunch({ date: TOMORROW })], TODAY)).toBeNull();
    expect(pendingFixPunchInFor([fixPunch({ type: "out", time: "18:00" })], TODAY)).toBeNull();
  });

  it("不是待簽核（已核准／駁回／撤回）、或不是補卡單 → null", () => {
    for (const status of ["approved", "rejected", "cancelled"]) {
      expect(pendingFixPunchInFor([fixPunch({ status })], TODAY)).toBeNull();
    }
    expect(pendingFixPunchInFor([fixPunch({ kind: "leave" })], TODAY)).toBeNull();
  });

  it("拿不到待簽核單（null／undefined，例如 403）或清單是空的 → null", () => {
    expect(pendingFixPunchInFor(null, TODAY)).toBeNull();
    expect(pendingFixPunchInFor(undefined, TODAY)).toBeNull();
    expect(pendingFixPunchInFor([], TODAY)).toBeNull();
  });

  it("好幾張今天的補上班卡 → 取時間最早的一張", () => {
    const got = pendingFixPunchInFor([fixPunch({ id: "late", time: "09:10" }), fixPunch({ id: "early", time: "08:30" })], TODAY);
    expect(got?.requestId).toBe("early");
    expect(got?.hm).toBe("08:30");
  });

  it("segments 缺席、不是陣列、時間格式不對 → 略過，不會丟錯", () => {
    const weird = [
      { id: "a", kind: "fix_punch", status: "pending", segments: null },
      { id: "b", kind: "fix_punch", status: "pending" },
      { id: "c", kind: "fix_punch", status: "pending", segments: { date: TODAY } as unknown as [] },
      { id: "d", kind: "fix_punch", status: "pending", segments: [null, { date: TODAY, startTime: "8點", type: "in" }] },
      { id: "e", kind: "fix_punch", status: "pending", segments: [{ date: TODAY, startTime: "25:00", type: "in" }] },
    ] as PendingFixPunchRequestLike[];
    expect(pendingFixPunchInFor(weird, TODAY)).toBeNull();
  });

  it("時間帶秒也認得（只取到分）", () => {
    const req = fixPunch({ time: "08:52:30" });
    expect(pendingFixPunchInFor([req], TODAY)?.hm).toBe("08:52");
  });
});

describe("withPendingFixPunch＋summarizeWithPendingFixPunch（首頁按鈕與狀態）", () => {
  it("今天有待核准的上班補卡、今天沒有任何卡 → 已上班：按鈕「下班打卡」送 out、狀態「上班中・補卡待核准（08:52）」", () => {
    const records = withPendingFixPunch([], [fixPunch()], TODAY);
    expect(records).toHaveLength(1);
    expect(isProvisionalPunch(records[0])).toBe(true);
    const s = summarizeWithPendingFixPunch(records);
    expect(s.phase).toBe("working");
    expect(s.nextType).toBe("out");
    expect(s.nextLabel).toBe("下班打卡");
    expect(s.statusLabel).toBe("上班中・補卡待核准（08:52）");
    expect(s.workingOnPending).toBe(true);
    expect(s.firstInPending).toBe(true);
    expect(s.firstInAt).toBe(local("08:52"));
    expect(s.pendingIn?.hm).toBe("08:52");
    // 「今日共 N 筆」只算真的卡
    expect(s.inOutCount).toBe(0);
  });

  it("今天只有休息／外出卡（沒有上班卡）→ 一樣當作已上班", () => {
    const breakOnly = [{ type: "break_in", punch_at: local("12:00") }];
    const s = summarizeWithPendingFixPunch(withPendingFixPunch(breakOnly, [fixPunch()], TODAY));
    expect(s.nextLabel).toBe("下班打卡");
    expect(s.workingOnPending).toBe(true);
  });

  it("已經有真的上班卡 → 照舊（以真的為準，補卡不影響）", () => {
    const real = [{ id: "p1", type: "in", punch_at: local("10:31") }];
    const records = withPendingFixPunch(real, [fixPunch()], TODAY);
    expect(records).toEqual(real);
    const s = summarizeWithPendingFixPunch(records);
    expect(s).toEqual({ ...summarizePunches(real), pendingIn: null, workingOnPending: false, firstInPending: false });
    expect(s.statusLabel).toBe("上班中");
  });

  it("補卡是昨天的 → 不影響：照舊「上班打卡」", () => {
    const s = summarizeWithPendingFixPunch(withPendingFixPunch([], [fixPunch({ date: YESTERDAY })], TODAY));
    expect(s.phase).toBe("none");
    expect(s.nextType).toBe("in");
    expect(s.nextLabel).toBe("上班打卡");
    expect(s.statusLabel).toBe("尚未打卡");
    expect(s.pendingIn).toBeNull();
  });

  it("補的是下班卡 → 不影響：照舊「上班打卡」", () => {
    const s = summarizeWithPendingFixPunch(withPendingFixPunch([], [fixPunch({ type: "out", time: "18:00" })], TODAY));
    expect(s.nextLabel).toBe("上班打卡");
    expect(s.pendingIn).toBeNull();
  });

  it("拿不到待簽核單（403 → null）→ 照舊：紀錄原樣、按鈕「上班打卡」", () => {
    const records = withPendingFixPunch([], null, TODAY);
    expect(records).toEqual([]);
    const s = summarizeWithPendingFixPunch(records);
    expect(s.nextLabel).toBe("上班打卡");
    expect(s.statusLabel).toBe("尚未打卡");
    expect(s.workingOnPending).toBe(false);
  });

  it("按了下班之後 → 今日已下班；「上班」欄仍是待核准的 08:52、下班 18:00", () => {
    const afterOut = [{ id: "p2", type: "out", punch_at: local("18:00") }];
    const s = summarizeWithPendingFixPunch(withPendingFixPunch(afterOut, [fixPunch()], TODAY));
    expect(s.phase).toBe("done");
    expect(s.nextLabel).toBe("再次上班打卡");
    expect(s.statusLabel).toBe("今日已下班");
    expect(s.workingOnPending).toBe(false);
    expect(s.firstInPending).toBe(true);
    expect(s.firstInAt).toBe(local("08:52"));
    expect(s.lastOutAt).toBe(local("18:00"));
    expect(s.inOutCount).toBe(1);
  });

  it("補卡時間比已打的下班卡還晚（填錯）→ 不放暫定上班卡，按鈕不會又變回「下班打卡」", () => {
    const afterOut = [{ id: "p2", type: "out", punch_at: local("10:05") }];
    const records = withPendingFixPunch(afterOut, [fixPunch({ time: "18:00" })], TODAY);
    expect(records).toEqual(afterOut);
    expect(summarizeWithPendingFixPunch(records).nextLabel).toBe("再次上班打卡");
  });

  it("可以重複套用：已經併過的紀錄再套一次結果相同；補卡單不在了（核准／駁回／撤回）就拿掉暫定上班卡", () => {
    const once = withPendingFixPunch([], [fixPunch()], TODAY);
    expect(withPendingFixPunch(once, [fixPunch()], TODAY)).toEqual(once);
    expect(withPendingFixPunch(once, [], TODAY)).toEqual([]);
    expect(withPendingFixPunch(once, null, TODAY)).toEqual([]);
  });

  it("主管核准後（真的人工上班卡補進來）→ 以真的為準，狀態回到「上班中」", () => {
    const merged = withPendingFixPunch([], [fixPunch()], TODAY);
    const approved = [{ id: "manual-1", type: "in", punch_at: local("08:52") }];
    const records = withPendingFixPunch([...merged, ...approved], [fixPunch()], TODAY);
    expect(records).toEqual(approved);
    const s = summarizeWithPendingFixPunch(records);
    expect(s.statusLabel).toBe("上班中");
    expect(s.firstInPending).toBe(false);
  });

  it("不改原陣列", () => {
    const real = [{ id: "p2", type: "out", punch_at: local("18:00") }];
    const copy = [...real];
    withPendingFixPunch(real, [fixPunch()], TODAY);
    expect(real).toEqual(copy);
  });
});

describe("跟打卡前預檢／背景輪詢（lib/punch-state.ts）一起用", () => {
  const screen = withPendingFixPunch([], [fixPunch()], TODAY);
  const NOON = Date.parse(local("12:00"));

  it("最新的真紀錄還是空的 → 照畫面送 out（不擋）", () => {
    expect(precheckPunch(screen, [], NOON)).toEqual({ send: true, type: "out" });
  });

  it("查不到最新狀態（null）→ 照畫面送 out", () => {
    expect(precheckPunch(screen, null, NOON)).toEqual({ send: true, type: "out" });
  });

  it("主管剛核准（同一分鐘的人工上班卡）→ 認得是同一張，照送 out", () => {
    const latest = [{ id: "manual-1", type: "in", punch_at: local("08:52") }];
    expect(precheckPunch(screen, latest, NOON)).toEqual({ send: true, type: "out" });
  });

  it("別的裝置剛打了上班卡 → 不送，換成最新狀態", () => {
    const latest = [{ id: "p9", type: "in", punch_at: local("10:31") }];
    const check = precheckPunch(screen, latest, NOON);
    expect(check.send).toBe(false);
  });

  it("背景輪詢：加班過午夜（補卡日期已不是今天、新的一天還沒有卡）→ 維持「上班中」", () => {
    const polled = withPendingFixPunch([], [fixPunch()], TOMORROW);
    expect(polled).toEqual([]);
    expect(shouldApplyPolledPunches(screen, polled, Date.parse(local("00:30", TOMORROW)))).toBe(false);
  });

  it("背景輪詢：上班卡（補卡時間）已超過 16 小時 → 套用新的一天（回到「上班打卡」）", () => {
    expect(shouldApplyPolledPunches(screen, [], Date.parse(local("09:00", TOMORROW)))).toBe(true);
  });
});

describe("文案與網址", () => {
  it("狀態文字與「上班」欄", () => {
    expect(pendingFixPunchStatusLabel("08:52")).toBe("上班中・補卡待核准（08:52）");
    expect(`08:52${PENDING_FIX_PUNCH_CELL_SUFFIX}`).toBe("08:52（待核准）");
  });

  it("「早上有到，只是忘了打卡」→ 補卡單、預選上班、日期是今天", () => {
    const href = forgotPunchInHref(TODAY);
    expect(href).toBe("/ess/requests?kind=fix_punch&date=2026-10-12&type=in");
    const params = new URL(href, "https://example.test").searchParams;
    expect(params.get("kind")).toBe("fix_punch");
    expect(params.get("date")).toBe(TODAY);
    expect(params.get("type")).toBe("in");
  });
});

describe("審查回饋（2026-10-12）", () => {
  const screen = withPendingFixPunch([], [fixPunch()], TODAY);

  it("補卡被撤回或駁回：這次抓到的待簽核單沒有那張補卡、暫定卡是今天的 → 直接套用新紀錄（回到「上班打卡」）", () => {
    const next = withPendingFixPunch([], [], TODAY);
    expect(pendingFixPunchWithdrawn(screen, next, TODAY)).toBe(true);
    // 原本的輪詢規則不會套用（空紀錄不蓋掉上班中），所以要靠這條
    expect(shouldApplyPolledPunches(screen, next, Date.parse(local("12:00")))).toBe(false);
    expect(summarizeWithPendingFixPunch(next).nextLabel).toBe("上班打卡");
  });

  it("補卡還在待簽核 → 不算撤回", () => {
    const next = withPendingFixPunch([], [fixPunch()], TODAY);
    expect(pendingFixPunchWithdrawn(screen, next, TODAY)).toBe(false);
  });

  it("過午夜（暫定卡是昨天的）→ 不算撤回，照舊保留上班中", () => {
    const next = withPendingFixPunch([], [fixPunch()], TOMORROW);
    expect(pendingFixPunchWithdrawn(screen, next, TOMORROW)).toBe(false);
  });

  it("畫面上沒有暫定卡 → false", () => {
    expect(pendingFixPunchWithdrawn([], [], TODAY)).toBe(false);
  });

  it("送上班卡前：查到今天有待核准的上班補卡 → 中止，畫面換成「上班中・補卡待核准」並提示按下班打卡", () => {
    const hit = precheckPendingFixPunch("in", [], [], [fixPunch()], TODAY);
    expect(hit?.notice).toBe(PENDING_FIX_PUNCH_IN_NOTICE);
    expect(hit?.notice).toBe("你已送出今天的上班補卡，請按下班打卡");
    const s = summarizeWithPendingFixPunch(hit!.records);
    expect(s.statusLabel).toBe("上班中・補卡待核准（08:52）");
    expect(s.nextLabel).toBe("下班打卡");
  });

  it("送上班卡前：最新紀錄抓不到（null）就用畫面上的真卡判斷", () => {
    expect(precheckPendingFixPunch("in", [], null, [fixPunch()], TODAY)).not.toBeNull();
  });

  it("送上班卡前：沒有待核准的上班補卡、待簽核單沒抓到、已有真的上班卡、或送的是下班卡 → 照常送（null）", () => {
    expect(precheckPendingFixPunch("in", [], [], [], TODAY)).toBeNull();
    expect(precheckPendingFixPunch("in", [], [], null, TODAY)).toBeNull();
    expect(precheckPendingFixPunch("in", [], [{ id: "p1", type: "in", punch_at: local("10:31") }], [fixPunch()], TODAY)).toBeNull();
    expect(precheckPendingFixPunch("out", [], [], [fixPunch()], TODAY)).toBeNull();
    expect(precheckPendingFixPunch("in", [], [], [fixPunch({ date: YESTERDAY })], TODAY)).toBeNull();
  });

  it("今天另有待核准的補下班卡、時間晚於補上班卡 → 不變成「上班中」，維持現有行為", () => {
    const both = [fixPunch({ id: "in-1" }), fixPunch({ id: "out-1", type: "out", time: "18:00" })];
    expect(pendingFixPunchInFor(both, TODAY)).toBeNull();
    const s = summarizeWithPendingFixPunch(withPendingFixPunch([], both, TODAY));
    expect(s.nextLabel).toBe("上班打卡");
    // 同一張單補整天（上班＋下班兩段）也一樣
    const oneRequest: PendingFixPunchRequestLike = {
      id: "day-1",
      kind: "fix_punch",
      status: "pending",
      segments: [
        { date: TODAY, startTime: "08:52", type: "in" },
        { date: TODAY, startTime: "18:00", type: "out" },
      ],
    };
    expect(pendingFixPunchInFor([oneRequest], TODAY)).toBeNull();
    expect(precheckPendingFixPunch("in", [], [], both, TODAY)).toBeNull();
  });

  it("補下班卡是別天的、或時間早於補上班卡 → 不影響，照樣當作已上班", () => {
    expect(pendingFixPunchInFor([fixPunch(), fixPunch({ id: "o", type: "out", time: "18:00", date: YESTERDAY })], TODAY)?.hm).toBe("08:52");
    expect(pendingFixPunchInFor([fixPunch(), fixPunch({ id: "o", type: "out", time: "08:00" })], TODAY)?.hm).toBe("08:52");
  });
});
