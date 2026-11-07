import { describe, expect, it } from "vitest";
import {
  bucketHasQuota,
  isCompLeaveType,
  leaveBalanceBatchItemText,
  leaveBalanceErrorText,
  leaveBalanceFromBody,
  leaveBalanceMessage,
  quotaRemainingHours,
} from "../leave-balance-cap";
import { describeBatchError, summarizeBatch } from "../ess-approval-batch";

/** 模擬 apiFetch 丟出的 Error（lib/api-client.ts：message＝`[status] code`、code、status、body）。 */
function apiError(status: number, body: Record<string, unknown>): Error {
  const err = new Error(`[${status}] ${String(body.error ?? "")}`) as Error & { status?: number; code?: string; body?: unknown };
  err.status = status;
  err.code = typeof body.error === "string" ? body.error : undefined;
  err.body = body;
  return err;
}

const LT = "lt-annual";
const bucket = (over: Record<string, unknown>) => ({
  leave_type_id: LT,
  entitled: 56,
  used: 0,
  deferred: 0,
  period_start: "2027-01-01",
  period_end: "2027-12-31",
  year: 2027,
  ...over,
});

describe("quotaRemainingHours／bucketHasQuota", () => {
  it("有額度的桶：entitled＋deferred−used（PostgREST 字串也收）", () => {
    expect(quotaRemainingHours([bucket({ entitled: "56.00", used: "16.5", deferred: "8" })], LT, "2027-06-03")).toBe(47.5);
  });

  it("沒有桶 → null（不限額、不擋）", () => {
    expect(quotaRemainingHours([], LT, "2027-06-03")).toBeNull();
  });

  it("entitled=0 的自動記帳桶（事假等）→ null，不會因為「剩餘 −24」而擋", () => {
    expect(bucketHasQuota({ entitled: 0, deferred: 0 })).toBe(false);
    expect(quotaRemainingHours([bucket({ entitled: 0, used: 24 })], LT, "2027-06-03")).toBeNull();
  });

  it("依申請日挑週年期間的桶", () => {
    const rows = [
      bucket({ period_start: "2027-05-10", period_end: "2028-05-09", entitled: 56, used: 0 }),
      bucket({ period_start: "2026-05-10", period_end: "2027-05-09", entitled: 56, used: 56 }),
    ];
    expect(quotaRemainingHours(rows, LT, "2027-06-03")).toBe(56);
    expect(quotaRemainingHours(rows, LT, "2027-05-06")).toBe(0);
  });
});

describe("leave_balance_insufficient 錯誤的人話", () => {
  it("送出：此假別剩餘 X，申請 Y，超過額度無法送出（天＋時）", () => {
    const err = apiError(400, { error: "leave_balance_insufficient", leaveTypeId: LT, requestedHours: 16, availableHours: 12 });
    expect(leaveBalanceErrorText(err, "送出")).toBe("此假別剩餘 1 天 4 時，申請 2 天，超過額度無法送出");
  });

  it("依 hoursPerDay 換算天數", () => {
    expect(leaveBalanceMessage({ leaveTypeId: LT, requestedHours: 15, availableHours: 7.5 }, "送出", 7.5)).toBe(
      "此假別剩餘 1 天，申請 2 天，超過額度無法送出",
    );
  });

  it("剩餘 0 → 「剩餘 0 天」；核准用「無法核准」", () => {
    const err = apiError(409, { error: "leave_balance_insufficient", leaveTypeId: LT, requestedHours: 4, availableHours: 0 });
    expect(leaveBalanceErrorText(err, "核准")).toBe("此假別剩餘 0 天，申請 4 時，超過額度無法核准");
  });

  it("數字缺漏 → 不帶數字的說法；檢查失敗 503 → 可重試說法；其他錯誤 → null", () => {
    expect(leaveBalanceErrorText(apiError(400, { error: "leave_balance_insufficient" }), "送出")).toBe("此假別剩餘額度不足，無法送出");
    expect(leaveBalanceErrorText(apiError(503, { error: "leave_balance_check_failed" }), "送出")).toBe(
      "假別額度檢查暫時失敗，這張單尚未送出，請稍後再試",
    );
    expect(leaveBalanceErrorText(apiError(409, { error: "not_pending" }), "送出")).toBeNull();
    expect(leaveBalanceFromBody({ error: "other" })).toBeNull();
  });

  it("批次結果（數字包在 balance）→ 帶句號的人話，summarizeBatch 也用這句", () => {
    const item = { ok: false, id: "r1", error: "leave_balance_insufficient", balance: { leaveTypeId: LT, requestedHours: 8, availableHours: 4 } };
    expect(leaveBalanceBatchItemText(item, "核准")).toBe("此假別剩餘 4 時，申請 1 天，超過額度無法核准。");
    const summary = summarizeBatch("approve", [item as never], () => "員工甲");
    expect(JSON.stringify(summary)).toContain("此假別剩餘 4 時，申請 1 天，超過額度無法核准");
    expect(describeBatchError("leave_balance_check_failed")).toContain("假別額度檢查暫時失敗");
  });
});

describe("驗收追加", () => {
  it("isCompLeaveType 與 API 同規則", () => {
    expect(isCompLeaveType({ code: "comp", name: "補休假" })).toBe(true);
    expect(isCompLeaveType({ code: "x", name: "補休" })).toBe(true);
    expect(isCompLeaveType({ code: "company_trip", name: "公司旅遊" })).toBe(false);
  });

  it("退回失敗（500 leave_balance_revert_failed）→ 中文，單筆與批次都是", () => {
    const err = apiError(500, { error: "leave_balance_revert_failed" });
    expect(leaveBalanceErrorText(err, "核准")).toContain("退回待簽核失敗");
    expect(leaveBalanceBatchItemText({ ok: false, id: "r1", error: "leave_balance_revert_failed" }, "核准")).toContain("退回待簽核失敗");
    expect(describeBatchError("leave_balance_revert_failed")).toContain("退回待簽核失敗");
  });
});
