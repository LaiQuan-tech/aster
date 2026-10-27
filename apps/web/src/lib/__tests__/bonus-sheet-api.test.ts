import { describe, expect, it } from "vitest";
import {
  bonusSheetQuery,
  payoutDateOf,
  payoutDateText,
  payoutTimeline,
  rowProjectMap,
  runOptionLabel,
  stickyOffsets,
  type ProjectPayoutRun,
  type ShareRevision,
} from "../bonus-sheet-api";

describe("獎金分潤總表（前端純函式）", () => {
  it("bonusSheetQuery：預設最新批次不帶參數；指定批次帶 runId；基準日帶 asOf", () => {
    expect(bonusSheetQuery({ mode: "run", runId: null })).toBe("");
    expect(bonusSheetQuery({ mode: "run", runId: "abc" })).toBe("?runId=abc");
    expect(bonusSheetQuery({ mode: "asOf", asOf: "2026-10-27" })).toBe("?asOf=2026-10-27");
  });

  it("runOptionLabel：期別＋基準日＋狀態", () => {
    expect(runOptionLabel({ id: "x", label: "2026-Q3", asOf: "2026-09-09", status: "paid", kind: "regular" })).toBe("2026-Q3（基準日 2026-09-09・已發放）");
    expect(runOptionLabel({ id: "x", label: "2026-Q3", asOf: "2026-09-09", status: "draft", kind: "reversal" })).toBe("2026-Q3（基準日 2026-09-09・草稿・沖銷）");
  });

  it("stickyOffsets：凍結範圍內累加列高／欄寬，範圍外 null", () => {
    const o = stickyOffsets({ columns: [5, 10, 8], rowHeights: [15, 30, 12], freeze: { rows: 2, cols: 1 } });
    expect(o.top).toEqual([0, 20, null]);
    expect(o.left).toEqual([0, null, null]);
    expect(stickyOffsets({ columns: [5], rowHeights: [15] }).top).toEqual([null]);
  });
});

describe("發放歷程（前端純函式）", () => {
  const runOf = (label: string, over: Partial<ProjectPayoutRun> = {}): ProjectPayoutRun => ({
    runId: label, label, kind: "regular", status: "paid", asOf: "2026-03-09", submittedAt: null, approvedAt: null, paidOn: "2026-03-10",
    reversesLabel: null, reversedByStatus: null, total: 1000, countsTowardPaid: true, cumulativePaid: 1000, members: [], ...over,
  });
  const revOf = (date: string): ShareRevision => ({ key: date, at: `${date}T03:00:00Z`, date, changedByEmpId: null, changedByName: "測試老闆", reason: "測試", items: [], text: date });

  it("payoutDateOf：發放日 > 核准日 > 送審日 > 基準日", () => {
    expect(payoutDateOf(runOf("a"))).toBe("2026-03-10");
    expect(payoutDateOf(runOf("a", { paidOn: null, approvedAt: "2026-04-01T02:00:00Z" }))).toBe("2026-04-01");
    expect(payoutDateOf(runOf("a", { paidOn: null, submittedAt: "2026-04-02T02:00:00Z" }))).toBe("2026-04-02");
    expect(payoutDateOf(runOf("a", { paidOn: null }))).toBe("2026-03-09");
  });

  it("payoutTimeline：依日期穿插，同一天調整在發放前", () => {
    const t = payoutTimeline({
      runs: [runOf("Q1", { paidOn: "2026-03-10" }), runOf("Q2", { paidOn: "2026-06-10" })],
      revisions: [revOf("2026-01-20"), revOf("2026-06-10"), revOf("2026-08-01")],
    });
    expect(t.map((e) => (e.type === "run" ? e.run.label : `調整 ${e.revision.date}`))).toEqual(["調整 2026-01-20", "Q1", "調整 2026-06-10", "Q2", "調整 2026-08-01"]);
    expect(payoutTimeline({ runs: [], revisions: [] })).toEqual([]);
  });

  it("rowProjectMap／payoutDateText", () => {
    expect(rowProjectMap([{ row: 5, projectId: "p" }]).get(5)).toBe("p");
    expect(rowProjectMap(undefined).size).toBe(0);
    expect(payoutDateText("2026-09-10")).toBe("2026/09/10");
    expect(payoutDateText(null)).toBe("—");
  });
});
