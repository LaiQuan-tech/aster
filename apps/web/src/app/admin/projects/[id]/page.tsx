"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { DetailHeading, ErrorText, Empty } from "@/components/admin-ui";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import { listVendors, type Vendor } from "@/lib/company-api";
import {
  getProjectMembers,
  getProjectAdjustments,
  getProjectDocuments,
  deleteProjectDocument,
  getContracts,
  type ProjectMember,
  type ShareAdjustment,
  type ProjectDocument,
  type ProjectStatus,
  type Contract,
  type DocType,
  type OurRole,
} from "@/lib/projects-api";
import {
  getProjectDetail,
  updateProjectFields,
  getBillingSchedule,
  getProjectSubcontracts,
  listCompanies,
  PROJECT_KIND_LABELS,
  type ProjectDetail,
  type ProjectAccess,
  type ProjectMoney,
  type BillingScheduleExt,
  type InstallmentInputExt,
  type SubcontractPayment,
  type Company,
} from "@/lib/projects-ext-api";
import {
  humanError,
  todayKey,
  appFormFrom,
  toSubRows,
  emptySubcontractsResponse,
  emptyBillingSchedule,
  type AppForm,
  type SubRow,
} from "./_sections/shared";
import { ProjectSettingsCard } from "./_sections/ProjectSettingsCard";
import { ApplicationFieldsCard } from "./_sections/ApplicationFieldsCard";
import { MoneyCard } from "./_sections/MoneyCard";
import { ContractsCard } from "./_sections/ContractsCard";
import { BillingsCard } from "./_sections/BillingsCard";
import { SubcontractsCard } from "./_sections/SubcontractsCard";
import { StatusCard } from "./_sections/StatusCard";
import { MembersCard } from "./_sections/MembersCard";
import { DocumentsCard } from "./_sections/DocumentsCard";
import { AdjustmentsCard } from "./_sections/AdjustmentsCard";
import { LineageCard, DuplicateProjectDialog } from "./_sections/LineageCard";

/**
 * 專案詳情頁。B0 拆檔後這裡只留：資料載入、共用 state、header、各 Card 的組裝；
 * 每張 Card 的 JSX 與專屬 handler 在 ./_sections/*Card.tsx，state 與 setter 以 props 傳下去。
 */
export default function AdminProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  // C2 複製為追加減／加做（對話框開關；成功後導到新案）
  const [dupOpen, setDupOpen] = useState(false);

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

  const headerDesc = [
    project.code ? `編號 ${project.code}（不可變更）` : null,
    project.client?.name ? `客戶：${project.client.name}` : null,
    project.kind !== "main" ? `類型：${PROJECT_KIND_LABELS[project.kind]}` : null,
  ].filter(Boolean).join("　");

  return (
    <>
      <DetailHeading title={project.name} desc={headerDesc || undefined}>
        {canFinance && !project.reservedAt && (
          <button
            type="button"
            onClick={() => setDupOpen(true)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            data-testid="duplicate-project-button"
          >
            複製為追加減／加做
          </button>
        )}
        <Link href={`/admin/projects/${project.id}/application`} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
          列印申請單 →
        </Link>
      </DetailHeading>

      {/* C2 複製對話框：成功後導到新案（同一個 page 元件換 id 重新 load） */}
      <DuplicateProjectDialog
        open={dupOpen}
        project={project}
        onClose={() => setDupOpen(false)}
        onDone={(res) => {
          setDupOpen(false);
          router.push(`/admin/projects/${res.project.id}`);
        }}
      />

      {/* 專案設定 */}
      <ProjectSettingsCard project={project} depts={depts} emps={emps} isPool={isPool} saveProjectField={saveProjectField} error={error} />

      {/* C2 變更歷史：根案 → -1 → -2…，本案高亮、封存案灰字＋理由 */}
      <LineageCard projectId={projectId} />

      {/* 申請單資料（模組五） */}
      {appForm && (
        <ApplicationFieldsCard
          project={project}
          appForm={appForm} setAppForm={setAppForm}
          savingApp={savingApp} setSavingApp={setSavingApp}
          appSavedAt={appSavedAt} setAppSavedAt={setAppSavedAt}
          contracts={contracts} vendors={vendors} canFinance={canFinance}
          error={error} setError={setError} load={load}
        />
      )}

      {/* 金額（模組五，finance 權限才顯示） */}
      {canFinance && money && <MoneyCard money={money} />}

      {/* 合約與報價單（模組四第 3 條）。文件類型決定課不課印花稅。 */}
      <ContractsCard
        projectId={projectId} project={project} contracts={contracts} scansByContract={scansByContract}
        cDocType={cDocType} setCDocType={setCDocType}
        cOurRole={cOurRole} setCOurRole={setCOurRole}
        cTitle={cTitle} setCTitle={setCTitle}
        cCounterparty={cCounterparty} setCCounterparty={setCCounterparty}
        cAmount={cAmount} setCAmount={setCAmount}
        cSignedOn={cSignedOn} setCSignedOn={setCSignedOn}
        cCopies={cCopies} setCCopies={setCCopies}
        savingContract={savingContract} setSavingContract={setSavingContract}
        contractFileRef={contractFileRef} pendingContractId={pendingContractId}
        removeDoc={removeDoc}
        error={error} setError={setError} load={load}
      />

      {/* 請款期程（模組四第 4 條）＋ P3 開票／收款。金額一律系統算，不手動拉格。 */}
      <BillingsCard
        projectId={projectId}
        schedule={schedule} setSchedule={setSchedule}
        draft={draft} setDraft={setDraft}
        savingSchedule={savingSchedule} setSavingSchedule={setSavingSchedule}
        invoiceFormId={invoiceFormId} setInvoiceFormId={setInvoiceFormId}
        invoiceNo={invoiceNo} setInvoiceNo={setInvoiceNo}
        invoicedOn={invoicedOn} setInvoicedOn={setInvoicedOn}
        receiveFormId={receiveFormId} setReceiveFormId={setReceiveFormId}
        receivedOn={receivedOn} setReceivedOn={setReceivedOn}
        receivedAmount={receivedAmount} setReceivedAmount={setReceivedAmount}
        error={error} setError={setError} load={load}
      />

      {/* 副委託與協力技師（模組五） */}
      {canFinance && (
        <SubcontractsCard
          projectId={projectId}
          subDraft={subDraft} setSubDraft={setSubDraft}
          originalSubIds={originalSubIds} setOriginalSubIds={setOriginalSubIds}
          savingSubs={savingSubs} setSavingSubs={setSavingSubs}
          subsSavedAt={subsSavedAt} setSubsSavedAt={setSubsSavedAt}
          expandedSub={expandedSub} setExpandedSub={setExpandedSub}
          paymentsDraft={paymentsDraft} setPaymentsDraft={setPaymentsDraft}
          originalPayments={originalPayments} setOriginalPayments={setOriginalPayments}
          savingPayments={savingPayments} setSavingPayments={setSavingPayments}
          vendors={vendors} companies={companies} money={money}
          error={error} setError={setError} load={load}
        />
      )}

      {/* 案情狀態（模組四第 2 條）。與封存是兩軸。 */}
      <StatusCard
        project={project}
        newStatus={newStatus} setNewStatus={setNewStatus}
        statusReason={statusReason} setStatusReason={setStatusReason}
        statusEffectiveOn={statusEffectiveOn} setStatusEffectiveOn={setStatusEffectiveOn}
        savingStatus={savingStatus} setSavingStatus={setSavingStatus}
        saveProjectField={saveProjectField}
        error={error} setError={setError} load={load}
      />

      {/* 成員分潤 */}
      <MembersCard
        projectId={projectId} members={members} emps={emps} isPool={isPool} pctTotal={pctTotal}
        newEmp={newEmp} setNewEmp={setNewEmp}
        newRole={newRole} setNewRole={setNewRole}
        newValue={newValue} setNewValue={setNewValue}
        setError={setError} load={load}
      />

      {/* 文件（知識庫） */}
      <DocumentsCard projectId={projectId} fileRef={fileRef} projectLevelDocs={projectLevelDocs} removeDoc={removeDoc} setError={setError} load={load} />

      {/* 分潤異動史 */}
      <AdjustmentsCard adjustments={adjustments} />
    </>
  );
}
