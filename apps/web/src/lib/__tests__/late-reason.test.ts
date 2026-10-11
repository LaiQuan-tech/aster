import { describe, it, expect } from "vitest";
import {
  LATE_REASON_MAX,
  lateDecisionLabel,
  lateDecisionTone,
  lateReasonError,
  lateReasonPrompt,
  lateReportHeadline,
  periodOf,
  sortLateReports,
} from "../late-reason";
import { lateReasonRequiredOf } from "../ess-api";

/** 遲到理由（2026-10-11 業主拍板）：打卡對話框文案、理由驗證、決定狀態顯示、排序。 */

describe("lateReasonPrompt（打卡被擋下時的對話框說明）", () => {
  it("沒排班：「你今天 10:30 上班，超過 10:00（遲到 30 分鐘），請填寫原因（主管與老闆會看到）」", () => {
    expect(lateReasonPrompt({ punchTime: "10:30", threshold: "10:00", lateMinutes: 30 })).toBe(
      "你今天 10:30 上班，超過 10:00（遲到 30 分鐘），請填寫原因（主管與老闆會看到）",
    );
  });

  it("有排班：門檻換成班別上班時間；沒給門檻／時間也講得通", () => {
    expect(lateReasonPrompt({ punchTime: "09:01", threshold: "09:00", lateMinutes: 1 })).toBe(
      "你今天 09:01 上班，超過 09:00（遲到 1 分鐘），請填寫原因（主管與老闆會看到）",
    );
    expect(lateReasonPrompt({ punchTime: "", threshold: null, lateMinutes: 5 })).toBe(
      "你今天 現在 上班，已超過上班時間（遲到 5 分鐘），請填寫原因（主管與老闆會看到）",
    );
  });
});

describe("lateReasonError（與 API 相同：trim 後 1–500 字）", () => {
  it("空白 → 請填寫；剛好 500 字可以；501 字不行（附目前字數）", () => {
    expect(lateReasonError("")).toBe("請填寫遲到原因");
    expect(lateReasonError("   \n ")).toBe("請填寫遲到原因");
    expect(lateReasonError(" 捷運延誤 ")).toBeNull();
    expect(lateReasonError("塞".repeat(LATE_REASON_MAX))).toBeNull();
    expect(lateReasonError("塞".repeat(LATE_REASON_MAX + 1))).toBe("最多 500 字（目前 501 字）");
  });
});

describe("決定狀態的顯示", () => {
  it("未決定也要講清楚視為影響全勤；色調：不影響綠、影響紅、未決定琥珀", () => {
    expect(lateDecisionLabel("exempt")).toBe("不影響全勤");
    expect(lateDecisionLabel("affects")).toBe("影響全勤");
    expect(lateDecisionLabel(null)).toBe("老闆尚未決定（視為影響全勤）");
    expect(lateDecisionTone("exempt")).toBe("green");
    expect(lateDecisionTone("affects")).toBe("red");
    expect(lateDecisionTone(null)).toBe("amber");
    expect(lateReportHeadline({ dateLabel: "10/12（一）", punchHm: "10:30", lateMinutes: 30 })).toBe("10/12（一） 10:30 上班 · 遲到 30 分");
  });

  it("sortLateReports：未決定在前，其餘上班日新到舊、同日打卡新到舊；不改原陣列", () => {
    const list = [
      { id: "a", decision: "exempt" as const, workDate: "2026-10-14", punchAt: "2026-10-14T02:10:00Z" },
      { id: "b", decision: null, workDate: "2026-10-12", punchAt: "2026-10-12T02:30:00Z" },
      { id: "c", decision: "affects" as const, workDate: "2026-10-14", punchAt: "2026-10-14T03:00:00Z" },
      { id: "d", decision: null, workDate: "2026-10-13", punchAt: "2026-10-13T02:05:00Z" },
    ];
    expect(sortLateReports(list).map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
    expect(list.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("periodOf：本地日曆的 YYYY-MM", () => {
    expect(periodOf(new Date(2026, 9, 11, 12))).toBe("2026-10");
    expect(periodOf(new Date(2026, 0, 3))).toBe("2026-01");
  });
});

describe("lateReasonRequiredOf（認出 POST /punch 的 400 late_reason_required）", () => {
  const apiError = (status: number, code: string, body: unknown) =>
    Object.assign(new Error(`[${status}] ${code}`), { status, code, body });

  it("帶回遲到分鐘、門檻、打卡時間、上班日", () => {
    const err = apiError(400, "late_reason_required", {
      error: "late_reason_required",
      lateMinutes: 30,
      threshold: "10:00",
      punchTime: "10:30",
      workDate: "2026-10-12",
    });
    expect(lateReasonRequiredOf(err)).toEqual({ lateMinutes: 30, threshold: "10:00", punchTime: "10:30", workDate: "2026-10-12" });
  });

  it("其他錯誤（invalid_body、409 冷卻、網路錯）→ null", () => {
    expect(lateReasonRequiredOf(apiError(400, "invalid_body", { error: "invalid_body" }))).toBeNull();
    expect(lateReasonRequiredOf(apiError(409, "punch_too_soon", { error: "punch_too_soon" }))).toBeNull();
    expect(lateReasonRequiredOf(new TypeError("Failed to fetch"))).toBeNull();
    expect(lateReasonRequiredOf("nope")).toBeNull();
  });
});
