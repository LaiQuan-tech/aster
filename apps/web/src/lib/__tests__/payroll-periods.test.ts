import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECKLIST_FIX_HREF,
  CHECKLIST_PENDING_SHOW,
  PERIOD_LIST_MONTHS,
  PRIOR_PERIOD_CORRECTION_HINT,
  PRIOR_PERIOD_CORRECTION_HREF,
  REOPEN_EFFECT_NOTE,
  REOPEN_FORBIDDEN_HINT,
  REOPEN_REASON_MAX,
  REOPEN_REASON_MIN,
  UNLOCK_LIST_BOSS_ONLY_NOTE,
  UNLOCK_LIST_MAX,
  approvalBossEmpIdOf,
  canConfirmClose,
  canEditUnlockList,
  checklistSummary,
  checklistViews,
  closeButtonLabel,
  closeOutcomeOf,
  closePayrollPeriod,
  closeSuccessMessage,
  filterUnlockCandidates,
  getPeriodChecklist,
  isApprovalBoss,
  isBossOrPlatformAdmin,
  isChecklistReady,
  isForbiddenError,
  isValidReopenReason,
  listPayrollPeriods,
  payrollPeriodErrorMessage,
  pendingEntryText,
  periodActionsOf,
  periodStatusDetail,
  periodStatusLabel,
  periodStatusText,
  periodUnlockEmpIdsOf,
  reopenPayrollPeriod,
  reopenReasonError,
  reopenSuccessMessage,
  toggleUnlockEmpId,
  unlockCandidates,
  unlockListSaveErrorMessage,
  type ChecklistItem,
  type ChecklistPendingEntry,
  type PayrollPeriodRow,
  type PeriodChecklist,
  type PeriodStatus,
} from "../payroll-periods-api";

/**
 * 發薪鎖定（2026-10-11）的前端純函式：狀態文字、按鈕顯示規則、重新開放理由、檢查清單整理、
 * 「誰能重新開放」名單 helper；加上 close／reopen 打 fetch 那一層（409 checklist_incomplete 帶清單）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const TZ = "Asia/Taipei";

/** apiFetch 丟出的 Error 的樣子。 */
function apiError(status: number, body: Record<string, unknown>): Error {
  const code = typeof body.error === "string" ? body.error : undefined;
  const server = typeof body.message === "string" ? body.message : undefined;
  return Object.assign(new Error(`[${status}] ${code ?? server ?? "error"}`), {
    status,
    ...(code ? { code } : {}),
    ...(server ? { serverMessage: server } : {}),
    body,
  });
}

function row(overrides: Partial<PayrollPeriodRow> = {}): PayrollPeriodRow {
  return {
    period: "2026-09",
    status: "open",
    closedAt: null,
    closedByEmpId: null,
    closedByName: null,
    reopenedAt: null,
    reopenedByEmpId: null,
    reopenedByName: null,
    reopenReason: null,
    sheetCount: 0,
    lockedCount: 0,
    ...overrides,
  };
}

const pending = (name: string, detail: string, extra: Partial<ChecklistPendingEntry> = {}): ChecklistPendingEntry => ({
  employeeId: `emp-${name}`,
  employeeName: name,
  refId: `ref-${name}`,
  status: "draft",
  detail,
  ...extra,
});

function item(key: ChecklistItem["key"], done: number, total: number, list: ChecklistPendingEntry[] = [], pendingCount?: number): ChecklistItem {
  return {
    key,
    label: key,
    done,
    total,
    passed: list.length === 0 && (pendingCount ?? 0) === 0,
    pending: list,
    pendingCount: pendingCount ?? list.length,
  };
}

const PASSING: PeriodChecklist = {
  period: "2026-09",
  ready: true,
  items: [item("sheets", 5, 5), item("leave_settlement", 2, 2), item("expense_settlement", 0, 0), item("payslips", 5, 5)],
  warnings: [],
};

const FAILING: PeriodChecklist = {
  period: "2026-09",
  ready: false,
  items: [
    item("sheets", 3, 5, [pending("王小明", "月表還是草稿（員工尚未送出）"), pending("李小華", "尚未產生月表", { status: "missing" })]),
    item("leave_settlement", 2, 2),
    item("expense_settlement", 0, 0),
    item("payslips", 5, 5),
  ],
  warnings: [{ code: "pending_requests", count: 2, message: "還有 2 張待簽核的申請單碰到這個月" }],
};

/* ------------------------------------------------------------- 狀態文字 --- */

describe("狀態文字（開放中／已結算／已重新開放）", () => {
  it("開放中：就是「開放中」，沒有括號", () => {
    expect(periodStatusText(row({ status: "open" }), TZ)).toBe("開放中");
    expect(periodStatusLabel("open")).toBe("開放中");
    expect(periodStatusDetail(row({ status: "open" }), TZ)).toBe("");
  });

  it("已結算（○○，MM/DD HH:mm）", () => {
    const closed = row({ status: "closed", closedAt: "2026-10-12T06:30:00.000Z", closedByName: "王小明" });
    expect(periodStatusText(closed, TZ)).toBe("已結算（王小明，10/12 14:30）");
    expect(periodStatusLabel("closed")).toBe("已結算");
    expect(periodStatusDetail(closed, TZ)).toBe("王小明，10/12 14:30");
  });

  it("已重新開放（○○，MM/DD HH:mm，理由：…）——是重新開放的人與時間，不是當初鎖定的", () => {
    const reopened = row({
      status: "reopened",
      closedAt: "2026-10-12T06:30:00.000Z",
      closedByName: "王小明",
      reopenedAt: "2026-10-13T01:10:00.000Z",
      reopenedByName: "陳老闆",
      reopenReason: "  補登漏掉的獎金  ",
    });
    expect(periodStatusText(reopened, TZ)).toBe("已重新開放（陳老闆，10/13 09:10，理由：補登漏掉的獎金）");
    expect(periodStatusLabel("reopened")).toBe("已重新開放");
  });

  it("缺姓名、缺時間、缺理由就略過，不留空的逗號或括號", () => {
    expect(periodStatusText(row({ status: "closed", closedAt: "2026-10-12T06:30:00.000Z", closedByName: null }), TZ)).toBe(
      "已結算（10/12 14:30）",
    );
    expect(periodStatusText(row({ status: "closed", closedAt: null, closedByName: "王小明" }), TZ)).toBe("已結算（王小明）");
    expect(periodStatusText(row({ status: "closed", closedAt: null, closedByName: null }), TZ)).toBe("已結算");
    expect(periodStatusText(row({ status: "closed", closedAt: "壞掉的時間", closedByName: "王小明" }), TZ)).toBe("已結算（王小明）");
    expect(
      periodStatusText(row({ status: "reopened", reopenedAt: "2026-10-13T01:10:00.000Z", reopenedByName: null, reopenReason: null }), TZ),
    ).toBe("已重新開放（10/13 09:10）");
    expect(periodStatusText(row({ status: "reopened", reopenedByName: "陳老闆", reopenReason: "   " }), TZ)).toBe("已重新開放（陳老闆）");
  });

  it("GET /attendance-sheets/period-closes 的紀錄（沒有 open）也吃得進來；不認得的狀態原樣顯示", () => {
    expect(
      periodStatusText(
        { status: "reopened", closedAt: "x", closedByName: "甲", reopenedAt: "2026-10-13T01:10:00.000Z", reopenedByName: "乙", reopenReason: "改錯" },
        TZ,
      ),
    ).toBe("已重新開放（乙，10/13 09:10，理由：改錯）");
    expect(periodStatusLabel("weird")).toBe("weird");
  });
});

/* ------------------------------------------------------------- 按鈕規則 --- */

describe("按鈕顯示規則 periodActionsOf", () => {
  const actions = (status: PeriodStatus, canClose: boolean, canReopen: boolean) => periodActionsOf(status, { canClose, canReopen });

  it("鎖定鈕：HR（canClose）且狀態是開放中或已重新開放", () => {
    expect(actions("open", true, false).showClose).toBe(true);
    expect(actions("reopened", true, false).showClose).toBe(true);
    expect(actions("closed", true, false).showClose).toBe(false);
    expect(actions("open", false, true).showClose).toBe(false);
    expect(actions("reopened", false, false).showClose).toBe(false);
  });

  it("重新開放鈕：老闆或指定的人（canReopen）且狀態是已結算", () => {
    expect(actions("closed", false, true).showReopen).toBe(true);
    expect(actions("closed", true, true).showReopen).toBe(true);
    expect(actions("open", false, true).showReopen).toBe(false);
    expect(actions("reopened", false, true).showReopen).toBe(false);
    expect(actions("closed", true, false).showReopen).toBe(false);
  });

  it("HR 但沒有解鎖權限：已結算的月份不顯示重新開放鈕，改顯示「只有老闆、老闆指定的人或平台管理員可以重新開放」", () => {
    const a = actions("closed", true, false);
    expect(a).toEqual({ showClose: false, showReopen: false, reopenForbiddenHint: "只有老闆、老闆指定的人或平台管理員可以重新開放" });
    expect(REOPEN_FORBIDDEN_HINT).toBe("只有老闆、老闆指定的人或平台管理員可以重新開放");
  });

  it("說明文字只在「已結算且不能重新開放」時出現：開放中、已重新開放、有權限的人都沒有", () => {
    expect(actions("open", true, false).reopenForbiddenHint).toBeNull();
    expect(actions("reopened", true, false).reopenForbiddenHint).toBeNull();
    expect(actions("closed", true, true).reopenForbiddenHint).toBeNull();
    expect(actions("closed", false, true).reopenForbiddenHint).toBeNull();
    // 兩個權限都沒有（理論上列表 403 看不到）：已結算只剩說明
    expect(actions("closed", false, false)).toEqual({ showClose: false, showReopen: false, reopenForbiddenHint: REOPEN_FORBIDDEN_HINT });
  });

  it("完整組合：老闆本人同時是 HR——開放中看到鎖定、已結算看到重新開放，不會兩顆同時出現", () => {
    for (const status of ["open", "closed", "reopened"] as const) {
      const a = actions(status, true, true);
      expect(a.showClose && a.showReopen).toBe(false);
    }
    expect(actions("open", true, true)).toMatchObject({ showClose: true, showReopen: false });
    expect(actions("closed", true, true)).toMatchObject({ showClose: false, showReopen: true });
    expect(actions("reopened", true, true)).toMatchObject({ showClose: true, showReopen: false });
  });

  it("鎖定鈕文字固定「完成 YYYY-MM 發薪並鎖定」；成功提示「YYYY-MM 已完成發薪並鎖定」", () => {
    expect(closeButtonLabel("2026-10")).toBe("完成 2026-10 發薪並鎖定");
    expect(closeSuccessMessage("2026-10")).toBe("2026-10 已完成發薪並鎖定");
    expect(PERIOD_LIST_MONTHS).toBe(12);
  });

  it("重新開放成功的提示帶連動回復的張數", () => {
    expect(reopenSuccessMessage({ period: "2026-09", unlockedSheets: 12, revertedPayslips: 11 })).toBe(
      "2026-09 已重新開放：12 張出勤月表回到已核准、11 張薪資單回到草稿；要再鎖定須重新通過檢查清單",
    );
  });
});

/* ------------------------------------------------------ 重新開放的理由 --- */

describe("重新開放的理由（trim 後至少 5 個字）", () => {
  it("4 個字不行、5 個字可以", () => {
    expect(REOPEN_REASON_MIN).toBe(5);
    expect(reopenReasonError("補發獎金")).toBe("重新開放的理由至少 5 個字（目前 4 字）");
    expect(isValidReopenReason("補發獎金")).toBe(false);
    expect(reopenReasonError("補發漏的獎")).toBeNull();
    expect(isValidReopenReason("補發漏的獎")).toBe(true);
  });

  it("前後空白與換行不算字數；中間的空白算", () => {
    expect(isValidReopenReason("   補發獎金   ")).toBe(false);
    expect(isValidReopenReason("\n\n補發獎金 \n")).toBe(false);
    expect(isValidReopenReason("  補發漏的獎  ")).toBe(true);
    expect(isValidReopenReason("補 發 獎")).toBe(true); // 5 字元（含 2 個空白）
    expect(reopenReasonError("")).toBe("重新開放的理由至少 5 個字（目前 0 字）");
    expect(reopenReasonError("     ")).toBe("重新開放的理由至少 5 個字（目前 0 字）");
  });

  it("上限 500 字（與後端 REOPEN_REASON_MAX 一致）", () => {
    expect(REOPEN_REASON_MAX).toBe(500);
    expect(isValidReopenReason("字".repeat(500))).toBe(true);
    expect(reopenReasonError("字".repeat(501))).toBe("重新開放的理由最多 500 字（目前 501 字）");
    expect(isValidReopenReason("字".repeat(501))).toBe(false);
  });
});

describe("前期更正提示與重新開放的說明（對話框一定要顯示）", () => {
  it("提示文字一字不差；連結指向薪資作業頁的『薪資加減項（前期更正）』卡（#payroll-adjustments）", () => {
    expect(PRIOR_PERIOD_CORRECTION_HINT).toBe(
      "如果這個月薪資已經匯款，建議不要重新開放，改在下個月薪資用「前期更正」補發或扣回",
    );
    expect(PRIOR_PERIOD_CORRECTION_HREF).toBe("/admin/payroll#payroll-adjustments");
  });

  it("重新開放的後果說明", () => {
    expect(REOPEN_EFFECT_NOTE).toBe(
      "重新開放後：該月已鎖定的出勤月表會回到已核准、已定稿的薪資單會回到草稿，重新試算定稿後要再過一次檢查清單才能再鎖定",
    );
  });
});

/* ------------------------------------------------------------ 檢查清單 --- */

describe("檢查清單的顯示整理 checklistViews", () => {
  it("每項「完成數/應完成數」＋是否通過；通過的沒有明細也沒有處理連結", () => {
    const views = checklistViews(PASSING);
    expect(views.map((v) => [v.key, v.progress, v.passed])).toEqual([
      ["sheets", "5/5", true],
      ["leave_settlement", "2/2", true],
      ["expense_settlement", "0/0", true],
      ["payslips", "5/5", true],
    ]);
    expect(views.every((v) => v.shown.length === 0 && v.moreLabel === null && v.fixHref === null)).toBe(true);
  });

  it("沒通過：列出誰／哪張、給處理連結；其餘項目照常", () => {
    const views = checklistViews(FAILING);
    const sheets = views[0];
    expect(sheets).toMatchObject({ key: "sheets", progress: "3/5", passed: false, moreCount: 0, moreLabel: null });
    expect(sheets.shown.map(pendingEntryText)).toEqual(["王小明：月表還是草稿（員工尚未送出）", "李小華：尚未產生月表"]);
    expect(sheets.fixHref).toBe("/admin/attendance-sheets");
    expect(views[1].passed).toBe(true);
  });

  it("最多顯示前 10 筆，其餘寫「還有 N 筆」——N 用 pendingCount（真實總數），不是 pending 陣列長度", () => {
    expect(CHECKLIST_PENDING_SHOW).toBe(10);
    const many = Array.from({ length: 12 }, (_, i) => pending(`員工${i + 1}`, "待處理"));
    const v12 = checklistViews({ items: [item("sheets", 0, 12, many)] })[0];
    expect(v12.shown).toHaveLength(10);
    expect(v12.shown[0].employeeName).toBe("員工1");
    expect(v12.shown[9].employeeName).toBe("員工10");
    expect(v12.moreCount).toBe(2);
    expect(v12.moreLabel).toBe("還有 2 筆");

    // 伺服器 pending 最多回 50 筆，真實總數 137：還有 127 筆
    const fifty = Array.from({ length: 50 }, (_, i) => pending(`員工${i + 1}`, "待處理"));
    const v137 = checklistViews({ items: [item("payslips", 0, 137, fifty, 137)] })[0];
    expect(v137.shown).toHaveLength(10);
    expect(v137.moreCount).toBe(127);
    expect(v137.moreLabel).toBe("還有 127 筆");

    // 剛好 10 筆：不寫「還有」
    const ten = Array.from({ length: 10 }, (_, i) => pending(`員工${i + 1}`, "待處理"));
    expect(checklistViews({ items: [item("sheets", 0, 10, ten)] })[0]).toMatchObject({ moreCount: 0, moreLabel: null });
  });

  it("每一項的處理連結都指向既有的後台頁面", () => {
    expect(CHECKLIST_FIX_HREF).toEqual({
      sheets: "/admin/attendance-sheets",
      leave_settlement: "/admin/leave-settlement",
      expense_settlement: "/admin/expenses",
      payslips: "/admin/payslips",
    });
  });

  it("未完成明細一行字：姓名：說明；沒有姓名就只有說明", () => {
    expect(pendingEntryText({ employeeName: "王小明", detail: "特休 2026-10-03（8 小時）尚未核銷" })).toBe("王小明：特休 2026-10-03（8 小時）尚未核銷");
    expect(pendingEntryText({ employeeName: "", detail: "尚未月結" })).toBe("尚未月結");
    expect(pendingEntryText({ employeeName: "王小明", detail: "" })).toBe("王小明");
  });

  it("label 缺漏時用內建的名稱", () => {
    const views = checklistViews({ items: [{ ...item("payslips", 1, 1), label: "" }] });
    expect(views[0].label).toBe("薪資單已定稿");
  });
});

describe("檢查清單全過才能鎖（沒有強制略過）", () => {
  it("isChecklistReady：ready=true 且每一項都通過才算", () => {
    expect(isChecklistReady(PASSING)).toBe(true);
    expect(isChecklistReady(FAILING)).toBe(false);
    expect(isChecklistReady(null)).toBe(false);
    expect(isChecklistReady(undefined)).toBe(false);
    // 伺服器說 ready，但有一項沒過（不該發生）→ 寧可擋
    expect(isChecklistReady({ ...PASSING, items: [...PASSING.items.slice(0, 3), item("payslips", 4, 5, [pending("甲", "草稿")])] })).toBe(false);
    // ready=false 但每項都過（不該發生）→ 也擋
    expect(isChecklistReady({ ...PASSING, ready: false })).toBe(false);
    // 沒有任何項目 → 不算
    expect(isChecklistReady({ ...PASSING, items: [] })).toBe(false);
  });

  it("確認鈕：ready=false 時是 disabled（canConfirmClose=false）；全過才啟用", () => {
    expect(canConfirmClose({ checklist: FAILING, loading: false, submitting: false })).toBe(false);
    expect(canConfirmClose({ checklist: PASSING, loading: false, submitting: false })).toBe(true);
    expect(canConfirmClose({ checklist: PASSING, loading: false, submitting: false, periodStatus: "open" })).toBe(true);
    expect(canConfirmClose({ checklist: PASSING, loading: false, submitting: false, periodStatus: "reopened" })).toBe(true);
  });

  it("沒載到清單、載入中、送出中、該月其實已經鎖了，都不能按", () => {
    expect(canConfirmClose({ checklist: null, loading: false, submitting: false })).toBe(false);
    expect(canConfirmClose({ checklist: PASSING, loading: true, submitting: false })).toBe(false);
    expect(canConfirmClose({ checklist: PASSING, loading: false, submitting: true })).toBe(false);
    expect(canConfirmClose({ checklist: PASSING, loading: false, submitting: false, periodStatus: "closed" })).toBe(false);
  });

  it("清單上方的一句話", () => {
    expect(checklistSummary(PASSING)).toBe("4 項檢查全部通過，可以鎖定");
    expect(checklistSummary(FAILING)).toBe("還有 1 項未通過，處理完才能鎖定");
  });
});

/* ------------------------------------------------- 409 與錯誤訊息（純函式）--- */

describe("closeOutcomeOf／payrollPeriodErrorMessage", () => {
  it("409 checklist_incomplete 帶出 body.checklist；形狀不對或沒附 → checklist 是 null", () => {
    const withList = closeOutcomeOf(apiError(409, { error: "checklist_incomplete", period: "2026-09", checklist: FAILING }));
    expect(withList).toEqual({ ok: false, error: "checklist_incomplete", checklist: FAILING });
    expect(closeOutcomeOf(apiError(409, { error: "checklist_incomplete", period: "2026-09" }))).toEqual({
      ok: false,
      error: "checklist_incomplete",
      checklist: null,
    });
    expect(closeOutcomeOf(apiError(409, { error: "checklist_incomplete", checklist: { ready: "yes", items: 3 } }))).toMatchObject({
      checklist: null,
    });
  });

  it("409 already_closed；其他錯誤（403、5xx、別的 409、非 Error）一律 null＝照丟", () => {
    expect(closeOutcomeOf(apiError(409, { error: "already_closed", period: "2026-09" }))).toEqual({ ok: false, error: "already_closed" });
    expect(closeOutcomeOf(apiError(403, { error: "forbidden" }))).toBeNull();
    expect(closeOutcomeOf(apiError(500, { error: "checklist_incomplete" }))).toBeNull(); // 狀態碼不是 409
    expect(closeOutcomeOf(apiError(409, { error: "period_closed", period: "2026-09" }))).toBeNull();
    expect(closeOutcomeOf("boom")).toBeNull();
    expect(closeOutcomeOf(null)).toBeNull();
  });

  it("友善訊息：已結算、unlock_forbidden 顯示後端的 message、理由太短／太長、已鎖／已重新開放", () => {
    expect(payrollPeriodErrorMessage(apiError(409, { error: "period_closed", period: "2026-09" }))).toBe("2026-09 已結算，請洽管理者");
    expect(
      payrollPeriodErrorMessage(apiError(403, { error: "unlock_forbidden", message: "只有老闆或老闆指定的人可以重新開放已結算的月份" })),
    ).toBe("只有老闆或老闆指定的人可以重新開放已結算的月份");
    // 後端沒附 message 時的保底
    expect(payrollPeriodErrorMessage(Object.assign(new Error("[403] unlock_forbidden"), { status: 403, code: "unlock_forbidden" }))).toBe(
      "只有老闆、老闆指定的人或平台管理員可以重新開放已結算的月份",
    );
    expect(payrollPeriodErrorMessage(apiError(400, { error: "reason_too_short", message: "重新開放的理由至少 5 個字" }))).toBe(
      "重新開放的理由至少 5 個字",
    );
    expect(payrollPeriodErrorMessage(apiError(400, { error: "reason_too_long" }))).toBe("重新開放的理由最多 500 字");
    expect(payrollPeriodErrorMessage(apiError(404, { error: "period_not_closed" }))).toBe("這個月份目前不是已結算狀態，請重新整理確認");
    expect(payrollPeriodErrorMessage(apiError(409, { error: "already_reopened" }))).toBe("這個月份已經是重新開放的狀態");
    expect(payrollPeriodErrorMessage(apiError(409, { error: "already_closed" }))).toBe("這個月份已經完成發薪並鎖定");
    expect(payrollPeriodErrorMessage(apiError(403, { error: "forbidden" }))).toBe("沒有權限執行此操作");
    expect(payrollPeriodErrorMessage(apiError(503, { error: "period_closes_not_migrated" }))).toContain("尚未套用遷移");
    expect(payrollPeriodErrorMessage(new Error("[500] kaboom"))).toBe("[500] kaboom");
    expect(payrollPeriodErrorMessage("boom", "鎖定失敗")).toBe("鎖定失敗");
  });

  it("isForbiddenError：只看 403", () => {
    expect(isForbiddenError(apiError(403, { error: "forbidden" }))).toBe(true);
    expect(isForbiddenError(apiError(409, { error: "x" }))).toBe(false);
    expect(isForbiddenError("x")).toBe(false);
  });
});

/* ---------------------------------------------------- close／reopen 的 fetch --- */

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("API 呼叫", () => {
  it("listPayrollPeriods：GET /payroll-periods?months=12；getPeriodChecklist：GET /payroll-periods/:period/checklist", async () => {
    const list = {
      currentPeriod: "2026-10",
      canClose: true,
      canReopen: false,
      periods: [row({ period: "2026-10" })],
    };
    const fetchMock = mockFetch(200, list);
    expect(await listPayrollPeriods()).toEqual(list);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/payroll-periods\?months=12$/);
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();

    const checklistFetch = mockFetch(200, { period: "2026-09", status: "open", checklist: PASSING });
    const res = await getPeriodChecklist("2026-09");
    expect(res.checklist.ready).toBe(true);
    expect(String(checklistFetch.mock.calls[0][0])).toMatch(/\/payroll-periods\/2026-09\/checklist$/);
  });

  it("closePayrollPeriod 成功：POST /payroll-periods/:period/close，沒有 body", async () => {
    const result = {
      period: "2026-09",
      status: "closed",
      closedAt: "2026-10-12T06:30:00.000Z",
      closedByEmpId: "emp-1",
      sheetCount: 5,
      lockedCount: 5,
      lockedNow: 5,
      snapshotManifestPath: null,
    };
    const fetchMock = mockFetch(200, result);
    const outcome = await closePayrollPeriod("2026-09");
    expect(outcome).toEqual({ ok: true, result });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/payroll-periods\/2026-09\/close$/);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("closePayrollPeriod 409 checklist_incomplete：不丟例外，把 body.checklist 帶出來給畫面", async () => {
    mockFetch(409, { error: "checklist_incomplete", period: "2026-09", checklist: FAILING });
    const outcome = await closePayrollPeriod("2026-09");
    expect(outcome).toEqual({ ok: false, error: "checklist_incomplete", checklist: FAILING });
    // 畫面拿到的清單：確認鈕仍然是 disabled
    expect(outcome.ok === false && outcome.error === "checklist_incomplete" && isChecklistReady(outcome.checklist)).toBe(false);
  });

  it("closePayrollPeriod 409 already_closed：不丟例外", async () => {
    mockFetch(409, { error: "already_closed", period: "2026-09" });
    expect(await closePayrollPeriod("2026-09")).toEqual({ ok: false, error: "already_closed" });
  });

  it("closePayrollPeriod 其他錯誤照丟：403（不是 HR）、409 period_closed 以外的錯、5xx", async () => {
    mockFetch(403, { error: "forbidden" });
    await expect(closePayrollPeriod("2026-09")).rejects.toMatchObject({ status: 403, code: "forbidden" });
    mockFetch(500, { error: "internal_error" });
    await expect(closePayrollPeriod("2026-09")).rejects.toMatchObject({ status: 500 });
  });

  it("reopenPayrollPeriod：POST /payroll-periods/:period/reopen，body { reason } 去頭尾空白", async () => {
    const result = {
      period: "2026-09",
      status: "reopened",
      reopenedAt: "2026-10-13T01:10:00.000Z",
      reopenedByEmpId: "emp-boss",
      reopenReason: "補發漏的獎金",
      unlockedSheets: 5,
      revertedPayslips: 5,
      notified: 2,
    };
    const fetchMock = mockFetch(200, result);
    expect(await reopenPayrollPeriod("2026-09", "  補發漏的獎金  ")).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/payroll-periods\/2026-09\/reopen$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ reason: "補發漏的獎金" });
  });

  it("reopenPayrollPeriod 403 unlock_forbidden：錯誤帶 serverMessage，畫面顯示後端的 message", async () => {
    mockFetch(403, { error: "unlock_forbidden", message: "只有老闆或老闆指定的人可以重新開放已結算的月份" });
    const err = await reopenPayrollPeriod("2026-09", "補發漏的獎金").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(payrollPeriodErrorMessage(err)).toBe("只有老闆或老闆指定的人可以重新開放已結算的月份");
    expect(isForbiddenError(err)).toBe(true);
  });
});

/* ------------------------------------------- 「誰能重新開放」名單（設定頁）--- */

const BOSS = "11111111-1111-4111-8111-111111111111";
const HR = "22222222-2222-4222-8222-222222222222";
const EMP_A = "33333333-3333-4333-8333-333333333333";
const EMP_B = "44444444-4444-4444-8444-444444444444";

describe("名單 helper：periodUnlockEmpIdsOf／approvalBossEmpIdOf", () => {
  it("沒設定、格式不對 → 空陣列（沒設定＝沒有指定任何人）", () => {
    expect(periodUnlockEmpIdsOf(undefined)).toEqual([]);
    expect(periodUnlockEmpIdsOf(null)).toEqual([]);
    expect(periodUnlockEmpIdsOf({})).toEqual([]);
    expect(periodUnlockEmpIdsOf({ payroll: null })).toEqual([]);
    expect(periodUnlockEmpIdsOf({ payroll: {} })).toEqual([]);
    expect(periodUnlockEmpIdsOf({ payroll: { periodUnlockEmpIds: "oops" } })).toEqual([]);
    expect(periodUnlockEmpIdsOf({ payroll: { periodUnlockEmpIds: { 0: EMP_A } } })).toEqual([]);
    expect(periodUnlockEmpIdsOf({ payroll: [EMP_A] })).toEqual([]);
  });

  it("有設定：只收非空字串、轉小寫、去重，保留順序", () => {
    expect(periodUnlockEmpIdsOf({ payroll: { periodUnlockEmpIds: [EMP_A, EMP_B] } })).toEqual([EMP_A, EMP_B]);
    expect(
      periodUnlockEmpIdsOf({ payroll: { periodUnlockEmpIds: [EMP_A.toUpperCase(), 7, "", "  ", null, EMP_A, EMP_B] } }),
    ).toEqual([EMP_A, EMP_B]);
  });

  it("老闆＝features.approval.fallbackApproverEmpId；沒設定或空字串 → null", () => {
    expect(approvalBossEmpIdOf({ approval: { fallbackApproverEmpId: BOSS } })).toBe(BOSS);
    expect(approvalBossEmpIdOf({ approval: { fallbackApproverEmpId: null } })).toBeNull();
    expect(approvalBossEmpIdOf({ approval: { fallbackApproverEmpId: "  " } })).toBeNull();
    expect(approvalBossEmpIdOf({ approval: {} })).toBeNull();
    expect(approvalBossEmpIdOf({})).toBeNull();
    expect(approvalBossEmpIdOf(null)).toBeNull();
  });
});

describe("isApprovalBoss — 登入者是不是老闆（ESS 簽核分頁永遠顯示給老闆）", () => {
  it("員工 id 等於 features.approval.fallbackApproverEmpId（不分大小寫）→ true", () => {
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: BOSS } }, BOSS)).toBe(true);
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: BOSS.toUpperCase() } }, BOSS)).toBe(true);
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: BOSS } }, BOSS.toUpperCase())).toBe(true);
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: ` ${BOSS} ` } }, BOSS)).toBe(true);
  });

  it("別人 → false（含 HR：HR 不等於老闆）", () => {
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: BOSS } }, EMP_A)).toBe(false);
  });

  it("拿不到就照舊（false）：沒設定老闆、features 沒回、登入者 id 還沒取得", () => {
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: null } }, BOSS)).toBe(false);
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: "" } }, BOSS)).toBe(false);
    expect(isApprovalBoss({ approval: {} }, BOSS)).toBe(false);
    expect(isApprovalBoss({}, BOSS)).toBe(false);
    expect(isApprovalBoss(null, BOSS)).toBe(false);
    expect(isApprovalBoss(undefined, BOSS)).toBe(false);
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: BOSS } }, null)).toBe(false);
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: BOSS } }, undefined)).toBe(false);
    expect(isApprovalBoss({ approval: { fallbackApproverEmpId: BOSS } }, "")).toBe(false);
    expect(isApprovalBoss({ approval: "not-an-object" }, BOSS)).toBe(false);
  });
});

describe("isBossOrPlatformAdmin — 以後平台管理員就是老闆（2026-10-27）", () => {
  it("老闆本人可以；platform_admin 可以（沒設定老闆也可以）；hr_admin、一般員工不行；沒登入不行", () => {
    const features = { approval: { fallbackApproverEmpId: BOSS } };
    expect(isBossOrPlatformAdmin(features, { id: BOSS, role: "employee" })).toBe(true);
    expect(isBossOrPlatformAdmin(features, { id: EMP_A, role: "platform_admin" })).toBe(true);
    expect(isBossOrPlatformAdmin({}, { id: EMP_A, role: "platform_admin" })).toBe(true);
    expect(isBossOrPlatformAdmin(null, { id: EMP_A, role: "platform_admin" })).toBe(true);
    expect(isBossOrPlatformAdmin(features, { id: EMP_A, role: "hr_admin" })).toBe(false);
    expect(isBossOrPlatformAdmin({}, { id: EMP_A, role: "hr_admin" })).toBe(false);
    expect(isBossOrPlatformAdmin(features, { id: EMP_A, role: "employee" })).toBe(false);
    expect(isBossOrPlatformAdmin(features, null)).toBe(false);
    expect(isBossOrPlatformAdmin(features, { id: null, role: "platform_admin" })).toBe(false);
  });
});

describe("誰能改名單 canEditUnlockList：只有老闆或 platform_admin", () => {
  it("老闆本人（員工 id 等於 fallbackApproverEmpId，不分大小寫）可以", () => {
    expect(canEditUnlockList({ id: BOSS, role: "employee" }, BOSS)).toBe(true);
    expect(canEditUnlockList({ id: BOSS.toUpperCase(), role: "hr_admin" }, BOSS)).toBe(true);
    expect(canEditUnlockList({ id: BOSS, role: "hr_admin" }, BOSS.toUpperCase())).toBe(true);
  });

  it("HR 不是老闆就不行（HR 也一樣）；會計、一般員工也不行", () => {
    expect(canEditUnlockList({ id: HR, role: "hr_admin" }, BOSS)).toBe(false);
    expect(canEditUnlockList({ id: EMP_A, role: "accountant" }, BOSS)).toBe(false);
    expect(canEditUnlockList({ id: EMP_A, role: "employee" }, BOSS)).toBe(false);
  });

  it("platform_admin 永遠可以（含沒有設定老闆的租戶）", () => {
    expect(canEditUnlockList({ id: HR, role: "platform_admin" }, BOSS)).toBe(true);
    expect(canEditUnlockList({ id: HR, role: "platform_admin" }, null)).toBe(true);
  });

  it("沒設定老闆、或還沒載到登入者 → 不能改", () => {
    expect(canEditUnlockList({ id: HR, role: "hr_admin" }, null)).toBe(false);
    expect(canEditUnlockList({ id: HR, role: "hr_admin" }, undefined)).toBe(false);
    expect(canEditUnlockList({ id: HR, role: "hr_admin" }, "")).toBe(false);
    expect(canEditUnlockList(null, BOSS)).toBe(false);
    expect(canEditUnlockList(undefined, BOSS)).toBe(false);
  });
});

describe("勾選清單 toggleUnlockEmpId／unlockCandidates／filterUnlockCandidates", () => {
  const employees = [
    { id: BOSS, name: "陳老闆", emp_no: "E001", status: "active" },
    { id: HR, name: "林人資", emp_no: "E002", status: "active" },
    { id: EMP_A, name: "王小明", emp_no: "E010", status: "active" },
    { id: EMP_B, name: "李離職", emp_no: "E020", status: "terminated" },
  ];

  it("toggleUnlockEmpId：勾選加到最後、取消拿掉；回新陣列，不改原陣列；重複勾選不會重複", () => {
    const base = [EMP_A];
    expect(toggleUnlockEmpId(base, EMP_B, true)).toEqual([EMP_A, EMP_B]);
    expect(toggleUnlockEmpId(base, EMP_A, true)).toEqual([EMP_A]);
    expect(toggleUnlockEmpId([EMP_A, EMP_B], EMP_A, false)).toEqual([EMP_B]);
    expect(toggleUnlockEmpId([], EMP_A, false)).toEqual([]);
    expect(toggleUnlockEmpId([EMP_A], EMP_A.toUpperCase(), false)).toEqual([]);
    expect(toggleUnlockEmpId([EMP_A], EMP_B.toUpperCase(), true)).toEqual([EMP_A, EMP_B]);
    expect(base).toEqual([EMP_A]);
  });

  it("unlockCandidates：老闆排最前；離職的人只有「已被指定」才會留在清單裡（讓老闆取消得掉）", () => {
    const list = unlockCandidates(employees, [EMP_A], BOSS);
    // 老闆之後依姓名排序（zh-Hant 筆畫序依 ICU 資料而定，這裡不綁死順序，只確認人是對的）
    expect(list[0].name).toBe("陳老闆");
    expect(list.slice(1).map((c) => c.name).sort()).toEqual(["王小明", "林人資"].sort());
    expect(list).toHaveLength(3); // 離職且沒被指定的李離職不在清單裡
    expect(list[0]).toMatchObject({ id: BOSS, isBoss: true, checked: false, active: true });
    expect(list.find((c) => c.id === EMP_A)).toMatchObject({ checked: true, isBoss: false });
    expect(list.find((c) => c.id === HR)).toMatchObject({ checked: false });

    const withLeaver = unlockCandidates(employees, [EMP_A, EMP_B], BOSS);
    expect(withLeaver.map((c) => c.name)).toContain("李離職");
    expect(withLeaver.find((c) => c.id === EMP_B)).toMatchObject({ checked: true, active: false });
  });

  it("沒設定老闆也行；大小寫不同的 id 對得上", () => {
    const list = unlockCandidates(employees, [EMP_A.toUpperCase()], null);
    expect(list.some((c) => c.isBoss)).toBe(false);
    expect(list.find((c) => c.id === EMP_A)?.checked).toBe(true);
  });

  it("filterUnlockCandidates：姓名或工號、不分大小寫；沒關鍵字就是全部", () => {
    const list = unlockCandidates(employees, [], BOSS);
    expect(filterUnlockCandidates(list, "").map((c) => c.name)).toEqual(list.map((c) => c.name));
    expect(filterUnlockCandidates(list, "  小明 ").map((c) => c.name)).toEqual(["王小明"]);
    expect(filterUnlockCandidates(list, "e002").map((c) => c.name)).toEqual(["林人資"]);
    expect(filterUnlockCandidates(list, "不存在")).toEqual([]);
  });
});

describe("名單人數上限", () => {
  it("與後端 periodUnlockEmpIds 的 .max(50) 一致", () => {
    expect(UNLOCK_LIST_MAX).toBe(50);
  });
});

describe("儲存名單失敗的訊息 unlockListSaveErrorMessage", () => {
  it("403 not_boss → 「只有老闆可以指定…」（唯讀時畫面上也是同一句）", () => {
    expect(UNLOCK_LIST_BOSS_ONLY_NOTE).toContain("只有老闆可以指定");
    expect(unlockListSaveErrorMessage(apiError(403, { error: "not_boss", message: "只有老闆可以指定誰能重新開放已結算的月份" }))).toBe(
      UNLOCK_LIST_BOSS_ONLY_NOTE,
    );
  });

  it("400 invalid_employee、403 forbidden（不是 HR）、其餘照原文", () => {
    expect(unlockListSaveErrorMessage(apiError(400, { error: "invalid_employee", employeeIds: [EMP_B] }))).toContain("不屬於本公司");
    expect(unlockListSaveErrorMessage(apiError(403, { error: "forbidden" }))).toContain("沒有儲存設定的權限");
    expect(unlockListSaveErrorMessage(new Error("[500] kaboom"))).toBe("[500] kaboom");
    expect(unlockListSaveErrorMessage("boom")).toBe("儲存失敗");
  });
});
