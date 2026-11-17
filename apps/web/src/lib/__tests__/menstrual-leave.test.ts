import { describe, expect, it } from "vitest";
import {
  isMenstrualLeaveType,
  leaveBalanceBatchItemText,
  leaveBalanceErrorText,
  menstrualErrorFromBody,
  statutoryKindMissingWarning,
} from "../leave-balance-cap";
import { leaveBalanceSummaryView, leaveTypeBalanceItems, menstrualMergedNote } from "../leave-balance-summary";
import { REQUEST_ERROR_MESSAGES } from "../request-forms";

/** 生理假（2026-11-17）前端：錯誤訊息、病假列「含生理假併入」、假別判斷。假資料。 */

const apiError = (code: string, body: Record<string, unknown>) =>
  Object.assign(new Error(`[400] ${code}`), { code, body: { error: code, ...body } });

describe("生理假錯誤訊息", () => {
  it("每月上限：帶月份與數字", () => {
    const err = apiError("menstrual_monthly_cap", { month: "2027-06", usedHours: 4, requestedHours: 8, capHours: 8 });
    expect(leaveBalanceErrorText(err, "送出", 8)).toBe("生理假每月以 1 日為限（2027-06 已請 4 時，本單 1 天），無法送出");
  });

  it("每月上限：只有錯誤碼也有中文", () => {
    const err = Object.assign(new Error("[409] menstrual_monthly_cap"), { code: "menstrual_monthly_cap" });
    expect(leaveBalanceErrorText(err, "核准")).toBe("生理假每月以 1 日為限，無法核准");
    expect(REQUEST_ERROR_MESSAGES.menstrual_monthly_cap).toBe("生理假每月以 1 日為限");
  });

  it("併入病假超過病假剩餘", () => {
    const err = apiError("menstrual_exceeds_sick_balance", { mergedHours: 8, availableHours: 4 });
    expect(leaveBalanceErrorText(err, "送出", 8)).toBe("生理假全年超過 3 日的部分併入病假計算：本單併入 1 天，病假剩餘 4 時，無法送出");
  });

  it("批次核准的一項（數字包在 menstrual 裡）", () => {
    const item = { ok: false, id: "x", error: "menstrual_monthly_cap", menstrual: { error: "menstrual_monthly_cap", month: "2027-06", usedHours: 8, requestedHours: 4 } };
    expect(leaveBalanceBatchItemText(item, "核准", 8)).toBe("生理假每月以 1 日為限（2027-06 已請 1 天，本單 4 時），無法核准。");
  });

  it("其他錯誤 → null", () => {
    expect(menstrualErrorFromBody({ error: "leave_balance_insufficient" }, "送出")).toBeNull();
  });
});

describe("病假列：含生理假併入", () => {
  it("menstrualMergedNote", () => {
    expect(menstrualMergedNote(4)).toBe("（含生理假併入 4 小時）");
    expect(menstrualMergedNote(0)).toBe("");
    expect(menstrualMergedNote(undefined)).toBe("");
  });

  it("各假別一覽與本單摘要帶加註", () => {
    const items = leaveTypeBalanceItems(
      [
        { leaveTypeId: "sick", name: "病假", current: false, capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 12, menstrualMergedHours: 4 },
        { leaveTypeId: "annual", name: "特休", current: true, capped: true, source: "balance", remainingHours: 16, pendingHours: 0, usedHours: 8 },
      ],
      8,
    );
    expect(items[0]!.text).toBe("已請 12 小時（約 1 天 4 時）（無額度）（含生理假併入 4 小時）");
    expect(items[1]!.text).not.toContain("生理假");
    const view = leaveBalanceSummaryView(
      { capped: true, source: "balance", remainingHours: 200, pendingHours: 0, usedHours: 40, hoursPerDay: 8, menstrualMergedHours: 8 },
      8,
      "病假",
    );
    expect(view?.text).toContain("（含生理假併入 8 小時）");
  });
});

describe("生理假預估併入病假（2026-11-17 驗收）", () => {
  it("病假列簽核中註明含生理假預估併入；本單（生理假）顯示「核准後約有 X 小時併入病假」", () => {
    const items = leaveTypeBalanceItems(
      [
        { leaveTypeId: "sick", name: "病假", current: false, capped: true, source: "balance", remainingHours: 200, pendingHours: 12, usedHours: 40, menstrualPendingMergeHours: 8 },
        { leaveTypeId: "mens", name: "生理假", current: true, capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 24, estimatedSickMergeHours: 8 },
      ],
      8,
    );
    expect(items[0]!.text).toBe("已請 40 小時（約 5 天）／剩 200 小時（約 25 天）・簽核中 12 小時（含生理假預估併入 8 小時）");
    expect(items[1]!.text).toBe("已請 24 小時（約 3 天）（無額度）・核准後約有 8 小時併入病假");
    const view = leaveBalanceSummaryView(
      { capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 24, hoursPerDay: 8, estimatedSickMergeHours: 8 },
      8,
      "生理假",
    );
    expect(view?.text).toBe("今年已請生理假 24 小時（約 3 天） · 核准後約有 8 小時併入病假");
  });

  it("沒有預估併入 → 不出現字樣", () => {
    const view = leaveBalanceSummaryView({ capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 8, hoursPerDay: 8 }, 8, "生理假");
    expect(view?.text).not.toContain("併入病假");
  });
});

describe("isMenstrualLeaveType", () => {
  it("有 statutoryKind 以它為準；舊 API 沒回時用名稱／code", () => {
    expect(isMenstrualLeaveType({ name: "生理假", statutoryKind: "menstrual" })).toBe(true);
    expect(isMenstrualLeaveType({ name: "生理假", statutoryKind: null })).toBe(false);
    expect(isMenstrualLeaveType({ name: "生理假" })).toBe(true);
    expect(isMenstrualLeaveType({ name: "女性假", code: "menstrual" })).toBe(true);
    expect(isMenstrualLeaveType({ name: "病假", code: "sick", statutoryKind: "sick" })).toBe(false);
    expect(isMenstrualLeaveType(null)).toBe(false);
  });
});

describe("後台假別頁：名稱像病假／生理假卻沒設法定假別 → 提醒", () => {
  it("含「病」或「生理」且 statutoryKind 為空 → 提醒；公傷病假、住院不提醒；已設定或舊 API 不提醒", () => {
    const msg = "未設定法定假別，生理假規則不會套用";
    expect(statutoryKindMissingWarning({ name: "病假", statutoryKind: null })).toBe(msg);
    expect(statutoryKindMissingWarning({ name: "普通傷病假", statutoryKind: null })).toBe(msg);
    expect(statutoryKindMissingWarning({ name: "生理假", statutoryKind: null })).toBe(msg);
    expect(statutoryKindMissingWarning({ name: "女性生理休假", statutoryKind: null })).toBe(msg);
    expect(statutoryKindMissingWarning({ name: "公傷病假", statutoryKind: null })).toBeNull();
    expect(statutoryKindMissingWarning({ name: "住院病假", statutoryKind: null })).toBeNull();
    expect(statutoryKindMissingWarning({ name: "病假", statutoryKind: "sick" })).toBeNull();
    expect(statutoryKindMissingWarning({ name: "生理假", statutoryKind: "menstrual" })).toBeNull();
    expect(statutoryKindMissingWarning({ name: "事假", statutoryKind: null })).toBeNull();
    expect(statutoryKindMissingWarning({ name: "病假" })).toBeNull();
  });
});
