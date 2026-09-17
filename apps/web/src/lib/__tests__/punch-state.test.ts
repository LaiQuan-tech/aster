import { describe, it, expect } from "vitest";
import { needsAnnouncementHint, summarizePunches } from "../punch-state";

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
