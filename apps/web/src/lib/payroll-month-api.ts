/**
 * 「月結發薪」頁（/admin/payroll，2026-11-09「薪資資料與執行」＋「薪資單」合併）的 client＋純函式。
 *
 * 對應後端 GET /payroll-periods/:period/employees（apps/api/src/routes/payroll-periods.ts；形狀手抄自
 * services/payroll-period.ts 的 PeriodEmployeeRow——web 與 api 是各自的 build 邊界）。
 * 每位員工一列：月表、待簽申請、未核銷假單、遲到說明、未月結報銷、未核銷預支、薪資單；`ready`＝四項會擋鎖定的
 * 檢查（月表／假單核銷／報銷月結／薪資單定稿）都過——與「完成發薪並鎖定」的檢查清單同一組判定。
 * 待簽申請與遲到說明只是提醒（reminders），不擋鎖定。
 *
 * 純函式（篩選、步驟進度、鎖定卡住清單、儲存格文字）都有單元測試：__tests__/payroll-month.test.ts。
 */
import { apiFetch } from "./api-client";
import type { ChecklistKey, PeriodStatus } from "./payroll-periods-api";

export type PayslipRowStatus = "none" | "draft" | "finalized";

export interface PeriodEmployeeRow {
  employeeId: string;
  employeeName: string;
  empNo: string | null;
  status: string;
  employedInPeriod: boolean;
  /** missing＝應有但還沒產生；null＝不需要（不在職且沒有月表）。 */
  sheet: { id: string | null; status: string; ready: boolean } | null;
  pendingRequests: { total: number; byKind: Record<string, number> };
  unsettledLeaves: number;
  undecidedLateReports: number;
  submittedExpenses: { count: number; amount: number };
  openAdvances: number;
  payslip: {
    id: string | null;
    status: PayslipRowStatus;
    required: boolean;
    stale: Array<"fixed_allowances" | "pension_settings">;
    sentAt: string | null;
    net: number | null;
  };
  blockers: ChecklistKey[];
  reminders: Array<"pending_requests" | "late_reports">;
  ready: boolean;
}

export interface PeriodEmployeesResponse {
  period: string;
  status: PeriodStatus;
  ready: boolean;
  summary: { total: number; ready: number; blocked: number; withReminders: number };
  employees: PeriodEmployeeRow[];
}

export function getPeriodEmployees(period: string) {
  return apiFetch<PeriodEmployeesResponse>(`/payroll-periods/${encodeURIComponent(period)}/employees`);
}

/* ------------------------------------------------------------- 篩選 --- */

export type RosterFilter = "all" | "blocked" | "ready" | "reminders";

export const ROSTER_FILTER_LABEL: Record<RosterFilter, string> = {
  all: "全部",
  blocked: "未就緒",
  ready: "已就緒",
  reminders: "有提醒",
};

/** 依篩選與關鍵字（工號、姓名，不分大小寫）挑列。 */
export function filterRoster(rows: readonly PeriodEmployeeRow[], filter: RosterFilter, keyword: string): PeriodEmployeeRow[] {
  const kw = keyword.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "blocked" && r.ready) return false;
    if (filter === "ready" && !r.ready) return false;
    if (filter === "reminders" && r.reminders.length === 0) return false;
    if (!kw) return true;
    return `${r.empNo ?? ""} ${r.employeeName}`.toLowerCase().includes(kw);
  });
}

export function rosterCounts(rows: readonly PeriodEmployeeRow[]): Record<RosterFilter, number> {
  return {
    all: rows.length,
    blocked: rows.filter((r) => !r.ready).length,
    ready: rows.filter((r) => r.ready).length,
    reminders: rows.filter((r) => r.reminders.length > 0).length,
  };
}

export function rosterLabel(r: Pick<PeriodEmployeeRow, "empNo" | "employeeName">): string {
  return r.empNo ? `${r.empNo} · ${r.employeeName}` : r.employeeName;
}

/* ------------------------------------------------------------- 步驟條 --- */

export type StepKey = "check" | "run" | "finalize" | "send" | "lock";

export interface StepView {
  key: StepKey;
  no: number;
  label: string;
  /** 「3/5」之類的進度；沒有可數的就是空字串。 */
  progress: string;
  done: boolean;
}

const STEP_LABEL: Record<StepKey, string> = {
  check: "檢查待辦",
  run: "執行薪資",
  finalize: "核對並定案",
  send: "寄送薪資條",
  lock: "鎖定",
};

/**
 * 五個步驟各自的進度：
 *   ① 檢查待辦：月表／假單核銷／報銷月結都過的人數（薪資單那項在 ②③ 算）
 *   ② 執行薪資：應有薪資單的人裡，已經有薪資單的人數
 *   ③ 核對並定案：應有薪資單的人裡，已定案的人數
 *   ④ 寄送薪資條：已定案的薪資單裡，已寄送的張數（不擋鎖定）
 *   ⑤ 鎖定：該月狀態
 */
export function stepViews(rows: readonly PeriodEmployeeRow[], periodStatus: PeriodStatus | null): StepView[] {
  const checkDone = rows.filter((r) => !r.blockers.some((b) => b !== "payslips")).length;
  const required = rows.filter((r) => r.payslip.required);
  const generated = required.filter((r) => r.payslip.status !== "none").length;
  const finalized = required.filter((r) => r.payslip.status === "finalized").length;
  const finalizedAll = rows.filter((r) => r.payslip.status === "finalized");
  const sent = finalizedAll.filter((r) => !!r.payslip.sentAt).length;
  const locked = periodStatus === "closed";
  const mk = (key: StepKey, no: number, progress: string, done: boolean): StepView => ({ key, no, label: STEP_LABEL[key], progress, done });
  return [
    mk("check", 1, `${checkDone}/${rows.length}`, checkDone === rows.length),
    mk("run", 2, `${generated}/${required.length}`, generated === required.length),
    mk("finalize", 3, `${finalized}/${required.length}`, finalized === required.length),
    mk("send", 4, `${sent}/${finalizedAll.length}`, finalizedAll.length > 0 && sent === finalizedAll.length),
    mk("lock", 5, locked ? "已鎖定" : periodStatus === "reopened" ? "已重新開放" : "未鎖定", locked),
  ];
}

/* ------------------------------------------------------- 鎖定卡住清單 --- */

export const BLOCKER_LABEL: Record<ChecklistKey, string> = {
  sheets: "出勤月表未核准",
  leave_settlement: "假單未核銷",
  expense_settlement: "報銷未月結",
  payslips: "薪資單未定案",
};

export interface LockBlocker {
  employeeId: string;
  label: string;
  items: string[];
}

/** 鎖定區列出「卡在誰、哪一項」。 */
export function lockBlockersOf(rows: readonly PeriodEmployeeRow[]): LockBlocker[] {
  return rows
    .filter((r) => r.blockers.length > 0)
    .map((r) => ({ employeeId: r.employeeId, label: rosterLabel(r), items: r.blockers.map((b) => BLOCKER_LABEL[b]) }));
}

/* ------------------------------------------------------------ 儲存格 --- */

export type CellTone = "ok" | "warn" | "bad" | "none";

export interface Cell {
  text: string;
  tone: CellTone;
}

const SHEET_STATUS_TEXT: Record<string, string> = {
  missing: "未產生",
  draft: "草稿",
  submitted: "待主管",
  manager_reviewed: "待 HR",
  returned: "已退回",
  approved: "已核准",
  locked: "已鎖定",
};

export function sheetCell(r: PeriodEmployeeRow): Cell {
  if (!r.sheet) return { text: "—", tone: "none" };
  return { text: SHEET_STATUS_TEXT[r.sheet.status] ?? r.sheet.status, tone: r.sheet.ready ? "ok" : "bad" };
}

export function requestsCell(r: PeriodEmployeeRow): Cell {
  return r.pendingRequests.total > 0 ? { text: `${r.pendingRequests.total} 張`, tone: "warn" } : { text: "—", tone: "ok" };
}

export function lateCell(r: PeriodEmployeeRow): Cell {
  return r.undecidedLateReports > 0 ? { text: `${r.undecidedLateReports} 筆未決定`, tone: "warn" } : { text: "—", tone: "ok" };
}

/** 核銷／報銷：未核銷假單與未月結報銷（兩者都擋鎖定）；未核銷預支只附註。 */
export function settlementCell(r: PeriodEmployeeRow): Cell {
  const parts: string[] = [];
  if (r.unsettledLeaves > 0) parts.push(`假單 ${r.unsettledLeaves}`);
  if (r.submittedExpenses.count > 0) parts.push(`報銷 ${r.submittedExpenses.count}`);
  if (parts.length > 0) return { text: `${parts.join("、")} 未處理`, tone: "bad" };
  return { text: r.openAdvances > 0 ? `預支 ${r.openAdvances} 未沖` : "—", tone: "ok" };
}

export function payslipCell(r: PeriodEmployeeRow): Cell {
  const net = r.payslip.net != null ? ` ${r.payslip.net.toLocaleString("zh-TW")}` : "";
  if (r.payslip.status === "finalized") return { text: `已定案${net}`, tone: "ok" };
  if (r.payslip.status === "draft") return { text: `${r.payslip.stale.length > 0 ? "需重算" : "草稿"}${net}`, tone: r.payslip.required ? "bad" : "warn" };
  return r.payslip.required ? { text: "未產生", tone: "bad" } : { text: "—", tone: "none" };
}
