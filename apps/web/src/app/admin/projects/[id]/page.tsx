"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import { listVendors, type Vendor } from "@/lib/company-api";
import {
  getProjectMembers,
  addProjectMember,
  updateProjectMember,
  removeProjectMember,
  getProjectAdjustments,
  getProjectDocuments,
  uploadProjectDocument,
  deleteProjectDocument,
  type ProjectMember,
  type ShareAdjustment,
  type ProjectDocument,
  type ShareMode,
  type ProjectStatus,
  PROJECT_STATUS_ORDER,
  PROJECT_STATUS_LABELS,
  statusLabel,
  getContracts,
  createContract,
  updateContract,
  deleteContract,
  DOC_TYPE_LABELS,
  OUR_ROLE_LABELS,
  type Contract,
  type DocType,
  type OurRole,
} from "@/lib/projects-api";
import {
  getProjectDetail,
  updateProjectFields,
  humanizeProjectExtError,
  type ProjectDetail,
  type ProjectAccess,
  type ProjectMoney,
  getBillingSchedule,
  saveBillingSchedule,
  billInstallmentExt,
  unbillInstallmentExt,
  invoiceBilling,
  uninvoiceBilling,
  receiveBilling,
  unreceiveBilling,
  humanizeBillingError,
  BILLING_KIND_LABELS,
  type BillingScheduleExt,
  type BillingExt,
  type InstallmentInputExt,
  type BillingKind,
  getProjectSubcontracts,
  putProjectSubcontracts,
  putSubcontractPayments,
  humanizeSubcontractError,
  type Subcontract,
  type SubcontractPayment,
  type SubcontractKind,
  type OrderType,
  type SubcontractsResponse,
  type DesignScopeItem,
  type ProjectEngineers,
  type EngineerDiscipline,
  ENGINEER_DISCIPLINE_LABELS,
  ENGINEER_DISCIPLINES,
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  type InvoiceType,
  type PaymentMethod,
  COMMON_DISCIPLINES,
  PROJECT_KIND_LABELS,
  listCompanies,
  type Company,
} from "@/lib/projects-ext-api";

/** 後端的錯誤碼翻成人看得懂的話（既有：合約／狀態／成員這些流程用）。 */
const STATUS_ERRORS: Record<string, string> = {
  status_reason_required: "變更案情狀態必須填理由。",
  archive_requires_non_active: "「進行中」的專案不能封存。要收起來請先改成暫停、結案或已解約。",
  invalid_status: "狀態值不合法。",
  override_reason_required: "人工指定金額必須填理由——偏離期程的金額是談出來的，要留得下痕跡。",
  billed_installment_not_removable: "已請款的期別不能移除。帳已經出去了，移掉那筆應收會憑空消失。",
  duplicate_installment_no: "期別編號重複。",
  installment_no_taken: "期別編號已存在。",
  amount_unknown: "算不出金額（還沒有合約，或這期沒有百分比也沒有人工金額）。",
  already_billed: "這期已經標記請款過了。",
  not_billed: "這期還沒標記請款。",
};

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

type EngineerFormValue = { vendorId: string | null; name: string | null };
type EngineersForm = Record<EngineerDiscipline, EngineerFormValue>;

function emptyEngineersForm(): EngineersForm {
  return {
    electrical: { vendorId: null, name: null },
    hvac: { vendorId: null, name: null },
    fire: { vendorId: null, name: null },
  };
}

interface AppForm {
  siteAddress: string;
  siteAreaM2: string;
  designScope: DesignScopeItem[];
  invoiceType: InvoiceType | "";
  paymentMethod: PaymentMethod | "";
  closingDay: string;
  paymentDay: string;
  otherExpenses: string;
  engineers: EngineersForm;
}

function appFormFrom(p: ProjectDetail): AppForm {
  const engineers = emptyEngineersForm();
  for (const d of ENGINEER_DISCIPLINES) {
    const a = p.engineers?.[d];
    if (a) engineers[d] = { vendorId: a.vendorId ?? null, name: a.name ?? null };
  }
  return {
    siteAddress: p.siteAddress ?? "",
    siteAreaM2: p.siteAreaM2 != null ? String(p.siteAreaM2) : "",
    designScope: p.designScope ?? [],
    invoiceType: (p.invoiceType as InvoiceType) ?? "",
    paymentMethod: (p.paymentMethod as PaymentMethod) ?? "",
    closingDay: p.closingDay ?? "",
    paymentDay: p.paymentDay ?? "",
    otherExpenses: p.otherExpenses != null ? String(p.otherExpenses) : "",
    engineers,
  };
}

/** 「訂單類型（沿用合約）」：跟後端 summarizeContracts() 同一套邏輯——
 * 我方承攬、優先看合約（簽訂日新的優先，沒簽訂日的排後面），沒有合約才退用最新報價單。 */
function isNewerDoc(a: Contract, b: Contract): boolean {
  if (a.signedOn !== b.signedOn) {
    if (a.signedOn === null) return false;
    if (b.signedOn === null) return true;
    return a.signedOn > b.signedOn;
  }
  return a.createdAt > b.createdAt;
}
function latestDocumentOf(list: Contract[]): Contract | null {
  let latestContract: Contract | null = null;
  let latestQuotation: Contract | null = null;
  for (const c of list) {
    if (c.ourRole !== "contractor") continue;
    if (c.docType === "quotation") {
      if (!latestQuotation || isNewerDoc(c, latestQuotation)) latestQuotation = c;
    } else if (c.docType === "contract") {
      if (!latestContract || isNewerDoc(c, latestContract)) latestContract = c;
    }
  }
  return latestContract ?? latestQuotation;
}

/** 廠商挑選：可選名冊裡的 vendor，也可以直接輸入自由文字名稱。兩者並存
 * （選了 vendor 就把名稱一併帶入，之後改名冊不影響這裡已存的字串）。 */
function VendorCombo({
  vendors,
  vendorId,
  name,
  onChange,
}: {
  vendors: Vendor[];
  vendorId: string | null | undefined;
  name: string | null | undefined;
  onChange: (v: { vendorId: string | null; name: string | null }) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <select
        className={`${inputCls} text-xs`}
        value={vendorId ?? ""}
        onChange={(e) => {
          const vid = e.target.value || null;
          const v = vendors.find((x) => x.id === vid);
          onChange({ vendorId: vid, name: v ? v.name : (name ?? null) });
        }}
      >
        <option value="">自由輸入／未建檔</option>
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </select>
      <input
        className={`${inputCls} text-xs`}
        value={name ?? ""}
        placeholder="名稱"
        onChange={(e) => onChange({ vendorId: vendorId ?? null, name: e.target.value })}
      />
    </div>
  );
}

type SubRow = Subcontract & { _key: string };
let subSeq = 0;
const newSubKey = () => `newsub-${Date.now()}-${subSeq++}`;
function toSubRows(list: Subcontract[]): SubRow[] {
  return list.map((s) => ({ ...s, _key: s.id ?? newSubKey() }));
}
function emptySubcontractsResponse(): SubcontractsResponse {
  return { subcontracts: [], summary: { subcontractTotal: 0, technicianTotal: 0, total: 0, paidTotal: 0, withheldTotal: 0 } };
}
function emptyBillingSchedule(): BillingScheduleExt {
  return {
    contract: { total: null, base: 0, changeOrders: 0 },
    installments: [],
    summary: {
      percentageTotal: 0, effectiveTotal: 0, unallocatedResidue: 0, guildAdvanceTotal: 0,
      billedTotal: 0, unbilledTotal: 0, invoicedTotal: 0, receivedTotal: 0, unreceivedTotal: 0,
    },
    warnings: [],
  };
}

export default function AdminProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [access, setAccess] = useState<ProjectAccess>({ finance: true, bonus: true });
  const [money, setMoney] = useState<ProjectMoney | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [adjustments, setAdjustments] = useState<ShareAdjustment[]>([]);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [schedule, setSchedule] = useState<BillingScheduleExt | null>(null);
  /** 期程是整批存的，所以編輯中的狀態獨立於已存檔的 schedule。 */
  const [draft, setDraft] = useState<InstallmentInputExt[]>([]);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 合約掃描檔共用一個隱藏 input；點哪一列的「上傳掃描檔」就把該合約 id 暫存起來
  const contractFileRef = useRef<HTMLInputElement>(null);
  const pendingContractId = useRef<string | null>(null);

  // 合約／報價單（模組四第 3 條）
  const [cDocType, setCDocType] = useState<DocType>("quotation");
  const [cOurRole, setCOurRole] = useState<OurRole>("contractor");
  const [cTitle, setCTitle] = useState("");
  const [cCounterparty, setCCounterparty] = useState("");
  const [cAmount, setCAmount] = useState("");
  const [cSignedOn, setCSignedOn] = useState("");
  const [cCopies, setCCopies] = useState("1");
  const [savingContract, setSavingContract] = useState(false);

  // 案情狀態變更（模組四第 2 條）。改狀態要理由，所以不能是即存下拉。
  const [newStatus, setNewStatus] = useState<ProjectStatus | "">("");
  const [statusReason, setStatusReason] = useState("");
  const [statusEffectiveOn, setStatusEffectiveOn] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  // add-member form
  const [newEmp, setNewEmp] = useState("");
  const [newRole, setNewRole] = useState<"member" | "lead">("member");
  const [newValue, setNewValue] = useState("");

  // 申請單資料（模組五）
  const [appForm, setAppForm] = useState<AppForm | null>(null);
  const [savingApp, setSavingApp] = useState(false);
  const [appSavedAt, setAppSavedAt] = useState<number | null>(null);

  // 開票／收款的小表單（模組五）
  const [invoiceFormId, setInvoiceFormId] = useState<string | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoicedOn, setInvoicedOn] = useState(todayKey());
  const [receiveFormId, setReceiveFormId] = useState<string | null>(null);
  const [receivedOn, setReceivedOn] = useState(todayKey());
  const [receivedAmount, setReceivedAmount] = useState("");

  // 副委託與協力技師（模組五）
  const [subDraft, setSubDraft] = useState<SubRow[]>([]);
  const [originalSubIds, setOriginalSubIds] = useState<string[]>([]);
  const [savingSubs, setSavingSubs] = useState(false);
  const [subsSavedAt, setSubsSavedAt] = useState<number | null>(null);
  const [expandedSub, setExpandedSub] = useState<string | null>(null);
  const [paymentsDraft, setPaymentsDraft] = useState<Record<string, SubcontractPayment[]>>({});
  const [originalPayments, setOriginalPayments] = useState<Record<string, SubcontractPayment[]>>({});
  const [savingPayments, setSavingPayments] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [detail, m, adj, docs, cs, bs, subs, d, e, ven, comp] = await Promise.all([
        getProjectDetail(projectId),
        getProjectMembers(projectId),
        getProjectAdjustments(projectId),
        getProjectDocuments(projectId),
        getContracts(projectId),
        getBillingSchedule(projectId).catch(() => emptyBillingSchedule()),
        getProjectSubcontracts(projectId).catch(() => emptySubcontractsResponse()),
        getDepartments(),
        getEmployees(),
        listVendors(),
        listCompanies(),
      ]);
      setProject(detail.project);
      setAccess(detail.access);
      setMoney(detail.money);
      setContracts(cs.contracts);
      setSchedule(bs);
      setDraft(
        bs.installments.map((i) => ({
          id: i.id,
          installmentNo: i.installmentNo,
          kind: i.kind,
          percentage: i.percentage,
          milestone: i.milestone,
          plannedOn: i.plannedOn,
          overrideAmount: i.overrideAmount,
          overrideReason: i.overrideReason,
          note: i.note,
        })),
      );
      const subRows = toSubRows(subs.subcontracts);
      setSubDraft(subRows);
      setOriginalSubIds(subRows.map((r) => r.id).filter((x): x is string => !!x));
      setPaymentsDraft(Object.fromEntries(subRows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setOriginalPayments(Object.fromEntries(subRows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setAppForm(appFormFrom(detail.project));
      setMembers(m.members);
      setAdjustments(adj.adjustments);
      setDocuments(docs.documents);
      setDepts(d.departments);
      setEmps(e.employees.filter((x) => x.status === "active"));
      setVendors(ven.vendors);
      setCompanies(comp.companies);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const isPool = project?.shareMode === "pool_pct";
  const canFinance = access.finance;

  // pool 模式的 % 加總（提示是否超過 100）。
  const pctTotal = members.reduce((s, m) => s + (m.sharePct ?? 0), 0);

  function humanError(err: unknown, fallback: string): string {
    const msg = err instanceof Error ? err.message : fallback;
    for (const [code, text] of Object.entries(STATUS_ERRORS)) {
      if (msg.includes(code)) return text;
    }
    if (msg.includes("code_immutable")) return "專案編號不可變更。";
    return msg;
  }

  async function saveProjectField(patch: Parameters<typeof updateProjectFields>[1]) {
    if (!project) return;
    setError(null);
    try {
      await updateProjectFields(project.id, patch);
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  /* ── 申請單資料（模組五） ─────────────────────────────────────── */

  function patchScopeRow(idx: number, patch: Partial<DesignScopeItem>) {
    setAppForm((f) => (f ? { ...f, designScope: f.designScope.map((r, i) => (i === idx ? { ...r, ...patch } : r)) } : f));
  }
  function addScopeRow() {
    setAppForm((f) => (f ? { ...f, designScope: [...f.designScope, { discipline: "", item: "", amount: null }] } : f));
  }
  function removeScopeRow(idx: number) {
    setAppForm((f) => (f ? { ...f, designScope: f.designScope.filter((_, i) => i !== idx) } : f));
  }

  async function saveApplication() {
    if (!appForm || !project) return;
    setSavingApp(true);
    setError(null);
    try {
      const engineers: ProjectEngineers = {};
      for (const d of ENGINEER_DISCIPLINES) {
        const v = appForm.engineers[d];
        engineers[d] = v.vendorId || (v.name && v.name.trim()) ? { vendorId: v.vendorId, name: v.name } : null;
      }
      await updateProjectFields(project.id, {
        siteAddress: appForm.siteAddress.trim() || null,
        siteAreaM2: appForm.siteAreaM2 === "" ? null : Number(appForm.siteAreaM2),
        designScope: appForm.designScope
          .filter((row) => row.discipline.trim())
          .map((row) => ({ discipline: row.discipline.trim(), item: row.item?.trim() || null, amount: row.amount })),
        invoiceType: appForm.invoiceType || null,
        paymentMethod: appForm.paymentMethod || null,
        closingDay: appForm.closingDay.trim() || null,
        paymentDay: appForm.paymentDay.trim() || null,
        otherExpenses: appForm.otherExpenses === "" ? null : Number(appForm.otherExpenses),
        engineers,
      });
      setAppSavedAt(Date.now());
      await load();
    } catch (err) {
      setError(humanizeProjectExtError(err, "儲存申請單資料失敗"));
    } finally {
      setSavingApp(false);
    }
  }

  /* ── 請款期程（模組四第 4 條）＋ P3 開票／收款 ─────────────────── */

  function patchDraft(idx: number, patch: Partial<InstallmentInputExt>) {
    setDraft((d) => d.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }

  function addRow() {
    const nextNo = draft.reduce((m, r) => Math.max(m, r.installmentNo), 0) + 1;
    setDraft((d) => [...d, { installmentNo: nextNo, percentage: null, milestone: "" }]);
  }

  function removeRow(idx: number) {
    setDraft((d) => d.filter((_, i) => i !== idx));
  }

  /** 平均分配百分比——這正是客戶說的「不要用 Excel 拉格」。 */
  function splitEvenly() {
    if (draft.length === 0) return;
    const pct = Math.round((100 / draft.length) * 1000) / 1000;
    setDraft((d) => d.map((row) => ({ ...row, percentage: pct })));
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setError(null);
    try {
      const res = await saveBillingSchedule(projectId, draft);
      setSchedule(res);
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, humanError(err, "儲存期程失敗")));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function markBilled(id: string) {
    setError(null);
    try {
      setSchedule(await billInstallmentExt(id));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, humanError(err, "標記請款失敗")));
    }
  }

  async function cancelBilled(id: string) {
    const reason = window.prompt("取消請款的理由？");
    if (!reason?.trim()) return;
    setError(null);
    try {
      setSchedule(await unbillInstallmentExt(id, reason.trim()));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "取消請款失敗"));
    }
  }

  async function submitInvoice(id: string) {
    if (!invoiceNo.trim()) {
      setError("請輸入發票號碼");
      return;
    }
    setError(null);
    try {
      setSchedule(await invoiceBilling(id, { invoiceNo: invoiceNo.trim(), invoicedOn }));
      setInvoiceFormId(null);
      setInvoiceNo("");
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "標記開票失敗"));
    }
  }
  async function cancelInvoice(id: string) {
    const reason = window.prompt("取消開票的理由？");
    if (!reason?.trim()) return;
    setError(null);
    try {
      setSchedule(await uninvoiceBilling(id, reason.trim()));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "取消開票失敗"));
    }
  }
  async function submitReceive(id: string) {
    setError(null);
    try {
      setSchedule(await receiveBilling(id, { receivedOn, receivedAmount: receivedAmount === "" ? undefined : Number(receivedAmount) }));
      setReceiveFormId(null);
      setReceivedAmount("");
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "標記入帳失敗"));
    }
  }
  async function cancelReceive(id: string) {
    const reason = window.prompt("取消入帳的理由？");
    if (!reason?.trim()) return;
    setError(null);
    try {
      setSchedule(await unreceiveBilling(id, reason.trim()));
      await load();
    } catch (err) {
      setError(humanizeBillingError(err, "取消入帳失敗"));
    }
  }

  /* ── 副委託與協力技師（模組五） ───────────────────────────────── */

  function patchSub(idx: number, patch: Partial<Subcontract>) {
    setSubDraft((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addSubRow() {
    setSubDraft((rows) => [
      ...rows,
      {
        _key: newSubKey(), kind: "subcontract", discipline: "", vendorId: null, vendorName: "",
        contact: "", item: "", amount: 0, billingBasis: "", orderType: null,
        withholdingRate: 0.1, withholdingThreshold: 20000, note: "",
      },
    ]);
  }
  function removeSubRow(idx: number) {
    setSubDraft((rows) => rows.filter((_, i) => i !== idx));
  }

  async function saveSubcontracts() {
    const removed = originalSubIds.filter((id) => !subDraft.some((r) => r.id === id));
    let deleteReason: string | undefined;
    if (removed.length > 0) {
      const r = window.prompt(`確定要移除 ${removed.length} 筆下包／技師？請填理由（有已付款期別的無法移除）`);
      if (!r?.trim()) return;
      deleteReason = r.trim();
    }
    setSavingSubs(true);
    setError(null);
    try {
      const body = subDraft.map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        kind: r.kind,
        discipline: r.discipline?.trim() || null,
        vendorId: r.vendorId || null,
        vendorName: r.vendorName?.trim() || null,
        contact: r.contact?.trim() || null,
        item: r.item?.trim() || null,
        amount: r.amount || 0,
        billingBasis: r.billingBasis?.trim() || null,
        orderType: r.orderType || null,
        withholdingRate: r.withholdingRate,
        withholdingThreshold: r.withholdingThreshold,
        note: r.note?.trim() || null,
      }));
      const res = await putProjectSubcontracts(projectId, { subcontracts: body, deleteReason });
      const rows = toSubRows(res.subcontracts);
      setSubDraft(rows);
      setOriginalSubIds(rows.map((r) => r.id).filter((x): x is string => !!x));
      setPaymentsDraft(Object.fromEntries(rows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setOriginalPayments(Object.fromEntries(rows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setSubsSavedAt(Date.now());
      await load();
    } catch (err) {
      setError(humanizeSubcontractError(err, "儲存副委託失敗"));
    } finally {
      setSavingSubs(false);
    }
  }

  function toggleExpand(subId: string) {
    setExpandedSub((cur) => (cur === subId ? null : subId));
  }
  function patchPayment(subId: string, idx: number, patch: Partial<SubcontractPayment>) {
    setPaymentsDraft((d) => ({ ...d, [subId]: (d[subId] ?? []).map((p, i) => (i === idx ? { ...p, ...patch } : p)) }));
  }
  function addPaymentRow(subId: string) {
    setPaymentsDraft((d) => {
      const cur = d[subId] ?? [];
      const nextNo = cur.reduce((m, p) => Math.max(m, p.installmentNo), 0) + 1;
      return { ...d, [subId]: [...cur, { installmentNo: nextNo, percentage: null, dueWhen: "", paidOn: null, paidAmount: null }] };
    });
  }
  function removePaymentRow(subId: string, idx: number) {
    setPaymentsDraft((d) => ({ ...d, [subId]: (d[subId] ?? []).filter((_, i) => i !== idx) }));
  }
  async function saveSubcontractPayments(subId: string) {
    const payments = paymentsDraft[subId] ?? [];
    const original = originalPayments[subId] ?? [];
    const unpaying = payments.some((p) => {
      const orig = original.find((o) => o.installmentNo === p.installmentNo);
      return !!orig?.paidOn && !p.paidOn;
    });
    let reason: string | undefined;
    if (unpaying) {
      const r = window.prompt("把已付款的期別改回未付，理由？");
      if (!r?.trim()) return;
      reason = r.trim();
    }
    setSavingPayments(subId);
    setError(null);
    try {
      const res = await putSubcontractPayments(projectId, subId, {
        payments: payments.map((p) => ({
          ...(p.id ? { id: p.id } : {}),
          installmentNo: p.installmentNo,
          percentage: p.percentage,
          dueWhen: p.dueWhen?.trim() || null,
          paidOn: p.paidOn || null,
          paidAmount: p.paidAmount,
          payingCompanyId: p.payingCompanyId || null,
          receiptIssuerCompanyId: p.receiptIssuerCompanyId || null,
          receiptRef: p.receiptRef?.trim() || null,
          note: p.note?.trim() || null,
        })),
        reason,
      });
      const nextPayments = res.subcontract.payments ?? [];
      setSubDraft((rows) => rows.map((r) => (r.id === subId ? { ...res.subcontract, _key: r._key } : r)));
      setPaymentsDraft((d) => ({ ...d, [subId]: nextPayments }));
      setOriginalPayments((d) => ({ ...d, [subId]: nextPayments }));
      await load();
    } catch (err) {
      setError(humanizeSubcontractError(err, "儲存期款失敗"));
    } finally {
      setSavingPayments(null);
    }
  }

  /* ── 合約與報價單、案情、成員、文件（既有邏輯不變） ───────────── */

  async function addContract() {
    if (!cTitle.trim()) {
      setError("請輸入文件名稱");
      return;
    }
    setSavingContract(true);
    setError(null);
    try {
      await createContract(projectId, {
        docType: cDocType,
        ourRole: cOurRole,
        title: cTitle.trim(),
        counterparty: cCounterparty.trim() || null,
        amount: cAmount === "" ? null : Number(cAmount),
        signedOn: cSignedOn || null,
        copies: Number(cCopies) || 1,
      });
      setCTitle("");
      setCCounterparty("");
      setCAmount("");
      setCSignedOn("");
      setCCopies("1");
      await load();
    } catch (err) {
      setError(humanError(err, "新增文件失敗"));
    } finally {
      setSavingContract(false);
    }
  }

  async function markStamped(c: Contract, paidOn: string | null) {
    setError(null);
    try {
      await updateContract(c.id, { stampDutyPaidOn: paidOn });
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  async function removeContract(c: Contract) {
    const reason = window.prompt(`作廢「${c.title}」的理由？`);
    if (!reason?.trim()) return;
    setError(null);
    try {
      await deleteContract(c.id, reason.trim());
      await load();
    } catch (err) {
      setError(humanError(err, "作廢失敗"));
    }
  }

  async function changeStatus() {
    if (!project || !newStatus) return;
    if (!statusReason.trim()) {
      setError(STATUS_ERRORS.status_reason_required);
      return;
    }
    setSavingStatus(true);
    setError(null);
    try {
      await updateProjectFields(project.id, {
        status: newStatus,
        statusReason: statusReason.trim(),
        statusEffectiveOn: statusEffectiveOn || null,
      });
      setNewStatus("");
      setStatusReason("");
      setStatusEffectiveOn("");
      await load();
    } catch (err) {
      setError(humanError(err, "變更狀態失敗"));
    } finally {
      setSavingStatus(false);
    }
  }

  async function addMember() {
    if (!newEmp) {
      setError("請選擇員工");
      return;
    }
    setError(null);
    try {
      const val = newValue ? Number(newValue) : null;
      await addProjectMember(projectId, {
        employeeId: newEmp,
        roleInProject: newRole,
        sharePct: isPool ? val : null,
        shareAmount: isPool ? null : val,
      });
      setNewEmp("");
      setNewRole("member");
      setNewValue("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增成員失敗");
    }
  }

  async function saveMemberShare(m: ProjectMember, raw: string) {
    const val = raw === "" ? null : Number(raw);
    setError(null);
    try {
      await updateProjectMember(projectId, m.id, isPool ? { sharePct: val } : { shareAmount: val });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "調整分潤失敗");
    }
  }

  async function toggleLead(m: ProjectMember) {
    setError(null);
    try {
      await updateProjectMember(projectId, m.id, {
        roleInProject: m.roleInProject === "lead" ? "member" : "lead",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    }
  }

  async function removeMember(m: ProjectMember) {
    if (!confirm(`確定移除成員「${m.name ?? m.employeeId}」？`)) return;
    setError(null);
    try {
      await removeProjectMember(projectId, m.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失敗");
    }
  }

  async function onUpload(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      await uploadProjectDocument(projectId, file);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    }
  }

  function pickContractScan(contractId: string) {
    pendingContractId.current = contractId;
    contractFileRef.current?.click();
  }

  async function onUploadContractScan(file: File | undefined) {
    const contractId = pendingContractId.current;
    pendingContractId.current = null;
    if (contractFileRef.current) contractFileRef.current.value = "";
    if (!file || !contractId) return;
    setError(null);
    try {
      await uploadProjectDocument(projectId, file, contractId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    }
  }

  // 掃描檔跟著合約列顯示，專案文件區只列專案層級的；作廢合約的掃描檔會退回專案文件區（帶標記），不會消失。
  const activeContractIds = new Set(contracts.map((c) => c.id));
  const scansByContract = new Map<string, ProjectDocument[]>();
  const projectLevelDocs: ProjectDocument[] = [];
  for (const doc of documents) {
    if (doc.contractId && activeContractIds.has(doc.contractId)) {
      const list = scansByContract.get(doc.contractId) ?? [];
      list.push(doc);
      scansByContract.set(doc.contractId, list);
    } else {
      projectLevelDocs.push(doc);
    }
  }

  async function removeDoc(doc: ProjectDocument) {
    if (!confirm(`確定刪除文件「${doc.fileName}」？`)) return;
    setError(null);
    try {
      await deleteProjectDocument(projectId, doc.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  if (loading) return <Empty>載入中…</Empty>;
  if (!project) return <ErrorText>{error ?? "找不到專案"}</ErrorText>;

  const latestDoc = latestDocumentOf(contracts);
  const headerDesc = [
    project.code ? `編號 ${project.code}（不可變更）` : null,
    project.client?.name ? `客戶：${project.client.name}` : null,
    project.kind !== "main" ? `類型：${PROJECT_KIND_LABELS[project.kind]}` : null,
  ].filter(Boolean).join("　");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageHeader title={project.name} desc={headerDesc || undefined} />
        <div className="flex items-center gap-3">
          <Link href={`/admin/projects/${project.id}/application`} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
            列印申請單 →
          </Link>
          <Link href="/admin/projects" className="text-sm text-gray-500 hover:underline">← 專案列表</Link>
        </div>
      </div>

      {/* 專案設定 */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">專案設定</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>所屬部門</label>
            <select
              className={inputCls}
              value={project.deptId ?? ""}
              onChange={(e) => saveProjectField({ deptId: e.target.value || null })}
            >
              <option value="">不指定</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>專案負責人</label>
            <select
              className={inputCls}
              value={project.leadEmpId ?? ""}
              onChange={(e) => saveProjectField({ leadEmpId: e.target.value || null })}
            >
              <option value="">不指定</option>
              {emps.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>分潤模式</label>
            <select
              className={inputCls}
              value={project.shareMode}
              onChange={(e) => saveProjectField({ shareMode: e.target.value as ShareMode })}
            >
              <option value="pool_pct">獎金池 × 百分比</option>
              <option value="fixed_amount">直接填每人金額</option>
            </select>
          </div>
          {isPool && (
            <div>
              <label className={labelCls}>獎金池總額</label>
              <input
                className={inputCls}
                type="number"
                min="0"
                defaultValue={project.bonusPool ?? ""}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== project.bonusPool) saveProjectField({ bonusPool: v });
                }}
              />
            </div>
          )}
          <div>
            <label className={labelCls}>歸屬年度</label>
            <input
              className={inputCls}
              type="number"
              min="2000"
              max="2100"
              defaultValue={project.fiscalYear ?? ""}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                if (v !== project.fiscalYear) saveProjectField({ fiscalYear: v });
              }}
            />
            <p className="mt-1 text-xs text-gray-400">
              報表與獎金歸在哪一年。編號裡的年度是建立年，已印在合約上，不隨這裡改動。
            </p>
          </div>
          <div>
            <label className={labelCls}>預定起始日</label>
            <input
              className={inputCls}
              type="date"
              defaultValue={project.startsOn ?? ""}
              onBlur={(e) => {
                const v = e.target.value || null;
                if (v !== (project.startsOn ?? null)) saveProjectField({ startsOn: v });
              }}
            />
          </div>
          <div>
            <label className={labelCls}>預定完工日</label>
            <input
              className={inputCls}
              type="date"
              defaultValue={project.endsOn ?? ""}
              onBlur={(e) => {
                const v = e.target.value || null;
                if (v !== (project.endsOn ?? null)) saveProjectField({ endsOn: v });
              }}
            />
            <p className="mt-1 text-xs text-gray-400">
              甘特圖與進度示警的依據。過了完工日還沒結案會被示警。
            </p>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {/* 申請單資料（模組五） */}
      {appForm && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-700">申請單資料</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>設計地點</label>
              <input className={inputCls} value={appForm.siteAddress} onChange={(e) => setAppForm((f) => f && { ...f, siteAddress: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>設計面積</label>
              <div className="flex items-center gap-2">
                <input className={inputCls} type="number" min="0" value={appForm.siteAreaM2} onChange={(e) => setAppForm((f) => f && { ...f, siteAreaM2: e.target.value })} />
                <span className="shrink-0 text-sm text-gray-400">m²</span>
              </div>
            </div>
            <div>
              <label className={labelCls}>發票聯式</label>
              <select className={inputCls} value={appForm.invoiceType} onChange={(e) => setAppForm((f) => f && { ...f, invoiceType: e.target.value as InvoiceType | "" })}>
                <option value="">未指定{project.client?.invoiceType ? `（客戶預設：${INVOICE_TYPE_LABELS[project.client.invoiceType]}）` : ""}</option>
                {(Object.keys(INVOICE_TYPE_LABELS) as InvoiceType[]).map((v) => (
                  <option key={v} value={v}>{INVOICE_TYPE_LABELS[v]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>付款方式</label>
              <select className={inputCls} value={appForm.paymentMethod} onChange={(e) => setAppForm((f) => f && { ...f, paymentMethod: e.target.value as PaymentMethod | "" })}>
                <option value="">未指定{project.client?.paymentMethod ? `（客戶預設：${PAYMENT_METHOD_LABELS[project.client.paymentMethod]}）` : ""}</option>
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((v) => (
                  <option key={v} value={v}>{PAYMENT_METHOD_LABELS[v]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>結帳日</label>
              <input className={inputCls} value={appForm.closingDay} onChange={(e) => setAppForm((f) => f && { ...f, closingDay: e.target.value })} placeholder={project.client?.closingDay ?? "例：每月 5 日"} />
            </div>
            <div>
              <label className={labelCls}>付款日</label>
              <input className={inputCls} value={appForm.paymentDay} onChange={(e) => setAppForm((f) => f && { ...f, paymentDay: e.target.value })} placeholder={project.client?.paymentDay ?? "例：次月 10 日"} />
            </div>
            <div>
              <label className={labelCls}>訂單類型（沿用合約）</label>
              <p className={`${inputCls} bg-gray-50 text-gray-500`}>
                {latestDoc ? DOC_TYPE_LABELS[latestDoc.docType] : "尚無合約或報價單"}
              </p>
            </div>
            {canFinance && (
              <div>
                <label className={labelCls}>其他支出（差旅、規費等，計入損益）</label>
                <input className={inputCls} type="number" min="0" value={appForm.otherExpenses} onChange={(e) => setAppForm((f) => f && { ...f, otherExpenses: e.target.value })} />
              </div>
            )}
          </div>

          <div className="mt-4 border-t pt-4">
            <div className="mb-2 flex items-center justify-between">
              <label className={labelCls}>科別與服務項目</label>
              <button type="button" className="text-xs text-gray-500 hover:underline" onClick={addScopeRow}>＋ 新增一列</button>
            </div>
            {appForm.designScope.length === 0 ? (
              <Empty>尚未填寫</Empty>
            ) : (
              <div className="space-y-2">
                {appForm.designScope.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_140px_auto] sm:items-center">
                    <input className={inputCls} list="discipline-suggestions" value={row.discipline} placeholder="科別" onChange={(e) => patchScopeRow(idx, { discipline: e.target.value })} />
                    <input className={inputCls} value={row.item ?? ""} placeholder="服務項目" onChange={(e) => patchScopeRow(idx, { item: e.target.value })} />
                    {canFinance ? (
                      <input className={inputCls} type="number" min="0" value={row.amount ?? ""} placeholder="金額" onChange={(e) => patchScopeRow(idx, { amount: e.target.value === "" ? null : Number(e.target.value) })} />
                    ) : <div />}
                    <button type="button" className="justify-self-start text-xs text-gray-400 hover:text-red-600 sm:justify-self-center" onClick={() => removeScopeRow(idx)}>移除</button>
                  </div>
                ))}
              </div>
            )}
            <datalist id="discipline-suggestions">
              {COMMON_DISCIPLINES.map((d) => <option key={d} value={d} />)}
            </datalist>
          </div>

          <div className="mt-4 border-t pt-4">
            <label className={labelCls}>協力技師</label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {ENGINEER_DISCIPLINES.map((d) => (
                <div key={d}>
                  <p className="mb-1 text-xs text-gray-500">{ENGINEER_DISCIPLINE_LABELS[d]}</p>
                  <VendorCombo
                    vendors={vendors}
                    vendorId={appForm.engineers[d].vendorId}
                    name={appForm.engineers[d].name}
                    onChange={(v) => setAppForm((f) => f && { ...f, engineers: { ...f.engineers, [d]: v } })}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <PrimaryButton onClick={saveApplication} disabled={savingApp}>{savingApp ? "儲存中…" : "儲存申請單資料"}</PrimaryButton>
            {appSavedAt && <span className="text-sm text-green-700">已儲存</span>}
          </div>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      {/* 金額（模組五，finance 權限才顯示） */}
      {canFinance && money && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-700">金額</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs text-gray-500">
                未稅金額
                {money.amountSource && (
                  <span className="ml-1 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">
                    {money.amountSource === "contract" ? "合約" : "報價單"}
                  </span>
                )}
              </p>
              <p className="text-lg font-semibold text-gray-900">{fmtMoney(money.amountUntaxed)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">營業稅</p>
              <p className="text-lg font-semibold text-gray-900">{fmtMoney(money.taxAmount)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">含稅總額</p>
              <p className="text-lg font-semibold text-gray-900">{fmtMoney(money.amountTotal)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">未收</p>
              <p className="text-lg font-semibold text-red-600">{fmtMoney(money.unreceived)}</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div><p className="text-xs text-gray-500">已請款</p><p className="font-medium text-gray-800">{fmtMoney(money.billedTotal)}</p></div>
            <div><p className="text-xs text-gray-500">已開票</p><p className="font-medium text-gray-800">{fmtMoney(money.invoicedTotal)}</p></div>
            <div><p className="text-xs text-gray-500">已入帳</p><p className="font-medium text-gray-800">{fmtMoney(money.receivedTotal)}</p></div>
          </div>
          <div className="mt-4 space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
                <span>請款進度</span><span>{money.billingProgressPct ?? "—"}{money.billingProgressPct != null && "%"}</span>
              </div>
              <div className="h-2 rounded-full bg-gray-100">
                <div className="h-2 rounded-full bg-blue-400" style={{ width: `${Math.max(0, Math.min(100, money.billingProgressPct ?? 0))}%` }} />
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
                <span>收款進度</span><span>{money.receiptProgressPct ?? "—"}{money.receiptProgressPct != null && "%"}</span>
              </div>
              <div className="h-2 rounded-full bg-gray-100">
                <div className="h-2 rounded-full bg-green-400" style={{ width: `${Math.max(0, Math.min(100, money.receiptProgressPct ?? 0))}%` }} />
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* 合約與報價單（模組四第 3 條）。文件類型決定課不課印花稅。 */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-700">合約與報價單</h2>
          {project.hasSignedContract ? (
            <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">已簽約</span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">尚未簽約</span>
          )}
        </div>

        {contracts.length === 0 ? (
          <Empty>尚無文件</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">類型</th>
                  <th className="py-2 pr-3">名稱</th>
                  <th className="py-2 pr-3">對方</th>
                  <th className="py-2 pr-3 text-right">金額</th>
                  <th className="py-2 pr-3">簽訂日</th>
                  <th className="py-2 pr-3 text-right">印花稅</th>
                  <th className="py-2 pr-3">貼花</th>
                  <th className="py-2 pr-3">掃描檔</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${c.docType === "contract" ? "bg-blue-50 text-blue-700" : c.docType === "change_order" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600"}`}>
                        {DOC_TYPE_LABELS[c.docType]}
                      </span>
                      {c.version > 1 && <span className="ml-1 text-xs text-gray-400">v{c.version}</span>}
                    </td>
                    <td className="py-2 pr-3 font-medium text-gray-900">{c.title}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.counterparty ?? "—"}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">{fmtMoney(c.amount)}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.signedOn ?? "—"}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">
                      {!c.dutiable ? (
                        <span className="text-xs text-gray-400">不課</span>
                      ) : c.stampDutyAmount == null ? (
                        <span className="text-xs text-red-600" title="應貼花但沒有金額，算不出稅額">
                          缺金額
                        </span>
                      ) : (
                        fmtMoney(c.stampDutyAmount)
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {!c.dutiable ? (
                        "—"
                      ) : c.stampDutyPaidOn ? (
                        <button
                          type="button"
                          className="text-xs text-green-700 hover:underline"
                          onClick={() => markStamped(c, null)}
                          title="點一下取消標記"
                        >
                          已貼 {c.stampDutyPaidOn}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                          onClick={() => markStamped(c, new Date().toISOString().slice(0, 10))}
                        >
                          標記已貼花
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {(scansByContract.get(c.id) ?? []).map((doc) => (
                          <span key={doc.id} className="inline-flex items-center gap-1">
                            <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="text-xs" style={{ color: "var(--brand)" }} title={`${Math.round(doc.sizeBytes / 1024)} KB`}>
                              {doc.fileName}
                            </a>
                            <button type="button" className="text-xs text-gray-300 hover:text-red-600" onClick={() => removeDoc(doc)} title="刪除掃描檔">
                              ×
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                          onClick={() => pickContractScan(c.id)}
                        >
                          上傳掃描檔
                        </button>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-red-600"
                        onClick={() => removeContract(c)}
                      >
                        作廢
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <input
          ref={contractFileRef}
          type="file"
          className="hidden"
          onChange={(e) => onUploadContractScan(e.target.files?.[0])}
        />

        <div className="mt-4 border-t pt-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelCls}>類型</label>
              <select className={inputCls} value={cDocType} onChange={(e) => setCDocType(e.target.value as DocType)}>
                {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((v) => (
                  <option key={v} value={v}>{DOC_TYPE_LABELS[v]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">報價單不是契據，不課印花稅。</p>
            </div>
            <div>
              <label className={labelCls}>我方角色</label>
              <select className={inputCls} value={cOurRole} onChange={(e) => setCOurRole(e.target.value as OurRole)}>
                {(Object.keys(OUR_ROLE_LABELS) as OurRole[]).map((v) => (
                  <option key={v} value={v}>{OUR_ROLE_LABELS[v]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">承攬契據由承攬人貼花，發包出去的由下包貼。</p>
            </div>
            <div>
              <label className={labelCls}>文件名稱 *</label>
              <input className={inputCls} value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder="例如：官網改版承攬契約" />
            </div>
            <div>
              <label className={labelCls}>對方（業主／下包）</label>
              <input className={inputCls} value={cCounterparty} onChange={(e) => setCCounterparty(e.target.value)} placeholder="選填" />
            </div>
            <div>
              <label className={labelCls}>金額</label>
              <input className={inputCls} type="number" value={cAmount} onChange={(e) => setCAmount(e.target.value)} placeholder="追加減帳可填負數" />
            </div>
            <div>
              <label className={labelCls}>簽訂日</label>
              <input className={inputCls} type="date" value={cSignedOn} onChange={(e) => setCSignedOn(e.target.value)} />
              <p className="mt-1 text-xs text-gray-400">沒有簽訂日就不算已簽約，也不會進印花稅清單。</p>
            </div>
            <div>
              <label className={labelCls}>份數</label>
              <input className={inputCls} type="number" min="1" value={cCopies} onChange={(e) => setCCopies(e.target.value)} />
              <p className="mt-1 text-xs text-gray-400">同一憑證繕寫兩份以上，各份均應貼用。</p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <PrimaryButton onClick={addContract} disabled={savingContract}>
              {savingContract ? "新增中…" : "新增文件"}
            </PrimaryButton>
            <span className="text-xs text-gray-400">
              印花稅為系統試算，非申報值；承攬契據認定與免稅憑證請會計師確認。
            </span>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {/* 請款期程（模組四第 4 條）＋ P3 開票／收款。金額一律系統算，不手動拉格。 */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-700">分期請款期程</h2>
          {schedule?.contract.total == null ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
              還沒有合約，無法計算金額
            </span>
          ) : (
            <span className="text-xs text-gray-500">
              分母 {fmtMoney(schedule.contract.total)}
              <span className="text-gray-400">
                （主約 {fmtMoney(schedule.contract.base)}
                {schedule.contract.changeOrders !== 0 &&
                  ` ＋追加減 ${schedule.contract.changeOrders > 0 ? "+" : ""}${schedule.contract.changeOrders.toLocaleString()}`}
                ）
              </span>
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-2 w-14">期</th>
                <th className="py-2 pr-2">階段</th>
                <th className="py-2 pr-2 w-24">百分比</th>
                <th className="py-2 pr-2 w-36">預定日</th>
                <th className="py-2 pr-2 text-right">系統試算</th>
                <th className="py-2 pr-2 w-32 text-right">人工指定</th>
                <th className="py-2 pr-2">狀態</th>
                <th className="py-2 pr-2"></th>
              </tr>
            </thead>
            <tbody>
              {draft.map((rowDraft, idx) => {
                const saved = schedule?.installments.find((i) => i.id === rowDraft.id);
                const billed = !!saved?.billedOn;
                const received = !!saved?.receivedOn;
                const locked = billed || received;
                return (
                  <Fragment key={rowDraft.id ?? `new-${idx}`}>
                    <tr className="border-b last:border-0">
                      <td className="py-2 pr-2">
                        <input
                          className={`${inputCls} w-12`}
                          type="number"
                          min="1"
                          value={rowDraft.installmentNo}
                          disabled={locked}
                          onChange={(e) => patchDraft(idx, { installmentNo: Number(e.target.value) })}
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          className={inputCls}
                          value={rowDraft.milestone ?? ""}
                          placeholder="開工款／完成 50%／驗收款／保留款"
                          onChange={(e) => patchDraft(idx, { milestone: e.target.value })}
                        />
                        <select
                          className="mt-1 w-full rounded border border-gray-200 px-1 py-0.5 text-[11px] text-gray-500"
                          value={rowDraft.kind ?? "installment"}
                          disabled={locked}
                          onChange={(e) => patchDraft(idx, { kind: e.target.value as BillingKind })}
                        >
                          <option value="installment">一般分期</option>
                          <option value="guild_advance">技師公會代墊</option>
                        </select>
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          className={inputCls}
                          type="number"
                          step="0.001"
                          min="0"
                          max="100"
                          value={rowDraft.percentage ?? ""}
                          disabled={locked}
                          onChange={(e) =>
                            patchDraft(idx, {
                              percentage: e.target.value === "" ? null : Number(e.target.value),
                            })
                          }
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          className={inputCls}
                          type="date"
                          value={rowDraft.plannedOn ?? ""}
                          onChange={(e) => patchDraft(idx, { plannedOn: e.target.value || null })}
                        />
                      </td>
                      <td className="py-2 pr-2 text-right text-gray-600">
                        {saved?.calculatedAmount == null ? (
                          "—"
                        ) : (
                          <>
                            {fmtMoney(saved.calculatedAmount)}
                            {saved.residueApplied !== 0 && (
                              <span
                                className="block text-xs text-amber-600"
                                title="尾差落在最後一個未請款的期別，讓合計等於合約金額"
                              >
                                含尾差 {saved.residueApplied > 0 ? "+" : ""}
                                {saved.residueApplied.toLocaleString()}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          className={`${inputCls} text-right`}
                          type="number"
                          placeholder="—"
                          value={rowDraft.overrideAmount ?? ""}
                          disabled={locked}
                          onChange={(e) =>
                            patchDraft(idx, {
                              overrideAmount: e.target.value === "" ? null : Number(e.target.value),
                            })
                          }
                        />
                        {rowDraft.overrideAmount != null && (
                          <input
                            className={`${inputCls} mt-1`}
                            placeholder="理由 *"
                            value={rowDraft.overrideReason ?? ""}
                            onChange={(e) => patchDraft(idx, { overrideReason: e.target.value })}
                          />
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {billed ? (
                          <button
                            type="button"
                            className="text-xs text-green-700 hover:underline"
                            onClick={() => rowDraft.id && cancelBilled(rowDraft.id)}
                            title={`已請款 ${fmtMoney(saved?.billedAmount ?? null)}，點一下取消`}
                          >
                            已請款 {saved?.billedOn}
                          </button>
                        ) : rowDraft.id ? (
                          <button
                            type="button"
                            className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                            onClick={() => rowDraft.id && markBilled(rowDraft.id)}
                          >
                            標記請款
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">存檔後可請款</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-right">
                        {!locked && (
                          <button
                            type="button"
                            className="text-xs text-gray-400 hover:text-red-600"
                            onClick={() => removeRow(idx)}
                          >
                            移除
                          </button>
                        )}
                      </td>
                    </tr>
                    {saved && (
                      <tr className="border-b bg-gray-50/60 text-xs last:border-0">
                        <td colSpan={8} className="py-1.5 pl-8 pr-2">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                            {saved.kind === "guild_advance" && (
                              <span className="rounded bg-purple-50 px-1.5 py-0.5 text-[10px] text-purple-700">
                                {BILLING_KIND_LABELS.guild_advance}
                              </span>
                            )}
                            {/* 開票 */}
                            {saved.invoicedOn ? (
                              <button type="button" className="text-green-700 hover:underline" onClick={() => cancelInvoice(saved.id)}>
                                已開票 {saved.invoiceNo}／{saved.invoicedOn}（點取消）
                              </button>
                            ) : !billed ? (
                              <span className="text-gray-300">未請款，尚無法開票</span>
                            ) : invoiceFormId === saved.id ? (
                              <span className="flex flex-wrap items-center gap-1.5">
                                <input className="w-28 rounded border border-gray-300 px-1.5 py-0.5" placeholder="發票號碼" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
                                <input className="rounded border border-gray-300 px-1.5 py-0.5" type="date" value={invoicedOn} onChange={(e) => setInvoicedOn(e.target.value)} />
                                <button type="button" className="rounded bg-gray-700 px-2 py-0.5 text-white" onClick={() => submitInvoice(saved.id)}>確認</button>
                                <button type="button" className="text-gray-400" onClick={() => setInvoiceFormId(null)}>取消</button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="rounded border border-gray-200 bg-white px-2 py-0.5 text-gray-600 hover:bg-gray-50"
                                onClick={() => { setInvoiceFormId(saved.id); setInvoiceNo(""); setInvoicedOn(todayKey()); }}
                              >
                                標記開票
                              </button>
                            )}
                            {/* 入帳 */}
                            {saved.receivedOn ? (
                              <button type="button" className="text-green-700 hover:underline" onClick={() => cancelReceive(saved.id)}>
                                已入帳 {fmtMoney(saved.receivedAmount)}／{saved.receivedOn}（點取消）
                              </button>
                            ) : receiveFormId === saved.id ? (
                              <span className="flex flex-wrap items-center gap-1.5">
                                <input className="rounded border border-gray-300 px-1.5 py-0.5" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
                                <input className="w-24 rounded border border-gray-300 px-1.5 py-0.5 text-right" type="number" placeholder={fmtMoney(saved.effectiveAmount)} value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)} />
                                <button type="button" className="rounded bg-gray-700 px-2 py-0.5 text-white" onClick={() => submitReceive(saved.id)}>確認</button>
                                <button type="button" className="text-gray-400" onClick={() => setReceiveFormId(null)}>取消</button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className="rounded border border-gray-200 bg-white px-2 py-0.5 text-gray-600 hover:bg-gray-50"
                                onClick={() => { setReceiveFormId(saved.id); setReceivedOn(todayKey()); setReceivedAmount(""); }}
                              >
                                標記入帳
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            {schedule && draft.length > 0 && (
              <tfoot>
                <tr className="border-t-2 font-medium">
                  <td className="py-2 pr-2" colSpan={2}>合計</td>
                  <td className="py-2 pr-2">
                    <span className={schedule.summary.percentageTotal === 100 ? "text-gray-700" : "text-amber-600"}>
                      {schedule.summary.percentageTotal}%
                      {schedule.summary.percentageTotal !== 100 && " ⚠️"}
                    </span>
                  </td>
                  <td className="py-2 pr-2"></td>
                  <td className="py-2 pr-2 text-right" colSpan={2}>
                    {fmtMoney(schedule.summary.effectiveTotal)}
                  </td>
                  <td className="py-2 pr-2 text-xs text-gray-500" colSpan={2}>
                    已請款 {fmtMoney(schedule.summary.billedTotal)}／
                    未請款 {fmtMoney(schedule.summary.unbilledTotal)}
                    {schedule.summary.guildAdvanceTotal !== 0 && `／公會代墊 ${fmtMoney(schedule.summary.guildAdvanceTotal)}`}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {schedule && schedule.summary.percentageTotal !== 100 && draft.length > 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            百分比合計為 {schedule.summary.percentageTotal}%，不是 100%。
            金額仍會補平到合約總額（差額落在最後一個未請款的期別），但期程本身可能還沒設定完。
          </p>
        )}
        {schedule && schedule.summary.unallocatedResidue !== 0 && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
            有 {fmtMoney(schedule.summary.unallocatedResidue)} 元無法分配——
            所有期別都已請款或已人工指定金額，沒有期別可以吸收差額。
            請新增一期，或調整人工指定的金額。
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={saveSchedule} disabled={savingSchedule}>
            {savingSchedule ? "儲存中…" : "儲存期程"}
          </PrimaryButton>
          <button
            type="button"
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            onClick={addRow}
          >
            ＋ 新增一期
          </button>
          <button
            type="button"
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            onClick={splitEvenly}
            disabled={draft.length === 0}
          >
            平均分配百分比
          </button>
          <span className="text-xs text-gray-400">
            金額一律由系統算：末期自動吸收四捨五入的尾差，合計必然等於合約金額。
          </span>
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {/* 副委託與協力技師（模組五） */}
      {canFinance && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">副委託與協力技師</h2>
            <button type="button" onClick={addSubRow} className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
              ＋ 新增一列
            </button>
          </div>
          {subDraft.length === 0 ? (
            <Empty>尚無下包或技師</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="py-2 pr-2">類型</th>
                    <th className="py-2 pr-2">科別</th>
                    <th className="py-2 pr-2 min-w-[150px]">單位</th>
                    <th className="py-2 pr-2">聯絡</th>
                    <th className="py-2 pr-2">項目</th>
                    <th className="py-2 pr-2 text-right">金額</th>
                    <th className="py-2 pr-2">請款依據</th>
                    <th className="py-2 pr-2">訂單類型</th>
                    <th className="py-2 pr-2 text-right">代扣率%</th>
                    <th className="py-2 pr-2 text-right">門檻</th>
                    <th className="py-2 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {subDraft.map((row, idx) => (
                    <Fragment key={row._key}>
                      <tr className="border-b last:border-0 align-top">
                        <td className="py-1.5 pr-2">
                          <select className={inputCls} value={row.kind} onChange={(e) => patchSub(idx, { kind: e.target.value as SubcontractKind })}>
                            <option value="subcontract">下包工程</option>
                            <option value="technician">技師簽證費</option>
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <input className={inputCls} list="discipline-suggestions" value={row.discipline ?? ""} onChange={(e) => patchSub(idx, { discipline: e.target.value })} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <VendorCombo vendors={vendors} vendorId={row.vendorId} name={row.vendorName} onChange={(v) => patchSub(idx, { vendorId: v.vendorId, vendorName: v.name })} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input className={inputCls} value={row.contact ?? ""} onChange={(e) => patchSub(idx, { contact: e.target.value })} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input className={inputCls} value={row.item ?? ""} onChange={(e) => patchSub(idx, { item: e.target.value })} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input className={`${inputCls} text-right`} type="number" min="0" value={row.amount} onChange={(e) => patchSub(idx, { amount: Number(e.target.value) || 0 })} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input className={inputCls} value={row.billingBasis ?? ""} onChange={(e) => patchSub(idx, { billingBasis: e.target.value })} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <select className={inputCls} value={row.orderType ?? ""} onChange={(e) => patchSub(idx, { orderType: (e.target.value || null) as OrderType | null })}>
                            <option value="">未定</option>
                            <option value="quotation">報價單</option>
                            <option value="contract">合約</option>
                          </select>
                        </td>
                        <td className="py-1.5 pr-2">
                          <input
                            className={`${inputCls} text-right`}
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={Math.round(row.withholdingRate * 1000) / 10}
                            onChange={(e) => patchSub(idx, { withholdingRate: (Number(e.target.value) || 0) / 100 })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <input className={`${inputCls} text-right`} type="number" min="0" value={row.withholdingThreshold} onChange={(e) => patchSub(idx, { withholdingThreshold: Number(e.target.value) || 0 })} />
                        </td>
                        <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                          {row.id ? (
                            <button type="button" className="mr-2 text-xs text-gray-500 hover:underline" onClick={() => toggleExpand(row.id as string)}>
                              {expandedSub === row.id ? "收合期款" : "期款"}
                            </button>
                          ) : (
                            <span className="mr-2 text-xs text-gray-300" title="存檔後才能編輯期款">期款</span>
                          )}
                          <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => removeSubRow(idx)}>移除</button>
                        </td>
                      </tr>
                      {row.id && expandedSub === row.id && (
                        <tr className="border-b bg-gray-50/60 last:border-0">
                          <td colSpan={11} className="p-3">
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b text-left text-gray-500">
                                    <th className="py-1 pr-2">期別</th>
                                    <th className="py-1 pr-2">%</th>
                                    <th className="py-1 pr-2 text-right">金額</th>
                                    <th className="py-1 pr-2">應付時機</th>
                                    <th className="py-1 pr-2">匯款單</th>
                                    <th className="py-1 pr-2">放款日</th>
                                    <th className="py-1 pr-2 text-right">實付</th>
                                    <th className="py-1 pr-2 text-right">代扣</th>
                                    <th className="py-1 pr-2">放款公司</th>
                                    <th className="py-1 pr-2">收據抬頭</th>
                                    <th className="py-1 pr-2">收據編號</th>
                                    <th className="py-1 pr-2"></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(paymentsDraft[row.id] ?? []).map((p, pIdx) => {
                                    const orig = (originalPayments[row.id as string] ?? []).find((o) => o.installmentNo === p.installmentNo);
                                    const originallyPaid = !!orig?.paidOn;
                                    return (
                                      <tr key={p.id ?? `new-${pIdx}`} className="border-b last:border-0">
                                        <td className="py-1 pr-2">
                                          <input className="w-12 rounded border border-gray-300 px-1 py-0.5" type="number" min="1" value={p.installmentNo} disabled={originallyPaid} onChange={(e) => patchPayment(row.id as string, pIdx, { installmentNo: Number(e.target.value) })} />
                                        </td>
                                        <td className="py-1 pr-2">
                                          <input className="w-16 rounded border border-gray-300 px-1 py-0.5" type="number" step="0.01" min="0" max="100" value={p.percentage ?? ""} disabled={originallyPaid} onChange={(e) => patchPayment(row.id as string, pIdx, { percentage: e.target.value === "" ? null : Number(e.target.value) })} />
                                        </td>
                                        <td className="py-1 pr-2 text-right text-gray-600">{fmtMoney(p.effectiveAmount ?? p.amount ?? null)}</td>
                                        <td className="py-1 pr-2">
                                          <input className="w-24 rounded border border-gray-300 px-1 py-0.5" value={p.dueWhen ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { dueWhen: e.target.value })} />
                                        </td>
                                        <td className="py-1 pr-2">
                                          {p.disbursementNo ? (
                                            <Link href={`/admin/disbursements/${p.disbursementId}`} className="hover:underline" style={{ color: "var(--brand)" }}>
                                              {p.disbursementNo}
                                            </Link>
                                          ) : (
                                            <span className="text-gray-300">—</span>
                                          )}
                                        </td>
                                        <td className="py-1 pr-2">
                                          {p.disbursementId ? (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{p.paidOn ?? "—"}</span>
                                          ) : (
                                            <input className="rounded border border-gray-300 px-1 py-0.5" type="date" value={p.paidOn ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { paidOn: e.target.value || null })} />
                                          )}
                                        </td>
                                        <td className="py-1 pr-2">
                                          {p.disbursementId ? (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{fmtMoney(p.paidAmount ?? null)}</span>
                                          ) : (
                                            <input className="w-20 rounded border border-gray-300 px-1 py-0.5 text-right" type="number" value={p.paidAmount ?? ""} placeholder={fmtMoney(p.netAmount ?? null)} onChange={(e) => patchPayment(row.id as string, pIdx, { paidAmount: e.target.value === "" ? null : Number(e.target.value) })} />
                                          )}
                                        </td>
                                        <td className="py-1 pr-2 text-right text-gray-500">{fmtMoney(p.withheldAmount ?? null)}</td>
                                        <td className="py-1 pr-2">
                                          {p.disbursementId ? (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{companies.find((c) => c.id === p.payingCompanyId)?.name ?? "—"}</span>
                                          ) : (
                                            <select className="rounded border border-gray-300 px-1 py-0.5" value={p.payingCompanyId ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { payingCompanyId: e.target.value || null })}>
                                              <option value="">—</option>
                                              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                            </select>
                                          )}
                                        </td>
                                        <td className="py-1 pr-2">
                                          {p.disbursementId ? (
                                            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">{companies.find((c) => c.id === p.receiptIssuerCompanyId)?.name ?? "—"}</span>
                                          ) : (
                                            <select className="rounded border border-gray-300 px-1 py-0.5" value={p.receiptIssuerCompanyId ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { receiptIssuerCompanyId: e.target.value || null })}>
                                              <option value="">—</option>
                                              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                            </select>
                                          )}
                                        </td>
                                        <td className="py-1 pr-2">
                                          <input className="w-20 rounded border border-gray-300 px-1 py-0.5" value={p.receiptRef ?? ""} onChange={(e) => patchPayment(row.id as string, pIdx, { receiptRef: e.target.value })} />
                                        </td>
                                        <td className="py-1 pr-2">
                                          {p.id ? (
                                            <span className="text-gray-300" title="已存在的期款列不能移除；要拿掉請把百分比改成 0">—</span>
                                          ) : (
                                            <button type="button" className="text-red-500 hover:underline" onClick={() => removePaymentRow(row.id as string, pIdx)}>移除</button>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            <div className="mt-2 flex items-center gap-3">
                              <button type="button" className="text-xs text-gray-500 hover:underline" onClick={() => addPaymentRow(row.id as string)}>＋ 新增一期</button>
                              <PrimaryButton type="button" onClick={() => saveSubcontractPayments(row.id as string)} disabled={savingPayments === row.id}>
                                {savingPayments === row.id ? "儲存中…" : "儲存期款"}
                              </PrimaryButton>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex items-center gap-3">
            <PrimaryButton onClick={saveSubcontracts} disabled={savingSubs}>{savingSubs ? "儲存中…" : "儲存副委託"}</PrimaryButton>
            {subsSavedAt && <span className="text-sm text-green-700">已儲存</span>}
          </div>
          {money && (
            <div className="mt-4 grid grid-cols-2 gap-4 border-t pt-4 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-gray-500">發包小計</p><p className="font-medium text-gray-800">{fmtMoney(money.subcontractTotal)}</p></div>
              <div><p className="text-xs text-gray-500">其他支出</p><p className="font-medium text-gray-800">{fmtMoney(money.otherExpenses)}</p></div>
              <div><p className="text-xs text-gray-500">利潤</p><p className="font-medium text-gray-800">{fmtMoney(money.profit)}</p></div>
              <div><p className="text-xs text-gray-500">毛利率</p><p className="font-medium text-gray-800">{money.grossMarginPct ?? "—"}{money.grossMarginPct != null && "%"}</p></div>
            </div>
          )}
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      {/* 案情狀態（模組四第 2 條）。與封存是兩軸。 */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">案情狀態</h2>

        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              project.status === "active"
                ? "bg-green-50 text-green-700"
                : project.status === "suspended"
                  ? "bg-amber-50 text-amber-700"
                  : project.status === "terminated"
                    ? "bg-red-50 text-red-700"
                    : "bg-gray-100 text-gray-600"
            }`}
          >
            {statusLabel(project.status)}
          </span>
          {project.statusEffectiveOn && (
            <span className="text-gray-500">自 {project.statusEffectiveOn} 起</span>
          )}
          {project.archivedAt && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500">已封存</span>
          )}
        </div>
        {project.statusReason && (
          <p className="mb-4 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
            理由：{project.statusReason}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>變更為</label>
            <select
              className={inputCls}
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as ProjectStatus | "")}
            >
              <option value="">不變更</option>
              {PROJECT_STATUS_ORDER.filter((v) => v !== project.status).map((v) => (
                <option key={v} value={v}>{PROJECT_STATUS_LABELS[v]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>生效日</label>
            <input
              className={inputCls}
              type="date"
              value={statusEffectiveOn}
              onChange={(e) => setStatusEffectiveOn(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400">
              解約通知書／結案文件上的那一天，不是今天。留空才用今天。
            </p>
          </div>
          <div>
            <label className={labelCls}>理由 *</label>
            <input
              className={inputCls}
              value={statusReason}
              onChange={(e) => setStatusReason(e.target.value)}
              placeholder="例如：業主資金斷鏈，依約第 12 條終止"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <PrimaryButton onClick={changeStatus} disabled={savingStatus || !newStatus}>
            {savingStatus ? "變更中…" : "變更狀態"}
          </PrimaryButton>
          <span className="text-xs text-gray-400">
            狀態變更不擋（結案後返工是真的），但一律留下理由與生效日。
          </span>
        </div>

        <div className="mt-5 border-t pt-4">
          <label className={labelCls}>封存（只影響列表是否顯示，與案情無關）</label>
          {project.status === "active" ? (
            <p className="text-sm text-gray-400">
              「進行中」的專案不能封存。要收起來請先改成暫停、結案或已解約。
            </p>
          ) : (
            <button
              type="button"
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
              onClick={() => saveProjectField({ archived: !project.archivedAt })}
            >
              {project.archivedAt ? "取消封存" : "封存此專案"}
            </button>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {/* 成員分潤 */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">成員分潤</h2>
          {isPool && (
            <span className={`text-xs ${pctTotal > 100 ? "text-red-600" : "text-gray-500"}`}>
              百分比加總 {pctTotal}%{pctTotal > 100 ? "（超過 100%）" : ""}
            </span>
          )}
        </div>

        {members.length === 0 ? (
          <Empty>尚無成員</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">成員</th>
                  <th className="py-2 pr-3">角色</th>
                  <th className="py-2 pr-3">{isPool ? "分潤 %" : "分潤金額"}</th>
                  <th className="py-2 pr-3">實得金額</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium text-gray-900">
                      {m.name ?? m.employeeId}
                      {m.empNo && <span className="ml-1 text-xs text-gray-400">{m.empNo}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <button
                        onClick={() => toggleLead(m)}
                        className={`rounded-full px-2 py-0.5 text-xs ${m.roleInProject === "lead" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-500"}`}
                        title="點擊切換 負責人／組員"
                      >
                        {m.roleInProject === "lead" ? "負責人" : "組員"}
                      </button>
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm"
                        type="number"
                        min="0"
                        defaultValue={(isPool ? m.sharePct : m.shareAmount) ?? ""}
                        onBlur={(e) => {
                          const cur = isPool ? m.sharePct : m.shareAmount;
                          const v = e.target.value === "" ? null : Number(e.target.value);
                          if (v !== cur) saveMemberShare(m, e.target.value);
                        }}
                      />
                    </td>
                    <td className="py-2 pr-3 text-gray-700">{fmtMoney(m.computedAmount)}</td>
                    <td className="py-2 pr-3">
                      <button onClick={() => removeMember(m)} className="text-xs text-red-600 hover:underline">移除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* add member */}
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
          <div>
            <label className={labelCls}>新增成員</label>
            <select className={inputCls} value={newEmp} onChange={(e) => setNewEmp(e.target.value)}>
              <option value="">選擇員工</option>
              {emps
                .filter((e) => !members.some((m) => m.employeeId === e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>{e.name}{e.emp_no ? `（${e.emp_no}）` : ""}</option>
                ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>角色</label>
            <select className={inputCls} value={newRole} onChange={(e) => setNewRole(e.target.value as "member" | "lead")}>
              <option value="member">組員</option>
              <option value="lead">負責人</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{isPool ? "分潤 %" : "分潤金額"}</label>
            <input className={inputCls} type="number" min="0" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          </div>
          <PrimaryButton onClick={addMember}>新增</PrimaryButton>
        </div>
      </Card>

      {/* 文件（知識庫） */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">專案文件（全公司可下載）</h2>
        <input
          ref={fileRef}
          type="file"
          className="mb-3 block text-sm"
          onChange={(e) => onUpload(e.target.files?.[0])}
        />
        {projectLevelDocs.length === 0 ? (
          <Empty>尚無文件</Empty>
        ) : (
          <ul className="divide-y">
            {projectLevelDocs.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between py-2 text-sm">
                <div className="min-w-0">
                  <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium" style={{ color: "var(--brand)" }}>
                    {doc.fileName}
                  </a>
                  <span className="ml-2 text-xs text-gray-400">{Math.round(doc.sizeBytes / 1024)} KB</span>
                  {doc.contractId && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">作廢合約的掃描檔</span>}
                </div>
                <button onClick={() => removeDoc(doc)} className="text-xs text-red-600 hover:underline">刪除</button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 分潤異動史 */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">分潤異動紀錄</h2>
        {adjustments.length === 0 ? (
          <Empty>尚無異動</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">時間</th>
                  <th className="py-2 pr-3">對象</th>
                  <th className="py-2 pr-3">項目</th>
                  <th className="py-2 pr-3">變更</th>
                  <th className="py-2 pr-3">原因</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 text-gray-500">{new Date(a.createdAt).toLocaleString("zh-TW")}</td>
                    <td className="py-2 pr-3 text-gray-700">{a.name ?? (a.field === "pool" ? "獎金池" : "—")}</td>
                    <td className="py-2 pr-3 text-gray-600">{a.field === "pct" ? "百分比" : a.field === "amount" ? "金額" : "獎金池"}</td>
                    <td className="py-2 pr-3 text-gray-700">{fmtMoney(a.oldValue)} → {fmtMoney(a.newValue)}</td>
                    <td className="py-2 pr-3 text-gray-500">{a.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
