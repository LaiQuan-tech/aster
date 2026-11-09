import { apiDownload, apiFetch } from "./api-client";

/**
 * 出勤統計表／薪資明細表（Excel 版面）的 API（apps/api/src/routes/employee-statements.ts）。
 *
 * 版面在 API 端算好（StatementGrid：每格的值、顯示字串、合併、框線、字級、底色），前端只照格線畫
 * （components/StatementTable.tsx），列印、PDF（lib/statement-pdf.ts）也用同一份格線——三者版面一致。
 * 會計看不到的金額在 API 端就遮成「—」，前端不另外判斷。
 * 型別與 apps/api/src/lib/statements/grid.ts 同步。
 */

export type BorderStyle = "thin" | "medium" | "thick" | "double";

export interface GridBorder {
  top?: BorderStyle;
  bottom?: BorderStyle;
  left?: BorderStyle;
  right?: BorderStyle;
}

export interface GridCell {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  value: string | number | null;
  text: string;
  format: string;
  bold?: boolean;
  size?: number;
  align?: "left" | "center" | "right";
  fill?: string;
  border?: GridBorder;
  wrap?: boolean;
  negative?: boolean;
  money?: boolean;
  /** 字色 hex（專案獎金總表的紅字欄、灰字、藍字備註）；省略＝黑。 */
  color?: string;
  /** 公司標誌格（專案獎金總表）：畫 /brand/aster-logo.svg，text 當替代文字。 */
  logo?: boolean;
  /** 畫面專用的小字提示（例：精簡檢視隱藏了幾位成員）；不進 Excel。 */
  hint?: string;
}

export interface StatementGrid {
  kind: "attendance" | "payslip" | "bonusSheet" | "leaveForm" | "expenseSheet";
  title: string;
  columns: number[];
  rowHeights: number[];
  font: string;
  cells: GridCell[];
  /** 凍結的表頭列數／前幾欄（專案獎金總表）。 */
  freeze?: { rows: number; cols: number };
  page?: {
    orientation: "portrait" | "landscape";
    paperSize: number;
    printTitleRows?: [number, number];
    fit?: "width" | "none";
    margins?: { left: number; right: number; top: number; bottom: number };
    printArea?: string;
  };
  /** 隱藏欄（0 起算；原 Excel 的試算欄）：畫面不畫，合併範圍只算可見欄。 */
  hiddenColumns?: number[];
  /** 預設隱藏的列（0 起算；出勤統計表的週末／國定假日列）：畫面預設不畫，可切換顯示。 */
  hiddenRows?: number[];
}

export interface StatementSummary {
  grid: StatementGrid;
  hasAttendance: boolean;
  sheetStatus: string | null;
  moneySource: "payslip" | "preview" | null;
  payslipStatus: string | null;
}

/** 出勤統計表：另帶「請假單」「支出表」兩頁與月表凍結狀態（2026-11-09）。舊 API 沒有這些欄位。 */
export interface AttendanceStatementSummary extends StatementSummary {
  leaveForm?: StatementGrid;
  expenseSheet?: StatementGrid;
  frozen?: boolean;
  approvedAt?: string | null;
  lockedAt?: string | null;
  computedAt?: string | null;
}

export type RecomputeReason =
  | "recomputed"
  | "throttled"
  | "frozen"
  | "in_review"
  | "period_closed"
  | "future_period"
  | "not_employed"
  | "failed";

export interface EmployeeStatements {
  period: string;
  periods: string[];
  employee: { id: string; name: string; empNo: string | null };
  canSeeMoney: boolean;
  /** live／refresh 時的重算結果；沒要求＝null。 */
  recompute?: { ran: boolean; reason: RecomputeReason } | null;
  attendance: AttendanceStatementSummary;
  /** 只有 HR／平台管理員拿得到；會計＝null。 */
  payslip: StatementSummary | null;
}

export interface MyPayslipStatement {
  period: string;
  periods: string[];
  employee: { id: string; name: string; empNo: string | null };
  payslip: StatementSummary;
  expenses: Array<{ date: string; amount: number; description: string; project: string | null }> | null;
}

/**
 * opts.live＝開畫面即重算（未核准月份、API 端 5 分鐘節流）；opts.refresh＝「重新整理」鈕（強制重算未核准月份）。
 */
export function getEmployeeStatements(employeeId: string, period?: string, opts: { live?: boolean; refresh?: boolean } = {}) {
  const params = new URLSearchParams();
  if (period) params.set("period", period);
  if (opts.refresh) params.set("refresh", "1");
  else if (opts.live) params.set("live", "1");
  const q = params.toString() ? `?${params.toString()}` : "";
  return apiFetch<EmployeeStatements>(`/employees/${encodeURIComponent(employeeId)}/statements${q}`);
}

/** 重算結果 → 畫面提示（沒有要說的＝null）。 */
export function recomputeNote(r: EmployeeStatements["recompute"]): string | null {
  if (!r) return null;
  switch (r.reason) {
    case "recomputed":
      return "已依最新打卡、補登、請假與加班紀錄重算";
    case "throttled":
      return "5 分鐘內已重算過，顯示最近一次重算結果";
    case "in_review":
      return "月表審核中（已送出），數字暫不重算";
    case "period_closed":
      return "該月已結算，不再重算";
    case "failed":
      return "重算失敗，顯示上次計算結果";
    default:
      return null;
  }
}

/** 'YYYY-MM' → 民國「115-06」（檔名用）。 */
export function rocPeriodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${y - 1911}-${String(m).padStart(2, "0")}`;
}

export function downloadStatementXlsx(
  employeeId: string,
  kind: "attendance" | "payslip",
  period: string,
  empNo: string | null,
): Promise<void> {
  const label = kind === "attendance" ? "出勤統計表" : "薪資明細表";
  const path = `/employees/${encodeURIComponent(employeeId)}/${kind}-statement.xlsx?period=${encodeURIComponent(period)}`;
  return apiDownload(path, `${label}_${rocPeriodLabel(period)}_${empNo || "未設工號"}.xlsx`);
}

export function getMyPayslipStatementPeriods() {
  return apiFetch<{ periods: string[] }>("/my/payslip-statements");
}

export function getMyPayslipStatement(period?: string) {
  const q = period ? `?period=${encodeURIComponent(period)}` : "";
  return apiFetch<MyPayslipStatement>(`/my/payslip-statement${q}`);
}
