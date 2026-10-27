"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Button, DetailHeading, ErrorText, Empty } from "@/components/admin-ui";
import { buttonClass } from "@/components/ess-ui";
import {
  applicationSheetDraftOf,
  rebaseApplicationSheetDraft,
  type ApplicationSheetDraft,
} from "@/lib/project-application-sheet";
import { applicationSheetPlan, resolveSheetClient, type SheetSaveContext } from "@/lib/project-application-sheet-save";
import { unsavedChangesMessage } from "@/lib/unsaved-changes";
import { useUnsavedChangesGuard } from "./_sections/useUnsavedChangesGuard";
import { getDepartments, getEmployees, getMe, type Department, type Employee } from "@/lib/admin-api";
import { isAdminRole } from "@/lib/roles";
import { listVendors, type Vendor } from "@/lib/company-api";
import {
  getProjectMembers,
  getProjectAdjustments,
  getProjectDocuments,
  deleteProjectDocument,
  getContracts,
  type ProjectMember,
  type ProjectMemberRole,
  type ProjectBonusEstimateSummary,
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
  listProjectsExt,
  getP3SettingsLite,
  listClients,
  loadContractsForProjectAccess,
  engineerDisciplinesOf,
  PROJECT_KIND_LABELS,
  type ProjectDetail,
  type ProjectAccess,
  type ProjectMoney,
  type BillingScheduleExt,
  type InstallmentInputExt,
  type SubcontractPayment,
  type Subcontract,
  type Company,
  type Client,
  type ProjectListItem,
} from "@/lib/projects-ext-api";
import { parentProjectChoices } from "../_components/project-application-form";
import {
  humanError,
  todayKey,
  toSubRows,
  emptySubcontractsResponse,
  emptyBillingSchedule,
  type SubRow,
} from "./_sections/shared";
import { ProjectSettingsCard } from "./_sections/ProjectSettingsCard";
import { ApplicationSheet, type ApplicationSheetSaveReport } from "./_sections/ApplicationSheet";
import { effectiveRoleSharePct } from "@/lib/project-share-calculation";
import { ContractsCard } from "./_sections/ContractsCard";
import { BillingsCard } from "./_sections/BillingsCard";
import { SubcontractsCard } from "./_sections/SubcontractsCard";
import { StatusCard } from "./_sections/StatusCard";
import { BonusShareCard } from "./_sections/BonusShareCard";
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
  // 獎金分潤卡（2026-10-27 三卡合一）：寫入權（只有老闆）、老闆是否已指定、估算服務的專案層數字、
  // 新增一列時帶入的角色預設％（本案 share_pct_by_role；未設定退回租戶的新專案起始值）、變更原因是否必填。
  const [shareMeta, setShareMeta] = useState<{
    canEditBonus: boolean;
    bossConfigured: boolean;
    estimate: ProjectBonusEstimateSummary | null;
    bonusRatePct: number | null;
    legacyBonusPool: number | null;
    profitHidden: boolean;
    reasonRequired: boolean;
    defaults: Partial<Record<ProjectMemberRole, number>>;
  }>({ canEditBonus: false, bossConfigured: true, estimate: null, bonusRatePct: null, legacyBonusPool: null, profitHidden: false, reasonRequired: true, defaults: {} });
  const [adjustments, setAdjustments] = useState<ShareAdjustment[]>([]);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  /**
   * 合約掃描檔與合約內容欄位只有 HR／該案 lead／經理與主辦成員看得到（會計與部門主管看不到）。
   * 後端在 documents 回應裡告知；false 時合約卡不顯示掃描檔、上傳／刪除按鈕與內容欄位。
   */
  const [canSeeContractDocs, setCanSeeContractDocs] = useState(false);
  const [contracts, setContracts] = useState<Contract[]>([]);
  /** 「母案」下拉的來源：同租戶的主案（含已封存的）。載入失敗就是空清單，不影響整頁。 */
  const [mainProjects, setMainProjects] = useState<ProjectListItem[]>([]);
  const [schedule, setSchedule] = useState<BillingScheduleExt | null>(null);
  /** 期程是整批存的，所以編輯中的狀態獨立於已存檔的 schedule。 */
  const [draft, setDraft] = useState<InstallmentInputExt[]>([]);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  /**
   * W8：協力技師的科別欄位依租戶設定（`project_settings.disciplines`）動態產生，
   * 不再是寫死的電機／空調／消防三欄。
   */
  const [disciplines, setDisciplines] = useState<string[]>(() => engineerDisciplinesOf(null));
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
  const [cContentNote, setCContentNote] = useState("");
  /** 正在編輯的合約內容欄位：合約 id → 草稿文字。放這裡的原因同下面 showContractForm（load() 會整頁重掛）。 */
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [savingContract, setSavingContract] = useState(false);
  // 「＋ 新增文件」表單的展開狀態：放這裡是因為 load() 會整頁卸載重掛（見下方 `if (loading)`），
  // 放在 ContractsCard 裡送出後會被重置成收起。預設收起。
  const [showContractForm, setShowContractForm] = useState(false);

  // 案情狀態變更（模組四第 2 條）。改狀態要理由，所以不能是即存下拉。
  const [newStatus, setNewStatus] = useState<ProjectStatus | "">("");
  const [statusReason, setStatusReason] = useState("");
  const [statusEffectiveOn, setStatusEffectiveOn] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  /**
   * 申請單表格的草稿放在頁面這層：load() 會讓下方卡片整個卸載重掛，草稿放在 ApplicationSheet 裡會被清掉。
   * sheetBaseRef＝上次載入時由專案算出的草稿，重新載入時用它判斷哪些欄位使用者動過（rebaseApplicationSheetDraft）。
   */
  const [sheetDraft, setSheetDraft] = useState<ApplicationSheetDraft | null>(null);
  const sheetBaseRef = useRef<{ projectId: string; base: ApplicationSheetDraft } | null>(null);
  /** 已存檔的副委託（申請單表格的「發包單位」區塊用；編輯中的草稿是下面的 subDraft）。 */
  const [savedSubs, setSavedSubs] = useState<Subcontract[]>([]);
  /** 客戶名冊（申請單客戶欄位的基準；跟著 load() 重抓，存完客戶欄位才比得出已存成）。 */
  const [clients, setClients] = useState<Client[]>([]);
  /**
   * 能改客戶名冊：PATCH /clients/:id 是 requireFinance（HR／會計／平台管理員＝ADMIN_ROLES），比本案 finance 窄。
   * 本案經理、主辦、部門主管在申請單上的客戶欄位維持唯讀，免得每次存檔都 403。讀不到 /me 就當不能改。
   */
  const [canEditClients, setCanEditClients] = useState(false);
  /** 申請單上次儲存的結果（哪幾部分沒存成）；load() 會讓申請單重掛，所以放這層。 */
  const [sheetSaveReport, setSheetSaveReport] = useState<ApplicationSheetSaveReport | null>(null);

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
      // access 由 detail 回應決定；先取得它，避免非 finance 使用者先打合約 API 收到 403，
      // 進而讓整頁 Promise.all 失敗。
      const detail = await getProjectDetail(projectId);
      const [m, adj, docs, contractsForAccess, bs, subs, d, e, ven, comp, p3, mains, cl, me] = await Promise.all([
        getProjectMembers(projectId),
        getProjectAdjustments(projectId),
        getProjectDocuments(projectId),
        loadContractsForProjectAccess(detail.access.finance, () => getContracts(projectId)),
        getBillingSchedule(projectId).catch(() => emptyBillingSchedule()),
        getProjectSubcontracts(projectId).catch(() => emptySubcontractsResponse()),
        // GET /departments 目前仍是 requireHrAdmin（routes/departments.ts 不在 WP5 範圍）。
        // 會計進得來這一頁，但拿不到部門清單——整頁不該因此掛掉，「所屬部門」下拉空著就好。
        getDepartments().catch(() => ({ departments: [] as Department[] })),
        getEmployees(),
        listVendors(),
        listCompanies(),
        getP3SettingsLite().catch(() => null),
        // 補母案的下拉：只要主案（後端 ?kind=main）；主案本身不顯示這個下拉，就不必抓。
        // 失敗不該讓整頁掛掉，下拉空著就好。
        detail.project.kind === "main"
          ? Promise.resolve({ projects: [] as ProjectListItem[] })
          : listProjectsExt({ includeArchived: true, kinds: ["main"] }).catch(() => ({ projects: [] as ProjectListItem[] })),
        // 客戶名冊只有可編輯申請單的人需要；讀不到就退回專案帶的 client。
        detail.access.finance ? listClients().catch(() => ({ clients: [] as Client[] })) : Promise.resolve({ clients: [] as Client[] }),
        getMe().catch(() => null),
      ]);
      const clientsEditable = isAdminRole(me?.role);
      const disciplineList = engineerDisciplinesOf(p3?.settings.disciplines ?? null);
      setDisciplines(disciplineList);
      // 申請單草稿：沒動過的欄位換成新值、動過的保留；疊完若已跟專案一致（例如剛存好）就整份換新。
      const newBase = applicationSheetDraftOf(detail.project, disciplineList);
      const oldBase = sheetBaseRef.current?.projectId === detail.project.id ? sheetBaseRef.current.base : null;
      sheetBaseRef.current = { projectId: detail.project.id, base: newBase };
      setSheetDraft((prev) => {
        if (!prev || !oldBase) return newBase;
        const rebased = rebaseApplicationSheetDraft(oldBase, newBase, prev);
        const pending = applicationSheetPlan(
          {
            project: detail.project,
            canFinance: detail.access.finance,
            canEditClient: clientsEditable,
            disciplines: disciplineList,
            client: resolveSheetClient(cl.clients, detail.project, rebased.clientId),
            money: detail.money,
            contracts: contractsForAccess,
            billings: bs.installments,
            subcontracts: subs.subcontracts,
            vendors: ven.vendors,
          },
          rebased,
        );
        return pending.dirtyCount === 0 ? newBase : rebased;
      });
      setClients(cl.clients);
      setCanEditClients(clientsEditable);
      setProject(detail.project);
      setAccess(detail.access);
      setMoney(detail.money);
      setContracts(contractsForAccess);
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
      setSavedSubs(subs.subcontracts);
      const subRows = toSubRows(subs.subcontracts);
      setSubDraft(subRows);
      setOriginalSubIds(subRows.map((r) => r.id).filter((x): x is string => !!x));
      setPaymentsDraft(Object.fromEntries(subRows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setOriginalPayments(Object.fromEntries(subRows.filter((r) => r.id).map((r) => [r.id as string, r.payments ?? []])));
      setMembers(m.members);
      setShareMeta({
        canEditBonus: m.canEditBonus ?? detail.access.editBonus ?? false,
        bossConfigured: m.bossConfigured ?? detail.access.bossConfigured ?? true,
        estimate: m.bonusEstimate ?? null,
        bonusRatePct: m.bonusRatePct ?? detail.project.bonusRatePct ?? null,
        legacyBonusPool: m.bonusEstimate?.basis === "legacy_pool" ? m.bonusPool : null,
        // 專案毛利只有老闆／platform_admin／授權 HR 看得到（canSeeProfit）；其他人不在本機推算獎金總額。
        profitHidden: m.canSeeProfit === false,
        // 舊版後端沒有這個鍵 → 保守視為必填。
        reasonRequired: m.reasonRequired ?? true,
        defaults: effectiveRoleSharePct(
          detail.project.sharePctByRole,
          (p3?.settings.defaultSharePctByRole ?? null) as Partial<Record<ProjectMemberRole, number>> | null,
        ),
      });
      setAdjustments(adj.adjustments);
      setDocuments(docs.documents);
      setCanSeeContractDocs(docs.canSeeContractDocs);
      setMainProjects(mains.projects);
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

  const canFinance = access.finance;
  /** W4：分潤區（獎金池／成員趴數／異動史）。會計有 finance 但沒有 bonus。 */
  const canBonus = access.bonus;

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

  // 申請單未儲存的欄位數（含客戶名冊、合約、付款階段、發包單位格子）：離開頁面（連結、上一頁、關分頁）前提醒。
  const sheetContext: SheetSaveContext | null = project
    ? {
        project,
        canFinance,
        canEditClient: canEditClients,
        disciplines,
        client: sheetDraft ? resolveSheetClient(clients, project, sheetDraft.clientId) : null,
        money,
        contracts,
        billings: schedule?.installments ?? [],
        subcontracts: savedSubs,
        vendors,
      }
    : null;
  const sheetDirtyCount = sheetContext && sheetDraft ? applicationSheetPlan(sheetContext, sheetDraft).dirtyCount : 0;
  useUnsavedChangesGuard(sheetDirtyCount > 0, unsavedChangesMessage(sheetDirtyCount));

  if (loading) return <Empty>載入中…</Empty>;
  if (!project) return <ErrorText>{error ?? "找不到專案"}</ErrorText>;

  const headerDesc = project.kind !== "main" ? `類型：${PROJECT_KIND_LABELS[project.kind]}` : "";

  return (
    <>
      {/* 頁首動作：一律次要外框按鈕、大小一致，手機自動換行（DetailHeading 已 flex-wrap）。 */}
      <DetailHeading title={project.name} desc={headerDesc || undefined}>
        {canBonus && (
          <Link href="/admin/bonus-runs" className={buttonClass("secondary", "sm")}>
            追蹤獎金撥款
          </Link>
        )}
        {canFinance && (
          <Link href={`/admin/disbursements/pivot?year=${project.fiscalYear ?? new Date().getFullYear()}&groupBy=project`} className={buttonClass("secondary", "sm")}>
            查看年度專案放款
          </Link>
        )}
        {canFinance && !project.reservedAt && (
          <Button variant="secondary" size="sm" onClick={() => setDupOpen(true)} data-testid="duplicate-project-button">
            複製為追加減／加做
          </Button>
        )}
        <Link href={`/admin/projects/${project.id}/application`} className={buttonClass("secondary", "sm")}>
          列印申請單
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

      {/* ① 專案申請單（版面照公司 Word 申請單；格子內直接編輯，只送有變的欄位） */}
      {sheetDraft && (
      <ApplicationSheet
        draft={sheetDraft}
        onDraftChange={setSheetDraft as Dispatch<SetStateAction<ApplicationSheetDraft>>}
        project={project}
        canFinance={canFinance}
        showProfit={access.profit !== false}
        money={money}
        billings={schedule?.installments ?? []}
        subcontracts={savedSubs}
        contracts={contracts}
        companies={companies}
        vendors={vendors}
        disciplines={disciplines}
        clients={clients}
        canEditClients={canEditClients}
        saveReport={sheetSaveReport}
        onSaveReport={setSheetSaveReport}
        load={load}
      />
      )}

      {/* ② 申請單上沒有、系統要的設定：母案／部門／負責人／年度／預定起迄日 */}
      <ProjectSettingsCard
        project={project} depts={depts} emps={emps}
        parentChoices={parentProjectChoices(mainProjects, project.id, project.parentProjectId)}
        canEdit={canFinance}
        saveProjectField={saveProjectField} error={error}
      />

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

      {/* 合約與報價單（模組四第 3 條）：申請單「訂單」「銷售金額」的來源。文件類型決定課不課印花稅。 */}
      {canFinance && (
        <div id="project-contracts" className="scroll-mt-20">
          <ContractsCard
            projectId={projectId} project={project} contracts={contracts} scansByContract={scansByContract}
            cDocType={cDocType} setCDocType={setCDocType}
            cOurRole={cOurRole} setCOurRole={setCOurRole}
            cTitle={cTitle} setCTitle={setCTitle}
            cCounterparty={cCounterparty} setCCounterparty={setCCounterparty}
            cAmount={cAmount} setCAmount={setCAmount}
            cSignedOn={cSignedOn} setCSignedOn={setCSignedOn}
            cCopies={cCopies} setCCopies={setCCopies}
            cContentNote={cContentNote} setCContentNote={setCContentNote}
            noteDrafts={noteDrafts} setNoteDrafts={setNoteDrafts}
            canSeeContractDocs={canSeeContractDocs}
            savingContract={savingContract} setSavingContract={setSavingContract}
            showAddForm={showContractForm} setShowAddForm={setShowContractForm}
            contractFileRef={contractFileRef} pendingContractId={pendingContractId}
            removeDoc={removeDoc}
            error={error} setError={setError} load={load}
          />
        </div>
      )}

      {/* 請款期程（模組四第 4 條）＋ P3 開票／收款：申請單「付款階段」以外的動作（請款／開票／入帳／人工指定金額）。
          後端讀寫都要 finance，跟其他財務卡一樣只對 canFinance 顯示。 */}
      {canFinance && (
      <div id="project-billings" className="scroll-mt-20">
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
      </div>
      )}

      {/* 副委託與協力技師（模組五）：申請單「發包單位」的來源；期款與放款連動也在這裡。 */}
      {canFinance && (
        <div id="project-subcontracts" className="scroll-mt-20">
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
            companies={companies}
            error={error} setError={setError} load={load}
          />
        </div>
      )}

      {/* 文件（知識庫） */}
      <DocumentsCard projectId={projectId} fileRef={fileRef} projectLevelDocs={projectLevelDocs} canSeeContractDocs={canSeeContractDocs} removeDoc={removeDoc} setError={setError} load={load} />

      {/* C2 變更歷史：根案 → -1 → -2…，本案高亮、封存案灰字＋理由 */}
      <LineageCard projectId={projectId} canDuplicate={canFinance && !project.reservedAt} />

      {/* ③ 最下方：獎金分潤（2026-10-27 業主要求三卡合一：獎金比例＋每列 角色｜員工｜％）。
          沒有分潤權限的人（會計）只看到唯讀成員名單（角色＋姓名）。 */}
      <BonusShareCard
        projectId={projectId} shareMode={project.shareMode} members={members} emps={emps}
        canBonus={canBonus} canEditBonus={shareMeta.canEditBonus} bossConfigured={shareMeta.bossConfigured}
        defaultSharePctByRole={shareMeta.defaults}
        // 合約額優先用估算服務的口徑（與獎金引擎同一個合約總額，含追加減）；沒有才退回金額卡。
        contractAmount={shareMeta.estimate?.contractTotal ?? money?.amountUntaxed ?? null}
        estimate={shareMeta.estimate} bonusRatePct={shareMeta.bonusRatePct} legacyBonusPool={shareMeta.legacyBonusPool}
        profitHidden={shareMeta.profitHidden} reasonRequired={shareMeta.reasonRequired}
        setError={setError} load={load}
      />
      {/* 分潤版本歷程：放在分潤卡下方、預設收起，只給看得到分潤的人。 */}
      {canBonus && <AdjustmentsCard adjustments={adjustments} />}
      {/* 未儲存提醒列是 fixed 在底部，留出空間免得蓋住最下面的成員分潤。 */}
      {sheetDirtyCount > 0 && <div aria-hidden="true" className="h-16" />}
    </>
  );
}
