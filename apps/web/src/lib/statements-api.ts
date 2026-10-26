import { apiDownload, apiFetch } from "./api-client";

/**
 * 出勤統計表／薪資明細表（Excel 版面）的 API（apps/api/src/routes/employee-statements.ts）。
 *
 * 版面在 API 端算好（StatementGrid：每格的值、顯示字串、合併、框線、字級、底色），前端只照格線畫
 * （components/StatementTable.tsx），列印、PDF（lib/statement-pdf.ts）也用同一份格線——三者版面一致。
 * 會計看不到的金額在 API 端就遮成「—」，前端不另外判斷。
 * 型別與 apps/api/src/lib/statements/grid.ts 同步。
 */

export type BorderStyle = "thin" | "medium" | "thick";

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
}

export interface StatementGrid {
  kind: "attendance" | "payslip";
  title: string;
  columns: number[];
  rowHeights: number[];
  font: string;
  cells: GridCell[];
}

export interface StatementSummary {
  grid: StatementGrid;
  hasAttendance: boolean;
  sheetStatus: string | null;
  moneySource: "payslip" | "preview" | null;
  payslipStatus: string | null;
}

export interface EmployeeStatements {
  period: string;
  periods: string[];
  employee: { id: string; name: string; empNo: string | null };
  canSeeMoney: boolean;
  attendance: StatementSummary;
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

export function getEmployeeStatements(employeeId: string, period?: string) {
  const q = period ? `?period=${encodeURIComponent(period)}` : "";
  return apiFetch<EmployeeStatements>(`/employees/${encodeURIComponent(employeeId)}/statements${q}`);
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
