import { describe, it, expect } from "vitest";
import {
  needsAnnouncementHint,
  precheckPunch,
  punchStateChangedNotice,
  shouldApplyPolledPunches,
  summarizePunches,
} from "../punch-state";

/** 2026-09-18 台北時間 hh:mm（UTC+8）的 ISO 字串。 */
function at(hhmm: string): string {
  return `2026-09-18T${hhmm}:00+08:00`;
}

const IN_0902 = { type: "in", punch_at: at("09:02") };
const OUT_1205 = { type: "out", punch_at: at("12:05") };
const IN_1301 = { type: "in", punch_at: at("13:01") };
const OUT_1805 = { type: "out", punch_at: at("18:05") };

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
  it("主管剛核准補上班卡：畫面還是「上班打卡」（in）、最新紀錄已有 in → 中止不送，回最新紀錄與摘要", () => {
    const latest = [{ ...IN_0902, id: "fix-in" }];
    const r = precheckPunch("in", latest);
    expect(r.send).toBe(false);
    if (r.send) return;
    expect(r.latest).toBe(latest); // 呼叫端拿來換掉畫面，不另外複製
    expect(r.summary.phase).toBe("working");
    expect(r.summary.nextType).toBe("out");
    expect(r.summary.nextLabel).toBe("下班打卡");
    expect(r.summary.workingSince).toBe(at("09:02"));
  });

  it("畫面是「下班打卡」（out）但最新紀錄已有下班卡（例如補下班卡剛核准）→ 中止，下一步改回 in", () => {
    const r = precheckPunch("out", [IN_0902, OUT_1805]);
    expect(r.send).toBe(false);
    if (r.send) return;
    expect(r.summary.nextType).toBe("in");
    expect(r.summary.nextLabel).toBe("再次上班打卡");
  });

  it("最新紀錄推出的下一步與畫面相同 → 照畫面送", () => {
    expect(precheckPunch("in", [])).toEqual({ send: true, type: "in" });
    expect(precheckPunch("out", [IN_0902])).toEqual({ send: true, type: "out" });
    // 中間多了補卡（in＋out），最後仍是 in：下一步一樣是 out
    expect(precheckPunch("out", [IN_0902, OUT_1205, IN_1301])).toEqual({ send: true, type: "out" });
    // break_*／outing_* 不影響判斷
    expect(precheckPunch("out", [IN_0902, { type: "break_start", punch_at: at("12:00") }])).toEqual({
      send: true,
      type: "out",
    });
  });

  it("none 與 done 下一步都是 in：畫面「上班打卡」、最新已是 in＋out → 照送 in（只比種類，不比階段）", () => {
    expect(precheckPunch("in", [IN_0902, OUT_1805])).toEqual({ send: true, type: "in" });
  });

  it("抓失敗或逾時（null／undefined）→ 照畫面上的種類送出，不擋打卡", () => {
    expect(precheckPunch("in", null)).toEqual({ send: true, type: "in" });
    expect(precheckPunch("out", undefined)).toEqual({ send: true, type: "out" });
  });

  it("亂序的最新紀錄也照時間判斷（同 summarizePunches）", () => {
    const r = precheckPunch("in", [OUT_1205, IN_1301, IN_0902]);
    expect(r.send).toBe(false);
    if (r.send) return;
    expect(r.summary.nextType).toBe("out");
  });

  it("空紀錄＋畫面上班中（加班過午夜，新的一天還沒打卡）→ 沒有新證據，照送 out，不中止", () => {
    expect(precheckPunch("out", [])).toEqual({ send: true, type: "out" });
  });

  it("空紀錄＋畫面下班／尚未打卡 → 照送 in", () => {
    expect(precheckPunch("in", [])).toEqual({ send: true, type: "in" });
  });

  it("只有休息／外出卡（沒有任何 in／out）也算空紀錄 → 照畫面送", () => {
    expect(precheckPunch("out", [{ type: "break_start", punch_at: at("00:10") }])).toEqual({ send: true, type: "out" });
  });
});

describe("punchStateChangedNotice", () => {
  it("中文提示：說明可能是主管核准補卡、按鈕改成什麼、請再按一次", () => {
    expect(punchStateChangedNotice(summarizePunches([IN_0902]))).toBe(
      "打卡狀態剛更新（可能主管已核准補卡），按鈕已改為「下班打卡」，請確認後再按一次",
    );
    expect(punchStateChangedNotice(summarizePunches([IN_0902, OUT_1805]))).toContain("「再次上班打卡」");
  });
});

describe("shouldApplyPolledPunches（每 60 秒背景輪詢，只認正面證據）", () => {
  it("輪詢拿到空紀錄、畫面上班中（加班過午夜）→ 不套用，按鈕維持「下班打卡」", () => {
    expect(shouldApplyPolledPunches([IN_0902], [])).toBe(false);
    // 只有休息卡也算空
    expect(shouldApplyPolledPunches([IN_0902], [{ type: "break_start", punch_at: at("00:10") }])).toBe(false);
  });

  it("輪詢拿到非空且不同的狀態（主管剛核准補上班卡）→ 套用", () => {
    expect(shouldApplyPolledPunches([], [IN_0902])).toBe(true);
    expect(shouldApplyPolledPunches([IN_0902], [IN_0902, OUT_1805])).toBe(true);
  });

  it("輪詢拿到非空且相同 → 套用（沒有差別，照常對齊）", () => {
    expect(shouldApplyPolledPunches([IN_0902], [IN_0902])).toBe(true);
  });

  it("空紀錄＋畫面沒在上班（尚未打卡／已下班）→ 照常套用", () => {
    expect(shouldApplyPolledPunches([], [])).toBe(true);
    expect(shouldApplyPolledPunches([IN_0902, OUT_1805], [])).toBe(true);
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
