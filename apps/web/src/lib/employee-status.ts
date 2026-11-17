/**
 * 員工在職／離職判斷（2026-11-17 業主：「已離職員工不要出現在列表與下拉選單，但要有地方可以查詢」）。
 * 純函式、無 React／IO，有 vitest（lib/__tests__/employee-status.test.ts）。
 *
 * 在職＝status === "active" 且（沒有離職日，或離職日 ≥ 今天——離職當天仍算在職）。
 *   - 與後端 /employees/:id/deactivate 一致：停用會把 status 改成 inactive 並寫入離職日。
 *   - HR 在員工內頁只填離職日（status 仍是 active）時，過了離職日也算離職。
 *   - 舊資料沒有 status（undefined/""）視同 active，避免舊 API 把所有人藏掉。
 *
 * 用途：
 *   - 「選人」的下拉（指派、簽核人、代理人、通知對象…）→ `pickableEmployees(list, keepIds)`：只留在職者，
 *     但目前已選中的人（既有資料）保留，顯示時加註「已離職」，避免既有值變成空白或 id。
 *   - 「查歷史」的下拉（出勤、打卡、薪資、請假紀錄、稽核…）→ `employedInPeriod(list, from, to, keepIds)`：
 *     預設在職，另加該期間內仍在職（離職日 ≥ 期間起日）的離職者。
 *   - 薪資計算、跑薪資等邏輯不使用本檔（離職當月仍要算）。
 */

export type EmployeeStatusFields = {
  id: string;
  status?: string | null;
  terminated_at?: string | null;
  hire_date?: string | null;
};

/** 台北時區的今天（YYYY-MM-DD）。 */
export function todayTaipei(now: Date = new Date()): string {
  return now.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

function day(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

/** 是否在職（今天）。 */
export function isEmployeeActive(employee: Omit<EmployeeStatusFields, "id">, today: string = todayTaipei()): boolean {
  const status = employee.status ?? "active";
  if (status !== "" && status !== "active") return false;
  const term = day(employee.terminated_at);
  return !term || term >= today;
}

/** 已離職（＝不在職）。 */
export function isEmployeeTerminated(employee: Omit<EmployeeStatusFields, "id">, today: string = todayTaipei()): boolean {
  return !isEmployeeActive(employee, today);
}

/** 離職標籤：「已離職（2026-10-31）」；沒有離職日的停用帳號 →「已離職（停用）」。在職回 null。 */
export function terminatedLabel(employee: Omit<EmployeeStatusFields, "id">, today: string = todayTaipei()): string | null {
  if (isEmployeeActive(employee, today)) return null;
  const term = day(employee.terminated_at);
  return term ? `已離職（${term}）` : "已離職（停用）";
}

/** 下拉選項右側小字（EmployeeOption.note）：離職者「已離職」、沒有離職日的停用帳號「已停用」，在職者 undefined。 */
export function employeeStatusNote(employee: Omit<EmployeeStatusFields, "id">, today: string = todayTaipei()): string | undefined {
  if (isEmployeeActive(employee, today)) return undefined;
  return day(employee.terminated_at) ? "已離職" : "已停用";
}

function keepSet(keepIds: Iterable<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const id of keepIds) if (id) set.add(id);
  return set;
}

/**
 * 「選人」下拉的候選：只留在職者；`keepIds`（目前已選中的值、既有資料上的人）即使已離職也保留，
 * 呼叫端用 employeeStatusNote 標「已離職」。維持原本順序。
 */
export function pickableEmployees<T extends EmployeeStatusFields>(
  employees: readonly T[],
  keepIds: Iterable<string | null | undefined> = [],
  today: string = todayTaipei(),
): T[] {
  const keep = keepSet(keepIds);
  return employees.filter((e) => keep.has(e.id) || isEmployeeActive(e, today));
}

/**
 * 「查歷史」下拉的候選：在職者＋在 [from, to] 期間仍在職的離職者（離職日 ≥ from，且到職日 ≤ to 或沒填）。
 * 沒有離職日的停用帳號無法判斷何時離開 → 一律列出（呼叫端用 employeeStatusNote 標「已停用」），避免舊資料選不到。
 * from/to 為 YYYY-MM-DD；from 為空＝不限（離職者全列）。
 */
export function employedInPeriod<T extends EmployeeStatusFields>(
  employees: readonly T[],
  from: string | null | undefined,
  to: string | null | undefined,
  keepIds: Iterable<string | null | undefined> = [],
  today: string = todayTaipei(),
): T[] {
  const keep = keepSet(keepIds);
  const f = day(from);
  const t = day(to);
  return employees.filter((e) => {
    if (keep.has(e.id) || isEmployeeActive(e, today)) return true;
    const term = day(e.terminated_at);
    if (!f) return true;
    if (!term) return true;
    if (term < f) return false;
    const hire = day(e.hire_date);
    return !t || !hire || hire <= t;
  });
}

/** 月份（YYYY-MM）→ [當月 1 日, 當月最後一天]；格式不對回 [null, null]。 */
export function monthRange(month: string | null | undefined): [string | null, string | null] {
  const m = /^(\d{4})-(\d{2})/.exec(month ?? "");
  if (!m) return [null, null];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return [`${m[1]}-${m[2]}-01`, `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`];
}

/* ────────── 員工管理頁列表：狀態篩選＋搜尋 ────────── */

export type EmploymentStatusFilter = "active" | "terminated" | "all";

export const EMPLOYMENT_STATUS_FILTERS: ReadonlyArray<{ value: EmploymentStatusFilter; label: string }> = [
  { value: "active", label: "在職" },
  { value: "terminated", label: "已離職" },
  { value: "all", label: "全部" },
];

/** URL query（?status=）→ 篩選值；不認得或沒有＝在職。 */
export function parseStatusFilter(value: string | null | undefined): EmploymentStatusFilter {
  return value === "terminated" || value === "all" ? value : "active";
}

/** 依在職狀態篩選。 */
export function filterByEmploymentStatus<T extends EmployeeStatusFields>(
  rows: readonly T[],
  filter: EmploymentStatusFilter,
  today: string = todayTaipei(),
): T[] {
  if (filter === "all") return [...rows];
  const wantActive = filter === "active";
  return rows.filter((row) => isEmployeeActive(row, today) === wantActive);
}

/** 離職人數（開關上的 N）。 */
export function countTerminated(rows: readonly EmployeeStatusFields[], today: string = todayTaipei()): number {
  return rows.filter((row) => !isEmployeeActive(row, today)).length;
}

/** 列表搜尋：姓名、工號、Email；不分大小寫，空白分隔的多個字都要命中。空字串＝不篩。 */
export function searchEmployees<T extends { name?: string | null; emp_no?: string | null; email?: string | null }>(
  rows: readonly T[],
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...rows];
  return rows.filter((row) => {
    const hay = `${row.name ?? ""} ${row.emp_no ?? ""} ${row.email ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/**
 * 批次給假（請假餘額頁「全員批次給假」，2026-11-17 業主決定）：只套用在職員工。
 * 以套用的期間 [from, to]（留白＝該年度 1/1～12/31）判斷：今天在職者照套；
 * 已離職者只有在離職日 ≥ from（該期間仍在職）時才套；沒有離職日的停用帳號一律略過。
 * 回傳要套用的名單與略過的名單（結果訊息顯示略過人數）。
 */
export function batchGrantTargets<T extends EmployeeStatusFields>(
  employees: readonly T[],
  from: string,
  to: string,
  today: string = todayTaipei(),
): { targets: T[]; skipped: T[] } {
  const f = day(from);
  const t = day(to);
  const targets: T[] = [];
  const skipped: T[] = [];
  for (const e of employees) {
    let ok = isEmployeeActive(e, today);
    if (!ok) {
      const term = day(e.terminated_at);
      const hire = day(e.hire_date);
      ok = !!term && !!f && term >= f && (!t || !hire || hire <= t);
    }
    (ok ? targets : skipped).push(e);
  }
  return { targets, skipped };
}
