/**
 * 專案明細頁上半部「專案申請單」表格版面的純資料層（2026-10-27 業主：明細頁要跟公司 Word
 * 申請單一模一樣）。版面定義（哪一列、哪一格、跨幾欄、哪些是藍底標題格）、草稿 ↔ 專案欄位
 * 的對應、只送變更欄位的 diff、付款階段／發包單位的列展開都在這裡，畫面元件
 * （app/admin/projects/[id]/_sections/ApplicationSheet.tsx）只負責把格子畫出來。
 *
 * ⚠️ vitest 沒設 `@/` 別名：這支只能用相對路徑、且只 import 型別或不依賴 `@/` 的模組。
 */
import { isOurContract, type Contract } from "./projects-api";
import type {
  BillingExt,
  DesignScopeItem,
  InvoiceType,
  PaymentMethod,
  ProjectDetail,
  ProjectEngineers,
  ProjectMoney,
  Subcontract,
  UpdateProjectExtBody,
} from "./projects-ext-api";

/* ============================================================ 版面 == */

/**
 * Word 表格的欄寬（twips，gridCol 去掉最左側 43 的縮排欄）。畫面用 CSS grid 依比例重現，
 * 每一格的跨欄數（gridSpan）都對得回這 16 欄。
 */
export const APPLICATION_SHEET_COLUMNS: readonly number[] = [
  1402, 710, 893, 241, 1275, 185, 666, 251, 720, 446, 284, 1035, 425, 524, 1733, 43,
];
export const APPLICATION_SHEET_COLUMN_COUNT = APPLICATION_SHEET_COLUMNS.length;

/** 可編輯／帶值的格子；畫面元件依 key 決定畫輸入框或唯讀文字。 */
export type SheetField =
  | "siteAddress"
  | "siteAreaM2"
  | "designScope"
  | "clientName"
  | "clientPhone"
  | "invoiceAddress"
  | "orderDocument"
  | "clientContact"
  | "clientFax"
  | "clientTaxId"
  | "invoiceType"
  | "remarks"
  | "amountUntaxed"
  | "taxAmount"
  | "amountTotal"
  | "closingDay"
  | "paymentDay"
  | "paymentMethod";

export interface SheetCell {
  /** 跨幾欄（Word gridSpan）。 */
  span: number;
  /** 固定標題文字（照 Word 原字，含全形冒號與空白）。 */
  label?: string;
  field?: SheetField;
  /** Word 的淺藍底（shd DAEEF3）。 */
  shade?: boolean;
  /** 往下合併幾列（Word vMerge）；省略＝1。 */
  rowSpan?: number;
  /** 被上方合併格佔住的位置：不畫，只用來讓每列的欄數加總維持 16。 */
  covered?: boolean;
  /** 整列標題（「專 案 明 細」）。 */
  title?: boolean;
}

/** Word 表格上半部（專案明細～付款方式），一列一個陣列，順序與跨欄照原檔。 */
export const APPLICATION_SHEET_TOP_ROWS: readonly (readonly SheetCell[])[] = [
  [{ span: 16, label: "專 案 明 細", shade: true, title: true }],
  [{ span: 2, label: "設計地點：" }, { span: 14, field: "siteAddress" }],
  [{ span: 2, label: "設計面積：" }, { span: 14, field: "siteAreaM2" }],
  [{ span: 2, label: "設計內容：" }, { span: 14, field: "designScope" }],
  [
    { span: 2, label: "客戶名稱:", shade: true },
    { span: 6, field: "clientName" },
    { span: 1, label: "電話:", shade: true },
    { span: 5, field: "clientPhone" },
    { span: 2, label: "備  註:", shade: true },
  ],
  [
    { span: 2, label: "發票地址:", shade: true },
    { span: 6, field: "invoiceAddress" },
    { span: 1, label: "訂單:", shade: true },
    { span: 5, field: "orderDocument" },
    { span: 2, field: "remarks", rowSpan: 3 },
  ],
  [
    { span: 2, label: "採購承辦:", shade: true },
    { span: 6, field: "clientContact" },
    { span: 1, label: "傳真:", shade: true },
    { span: 5, field: "clientFax" },
    { span: 2, covered: true },
  ],
  [
    { span: 2, label: "統一編號:", shade: true },
    { span: 6, field: "clientTaxId" },
    { span: 1, label: "發票:", shade: true },
    { span: 5, field: "invoiceType" },
    { span: 2, covered: true },
  ],
  [
    { span: 2, label: "銷售金額:", shade: true },
    { span: 1, label: "未稅:", shade: true },
    { span: 3, field: "amountUntaxed" },
    { span: 2, label: "營業稅:", shade: true },
    { span: 3, field: "taxAmount" },
    { span: 2, label: "銷售總額:", shade: true },
    { span: 3, field: "amountTotal" },
  ],
  [
    { span: 2, label: "付款方式：", shade: true },
    { span: 1, label: "結帳日", shade: true },
    { span: 3, field: "closingDay" },
    { span: 2, label: "付款", shade: true },
    { span: 3, field: "paymentDay" },
    { span: 2, label: "付款方式：", shade: true },
    { span: 3, field: "paymentMethod" },
  ],
];

/** 付款階段每一列的跨欄：期別名稱｜%｜金額｜已於…入賬｜發票號碼:｜號碼與日期。 */
export const APPLICATION_STAGE_SPANS = [2, 1, 2, 5, 2, 4] as const;

/** 發包單位區塊每一列的跨欄：標題｜單位一｜單位二｜單位三｜右側小計標題｜右側小計值。 */
export const APPLICATION_SUBCONTRACT_SPANS = [1, 3, 3, 4, 3, 2] as const;
export const APPLICATION_SUBCONTRACT_LABELS = ["發包單位：", "聯絡資料：", "項    目：", "發包金額：", "請款依據："] as const;
export const APPLICATION_SUMMARY_LABELS = ["發包小計：", "其他支出：", "利潤：", "毛利率：", ""] as const;
/** Word 一張申請單只有三個發包欄；超過三筆就往下再開一個同樣的區塊。 */
export const SUBCONTRACTS_PER_BLOCK = 3;
/** Word 付款階段固定 7 期＋第 8 列技師公會代墊；期數不足 7 期時補空白列維持版面。 */
export const MIN_INSTALLMENT_ROWS = 7;

/* ======================================================== 分區列印 == */

/**
 * 列印申請單的分區勾選（B6）。新版面是一張固定格線的表，不能整塊抽掉（會在格線裡留下黑洞），
 * 所以取消勾選＝那一區的「內容格」列印時留白、標題與框線照印（像一張空白申請單）；螢幕上淡化。
 * 「合約與印花稅」是表格下方另外一張表，取消勾選就整張不印（與舊版相同）。
 */
export type PrintBlockKey = "customer" | "sales" | "payment" | "engineers" | "subcontract" | "contracts";

export const PRINT_BLOCKS: { key: PrintBlockKey; label: string }[] = [
  { key: "customer", label: "客戶資料" },
  { key: "sales", label: "銷售金額" },
  { key: "payment", label: "付款階段" },
  { key: "engineers", label: "協力技師" },
  { key: "subcontract", label: "發包單位" },
  { key: "contracts", label: "合約與印花稅" },
];

/** 上半部每個內容格屬於哪一個列印區塊；付款階段各列屬 payment、發包單位區塊屬 subcontract。 */
export const SHEET_FIELD_PRINT_BLOCK: Record<SheetField, PrintBlockKey> = {
  siteAddress: "customer",
  siteAreaM2: "customer",
  designScope: "customer",
  clientName: "customer",
  clientPhone: "customer",
  invoiceAddress: "customer",
  orderDocument: "customer",
  clientContact: "customer",
  clientFax: "customer",
  clientTaxId: "customer",
  invoiceType: "customer",
  remarks: "engineers",
  amountUntaxed: "sales",
  taxAmount: "sales",
  amountTotal: "sales",
  closingDay: "payment",
  paymentDay: "payment",
  paymentMethod: "payment",
};

/* ============================================================ 草稿 == */

export interface EngineerDraft {
  vendorId: string | null;
  name: string | null;
}

/** 申請單表格裡可直接編輯的欄位（全部以字串保存，輸入中途不轉型）。 */
export interface ApplicationSheetDraft {
  /** 工程名稱（＝專案名稱）。必填。 */
  name: string;
  /** 抬頭「民國　年　月　日」＝開案日期，'YYYY-MM-DD' 或 ""。 */
  openedOn: string;
  /** 抬頭左上角的承接公司。"" ＝沿用租戶預設公司（專案上 company_id 為 null）。 */
  companyId: string;
  /** 客戶名稱。"" ＝未指定。 */
  clientId: string;
  siteAddress: string;
  siteAreaM2: string;
  designScope: DesignScopeItem[];
  invoiceType: InvoiceType | "";
  paymentMethod: PaymentMethod | "";
  closingDay: string;
  paymentDay: string;
  /** 其他支出（只有 finance 看得到、改得了）。 */
  otherExpenses: string;
  /** 備註欄的協力技師（依租戶設定的科別）。 */
  engineers: Record<string, EngineerDraft>;
  /** 付款階段「技師公會代墊」列的「審迄還款」（自由文字，≤200 字；2026-10-28）。 */
  guildRepaymentNote: string;
  /*
   * ↓ 以下是「整張表直接編輯」（2026-10-29 業主：為什麼表格不能直接編輯？）新增的部分。
   * 這些格子的資料不在專案上（客戶名冊、合約、請款期程、副委託），所以草稿只存「使用者改過的格子」
   * （疊加層），是否真的有變由 project-application-sheet-save.ts 跟最新資料比對；
   * 重新載入時疊加層原樣保留（rebaseApplicationSheetDraft 的通用規則：跟舊基準＝空物件不同就保留）。
   */
  /** 客戶名冊欄位（電話、發票地址、採購承辦、傳真、統編），只套用在草稿目前選的客戶上；換客戶時清空。 */
  clientEdits: Partial<Record<ClientSheetField, string>>;
  /** 訂單格新勾選的文件類型（本案還沒有該類文件時，儲存時建立）；"" ＝沒勾新的。 */
  orderDocType: "" | "contract" | "quotation";
  /** 銷售金額「未稅」格的輸入；null ＝沒動過（顯示系統現值）。 */
  amountUntaxed: string | null;
  /** 付款階段各列改過的格子；key 見 stageRowKey()。 */
  stageEdits: Record<string, StageEdit>;
  /** 發包單位各欄改過的格子；key 見 applicationSubcontractSlots()。 */
  subEdits: Record<string, SubEdit>;
  /** 使用者按「多開一組發包欄」多開的區塊數（每塊 3 欄）。 */
  subExtraBlocks: number;
}

/** 申請單上屬於客戶名冊的格子（「採購承辦」＝聯絡人姓名＋電話兩個欄位）。 */
export type ClientSheetField = "phone" | "invoiceAddress" | "contactName" | "contactPhone" | "fax" | "taxId";
export const CLIENT_SHEET_FIELDS: readonly ClientSheetField[] = ["phone", "invoiceAddress", "contactName", "contactPhone", "fax", "taxId"];
export const CLIENT_SHEET_FIELD_LABELS: Record<ClientSheetField, string> = {
  phone: "電話",
  invoiceAddress: "發票地址",
  contactName: "採購承辦姓名",
  contactPhone: "採購承辦電話",
  fax: "傳真",
  taxId: "統一編號",
};

/** 付款階段一列可直接改的格子（全部字串，輸入中途不轉型）。 */
export interface StageEdit {
  milestone?: string;
  percentage?: string;
  amount?: string;
  /** 改了金額（＝人工指定）時的理由；後端要求必填，沿用既有理由時可不填。 */
  overrideReason?: string;
  receivedOn?: string;
  invoiceNo?: string;
}

/** 發包單位一欄可直接改的格子。 */
export interface SubEdit {
  vendorName?: string;
  contact?: string;
  item?: string;
  amount?: string;
  billingBasis?: string;
}

/** 審迄還款的長度上限（與 API zod、DB CHECK projects_guild_repayment_note_len_chk 相同）。 */
export const GUILD_REPAYMENT_NOTE_MAX = 200;

/**
 * 技師欄位＝租戶設定的科別；專案上已經有值、但設定裡沒有的科別（改過設定、或 backfill 前的舊 key）
 * 接在後面保留，免得一開畫面就把既有資料弄丟。
 */
export function engineerDraftOf(
  engineers: ProjectEngineers | null | undefined,
  disciplines: readonly string[],
): Record<string, EngineerDraft> {
  const keys = [...disciplines];
  for (const key of Object.keys(engineers ?? {})) if (!keys.includes(key)) keys.push(key);
  const out: Record<string, EngineerDraft> = {};
  for (const key of keys) {
    const assignment = engineers?.[key];
    out[key] = { vendorId: assignment?.vendorId ?? null, name: assignment?.name ?? null };
  }
  return out;
}

export function applicationSheetDraftOf(project: ProjectDetail, disciplines: readonly string[]): ApplicationSheetDraft {
  return {
    name: project.name ?? "",
    openedOn: project.openedOn ?? "",
    companyId: project.companyId ?? "",
    clientId: project.clientId ?? "",
    siteAddress: project.siteAddress ?? "",
    siteAreaM2: project.siteAreaM2 != null ? String(project.siteAreaM2) : "",
    designScope: (project.designScope ?? []).map((row) => ({ ...row })),
    invoiceType: project.invoiceType ?? "",
    paymentMethod: project.paymentMethod ?? "",
    closingDay: project.closingDay ?? "",
    paymentDay: project.paymentDay ?? "",
    otherExpenses: project.otherExpenses != null ? String(project.otherExpenses) : "",
    engineers: engineerDraftOf(project.engineers, disciplines),
    guildRepaymentNote: project.guildRepaymentNote ?? "",
    clientEdits: {},
    orderDocType: "",
    amountUntaxed: null,
    stageEdits: {},
    subEdits: {},
    subExtraBlocks: 0,
  };
}

/* ============================================================ 驗證 == */

function parseOptionalNumber(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

/** 存檔前的檢查，回人看得懂的訊息；空陣列＝可以存。 */
export function applicationSheetErrors(draft: ApplicationSheetDraft, opts: { canFinance: boolean }): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("工程名稱不可空白。");
  if (parseOptionalNumber(draft.siteAreaM2) === "invalid") errors.push("設計面積必須是 0 以上的數字。");
  if (opts.canFinance && parseOptionalNumber(draft.otherExpenses) === "invalid") errors.push("其他支出必須是 0 以上的數字。");
  if (draft.designScope.some((row) => !row.discipline.trim() && ((row.item ?? "").trim() || row.amount != null))) {
    errors.push("設計內容每一列都要填科別（只填項目或金額的列存不進去）。");
  }
  if (draft.guildRepaymentNote.trim().length > GUILD_REPAYMENT_NOTE_MAX) {
    errors.push(`審迄還款最多 ${GUILD_REPAYMENT_NOTE_MAX} 字。`);
  }
  if (draft.designScope.some((row) => row.amount != null && (!Number.isFinite(row.amount) || row.amount < 0))) {
    errors.push("設計內容的金額必須是 0 以上的數字。");
  }
  return errors;
}

/* ============================================================ diff == */

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeScope(rows: readonly DesignScopeItem[]): DesignScopeItem[] {
  return rows
    .filter((row) => row.discipline.trim())
    .map((row) => ({ discipline: row.discipline.trim(), item: textOrNull(row.item), amount: row.amount ?? null }));
}

function normalizeEngineer(value: { vendorId?: string | null; name?: string | null } | null | undefined): EngineerDraft | null {
  if (!value) return null;
  const vendorId = value.vendorId ?? null;
  const name = textOrNull(value.name);
  return vendorId || name ? { vendorId, name } : null;
}

/**
 * 草稿跟專案現值比，**只回有變的欄位**（PATCH /projects/:id）。沒改的欄位一律不送——
 * 不會因為存申請單就把別人剛改的值蓋回去，也不會碰到沒權限的欄位。
 *
 * - 看不到錢（canFinance=false）的人整份唯讀，回空物件（後端 PATCH 需要 canManage）。
 * - 其他支出、設計內容金額屬 finance；設計內容整份有變才整份送。
 * - 協力技師：只送設定裡的科別（後端對不認得的 key 回 unknown_discipline）；設定裡某科有變、或使用者
 *   清除了已不在設定裡的舊科別時才整份送，這時舊科別會一併清掉。
 */
export function applicationSheetPatch(
  project: ProjectDetail,
  draft: ApplicationSheetDraft,
  opts: { disciplines: readonly string[]; canFinance: boolean },
): UpdateProjectExtBody {
  if (!opts.canFinance) return {};
  const patch: UpdateProjectExtBody = {};

  const name = draft.name.trim();
  if (name && name !== project.name) patch.name = name;

  const openedOn = draft.openedOn || null;
  if (openedOn !== (project.openedOn ?? null)) patch.openedOn = openedOn;

  const companyId = draft.companyId || null;
  if (companyId !== (project.companyId ?? null)) patch.companyId = companyId;

  const clientId = draft.clientId || null;
  if (clientId !== (project.clientId ?? null)) patch.clientId = clientId;

  const siteAddress = textOrNull(draft.siteAddress);
  if (siteAddress !== (project.siteAddress ?? null)) patch.siteAddress = siteAddress;

  const area = parseOptionalNumber(draft.siteAreaM2);
  if (area !== "invalid" && area !== (project.siteAreaM2 ?? null)) patch.siteAreaM2 = area;

  const scope = normalizeScope(draft.designScope);
  if (JSON.stringify(scope) !== JSON.stringify(normalizeScope(project.designScope ?? []))) patch.designScope = scope;

  const invoiceType = draft.invoiceType || null;
  if (invoiceType !== (project.invoiceType ?? null)) patch.invoiceType = invoiceType;

  const paymentMethod = draft.paymentMethod || null;
  if (paymentMethod !== (project.paymentMethod ?? null)) patch.paymentMethod = paymentMethod;

  const closingDay = textOrNull(draft.closingDay);
  if (closingDay !== (project.closingDay ?? null)) patch.closingDay = closingDay;

  const paymentDay = textOrNull(draft.paymentDay);
  if (paymentDay !== (project.paymentDay ?? null)) patch.paymentDay = paymentDay;

  const other = parseOptionalNumber(draft.otherExpenses);
  // 後端把 null 存成 0（serializeProject 也回 0），所以 null 與 0 視為同值。
  if (other !== "invalid" && (other ?? 0) !== (project.otherExpenses ?? 0)) patch.otherExpenses = other;

  const guildRepaymentNote = textOrNull(draft.guildRepaymentNote);
  if (guildRepaymentNote !== textOrNull(project.guildRepaymentNote)) patch.guildRepaymentNote = guildRepaymentNote;

  const engineersChanged =
    opts.disciplines.some(
      (d) => JSON.stringify(normalizeEngineer(draft.engineers[d])) !== JSON.stringify(normalizeEngineer(project.engineers?.[d])),
    ) ||
    // 已不在科別設定的舊科別：使用者按了「清除」（草稿清空、專案上仍有值）也要整份送，送出時自然不含它。
    Object.keys(project.engineers ?? {}).some(
      (k) => !opts.disciplines.includes(k) && normalizeEngineer(project.engineers?.[k]) !== null && normalizeEngineer(draft.engineers[k]) === null,
    );
  if (engineersChanged) {
    const engineers: ProjectEngineers = {};
    for (const d of opts.disciplines) engineers[d] = normalizeEngineer(draft.engineers[d]);
    patch.engineers = engineers;
  }

  return patch;
}

/**
 * 重新載入專案後（下方其他卡片存檔會整頁重抓），把使用者在申請單上還沒存的修改疊回新資料上：
 * 每個欄位若草稿跟「舊的載入值」一樣（沒動過）就換成新載入值，動過的保留使用者的輸入。
 * 不會因為存了別張卡片就默默清掉申請單草稿。
 */
export function rebaseApplicationSheetDraft(
  oldBase: ApplicationSheetDraft,
  newBase: ApplicationSheetDraft,
  draft: ApplicationSheetDraft,
): ApplicationSheetDraft {
  const out = { ...newBase } as Record<keyof ApplicationSheetDraft, unknown>;
  for (const key of Object.keys(newBase) as Array<keyof ApplicationSheetDraft>) {
    if (key === "engineers") continue;
    if (JSON.stringify(draft[key]) !== JSON.stringify(oldBase[key])) out[key] = draft[key];
  }
  // 協力技師逐科合併：動過的科別保留草稿，其餘用新值。
  const engineers: Record<string, EngineerDraft> = { ...newBase.engineers };
  for (const [k, v] of Object.entries(draft.engineers)) {
    if (JSON.stringify(v) !== JSON.stringify(oldBase.engineers[k])) engineers[k] = v;
  }
  out.engineers = engineers;
  return out as unknown as ApplicationSheetDraft;
}

/** 未儲存的變更數（存檔鈕旁提示用）。 */
export function applicationSheetDirtyCount(
  project: ProjectDetail,
  draft: ApplicationSheetDraft,
  opts: { disciplines: readonly string[]; canFinance: boolean },
): number {
  return Object.keys(applicationSheetPatch(project, draft, opts)).length;
}

/* ====================================================== 帶入的資料 == */

/** Word 寫法的民國日期 'yyy.m.d'（例：110.8.10）。空值回 ""。 */
export function rocDots(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[1]) - 1911}.${Number(m[2])}.${Number(m[3])}`;
}

/** 抬頭「民國　年　月　日」的三段；空值回 null。 */
export function rocDateParts(iso: string | null | undefined): { year: number; month: number; day: number } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return { year: Number(m[1]) - 1911, month: Number(m[2]), day: Number(m[3]) };
}

function isNewerDoc(a: Contract, b: Contract): boolean {
  if (a.signedOn !== b.signedOn) {
    if (a.signedOn === null) return false;
    if (b.signedOn === null) return true;
    return a.signedOn > b.signedOn;
  }
  return a.createdAt > b.createdAt;
}

/**
 * 「訂單」格：跟後端 summarizeContracts() 同一套邏輯——我方承攬、優先看合約（簽訂日新的優先，
 * 沒簽訂日的排後面），沒有合約才退用最新報價單。
 */
export function latestOrderDocument(list: readonly Contract[]): Contract | null {
  let latestContract: Contract | null = null;
  let latestQuotation: Contract | null = null;
  for (const c of list) {
    if (!isOurContract(c.ourRole)) continue;
    if (c.docType === "quotation") {
      if (!latestQuotation || isNewerDoc(c, latestQuotation)) latestQuotation = c;
    } else if (c.docType === "contract") {
      if (!latestContract || isNewerDoc(c, latestContract)) latestContract = c;
    }
  }
  return latestContract ?? latestQuotation;
}

/** 「訂單:」格的勾選框：Word 原檔是「■合約書 110.7.20」。 */
export function orderDocumentCells(doc: Pick<Contract, "docType" | "signedOn"> | null): Array<{ label: string; checked: boolean; date: string }> {
  return [
    { label: "合約書", checked: doc?.docType === "contract", date: doc?.docType === "contract" ? rocDots(doc.signedOn) : "" },
    { label: "報價單", checked: doc?.docType === "quotation", date: doc?.docType === "quotation" ? rocDots(doc.signedOn) : "" },
  ];
}

export interface ApplicationStageRow {
  /** 列首的編號（1 起算，技師公會代墊接在最後一期之後）。 */
  no: number;
  kind: "installment" | "guild_advance";
  /** 期別名稱（milestone）；空白列為 ""。 */
  milestone: string;
  percentage: number | null;
  amount: number | null;
  receivedOn: string | null;
  invoiceNo: string | null;
  invoicedOn: string | null;
  /** 系統裡真的有這一期（false＝補版面的空白列）。 */
  exists: boolean;
  /** 期別 id（空白列 null）。 */
  id: string | null;
  /** 已請款（金額凍結，表格裡不能改金額）。 */
  billed: boolean;
  /** 人工覆寫的理由（改金額時沿用）。 */
  overrideReason: string | null;
}

/** 付款階段每一列在草稿 stageEdits 裡的 key：既有期別用 id，空白列用列號（公會代墊固定一列）。 */
export function stageRowKey(row: Pick<ApplicationStageRow, "id" | "kind" | "no">): string {
  if (row.id) return row.id;
  return row.kind === "guild_advance" ? "new-guild" : `new-installment-${row.no}`;
}

/**
 * 付款階段：一般期別依期別編號排序，不足 7 期補空白列（Word 固定 1～7），
 * 最後一列固定是技師公會代墊。專案明細頁不截斷：超過 7 期全部列出。
 */
export function applicationStageRows(billings: readonly BillingExt[]): ApplicationStageRow[] {
  const installments = billings.filter((b) => b.kind === "installment").sort((a, b) => a.installmentNo - b.installmentNo);
  const guild = billings.find((b) => b.kind === "guild_advance") ?? null;
  const rows: ApplicationStageRow[] = [];
  const count = Math.max(MIN_INSTALLMENT_ROWS, installments.length);
  for (let i = 0; i < count; i++) {
    const b = installments[i];
    rows.push({
      no: i + 1,
      kind: "installment",
      milestone: b?.milestone ?? "",
      percentage: b?.percentage ?? null,
      amount: b ? b.effectiveAmount : null,
      receivedOn: b?.receivedOn ?? null,
      invoiceNo: b?.invoiceNo ?? null,
      invoicedOn: b?.invoicedOn ?? null,
      exists: !!b,
      id: b?.id ?? null,
      billed: !!b?.billedOn,
      overrideReason: b?.overrideReason ?? null,
    });
  }
  rows.push({
    no: count + 1,
    kind: "guild_advance",
    milestone: guild?.milestone || "技師公會代墊",
    percentage: guild?.percentage ?? null,
    amount: guild ? guild.effectiveAmount : null,
    receivedOn: guild?.receivedOn ?? null,
    invoiceNo: guild?.invoiceNo ?? null,
    invoicedOn: guild?.invoicedOn ?? null,
    exists: !!guild,
    id: guild?.id ?? null,
    billed: !!guild?.billedOn,
    overrideReason: guild?.overrideReason ?? null,
  });
  return rows;
}

/** 發包單位：每三筆一個區塊，最後一塊不足三格補 null；沒有任何下包時仍回一個空白區塊。 */
export function applicationSubcontractBlocks(subcontracts: readonly Subcontract[]): Array<Array<Subcontract | null>> {
  const blocks: Array<Array<Subcontract | null>> = [];
  for (let i = 0; i < Math.max(1, subcontracts.length); i += SUBCONTRACTS_PER_BLOCK) {
    const block: Array<Subcontract | null> = [];
    for (let j = 0; j < SUBCONTRACTS_PER_BLOCK; j++) block.push(subcontracts[i + j] ?? null);
    blocks.push(block);
  }
  return blocks;
}

export interface SubcontractSlot {
  /** 草稿 subEdits 的 key：既有副委託用 id，空欄用 `new-<全域欄位序號>`。 */
  key: string;
  sub: Subcontract | null;
}

/**
 * 可編輯版的發包單位欄位：既有副委託依序排，空欄可直接填成新的一筆。
 * 區塊數＝放得下既有筆數的最少區塊（至少一塊）＋使用者多開的區塊；另外確保草稿裡已填的新欄都畫得出來。
 */
export function applicationSubcontractSlots(
  subcontracts: readonly Subcontract[],
  extraBlocks = 0,
  edits: Record<string, SubEdit> = {},
): SubcontractSlot[][] {
  const per = SUBCONTRACTS_PER_BLOCK;
  let maxNewIndex = -1;
  for (const key of Object.keys(edits)) {
    const m = /^new-(\d+)$/.exec(key);
    if (m) maxNewIndex = Math.max(maxNewIndex, Number(m[1]));
  }
  const baseBlocks = Math.max(1, Math.ceil(subcontracts.length / per));
  const neededForEdits = Math.ceil((maxNewIndex + 1) / per);
  const blockCount = Math.max(baseBlocks + Math.max(0, extraBlocks), neededForEdits);
  const blocks: SubcontractSlot[][] = [];
  for (let b = 0; b < blockCount; b++) {
    const block: SubcontractSlot[] = [];
    for (let j = 0; j < per; j++) {
      const i = b * per + j;
      const sub = subcontracts[i] ?? null;
      block.push({ key: sub ? (sub.id ?? `saved-${i}`) : `new-${i}`, sub });
    }
    blocks.push(block);
  }
  return blocks;
}

/** 銷售金額：營業稅＝未稅 × 稅率四捨五入到元（同後端 computeMoney 的 round0），總額＝未稅＋稅。 */
export function salesAmounts(untaxed: number | null, vatRate: number): { taxAmount: number | null; amountTotal: number | null } {
  if (untaxed === null || !Number.isFinite(untaxed)) return { taxAmount: null, amountTotal: null };
  const taxAmount = Math.round(untaxed * vatRate);
  return { taxAmount, amountTotal: untaxed + taxAmount };
}

/** 設計內容的唯讀文字（科別－項目 金額，以「、」串起）。 */
export function designScopeText(rows: readonly DesignScopeItem[]): string {
  return normalizeScope(rows)
    .map((row) => `${row.discipline}${row.item ? `－${row.item}` : ""}${row.amount != null ? ` ${row.amount.toLocaleString()}` : ""}`)
    .join("、");
}

/**
 * 收款彙總一行字（金額卡移除後補在請款期程卡標題列）：「已收 X／未收 Y（收款 Z%）」，口徑同後端 computeMoney（未稅）。
 * 沒有 money（沒有 finance 權限或還沒載入）回 null；未收／進度算不出來（沒有合約金額）顯示「—」。純函式。
 */
export function receiptSummaryText(money: Pick<ProjectMoney, "receivedTotal" | "unreceived" | "receiptProgressPct"> | null | undefined): string | null {
  if (!money) return null;
  const fmt = (n: number | null) => (n == null ? "—" : Math.round(n).toLocaleString("zh-TW"));
  const pct = money.receiptProgressPct == null ? "—" : `${money.receiptProgressPct}%`;
  return `已收 ${fmt(money.receivedTotal)}／未收 ${fmt(money.unreceived)}（收款 ${pct}）`;
}
