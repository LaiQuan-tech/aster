/**
 * 後台「出勤統計表」合併頁（2026-11-09 業主：原「出勤月表與月結」/admin/attendance-sheets 併進來，
 * 一頁完成「看＋簽核＋結算進度」）的純邏輯：網址 query 讀寫、員工清單（員工主檔 × 當月月表）組裝與篩選、
 * 狀態磚計數。不 import React／DOM，單元測試在 __tests__/attendance-statements-page.test.ts。
 *
 * 網址：/admin/attendance-statements?employee=<id>&period=YYYY-MM&status=<SheetStatus>&dept=<deptId>&anomaly=1
 *   - 舊網址 /admin/attendance-sheets（帶的 query 原樣保留）與 /admin/attendance-sheets/:id（→ ?sheet=:id，
 *     頁面用 GET /attendance-sheets/:id 換成 employee＋period 後從網址拿掉）都轉址到這裡（admin-nav ADMIN_REDIRECTS）。
 *   - `deptId` 也收（舊列表頁 API 參數名），寫回時一律用 `dept`。
 */
import type { Employee } from "./admin-api";
import { filterEmployeeOptions, type EmployeeOption } from "./employee-combobox";
import type { SheetListItem, SheetStatus } from "./attendance-sheets-api";

export const STATEMENT_STATUS_TILES: readonly SheetStatus[] = [
  "draft",
  "submitted",
  "manager_reviewed",
  "approved",
  "locked",
  "returned",
];

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface StatementsQuery {
  employee: string | null;
  period: string | null;
  status: SheetStatus | "";
  dept: string;
  anomaly: boolean;
  /** 舊網址 /admin/attendance-sheets/:id 轉來的月表 id（只讀不寫）。 */
  sheet: string | null;
}

export function readStatementsQuery(search: string): StatementsQuery {
  const qs = new URLSearchParams(search);
  const period = qs.get("period");
  const status = qs.get("status") ?? "";
  const anomaly = qs.get("anomaly");
  return {
    employee: qs.get("employee") || null,
    period: period && PERIOD_RE.test(period) ? period : null,
    status: (STATEMENT_STATUS_TILES as readonly string[]).includes(status) ? (status as SheetStatus) : "",
    dept: qs.get("dept") || qs.get("deptId") || "",
    anomaly: anomaly === "1" || anomaly === "true",
    sheet: qs.get("sheet") || null,
  };
}

/** 狀態 → 網址 search（含開頭的「?」；全空回 ""）。不寫 sheet（換成 employee＋period 後就丟掉）。 */
export function buildStatementsSearch(q: Omit<StatementsQuery, "sheet">): string {
  const qs = new URLSearchParams();
  if (q.employee) qs.set("employee", q.employee);
  if (q.period) qs.set("period", q.period);
  if (q.status) qs.set("status", q.status);
  if (q.dept) qs.set("dept", q.dept);
  if (q.anomaly) qs.set("anomaly", "1");
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export interface RosterRow {
  employeeId: string;
  empNo: string | null;
  name: string;
  active: boolean;
  deptId: string | null;
  /** 當月月表（沒有＝尚未產生或不在職）。 */
  sheet: SheetListItem | null;
}

/**
 * 員工主檔 × 當月月表 → 左側清單。在職員工全列；離職員工只有當月有月表才列（例如月中離職）。
 * 月表的員工若不在主檔清單（例如主檔讀取失敗）也照列，資料以月表為準。
 * 排序：在職在前 → 工號 → 姓名。
 */
export function buildRoster(employees: readonly Employee[], sheets: readonly SheetListItem[]): RosterRow[] {
  const sheetByEmp = new Map<string, SheetListItem>();
  for (const s of sheets) sheetByEmp.set(s.employeeId, s);
  const rows: RosterRow[] = [];
  const seen = new Set<string>();
  for (const e of employees) {
    const sheet = sheetByEmp.get(e.id) ?? null;
    const active = e.status === "active";
    if (!active && !sheet) continue;
    seen.add(e.id);
    rows.push({ employeeId: e.id, empNo: e.emp_no, name: e.name, active, deptId: e.dept_id, sheet });
  }
  for (const s of sheets) {
    if (seen.has(s.employeeId)) continue;
    rows.push({ employeeId: s.employeeId, empNo: s.employeeNo, name: s.employeeName, active: true, deptId: s.deptId, sheet: s });
  }
  return rows.sort(
    (a, b) =>
      Number(!a.active) - Number(!b.active) ||
      String(a.empNo ?? "").localeCompare(String(b.empNo ?? "")) ||
      a.name.localeCompare(b.name),
  );
}

export function hasAnomaly(sheet: SheetListItem | null): boolean {
  return !!sheet && sheet.anomalyCount.error + sheet.anomalyCount.warn > 0;
}

/** 清單列 → 搜尋用的選項（沿用 EmployeeCombobox 的篩選邏輯：工號／姓名、多字皆須命中）。 */
export function rosterOption(row: RosterRow): EmployeeOption {
  return {
    id: row.employeeId,
    label: row.empNo ? `${row.empNo} · ${row.name}` : row.name,
    searchText: row.empNo ?? "",
    note: row.active ? undefined : "已離職",
  };
}

/**
 * 篩選：部門（以月表的 deptId 為準、無月表才用員工主檔的 dept_id；與狀態磚同口徑）、狀態（只留該狀態的月表）、只看異常
 * （error＋warn > 0，與 API anomaly=1 同一條件）、關鍵字。
 */
export function filterRoster(
  rows: readonly RosterRow[],
  f: { status: SheetStatus | ""; dept: string; anomaly: boolean; query: string },
): RosterRow[] {
  let out = rows.filter((r) => {
    if (f.dept && (r.sheet?.deptId ?? r.deptId ?? null) !== f.dept) return false;
    if (f.status && r.sheet?.status !== f.status) return false;
    if (f.anomaly && !hasAnomaly(r.sheet)) return false;
    return true;
  });
  if (f.query.trim()) {
    const keep = new Set(filterEmployeeOptions(out.map(rosterOption), f.query).map((o) => o.id));
    out = out.filter((r) => keep.has(r.employeeId));
  }
  return out;
}

export interface StatusStats {
  total: number;
  byStatus: Record<SheetStatus, number>;
  pendingApproval: number;
  hasError: number;
}

/** 狀態磚：計數不受狀態篩選影響（點磚＝切篩選），只吃部門篩選後的月表。 */
export function statusStats(sheets: readonly SheetListItem[], dept: string): StatusStats {
  const byStatus = Object.fromEntries(STATEMENT_STATUS_TILES.map((s) => [s, 0])) as Record<SheetStatus, number>;
  let total = 0;
  let hasError = 0;
  for (const s of sheets) {
    if (dept && s.deptId !== dept) continue;
    total += 1;
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    if (s.anomalyCount.error > 0) hasError += 1;
  }
  return { total, byStatus, pendingApproval: byStatus.manager_reviewed, hasError };
}

/** 依月表狀態可用的簽核動作（與原 /admin/attendance-sheets/[id] 相同；後端仍會再擋）。 */
export function sheetActions(status: SheetStatus): { approve: boolean; return: boolean; reopen: boolean; recompute: boolean } {
  return {
    approve: status === "manager_reviewed",
    return: status === "submitted" || status === "manager_reviewed" || status === "approved",
    reopen: status === "approved",
    recompute: status === "draft" || status === "returned",
  };
}

/** 加班累計警示的字色（36／40／46 小時門檻）。 */
export function otAlertClass(alert: SheetListItem["overtimeMonthlyAlert"]): string {
  if (alert === "46") return "text-red-700 font-semibold";
  if (alert === "40") return "text-orange-600 font-semibold";
  if (alert === "36") return "text-amber-600 font-semibold";
  return "text-gray-500";
}
