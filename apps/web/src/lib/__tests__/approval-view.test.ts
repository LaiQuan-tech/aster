import { describe, it, expect } from "vitest";
import type { ApprovalFlow, Department, Employee, LeaveRequest } from "../admin-api";
import { fmtHm, localDateKey } from "../ess-format";
import {
  APPROVAL_VIEWS,
  CSV_HEADER,
  KIND_LABEL,
  KIND_OPTIONS,
  actionsFor,
  applyClientFilters,
  bucketOf,
  buildApprovalLookup,
  contentLines,
  csvFileName,
  csvMatrix,
  csvText,
  currentApproverLabel,
  currentCandidateIds,
  fallbackHrIdOf,
  flowByKindOf,
  hasBatchRow,
  parseApprovalView,
  pendingCounts,
  resolveApproverId,
  rowsForView,
  statsOf,
  statusParamFor,
  viewOptions,
  type BucketContext,
} from "../approval-view";

/* ------------------------------------------------------------ fixtures --- */

const ME = "me000000-0000-0000-0000-000000000000";
const BOSS = "boss0000-0000-0000-0000-000000000000";
const HR2 = "hr200000-0000-0000-0000-000000000000";
const AMY = "amy00000-0000-0000-0000-000000000000";
const BOB = "bob00000-0000-0000-0000-000000000000";

function employee(partial: Partial<Employee> & Pick<Employee, "id" | "name">): Employee {
  return {
    tenant_id: "t",
    user_id: `u-${partial.id}`,
    role: "employee",
    dept_id: null,
    emp_no: null,
    employment_type: "regular",
    hire_date: null,
    terminated_at: null,
    status: "active",
    created_at: "2026-01-01T00:00:00+00:00",
    email: null,
    ...partial,
  };
}

const EMPLOYEES: Employee[] = [
  employee({ id: ME, name: "Kimi", role: "hr_admin", emp_no: "A001" }),
  employee({ id: HR2, name: "二號HR", role: "hr_admin", emp_no: "A002", status: "inactive" }),
  employee({ id: BOSS, name: "老闆", role: "employee", emp_no: "B001", dept_id: "d-mgmt" }),
  employee({ id: AMY, name: "王小美", emp_no: "E010", dept_id: "d-eng" }),
  employee({ id: BOB, name: "陳大寶", dept_id: "d-ghost" }),
];

const DEPARTMENTS: Department[] = [
  {
    id: "d-mgmt",
    tenant_id: "t",
    parent_id: null,
    code: "M",
    name: "管理部",
    manager_emp_id: BOSS,
    manager_name: "老闆",
    manager_emp_no: "B001",
    manager_label: "B001 · 老闆",
    manager_emp_ids: [BOSS],
    managers: [{ id: BOSS, name: "老闆", emp_no: "B001", label: "B001 · 老闆" }],
    created_at: "2026-01-01T00:00:00+00:00",
  },
  {
    id: "d-eng",
    tenant_id: "t",
    parent_id: null,
    code: "E",
    name: "工程部",
    manager_emp_id: null,
    manager_name: null,
    manager_emp_no: null,
    manager_label: null,
    manager_emp_ids: [],
    managers: [],
    created_at: "2026-01-01T00:00:00+00:00",
  },
];

const FLOWS: ApprovalFlow[] = [
  { id: "f1", tenant_id: "t", applies_to: "leave", approver_emp_ids: [BOSS, ME], mode: "list", created_at: "" },
  { id: "f2", tenant_id: "t", applies_to: "ot", approver_emp_ids: [], mode: "manager", created_at: "" },
  // manager_hr：名單裡雖然留著 ME（切模式前勾的），但這個模式的簽核者由後端依部門主管鏈算，名單不能當退路
  { id: "f3", tenant_id: "t", applies_to: "fix_punch", approver_emp_ids: [ME], mode: "manager_hr", created_at: "" },
];

let seq = 0;
function request(partial: Partial<LeaveRequest>): LeaveRequest {
  seq += 1;
  return {
    id: `r${seq}`,
    tenant_id: "t",
    employee_id: AMY,
    kind: "leave",
    leave_type_id: null,
    start_at: "2026-09-18T01:00:00+00:00",
    end_at: "2026-09-18T10:00:00+00:00",
    hours: 8,
    reason: null,
    agent_name: null,
    payout: null,
    trip_type: null,
    location: null,
    remark: null,
    segments: null,
    status: "pending",
    current_step: 1,
    current_approver_emp_id: null,
    created_at: "2026-09-17T08:30:00+00:00",
    ...partial,
  };
}

const LOOKUP = buildApprovalLookup(EMPLOYEES, DEPARTMENTS, FLOWS);
const CTX: BucketContext = { meId: ME, flowByKind: LOOKUP.flowByKind, fallbackHrId: LOOKUP.fallbackHrId };

/** 五桶各一張＋一張明確指給我的。 */
const MINE_EXPLICIT = request({ current_approver_emp_id: ME, kind: "fix_punch", reason: "忘記打卡", employee_id: AMY });
const MINE_BY_FLOW = request({ kind: "leave", current_step: 2, reason: "家中有事", employee_id: BOB });
const OTHERS_EXPLICIT = request({ current_approver_emp_id: BOSS, kind: "fix_punch", employee_id: AMY, reason: "補打下班卡" });
const OTHERS_BY_FLOW = request({ kind: "leave", current_step: 1, employee_id: AMY, agent_name: "代理人阿花" });
const MINE_FALLBACK = request({ kind: "ot", employee_id: BOSS, payout: "pay", location: "台中廠" });
const APPROVED = request({ status: "approved", kind: "business_trip", trip_type: "outing", location: "客戶端", employee_id: BOSS });
const REJECTED = request({ status: "rejected", employee_id: AMY, reason: "重複申請" });
const CANCELLED = request({ status: "cancelled", employee_id: BOB });
const ALL_ROWS = [MINE_EXPLICIT, MINE_BY_FLOW, OTHERS_EXPLICIT, OTHERS_BY_FLOW, MINE_FALLBACK, APPROVED, REJECTED, CANCELLED];
const PENDING_ROWS = ALL_ROWS.filter((r) => r.status === "pending");

/* ---------------------------------------------------------------- view --- */

describe("KIND_LABEL／KIND_OPTIONS 涵蓋六種表單（零用金預支曾漏掉→後台類型欄空白；2026-09-23 加在家工作）", () => {
  it("六種 kind 都有中文標籤，且篩選選項一致", () => {
    const kinds = ["leave", "ot", "fix_punch", "business_trip", "petty_cash", "wfh"] as const;
    for (const k of kinds) expect(KIND_LABEL[k]).toBeTruthy();
    expect(KIND_LABEL.petty_cash).toBe("零用金預支");
    expect(KIND_LABEL.wfh).toBe("在家工作");
    expect(KIND_OPTIONS.map((o) => o.value)).toEqual([...kinds]);
  });
});

describe("parseApprovalView／statusParamFor", () => {
  it("五個合法值原樣回；空／null／未知一律 pending", () => {
    for (const view of APPROVAL_VIEWS) expect(parseApprovalView(view)).toBe(view);
    expect(parseApprovalView(null)).toBe("pending");
    expect(parseApprovalView(undefined)).toBe("pending");
    expect(parseApprovalView("")).toBe("pending");
    expect(parseApprovalView("cancelled")).toBe("pending");
    expect(parseApprovalView("PENDING")).toBe("pending");
  });

  it("pending／in_progress 都抓 pending；approved／rejected 各抓自己；all 不帶", () => {
    expect(statusParamFor("pending")).toBe("pending");
    expect(statusParamFor("in_progress")).toBe("pending");
    expect(statusParamFor("approved")).toBe("approved");
    expect(statusParamFor("rejected")).toBe("rejected");
    expect(statusParamFor("all")).toBeUndefined();
  });

  it("批次列只在 pending／in_progress", () => {
    expect(APPROVAL_VIEWS.filter(hasBatchRow)).toEqual(["pending", "in_progress"]);
  });

  it("viewOptions 五個、順序固定、前兩個帶計數", () => {
    const options = viewOptions({ pending_mine: 3, in_progress: 12 });
    expect(options.map((o) => o.value)).toEqual(["pending", "in_progress", "approved", "rejected", "all"]);
    expect(options.map((o) => o.label)).toEqual(["待簽核 3", "簽核中 12", "已核准", "已駁回", "全部"]);
  });
});

/* ------------------------------------------------------------ approver --- */

describe("resolveApproverId 三段退路", () => {
  const flowByKind = flowByKindOf(FLOWS);

  it("① 列上有 current_approver_emp_id 就用它（即使流程表有別人）", () => {
    expect(resolveApproverId({ kind: "leave", current_step: 1, current_approver_emp_id: AMY }, flowByKind, HR2)).toBe(AMY);
  });

  it("② 沒有就看該 kind 流程表第 current_step-1 位", () => {
    expect(resolveApproverId({ kind: "leave", current_step: 1, current_approver_emp_id: null }, flowByKind, HR2)).toBe(BOSS);
    expect(resolveApproverId({ kind: "leave", current_step: 2, current_approver_emp_id: null }, flowByKind, HR2)).toBe(ME);
  });

  it("③ 流程表沒有這個 kind／名單為空／關卡超出 → fallbackHrId；連 fallback 都沒有 → null", () => {
    expect(resolveApproverId({ kind: "ot", current_step: 1, current_approver_emp_id: null }, flowByKind, HR2)).toBe(HR2);
    expect(resolveApproverId({ kind: "fix_punch", current_step: 1, current_approver_emp_id: null }, flowByKind, HR2)).toBe(HR2);
    expect(resolveApproverId({ kind: "leave", current_step: 3, current_approver_emp_id: null }, flowByKind, HR2)).toBe(HR2);
    expect(resolveApproverId({ kind: "fix_punch", current_step: 1, current_approver_emp_id: null }, flowByKind, null)).toBeNull();
    expect(resolveApproverId({ kind: "fix_punch", current_step: 1, current_approver_emp_id: null }, new Map(), undefined)).toBeNull();
  });

  it("fallbackHrIdOf 取第一位 hr_admin／platform_admin；沒有 → null", () => {
    expect(fallbackHrIdOf(EMPLOYEES)).toBe(ME);
    expect(fallbackHrIdOf([employee({ id: "p", name: "平台", role: "platform_admin" })])).toBe("p");
    expect(fallbackHrIdOf([employee({ id: "e", name: "員工" })])).toBeNull();
  });

  it("currentApproverLabel：pending 顯示關卡＋姓名、查不到姓名顯示「依後端簽核鏈」、非 pending 顯示「—」", () => {
    expect(LOOKUP.approverLabel(MINE_EXPLICIT)).toBe("第 1 關 · A001 · Kimi");
    expect(LOOKUP.approverLabel(OTHERS_BY_FLOW)).toBe("第 1 關 · B001 · 老闆");
    expect(LOOKUP.approverLabel(MINE_BY_FLOW)).toBe("第 2 關 · A001 · Kimi");
    const unknownApprover = request({ current_approver_emp_id: "nobody", current_step: 3 });
    expect(currentApproverLabel(unknownApprover, LOOKUP.employeeName, LOOKUP.flowByKind, LOOKUP.fallbackHrId)).toBe(
      "第 3 關 · 依後端簽核鏈",
    );
    expect(LOOKUP.approverLabel(APPROVED)).toBe("—");
    expect(LOOKUP.approverLabel(REJECTED)).toBe("—");
  });
});

/* ----------------------------------------------- 多級簽核：候選簽核人 --- */

describe("currentCandidateIds／bucketOf：同一關多位候選（manager_hr 的 HR 覆核關）", () => {
  const flowByKind = flowByKindOf(FLOWS);
  /** 第 3 關 HR 覆核：候選 ME＋HR2，後端相容欄位 current_approver_emp_id＝第一位 */
  const HR_STEP = request({
    kind: "fix_punch",
    current_step: 3,
    current_approver_emp_id: HR2,
    current_candidate_emp_ids: [HR2, ME],
    current_approver_names: ["二號HR", "Kimi"],
    current_step_kind: "hr",
    employee_id: AMY,
  });

  it("候選含我 → pending_mine（即使 current_approver_emp_id 是別人）", () => {
    expect(currentCandidateIds(HR_STEP, flowByKind, null)).toEqual([HR2, ME]);
    expect(resolveApproverId(HR_STEP, flowByKind, null)).toBe(HR2);
    expect(bucketOf(HR_STEP, CTX)).toBe("pending_mine");
  });

  it("候選不含我 → in_progress；me 尚未載入時也是 in_progress", () => {
    const others = request({ ...HR_STEP, current_candidate_emp_ids: [HR2, BOSS], current_approver_emp_id: HR2 });
    expect(bucketOf(others, CTX)).toBe("in_progress");
    expect(bucketOf(HR_STEP, { ...CTX, meId: null })).toBe("in_progress");
  });

  it("沒有候選欄位（舊 API／空陣列）→ 退回 current_approver_emp_id → 名單 → fallback 三段邏輯", () => {
    expect(currentCandidateIds(request({ current_approver_emp_id: BOSS, current_candidate_emp_ids: [] }), flowByKind, HR2)).toEqual([BOSS]);
    expect(currentCandidateIds(request({ kind: "leave", current_step: 2 }), flowByKind, HR2)).toEqual([ME]);
    expect(currentCandidateIds(request({ kind: "ot" }), flowByKind, HR2)).toEqual([HR2]);
    expect(currentCandidateIds(request({ kind: "ot" }), flowByKind, null)).toEqual([]);
    expect(bucketOf(request({ kind: "ot" }), { ...CTX, flowByKind, fallbackHrId: null })).toBe("pending_mine");
  });

  it("manager_hr（與 manager）模式的名單不當退路：flowByKindOf 只收 list 模式", () => {
    expect([...flowByKind.keys()]).toEqual(["leave"]);
    // fix_punch 是 manager_hr、名單有 ME：沒有候選欄位時不能因為名單就判成待我簽
    const noCandidate = request({ kind: "fix_punch", current_step: 1, employee_id: AMY });
    expect(currentCandidateIds(noCandidate, flowByKind, BOSS)).toEqual([BOSS]);
    expect(bucketOf(noCandidate, { ...CTX, flowByKind, fallbackHrId: BOSS })).toBe("in_progress");
    // 舊行為對照：若把 manager_hr 的名單也收進表，同一張單會被誤判成待我簽
    const legacyMap = new Map<string, string[]>([["fix_punch", [ME]]]);
    expect(bucketOf(noCandidate, { ...CTX, flowByKind: legacyMap, fallbackHrId: BOSS })).toBe("pending_mine");
  });

  it("多人標籤：有 current_approver_names 直接串「／」、HR 覆核關加註；只有候選 id 時查員工表", () => {
    expect(LOOKUP.approverLabel(HR_STEP)).toBe("第 3 關 · 二號HR／Kimi（HR 覆核）");
    const managerStep = request({ ...HR_STEP, current_step: 1, current_step_kind: "manager", current_approver_names: ["老闆"] });
    expect(LOOKUP.approverLabel(managerStep)).toBe("第 1 關 · 老闆");
    const idsOnly = request({ ...HR_STEP, current_approver_names: undefined });
    expect(LOOKUP.approverLabel(idsOnly)).toBe("第 3 關 · A002 · 二號HR／A001 · Kimi（HR 覆核）");
    const unknownIds = request({ ...HR_STEP, current_approver_names: [], current_candidate_emp_ids: ["nobody", "ghost"] });
    expect(LOOKUP.approverLabel(unknownIds)).toBe("第 3 關 · 依後端簽核鏈");
    expect(LOOKUP.approverLabel({ ...HR_STEP, status: "approved" })).toBe("—");
  });

  it("CSV 的「目前簽核人」與「狀態」欄跟著候選走", () => {
    const [, cells] = csvMatrix([HR_STEP], LOOKUP, CTX);
    expect(cells[9]).toBe("第 3 關 · 二號HR／Kimi（HR 覆核）");
    expect(cells[10]).toBe("第 3 關");
    expect(cells[11]).toBe("待簽核");
    const [, othersCells] = csvMatrix([request({ ...HR_STEP, current_candidate_emp_ids: [HR2, BOSS] })], LOOKUP, CTX);
    expect(othersCells[11]).toBe("簽核中");
  });

  it("pendingCounts／rowsForView 用候選分桶：候選含我算待簽核", () => {
    const rows = [HR_STEP, request({ ...HR_STEP, current_candidate_emp_ids: [HR2, BOSS] })];
    expect(pendingCounts(rows, CTX)).toEqual({ pending_mine: 1, in_progress: 1 });
    expect(rowsForView(rows, "pending", CTX).map((r) => r.id)).toEqual([HR_STEP.id]);
  });
});

/* -------------------------------------------------------------- bucket --- */

describe("bucketOf 五桶", () => {
  it("pending：簽核者是我（明確指定／流程表／fallback HR）→ pending_mine；是別人 → in_progress", () => {
    expect(bucketOf(MINE_EXPLICIT, CTX)).toBe("pending_mine");
    expect(bucketOf(MINE_BY_FLOW, CTX)).toBe("pending_mine");
    expect(bucketOf(MINE_FALLBACK, CTX)).toBe("pending_mine");
    expect(bucketOf(OTHERS_EXPLICIT, CTX)).toBe("in_progress");
    expect(bucketOf(OTHERS_BY_FLOW, CTX)).toBe("in_progress");
  });

  it("解析不到簽核者（null）也算 pending_mine；me 尚未載入時只有 null 簽核者落到 pending_mine", () => {
    const noFallback: BucketContext = { meId: ME, flowByKind: new Map(), fallbackHrId: null };
    expect(bucketOf(MINE_FALLBACK, noFallback)).toBe("pending_mine");
    const noMe: BucketContext = { ...CTX, meId: null };
    expect(bucketOf(MINE_EXPLICIT, noMe)).toBe("in_progress");
    expect(bucketOf(MINE_FALLBACK, { ...noFallback, meId: null })).toBe("pending_mine");
  });

  it("approved／rejected／cancelled 直接對應，不看簽核者", () => {
    expect(bucketOf(APPROVED, CTX)).toBe("approved");
    expect(bucketOf(REJECTED, CTX)).toBe("rejected");
    expect(bucketOf(CANCELLED, CTX)).toBe("cancelled");
    expect(bucketOf({ ...APPROVED, current_approver_emp_id: BOSS }, CTX)).toBe("approved");
  });

  it("pendingCounts 只數 pending，N＋M＝pending 總數", () => {
    const counts = pendingCounts(ALL_ROWS, CTX);
    expect(counts).toEqual({ pending_mine: 3, in_progress: 2 });
    expect(counts.pending_mine + counts.in_progress).toBe(PENDING_ROWS.length);
  });
});

describe("rowsForView", () => {
  it("pending／in_progress 從同一份 pending 資料切桶，兩者互斥且聯集＝全部 pending", () => {
    const mine = rowsForView(PENDING_ROWS, "pending", CTX);
    const others = rowsForView(PENDING_ROWS, "in_progress", CTX);
    expect(mine.map((r) => r.id)).toEqual([MINE_EXPLICIT.id, MINE_BY_FLOW.id, MINE_FALLBACK.id]);
    expect(others.map((r) => r.id)).toEqual([OTHERS_EXPLICIT.id, OTHERS_BY_FLOW.id]);
    expect(mine.length + others.length).toBe(PENDING_ROWS.length);
  });

  it("approved／rejected 只留該 status；all 原樣（含 cancelled）且回新陣列", () => {
    expect(rowsForView(ALL_ROWS, "approved", CTX)).toEqual([APPROVED]);
    expect(rowsForView(ALL_ROWS, "rejected", CTX)).toEqual([REJECTED]);
    const all = rowsForView(ALL_ROWS, "all", CTX);
    expect(all).toEqual(ALL_ROWS);
    expect(all).not.toBe(ALL_ROWS);
    expect(all.some((r) => r.status === "cancelled")).toBe(true);
  });
});

/* ------------------------------------------------------- client filters --- */

describe("applyClientFilters（單位＋關鍵字，client 端）", () => {
  it("單位：只留該單位員工的單；找不到員工的單一律排除", () => {
    const eng = applyClientFilters(ALL_ROWS, { deptId: "d-eng" }, LOOKUP);
    expect(eng.every((r) => r.employee_id === AMY)).toBe(true);
    expect(eng).toHaveLength(ALL_ROWS.filter((r) => r.employee_id === AMY).length);
    const ghost = request({ employee_id: "nobody" });
    expect(applyClientFilters([ghost], { deptId: "d-eng" }, LOOKUP)).toEqual([]);
    expect(applyClientFilters([ghost], { deptId: "" }, LOOKUP)).toEqual([ghost]);
  });

  it("關鍵字：姓名、工號、單位名、原因、地點、代理人、目前簽核人都比得到，不分大小寫、前後空白忽略", () => {
    const ids = (rows: LeaveRequest[]) => rows.map((r) => r.id);
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: " 小美 " }, LOOKUP))).toEqual(
      ids(ALL_ROWS.filter((r) => r.employee_id === AMY)),
    );
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: "e010" }, LOOKUP))).toEqual(ids(ALL_ROWS.filter((r) => r.employee_id === AMY)));
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: "管理部" }, LOOKUP))).toEqual(
      ids(ALL_ROWS.filter((r) => r.employee_id === BOSS)),
    );
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: "忘記打卡" }, LOOKUP))).toEqual([MINE_EXPLICIT.id]);
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: "台中廠" }, LOOKUP))).toEqual([MINE_FALLBACK.id]);
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: "阿花" }, LOOKUP))).toEqual([OTHERS_BY_FLOW.id]);
    // 姓名比對也涵蓋沒有工號的員工（陳大寶：申請人 r2／r8）
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: "陳大寶" }, LOOKUP))).toEqual([MINE_BY_FLOW.id, CANCELLED.id]);
    // 目前簽核人「老闆」：OTHERS_EXPLICIT（明確指定）＋ OTHERS_BY_FLOW（流程表第 1 關）
    expect(ids(applyClientFilters(ALL_ROWS, { keyword: "第 1 關 · B001" }, LOOKUP))).toEqual([OTHERS_EXPLICIT.id, OTHERS_BY_FLOW.id]);
    expect(applyClientFilters(ALL_ROWS, { keyword: "找不到的字" }, LOOKUP)).toEqual([]);
  });

  it("兩個條件同時生效；都空就原樣", () => {
    expect(applyClientFilters(ALL_ROWS, { deptId: "d-eng", keyword: "重複申請" }, LOOKUP)).toEqual([REJECTED]);
    expect(applyClientFilters(ALL_ROWS, { deptId: "d-mgmt", keyword: "重複申請" }, LOOKUP)).toEqual([]);
    expect(applyClientFilters(ALL_ROWS, {}, LOOKUP)).toEqual(ALL_ROWS);
  });
});

/* --------------------------------------------------------------- stats --- */

describe("statsOf", () => {
  it("總數／簽核中／已核准／已駁回（cancelled 只計入總數）", () => {
    expect(statsOf(ALL_ROWS)).toEqual({ total: 8, pending: 5, approved: 1, rejected: 1 });
    expect(statsOf([])).toEqual({ total: 0, pending: 0, approved: 0, rejected: 0 });
  });
});

/* ----------------------------------------------------------------- CSV --- */

describe("csvMatrix／csvText", () => {
  it("表頭 12 欄與 form-records 相同，每列 12 格全是字串", () => {
    expect(CSV_HEADER).toEqual([
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
    ]);
    const matrix = csvMatrix(ALL_ROWS, LOOKUP, CTX);
    expect(matrix).toHaveLength(ALL_ROWS.length + 1);
    expect(matrix[0]).toEqual(CSV_HEADER);
    for (const row of matrix) {
      expect(row).toHaveLength(12);
      expect(row.every((cell) => typeof cell === "string")).toBe(true);
    }
  });

  it("各欄取值：日期與起迄時間都轉成「當地」時間（不是 UTC 切字串）、時數空值→空字串、地點/代理/給付用「 / 」串、原因退回備註、狀態依桶", () => {
    const local = (iso: string) => `${localDateKey(iso)} ${fmtHm(iso)}`;
    const [, mineExplicit, , , , fallback, approved] = csvMatrix(
      [MINE_EXPLICIT, MINE_BY_FLOW, OTHERS_EXPLICIT, OTHERS_BY_FLOW, MINE_FALLBACK, APPROVED],
      LOOKUP,
      CTX,
    );
    expect(mineExplicit).toEqual([
      localDateKey("2026-09-17T08:30:00+00:00"),
      "工程部",
      "E010 · 王小美",
      "補卡",
      local("2026-09-18T01:00:00+00:00"),
      local("2026-09-18T10:00:00+00:00"),
      "8",
      "",
      "忘記打卡",
      "第 1 關 · A001 · Kimi",
      "第 1 關",
      "待簽核",
    ]);
    expect(fallback.slice(1, 4)).toEqual(["管理部", "B001 · 老闆", "加班"]);
    expect(fallback[7]).toBe("台中廠 / pay");
    expect(approved[11]).toBe("已核准");
    // 明確釘 Asia/Taipei：UTC 01:00 → 當地 09:00，證明不是 UTC 切字串
    expect(`${localDateKey("2026-09-18T01:00:00+00:00", "Asia/Taipei")} ${fmtHm("2026-09-18T01:00:00+00:00", "Asia/Taipei")}`).toBe("2026-09-18 09:00");
    expect(approved[9]).toBe("—");

    const noHours = request({ hours: null, remark: "只有備註", employee_id: "nobody", current_approver_emp_id: BOSS });
    const [, cells] = csvMatrix([noHours], LOOKUP, CTX);
    expect(cells[1]).toBe("—");
    expect(cells[2]).toBe("nobody");
    expect(cells[6]).toBe("");
    expect(cells[8]).toBe("只有備註");
    expect(cells[11]).toBe("簽核中");
  });

  it("csvText：BOM 開頭、每格雙引號、內部引號加倍、換列用 \\n；檔名 approvals-YYYY-MM-DD.csv", () => {
    const text = csvText([
      ["a", "b"],
      ['說 "引號"', "1,2"],
    ]);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe('"a","b"\n"說 ""引號""","1,2"');
    expect(csvFileName(new Date("2026-09-19T15:00:00Z"))).toBe("approvals-2026-09-19.csv");
  });
});

/* ------------------------------------------------------------- actions --- */

describe("actionsFor（各桶列操作）", () => {
  const keys = (bucket: Parameters<typeof actionsFor>[0]) => actionsFor(bucket).map((a) => a.key);

  it("pending_mine：核准／駁回／變更簽核人／註銷／附件", () => {
    expect(keys("pending_mine")).toEqual(["approve", "reject", "change_approver", "delete", "attachments"]);
    expect(actionsFor("pending_mine").every((a) => !a.disabled)).toBe(true);
  });

  it("in_progress：催簽／代理簽核／變更簽核人／註銷／附件（沒有直接核准駁回）", () => {
    expect(keys("in_progress")).toEqual(["remind", "proxy_approve", "change_approver", "delete", "attachments"]);
    expect(keys("in_progress")).not.toContain("approve");
  });

  it("approved：只有附件，註銷顯示但 disabled；rejected／cancelled：註銷＋附件", () => {
    const approved = actionsFor("approved");
    expect(approved.map((a) => a.key)).toEqual(["delete", "attachments"]);
    expect(approved.find((a) => a.key === "delete")?.disabled).toBe(true);
    expect(keys("rejected")).toEqual(["delete", "attachments"]);
    expect(keys("cancelled")).toEqual(["delete", "attachments"]);
    expect(actionsFor("rejected").every((a) => !a.disabled)).toBe(true);
  });

  it("每桶都能看附件", () => {
    for (const bucket of ["pending_mine", "in_progress", "approved", "rejected", "cancelled"] as const) {
      expect(keys(bucket)).toContain("attachments");
    }
  });
});

/* ------------------------------------------------------------- content --- */

describe("contentLines（內容欄）", () => {
  it("第一行期間＋時數，之後依序原因／地點／代理人／類型／給付；原因空則退回備註", () => {
    const row = request({
      hours: 2.5,
      reason: "客戶拜訪",
      location: "新竹",
      agent_name: "王小美",
      trip_type: "business_trip",
      payout: "comp_time",
    });
    const lines = contentLines(row);
    expect(lines[0]).toMatch(/→ .*（2\.5 小時）$/);
    expect(lines.slice(1)).toEqual(["客戶拜訪", "地點：新竹", "代理人：王小美", "類型：出差", "加班給付：補休"]);
    const remarkOnly = contentLines(request({ hours: null, reason: "", remark: "備註而已", trip_type: "outing", payout: "pay" }));
    expect(remarkOnly[0]).not.toContain("小時");
    expect(remarkOnly.slice(1)).toEqual(["備註而已", "類型：公出", "加班給付：加班費"]);
    expect(contentLines(request({ hours: null }))).toHaveLength(1);
  });

  it("結束時間缺席／無效或與起始相同（補卡單）→ 只顯示起始，不印「→」也不印 1970", () => {
    // 時間文字走 toLocaleString（zh-TW 會印「下午03:00」），用同一支函式算出的「起始」當基準，不寫死格式。
    const startOf = (row: LeaveRequest) => contentLines({ ...row, end_at: "2026-12-31T10:00:00+00:00", hours: null })[0].split(" → ")[0];

    const punch = request({ kind: "fix_punch", hours: null, start_at: "2026-09-17T07:00:00+00:00", end_at: "2026-09-17T07:00:00+00:00" });
    expect(contentLines(punch)[0]).toBe(startOf(punch));
    expect(contentLines(punch)[0]).not.toContain("→");

    const missing = request({ kind: "fix_punch", hours: null, end_at: null as unknown as string });
    expect(contentLines(missing)[0]).toBe(startOf(missing));
    expect(contentLines(missing)[0]).not.toContain("1970");
    expect(contentLines(missing)[0]).not.toContain("undefined");

    const invalid = request({ hours: 2, end_at: "not-a-date" });
    expect(contentLines(invalid)[0]).toBe(`${startOf(invalid)}（2 小時）`);

    // 正常起訖仍是「起 → 迄」
    const normal = request({ hours: 8 });
    expect(contentLines(normal)[0]).toContain(" → ");
    expect(contentLines(normal)[0]).toMatch(/（8 小時）$/);
  });
});
