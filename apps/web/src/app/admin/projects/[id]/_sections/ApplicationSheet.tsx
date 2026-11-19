"use client";

import { BOUND_SUBCONTRACT_LOCKED_NOTE, useCanManageBoundSubcontracts } from "@/lib/use-bound-subcontract-permission";
import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Button, PrimaryButton } from "@/components/admin-ui";
import { ClientCombo } from "@/components/ClientCombo";
import { QuickNewClientForm } from "@/components/QuickNewClientForm";
import { EmployeeCombobox } from "@/components/EmployeeCombobox";
import { MoneyInput } from "@/components/MoneyInput";
import { AddDisciplineOptionButton, DesignDisciplineDatalist } from "@/components/DesignDisciplineInput";
import { ProjectCodeField } from "./ProjectCodeField";
import { ReinvoiceDialog, type ReinvoiceTarget } from "./ReinvoiceDialog";
import { useInvoicedAck } from "@/components/InvoicedAckDialog";
import { billingScheduleVersion } from "@/lib/billing-version";
import { COMMITTED_CONFLICT_MESSAGE, conflictKindOf, type InvoicedAckBody } from "@/lib/invoiced-ack";
import { INVOICED_AMOUNT_CHANGED_NOTICE, isBillingInvoiced } from "@/lib/billing-invoice";
import { PROJECT_NO_MAX } from "@/lib/project-no";
import type { Vendor } from "@/lib/company-api";
import { companyOptions } from "@/lib/company-options";
import { createContract, updateContract, type Contract } from "@/lib/projects-api";
import {
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  clientSaveWarningText,
  createClient,
  disciplineLabel,
  getBillingSchedule,
  getProjectSubcontracts,
  humanizeBillingError,
  humanizeClientError,
  humanizeProjectExtError,
  humanizeSubcontractError,
  invoiceBilling,
  listClients,
  putBillingShares,
  putProjectSubcontractsWithRebind,
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
  APPLICATION_STAGE_BONUS_HEADERS,
  APPLICATION_STAGE_BONUS_WEIGHTS,
  APPLICATION_STAGE_HEADERS,
  APPLICATION_STAGE_SPANS,
  APPLICATION_SUBCONTRACT_HEADERS,
  APPLICATION_SUMMARY_LABELS,
  CLIENT_SHEET_FIELD_LABELS,
  applicationSheetDraftOf,
  applicationSheetErrors,
  applicationSubcontractRows,
  isExtraStageRow,
  removeNewSubcontractRow,
  removeStageExtraRow,
  stageRemoveBlockReason,
  toggleStageRemoved,
  subcontractHasPaid,
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
  stageContractTotal,
  stageLocks,
  stageScreenAmount,
  savedHasShares,
  sharesOverLimit,
  sheetStageRows,
  type SheetSaveApi,
  type SheetSaveStep,
} from "@/lib/project-application-sheet-save";
import { estimatedStageAmount } from "@/lib/project-application-stage-amounts";
import { applyStageAmountEdit, applyStagePctEdit, formatStagePct, releaseTypedPercentages, stageAmountDisplay, stagePctDisplay, stageScheduleSummary } from "@/lib/project-application-stage-amounts";

import {
  currentBonusAmount,
  currentBonusPaidOn,
  currentFormulaNote,
  currentShareLines,
  filledShareLines,
  FORMULA_NOTE_MAX,
  overviewCells,
  shareCapOf,
  shareCellSummary,
  shareLinesTotal,
  sharePctText,
  shareSetOf,
  type BillingSharesView,
  type ShareEdit,
  type ShareLine,
} from "@/lib/project-billing-shares";
import { employeeOptionsOf, type EmployeeOption } from "@/lib/employee-combobox";
import { formatMoney } from "@/lib/money";
import { engineerForTypedName } from "@/lib/vendor-name-binding";
import { sheet } from "@/lib/sheet-styles";
import { selectedCompanyId } from "../../_components/project-application-form";
import { fmtMoney, humanError } from "./shared";

const GRID_TEMPLATE = APPLICATION_SHEET_COLUMNS.map((w) => `minmax(0, ${w}fr)`).join(" ");

/**
 * 格子內的輸入框（2026-10-27 起跟後台輸入框同一套淡框＋品牌色聚焦，lib/sheet-styles.ts）：
 * 可填的格子裡一定有這個框，一眼分得出「可以填」與「系統算的／唯讀」（沒有框）。列印模式沒有輸入框。
 */
const cellInput = sheet.input;
/** 驗證擋住儲存的格子：淡紅底＋紅框，列印不顯示。 */
const INVALID_CELL_CLS = "bg-red-50! ring-1 ring-inset ring-red-400 print:bg-white! print:ring-0";
const INVALID_INPUT_CLS = "bg-red-50 ring-1 ring-red-400 print:bg-transparent print:ring-0";
/** 格子裡的 ■／□ 選項鈕（可編輯時）：跟輸入框同樣的淡框。 */
const cellChoice =
  "rounded-md border border-gray-300 bg-white px-1 hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";

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
  errField,
  invalid = false,
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
  /** 這格可以直接填（格內有淡框輸入框；data-editable 給測試／樣式用）。 */
  editable?: boolean;
  /** 這格對應的驗證錯誤 field（空白分隔；點「無法儲存」時據此捲動並 focus）。 */
  errField?: string;
  /** 這格有驗證錯誤：淡紅底＋紅框（列印不顯示）。 */
  invalid?: boolean;
}) {
  const style = {
    "--gc": `${col} / span ${span}`,
    "--gr": `${row} / span ${rowSpan}`,
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
      data-err-field={errField}
      data-invalid={invalid ? "true" : undefined}
      className={`${place} flex min-w-0 items-center border-b border-gray-200 ${shade ? "bg-gray-50" : "bg-white"} px-2 py-1 text-[13px] leading-[1.4] md:border-0 md:[grid-column:var(--gc)] md:[grid-row:var(--gr)] print:border-0 print:px-1 print:py-0.5 print:text-[11px] print:[grid-column:var(--gc)] print:[grid-row:var(--gr)] ${alignCls} ${kind === "label" ? "whitespace-pre text-xs font-medium text-gray-600" : "text-gray-900"} ${invalid ? INVALID_CELL_CLS : ""} ${className}`}
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
            className={cellChoice}
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
  /** 重新抓客戶名冊（客戶名稱格聚焦時呼叫：別的分頁剛新增的客戶才選得到）。省略且沒給 clients＝元件自己重抓。 */
  onRefreshClients?: () => Promise<void>;
  /** 上次儲存的結果（page.tsx 持有；存完重新載入時本元件會重掛）。省略＝元件自己保存。 */
  saveReport?: ApplicationSheetSaveReport | null;
  onSaveReport?: (report: ApplicationSheetSaveReport | null) => void;
  /**
   * 唯讀檢視（2026-11-10 申請單舊版本）：同一版面、金額照顯示，但沒有任何輸入框、儲存列與說明文字。
   * 與 canFinance=false 不同：canFinance=false 連金額都不顯示。
   */
  readOnly?: boolean;
  /** 標題旁的版本號（「第 3 版」）；列印也會印。省略＝不顯示。 */
  versionLabel?: string;
  /** 標題旁的版本控制（版本下拉、另存新版本）；列印不印。函式形式拿得到「有未儲存修改」。 */
  versionControls?: ReactNode | ((state: { dirty: boolean }) => ReactNode);
  /** 申請單最上方的橫幅（檢視舊版時的黃色提示）；列印不印。 */
  banner?: ReactNode;
  /**
   * 每期款獎金分潤（2026-11-11，GET /projects/:id/billing-shares）：有值且 available 時付款階段多畫
   * 「獎金分潤」「發獎金日」兩欄；canEdit 時可編輯。省略／null＝看不到（無權限），維持原 7 欄。列印／舊版檢視不畫。
   */
  billingShares?: BillingSharesView;
  /** 分潤選人的員工清單（在職）。 */
  shareEmployees?: ReadonlyArray<{ id: string; name?: string | null; empNo?: string | null; emp_no?: string | null }>;
}

/** 沒有客戶名冊寫入權時「＋ 新增客戶」的說明（POST /clients 只放行 HR／會計／平台管理員）。 */
export const NEW_CLIENT_LOCKED_NOTE = "新增客戶會寫進客戶名冊，只有 HR／會計（或平台管理員）能新增；請他們先在「客戶名冊」建檔，再回來搜尋選用。";

/** 名冊 ∪ 本單剛建的客戶（名冊已有同 id 的以名冊為準）。 */
export function mergeCreatedClients(roster: readonly Client[], created: readonly Client[]): Client[] {
  if (created.length === 0) return roster as Client[];
  const ids = new Set(roster.map((c) => c.id));
  return [...roster, ...created.filter((c) => !ids.has(c.id))];
}

/**
 * 專案明細頁上半部：版面照公司 Word「專案申請單」（抬頭、專案明細表、付款階段、發包單位），
 * 整張表像 Excel 一樣在格子裡直接改（格內有淡框輸入框＝可填），按「儲存申請單」一次存：
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
  onRefreshClients,
  canEditClients = true,
  saveReport: controlledReport,
  onSaveReport,
  readOnly = false,
  versionLabel,
  versionControls,
  banner,
  billingShares,
  shareEmployees,
}: ApplicationSheetProps) {
  const print = mode === "print";
  const [localDraft, setLocalDraft] = useState<ApplicationSheetDraft>(() => applicationSheetDraftOf(project, disciplines));
  const draft = controlledDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;
  const [ownClients, setOwnClients] = useState<Client[]>([]);
  /** 這張單上剛「＋ 新增客戶」建的客戶：名冊（page.tsx 持有）重抓回來前先併進來，選得到也顯示得出資料。 */
  const [createdClients, setCreatedClients] = useState<Client[]>([]);
  const rosterClients = clientsProp ?? ownClients;
  const clients = useMemo(() => mergeCreatedClients(rosterClients, createdClients), [rosterClients, createdClients]);
  /** 就地新增客戶表單：null＝收起；字串＝展開並預填的名稱。 */
  const [newClientName, setNewClientName] = useState<string | null>(null);
  const [newClientNotice, setNewClientNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** 正在輸入的發包金額格（slot key）：聚焦時顯示純數字方便改，離開後顯示千分位。 */
  const [editingSubAmount, setEditingSubAmount] = useState<string | null>(null);
  const [localReport, setLocalReport] = useState<ApplicationSheetSaveReport | null>(null);
  const report = controlledReport !== undefined ? controlledReport : localReport;
  const setReport = onSaveReport ?? setLocalReport;
  const editable = canFinance && !print && !readOnly;
  /** S2 擴大（2026-11-17）：已綁定名冊廠商的發包列，只有老闆／平台管理員能改單位（改綁／解綁）或移除。 */
  const canManageBound = useCanManageBoundSubcontracts();
  /** 付款階段的「獎金分潤／發獎金日」兩欄（看得到才畫；列印與舊版檢視不畫）。 */
  const shareView: BillingSharesView = canFinance && !print && !readOnly && billingShares?.available ? billingShares : null;
  const showShares = !!shareView;
  const sharesEditable = editable && !!shareView?.canEdit;
  /** 正在展開分潤明細的付款階段列（stageRowKey）。 */
  const [openShareKey, setOpenShareKey] = useState<string | null>(null);
  /** 「修正」已登記發票的視窗（2026-11-18）：null＝收起。 */
  const [reinvoiceTarget, setReinvoiceTarget] = useState<ReinvoiceTarget | null>(null);
  const invoicedAck = useInvoicedAck();
  const blockOn = (key: PrintBlockKey) => printChecked?.[key] ?? true;
  /** 未勾選的列印區塊：螢幕淡化、列印時文字透明（格線與標題照印）。 */
  const blankCls = (key: PrintBlockKey) => (blockOn(key) ? "" : "opacity-40 print:opacity-100 print:text-transparent print:**:text-transparent");

  useEffect(() => {
    if (print || readOnly || clientsProp) return;
    listClients().then((r) => setOwnClients(r.clients)).catch(() => {});
  }, [print, readOnly, clientsProp]);
  /** 客戶名稱格聚焦時重抓名冊；page.tsx 持有名冊時交給它，否則重抓自己那份。 */
  const refreshClients =
    onRefreshClients ?? (clientsProp ? undefined : async () => setOwnClients((await listClients()).clients));

  /** POST /clients（只放行 HR／會計／平台管理員＝canEditClients）；成功併進名冊並重抓。 */
  async function createSheetClient(body: Parameters<typeof createClient>[0]): Promise<Client> {
    try {
      const res = await createClient(body);
      setCreatedClients((cs) => [...cs.filter((c) => c.id !== res.client.id), res.client]);
      setNewClientNotice(clientSaveWarningText(res));
      void Promise.resolve(refreshClients?.()).catch(() => {});
      return res.client;
    } catch (err) {
      throw new Error(humanizeClientError(err, "新增客戶失敗"));
    }
  }

  // 客戶資料格：草稿裡選的客戶（還沒存也即時顯示它的名冊資料）。
  const client: Client | null = resolveSheetClient(clients, project, draft.clientId);
  const plan = useMemo(
    () =>
      applicationSheetPlan(
        { project, canFinance: editable, canEditClient: canEditClients, disciplines, client, money, contracts, billings, subcontracts, vendors, billingShares: shareView },
        draft,
      ),
    [project, editable, canEditClients, disciplines, client, money, contracts, billings, subcontracts, vendors, draft, shareView],
  );
  const dirtyCount = plan.dirtyCount;
  const validationErrors = [...applicationSheetErrors(draft, { canFinance }), ...plan.errors];
  const validation = [...new Set(validationErrors.map((e) => e.message))];
  const errFields = new Set(validationErrors.map((e) => e.field));
  const isBad = (...fields: string[]) => editable && fields.some((f) => errFields.has(f));
  const errAttr = (...fields: string[]) => ({ errField: fields.join(" "), invalid: isBad(...fields) });
  const blockedHint = validation.length > 0
    ? `無法儲存：${validation[0]}${validation.length > 1 ? `（還有 ${validation.length - 1} 項，見下方）` : ""}`
    : null;
  const blockedTitle = validation.length > 0 ? validation.join("\n") : undefined;
  /** 捲到第一個有錯的格子並 focus（點按鈕旁的紅字提示）。 */
  const focusFirstError = () => {
    const first = validationErrors[0];
    if (!first) return;
    const root = document.querySelector('[data-testid="application-sheet"]');
    const target = [...(root?.querySelectorAll<HTMLElement>("[data-err-field]") ?? [])].find((el) => el.dataset.errField?.split(" ").includes(first.field));
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    (target.matches("input,button,select,textarea") ? target : target.querySelector<HTMLElement>("input,button,select,textarea"))?.focus({ preventScroll: true });
  };

  const set = <K extends keyof ApplicationSheetDraft>(key: K, value: ApplicationSheetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setClientField = (field: ClientSheetField, value: string) =>
    setDraft((d) => ({ ...d, clientEdits: { ...d.clientEdits, [field]: value } }));
  const setStage = (key: string, field: keyof StageEdit, value: string) =>
    setDraft((d) => ({ ...d, stageEdits: { ...d.stageEdits, [key]: { ...d.stageEdits[key], [field]: value } } }));
  const setSub = (key: string, field: keyof SubEdit, value: string) =>
    setDraft((d) => ({ ...d, subEdits: { ...d.subEdits, [key]: { ...d.subEdits[key], [field]: value } } }));
  const patchShare = (key: string, next: ShareEdit) =>
    setDraft((d) => ({ ...d, shareEdits: { ...(d.shareEdits ?? {}), [key]: { ...(d.shareEdits?.[key] ?? {}), ...next } } }));

  /**
   * 期程樂觀鎖（2026-11-18）：整批存期程帶「這張申請單讀到的期程版本」。同一次存檔裡若先確認了「已開票期別金額變動」
   * （後端會在該期備註留紀錄、版本跟著變），改用確認後重新讀到的版本，免得自己的上一步被當成別人的修改。
   */
  let expectedVersion = billingScheduleVersion(billings);
  /** 銷售金額／期程會讓已開票期別金額改變（409）→ 跳確認視窗、填理由後帶 ack 重送。 */
  /**
   * 409 conflict_retry 且 committed（後端其實已寫入，期間有人開票／改期程）：這一步當成已完成（草稿清掉、不重送，
   * 免得合約或報價單重複），存檔結果另外提示「已存檔，但…請核對發票」，存完重新載入。
   */
  const committedNotices: string[] = [];
  const toleratingCommitted = async <T,>(call: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (conflictKindOf(err) !== "committed") throw err;
      committedNotices.push(COMMITTED_CONFLICT_MESSAGE);
      return fallback();
    }
  };
  const withInvoicedAck = async <T,>(call: (ack?: InvoicedAckBody) => Promise<T>): Promise<T> => {
    let acked = false;
    const result = await withInvoicedAckInner(call, () => {
      acked = true;
    });
    // 已開票期別金額經確認改動（銷售金額變了）：存完提示是否要修正發票。
    if (acked && !committedNotices.includes(INVOICED_AMOUNT_CHANGED_NOTICE)) committedNotices.push(INVOICED_AMOUNT_CHANGED_NOTICE);
    return result;
  };
  const withInvoicedAckInner = async <T,>(call: (ack?: InvoicedAckBody) => Promise<T>, onAck: () => void): Promise<T> => {
    let acked = false;
    const result = await toleratingCommitted(
      () =>
        invoicedAck.run((ack) => {
          if (ack) {
            acked = true;
            onAck();
          }
          return call(ack);
        }),
      async () => undefined as T,
    );
    if (acked) {
      // 重抓失敗不影響已成功的這一步：沿用舊版本（之後存期程若被判衝突，會提示重新整理）。
      try {
        const fresh = await getBillingSchedule(project.id);
        expectedVersion = fresh.version ?? billingScheduleVersion(fresh.installments);
      } catch {
        // 保留舊版本
      }
    }
    return result;
  };
  const api: SheetSaveApi = {
    updateProject: (body) => updateProjectFields(project.id, body),
    updateClient: async (id, body) => clientSaveWarningText(await updateClient(id, body)),
    upsertMainContract: (body) => withInvoicedAck((ack) => upsertMainContract(project.id, body, ack)),
    updateContract: (id, body) => withInvoicedAck((ack) => updateContract(id, body, ack)),
    createQuotation: (body) => withInvoicedAck((ack) => createContract(project.id, { docType: "quotation", title: "報價單", amount: body.amount }, ack)),
    saveBillingSchedule: async (installments) => {
      let acked = false;
      const res = await toleratingCommitted(
        () =>
          invoicedAck.run((ack) => {
            if (ack) acked = true;
            return saveBillingSchedule(project.id, installments, { expectedVersion, ack });
          }),
        // 已寫入：用重新讀到的期程當作這一步的結果（新建期別的 id 從這裡對回草稿）。
        () => getBillingSchedule(project.id),
      );
      // 已開票期別金額經確認改動：存完提示是否要修正發票。
      if (acked && !committedNotices.includes(INVOICED_AMOUNT_CHANGED_NOTICE)) committedNotices.push(INVOICED_AMOUNT_CHANGED_NOTICE);
      // 期程存好後版本換新：同一次存檔接著登記發票時帶新版本。
      expectedVersion = res.version ?? billingScheduleVersion(res.installments);
      return res;
    },
    invoiceBilling: (id, invoiceNo, invoicedOn, expectedAmount) =>
      invoiceBilling(id, { invoiceNo, ...(invoicedOn ? { invoicedOn } : {}), expectedVersion, ...(expectedAmount !== undefined ? { expectedAmount } : {}) }),
    receiveBilling: (id, receivedOn) => receiveBilling(id, { receivedOn }),
    // 第六輪：改綁另一家名冊廠商且有未付期款 → 跳輸入框問原因後重送。
    putSubcontracts: (list, deleteReason) =>
      putProjectSubcontractsWithRebind(project.id, deleteReason ? { subcontracts: list, deleteReason } : { subcontracts: list }, (m) => window.prompt(m)),
    fetchBillings: async () => (await getBillingSchedule(project.id)).installments,
    fetchSubcontracts: async () => (await getProjectSubcontracts(project.id)).subcontracts,
    saveBillingShares: (list, extra) => putBillingShares(project.id, list, extra),
    humanize: (section, err) => {
      const msg = err instanceof Error ? err.message : "";
      if (section === "shares") {
        if (/shares_exceed_amount/.test(msg)) return "某一期的獎金分潤合計超過該期金額（以存檔後的期別金額為準），請調整後再存。";
        if (/advance_billing_no_shares/.test(msg)) return "技師公會代墊（代墊款）不能設定獎金分潤。";
        if (/bonus_edit_boss_only|boss_not_configured/.test(msg)) return "只有老闆（或平台管理員）可以改獎金分潤。";
        if (/migration_required/.test(msg)) return "系統尚未開通每期獎金分潤（資料庫待更新），請稍後再試。";
        return humanError(err, "儲存失敗");
      }
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
        project, canFinance: editable, canEditClient: canEditClients, disciplines, client, money, contracts, billings, subcontracts, vendors, billingShares: shareView,
      });
      // 先把已存成的格子從草稿拿掉，再重新載入（沒存成的留著，下一次只送那些）。
      setDraft(result.residual);
      setReport({ steps: result.steps, notices: [...result.notices, ...committedNotices.filter((m, i, a) => a.indexOf(m) === i)] });
      if (result.steps.some((st) => st.status === "ok" || st.status === "warning")) await load?.();
    } finally {
      setSaving(false);
    }
  }

  // 名冊讀不到（或還沒載入）時至少放進本案目前的客戶，免得客戶名稱格看起來是空的。
  const clientChoices = project.client && !clients.some((c) => c.id === project.client?.id) ? [project.client, ...clients] : clients;
  const orderDoc = latestDocument !== undefined ? latestDocument : latestOrderDocument(contracts);
  // 付款階段列（2026-11-18 期數不限）：「＋ 新增一期」多開的空白列只在可編輯時畫；標記移除的列仍畫（可復原），但不算進合計。
  /** 這次存檔要填「指定理由」的列（人工指定金額、沒有可沿用的理由）。 */
  const needsReasonKeys = new Set(editable ? plan.stages.needsReason.map((r) => r.key) : []);
  const stageRows = sheetStageRows(billings, { stageExtraRows: editable ? (draft.stageExtraRows ?? 0) : 0 });
  const stageRemovedIds = new Set(editable ? (draft.stageRemovedIds ?? []) : []);
  const stageRowsKept = stageRows.filter((s) => !(s.id && stageRemovedIds.has(s.id)));
  const subRows = applicationSubcontractRows(subcontracts, editable ? draft.subExtraRows : 0, editable ? draft.subEdits : {});
  const subRemoved = new Set(editable ? draft.subRemovedIds : []);
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
  // 付款階段：金額為主、% ＝金額 ÷ 銷售金額（未稅）。總額取合約（後端試算口徑），沒有合約時用畫面上的未稅。
  /** % 反算金額只在後端會依 % 試算時做（有合約）；只有報價單時填 % 不連帶寫金額（不必人工指定理由）。 */
  const stageCalcTotal = editable ? stageContractTotal(money, contracts, draft) : null;
  const stageTotal = editable
    ? (stageContractTotal(money, contracts, draft) ?? (untaxedTyped !== null && Number.isFinite(untaxedTyped) ? untaxedTyped : (money?.amountUntaxed ?? null)))
    : null;

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

  /** 可直接填的格子（格內有輸入框）：唯讀計算格（營業稅、總額）與沒選客戶時的客戶欄位除外。 */
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
              <div key={idx} data-err-field={`designScope:${idx}`} className={`flex flex-wrap items-center gap-1 sm:flex-nowrap ${isBad(`designScope:${idx}`) ? "rounded bg-red-50 ring-1 ring-red-400 print:bg-transparent print:ring-0" : ""}`}>
                <input aria-label={`設計內容第 ${idx + 1} 列科別`} className={`${cellInput} sm:w-24 sm:flex-none`} list="sheet-discipline-suggestions" placeholder="科別" value={row.discipline} onChange={(e) => patchScopeRow(idx, { discipline: e.target.value })} />
                <AddDisciplineOptionButton value={row.discipline} projectId={project.id} />
                <input aria-label={`設計內容第 ${idx + 1} 列項目`} className={`${cellInput} flex-1`} placeholder="服務項目" value={row.item ?? ""} onChange={(e) => patchScopeRow(idx, { item: e.target.value })} />
                <MoneyInput aria-label={`設計內容第 ${idx + 1} 列金額`} className={`${cellInput} text-right sm:w-32 sm:flex-none`} placeholder="金額" value={row.amount ?? ""} onValueChange={(v) => patchScopeRow(idx, { amount: v === "" ? null : Number(v) })} />
                <button type="button" className="shrink-0 px-1 text-xs text-gray-400 hover:text-red-600" onClick={() => setDraft((d) => ({ ...d, designScope: d.designScope.filter((_, i) => i !== idx) }))}>
                  移除
                </button>
              </div>
            ))}
            <button type="button" className="text-xs font-medium" style={{ color: "var(--brand)" }} onClick={() => set("designScope", [...draft.designScope, { discipline: "", item: "", amount: null }])}>
              ＋ 新增一列
            </button>
            <DesignDisciplineDatalist id="sheet-discipline-suggestions" />
          </div>
        );
      case "clientName":
        return editable ? (
          <div className="w-full [&_input]:max-w-none [&_input]:rounded-md [&_input]:px-1.5 [&_input]:py-0.5 [&_input]:text-[13px]">
            {/* 換客戶時清掉客戶欄位的修改（那些是改「原客戶」名冊用的）。 */}
            <div className="flex flex-wrap items-start gap-2">
              <ClientCombo
                clients={clientChoices}
                clientId={draft.clientId || null}
                onRefresh={refreshClients}
                onChange={(id) => setDraft((d) => ({ ...d, clientId: id ?? "", clientEdits: {} }))}
                onCreateNew={canEditClients ? (name) => setNewClientName(name) : undefined}
              />
              <button
                type="button"
                data-testid="sheet-new-client-toggle"
                className="rounded-md border border-slate-300 px-2 py-0.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-50 print:hidden"
                disabled={!canEditClients}
                title={canEditClients ? undefined : NEW_CLIENT_LOCKED_NOTE}
                onClick={() => { setNewClientNotice(null); setNewClientName((cur) => (cur === null ? "" : null)); }}
              >
                {newClientName !== null ? "取消新增客戶" : "＋ 新增客戶"}
              </button>
            </div>
            {!canEditClients && <p className="mt-0.5 text-xs text-gray-500 print:hidden" data-testid="sheet-new-client-locked">{NEW_CLIENT_LOCKED_NOTE}</p>}
            {canEditClients && newClientName !== null && (
              <QuickNewClientForm
                key={newClientName}
                className="mt-1 print:hidden [&_input]:!max-w-none"
                clients={clientChoices}
                initialName={newClientName}
                onCreate={createSheetClient}
                onPicked={(picked) => {
                  // 換客戶＝清掉改原客戶名冊用的欄位修改；儲存申請單時才寫回專案。
                  setDraft((d) => ({ ...d, clientId: picked.id, clientEdits: {} }));
                  setNewClientName(null);
                }}
              />
            )}
            {newClientNotice && <p className="mt-0.5 text-xs text-amber-700 print:hidden">{newClientNotice}</p>}
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
                    className={cellChoice}
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
                        // 打的字剛好是名冊廠商就連到該廠商（同 VendorCombo：vendorIdForTypedName）；原本已綁定且名稱未變
                        // → 保留原 id；同名多筆無法判斷是哪一家 → 當自由輸入、不掛廠商。
                        const text = e.target.value;
                        const next = engineerForTypedName(vendors, v.vendorId, text);
                        setDraft((f) => ({ ...f, engineers: { ...f.engineers, [d]: next } }));
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
          <MoneyInput
            aria-label="銷售金額（未稅）"
            title={money?.amountSource === "quotation" ? "目前取自最新報價單" : undefined}
            className={`${cellInput} text-right`}
            value={draft.amountUntaxed ?? (money?.amountUntaxed != null ? String(money.amountUntaxed) : "")}
            onValueChange={(v) => setDraft((d) => ({ ...d, amountUntaxed: v, stageEdits: releaseTypedPercentages(d.stageEdits) }))}
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

  const SHEET_FIELD_ERR: Partial<Record<SheetField, string[]>> = {
    siteAreaM2: ["siteAreaM2"],
    orderDocument: ["orderDocType"],
    amountUntaxed: ["amountUntaxed"],
    clientTaxId: ["taxId"],
  };
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
          <Cell key={key} col={start} span={cell.span} row={r + 1} kind="full" shade align="center" className="justify-center py-1.5 text-sm font-semibold text-gray-900">
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
          <Cell key={key} col={start} span={cell.span} row={r + 1} rowSpan={cell.rowSpan} kind="value" align={numericFields.has(cell.field) ? "right" : "left"} testId={`sheet-${cell.field}`} className={blankCls(SHEET_FIELD_PRINT_BLOCK[cell.field])} editable={fieldEditable(cell.field)} {...errAttr(...(SHEET_FIELD_ERR[cell.field] ?? []))}>
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
  /*
   * 付款階段的格線：看不到獎金分潤＝跟 Word 一樣畫在 16 欄格線上（7 欄）；看得到＝9 欄，16 欄格線切不出夠寬的格子，
   * 改畫在付款階段自己的小格線裡（stageCells 包進一個跨 16 欄的容器，欄寬比例見 APPLICATION_STAGE_BONUS_WEIGHTS）。
   */
  const stageHeaders: readonly string[] = showShares ? APPLICATION_STAGE_BONUS_HEADERS : APPLICATION_STAGE_HEADERS;
  const S: readonly number[] = showShares ? stageHeaders.map(() => 1) : APPLICATION_STAGE_SPANS;
  const stageCols = S.reduce<number[]>((acc, _span, i) => [...acc, i === 0 ? 1 : acc[i - 1] + S[i - 1]], []);
  const stageCells: ReactNode[] = showShares ? [] : cells;
  let srow = showShares ? 1 : row;
  /** 備註欄在第幾欄（看得到分潤時，獎金分潤插在入帳日期與備註之間）。 */
  const NOTE = showShares ? 7 : 6;
  const shareOptions: EmployeeOption[] = (() => {
    if (!showShares) return [];
    const opts = employeeOptionsOf(shareEmployees ?? []);
    const known = new Set(opts.map((o) => o.id));
    // 已存的分潤對象不在在職清單（離職等）：補一個選項，免得選單顯示空白。
    for (const b of shareView?.billings ?? []) {
      for (const sh of b.shares) {
        if (known.has(sh.employeeId)) continue;
        known.add(sh.employeeId);
        opts.push({ id: sh.employeeId, label: sh.employeeName ?? "（已不在名冊）", note: "非在職" });
      }
    }
    return opts;
  })();
  const shareNameOf = (id: string) => shareOptions.find((o) => o.id === id)?.label ?? "";
  // 付款階段小表頭：欄名只印一次（桌機／列印）；手機堆疊版改由各格前的小標示說明。
  {
    const r = srow++;
    stageHeaders.forEach((h, i) => {
      stageCells.push(
        <Cell key={`stage-head-${i}`} col={stageCols[i]} span={S[i]} row={r} kind="label" shade align="center" testId={`sheet-stage-head-${i}`} className="hidden py-0.5 text-[11px] md:flex print:flex">
          {h}
        </Cell>,
      );
    });
  }
  /** 手機堆疊版沒有表頭，格內前面補一個小欄名；桌機／列印隱藏。 */
  const mLabel = (text: string) => <span className="mr-1 shrink-0 text-xs text-gray-500 md:hidden print:hidden">{text}</span>;
  for (const s of stageRows) {
    const r = srow++;
    const guild = s.kind === "guild_advance";
    const key = stageRowKey(s);
    const base = stageBaseValues(s);
    const edit: StageEdit = editable ? (draft.stageEdits[key] ?? {}) : {};
    const locks = stageLocks(s);
    /** 金額格顯示：已有金額照用；只有報價單（後端算不出期別金額）→ 銷售金額 × % 試算（灰字）。 */
    const stageEstimate = estimatedStageAmount(s.amount, s.percentage, money?.amountUntaxed);
    const val = (f: Exclude<keyof StageEdit, "overrideReason">) => edit[f] ?? base[f];
    const rowEdit = editable ? draft.stageEdits[key] : undefined;
    const patchStage = (next: StageEdit) => setDraft((d) => ({ ...d, stageEdits: { ...d.stageEdits, [key]: next } }));
    const pctText = stagePctDisplay(s, rowEdit, stageTotal);
    const rowLabel = guild ? "技師公會代墊" : `付款階段第 ${s.no} 列`;
    const shareSet = shareSetOf(shareView, s.id);
    const markedRemoved = !!s.id && stageRemovedIds.has(s.id);
    /** 已登記發票的期別（號碼或日期任一有值）：鎖住的發票格旁給「修正」鈕（要能重新載入才顯示）。 */
    const canReinvoice = editable && !guild && !!s.id && !!load && isBillingInvoiced(s);
    const openReinvoice = () =>
      s.id &&
      setReinvoiceTarget({ billingId: s.id, label: rowLabel, invoiceNo: s.invoiceNo, invoicedOn: s.invoicedOn, expectedVersion: billingScheduleVersion(billings), expectedAmount: s.amount });
    /** 不能移除的原因（已請款／開票／入帳；看得到分潤時，已有分潤或發獎金日）；null＝可以移除。 */
    const removeBlock = stageRemoveBlockReason(s, { hasShares: savedHasShares(shareSet) });
    const shareEdit: ShareEdit | undefined = sharesEditable ? draft.shareEdits?.[key] : undefined;
    const shareLines = currentShareLines(shareSet, shareEdit);
    /** 2026-11-19 本期獎金（migration 0119 未套用時沒有這格）。 */
    const quarterReady = shareView?.quarterReady === true;
    const bonusText = quarterReady ? currentBonusAmount(shareSet, shareEdit) : "";
    const sharePaid = !!shareSet?.paid;
    /** 已隨季獎金發放的期別：人員／金額／本期獎金／發獎金日鎖住，只能改算法說明。 */
    const shareLocked = sharesEditable && sharePaid;
    const shareSummary = shareCellSummary(shareLines, bonusText);
    // 代墊款（技師公會代墊）不可設分潤：不畫分潤格內容、不能點開。
    const shareOpen = showShares && !guild && openShareKey === key;
    /** 該期分潤的比較基準：存後金額（依後端尾差規則預估）；計畫沒算到時退回畫面金額。 */
    const shareLimit = key in plan.shares.limits ? plan.shares.limits[key] : stageScreenAmount(s, rowEdit);
    /** 分給成員的合計上限：本期獎金有填用它（2026-11-19），否則該期金額。 */
    const shareCap = shareCapOf(bonusText, shareLimit);
    const shareOver =
      showShares &&
      !guild &&
      ((shareCap.byBonus
        ? Math.round(shareLinesTotal(filledShareLines(shareLines)) * 100) > Math.round((shareCap.cap ?? 0) * 100)
        : sharesOverLimit(shareLinesTotal(filledShareLines(shareLines)), shareLimit)) ||
        (!shareEdit?.lines && shareEdit?.bonusAmount === undefined && !!shareSet?.overLimit));
    stageCells.push(
      <Cell key={`stage-${s.no}-0`} col={stageCols[0]} span={S[0]} row={r} kind="label" shade testId={`sheet-stage-${s.no}`}>
        {editable && markedRemoved ? (
          <span className="flex w-full min-w-0 items-center gap-1" data-testid={`sheet-stage-${s.no}-removed`}>
            <span className="min-w-0 truncate text-gray-400 line-through">{`${s.no}.${s.milestone}`}</span>
            <span className="shrink-0 text-[11px] text-red-600">存檔後移除</span>
            <button type="button" className="shrink-0 text-[11px] text-[var(--brand)] underline print:hidden" onClick={() => setDraft((d) => toggleStageRemoved(d, s.id as string))}>
              復原
            </button>
          </span>
        ) : editable ? (
          <span className="flex w-full min-w-0 items-center gap-0.5">
            <span className="shrink-0">{s.no}.</span>
            <input aria-label={`${rowLabel}項目說明`} className={cellInput} maxLength={200} placeholder="項目說明" title="名稱、金額、%、備註都清空並儲存＝移除這一期（已請款／開票／入帳的不能移除）" value={val("milestone")} onChange={(e) => setStage(key, "milestone", e.target.value)} />
            {guild ? null : s.id ? (
              <button
                type="button"
                className="shrink-0 px-0.5 text-[11px] text-red-500 disabled:cursor-not-allowed disabled:text-gray-300 print:hidden"
                aria-label={`移除${rowLabel}`}
                disabled={removeBlock !== null}
                title={removeBlock ?? "移除這一期（存檔後生效，存檔前可復原）"}
                data-testid={`sheet-stage-${s.no}-remove`}
                onClick={() => setDraft((d) => toggleStageRemoved(d, s.id as string))}
              >
                移除
              </button>
            ) : isExtraStageRow(stageRows, s, draft.stageExtraRows ?? 0) ? (
              <button
                type="button"
                className="shrink-0 px-0.5 text-[11px] text-red-500 print:hidden"
                aria-label={`移除${rowLabel}`}
                title="移除這一列新增的空白期別"
                data-testid={`sheet-stage-${s.no}-remove`}
                onClick={() => setDraft((d) => removeStageExtraRow(d, stageRows, s))}
              >
                移除
              </button>
            ) : null}
          </span>
        ) : (
          <span className="truncate" title={`${s.no}.${s.milestone}`}>{`${s.no}.${s.milestone}`}</span>
        )}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-1`} col={stageCols[1]} span={S[1]} row={r} kind="value" align="right" testId={`sheet-stage-${s.no}-amount`} editable={editable && !locks.amount} {...errAttr(`stage:${key}:amount`)}>
        {mLabel("金額")}
        {editable && !locks.amount ? (
          <span className="flex w-full min-w-0 flex-col gap-0.5">
          <span className="flex w-full min-w-0 items-center gap-0.5">
            <MoneyInput
              aria-label={`${rowLabel}金額`}
              title={
                locks.confirmAmount
                  ? "這一期已開發票：改金額存檔時要確認並填理由，改完請確認是否需要修正發票（作廢／重開）"
                  : "輸入金額，% 自動算出（金額 ÷ 銷售金額（未稅））"
              }
              className={`${cellInput} text-right tabular-nums`}
              placeholder={stageEstimate.estimated && stageEstimate.value !== null ? `${fmtMoney(stageEstimate.value)} 試算` : undefined}
              value={stageAmountDisplay(s, rowEdit)}
              onValueChange={(v) => patchStage(applyStageAmountEdit(rowEdit, v))}
            />
            {locks.confirmAmount ? (
              <span className="shrink-0 rounded bg-amber-50 px-1 text-[10px] text-amber-700 print:hidden" title="已開發票：改金額／% 存檔時要確認並填理由" data-testid={`sheet-stage-${s.no}-confirm-badge`}>
                需確認
              </span>
            ) : null}
          </span>
          {/* 人工指定金額要理由（2026-11-19 業主找不到在哪填）：就在這一列金額下方直接填，必填、紅框提示。 */}
          {needsReasonKeys.has(key) || rowEdit?.overrideReason !== undefined ? (
            <input
              aria-label={`${rowLabel}人工指定理由`}
              data-err-field={`stage:${key}:overrideReason`}
              data-testid={`sheet-stage-${s.no}-override-reason`}
              className={`${cellInput} text-xs ${isBad(`stage:${key}:overrideReason`) || (needsReasonKeys.has(key) && !(rowEdit?.overrideReason ?? "").trim()) ? INVALID_INPUT_CLS : ""}`}
              maxLength={1000}
              placeholder="指定理由（必填，例：議價、業主要求）"
              value={rowEdit?.overrideReason ?? ""}
              onChange={(e) => setStage(key, "overrideReason", e.target.value)}
            />
          ) : null}
          </span>
        ) : (
          <span
            className={`tabular-nums ${stageEstimate.estimated ? "text-gray-400" : ""}`}
            data-testid={`sheet-stage-${s.no}-amount-value`}
            title={
              stageEstimate.estimated
                ? "沒有合約，以銷售金額（未稅）× % 試算，僅供參考"
                : editable && locks.amount
                  ? "已請款／已入帳，金額凍結"
                  : undefined
            }
          >
            {/* 2026-11-19：數字放前面、「試算」縮小放後面，可換行，不再把數字擠掉只剩「試算」。 */}
            {stageEstimate.value !== null ? (
              <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1">
                <span className="whitespace-nowrap">{fmtMoney(stageEstimate.value)}</span>
                {stageEstimate.estimated ? <span className="whitespace-nowrap text-[10px]">試算</span> : null}
              </span>
            ) : (
              ""
            )}
          </span>
        )}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-2`} col={stageCols[2]} span={S[2]} row={r} kind="value" align="center" testId={`sheet-stage-${s.no}-pct`} editable={editable && !locks.percentage && !locks.amount} {...errAttr(`stage:${key}:percentage`)}>
        {mLabel("百分比")}
        {editable && !locks.percentage && !locks.amount ? (
          <span className="flex w-full min-w-0 items-center gap-0.5">
            <input
              aria-label={`${rowLabel}百分比`}
              title="也可以填 %，會反算金額（以金額為準存檔）"
              className={`${cellInput} text-right tabular-nums`}
              type="text"
              inputMode="decimal"
              value={pctText}
              onChange={(e) => patchStage(applyStagePctEdit(s, rowEdit, e.target.value.replace(/[^\d.]/g, ""), stageCalcTotal))}
            />
            <span className="shrink-0">%</span>
          </span>
        ) : pctText !== "" ? `${pctText}%` : ""}
      </Cell>,
      guild ? (
        <Cell className={blankCls("payment")} key={`stage-${s.no}-3`} col={stageCols[3]} span={S[3] + S[4]} row={r} kind="value" testId="sheet-guild-repayment" editable={editable} {...errAttr("guildRepaymentNote")}>
          <span className="mr-1 shrink-0 text-xs font-medium text-gray-600">審迄還款:</span>
          {editable ? (
            <input
              aria-label="審迄還款"
              className={cellInput}
              maxLength={GUILD_REPAYMENT_NOTE_MAX}
              placeholder="例：115.9.30 還款"
              value={draft.guildRepaymentNote}
              onChange={(e) => set("guildRepaymentNote", e.target.value)}
            />
          ) : (
            <span className="min-w-0 whitespace-normal break-words">{draft.guildRepaymentNote}</span>
          )}
        </Cell>
      ) : (
        <Cell className={blankCls("payment")} key={`stage-${s.no}-3`} col={stageCols[3]} span={S[3]} row={r} kind="value" editable={editable && !locks.invoiceNo} {...errAttr(`stage:${key}:invoiceNo`)}>
          {mLabel("發票號碼")}
          {editable && !locks.invoiceNo ? (
            <input aria-label={`${rowLabel}發票號碼`} title="儲存時登記開票（發票日期未填＝今天，可到下方卡片撤銷重開）" className={cellInput} maxLength={40} value={val("invoiceNo")} onChange={(e) => setStage(key, "invoiceNo", e.target.value)} />
          ) : (
            <span className="flex w-full min-w-0 items-center gap-1">
              <span className="min-w-0 truncate" title={editable ? "已開票；要改號碼或日期請按「修正」" : undefined}>{s.invoiceNo ?? ""}</span>
              {canReinvoice ? (
                <button type="button" className="shrink-0 rounded border border-gray-300 bg-white px-1 text-[11px] text-[var(--brand)] hover:bg-gray-50 print:hidden" aria-label={`修正${rowLabel}發票`} data-testid={`sheet-stage-${s.no}-reinvoice`} onClick={openReinvoice}>
                  修正
                </button>
              ) : null}
            </span>
          )}
        </Cell>
      ),
      ...(guild
        ? []
        : [
            <Cell className={blankCls("payment")} key={`stage-${s.no}-4`} col={stageCols[4]} span={S[4]} row={r} kind="value" editable={editable && !locks.invoicedOn} {...errAttr(`stage:${key}:invoicedOn`)}>
              {mLabel("發票日期")}
              {editable && !locks.invoicedOn ? (
                <input aria-label={`${rowLabel}發票日期`} title="未填＝登記開票當天" className={`${cellInput} px-0.5`} type="date" value={val("invoicedOn")} onChange={(e) => setStage(key, "invoicedOn", e.target.value)} />
              ) : (
                <span title={editable ? "已開票；要改號碼或日期請按發票號碼旁的「修正」" : undefined}>{s.invoicedOn ? rocDots(s.invoicedOn) : ""}</span>
              )}
            </Cell>,
          ]),
      <Cell className={blankCls("payment")} key={`stage-${s.no}-5`} col={stageCols[5]} span={S[5]} row={r} kind="value" editable={editable && !locks.receivedOn} {...errAttr(`stage:${key}:receivedOn`)}>
        {mLabel("入帳日期")}
        {editable && !locks.receivedOn ? (
          <input aria-label={`${rowLabel}入帳日期`} className={`${cellInput} px-0.5`} type="date" value={val("receivedOn")} onChange={(e) => setStage(key, "receivedOn", e.target.value)} />
        ) : (
          <span title={editable && locks.receivedOn ? "已入帳；撤銷請到下方「分期請款期程」" : undefined}>{s.receivedOn ? rocDots(s.receivedOn) : ""}</span>
        )}
      </Cell>,
      ...(showShares
        ? [
            <Cell
              key={`stage-${s.no}-share`}
              col={stageCols[6]}
              span={S[6]}
              row={r}
              kind="value"
              testId={`sheet-stage-${s.no}-shares`}
              editable={sharesEditable && !guild}
              className={shareOver ? "bg-red-50!" : undefined}
              {...errAttr(`stage:${key}:shares`)}
            >
              {mLabel("獎金分潤")}
              {guild ? null : sharesEditable || shareSummary ? (
                <button
                  type="button"
                  className={`${cellChoice} w-full truncate text-left tabular-nums`}
                  aria-expanded={shareOpen}
                  aria-label={`${rowLabel}獎金分潤${shareSummary ? `：${shareSummary}` : ""}`}
                  title={
                    sharePaid
                      ? "已隨季獎金發放（鎖定，只能改算法說明）"
                      : sharesEditable
                        ? "點開設定本期獎金與誰分多少（發獎金日落在哪一季，就自動列入該季的季獎金批次發放）"
                        : "點開看明細"
                  }
                  onClick={() => setOpenShareKey(shareOpen ? null : key)}
                >
                  {shareSummary || <span className="text-gray-400">＋ 設定</span>}
                  {sharePaid && (
                    <span className="block text-[11px] font-medium text-emerald-700" data-testid={`sheet-stage-${s.no}-share-paid`}>
                      已發放
                    </span>
                  )}
                  {shareOver && (
                    <span className="block text-[11px] font-medium text-red-700" data-testid={`sheet-stage-${s.no}-share-over`}>
                      分潤超過本期金額
                    </span>
                  )}
                </button>
              ) : null}
            </Cell>,
          ]
        : []),
      <Cell className={blankCls("payment")} key={`stage-${s.no}-6`} col={stageCols[NOTE]} span={S[NOTE]} row={r} kind="value" testId={`sheet-stage-${s.no}-note`} editable={editable} {...errAttr(`stage:${key}:note`)}>
        {mLabel("備註")}
        {editable ? (
          <input aria-label={`${rowLabel}備註`} className={cellInput} maxLength={1000} value={val("note")} onChange={(e) => setStage(key, "note", e.target.value)} />
        ) : (
          <span className="min-w-0 whitespace-normal break-words">{s.note}</span>
        )}
      </Cell>,
      ...(showShares
        ? [
            <Cell key={`stage-${s.no}-bonus-date`} col={stageCols[8]} span={S[8]} row={r} kind="value" testId={`sheet-stage-${s.no}-bonus-date`} editable={sharesEditable && !guild} {...errAttr(`stage:${key}:bonusPaidOn`)}>
              {mLabel("發獎金日")}
              {guild ? null : sharesEditable ? (
                <input
                  aria-label={`${rowLabel}發獎金日`}
                  className={`${cellInput} px-0.5`}
                  type="date"
                  value={currentBonusPaidOn(shareSet, shareEdit)}
                  disabled={shareLocked}
                  title={shareLocked ? "已隨季獎金發放，不能改發獎金日" : "發獎金日落在哪一季，就自動列入該季的季獎金批次"}
                  onChange={(e) => patchShare(key, { bonusPaidOn: e.target.value })}
                />
              ) : (
                <span>{shareSet?.bonusPaidOn ? rocDots(shareSet.bonusPaidOn) : ""}</span>
              )}
            </Cell>,
          ]
        : []),
    );
    if (shareOpen) {
      const stageAmount = shareLimit;
      const total = shareLinesTotal(filledShareLines(shareLines));
      const over = shareCap.byBonus ? Math.round(total * 100) > Math.round((shareCap.cap ?? 0) * 100) : sharesOverLimit(total, stageAmount);
      const setLines = (lines: ShareLine[]) => patchShare(key, { lines });
      /** 人員／金額可不可以改（已發放的期別鎖住）。 */
      const linesEditable = sharesEditable && !shareLocked;
      stageCells.push(
        <Cell key={`stage-${s.no}-share-editor`} col={1} span={stageHeaders.length} row={srow++} kind="full" testId={`sheet-stage-${s.no}-share-editor`} className="bg-gray-50!">
          <div className="w-full space-y-1.5 py-1 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-gray-700">
                {rowLabel}每期款獎金（發獎金日落在哪一季，就自動列入該季的季獎金批次發放；不寫入月結薪資）
              </span>
              <button type="button" className="text-xs text-gray-500 hover:text-gray-800" onClick={() => setOpenShareKey(null)}>
                收合
              </button>
            </div>
            {shareView?.quarterlyShares && (
              <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-200" data-testid="sheet-share-quarterly-warning">
                此專案也有季獎金分潤（比例制），季獎金批次會分開列兩種來源，請確認不要重複發放。
              </p>
            )}
            {sharePaid && (
              <p className="rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800 ring-1 ring-emerald-200" data-testid={`sheet-stage-${s.no}-share-locked`}>
                這一期已隨季獎金批次發放（{formatMoney(shareSet?.paidAmount ?? 0)}），人員、金額、本期獎金與發獎金日已鎖定；要改請先沖銷該季獎金批次。算法說明仍可補充。
              </p>
            )}
            {quarterReady && (
              <div
                className={`flex flex-wrap items-center gap-1.5 ${isBad(`stage:${key}:bonusAmount`) ? "rounded ring-1 ring-red-400" : ""}`}
                data-testid={`sheet-stage-${s.no}-bonus-amount-row`}
                data-err-field={`stage:${key}:bonusAmount`}
              >
                <span className="w-16 shrink-0 text-xs font-medium text-gray-600">本期獎金</span>
                {sharesEditable ? (
                  <MoneyInput
                    aria-label={`${rowLabel}本期獎金`}
                    className={`${cellInput} text-right tabular-nums sm:w-32 sm:flex-none`}
                    placeholder="可填 0"
                    disabled={shareLocked}
                    value={bonusText}
                    onValueChange={(v) => patchShare(key, { bonusAmount: v })}
                  />
                ) : (
                  <span className="w-32 text-right tabular-nums">{bonusText === "" ? "—" : formatMoney(Number(bonusText))}</span>
                )}
                <span className="shrink-0 text-xs font-medium text-gray-600">算法說明</span>
                {sharesEditable ? (
                  <input
                    aria-label={`${rowLabel}算法說明`}
                    className={`${cellInput} min-w-[10rem] flex-1`}
                    maxLength={FORMULA_NOTE_MAX}
                    placeholder="例：30萬＋20萬×10%"
                    value={currentFormulaNote(shareSet, shareEdit)}
                    onChange={(e) => patchShare(key, { formulaNote: e.target.value })}
                  />
                ) : (
                  <span className="min-w-0 flex-1 whitespace-normal break-words">{currentFormulaNote(shareSet, shareEdit) || "—"}</span>
                )}
              </div>
            )}
            {shareLines.length === 0 && !sharesEditable && <p className="text-xs text-gray-500">這一期沒有獎金分潤。</p>}
            {shareLines.map((line, i) => (
              <div key={i} className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap" data-testid={`sheet-share-line-${i}`}>
                {linesEditable ? (
                  <>
                    <EmployeeCombobox
                      options={shareOptions}
                      value={line.employeeId}
                      onChange={(id) => setLines(shareLines.map((l, j) => (j === i ? { ...l, employeeId: id } : l)))}
                      ariaLabel={`${rowLabel}獎金分潤第 ${i + 1} 位員工`}
                      className="min-w-[10rem] flex-1"
                    />
                    <MoneyInput
                      aria-label={`${rowLabel}獎金分潤第 ${i + 1} 位金額`}
                      className={`${cellInput} text-right tabular-nums sm:w-32 sm:flex-none`}
                      placeholder="金額"
                      value={line.amount}
                      onValueChange={(v) => setLines(shareLines.map((l, j) => (j === i ? { ...l, amount: v } : l)))}
                    />
                  </>
                ) : (
                  <>
                    <span className="flex-1">{shareNameOf(line.employeeId)}</span>
                    <span className="w-32 text-right tabular-nums">{formatMoney(Number(line.amount))}</span>
                  </>
                )}
                <span className="w-16 shrink-0 text-right text-xs text-gray-500 tabular-nums" data-testid={`sheet-share-line-${i}-pct`}>
                  {sharePctText(line.amount, stageAmount)}
                </span>
                {linesEditable && (
                  <button type="button" className="shrink-0 px-1 text-xs text-gray-400 hover:text-red-600" onClick={() => setLines(shareLines.filter((_, j) => j !== i))}>
                    移除
                  </button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {linesEditable ? (
                <button type="button" className="text-xs font-medium" style={{ color: "var(--brand)" }} onClick={() => setLines([...shareLines, { employeeId: "", amount: "" }])}>
                  ＋ 新增一人
                </button>
              ) : (
                <span />
              )}
              <span className={`text-xs tabular-nums ${over ? "font-medium text-red-700" : "text-gray-600"}`} data-testid={`sheet-stage-${s.no}-share-total`}>
                合計 {formatMoney(total)}
                {stageAmount !== null && stageAmount > 0 ? `（${sharePctText(total, stageAmount)}）` : ""}
                {shareCap.byBonus ? `／本期獎金 ${formatMoney(shareCap.cap ?? 0)}` : ""}／該期金額 {stageAmount !== null ? formatMoney(stageAmount) : "—"}
                {over ? (shareCap.byBonus ? "：超過本期獎金" : "：超過該期金額") : ""}
              </span>
            </div>
          </div>
        </Cell>,
      );
    }
  }
  if (showShares) {
    const template = APPLICATION_STAGE_BONUS_WEIGHTS.map((w) => `minmax(0, ${w}fr)`).join(" ");
    cells.push(
      <div
        key="stage-grid"
        data-testid="sheet-stage-grid"
        style={{ "--gc": "1 / span 16", "--gr": `${row} / span 1`, "--stage-cols": template } as CSSProperties}
        className="col-span-2 grid grid-cols-[6.5rem_minmax(0,1fr)] md:gap-px md:bg-gray-200 md:[grid-column:var(--gc)] md:[grid-row:var(--gr)] md:[grid-template-columns:var(--stage-cols)]"
      >
        {stageCells}
      </div>,
    );
    row++;
  } else {
    row = srow;
  }
  // 2026-11-19 專案獎金總覽（付款階段下方一列）：合約（未稅）｜獎金上限｜已發（＝每期分潤＋季獎金）及占合約 %｜可發餘額｜已設定未發。
  const overview = shareView?.quarterReady ? (shareView.overview ?? null) : null;
  if (overview) {
    const capText = draft.billingCapPct ?? (overview.capPct === null ? "" : String(overview.capPct));
    const ovCells = overviewCells(overview, capText);
    cells.push(
      <Cell key="bonus-overview" col={1} span={16} row={row++} kind="full" testId="sheet-bonus-overview" className="flex-col items-stretch gap-1 bg-sky-50! print:hidden" {...errAttr("billingCapPct")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="font-medium text-gray-700">專案獎金總覽</span>
          {ovCells.map((c) => (
            <span key={c.key} className="whitespace-nowrap" data-testid={`sheet-bonus-overview-${c.key}`} title={c.hint}>
              <span className="text-gray-500">{c.label}</span>{" "}
              <span className={`tabular-nums font-medium ${c.danger ? "text-red-700" : "text-gray-900"}`}>{c.value}</span>
              {c.hint && c.key !== "available" ? <span className="ml-1 text-[11px] text-gray-500">（{c.hint}）</span> : null}
            </span>
          ))}
          <span className="flex items-center gap-1 whitespace-nowrap">
            <span className="text-gray-500">上限比例</span>
            {sharesEditable ? (
              <input
                aria-label="專案獎金上限比例（%）"
                className={`${cellInput} w-16 text-right tabular-nums`}
                inputMode="decimal"
                placeholder="未設"
                value={capText}
                onChange={(e) => set("billingCapPct", e.target.value.replace(/[^\d.]/g, ""))}
              />
            ) : (
              <span className="tabular-nums">{overview.capPct === null ? "未設" : overview.capPct}</span>
            )}
            <span>%</span>
          </span>
        </div>
        {overview.dualSource && (
          <p className="text-[11px] text-amber-800" data-testid="sheet-bonus-overview-dual">
            此案同時有季獎金比例制與每期款獎金：季獎金批次與獎金分潤總表會分開列兩種來源，請確認不要重複發放。
          </p>
        )}
      </Cell>,
    );
  }
  if (editable) {
    cells.push(
      <Cell key="stage-add" col={1} span={16} row={row++} kind="full" testId="sheet-stage-add" className="justify-between gap-2 text-xs text-gray-500 print:hidden">
        <span>期數不限：新增的期別排在最後一期之後、技師公會代墊之前；存檔後自動編號。已請款／開票／入帳或已有分潤的期別不能移除。</span>
        <button type="button" className="shrink-0 text-sm text-[var(--brand)] hover:underline" onClick={() => set("stageExtraRows", (draft.stageExtraRows ?? 0) + 1)}>
          ＋ 新增一期
        </button>
      </Cell>,
    );
  }
  if (editable && stageTotal !== null && stageTotal > 0) {
    const sum = stageScheduleSummary(stageRowsKept, draft.stageEdits, stageRowKey, stageTotal);
    if (sum.amountTotal > 0 && sum.diff !== 0) {
      cells.push(
        <Cell key="stage-sum-hint" col={1} span={16} row={row++} kind="full" testId="sheet-stage-sum-hint" className="text-xs text-amber-800 print:hidden">
          各期金額合計 {fmtMoney(sum.amountTotal)}（{formatStagePct(sum.pctTotal)}%），與銷售金額（未稅）{fmtMoney(stageTotal)} 差 {fmtMoney(sum.diff)}；存檔後差額會加到最後一期。
        </Cell>,
      );
    }
  }
  // Word 第 19 列：付款階段與發包單位之間的空白列。
  cells.push(<Cell key="spacer" col={1} span={16} row={row++} kind="full" className="hidden h-6 md:flex print:flex print:h-5" />);

  // ---- 發包列表（2026-11-09 改版）：每家發包單位一列由上到下，表頭只印一次，小計列在列表下方 ----
  const summaryValues: ReactNode[] = [
    moneyText(money?.subcontractTotal),
    editable ? (
      <MoneyInput key="other" aria-label="其他支出" className={`${cellInput} text-right tabular-nums`} value={draft.otherExpenses} onValueChange={(v) => set("otherExpenses", v)} />
    ) : moneyText(money?.otherExpenses),
    showProfit ? moneyText(money?.profit) : <span title="屬集團財務，僅老闆與授權人員可見">—</span>,
    showProfit ? (canFinance && money?.grossMarginPct != null ? `${money.grossMarginPct}%` : "—") : <span title="屬集團財務，僅老闆與授權人員可見">—</span>,
  ];
  const SUB_FIELDS = ["vendorName", "contact", "item", "amount", "billingBasis"] as const;
  const subBase = (sub: Subcontract | null, field: (typeof SUB_FIELDS)[number]): string => {
    if (!sub) return "";
    if (field === "amount") return String(sub.amount ?? 0);
    return sub[field] ?? "";
  };
  /** 純數字（可含逗號）顯示成千分位；其他（打錯的字）原樣顯示，讓紅框看得到錯在哪。 */
  const amountDisplay = (v: string) => {
    const raw = v.replace(/,/g, "").trim();
    return /^\d+(\.\d+)?$/.test(raw) ? Number(raw).toLocaleString("en-US") : v;
  };
  const subTd = "border border-gray-200 px-2 py-1 align-middle print:px-1 print:py-0.5";
  const subTh = "border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 print:px-1 print:py-0.5 print:text-[11px]";
  const subRowNodes = subRows.map((slot, idx) => {
    const n = idx + 1;
    // S2 擴大：已綁定名冊廠商的列，非老闆／平台管理員不能改單位名稱（＝改綁／解綁）也不能移除。
    // 權限還在載入（null）→ 中性：先唯讀但不畫鎖頭；確定不能（false）才畫鎖頭與說明。
    const boundLocked = !!slot.sub?.vendorId && canManageBound !== true;
    const boundLockedKnown = boundLocked && canManageBound === false;
    const removed = !!slot.sub?.id && subRemoved.has(slot.sub.id);
    const paid = subcontractHasPaid(slot.sub);
    const rowLabel = `發包第 ${n} 列`;
    const cellOf = (field: (typeof SUB_FIELDS)[number], extra = "") => {
      const isAmount = field === "amount";
      const header = APPLICATION_SUBCONTRACT_HEADERS[1 + SUB_FIELDS.indexOf(field)];
      const errField = `sub:${slot.key}:${field}`;
      const bad = isBad(errField);
      const value = draft.subEdits[slot.key]?.[field] ?? subBase(slot.sub, field);
      return (
        <td
          key={field}
          className={`${subTd} ${isAmount ? "text-right tabular-nums" : "text-left"} ${bad ? INVALID_CELL_CLS : ""} ${blankCls("subcontract")} ${extra}`}
          data-err-field={errField}
          data-invalid={bad ? "true" : undefined}
          data-testid={`sheet-sub-${n}-${field}`}
        >
          {editable && !removed && !(field === "vendorName" && boundLocked) ? (
            <input
              aria-label={`${rowLabel}${header}`}
              className={`${cellInput} ${isAmount ? "text-right tabular-nums" : ""}`}
              list={field === "vendorName" ? "sheet-vendor-suggestions" : undefined}
              type="text"
              inputMode={isAmount ? "numeric" : undefined}
              title={field === "vendorName" && value ? value : undefined}
              value={isAmount && editingSubAmount !== slot.key ? amountDisplay(value) : value}
              onFocus={isAmount ? () => setEditingSubAmount(slot.key) : undefined}
              onBlur={isAmount ? () => setEditingSubAmount(null) : undefined}
              onChange={(e) => setSub(slot.key, field, isAmount ? e.target.value.replace(/,/g, "") : e.target.value)}
            />
          ) : isAmount ? (
            slot.sub ? fmtMoney(slot.sub.amount) : ""
          ) : (
            <span className="whitespace-normal break-words" title={field === "vendorName" && boundLockedKnown ? BOUND_SUBCONTRACT_LOCKED_NOTE : undefined}>
              {slot.sub?.[field] ?? ""}
              {field === "vendorName" && boundLockedKnown && editable && <span className="ml-1 text-[11px] text-gray-400 print:hidden">🔒</span>}
            </span>
          )}
        </td>
      );
    };
    return (
      <tr key={slot.key} data-testid={`sheet-sub-row-${n}`} data-removed={removed ? "true" : undefined} className={removed ? "bg-red-50/40 text-gray-400 line-through" : ""}>
        <td className={`${subTd} bg-gray-50 text-center text-xs text-gray-600 tabular-nums`}>{n}</td>
        {SUB_FIELDS.map((f) => cellOf(f))}
        {editable && (
          <td className={`${subTd} no-print text-center print:hidden`} data-err-field={`sub:${slot.key}:remove`}>
            {removed ? (
              <button type="button" className="text-xs text-[var(--brand)] no-underline hover:underline" aria-label={`復原${rowLabel}`} onClick={() => set("subRemovedIds", draft.subRemovedIds.filter((id) => id !== slot.sub?.id))}>
                復原
              </button>
            ) : slot.sub && paid ? (
              <span className="cursor-not-allowed text-xs text-gray-300" title="已有付款紀錄的發包不能移除；要移除請先到下方「副委託」撤銷付款">移除</span>
            ) : boundLocked ? (
              <span className="cursor-not-allowed text-xs text-gray-300" title={boundLockedKnown ? BOUND_SUBCONTRACT_LOCKED_NOTE : undefined}>移除</span>
            ) : (
              <button
                type="button"
                className="text-xs text-gray-400 hover:text-red-600"
                aria-label={`移除${rowLabel}`}
                title={slot.sub ? "儲存時移除這筆副委託（要填理由）" : "移除這一列"}
                onClick={() => {
                  if (slot.sub?.id) set("subRemovedIds", [...draft.subRemovedIds, slot.sub.id]);
                  else setDraft((d) => removeNewSubcontractRow(d, idx));
                }}
              >
                移除
              </button>
            )}
          </td>
        )}
      </tr>
    );
  });
  cells.push(
    <div
      key="subcontracts"
      style={{ "--gc": "1 / span 16", "--gr": `${row++} / span 1` } as CSSProperties}
      className="col-span-2 min-w-0 bg-white md:[grid-column:var(--gc)] md:[grid-row:var(--gr)] print:[grid-column:var(--gc)] print:[grid-row:var(--gr)]"
      data-testid="sheet-subcontracts"
    >
      <div className="overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[680px] table-fixed border-collapse text-[13px] leading-[1.4] print:min-w-0 print:text-[11px]">
          <thead>
            <tr>
              <th className={`${subTh} w-9 text-center`}>#</th>
              <th className={`${subTh} w-[25%] text-left`}>{APPLICATION_SUBCONTRACT_HEADERS[1]}</th>
              <th className={`${subTh} w-[18%] text-left`}>{APPLICATION_SUBCONTRACT_HEADERS[2]}</th>
              <th className={`${subTh} w-[17%] text-left`}>{APPLICATION_SUBCONTRACT_HEADERS[3]}</th>
              <th className={`${subTh} w-[13%] text-right`}>{APPLICATION_SUBCONTRACT_HEADERS[4]}</th>
              <th className={`${subTh} text-left`}>{APPLICATION_SUBCONTRACT_HEADERS[5]}</th>
              {editable && <th className={`${subTh} no-print w-14 text-center print:hidden`}>移除</th>}
            </tr>
          </thead>
          <tbody>{subRowNodes}</tbody>
        </table>
      </div>
      {editable && (
        <div className="no-print border-t border-gray-200 px-2 py-1 print:hidden">
          <button type="button" className="text-sm text-[var(--brand)] hover:underline" onClick={() => set("subExtraRows", draft.subExtraRows + 1)}>
            ＋ 新增一列發包
          </button>
        </div>
      )}
      {/* 發包小計／其他支出／利潤／毛利率：列表下方一列，標題｜值 四組 */}
      <div className="grid grid-cols-2 gap-px border-t border-gray-200 bg-gray-200 sm:grid-cols-[repeat(4,minmax(0,0.8fr)_minmax(0,1.2fr))] print:grid-cols-[repeat(4,minmax(0,0.8fr)_minmax(0,1.2fr))] print:[print-color-adjust:exact]" data-testid="sheet-sub-summary">
        {APPLICATION_SUMMARY_LABELS.map((label, i) => [
          <div key={`${label}-l`} className="flex items-center justify-end bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 print:px-1 print:py-0.5 print:text-[11px]">{label}</div>,
          <div
            key={`${label}-v`}
            className={`flex items-center justify-end bg-white px-2 py-1 text-[13px] tabular-nums text-gray-900 print:px-1 print:py-0.5 print:text-[11px] ${i === 1 && isBad("otherExpenses") ? INVALID_CELL_CLS : ""} ${blankCls("subcontract")}`}
            data-testid={i === 1 ? "sheet-other-expenses" : `sheet-summary-${i}`}
            data-editable={editable && i === 1 ? "true" : undefined}
            data-err-field={i === 1 ? "otherExpenses" : undefined}
          >
            {summaryValues[i]}
          </div>,
        ])}
      </div>
    </div>,
  );

  const failedSteps = report?.steps.filter((st) => st.status === "failed" || st.status === "skipped") ?? [];
  const warningSteps = report?.steps.filter((st) => st.status === "warning") ?? [];
  const okSteps = report?.steps.filter((st) => st.status === "ok") ?? [];

  return (
    <section aria-label="專案申請單" className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-5 print:rounded-none print:border-0 print:p-0 print:shadow-none" data-testid="application-sheet">
      {/* 存檔中整張鎖住：存完會用「剩下的草稿」取代，存檔期間打的字會被蓋掉。 */}
      {banner && <div className="no-print mx-auto mb-3 w-full max-w-[960px] print:hidden">{banner}</div>}
      <fieldset disabled={saving} className="m-0 min-w-0 border-0 p-0">
      <div className="mx-auto w-full max-w-[960px] text-gray-900 print:max-w-none">
        {/* 抬頭（後台卡片標題樣式）：標誌＋「專案申請單 民國　年　月　日」、承接公司、工程名稱／專案序號 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <img src="/brand/aster-logo.svg" alt="" aria-hidden="true" className="h-6 w-auto" />
          <h2 className={sheet.title}>專案申請單</h2>
          {versionLabel && (
            <span className="rounded border border-gray-300 px-1.5 py-0.5 text-xs font-medium text-gray-700 print:border-gray-400" data-testid="application-version-label">
              {versionLabel}
            </span>
          )}
          {versionControls && (
            <span className="no-print flex flex-wrap items-center gap-2 print:hidden">
              {typeof versionControls === "function" ? versionControls({ dirty: editable && dirtyCount > 0 }) : versionControls}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1 text-sm text-gray-600">
            民國<span className="min-w-[2.5em] border-b border-gray-300 text-center text-gray-900 tabular-nums">{opened?.year ?? ""}</span>年
            <span className="min-w-[1.5em] border-b border-gray-300 text-center text-gray-900 tabular-nums">{opened?.month ?? ""}</span>月
            <span className="min-w-[1.5em] border-b border-gray-300 text-center text-gray-900 tabular-nums">{opened?.day ?? ""}</span>日
            {editable && (
              <input aria-label="開案日期" type="date" className={`${cellInput} ml-1 !w-auto text-xs`} value={draft.openedOn} onChange={(e) => set("openedOn", e.target.value)} />
            )}
          </span>
        </div>
        <div className="mt-1 text-sm text-gray-500" data-testid="application-company-name">
          {editable && companyChoices.length > 0 ? (
            <select aria-label="承接公司" className="max-w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm text-gray-700 hover:border-gray-300 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--brand)]" value={selectedCompanyId(draft.companyId, companies)} onChange={(e) => set("companyId", e.target.value)}>
              {companyChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          ) : (
            companyLabel
          )}
        </div>
        <div className="mb-2 mt-1 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-sm">
          <label className="flex min-w-0 flex-1 items-center gap-1">
            <span className="shrink-0 text-gray-600">工程名稱：</span>
            {editable ? (
              <input aria-label="工程名稱" data-err-field="name" className={`${cellInput} text-sm ${isBad("name") ? INVALID_INPUT_CLS : ""}`} value={draft.name} onChange={(e) => set("name", e.target.value)} />
            ) : (
              <span className="font-medium text-gray-900">{draft.name}</span>
            )}
          </label>
          {/* 2026-11-12 序號可手動調整：鉛筆鈕只給能編輯本案基本資料的人（editable＝access.finance 且非列印／舊版檢視）；外層 fieldset 存檔中會一併鎖住 */}
          <ProjectCodeField projectId={project.id} code={project.code ?? null} canEdit={editable && !!load} onSaved={load ? () => load() : undefined} />
          {/* 2026-11-18 合約編號：序號之外可自由輸入的另一套編號（選填），跟著申請單一起存（PATCH projectNo，版本快照一併保存）。 */}
          <label className="flex min-w-0 items-center gap-1" data-testid="sheet-project-no">
            <span className="shrink-0 text-gray-600">合約編號：</span>
            {editable ? (
              <input aria-label="合約編號" data-err-field="projectNo" className={`${cellInput} w-48 text-sm ${isBad("projectNo") ? INVALID_INPUT_CLS : ""}`} maxLength={PROJECT_NO_MAX} placeholder="選填" value={draft.projectNo ?? ""} onChange={(e) => set("projectNo", e.target.value)} />
            ) : (
              <span className="font-medium text-gray-900">{draft.projectNo || "—"}</span>
            )}
          </label>
        </div>

        {/* 專案明細表：外框 gray-300、內框 1px gray-200（gap-px 露出底色當格線）。
            桌機格線最窄 920px（付款階段的日期輸入框才放得下）；介於 md 與 920px 之間改水平捲動，格子不互相覆蓋。列印照紙寬縮放。 */}
        <div className="md:overflow-x-auto print:overflow-visible">
          <div
            className="grid grid-cols-[6.5rem_minmax(0,1fr)] overflow-hidden rounded-lg border border-gray-300 md:min-w-[920px] md:gap-px md:bg-gray-200 md:[grid-template-columns:var(--cols)] print:min-w-0 print:gap-px print:bg-gray-200 print:[print-color-adjust:exact] print:[grid-template-columns:var(--cols)] print:break-inside-avoid"
            style={{ "--cols": GRID_TEMPLATE } as CSSProperties}
          >
            {cells}
          </div>
        </div>
      </div>
      </fieldset>

      {!print && !readOnly && (
      <div className="no-print mx-auto mt-3 flex w-full max-w-[960px] flex-col gap-2">
        {editable ? (
          <div className="flex flex-wrap items-center gap-3">
            <span title={blockedTitle}>
              <PrimaryButton onClick={save} disabled={saving || dirtyCount === 0 || validation.length > 0}>
                {saving ? "儲存中…" : "儲存申請單"}
              </PrimaryButton>
            </span>
            {dirtyCount > 0 ? (
              <>
                <span className="text-sm text-amber-700">{dirtyCount} 個欄位尚未儲存</span>
                {blockedHint && <button type="button" className="text-left text-sm text-red-600 underline decoration-dotted" data-testid="sheet-blocked-hint" onClick={focusFirstError}>{blockedHint}</button>}
                <Button type="button" variant="ghost" size="sm" onClick={() => { setDraft(applicationSheetDraftOf(project, disciplines)); setReport(null); }}>還原</Button>
              </>
            ) : (
              <span className="text-sm text-gray-400">沒有未儲存的變更</span>
            )}
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
        {editable && draft.subRemovedIds.length > 0 && (
          <label className="flex flex-wrap items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-testid="sheet-sub-delete-reason">
            <span className="shrink-0 text-amber-900">移除 {draft.subRemovedIds.length} 筆發包，請填理由（已有付款紀錄的不能移除）：</span>
            <input
              aria-label="移除發包理由"
              data-err-field="subDeleteReason"
              className={`${cellInput} max-w-md ${isBad("subDeleteReason") ? INVALID_INPUT_CLS : ""}`}
              maxLength={1000}
              value={draft.subDeleteReason}
              onChange={(e) => set("subDeleteReason", e.target.value)}
            />
          </label>
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
            {warningSteps.length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900" data-testid="sheet-save-warnings">
                <ul className="list-disc pl-5">
                  {warningSteps.map((st, i) => (
                    <li key={`${st.section}-w-${i}`}>{st.label}：{st.message}</li>
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
          <span className="mr-1 inline-block h-3 w-5 rounded-sm border border-gray-300 bg-white align-middle" aria-hidden="true" />
          有輸入框的格子可以直接點進去改，改完按「儲存申請單」一次存；沒有框的是系統算的（營業稅、銷售總額、發包小計、利潤、毛利率）。
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
            <span className="mr-auto">申請單有 {dirtyCount} 個欄位尚未儲存。{blockedHint && <button type="button" className="ml-2 text-left text-red-600 underline decoration-dotted" onClick={focusFirstError}>{blockedHint}</button>}</span>
            <Button type="button" variant="secondary" size="sm" onClick={() => document.querySelector('[data-testid="application-sheet"]')?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              回到申請單
            </Button>
            <Button type="button" variant="primary" size="sm" onClick={save} disabled={saving || validation.length > 0} title={blockedTitle}>{saving ? "儲存中…" : "儲存申請單"}</Button>
          </div>
        </div>
      )}
      {invoicedAck.dialog}
      <ReinvoiceDialog target={reinvoiceTarget} onClose={() => setReinvoiceTarget(null)} onDone={async () => { if (load) await load(); }} />
    </section>
  );
}
