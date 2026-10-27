"use client";

import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Button, PrimaryButton } from "@/components/admin-ui";
import { ClientCombo } from "@/components/ClientCombo";
import type { Vendor } from "@/lib/company-api";
import { companyOptions } from "@/lib/company-options";
import { createContract, updateContract, type Contract } from "@/lib/projects-api";
import {
  COMMON_DISCIPLINES,
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  clientSaveWarningText,
  disciplineLabel,
  getBillingSchedule,
  getProjectSubcontracts,
  humanizeBillingError,
  humanizeClientError,
  humanizeProjectExtError,
  humanizeSubcontractError,
  invoiceBilling,
  listClients,
  putProjectSubcontracts,
  receiveBilling,
  saveBillingSchedule,
  updateClient,
  updateProjectFields,
  upsertMainContract,
  type BillingExt,
  type Client,
  type Company,
  type DesignScopeItem,
  type InvoiceType,
  type PaymentMethod,
  type ProjectDetail,
  type ProjectMoney,
  type Subcontract,
} from "@/lib/projects-ext-api";
import {
  APPLICATION_SHEET_COLUMNS,
  APPLICATION_SHEET_TOP_ROWS,
  APPLICATION_STAGE_SPANS,
  APPLICATION_SUBCONTRACT_LABELS,
  APPLICATION_SUBCONTRACT_SPANS,
  APPLICATION_SUMMARY_LABELS,
  CLIENT_SHEET_FIELD_LABELS,
  applicationSheetDraftOf,
  applicationSheetErrors,
  applicationStageRows,
  applicationSubcontractSlots,
  designScopeText,
  latestOrderDocument,
  orderDocumentCells,
  rocDateParts,
  rocDots,
  SHEET_FIELD_PRINT_BLOCK,
  GUILD_REPAYMENT_NOTE_MAX,
  salesAmounts,
  stageRowKey,
  type ApplicationSheetDraft,
  type ClientSheetField,
  type PrintBlockKey,
  type SheetField,
  type StageEdit,
  type SubEdit,
} from "@/lib/project-application-sheet";
import {
  applicationSheetPlan,
  clientFieldValue,
  resolveSheetClient,
  runApplicationSheetSave,
  stageBaseValues,
  stageLocks,
  type SheetSaveApi,
  type SheetSaveStep,
} from "@/lib/project-application-sheet-save";

import { selectedCompanyId } from "../../_components/project-application-form";
import { fmtMoney, humanError } from "./shared";

/** Word 原檔的淺藍底（shd DAEEF3）。 */
const SHADE = "#DAEEF3";
/** Word 原檔字型是標楷體；沒有就退回系統楷體／襯線。 */
const SHEET_FONT = '"DFKai-SB", "BiauKai", "標楷體", "Kaiti TC", "STKaiti", serif';
const GRID_TEMPLATE = APPLICATION_SHEET_COLUMNS.map((w) => `minmax(0, ${w}fr)`).join(" ");

/**
 * 可編輯格子的底色（淡黃，像 Excel 的輸入格）：一眼分得出「可以填」與「系統算的／唯讀」（白底）。
 * 標題格維持 Word 的淺藍底。列印模式不套（editable=false）。
 */
const EDITABLE_BG = "#FFF9E0";

/** 格子內的輸入框：白底細框，看得出是輸入框；滑過加深、聚焦換品牌色外框。 */
const cellInput =
  "w-full min-w-0 rounded-sm border border-amber-200 bg-white/90 px-1 py-0.5 text-[13px] text-gray-900 placeholder:text-gray-300 hover:border-amber-400 hover:bg-white focus:border-[var(--brand)] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/20 disabled:cursor-not-allowed disabled:opacity-60";

type CellKind = "label" | "value" | "full";

/** 存檔結果（放在頁面層：存完會整頁重新載入、本元件會重掛，結果要撐過那一下）。 */
export interface ApplicationSheetSaveReport {
  steps: SheetSaveStep[];
  notices: string[];
}

/**
 * 一格。桌機（md 以上）照 Word 的 16 欄格線擺放（--gc／--gr）；手機改成「標題｜內容」兩欄往下堆疊，
 * 不水平捲動。
 */
function Cell({
  col,
  span,
  row,
  rowSpan = 1,
  kind,
  shade,
  align = "left",
  className = "",
  children,
  testId,
  editable = false,
}: {
  col: number;
  span: number;
  row: number;
  rowSpan?: number;
  kind: CellKind;
  shade?: boolean;
  align?: "left" | "center" | "right";
  className?: string;
  children?: ReactNode;
  testId?: string;
  /** 這格可以直接填（淡黃底）。 */
  editable?: boolean;
}) {
  const style = {
    "--gc": `${col} / span ${span}`,
    "--gr": `${row} / span ${rowSpan}`,
    backgroundColor: shade ? SHADE : editable ? EDITABLE_BG : undefined,
  } as CSSProperties;
  const place = kind === "label" ? "col-start-1" : kind === "full" ? "col-span-2" : "col-start-2";
  // 列印時紙寬（A4 約 700px）比 md 斷點窄，所以每個 md: 都要有對應的 print:，才會印出 Word 格線而不是手機堆疊。
  const alignCls =
    align === "center"
      ? "md:text-center md:justify-center print:text-center print:justify-center"
      : align === "right"
        ? "md:text-right md:justify-end print:text-right print:justify-end"
        : "";
  return (
    <div
      style={style}
      data-testid={testId}
      data-editable={editable ? "true" : undefined}
      className={`${place} flex min-w-0 items-center border-b border-gray-300 bg-white px-1.5 py-1 text-[13px] leading-snug md:border-0 md:[grid-column:var(--gc)] md:[grid-row:var(--gr)] print:border-0 print:px-1 print:py-0.5 print:text-[11px] print:[grid-column:var(--gc)] print:[grid-row:var(--gr)] ${alignCls} ${kind === "label" ? "whitespace-pre text-gray-800" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/** ■／□ 勾選框（發票聯式、付款方式、訂單）。可編輯時點一下選取，再點一次取消（＝未指定）。 */
function CheckBoxes<T extends string>({
  options,
  value,
  editable,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T | "";
  editable: boolean;
  onChange: (next: T | "") => void;
  ariaLabel: string;
}) {
  return (
    <span role="radiogroup" aria-label={ariaLabel} className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {options.map((o) => {
        const checked = value === o.value;
        const mark = <span aria-hidden="true">{checked ? "■" : "□"}</span>;
        return editable ? (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            className="rounded px-0.5 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            onClick={() => onChange(checked ? "" : o.value)}
          >
            {mark}{o.label}
          </button>
        ) : (
          <span key={o.value} role="radio" aria-checked={checked}>{mark}{o.label}</span>
        );
      })}
    </span>
  );
}

interface ApplicationSheetProps {
  project: ProjectDetail;
  /** 看得到、改得了錢與申請單（access.finance＝後端 PATCH 的 canManage）。false＝整張唯讀。 */
  canFinance: boolean;
  /** 利潤／毛利率（access.profit，屬集團財務）。false＝格子留著但不顯示數字。 */
  showProfit: boolean;
  money: ProjectMoney | null;
  /** 已存檔的請款期程（付款階段 1～8 列）。 */
  billings: BillingExt[];
  /** 已存檔的副委託（發包單位區塊）。 */
  subcontracts: Subcontract[];
  contracts: Contract[];
  companies: Company[];
  vendors: Vendor[];
  /** 協力技師的科別（租戶設定 project_settings.disciplines）。 */
  disciplines: string[];
  /** 存檔後重新載入（edit 模式）。 */
  load?: () => Promise<void>;
  /**
   * "edit"（專案明細頁，預設）：格子可編輯、有儲存列與未儲存提醒。
   * "print"（列印申請單頁）：同一份版面的唯讀列印版——沒有輸入框、儲存列與說明文字，A4 直式。
   */
  mode?: "edit" | "print";
  /**
   * 受控草稿（edit 模式由 page.tsx 持有，下方其他卡片存檔整頁重抓時才不會清掉）。省略＝元件自己依專案建。
   */
  draft?: ApplicationSheetDraft;
  onDraftChange?: Dispatch<SetStateAction<ApplicationSheetDraft>>;
  /** 列印區塊勾選（print 模式）：未勾選的區塊內容格螢幕淡化、列印留白。省略＝全勾。 */
  printChecked?: Partial<Record<PrintBlockKey, boolean>>;
  /** 「訂單」格的來源覆寫（列印頁用 /application 回的 latestDocument；讀不到合約的人也印得出）。省略＝由 contracts 算。 */
  latestDocument?: { docType: Contract["docType"]; signedOn: string | null } | null;
  /**
   * 能改客戶名冊（PATCH /clients/:id 只放行 HR／會計／平台管理員，比本案財務權限窄）。
   * false＝客戶欄位唯讀並說明原因。省略＝true。
   */
  canEditClients?: boolean;
  /** 客戶名冊（edit 模式由 page.tsx 隨 load() 一起重抓，存完客戶欄位才比得出已存成）。省略＝元件自己抓一次。 */
  clients?: Client[];
  /** 上次儲存的結果（page.tsx 持有；存完重新載入時本元件會重掛）。省略＝元件自己保存。 */
  saveReport?: ApplicationSheetSaveReport | null;
  onSaveReport?: (report: ApplicationSheetSaveReport | null) => void;
}

/**
 * 專案明細頁上半部：版面照公司 Word「專案申請單」（抬頭、專案明細表、付款階段、發包單位），
 * 整張表像 Excel 一樣在格子裡直接改（淡黃底＝可填），按「儲存申請單」一次存：
 * 專案欄位、客戶名冊（電話／發票地址／採購承辦／傳真／統編）、訂單與銷售金額（合約）、
 * 付款階段（請款期程＋開票／入帳）、發包單位（副委託），各自走既有 API 與權限、只送有變的部分
 * （lib/project-application-sheet-save.ts）。利潤、毛利率、營業稅、銷售總額是系統算的唯讀格。
 * 已開票／已入帳要撤銷、人工指定金額的理由、副委託的期款與扣繳，仍在下方各卡片處理。
 */
export function ApplicationSheet({
  project,
  canFinance,
  showProfit,
  money,
  billings,
  subcontracts,
  contracts,
  companies,
  vendors,
  disciplines,
  load,
  mode = "edit",
  draft: controlledDraft,
  onDraftChange,
  printChecked,
  latestDocument,
  clients: clientsProp,
  canEditClients = true,
  saveReport: controlledReport,
  onSaveReport,
}: ApplicationSheetProps) {
  const print = mode === "print";
  const [localDraft, setLocalDraft] = useState<ApplicationSheetDraft>(() => applicationSheetDraftOf(project, disciplines));
  const draft = controlledDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;
  const [ownClients, setOwnClients] = useState<Client[]>([]);
  const clients = clientsProp ?? ownClients;
  const [saving, setSaving] = useState(false);
  const [localReport, setLocalReport] = useState<ApplicationSheetSaveReport | null>(null);
  const report = controlledReport !== undefined ? controlledReport : localReport;
  const setReport = onSaveReport ?? setLocalReport;
  const editable = canFinance && !print;
  const blockOn = (key: PrintBlockKey) => printChecked?.[key] ?? true;
  /** 未勾選的列印區塊：螢幕淡化、列印時文字透明（格線與標題照印）。 */
  const blankCls = (key: PrintBlockKey) => (blockOn(key) ? "" : "opacity-40 print:opacity-100 print:text-transparent print:**:text-transparent");

  useEffect(() => {
    if (print || clientsProp) return;
    listClients().then((r) => setOwnClients(r.clients)).catch(() => {});
  }, [print, clientsProp]);

  // 客戶資料格：草稿裡選的客戶（還沒存也即時顯示它的名冊資料）。
  const client: Client | null = resolveSheetClient(clients, project, draft.clientId);
  const plan = useMemo(
    () =>
      applicationSheetPlan(
        { project, canFinance: editable, canEditClient: canEditClients, disciplines, client, money, contracts, billings, subcontracts, vendors },
        draft,
      ),
    [project, editable, canEditClients, disciplines, client, money, contracts, billings, subcontracts, vendors, draft],
  );
  const dirtyCount = plan.dirtyCount;
  const validation = [...applicationSheetErrors(draft, { canFinance }), ...plan.errors];

  const set = <K extends keyof ApplicationSheetDraft>(key: K, value: ApplicationSheetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setClientField = (field: ClientSheetField, value: string) =>
    setDraft((d) => ({ ...d, clientEdits: { ...d.clientEdits, [field]: value } }));
  const setStage = (key: string, field: keyof StageEdit, value: string) =>
    setDraft((d) => ({ ...d, stageEdits: { ...d.stageEdits, [key]: { ...d.stageEdits[key], [field]: value } } }));
  const setSub = (key: string, field: keyof SubEdit, value: string) =>
    setDraft((d) => ({ ...d, subEdits: { ...d.subEdits, [key]: { ...d.subEdits[key], [field]: value } } }));

  const api: SheetSaveApi = {
    updateProject: (body) => updateProjectFields(project.id, body),
    updateClient: async (id, body) => clientSaveWarningText(await updateClient(id, body)),
    upsertMainContract: (body) => upsertMainContract(project.id, body),
    updateContract: (id, body) => updateContract(id, body),
    createQuotation: (body) => createContract(project.id, { docType: "quotation", title: "報價單", amount: body.amount }),
    saveBillingSchedule: (installments) => saveBillingSchedule(project.id, installments),
    invoiceBilling: (id, invoiceNo) => invoiceBilling(id, { invoiceNo }),
    receiveBilling: (id, receivedOn) => receiveBilling(id, { receivedOn }),
    putSubcontracts: (list) => putProjectSubcontracts(project.id, { subcontracts: list }),
    fetchBillings: async () => (await getBillingSchedule(project.id)).installments,
    fetchSubcontracts: async () => (await getProjectSubcontracts(project.id)).subcontracts,
    humanize: (section, err) => {
      const msg = err instanceof Error ? err.message : "";
      if (/\[403\]/.test(msg) && section === "client") return "沒有權限修改客戶名冊（限 HR／會計），請請他們改，或到客戶名冊頁處理。";
      if (/\[403\]/.test(msg) && /forbidden\b/.test(msg)) return "沒有權限（後端拒絕）。";
      switch (section) {
        case "project":
          return humanizeProjectExtError(err, "儲存失敗");
        case "client":
          return humanizeClientError(err, "儲存失敗");
        case "contract":
          return humanError(err, "儲存失敗");
        case "subcontracts":
          return humanizeSubcontractError(err, "儲存失敗");
        default:
          return humanizeBillingError(err, "儲存失敗");
      }
    },
  };

  async function save() {
    if (validation.length > 0 || dirtyCount === 0 || saving) return;
    setSaving(true);
    setReport(null);
    try {
      const result = await runApplicationSheetSave(plan, draft, api, {
        project, canFinance: editable, canEditClient: canEditClients, disciplines, client, money, contracts, billings, subcontracts, vendors,
      });
      // 先把已存成的格子從草稿拿掉，再重新載入（沒存成的留著，下一次只送那些）。
      setDraft(result.residual);
      setReport({ steps: result.steps, notices: result.notices });
      if (result.steps.some((st) => st.status === "ok")) await load?.();
    } finally {
      setSaving(false);
    }
  }

  // 名冊讀不到（或還沒載入）時至少放進本案目前的客戶，免得客戶名稱格看起來是空的。
  const clientChoices = project.client && !clients.some((c) => c.id === project.client?.id) ? [project.client, ...clients] : clients;
  const orderDoc = latestDocument !== undefined ? latestDocument : latestOrderDocument(contracts);
  const stageRows = applicationStageRows(billings);
  const subBlocks = applicationSubcontractSlots(subcontracts, editable ? draft.subExtraBlocks : 0, editable ? draft.subEdits : {});
  const companyChoices = companyOptions(companies, draft.companyId, { markDefault: true });
  const companyLabel =
    companyChoices.find((c) => c.id === selectedCompanyId(draft.companyId, companies))?.label ?? project.companyName ?? "";
  const engineerKeys = Object.keys(draft.engineers).filter(
    (k) => disciplines.includes(k) || draft.engineers[k]?.vendorId || draft.engineers[k]?.name,
  );
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));
  const opened = rocDateParts(draft.openedOn);
  const moneyText = (n: number | null | undefined) => (canFinance && money ? fmtMoney(n) : "—");
  // 銷售金額：未稅格有輸入就即時重算營業稅與總額（同後端：未稅 × 稅率四捨五入到元）。
  const untaxedInput = draft.amountUntaxed;
  const untaxedTyped = untaxedInput !== null && untaxedInput.trim() !== "" ? Number(untaxedInput) : null;
  const sales =
    editable && untaxedInput !== null
      ? salesAmounts(untaxedTyped !== null && Number.isFinite(untaxedTyped) ? untaxedTyped : null, money?.vatRate ?? 0.05)
      : { taxAmount: money?.taxAmount ?? null, amountTotal: money?.amountTotal ?? null };
  const hasContractDoc = orderDoc?.docType === "contract";

  /** 客戶名冊欄位：可編輯時是輸入框（改的是名冊那筆客戶）；沒選客戶時不能填。 */
  function clientInput(field: ClientSheetField, extraCls = "") {
    if (!editable || !client || !canEditClients) return clientFieldValue(client, field);
    return (
      <input
        aria-label={CLIENT_SHEET_FIELD_LABELS[field]}
        title="儲存時會同步更新客戶名冊"
        className={`${cellInput} ${extraCls}`}
        value={draft.clientEdits[field] ?? clientFieldValue(client, field)}
        onChange={(e) => setClientField(field, e.target.value)}
      />
    );
  }

  /** 可直接填的格子（淡黃底）：唯讀計算格（營業稅、總額）與沒選客戶時的客戶欄位除外。 */
  function fieldEditable(field: SheetField): boolean {
    if (!editable) return false;
    switch (field) {
      case "taxAmount":
      case "amountTotal":
        return false;
      case "clientPhone":
      case "invoiceAddress":
      case "clientContact":
      case "clientFax":
      case "clientTaxId":
        return !!client && canEditClients;
      default:
        return true;
    }
  }

  function patchScopeRow(idx: number, next: Partial<DesignScopeItem>) {
    setDraft((d) => ({ ...d, designScope: d.designScope.map((r, i) => (i === idx ? { ...r, ...next } : r)) }));
  }

  function renderField(field: SheetField): ReactNode {
    switch (field) {
      case "siteAddress":
        return editable ? (
          <input aria-label="設計地點" className={cellInput} value={draft.siteAddress} onChange={(e) => set("siteAddress", e.target.value)} />
        ) : (draft.siteAddress || "—");
      case "siteAreaM2":
        return (
          <span className="flex w-full items-center gap-1">
            {editable ? (
              <input aria-label="設計面積" className={`${cellInput} max-w-[9rem] text-right`} type="number" min="0" inputMode="decimal" value={draft.siteAreaM2} onChange={(e) => set("siteAreaM2", e.target.value)} />
            ) : (
              <span className="min-w-[4rem] text-right">{draft.siteAreaM2 || "　"}</span>
            )}
            <span className="shrink-0">m2(以實際設計結果為準)</span>
          </span>
        );
      case "designScope":
        if (!editable) return designScopeText(draft.designScope) || "—";
        return (
          <div className="w-full space-y-1 py-0.5">
            {draft.designScope.map((row, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
                <input aria-label={`設計內容第 ${idx + 1} 列科別`} className={`${cellInput} sm:w-24 sm:flex-none`} list="sheet-discipline-suggestions" placeholder="科別" value={row.discipline} onChange={(e) => patchScopeRow(idx, { discipline: e.target.value })} />
                <input aria-label={`設計內容第 ${idx + 1} 列項目`} className={`${cellInput} flex-1`} placeholder="服務項目" value={row.item ?? ""} onChange={(e) => patchScopeRow(idx, { item: e.target.value })} />
                <input aria-label={`設計內容第 ${idx + 1} 列金額`} className={`${cellInput} text-right sm:w-32 sm:flex-none`} type="number" min="0" placeholder="金額" value={row.amount ?? ""} onChange={(e) => patchScopeRow(idx, { amount: e.target.value === "" ? null : Number(e.target.value) })} />
                <button type="button" className="shrink-0 px-1 text-xs text-gray-400 hover:text-red-600" onClick={() => setDraft((d) => ({ ...d, designScope: d.designScope.filter((_, i) => i !== idx) }))}>
                  移除
                </button>
              </div>
            ))}
            <button type="button" className="text-xs font-medium" style={{ color: "var(--brand)" }} onClick={() => set("designScope", [...draft.designScope, { discipline: "", item: "", amount: null }])}>
              ＋ 新增一列
            </button>
            <datalist id="sheet-discipline-suggestions">
              {COMMON_DISCIPLINES.map((d) => <option key={d} value={d} />)}
            </datalist>
          </div>
        );
      case "clientName":
        return editable ? (
          <div className="w-full [&_input]:max-w-none [&_input]:text-[13px]">
            {/* 換客戶時清掉客戶欄位的修改（那些是改「原客戶」名冊用的）。 */}
            <ClientCombo clients={clientChoices} clientId={draft.clientId || null} onChange={(id) => setDraft((d) => ({ ...d, clientId: id ?? "", clientEdits: {} }))} />
          </div>
        ) : (client?.name ?? "—");
      case "clientPhone":
        return clientInput("phone");
      case "invoiceAddress":
        return clientInput("invoiceAddress");
      case "orderDocument":
        if (editable) {
          const contractChecked = hasContractDoc || draft.orderDocType === "contract";
          const quotationChecked = draft.orderDocType === "contract" ? false : orderDoc?.docType === "quotation" || (!orderDoc && draft.orderDocType === "quotation");
          const cellsNow = orderDocumentCells(orderDoc);
          const opts: Array<{ type: "contract" | "quotation"; label: string; checked: boolean; date: string; canToggle: boolean; lockedTitle: string }> = [
            { type: "contract", label: "合約書", checked: contractChecked, date: cellsNow[0].date, canToggle: !hasContractDoc, lockedTitle: "本案已有合約；要作廢或改簽訂日請到下方「合約與報價單」" },
            { type: "quotation", label: "報價單", checked: quotationChecked, date: cellsNow[1].date, canToggle: !orderDoc, lockedTitle: "本案已有訂單文件；要改請到下方「合約與報價單」" },
          ];
          return (
            <span className="flex flex-wrap items-center gap-x-2" data-testid="sheet-order-document" role="radiogroup" aria-label="訂單">
              {opts.map((o) =>
                o.canToggle ? (
                  <button
                    key={o.type}
                    type="button"
                    role="radio"
                    aria-checked={o.checked}
                    className="rounded-sm border border-amber-200 bg-white/90 px-1 hover:border-amber-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                    onClick={() => set("orderDocType", draft.orderDocType === o.type ? "" : o.type)}
                  >
                    <span aria-hidden="true">{o.checked ? "■" : "□"}</span>{o.label}{o.date ? ` ${o.date}` : ""}
                  </button>
                ) : (
                  <span key={o.type} role="radio" aria-checked={o.checked} title={o.lockedTitle}>
                    {o.checked ? "■" : "□"}{o.label}{o.date ? ` ${o.date}` : ""}
                  </span>
                ),
              )}
              {plan.contract && (plan.contract.kind === "quotation-create" || (plan.contract.kind === "main" && plan.contract.created)) && (
                <span className="text-[11px] text-amber-700">（儲存時建立）</span>
              )}
            </span>
          );
        }
        return (
          <span className="flex flex-wrap gap-x-2" data-testid="sheet-order-document">
            {orderDocumentCells(orderDoc).map((c) => (
              <span key={c.label}>{c.checked ? "■" : "□"}{c.label}{c.date ? ` ${c.date}` : ""}</span>
            ))}
          </span>
        );
      case "clientContact":
        if (!editable || !client || !canEditClients) return [client?.contactName, client?.contactPhone].filter(Boolean).join(" ");
        return (
          <span className="flex w-full gap-1">
            {/* basis-0＋grow 比例分寬（cellInput 自帶 w-full，用 width 會互搶）。 */}
            {clientInput("contactName", "basis-0 grow-[5]")}
            {clientInput("contactPhone", "basis-0 grow-[4]")}
          </span>
        );
      case "clientFax":
        return clientInput("fax");
      case "clientTaxId":
        return clientInput("taxId");
      case "invoiceType":
        return (
          <span className="flex flex-wrap items-center gap-x-2">
            <CheckBoxes<InvoiceType>
              ariaLabel="發票聯式"
              options={(Object.keys(INVOICE_TYPE_LABELS) as InvoiceType[]).map((v) => ({ value: v, label: INVOICE_TYPE_LABELS[v] }))}
              value={draft.invoiceType}
              editable={editable}
              onChange={(v) => set("invoiceType", v)}
            />
            {!draft.invoiceType && client?.invoiceType && (
              <span className="text-[11px] text-gray-400">（未指定，客戶預設{INVOICE_TYPE_LABELS[client.invoiceType]}）</span>
            )}
          </span>
        );
      case "paymentMethod":
        return (
          <span className="flex flex-wrap items-center gap-x-2">
            <CheckBoxes<PaymentMethod>
              ariaLabel="付款方式"
              options={(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((v) => ({ value: v, label: PAYMENT_METHOD_LABELS[v] }))}
              value={draft.paymentMethod}
              editable={editable}
              onChange={(v) => set("paymentMethod", v)}
            />
            {!draft.paymentMethod && client?.paymentMethod && (
              <span className="text-[11px] text-gray-400">（未指定，客戶預設{PAYMENT_METHOD_LABELS[client.paymentMethod]}）</span>
            )}
          </span>
        );
      case "remarks":
        return (
          <div className="w-full space-y-1 self-start py-0.5" data-testid="sheet-engineers">
            {engineerKeys.map((d) => {
              const v = draft.engineers[d] ?? { vendorId: null, name: null };
              const stale = !disciplines.includes(d);
              // 不 trim：自由輸入打到一半的空白要留著（存檔時 normalizeEngineer 才修剪）。
              const name = v.name ?? (v.vendorId ? vendorNameById.get(v.vendorId) ?? "" : "");
              return (
                <div key={d}>
                  <span>{disciplineLabel(d)}:</span>
                  {stale && (
                    <span className="ml-1 text-[11px] text-amber-700">
                      （已不在科別設定）
                      {editable && (
                        <button type="button" className="ml-1 underline hover:text-red-600" onClick={() => setDraft((f) => ({ ...f, engineers: { ...f.engineers, [d]: { vendorId: null, name: null } } }))}>
                          清除
                        </button>
                      )}
                    </span>
                  )}
                  {editable && !stale ? (
                    <input
                      aria-label={`協力技師（${disciplineLabel(d)}）`}
                      className={`${cellInput} inline-block w-[calc(100%-3.5em)] align-middle`}
                      list="sheet-vendor-suggestions"
                      placeholder="廠商名冊或自由輸入"
                      value={name}
                      onChange={(e) => {
                        // 打的字剛好是名冊廠商就連到該廠商（同 VendorCombo 選取）；否則當自由輸入、不掛廠商。
                        const text = e.target.value;
                        const match = vendors.find((x) => x.name === text.trim());
                        setDraft((f) => ({ ...f, engineers: { ...f.engineers, [d]: match ? { vendorId: match.id, name: match.name } : { vendorId: null, name: text } } }));
                      }}
                    />
                  ) : (
                    <span className="ml-0.5">{name}</span>
                  )}
                </div>
              );
            })}
            {editable && (
              <datalist id="sheet-vendor-suggestions">
                {vendors.map((x) => <option key={x.id} value={x.name} />)}
              </datalist>
            )}
          </div>
        );
      case "amountUntaxed":
        if (!editable) return moneyText(money?.amountUntaxed);
        return (
          <input
            aria-label="銷售金額（未稅）"
            title={money?.amountSource === "quotation" ? "目前取自最新報價單" : undefined}
            className={`${cellInput} text-right`}
            type="number"
            min="0"
            inputMode="numeric"
            value={draft.amountUntaxed ?? (money?.amountUntaxed != null ? String(money.amountUntaxed) : "")}
            onChange={(e) => set("amountUntaxed", e.target.value)}
          />
        );
      case "taxAmount":
        return moneyText(sales.taxAmount);
      case "amountTotal":
        return moneyText(sales.amountTotal);
      case "closingDay":
        return editable ? (
          <input aria-label="結帳日" className={cellInput} value={draft.closingDay} placeholder={client?.closingDay ?? ""} onChange={(e) => set("closingDay", e.target.value)} />
        ) : (draft.closingDay || client?.closingDay || "");
      case "paymentDay":
        return editable ? (
          <input aria-label="付款日" className={cellInput} value={draft.paymentDay} placeholder={client?.paymentDay ?? ""} onChange={(e) => set("paymentDay", e.target.value)} />
        ) : (draft.paymentDay || client?.paymentDay || "");
    }
  }

  const numericFields = new Set<SheetField>(["amountUntaxed", "taxAmount", "amountTotal"]);

  // ---- 版面：上半部固定 10 列，接付款階段、空白分隔列、發包單位區塊 ----
  const cells: ReactNode[] = [];
  /**
   * 手機版是「標題｜內容」自動往下排，DOM 順序就是畫面順序；往下合併的格子（備註＝協力技師）
   * 要緊接在它上一列同欄的標題（「備  註:」）後面，不然會被下一列的格子隔開。桌機有明確的格線位置，不受影響。
   */
  const labelIndexAt = new Map<string, number>();
  APPLICATION_SHEET_TOP_ROWS.forEach((rowCells, r) => {
    let col = 1;
    rowCells.forEach((cell, i) => {
      const start = col;
      col += cell.span;
      if (cell.covered) return;
      const key = `top-${r}-${i}`;
      if (cell.title) {
        cells.push(
          <Cell key={key} col={start} span={cell.span} row={r + 1} kind="full" shade align="center" className="justify-center py-1.5 text-base font-bold tracking-[0.3em]">
            {cell.label}
          </Cell>,
        );
      } else if (cell.label) {
        cells.push(
          <Cell key={key} col={start} span={cell.span} row={r + 1} kind="label" shade={cell.shade} align={r <= 3 ? "right" : "center"}>
            {cell.label}
          </Cell>,
        );
        labelIndexAt.set(`${r}-${start}`, cells.length);
      } else if (cell.field) {
        const node = (
          <Cell key={key} col={start} span={cell.span} row={r + 1} rowSpan={cell.rowSpan} kind="value" align={numericFields.has(cell.field) ? "right" : "left"} testId={`sheet-${cell.field}`} className={blankCls(SHEET_FIELD_PRINT_BLOCK[cell.field])} editable={fieldEditable(cell.field)}>
            {renderField(cell.field)}
          </Cell>
        );
        const insertAt = (cell.rowSpan ?? 1) > 1 ? labelIndexAt.get(`${r - 1}-${start}`) : undefined;
        if (insertAt !== undefined) cells.splice(insertAt, 0, node);
        else cells.push(node);
      }
    });
  });

  let row = APPLICATION_SHEET_TOP_ROWS.length + 1;
  const stageCols = APPLICATION_STAGE_SPANS.reduce<number[]>((acc, span, i) => [...acc, i === 0 ? 1 : acc[i - 1] + APPLICATION_STAGE_SPANS[i - 1]], []);
  for (const s of stageRows) {
    const r = row++;
    const guild = s.kind === "guild_advance";
    const key = stageRowKey(s);
    const base = stageBaseValues(s);
    const edit: StageEdit = editable ? (draft.stageEdits[key] ?? {}) : {};
    const locks = stageLocks(s);
    const val = (f: Exclude<keyof StageEdit, "overrideReason">) => edit[f] ?? base[f];
    const rowLabel = guild ? "技師公會代墊" : `付款階段第 ${s.no} 列`;
    cells.push(
      <Cell key={`stage-${s.no}-0`} col={stageCols[0]} span={APPLICATION_STAGE_SPANS[0]} row={r} kind="label" shade testId={`sheet-stage-${s.no}`}>
        {editable ? (
          <span className="flex w-full items-center gap-0.5">
            <span className="shrink-0">{s.no}.</span>
            <input aria-label={`${rowLabel}項目說明`} className={cellInput} maxLength={200} placeholder={guild ? "" : "項目說明"} value={val("milestone")} onChange={(e) => setStage(key, "milestone", e.target.value)} />
          </span>
        ) : (
          `${s.no}.${s.milestone}`
        )}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-1`} col={stageCols[1]} span={APPLICATION_STAGE_SPANS[1]} row={r} kind="value" align="center" editable={editable && !locks.percentage}>
        {editable && !locks.percentage ? (
          <span className="flex w-full items-center gap-0.5">
            <input aria-label={`${rowLabel}百分比`} className={`${cellInput} text-right`} type="number" min="0" max="100" inputMode="decimal" value={val("percentage")} onChange={(e) => setStage(key, "percentage", e.target.value)} />
            <span className="shrink-0">%</span>
          </span>
        ) : s.percentage != null ? `${s.percentage}%` : ""}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-2`} col={stageCols[2]} span={APPLICATION_STAGE_SPANS[2]} row={r} kind="value" align="right" editable={editable && !locks.amount}>
        {editable && !locks.amount ? (
          <input aria-label={`${rowLabel}金額`} title="填了就是人工指定金額；清空＝依百分比試算" className={`${cellInput} text-right`} type="number" min="0" inputMode="numeric" value={val("amount")} onChange={(e) => setStage(key, "amount", e.target.value)} />
        ) : (
          <span title={editable && locks.amount ? "已請款／已入帳，金額凍結" : undefined}>{s.amount != null ? fmtMoney(s.amount) : ""}</span>
        )}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-3`} col={stageCols[3]} span={APPLICATION_STAGE_SPANS[3]} row={r} kind="value" editable={editable && !locks.receivedOn}>
        {editable && !locks.receivedOn ? (
          <span className="flex w-full items-center gap-1 whitespace-nowrap">
            已於
            <input aria-label={`${rowLabel}入帳日期`} className={`${cellInput} px-0.5`} type="date" value={val("receivedOn")} onChange={(e) => setStage(key, "receivedOn", e.target.value)} />
            入賬
          </span>
        ) : (
          <span className="whitespace-pre" title={editable && locks.receivedOn ? "已入帳；撤銷請到下方「分期請款期程」" : undefined}>已於 {s.receivedOn ? rocDots(s.receivedOn) : "         "} 入賬</span>
        )}
      </Cell>,
      <Cell key={`stage-${s.no}-4`} col={stageCols[4]} span={APPLICATION_STAGE_SPANS[4]} row={r} kind="label" shade align="center">
        {guild ? "審迄還款:" : "發票號碼:"}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-5`} col={stageCols[5]} span={APPLICATION_STAGE_SPANS[5]} row={r} kind="value" editable={editable && (guild || !locks.invoiceNo)}>
        {guild
          ? editable ? (
              <input
                aria-label="審迄還款"
                className={cellInput}
                maxLength={GUILD_REPAYMENT_NOTE_MAX}
                placeholder="例：115.9.30 還款"
                value={draft.guildRepaymentNote}
                onChange={(e) => set("guildRepaymentNote", e.target.value)}
              />
            ) : draft.guildRepaymentNote
          : editable && !locks.invoiceNo ? (
              <input aria-label={`${rowLabel}發票號碼`} title="儲存時登記開票（開票日＝今天，可到下方卡片撤銷重開）" className={cellInput} maxLength={40} placeholder="發票號碼" value={val("invoiceNo")} onChange={(e) => setStage(key, "invoiceNo", e.target.value)} />
            ) : (
              <span title={editable ? "已開票；撤銷請到下方「分期請款期程」" : undefined}>{[s.invoiceNo, rocDots(s.invoicedOn)].filter(Boolean).join(" ")}</span>
            )}
      </Cell>,
    );
  }
  // Word 第 19 列：付款階段與發包單位之間的空白列。
  cells.push(<Cell key="spacer" col={1} span={16} row={row++} kind="full" className="hidden h-6 md:flex print:flex print:h-5" />);

  const subCols = APPLICATION_SUBCONTRACT_SPANS.reduce<number[]>((acc, span, i) => [...acc, i === 0 ? 1 : acc[i - 1] + APPLICATION_SUBCONTRACT_SPANS[i - 1]], []);
  const summaryValues: ReactNode[] = [
    moneyText(money?.subcontractTotal),
    editable ? (
      <input key="other" aria-label="其他支出" className={`${cellInput} text-right`} type="number" min="0" value={draft.otherExpenses} onChange={(e) => set("otherExpenses", e.target.value)} />
    ) : moneyText(money?.otherExpenses),
    showProfit ? moneyText(money?.profit) : <span title="屬集團財務，僅老闆與授權人員可見">—</span>,
    showProfit ? (canFinance && money?.grossMarginPct != null ? `${money.grossMarginPct}%` : "—") : <span title="屬集團財務，僅老闆與授權人員可見">—</span>,
    "",
  ];
  const SUB_FIELD_BY_ROW = ["vendorName", "contact", "item", "amount", "billingBasis"] as const;
  subBlocks.forEach((block, b) => {
    APPLICATION_SUBCONTRACT_LABELS.forEach((label, i) => {
      const r = row++;
      const field = SUB_FIELD_BY_ROW[i];
      const valueOf = (sub: Subcontract | null): ReactNode => {
        if (!sub) return "";
        if (i === 0) return sub.vendorName || "";
        if (i === 1) return sub.contact || "";
        if (i === 2) return sub.item || "";
        if (i === 3) return fmtMoney(sub.amount);
        return sub.billingBasis || "";
      };
      const baseOf = (sub: Subcontract | null): string => {
        if (!sub) return "";
        if (field === "amount") return String(sub.amount ?? 0);
        return sub[field] ?? "";
      };
      cells.push(
        <Cell key={`sub-${b}-${i}-l`} col={subCols[0]} span={APPLICATION_SUBCONTRACT_SPANS[0]} row={r} kind="label" shade align="center">
          {label}
        </Cell>,
      );
      block.forEach((slot, j) =>
        cells.push(
          <Cell className={blankCls("subcontract")} key={`sub-${b}-${i}-${j}`} col={subCols[1 + j]} span={APPLICATION_SUBCONTRACT_SPANS[1 + j]} row={r} kind="value" align={i === 3 ? "right" : "center"} editable={editable}>
            {editable ? (
              <input
                aria-label={`發包單位第 ${b * 3 + j + 1} 欄${label.replace(/[\s：]/g, "")}`}
                className={`${cellInput} ${i === 3 ? "text-right" : "text-center"}`}
                list={i === 0 ? "sheet-vendor-suggestions" : undefined}
                type={i === 3 ? "number" : "text"}
                min={i === 3 ? "0" : undefined}
                inputMode={i === 3 ? "numeric" : undefined}
                value={draft.subEdits[slot.key]?.[field] ?? baseOf(slot.sub)}
                onChange={(e) => setSub(slot.key, field, e.target.value)}
              />
            ) : (
              valueOf(slot.sub)
            )}
          </Cell>,
        ),
      );
      cells.push(
        <Cell key={`sub-${b}-${i}-sl`} col={subCols[4]} span={APPLICATION_SUBCONTRACT_SPANS[4]} row={r} kind="label" shade align="right">
          {b === 0 ? APPLICATION_SUMMARY_LABELS[i] : ""}
        </Cell>,
        <Cell className={blankCls("subcontract")} key={`sub-${b}-${i}-sv`} col={subCols[5]} span={APPLICATION_SUBCONTRACT_SPANS[5]} row={r} kind="value" align="right" testId={b === 0 && i === 1 ? "sheet-other-expenses" : undefined} editable={editable && b === 0 && i === 1}>
          {b === 0 ? summaryValues[i] : ""}
        </Cell>,
      );
    });
  });

  const failedSteps = report?.steps.filter((st) => st.status !== "ok") ?? [];
  const okSteps = report?.steps.filter((st) => st.status === "ok") ?? [];

  return (
    <section aria-label="專案申請單" className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-5 print:rounded-none print:border-0 print:p-0 print:shadow-none" data-testid="application-sheet">
      {/* 存檔中整張鎖住：存完會用「剩下的草稿」取代，存檔期間打的字會被蓋掉。 */}
      <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
      <div className="mx-auto w-full max-w-[960px] text-gray-900 print:max-w-none" style={{ fontFamily: SHEET_FONT }}>
        {/* 抬頭：標誌＋「專案申請單 民國　年　月　日」、承接公司、工程名稱／專案序號 */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <img src="/brand/aster-logo.svg" alt="" aria-hidden="true" className="h-7 w-auto" />
          <h2 className="text-xl font-bold">專案申請單</h2>
          <span className="flex flex-wrap items-center gap-1 text-base font-bold">
            民國<span className="min-w-[2.5em] border-b border-gray-800 text-center">{opened?.year ?? ""}</span>年
            <span className="min-w-[1.5em] border-b border-gray-800 text-center">{opened?.month ?? ""}</span>月
            <span className="min-w-[1.5em] border-b border-gray-800 text-center">{opened?.day ?? ""}</span>日
            {editable && (
              <input aria-label="開案日期" type="date" className="ml-1 rounded border border-gray-300 px-1 py-0.5 font-sans text-xs font-normal" value={draft.openedOn} onChange={(e) => set("openedOn", e.target.value)} />
            )}
          </span>
        </div>
        <div className="mt-1 text-base" data-testid="application-company-name">
          {editable && companyChoices.length > 0 ? (
            <select aria-label="承接公司" className="max-w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-base hover:border-gray-300 focus:border-[var(--brand)] focus:outline-none" value={selectedCompanyId(draft.companyId, companies)} onChange={(e) => set("companyId", e.target.value)}>
              {companyChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          ) : (
            companyLabel
          )}
        </div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-base">
          <label className="flex min-w-0 flex-1 items-center gap-1">
            <span className="shrink-0">工程名稱：</span>
            {editable ? (
              <input aria-label="工程名稱" className={`${cellInput} text-base`} value={draft.name} onChange={(e) => set("name", e.target.value)} />
            ) : (
              <span>{draft.name}</span>
            )}
          </label>
          <span className="shrink-0">專案序號：<span className="font-mono">{project.code ?? "—"}</span></span>
        </div>

        {/* 專案明細表：外框雙線、內框單線（gap-px 露出底色當格線）。 */}
        <div
          className="grid grid-cols-[6.5rem_minmax(0,1fr)] border-[3px] border-double border-gray-800 md:gap-px md:bg-gray-800 md:[grid-template-columns:var(--cols)] print:gap-px print:bg-gray-800 print:[grid-template-columns:var(--cols)] print:break-inside-avoid"
          style={{ "--cols": GRID_TEMPLATE } as CSSProperties}
        >
          {cells}
        </div>
      </div>
      </fieldset>

      {!print && (
      <div className="no-print mx-auto mt-3 flex w-full max-w-[960px] flex-col gap-2">
        {editable ? (
          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton onClick={save} disabled={saving || dirtyCount === 0 || validation.length > 0}>
              {saving ? "儲存中…" : "儲存申請單"}
            </PrimaryButton>
            {dirtyCount > 0 ? (
              <>
                <span className="text-sm text-amber-700">{dirtyCount} 個欄位尚未儲存</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(applicationSheetDraftOf(project, disciplines)); setReport(null); }}>還原</Button>
              </>
            ) : (
              <span className="text-sm text-gray-400">沒有未儲存的變更</span>
            )}
            <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => set("subExtraBlocks", draft.subExtraBlocks + 1)}>
              ＋ 多開一組發包欄
            </Button>
          </div>
        ) : (
          <p className="text-sm text-gray-500">唯讀：修改申請單需要本案的財務權限（HR／會計／本案經理、主辦／部門主管）。</p>
        )}
        {editable && plan.client && (
          <p className="text-sm text-amber-800" data-testid="sheet-client-sync-hint">
            儲存時會同步更新客戶名冊「{plan.client.name}」的{Object.keys(plan.client.body).map((f) => CLIENT_SHEET_FIELD_LABELS[f as ClientSheetField]).join("、")}（所有用這個客戶的專案都會一起變）。
          </p>
        )}
        {editable && !canEditClients && client && (
          <p className="text-xs text-gray-500">客戶的電話、發票地址、採購承辦、傳真、統一編號屬客戶名冊，只有 HR／會計能修改。</p>
        )}
        {editable && plan.stages.needsReason.length > 0 && (
          <div className="space-y-1 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-testid="sheet-override-reasons">
            <p className="text-amber-900">付款階段改了金額＝人工指定金額，請說明理由（例如議價、業主要求）：</p>
            {plan.stages.needsReason.map((r) => (
              <label key={r.key} className="flex items-center gap-2">
                <span className="shrink-0 text-amber-900">{r.label}</span>
                <input
                  aria-label={`付款階段${r.label}人工指定理由`}
                  className={`${cellInput} max-w-md`}
                  maxLength={1000}
                  value={draft.stageEdits[r.key]?.overrideReason ?? ""}
                  onChange={(e) => setStage(r.key, "overrideReason", e.target.value)}
                />
              </label>
            ))}
          </div>
        )}
        {editable && plan.warnings.length > 0 && (
          <ul className="text-sm text-amber-700">{plan.warnings.map((m) => <li key={m}>{m}</li>)}</ul>
        )}
        {validation.length > 0 && editable && (
          <ul className="text-sm text-red-600">{validation.map((m) => <li key={m}>{m}</li>)}</ul>
        )}
        {report && (
          <div role="status" className="space-y-1 text-sm" data-testid="sheet-save-report">
            {failedSteps.length > 0 && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                <p className="font-medium">以下部分沒有存成（其餘已儲存，修正後再按一次「儲存申請單」只會送這些）：</p>
                <ul className="mt-1 list-disc pl-5">
                  {failedSteps.map((st, i) => (
                    <li key={`${st.section}-${i}`}>{st.label}：{st.status === "skipped" ? "未送出，" : ""}{st.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {okSteps.length > 0 && (
              <p className="text-green-700">已儲存：{okSteps.map((st) => st.label).join("、")}。</p>
            )}
            {report.notices.map((n) => <p key={n} className="text-amber-700">{n}</p>)}
          </div>
        )}
        <p className="text-xs text-gray-500">
          <span className="mr-1 inline-block h-3 w-3 border border-amber-200 align-middle" style={{ backgroundColor: EDITABLE_BG }} aria-hidden="true" />
          淡黃底的格子可以直接點進去改，改完按「儲存申請單」一次存；白底是系統算的（營業稅、銷售總額、發包小計、利潤、毛利率）。
          電話、發票地址、採購承辦、傳真、統一編號存的是<a href="/admin/clients" className="underline">客戶名冊</a>那一筆（其他專案一起更新）；
          訂單與銷售金額寫回<a href="#project-contracts" className="underline">合約與報價單</a>；付款階段寫回<a href="#project-billings" className="underline">分期請款期程</a>（填發票號碼＝登記開票、填入帳日＝登記入帳）；發包單位寫回<a href="#project-subcontracts" className="underline">副委託</a>。
          已開票／已入帳要撤銷、人工指定金額的理由、副委託的扣繳與期款，在下方各卡片處理。
        </p>
      </div>
      )}

      {/* 未儲存提醒：捲到下方其他卡片時也看得到（下方卡片存檔重新載入不會清掉草稿，但要提醒還沒存）。 */}
      {editable && dirtyCount > 0 && (
        <div role="status" className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-amber-200 bg-amber-50/95 px-4 py-2 lg:pr-44 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] backdrop-blur" data-testid="sheet-unsaved-bar">
          <div className="mx-auto flex max-w-[960px] flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-amber-900">
            <span className="mr-auto">申請單有 {dirtyCount} 個欄位尚未儲存。</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => document.querySelector('[data-testid="application-sheet"]')?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              回到申請單
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={save} disabled={saving || validation.length > 0}>{saving ? "儲存中…" : "儲存申請單"}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
