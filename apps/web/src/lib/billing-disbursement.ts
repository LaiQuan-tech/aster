/**
 * 「請款與放款」頁（2026-10-27 業主：把「請款與未收款」跟「放款」融合，會計一頁看清請款細節並打勾放款）
 * 的純函式：把三份既有 API 資料拼成「每個專案：客戶請款 × 廠商付款」的對照總表，並決定哪些放款單能打勾放款。
 *
 *   客戶請款  ← GET /projects/receivables（ReceivableRow，每期一列）
 *   廠商付款  ← GET /disbursements/payables（未付期款，含驗收日）
 *             ＋ GET /disbursements（草稿／送簽中／已核准一律列；已匯款依日期窗）的分攤列
 *
 * 打勾的單位是**放款單**（一張單可能分攤到好幾期、甚至跨案；勾任一列＝整張單一起放款）。
 * 規則與後端 POST /disbursements/batch-pay 一致、只是先在畫面上擋：只有「已核准」且分攤到的期款都已驗收的單可以勾；
 * 實付必須等於核准金額（已核准單的金額凍結，要改得撤回簽核改單）。最後仍以後端逐筆結果為準。
 */
import type { Disbursement, DisbursementStatus, Payable } from "./disbursements-api";
import type { ReceivableRow } from "./projects-ext-api";

/* ------------------------------------------------------------- 子檢視 --- */

export type BillingDisbursementView = "ledger" | "receivables" | "payables" | "records";

export const BILLING_DISBURSEMENT_VIEWS: ReadonlyArray<{ value: BillingDisbursementView; label: string }> = [
  { value: "ledger", label: "對照總表" },
  { value: "receivables", label: "應收催收" },
  { value: "payables", label: "應付建單" },
  { value: "records", label: "放款紀錄" },
];

/**
 * `?view=` → 子檢視。舊網址相容：/admin/projects/receivables 轉址到 `?view=receivables`；
 * 舊放款頁的「匯款紀錄」tab 以前沒有網址，`records` 照收。認不得的值退回對照總表。
 */
export function parseBillingDisbursementView(raw: string | null | undefined): BillingDisbursementView {
  return BILLING_DISBURSEMENT_VIEWS.some((v) => v.value === raw) ? (raw as BillingDisbursementView) : "ledger";
}

/* ---------------------------------------------------------- 廠商付款列 --- */

/**
 * 廠商付款列狀態（由「離放款最近」排到「最遠」）：
 *   ready_to_pay          已核准、期款都已驗收 → 可以打勾放款
 *   approved_unaccepted   已核准但有期款還沒驗收（建單後被取消驗收）→ 不能勾
 *   pending_approval      送簽中
 *   draft                 放款單草稿，待送簽
 *   to_create             已驗收、還沒建放款單
 *   unaccepted            未驗收、還沒建放款單
 *   paid                  已放款
 */
export type VendorRowState =
  | "ready_to_pay"
  | "approved_unaccepted"
  | "pending_approval"
  | "draft"
  | "to_create"
  | "unaccepted"
  | "paid";

export const VENDOR_ROW_STATE_LABELS: Record<VendorRowState, string> = {
  ready_to_pay: "可放款",
  approved_unaccepted: "已核准・未驗收",
  pending_approval: "簽核中",
  draft: "草稿待送簽",
  to_create: "已驗收・待建單",
  unaccepted: "未驗收",
  paid: "已放款",
};

export const VENDOR_ROW_STATE_TONE: Record<VendorRowState, string> = {
  ready_to_pay: "bg-emerald-50 text-emerald-700",
  approved_unaccepted: "bg-red-50 text-red-700",
  pending_approval: "bg-blue-50 text-blue-700",
  draft: "bg-gray-100 text-gray-600",
  to_create: "bg-amber-50 text-amber-700",
  unaccepted: "bg-orange-50 text-orange-700",
  paid: "bg-gray-50 text-gray-400",
};

export interface VendorRowDisbursement {
  id: string;
  disbursementNo: string;
  status: DisbursementStatus;
  currentStep: number | null;
  paidOn: string | null;
  payingCompanyName: string | null;
  receiptIssuerCompanyName: string | null;
  receiptRef: string | null;
  hasInvoice: boolean;
  invoiceNo: string | null;
  /** 整張單的實付（淨額）。 */
  amount: number;
  /** 這張單分攤到幾個專案（>1 時畫面提示「整張單一起放款」）。 */
  projectCount: number;
}

export interface VendorRow {
  key: string;
  projectId: string;
  vendorName: string;
  /** 副委託描述（專業別／項目），沒有則 null。 */
  item: string | null;
  installmentNo: number | null;
  /** 請款依據：期款的應付時機。 */
  dueWhen: string | null;
  acceptedOn: string | null;
  grossAmount: number;
  withheldAmount: number;
  netAmount: number;
  state: VendorRowState;
  subcontractPaymentId: string | null;
  disbursement: VendorRowDisbursement | null;
}

export interface ProjectLedger {
  projectId: string;
  code: string | null;
  name: string;
  clientName: string | null;
  archived: boolean;
  /** 該專案收款進度%（來自應付清單；沒有未付期款的專案為 null）。 */
  receiptProgressPct: number | null;
  billings: ReceivableRow[];
  vendorRows: VendorRow[];
  totals: {
    billingAmount: number;
    unreceived: number;
    overdueCount: number;
    /** 未放款（不含已放款列）的淨額合計。 */
    unpaidNet: number;
    readyToPayNet: number;
  };
}

/** 未結束、會連動期款的放款單狀態（作廢的不算）。 */
const ACTIVE_STATUSES: ReadonlySet<DisbursementStatus> = new Set(["draft", "pending_approval", "approved"]);

export interface MarkPaidCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * 這張放款單能不能打勾放款（畫面預檢；後端 batch-pay 會再擋一次）。
 * `payablesById`：未付期款（帶驗收日）；`acceptanceTracked=false`（驗收欄位未套用）時不檢查驗收。
 */
export function markPaidCheck(
  d: Pick<Disbursement, "status" | "allocations" | "currentStep">,
  payablesById: ReadonlyMap<string, Pick<Payable, "acceptedOn" | "installmentNo">>,
  acceptanceTracked: boolean,
): MarkPaidCheck {
  if (d.status === "paid") return { ok: false, reason: "已放款" };
  if (d.status === "void") return { ok: false, reason: "已作廢" };
  if (d.status === "draft") return { ok: false, reason: "草稿還沒送簽，不能放款" };
  if (d.status === "pending_approval") {
    return { ok: false, reason: `簽核中${d.currentStep ? `（第 ${d.currentStep} 關）` : ""}，核准後才能放款` };
  }
  if (acceptanceTracked) {
    const pending = d.allocations
      .map((a) => (a.subcontractPaymentId ? payablesById.get(a.subcontractPaymentId) : undefined))
      .filter((p): p is Pick<Payable, "acceptedOn" | "installmentNo"> => !!p && !p.acceptedOn);
    if (pending.length > 0) {
      return { ok: false, reason: `第 ${pending.map((p) => p.installmentNo).join("、")} 期尚未驗收，驗收後才能放款` };
    }
  }
  return { ok: true, reason: null };
}

function toVendorDisbursement(d: Disbursement): VendorRowDisbursement {
  return {
    id: d.id,
    disbursementNo: d.disbursementNo,
    status: d.status,
    currentStep: d.currentStep ?? null,
    paidOn: d.paidOn,
    payingCompanyName: d.payingCompanyName ?? null,
    receiptIssuerCompanyName: d.receiptIssuerCompanyName ?? null,
    receiptRef: d.receiptRef ?? null,
    hasInvoice: !!d.hasInvoice,
    invoiceNo: d.invoiceNo ?? null,
    amount: d.amount,
    projectCount: new Set(d.allocations.map((a) => a.projectId)).size,
  };
}

function stateForDisbursement(d: Disbursement, check: MarkPaidCheck): VendorRowState {
  if (d.status === "paid") return "paid";
  if (d.status === "approved") return check.ok ? "ready_to_pay" : "approved_unaccepted";
  if (d.status === "pending_approval") return "pending_approval";
  return "draft";
}

function itemLabel(discipline: string | null | undefined, item: string | null | undefined): string | null {
  const parts = [discipline, item].filter((s): s is string => !!s && s.trim() !== "");
  return parts.length > 0 ? parts.join("・") : null;
}

const STATE_ORDER: Record<VendorRowState, number> = {
  ready_to_pay: 0,
  approved_unaccepted: 1,
  pending_approval: 2,
  draft: 3,
  to_create: 4,
  unaccepted: 5,
  paid: 6,
};

export interface BuildLedgerInput {
  receivables: ReceivableRow[];
  payables: Payable[];
  /** GET /disbursements 的結果（作廢的會被忽略）。 */
  disbursements: Disbursement[];
  acceptanceTracked: boolean;
  /** 是否列出已放款的分攤列（「全部」模式）。 */
  includePaid: boolean;
}

/**
 * 拼出對照總表：每個有請款或有廠商付款的專案一塊。
 * 未付期款以應付清單為準（金額取放款單的分攤列，沒有放款單時取試算淨額）；
 * 放款單上沒指到期款的分攤列（例如收款方「其他」）與已放款的分攤列從放款單補上。
 */
export function buildLedger(input: BuildLedgerInput): ProjectLedger[] {
  const payablesById = new Map(input.payables.map((p) => [p.subcontractPaymentId, p]));
  const liveDisbursements = input.disbursements.filter((d) => d.status !== "void");
  const checks = new Map(liveDisbursements.map((d) => [d.id, markPaidCheck(d, payablesById, input.acceptanceTracked)]));

  /** 期款 → 正在處理它的（未結束）放款單與分攤列。 */
  const activeByPayment = new Map<string, { d: Disbursement; alloc: Disbursement["allocations"][number] }>();
  for (const d of liveDisbursements) {
    if (!ACTIVE_STATUSES.has(d.status)) continue;
    for (const a of d.allocations) if (a.subcontractPaymentId) activeByPayment.set(a.subcontractPaymentId, { d, alloc: a });
  }

  const projects = new Map<string, ProjectLedger>();
  const ensure = (projectId: string, code: string | null, name: string, clientName: string | null, archived: boolean) => {
    let p = projects.get(projectId);
    if (!p) {
      p = {
        projectId,
        code,
        name,
        clientName,
        archived,
        receiptProgressPct: null,
        billings: [],
        vendorRows: [],
        totals: { billingAmount: 0, unreceived: 0, overdueCount: 0, unpaidNet: 0, readyToPayNet: 0 },
      };
      projects.set(projectId, p);
    } else {
      if (!p.clientName && clientName) p.clientName = clientName;
      if (!p.code && code) p.code = code;
    }
    return p;
  };

  for (const r of input.receivables) {
    const p = ensure(r.projectId, r.code, r.projectName, r.clientName, !!r.archived);
    p.billings.push(r);
  }

  for (const pay of input.payables) {
    const p = ensure(pay.projectId, pay.projectCode, pay.projectName, null, !!pay.archived);
    if (pay.projectReceiptProgressPct != null) p.receiptProgressPct = pay.projectReceiptProgressPct;
    const linked = activeByPayment.get(pay.subcontractPaymentId);
    const notAccepted = input.acceptanceTracked && !pay.acceptedOn;
    const state: VendorRowState = linked
      ? stateForDisbursement(linked.d, checks.get(linked.d.id)!)
      : notAccepted
        ? "unaccepted"
        : "to_create";
    p.vendorRows.push({
      key: `pay:${pay.subcontractPaymentId}`,
      projectId: pay.projectId,
      vendorName: linked?.alloc.vendorName ?? pay.vendorName ?? linked?.d.payeeName ?? "未指定廠商",
      item: itemLabel(pay.discipline, pay.item),
      installmentNo: pay.installmentNo,
      dueWhen: pay.dueWhen,
      acceptedOn: pay.acceptedOn ?? null,
      grossAmount: linked ? linked.alloc.amount : pay.grossAmount,
      withheldAmount: linked ? allocWithheld(linked.alloc) : pay.withheldAmount,
      netAmount: linked ? allocNet(linked.alloc) : pay.netAmount,
      state,
      subcontractPaymentId: pay.subcontractPaymentId,
      disbursement: linked ? toVendorDisbursement(linked.d) : null,
    });
  }

  for (const d of liveDisbursements) {
    if (d.status === "paid" && !input.includePaid) continue;
    d.allocations.forEach((a, idx) => {
      // 指到未付期款的分攤列上面已經列過（以應付清單為準）。
      if (a.subcontractPaymentId && payablesById.has(a.subcontractPaymentId)) return;
      // 未結束的單指到「不在應付清單」的期款＝資料不同步（例如期款已被別張單付掉）；照列，讓會計看得到。
      const p = ensure(a.projectId, a.projectCode ?? null, a.projectName ?? "", null, false);
      p.vendorRows.push({
        key: `alloc:${a.id ?? `${d.id}:${idx}`}`,
        projectId: a.projectId,
        vendorName: a.vendorName ?? d.payeeName,
        item: itemLabel(a.discipline, a.item) ?? d.purpose ?? null,
        installmentNo: a.installmentNo ?? null,
        dueWhen: null,
        acceptedOn: null,
        grossAmount: a.amount,
        withheldAmount: allocWithheld(a),
        netAmount: allocNet(a),
        state: stateForDisbursement(d, checks.get(d.id)!),
        subcontractPaymentId: a.subcontractPaymentId ?? null,
        disbursement: toVendorDisbursement(d),
      });
    });
  }

  const out = [...projects.values()];
  for (const p of out) {
    p.billings.sort((a, b) => a.installmentNo - b.installmentNo);
    p.vendorRows.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.vendorName.localeCompare(b.vendorName, "zh-Hant") ||
        (a.installmentNo ?? 1e9) - (b.installmentNo ?? 1e9),
    );
    p.totals.billingAmount = round2(p.billings.reduce((s, b) => s + (b.amount ?? 0), 0));
    p.totals.unreceived = round2(p.billings.reduce((s, b) => s + (b.unreceived ?? 0), 0));
    p.totals.overdueCount = p.billings.filter((b) => b.state === "overdue").length;
    p.totals.unpaidNet = round2(p.vendorRows.filter((v) => v.state !== "paid").reduce((s, v) => s + v.netAmount, 0));
    p.totals.readyToPayNet = round2(p.vendorRows.filter((v) => v.state === "ready_to_pay").reduce((s, v) => s + v.netAmount, 0));
  }
  // 有可放款的專案排前面，其次未收比例高（同應收催收的「先追誰」），最後照專案編號。
  out.sort(
    (a, b) =>
      Number(b.totals.readyToPayNet > 0) - Number(a.totals.readyToPayNet > 0) ||
      (b.billings[0]?.projectUnreceivedPct ?? -1) - (a.billings[0]?.projectUnreceivedPct ?? -1) ||
      (a.code ?? "").localeCompare(b.code ?? "") ||
      a.name.localeCompare(b.name, "zh-Hant"),
  );
  return out;
}

type AllocLike = Disbursement["allocations"][number];
function allocWithheld(a: AllocLike): number {
  return a.withheldAmount ?? 0;
}
function allocNet(a: AllocLike): number {
  return a.netAmount ?? round2(a.amount - allocWithheld(a));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------- 篩選 --- */

export type LedgerChip = "all" | "unreceived" | "overdue" | "readyToPay" | "blocked";

export const LEDGER_CHIPS: ReadonlyArray<{ value: LedgerChip; label: string }> = [
  { value: "all", label: "全部專案" },
  { value: "readyToPay", label: "有可放款" },
  { value: "unreceived", label: "有未收" },
  { value: "overdue", label: "有逾期" },
  { value: "blocked", label: "卡驗收／簽核" },
];

/** 關鍵字比對專案編號／名稱／客戶／廠商／放款單號（不分大小寫）。 */
export function filterLedger(ledger: ProjectLedger[], opts: { q?: string; chip?: LedgerChip }): ProjectLedger[] {
  const q = opts.q?.trim().toLowerCase() ?? "";
  const chip = opts.chip ?? "all";
  return ledger.filter((p) => {
    if (chip === "readyToPay" && p.totals.readyToPayNet <= 0) return false;
    if (chip === "unreceived" && p.totals.unreceived <= 0) return false;
    if (chip === "overdue" && p.totals.overdueCount === 0) return false;
    if (
      chip === "blocked" &&
      !p.vendorRows.some((v) => v.state === "approved_unaccepted" || v.state === "unaccepted" || v.state === "pending_approval")
    ) {
      return false;
    }
    if (!q) return true;
    const hay = [p.code, p.name, p.clientName, ...p.vendorRows.map((v) => v.vendorName), ...p.vendorRows.map((v) => v.disbursement?.disbursementNo)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

/** 一般用的關鍵字比對（應收催收／應付建單共用同一個關鍵字框）。 */
export function matchesKeyword(q: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => !!f && f.toLowerCase().includes(needle));
}

/* ---------------------------------------------------------- 打勾放款 --- */

export interface BatchPayDraftRow {
  id: string;
  disbursementNo: string;
  /** 核准金額（實付淨額）。 */
  approvedAmount: number;
  /** 畫面上的實付（預設＝核准金額，可改）。 */
  amount: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 送出前檢查：放款日要是有效日期；每列實付要有值且等於核准金額（±0.01）。
 * 回 { dateError, rowErrors }，rowErrors 只放有問題的列；有問題的列不送（其他列照送）。
 */
export function validateBatchPay(
  paidOn: string,
  rows: BatchPayDraftRow[],
): { dateError: string | null; rowErrors: Record<string, string> } {
  const dateError = isCalendarDate(paidOn) ? null : "請填有效的放款日（YYYY-MM-DD）";
  const rowErrors: Record<string, string> = {};
  for (const r of rows) {
    if (r.amount === null || !Number.isFinite(r.amount) || r.amount < 0) {
      rowErrors[r.id] = "請填實付金額";
    } else if (Math.abs(r.amount - r.approvedAmount) > 0.01) {
      rowErrors[r.id] = `實付與核准金額 ${r.approvedAmount.toLocaleString()} 不同：已核准的金額不能直接改，請到放款單撤回簽核、改單後重新送簽`;
    }
  }
  return { dateError, rowErrors };
}

export type BatchPayResultItem =
  | { id: string; ok: true }
  | { id: string; ok: false; status: number; error: string; details?: Record<string, unknown> };

/**
 * 套用後端逐筆結果：成功的從勾選移除（不會再送）、失敗的留著並記原因。
 * `describe` 把錯誤碼轉成中文（disbursements-api 的 DISBURSEMENT_ERRORS）。
 */
export function applyBatchPayResults(
  selected: ReadonlySet<string>,
  results: BatchPayResultItem[],
  describe: (code: string, details?: Record<string, unknown>) => string,
): { remaining: Set<string>; succeeded: string[]; failures: Record<string, string> } {
  const remaining = new Set(selected);
  const succeeded: string[] = [];
  const failures: Record<string, string> = {};
  for (const r of results) {
    if (r.ok) {
      remaining.delete(r.id);
      succeeded.push(r.id);
    } else {
      failures[r.id] = describe(r.error, r.details);
    }
  }
  return { remaining, succeeded, failures };
}
