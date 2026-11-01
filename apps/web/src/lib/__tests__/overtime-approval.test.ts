import { describe, expect, it } from "vitest";
import {
  OVERTIME_NOTICE_FALLBACK,
  dayTypeLabel,
  fmtMinutesHm,
  overtimeCapErrorText,
  overtimeCapExceededOf,
  overtimeCapMessage,
  overtimeNoticeOf,
  overtimeRequestHref,
} from "../overtime-approval";
import { normalizeUnapprovedOvertime, unapprovedOvertimeCsv, isReportNotDeployed } from "../unapproved-overtime-api";
import { DAY_ANOMALY_FALLBACK_TEXT, dayAnomalyText } from "../attendance-sheets-api";
import { describeBatchError, summarizeBatch } from "../ess-approval-batch";
import { overtimeBatchItemText } from "../overtime-approval";

/** 模擬 apiFetch 丟出的 Error（lib/api-client.ts：message＝error 碼、code、status、body）。 */
function apiError(status: number, body: Record<string, unknown>): Error {
  const err = new Error(String(body.error ?? "")) as Error & { status?: number; code?: string; body?: unknown };
  err.status = status;
  if (typeof body.error === "string") err.code = body.error;
  err.body = body;
  return err;
}

describe("overtimeNoticeOf：POST /punch 的 overtimeNotice（API 未部署時缺欄位）", () => {
  it("缺欄位／null／型別不對／kind 不認得 → null", () => {
    expect(overtimeNoticeOf({ id: "x", type: "in", punchAt: "2026-11-01T01:00:00Z" })).toBeNull();
    expect(overtimeNoticeOf({ overtimeNotice: null })).toBeNull();
    expect(overtimeNoticeOf({ overtimeNotice: "unapproved_overtime_day" })).toBeNull();
    expect(overtimeNoticeOf({ overtimeNotice: { kind: "something_else", dayType: "rest_day", message: "x" } })).toBeNull();
    expect(overtimeNoticeOf(null)).toBeNull();
    expect(overtimeNoticeOf(undefined)).toBeNull();
  });

  it("兩種 kind 原樣帶出；message 空白時用預設說法", () => {
    expect(
      overtimeNoticeOf({ overtimeNotice: { kind: "unapproved_overtime_day", dayType: "rest_day", message: " 請送加班單 " } }),
    ).toEqual({ kind: "unapproved_overtime_day", dayType: "rest_day", message: "請送加班單" });
    expect(overtimeNoticeOf({ overtimeNotice: { kind: "regular_leave_day", dayType: "regular_leave", message: "" } })).toEqual({
      kind: "regular_leave_day",
      dayType: "regular_leave",
      message: OVERTIME_NOTICE_FALLBACK.regular_leave_day,
    });
    expect(overtimeNoticeOf({ overtimeNotice: { kind: "unapproved_overtime_day" } })?.dayType).toBe("");
  });

  it("送加班單連結預選日期", () => {
    expect(overtimeRequestHref("2026-11-07")).toBe("/ess/requests?kind=ot&date=2026-11-07");
  });
});

describe("overtime_cap_exceeded（409）→ 人話", () => {
  it("月上限：帶已核准／這張／上限", () => {
    const err = apiError(409, { error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 38, requestedHours: 4 });
    expect(overtimeCapErrorText(err, "核准")).toBe("本月加班已核准 38 小時，這張 4 小時會超過每月加班 40 小時上限，無法核准");
    expect(overtimeCapErrorText(err, "送出")).toBe("本月加班已核准 38 小時，這張 4 小時會超過每月加班 40 小時上限，無法送出");
  });

  it("日上限：currentHours＝當天正常工時＋已核准加班", () => {
    const info = overtimeCapExceededOf(
      apiError(409, { error: "overtime_cap_exceeded", limit: "daily", capHours: 12, currentHours: 9.5, requestedHours: 3 }),
    );
    expect(info).toEqual({ limit: "daily", capHours: 12, currentHours: 9.5, requestedHours: 3 });
    expect(overtimeCapMessage(info!, "核准")).toBe("當天正常工時加已核准加班共 9.5 小時，這張 3 小時會讓當天工時超過每日工時 12 小時上限，無法核准");
    expect(overtimeCapMessage({ limit: "daily", capHours: 12, currentHours: null, requestedHours: 4 }, "核准")).toBe(
      "這張 4 小時會讓當天工時超過每日工時 12 小時上限，無法核准",
    );
  });

  it("數字缺漏 → 不帶數字的說法；不是這個錯誤 → null", () => {
    const bare = apiError(409, { error: "overtime_cap_exceeded" });
    // 上限讀租戶規則：沒附數字時不寫死 40／12
    expect(overtimeCapErrorText(bare, "核准")).toBe("這張加班單會超過每月加班上限，無法核准");
    expect(overtimeCapMessage({ limit: "daily", capHours: null, currentHours: null, requestedHours: null }, "送出")).toBe(
      "這張加班單會讓當天工時超過每日工時上限，無法送出",
    );
    expect(overtimeCapErrorText(apiError(409, { error: "period_closed" }), "核准")).toBeNull();
    expect(overtimeCapErrorText("overtime_cap_exceeded", "核准")).toBeNull();
    expect(overtimeCapErrorText(null, "送出")).toBeNull();
  });

  it("503 overtime_cap_check_failed → 稍後再試", () => {
    const err = apiError(503, { error: "overtime_cap_check_failed" });
    expect(overtimeCapErrorText(err, "送出")).toBe("加班上限檢查暫時失敗，這張單尚未送出，請稍後再試");
    expect(overtimeCapErrorText(err, "核准")).toBe("加班上限檢查暫時失敗，這張單尚未核准，請稍後再試");
    expect(describeBatchError("overtime_cap_check_failed")).toBe("加班上限檢查暫時失敗，這張單尚未核准，請稍後再試。");
  });

  it("批次核准：數字包在 cap 裡（API 實際形狀）或扁平都讀得到；沒附用通用說法（不寫死 40）", () => {
    expect(describeBatchError("overtime_cap_exceeded")).toContain("每月加班上限");
    expect(describeBatchError("overtime_cap_exceeded")).not.toContain("40");
    const summary = summarizeBatch(
      "approve",
      [
        { ok: false, id: "a", error: "overtime_cap_exceeded", limit: "monthly", capHours: 40, currentHours: 38, requestedHours: 4 },
        { ok: false, id: "b", error: "overtime_cap_exceeded" },
        { ok: false, id: "c", error: "overtime_cap_exceeded", cap: { limit: "daily", capHours: 12, currentHours: 8, requestedHours: 5 } },
      ],
      (id) => id,
    );
    expect(summary.failures[0].reason).toBe("本月加班已核准 38 小時，這張 4 小時會超過每月加班 40 小時上限，無法核准。");
    expect(summary.failures[1].reason).toBe("這張加班單會超過每月加班上限，無法核准。");
    expect(summary.failures[2].reason).toBe("當天正常工時加已核准加班共 8 小時，這張 5 小時會讓當天工時超過每日工時 12 小時上限，無法核准。");
  });
});

describe("月出勤表日異常 overtime_unapproved 的標籤", () => {
  it("message 空白 → 中文標籤；有 message 用 message；不認得的代碼回代碼", () => {
    expect(DAY_ANOMALY_FALLBACK_TEXT.overtime_unapproved).toBe("加班未事前核准");
    expect(dayAnomalyText({ code: "overtime_unapproved", message: "" })).toBe("加班未事前核准");
    expect(dayAnomalyText({ code: "overtime_unapproved", message: "休息日加班未核准" })).toBe("休息日加班未核准");
    expect(dayAnomalyText({ code: "brand_new_code" })).toBe("brand_new_code");
    expect(dayAnomalyText({ code: "constructor" })).toBe("constructor");
  });
});

describe("未核准加班報表", () => {
  it("日別標籤與時:分", () => {
    expect(dayTypeLabel("rest_day")).toBe("休息日");
    expect(dayTypeLabel("fixed_holiday")).toBe("國定假日");
    expect(dayTypeLabel("regular_leave")).toBe("例假");
    expect(dayTypeLabel("workday")).toBe("平日");
    expect(dayTypeLabel("")).toBe("—");
    expect(dayTypeLabel("mystery")).toBe("mystery");
    expect(fmtMinutesHm(0)).toBe("0:00");
    expect(fmtMinutesHm(125)).toBe("2:05");
    expect(fmtMinutesHm(600)).toBe("10:00");
    expect(fmtMinutesHm(-5)).toBe("0:00");
    expect(fmtMinutesHm(Number.NaN)).toBe("0:00");
  });

  it("normalize：缺欄位補預設、days 依日期排序、totalMinutes 缺漏用加總", () => {
    expect(normalizeUnapprovedOvertime(null, "2026-11")).toEqual({ period: "2026-11", rows: [] });
    expect(normalizeUnapprovedOvertime({ rows: "nope" }, "2026-11")).toEqual({ period: "2026-11", rows: [] });
    const report = normalizeUnapprovedOvertime(
      {
        period: "2026-10",
        rows: [
          {
            employeeId: "e-1",
            employeeName: "測試員甲",
            employeeNo: "T001",
            days: [
              { workDate: "2026-10-18", dayType: "rest_day", minutes: 240 },
              { workDate: "2026-10-03", dayType: "workday", minutes: 90 },
            ],
          },
          null,
          { employeeId: "e-2", employeeName: "測試員乙", employeeNo: 7, days: null, totalMinutes: "30" },
        ],
      },
      "2026-11",
    );
    expect(report.period).toBe("2026-10");
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0].days.map((d) => d.workDate)).toEqual(["2026-10-03", "2026-10-18"]);
    expect(report.rows[0].totalMinutes).toBe(330);
    expect(report.rows[1]).toEqual({ employeeId: "e-2", employeeName: "測試員乙", employeeNo: "7", days: [], totalMinutes: 30 });
  });

  it("CSV：BOM、每天一列、時:分、含逗號的欄位加引號", () => {
    const csv = unapprovedOvertimeCsv({
      period: "2026-10",
      rows: [
        {
          employeeId: "e-1",
          employeeName: "測試員,甲",
          employeeNo: "T001",
          days: [
            { workDate: "2026-10-03", dayType: "workday", minutes: 90 },
            { workDate: "2026-10-18", dayType: "rest_day", minutes: 240 },
          ],
          totalMinutes: 330,
        },
      ],
    });
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("員工編號,姓名,日期,日別,時數,未核准天數,總時數");
    expect(lines[1]).toBe('T001,"測試員,甲",2026-10-03,平日,1:30,2,5:30');
    expect(lines[2]).toBe('T001,"測試員,甲",2026-10-18,休息日,4:00,2,5:30');
  });

  it("404 視為端點尚未部署", () => {
    expect(isReportNotDeployed(apiError(404, { error: "not_found" }))).toBe(true);
    expect(isReportNotDeployed(apiError(500, { error: "internal_error" }))).toBe(false);
    expect(isReportNotDeployed("x")).toBe(false);
  });
});

describe("overtimeBatchItemText：批次結果逐張（後台 HR 代理簽核與 ESS 批次共用）", () => {
  it("日上限的數字在 cap 裡 → 說日上限、帶數字（不會被說成月上限）", () => {
    const item = { ok: false, id: "r1", error: "overtime_cap_exceeded", cap: { limit: "daily", capHours: 12, currentHours: 8, requestedHours: 5 } };
    expect(overtimeBatchItemText(item, "核准")).toBe("當天正常工時加已核准加班共 8 小時，這張 5 小時會讓當天工時超過每日工時 12 小時上限，無法核准。");
  });

  it("月上限 cap、扁平欄位、沒附數字、503 檢查失敗", () => {
    expect(
      overtimeBatchItemText({ error: "overtime_cap_exceeded", cap: { limit: "monthly", capHours: 40, currentHours: 38, requestedHours: 4 } }, "核准"),
    ).toBe("本月加班已核准 38 小時，這張 4 小時會超過每月加班 40 小時上限，無法核准。");
    expect(overtimeBatchItemText({ error: "overtime_cap_exceeded", limit: "daily", capHours: 10 }, "核准")).toBe(
      "這張加班單會讓當天工時超過每日工時 10 小時上限，無法核准。",
    );
    expect(overtimeBatchItemText({ error: "overtime_cap_exceeded" }, "核准")).toBe("這張加班單會超過每月加班上限，無法核准。");
    expect(overtimeBatchItemText({ error: "overtime_cap_check_failed" }, "核准")).toBe("加班上限檢查暫時失敗，這張單尚未核准，請稍後再試。");
  });

  it("其他錯誤／不是物件 → null（呼叫端走原本的說法）", () => {
    expect(overtimeBatchItemText({ error: "period_closed", period: "2026-10" }, "核准")).toBeNull();
    expect(overtimeBatchItemText({ error: "not_current_approver" }, "核准")).toBeNull();
    expect(overtimeBatchItemText(null, "核准")).toBeNull();
    expect(overtimeBatchItemText("overtime_cap_exceeded", "核准")).toBeNull();
  });
});
