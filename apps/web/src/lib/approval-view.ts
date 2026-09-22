/**
 * `/admin/approvals?status=…` 簽核合併頁（原「待審核表單」＋「表單紀錄管理」）的純函式：
 * URL status 解析、取資料的 status 參數、簽核者解析與分桶、依 view 篩列、client 端篩選、
 * 統計方塊、CSV 矩陣、各桶可用操作。無 React、無 DOM；vitest 在 `__tests__/approval-view.test.ts`。
 *
 * 狀態機（URL 是唯一真相）：
 *   pending（預設）／in_progress → 都抓 `status=pending` 同一份，再用 `bucketOf` 切桶：
 *     pending_mine ＝ 目前關卡的候選簽核人含我（或解析不到簽核者）；in_progress ＝ 候選都是別人。
 *   approved／rejected → 各抓自己的 status；all → 不帶 status（含 cancelled）。
 * 候選簽核人解析（`currentCandidateIds`；多級簽核起同一關可有多位候選，任一人簽即過）：
 *   `row.current_candidate_emp_ids`（有值）→ `[row.current_approver_emp_id]` →
 *   固定名單模式的 `flowByKind.get(row.kind)?.[row.current_step-1]` → `fallbackHrId` → `[]`。
 *   名單退路只在 `mode === "list"` 才建（`flowByKindOf`）：manager／manager_hr 模式的簽核者由後端依部門主管鏈算，
 *   名單對它們沒有意義，拿來當退路會把別人的單誤判成「待我簽」。
 */
import type { ApprovalFlow, Department, Employee, LeaveRequest, RequestKind, RequestStatus } from "./admin-api";
import { localDateKey, fmtHm } from "./ess-format";

/** ISO → 當地 `YYYY-MM-DD HH:mm`（CSV 用；原本直接切 ISO 字串會變成 UTC，與畫面差 8 小時）。 */
function csvLocalDateTime(iso: string): string {
  const day = localDateKey(iso);
  return day ? `${day} ${fmtHm(iso)}` : iso;
}

/* ------------------------------------------------------------- view ----- */

export type ApprovalView = "pending" | "in_progress" | "approved" | "rejected" | "all";

export const APPROVAL_VIEWS: readonly ApprovalView[] = ["pending", "in_progress", "approved", "rejected", "all"];

export const APPROVAL_VIEW_LABEL: Record<ApprovalView, string> = {
  pending: "待簽核",
  in_progress: "簽核中",
  approved: "已核准",
  rejected: "已駁回",
  all: "全部",
};

/** `?status=` 的值 → view；空／未知一律視同 pending。 */
export function parseApprovalView(raw: string | null | undefined): ApprovalView {
  return raw && (APPROVAL_VIEWS as readonly string[]).includes(raw) ? (raw as ApprovalView) : "pending";
}

/** 該 view 打 `GET /requests` 要帶的 status；`undefined`＝不帶（all）。 */
export function statusParamFor(view: ApprovalView): RequestStatus | undefined {
  switch (view) {
    case "pending":
    case "in_progress":
      return "pending";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "all":
      return undefined;
  }
}

/** 有批次列（簽核意見＋批次核准／駁回、可勾選）的 view。 */
export function hasBatchRow(view: ApprovalView): boolean {
  return view === "pending" || view === "in_progress";
}

/* ---------------------------------------------------------- labels ----- */

export const KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  ot: "加班",
  fix_punch: "補卡",
  business_trip: "公出/出差",
  petty_cash: "零用金預支",
  wfh: "在家工作",
};

export const KIND_OPTIONS: ReadonlyArray<{ value: RequestKind; label: string }> = [
  { value: "leave", label: "請假" },
  { value: "ot", label: "加班" },
  { value: "fix_punch", label: "補卡" },
  { value: "business_trip", label: "公出/出差" },
  { value: "petty_cash", label: "零用金預支" },
  { value: "wfh", label: "在家工作" },
];

/** 「工號 · 姓名」；沒有工號只顯示姓名。 */
export function employeeLabel(employee: Pick<Employee, "name" | "emp_no">): string {
  return employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name;
}

/* ------------------------------------------------ approver & bucket ----- */

/** kind → 依序簽核者 id 清單（approval_flows.applies_to 含 petty_cash，key 放寬成 string）。 */
export type FlowByKind = ReadonlyMap<string, readonly string[]>;

/** 只有固定名單模式（`mode === "list"`）的流程才進表；manager／manager_hr 的名單不當退路。 */
export function flowByKindOf(flows: readonly ApprovalFlow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const flow of flows) {
    if (flow.mode !== "list") continue;
    map.set(flow.applies_to, flow.approver_emp_ids ?? []);
  }
  return map;
}

/** 找不到簽核者時的退路：第一位 HR／平台管理員（原 form-records 規則）。 */
export function fallbackHrIdOf(employees: readonly Employee[]): string | null {
  return employees.find((e) => e.role === "hr_admin" || e.role === "platform_admin")?.id ?? null;
}

/** `currentCandidateIds`／`resolveApproverId` 只看這幾欄（測試可以只給部分列）。 */
export type ApproverRow = Pick<
  LeaveRequest,
  "kind" | "current_step" | "current_approver_emp_id" | "current_candidate_emp_ids" | "current_approver_names" | "current_step_kind"
>;

/**
 * 目前關卡的候選簽核人（任一人簽即過）：
 *   ① `current_candidate_emp_ids` 有值就用它（去掉空字串）；
 *   ② 沒有 → `[current_approver_emp_id]`；
 *   ③ 再沒有 → 固定名單模式的流程表第 current_step-1 位 → fallbackHrId；
 *   都沒有 → `[]`（畫面顯示「依後端簽核鏈」、分桶視同待我簽）。
 */
export function currentCandidateIds(row: ApproverRow, flowByKind: FlowByKind, fallbackHrId: string | null | undefined): string[] {
  const candidates = (row.current_candidate_emp_ids ?? []).filter((id) => typeof id === "string" && id.length > 0);
  if (candidates.length > 0) return candidates;
  const legacy = row.current_approver_emp_id ?? flowByKind.get(row.kind)?.[row.current_step - 1] ?? fallbackHrId ?? null;
  return legacy ? [legacy] : [];
}

/** 第一位候選（＝後端的 `current_approver_emp_id`）；變更簽核人下拉的預設值用。找不到 → null。 */
export function resolveApproverId(row: ApproverRow, flowByKind: FlowByKind, fallbackHrId: string | null | undefined): string | null {
  return currentCandidateIds(row, flowByKind, fallbackHrId)[0] ?? null;
}

export type ApprovalBucket = "pending_mine" | "in_progress" | "approved" | "rejected" | "cancelled";

export interface BucketContext {
  /** 登入者的 employee id；尚未取得時 null（只有解析不到簽核者的單會落到 pending_mine）。 */
  meId: string | null;
  flowByKind: FlowByKind;
  fallbackHrId: string | null;
}

export function bucketOf(row: LeaveRequest, ctx: BucketContext): ApprovalBucket {
  switch (row.status) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    default: {
      const candidates = currentCandidateIds(row, ctx.flowByKind, ctx.fallbackHrId);
      if (candidates.length === 0) return "pending_mine";
      return ctx.meId !== null && candidates.includes(ctx.meId) ? "pending_mine" : "in_progress";
    }
  }
}

export const BUCKET_LABEL: Record<ApprovalBucket, string> = {
  pending_mine: "待簽核",
  in_progress: "簽核中",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已取消",
};

/** 依 view 從伺服器回來的列裡挑出要顯示的（pending／in_progress 同一份資料切桶）。 */
export function rowsForView(rows: readonly LeaveRequest[], view: ApprovalView, ctx: BucketContext): LeaveRequest[] {
  switch (view) {
    case "pending":
      return rows.filter((row) => bucketOf(row, ctx) === "pending_mine");
    case "in_progress":
      return rows.filter((row) => bucketOf(row, ctx) === "in_progress");
    case "approved":
      return rows.filter((row) => row.status === "approved");
    case "rejected":
      return rows.filter((row) => row.status === "rejected");
    case "all":
      return [...rows];
  }
}

/** Segmented 標籤要的兩個計數（N＋M＝首頁「待簽核」卡數字）。 */
export function pendingCounts(rows: readonly LeaveRequest[], ctx: BucketContext): { pending_mine: number; in_progress: number } {
  let mine = 0;
  let others = 0;
  for (const row of rows) {
    if (row.status !== "pending") continue;
    if (bucketOf(row, ctx) === "pending_mine") mine += 1;
    else others += 1;
  }
  return { pending_mine: mine, in_progress: others };
}

/** Segmented 的五個選項：「待簽核 N｜簽核中 M｜已核准｜已駁回｜全部」。 */
export function viewOptions(counts: { pending_mine: number; in_progress: number }): { value: ApprovalView; label: string }[] {
  return APPROVAL_VIEWS.map((view) => ({
    value: view,
    label:
      view === "pending"
        ? `${APPROVAL_VIEW_LABEL.pending} ${counts.pending_mine}`
        : view === "in_progress"
          ? `${APPROVAL_VIEW_LABEL.in_progress} ${counts.in_progress}`
          : APPROVAL_VIEW_LABEL[view],
  }));
}

/* ---------------------------------------------------------- lookup ----- */

/** 表格／CSV／關鍵字篩選都要的查表；由 `buildApprovalLookup` 從員工、單位、簽核流程算出。 */
export interface ApprovalLookup {
  flowByKind: FlowByKind;
  fallbackHrId: string | null;
  /** 可被指定為簽核者的人（在職）。 */
  approverCandidates: Employee[];
  /** 員工的單位 id；找不到員工 → undefined。 */
  deptIdOf(employeeId: string): string | null | undefined;
  /** 「工號 · 姓名」；找不到員工 → undefined。 */
  employeeName(employeeId: string): string | undefined;
  /** 單位名；沒單位 →「—」、單位查不到 →「未命名單位」、找不到員工 → undefined。 */
  employeeDept(employeeId: string): string | undefined;
  /** 「第 N 關 · 簽核者」（多位候選用「／」串、HR 覆核關加註）／「第 N 關 · 依後端簽核鏈」；非 pending →「—」。 */
  approverLabel(row: LeaveRequest): string;
}

/** 多位候選姓名的連接符（與後端 `current_approver_name` 相同）。 */
export const CANDIDATE_JOINER = "／";

/**
 * 「目前簽核人」欄：
 *   有 `current_approver_names` → 「第 N 關 · 王小明／李小華」（後端已算好姓名，不必查員工表）；
 *   否則用候選 id 查員工表（查得到的才列，多人一樣用「／」串）；一個都查不到 → 「第 N 關 · 依後端簽核鏈」。
 *   `current_step_kind === "hr"`（manager_hr 模式最後一關）再加註「（HR 覆核）」，與 ESS 我的申請一致。
 */
export function currentApproverLabel(
  row: LeaveRequest,
  employeeName: (employeeId: string) => string | undefined,
  flowByKind: FlowByKind,
  fallbackHrId: string | null,
): string {
  if (row.status !== "pending") return "—";
  const fromApi = (row.current_approver_names ?? []).map((name) => name.trim()).filter(Boolean);
  const names =
    fromApi.length > 0
      ? fromApi
      : currentCandidateIds(row, flowByKind, fallbackHrId)
          .map((id) => employeeName(id))
          .filter((name): name is string => Boolean(name));
  if (names.length === 0) return `第 ${row.current_step} 關 · 依後端簽核鏈`;
  const hrSuffix = row.current_step_kind === "hr" ? "（HR 覆核）" : "";
  return `第 ${row.current_step} 關 · ${names.join(CANDIDATE_JOINER)}${hrSuffix}`;
}

export function buildApprovalLookup(
  employees: readonly Employee[],
  departments: readonly Department[],
  flows: readonly ApprovalFlow[],
): ApprovalLookup {
  const employeeById = new Map<string, Employee>();
  for (const employee of employees) employeeById.set(employee.id, employee);
  const deptName = new Map<string, string>();
  for (const department of departments) deptName.set(department.id, department.name);
  const flowByKind = flowByKindOf(flows);
  const fallbackHrId = fallbackHrIdOf(employees);

  const employeeName = (employeeId: string) => {
    const employee = employeeById.get(employeeId);
    return employee ? employeeLabel(employee) : undefined;
  };
  const employeeDept = (employeeId: string) => {
    const employee = employeeById.get(employeeId);
    if (!employee) return undefined;
    return employee.dept_id ? (deptName.get(employee.dept_id) ?? "未命名單位") : "—";
  };

  return {
    flowByKind,
    fallbackHrId,
    approverCandidates: employees.filter((employee) => employee.status === "active"),
    deptIdOf: (employeeId) => employeeById.get(employeeId)?.dept_id,
    employeeName,
    employeeDept,
    approverLabel: (row) => currentApproverLabel(row, employeeName, flowByKind, fallbackHrId),
  };
}

/* --------------------------------------------------- client filters ----- */

export interface ClientFilters {
  /** 單位 id；空字串／undefined＝不限。 */
  deptId?: string;
  /** 關鍵字：比對姓名、employee_id、單位、原因／備註／地點／代理人、目前簽核人（不分大小寫）。 */
  keyword?: string;
}

export function applyClientFilters(
  rows: readonly LeaveRequest[],
  filters: ClientFilters,
  lookup: Pick<ApprovalLookup, "deptIdOf" | "employeeName" | "employeeDept" | "approverLabel">,
): LeaveRequest[] {
  const term = (filters.keyword ?? "").trim().toLowerCase();
  const deptId = filters.deptId ?? "";
  return rows.filter((row) => {
    if (deptId && lookup.deptIdOf(row.employee_id) !== deptId) return false;
    if (!term) return true;
    const name = lookup.employeeName(row.employee_id) ?? "";
    const department = lookup.employeeDept(row.employee_id) ?? "";
    const content = [row.reason, row.remark, row.location, row.agent_name, lookup.approverLabel(row)]
      .filter(Boolean)
      .join(" ");
    return (
      name.toLowerCase().includes(term) ||
      row.employee_id.toLowerCase().includes(term) ||
      department.toLowerCase().includes(term) ||
      content.toLowerCase().includes(term)
    );
  });
}

/* ----------------------------------------------------------- stats ----- */

export interface ApprovalStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}

/** 「全部」view 的四個統計方塊（總數／簽核中／已核准／已駁回；原 form-records 規則）。 */
export function statsOf(rows: readonly LeaveRequest[]): ApprovalStats {
  const stats: ApprovalStats = { total: rows.length, pending: 0, approved: 0, rejected: 0 };
  for (const row of rows) {
    if (row.status === "pending") stats.pending += 1;
    else if (row.status === "approved") stats.approved += 1;
    else if (row.status === "rejected") stats.rejected += 1;
  }
  return stats;
}

/* ------------------------------------------------------------- CSV ----- */

export const CSV_HEADER: readonly string[] = [
  "申請日期",
  "單位",
  "申請人",
  "表單類型",
  "起日",
  "迄日",
  "時數",
  "地點/代理/給付",
  "原因",
  "目前簽核人",
  "關卡",
  "狀態",
];

/** 表頭＋每列 12 欄（全部字串）；狀態欄 pending 依桶顯示待簽核／簽核中。 */
export function csvMatrix(
  rows: readonly LeaveRequest[],
  lookup: Pick<ApprovalLookup, "employeeName" | "employeeDept" | "approverLabel">,
  ctx: BucketContext,
): string[][] {
  const body = rows.map((row) => [
    localDateKey(row.created_at) || row.created_at.slice(0, 10),
    lookup.employeeDept(row.employee_id) ?? "—",
    lookup.employeeName(row.employee_id) ?? row.employee_id,
    KIND_LABEL[row.kind],
    csvLocalDateTime(row.start_at),
    csvLocalDateTime(row.end_at),
    row.hours != null ? String(row.hours) : "",
    [row.location, row.agent_name, row.payout].filter(Boolean).join(" / "),
    row.reason ?? row.remark ?? "",
    lookup.approverLabel(row),
    `第 ${row.current_step} 關`,
    BUCKET_LABEL[bucketOf(row, ctx)],
  ]);
  return [[...CSV_HEADER], ...body];
}

/** 矩陣 → CSV 文字：每格雙引號包起（內部 `"` 變 `""`）、逗號分隔、`\n` 換列，開頭帶 BOM 讓 Excel 認 UTF-8。 */
export function csvText(matrix: readonly (readonly string[])[]): string {
  const lines = matrix.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","));
  return `\uFEFF${lines.join("\n")}`;
}

export function csvFileName(now: Date = new Date()): string {
  return `approvals-${now.toISOString().slice(0, 10)}.csv`;
}

/* --------------------------------------------------------- actions ----- */

export type RowAction = "approve" | "reject" | "change_approver" | "remind" | "proxy_approve" | "delete" | "attachments";

export interface RowActionSpec {
  key: RowAction;
  /** 顯示但不能按（已核准的單「註銷」）。 */
  disabled?: boolean;
}

/** 各桶列上的操作（順序即畫面順序）。 */
export function actionsFor(bucket: ApprovalBucket): RowActionSpec[] {
  switch (bucket) {
    case "pending_mine":
      return [{ key: "approve" }, { key: "reject" }, { key: "change_approver" }, { key: "delete" }, { key: "attachments" }];
    case "in_progress":
      return [{ key: "remind" }, { key: "proxy_approve" }, { key: "change_approver" }, { key: "delete" }, { key: "attachments" }];
    case "approved":
      return [{ key: "delete", disabled: true }, { key: "attachments" }];
    case "rejected":
    case "cancelled":
      return [{ key: "delete" }, { key: "attachments" }];
  }
}

/* --------------------------------------------------------- content ----- */

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 「內容」欄（原 approvals `contentLines`）：第一行期間＋時數，之後原因／地點／代理人／類型／給付。 */
export function contentLines(row: LeaveRequest): string[] {
  const period = `${fmtDateTime(row.start_at)} → ${fmtDateTime(row.end_at)}`;
  const lines = [row.hours != null ? `${period}（${row.hours} 小時）` : period];
  const main = row.reason || row.remark;
  if (main) lines.push(main);
  if (row.location) lines.push(`地點：${row.location}`);
  if (row.agent_name) lines.push(`代理人：${row.agent_name}`);
  if (row.trip_type) lines.push(`類型：${row.trip_type === "outing" ? "公出" : "出差"}`);
  if (row.payout) lines.push(`加班給付：${row.payout === "pay" ? "加班費" : "補休"}`);
  return lines;
}
