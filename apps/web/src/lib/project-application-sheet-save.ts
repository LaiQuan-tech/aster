/**
 * 專案申請單「整張表直接編輯」的存檔計畫（2026-10-29 業主：為什麼表格不能直接編輯？）。
 *
 * 申請單上的格子分屬五個來源，各有自己的既有 API 與權限，這支只負責：
 *   1. 把草稿跟最新資料比對，算出每個來源**真的有變**的部分（applicationSheetPlan）；
 *   2. 依序呼叫各 API、逐步記錄成敗（runApplicationSheetSave），失敗的那一步清楚回報、其餘照送；
 *   3. 算出「存完剩下的草稿」：已存成的格子從疊加層拿掉（重新載入後不會再送一次），沒存成的留著。
 *
 * | 格子                                  | 寫回                                   | 後端權限            |
 * |---------------------------------------|----------------------------------------|---------------------|
 * | 工程名稱、設計地點…其他支出、審迄還款 | PATCH /projects/:id（只送有變的欄位）  | 本案 finance        |
 * | 電話、發票地址、採購承辦、傳真、統編  | PATCH /clients/:id（客戶名冊那一筆）   | HR／會計／平台管理員 |
 * | 訂單勾選、銷售金額未稅                | PUT main-contract／PATCH・POST contracts | 本案 finance        |
 * | 付款階段（說明、%、金額）             | PUT /projects/:id/billings（整批）     | 本案 finance        |
 * | 付款階段（入帳日、發票號碼）          | POST /billings/:id/receive｜invoice    | 本案 finance        |
 * | 發包單位                              | PUT /projects/:id/subcontracts（整批） | 本案 finance        |
 * | 付款階段（獎金分潤、發獎金日）        | PUT /projects/:id/billing-shares       | 老闆／platform_admin |
 *
 * 權限一律交給後端既有檢查（前端只在 canFinance=false 時整張唯讀），這裡不放寬任何東西。
 *
 * ⚠️ vitest 沒設 `@/` 別名：只能用相對路徑。
 */
import { isOurContract, type Contract } from "./projects-api";
import { formatMoney } from "./money";
import { amountFromPct, formatStagePct, pctFromAmount, savedOverrideOf, stageAmountDisplay, stageScheduleSummary } from "./project-application-stage-amounts";
import {
  currentBonusPaidOn,
  currentShareLines,
  filledShareLines,
  parseShareAmount,
  sameShareLines,
  savedShareLines,
  shareLinesTotal,
  shareSetOf,
  type BillingSharesView,
  type ShareEdit,
} from "./project-billing-shares";
import { predictScheduleAmounts } from "./billing-schedule-predict";
import type {
  BillingExt,
  BillingShareSet,
  BillingScheduleWarning,
  BillingShareSetInput,
  Client,
  InstallmentInputExt,
  ProjectDetail,
  ProjectMoney,
  Subcontract,
  UpdateProjectExtBody,
} from "./projects-ext-api";
import {
  CLIENT_SHEET_FIELDS,
  applicationSheetPatch,
  applicationStageRows,
  applicationSubcontractRows,
  subcontractHasPaid,
  latestOrderDocument,
  stageRowKey,
  type ApplicationSheetDraft,
  type ApplicationStageRow,
  type ClientSheetField,
  type SheetError,
  type StageEdit,
  type SubEdit,
} from "./project-application-sheet";

/* ========================================================== 情境 == */

export interface SheetSaveContext {
  project: ProjectDetail;
  canFinance: boolean;
  /**
   * 能改客戶名冊（PATCH /clients/:id 是 requireFinance＝HR／會計／平台管理員，比本案 finance 窄：
   * 本案經理、主辦、部門主管改不了）。false 時客戶格唯讀、不進存檔計畫。省略＝true。
   */
  canEditClient?: boolean;
  disciplines: readonly string[];
  /** 草稿目前選的客戶（名冊讀不到時是專案帶的 client；沒選＝null）。 */
  client: Client | null;
  money: ProjectMoney | null;
  contracts: readonly Contract[];
  billings: readonly BillingExt[];
  subcontracts: readonly Subcontract[];
  vendors: ReadonlyArray<{ id: string; name: string }>;
  /**
   * 每期款獎金分潤（2026-11-11）：null／省略＝看不到（不畫兩欄、不進存檔計畫）。
   * canEdit=false（授權 HR 只能看）時分潤修改不進存檔計畫。
   */
  billingShares?: BillingSharesView;
}

/** 草稿選的客戶：名冊裡找；找不到但就是本案現在的客戶時用專案帶的 client。 */
export function resolveSheetClient(clients: readonly Client[], project: ProjectDetail, clientId: string): Client | null {
  if (!clientId) return null;
  return clients.find((c) => c.id === clientId) ?? (clientId === project.clientId ? project.client ?? null : null);
}

/* ========================================================== 小工具 == */

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function textOrNull(value: string | null | undefined): string | null {
  const t = trimmed(value);
  return t === "" ? null : t;
}

/** "" → null；不是數字 → "invalid"。 */
function parseNumber(value: string, opts: { min?: number; max?: number } = {}): number | null | "invalid" {
  const t = value.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return "invalid";
  if (opts.min !== undefined && n < opts.min) return "invalid";
  if (opts.max !== undefined && n > opts.max) return "invalid";
  return n;
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

/* ================================================== 客戶名冊欄位 == */

export function clientFieldValue(client: Client | null, field: ClientSheetField): string {
  return client?.[field] ?? "";
}

/** 客戶欄位的變更（只回有變的欄位，空字串轉 null）。沒選客戶或沒變回 null。 */
export function clientSheetPatch(
  client: Client | null,
  edits: ApplicationSheetDraft["clientEdits"],
): Partial<Record<ClientSheetField, string | null>> | null {
  if (!client) return null;
  const body: Partial<Record<ClientSheetField, string | null>> = {};
  for (const field of CLIENT_SHEET_FIELDS) {
    const edit = edits[field];
    if (edit === undefined) continue;
    if (textOrNull(edit) !== textOrNull(client[field])) body[field] = textOrNull(edit);
  }
  return Object.keys(body).length > 0 ? body : null;
}

/* ================================================ 訂單／銷售金額 == */

/** 我方承攬的追加減帳合計（同後端 summarizeContracts 的 changeOrders）。 */
export function changeOrderTotal(contracts: readonly Contract[]): number {
  return contracts
    .filter((c) => c.docType === "change_order" && isOurContract(c.ourRole))
    .reduce((sum, c) => sum + (c.amount ?? 0), 0);
}

export type ContractStep =
  | { kind: "main"; amount: number; created: boolean }
  | { kind: "quotation-update"; id: string; amount: number | null }
  | { kind: "quotation-create"; amount: number | null };

/**
 * 訂單格與未稅金額寫到哪：
 * - 有合約（含只有追加減）或新勾「合約書」→ PUT /projects/:id/main-contract（主合約＝合約金額唯一來源），
 *   主合約金額＝輸入的未稅 − 追加減（銷售金額＝主合約＋追加減，存完正好等於輸入值）。
 * - 只有報價單 → PATCH 最新那張報價單的金額（維持是報價單，不偷偷變成合約）。
 * - 什麼都沒有、新勾「報價單」→ POST 一張報價單。
 * - 什麼都沒有又沒勾 → 不知道該記成合約還是報價單，擋下來請使用者先勾。
 * 取消勾選既有文件＝作廢合約，要理由，留在下方「合約與報價單」卡處理。
 */
export function contractPlan(ctx: SheetSaveContext, draft: ApplicationSheetDraft): { step: ContractStep | null; changes: number; errors: SheetError[] } {
  const errors: SheetError[] = [];
  if (!ctx.canFinance) return { step: null, changes: 0, errors };
  const orderDoc = latestOrderDocument(ctx.contracts);
  const hasContractDoc = orderDoc?.docType === "contract";
  const pending =
    draft.orderDocType === "contract" && !hasContractDoc
      ? "contract"
      : draft.orderDocType === "quotation" && !orderDoc
        ? "quotation"
        : null;
  const base = ctx.money?.amountUntaxed ?? null;
  const source = ctx.money?.amountSource ?? null;
  const parsed = draft.amountUntaxed === null ? base : parseNumber(draft.amountUntaxed, { min: 0 });
  if (parsed === "invalid") {
    errors.push({ field: "amountUntaxed", message: "銷售金額（未稅）必須是 0 以上的數字。" });
    return { step: null, changes: 0, errors };
  }
  const amountChanged = draft.amountUntaxed !== null && parsed !== base;
  const changes = (pending ? 1 : 0) + (amountChanged ? 1 : 0);
  if (changes === 0) return { step: null, changes, errors };

  const changeOrders = changeOrderTotal(ctx.contracts);
  const toMain = (amount: number | null, created: boolean): ContractStep | null => {
    if (amount === null) {
      errors.push({ field: "amountUntaxed", message: created ? "勾選「合約書」要一併填銷售金額（未稅）。" : "合約金額不能清空（要作廢合約請到下方「合約與報價單」）。" });
      return null;
    }
    const main = amount - changeOrders;
    if (main < 0) {
      errors.push({ field: "amountUntaxed", message: `銷售金額（未稅）不能小於追加減帳合計 ${changeOrders.toLocaleString()}。` });
      return null;
    }
    return { kind: "main", amount: main, created };
  };

  let step: ContractStep | null = null;
  if (pending === "contract") step = toMain(parsed, true);
  else if (source === "contract") step = toMain(parsed, false);
  else if (orderDoc?.docType === "quotation") step = { kind: "quotation-update", id: orderDoc.id, amount: parsed };
  else if (pending === "quotation") step = { kind: "quotation-create", amount: parsed };
  else {
    const message = "本案還沒有合約或報價單：請先在「訂單」格勾選合約書或報價單，再填銷售金額。";
    errors.push({ field: "orderDocType", message }, { field: "amountUntaxed", message });
  }
  return { step, changes, errors };
}

/* ======================================================== 付款階段 == */

/**
 * 付款階段試算用的合約總額：後端只在「有合約（或這次勾了合約書）」時依 % 試算（billing-store contractTotal）；
 * 只有報價單＝null（不預填，避免存檔後金額變空白）。未稅格有輸入就用草稿值。
 */
export function stageContractTotal(
  money: ProjectMoney | null,
  contracts: readonly Contract[],
  draft: Pick<ApplicationSheetDraft, "amountUntaxed" | "orderDocType">,
): number | null {
  const pendingContract = draft.orderDocType === "contract" && latestOrderDocument(contracts)?.docType !== "contract";
  if (money?.amountSource !== "contract" && !pendingContract) return null;
  const parsed = draft.amountUntaxed === null ? (money?.amountUntaxed ?? null) : parseNumber(draft.amountUntaxed, { min: 0 });
  return parsed === "invalid" ? null : parsed;
}

interface StageBase {
  milestone: string;
  percentage: string;
  amount: string;
  receivedOn: string;
  invoiceNo: string;
  invoicedOn: string;
  note: string;
}

export function stageBaseValues(row: ApplicationStageRow): StageBase {
  return {
    milestone: row.milestone,
    percentage: row.percentage != null ? String(row.percentage) : "",
    amount: row.amount != null ? String(row.amount) : "",
    receivedOn: row.receivedOn ?? "",
    invoiceNo: row.invoiceNo ?? "",
    invoicedOn: row.invoicedOn ?? "",
    note: row.note ?? "",
  };
}

/** 一列哪些格子能在表格裡改（其他狀態要撤銷事件、填理由，留在下方「分期請款期程」卡）。 */
export function stageLocks(row: ApplicationStageRow) {
  const received = !!row.receivedOn;
  return {
    milestone: false,
    /** 已入帳的期別金額凍結（後端 409 received）。 */
    percentage: received,
    /** 已請款＝金額凍結在請款金額；已入帳同上。 */
    amount: received || row.billed,
    /** 已入帳的要先撤銷入帳（要理由）。 */
    receivedOn: received,
    /** 已開票的要先撤銷開票（要理由）；公會代墊列那格在 Word 上是「審迄還款」。 */
    invoiceNo: !!row.invoiceNo || row.kind === "guild_advance",
    /** 發票日期跟著開票走：已開票的要先撤銷開票；公會代墊列沒有發票。 */
    invoicedOn: !!row.invoiceNo || !!row.invoicedOn || row.kind === "guild_advance",
  };
}

export interface StagePlan {
  /** PUT /billings 的整批內容（含所有既有期別）；說明／%／金額都沒變＝null。 */
  installments: InstallmentInputExt[] | null;
  /** 新增的期別：草稿 key → 期別編號（存完用編號找回新 id）。 */
  created: Array<{ key: string; installmentNo: number; label: string }>;
  /** 整列清空（名稱、%、金額都空，且未請款／開票／入帳）→ 從整批 PUT 拿掉＝後端軟刪除。 */
  removed: Array<{ key: string; label: string }>;
  /**
   * 自動移除的空殼期別（使用者沒動、在申請單上看起來是空白列）原本的 PUT 內容。看不到分潤的人（會計）不知道
   * 空殼上有沒有獎金分潤；後端回 409 billing_has_bonus_shares 時，存檔會把這些列放回去重送一次（保留、不擋存）。
   */
  autoShells: InstallmentInputExt[];
  invoices: Array<{ key: string; label: string; invoiceNo: string; invoicedOn: string }>;
  receipts: Array<{ key: string; label: string; receivedOn: string }>;
  /** 改了金額、要使用者填人工指定理由的列（沒有合約總額、只能人工指定時；沒有既有理由可沿用）。 */
  needsReason: Array<{ key: string; label: string }>;
  changes: number;
  errors: SheetError[];
  /** 草稿裡對不到任何列的修改（那一列已被別處新增／移除）：不送出，提醒使用者。 */
  warnings: string[];
}

function stageLabel(row: ApplicationStageRow): string {
  return row.kind === "guild_advance" ? "技師公會代墊" : `第 ${row.no} 列`;
}

/**
 * 空殼期別：名稱、%、人工金額、預定日、備註都空，也沒請款／開票／入帳——在申請單上跟空白列無法區分，
 * 留著只會讓下方期程多一列「第 N 期 —」。
 */
export function isEmptyShellBilling(b: BillingExt): boolean {
  return (
    trimmed(b.milestone ?? "") === "" &&
    b.percentage == null &&
    b.overrideAmount == null &&
    !b.plannedOn &&
    trimmed(b.note ?? "") === "" &&
    !b.billedOn &&
    !b.invoiceNo &&
    !b.invoicedOn &&
    !b.receivedOn
  );
}

/** 草稿（沒改就用已存的）裡該期的分潤名單與發獎金日是否都空了。 */
export function draftClearsShares(set: BillingShareSet | null, edit: ShareEdit | undefined): boolean {
  return filledShareLines(currentShareLines(set, edit)).length === 0 && trimmed(currentBonusPaidOn(set, edit)) === "";
}

/** 已存的這一期有獎金分潤或發獎金日（看得到分潤時才知道；看不到＝false）。 */
function savedHasShares(set: BillingShareSet | null): boolean {
  return !!set && (set.shares.length > 0 || !!set.bonusPaidOn);
}

/** 空殼期別要不要因為分潤保留：已存有分潤／發獎金日，且草稿沒有把它們清空。 */
function shellKeepsForShares(ctx: SheetSaveContext, draft: ApplicationSheetDraft, key: string, billingId: string | null): boolean {
  const set = shareSetOf(ctx.billingShares ?? null, billingId);
  return savedHasShares(set) && !draftClearsShares(set, draft.shareEdits?.[key]);
}

/** 這次的修改有沒有在該列填進任何內容（說明／%／金額／發票／日期）。 */
function stageEditFills(edit: StageEdit | undefined): boolean {
  if (!edit) return false;
  return (["milestone", "percentage", "amount", "receivedOn", "invoiceNo", "invoicedOn", "note"] as const).some((f) => trimmed(edit[f]) !== "");
}

/** 金額為主模式：有合約總額，且未稅變了或任一可編輯期別改了金額／%。 */
function stageAmountMode(rows: readonly ApplicationStageRow[], draft: ApplicationSheetDraft, total: number | null, totalChanged: boolean): boolean {
  if (total === null || !(total > 0)) return false;
  if (totalChanged) return true;
  return rows.some((r) => {
    const e = draft.stageEdits[stageRowKey(r)];
    return !!e && !stageLocks(r).amount && (e.amount !== undefined || e.percentage !== undefined);
  });
}

/**
 * 存檔前把畫面上看到的金額「釘」進草稿：之後重抓期程時（合約金額可能已先存成新值，後端已依新總額重算各期），
 * 沒動過的期別仍以使用者看到的金額為準換算 %，存後金額＝畫面金額。只用於重新規劃，不回寫未儲存草稿。
 */
export function pinStageScreenAmounts(ctx: SheetSaveContext, draft: ApplicationSheetDraft): ApplicationSheetDraft {
  if (!ctx.canFinance) return draft;
  const rows = applicationStageRows(ctx.billings);
  const total = stageContractTotal(ctx.money, ctx.contracts, draft);
  const savedTotal = ctx.money?.amountSource === "contract" ? (ctx.money.amountUntaxed ?? null) : null;
  if (!stageAmountMode(rows, draft, total, total !== null && total !== savedTotal)) return draft;
  const stageEdits = { ...draft.stageEdits };
  for (const r of rows) {
    const key = stageRowKey(r);
    const e = stageEdits[key];
    // 負數＝吸收超額配置尾差的列：不釘（不重送），讓後端照原規則吸收（見 stagePlan 的超額檢查）。
    if (!r.exists || stageLocks(r).amount || r.amount == null || r.amount < 0 || savedOverrideOf(r, ctx.billings) !== null) continue;
    if (e?.amount !== undefined || e?.percentage !== undefined) continue;
    stageEdits[key] = { ...(e ?? {}), amount: String(r.amount) };
  }
  return { ...draft, stageEdits };
}

export function stagePlan(ctx: SheetSaveContext, draft: ApplicationSheetDraft): StagePlan {
  const out: StagePlan = { installments: null, created: [], removed: [], autoShells: [], invoices: [], receipts: [], needsReason: [], changes: 0, errors: [], warnings: [] };
  if (!ctx.canFinance) return out;
  const rows = applicationStageRows(ctx.billings);
  const byId = new Map(ctx.billings.map((b) => [b.id, b]));
  const payload: InstallmentInputExt[] = ctx.billings.map((b) => ({
    id: b.id,
    installmentNo: b.installmentNo,
    kind: b.kind,
    percentage: b.percentage,
    milestone: b.milestone,
    plannedOn: b.plannedOn,
    overrideAmount: b.overrideAmount,
    overrideReason: b.overrideReason,
    note: b.note,
  }));
  // 金額為主：有合約總額時，金額換成剛好算回同一金額的 % 存（後端以 % 試算），不必人工指定、不要理由。
  const total = stageContractTotal(ctx.money, ctx.contracts, draft);
  const savedTotal = ctx.money?.amountSource === "contract" ? (ctx.money.amountUntaxed ?? null) : null;
  /** 未稅變了：金額不動、% 依新總額重算 → 每列都要重送 %。 */
  const totalChanged = total !== null && total !== savedTotal;
  const mode = stageAmountMode(rows, draft, total, totalChanged);
  if (totalChanged && total !== null) {
    // 已入帳但還沒請款的期別：% 不能改（後端 409），金額會跟著新的未稅重算——事先講清楚。
    for (const r of rows) {
      if (!r.receivedOn || r.billed || r.percentage == null) continue;
      const next = r.kind === "installment" ? null : amountFromPct(r.percentage, total);
      const hint = next !== null ? `${formatMoney(next)}` : `約 ${formatMoney(amountFromPct(r.percentage, total))}`;
      out.warnings.push(`付款階段${stageLabel(r)}已入帳但未請款：百分比 ${formatStagePct(r.percentage)}% 不能改，金額會依新的未稅重算為${hint}（含尾差時以存後為準）。`);
    }
  }
  /** 目前金額為負、使用者沒動的列（期程原本就超額配置，最後一期吸收成負數）：不重送，交給後端照原規則吸收。 */
  const negativeUntouched = new Set<string>();
  if (mode && total !== null) {
    const isEdited = (r: ApplicationStageRow) => {
      const e = draft.stageEdits[stageRowKey(r)];
      return !!e && (e.amount !== undefined || e.percentage !== undefined);
    };
    for (const r of rows) if (r.exists && !stageLocks(r).amount && r.amount != null && r.amount < 0 && !isEdited(r)) negativeUntouched.add(stageRowKey(r));
    if (negativeUntouched.size > 0) {
      // 其他各期（含人工指定、已請款、這次改的）存後的金額合計；超過未稅＝超額配置，後端無法吸收成 0 以上 → 擋存並指出原因。
      let others = 0;
      for (const r of rows) {
        if (r.kind !== "installment" || negativeUntouched.has(stageRowKey(r))) continue;
        const e = draft.stageEdits[stageRowKey(r)];
        let a: number | null | "invalid" = stageLocks(r).amount ? r.amount : e?.amount !== undefined ? parseNumber(e.amount, { min: 0 }) : r.amount;
        if (a === null && e?.percentage !== undefined && !stageLocks(r).amount) {
          const p = parseNumber(e.percentage, { min: 0, max: 100 });
          a = typeof p === "number" ? amountFromPct(p, total) : null;
        }
        if (typeof a === "number") others += a;
      }
      const editedKeys = rows.filter((r) => isEdited(r) && !stageLocks(r).amount).map(stageRowKey);
      const errField = editedKeys.length > 0 ? `stage:${editedKeys[0]}:amount` : "amountUntaxed";
      const overrides = rows.filter((r) => savedOverrideOf(r, ctx.billings) !== null && !isEdited(r)).map(stageLabel);
      const cause = overrides.length > 0 ? `（人工指定金額：${overrides.join("、")}）` : "";
      if (others > total) {
        out.errors.push({
          field: errField,
          message: `付款階段超額配置 ${formatMoney(others - total)} 元：各期金額合計 ${formatMoney(others)} 超過銷售金額（未稅）${formatMoney(total)}${cause}，請先調整某期金額。`,
        });
      } else {
        // 負數列必須仍是最後一個吸收尾差的期別，否則差額會落到別期、存後與畫面不符。
        const absorbers = rows.filter((r) => {
          if (r.kind !== "installment" || stageLocks(r).amount) return false;
          const e = draft.stageEdits[stageRowKey(r)];
          const willExist = r.exists || (!!e && stageEditFills(e));
          const override = isEdited(r) ? false : savedOverrideOf(r, ctx.billings) !== null;
          return willExist && !override;
        });
        const last = absorbers[absorbers.length - 1];
        for (const r of rows) {
          const key = stageRowKey(r);
          if (negativeUntouched.has(key) && (!last || stageRowKey(last) !== key)) {
            out.errors.push({ field: `stage:${key}:amount`, message: `付款階段${stageLabel(r)}目前是負數（期程超額配置的尾差），請先調整這一期的金額再存。` });
          }
        }
      }
    }
  }
  let nextNo = ctx.billings.reduce((m, b) => Math.max(m, b.installmentNo), 0) + 1;
  let scheduleChanged = false;
  const rowKeys = new Set(rows.map(stageRowKey));
  const orphans = Object.entries(draft.stageEdits).filter(
    ([key, edit]) => !rowKeys.has(key) && Object.values(edit).some((v) => trimmed(v) !== ""),
  );
  if (orphans.length > 0) {
    out.warnings.push(`付款階段有 ${orphans.length} 列的修改對不到期別（期程已在別處變動），不會送出；請按「還原」後重填。`);
  }

  for (const row of rows) {
    const key = stageRowKey(row);
    const edit: StageEdit | undefined = draft.stageEdits[key];
    // 空殼期別（舊版清空名稱只存 null、沒移除而留下）：申請單這列看起來跟「沒有這一期」一樣空白，
    // 使用者再清空也沒有差異可送，所以這次沒填任何內容就直接列入移除（2026-11-09 業主回報第 8 列刪不掉）。
    const label = stageLabel(row);
    const ghost = row.id ? byId.get(row.id) : undefined;
    // 已有獎金分潤／發獎金日的空殼（看得到分潤時才知道）：保留、不擋存——除非草稿已把分潤與發獎金日清空
    // （那就跟一般要刪的期別一樣：存檔先清分潤、再刪期別，見 sharePlan／runApplicationSheetSave）。
    if (ghost && isEmptyShellBilling(ghost) && !stageEditFills(edit) && !shellKeepsForShares(ctx, draft, key, row.id)) {
      const target = payload.find((p) => p.id === row.id);
      if (target) {
        payload.splice(payload.indexOf(target), 1);
        out.autoShells.push(target);
      }
      scheduleChanged = true;
      out.changes += 1;
      out.removed.push({ key, label });
      out.warnings.push(`付款階段${label}在系統裡是空白期別（下方「分期請款期程」仍顯示），儲存時會一併移除。`);
      continue;
    }
    if (!edit && !mode) continue;
    const e: StageEdit = edit ?? {};
    const base = stageBaseValues(row);
    const locks = stageLocks(row);

    const milestoneChanged = e.milestone !== undefined && trimmed(e.milestone) !== trimmed(base.milestone);
    let percentage: number | null | undefined;
    let amount: number | null | undefined;
    const savedOverride = savedOverrideOf(row, ctx.billings);
    const amountEdited = e.amount !== undefined || e.percentage !== undefined;
    // 金額為主模式（任一期金額／% 或未稅有變）：所有可編輯期別都以畫面金額換算 % 一起送，存後各期＝畫面值
    // （吸收尾差的期別換人時也不會默默變動）。沒被編輯的人工指定列不動（金額本來就固定，理由保留）。
    if (mode && total !== null && !locks.amount && !negativeUntouched.has(key) && (amountEdited || (row.exists && savedOverride === null))) {
      // 目標金額：金額格 > % 格反算 > 原金額（只有未稅變了）。
      let target: number | null | "invalid";
      if (e.amount !== undefined) target = parseNumber(e.amount, { min: 0 });
      else if (e.percentage !== undefined) {
        const p = parseNumber(e.percentage, { min: 0, max: 100 });
        target = p === "invalid" ? "invalid" : p === null ? null : amountFromPct(p, total);
      } else target = row.amount;
      if (target === "invalid") {
        const field = e.amount !== undefined ? "amount" : "percentage";
        out.errors.push({ field: `stage:${key}:${field}`, message: field === "amount" ? `付款階段${label}的金額必須是 0 以上的數字。` : `付款階段${label}的百分比必須是 0～100 的數字。` });
      } else if (target !== null && target > total) {
        out.errors.push({ field: `stage:${key}:amount`, message: `付款階段${label}的金額不能大於銷售金額（未稅）${formatMoney(total)}。` });
      } else {
        const p = target === null ? null : pctFromAmount(target, total);
        if (p !== row.percentage) percentage = p;
        // 以金額為主＝不是人工指定：既有的人工指定金額一併取消（金額已由 % 算回）。
        if (savedOverride !== null) amount = null;
      }
    } else {
      // 沒有合約總額（後端不試算）或金額凍結：沿用舊規則——% 照填、改金額＝人工指定（要理由）。
      if (e.percentage !== undefined && !locks.percentage) {
        const p = parseNumber(e.percentage, { min: 0, max: 100 });
        if (p === "invalid") out.errors.push({ field: `stage:${key}:percentage`, message: `付款階段${label}的百分比必須是 0～100 的數字。` });
        else if (p !== row.percentage) percentage = p;
      }
      if (e.amount !== undefined && !locks.amount) {
        const a = parseNumber(e.amount, { min: 0 });
        if (a === "invalid") out.errors.push({ field: `stage:${key}:amount`, message: `付款階段${label}的金額必須是 0 以上的數字。` });
        else if (a === null) amount = savedOverride !== null ? null : undefined;
        else if (a !== savedOverride) amount = a;
      }
    }
    const noteChanged = e.note !== undefined && trimmed(e.note) !== trimmed(base.note);
    const receivedOn = !locks.receivedOn && e.receivedOn !== undefined ? trimmed(e.receivedOn) : "";
    const invoiceNo = !locks.invoiceNo && e.invoiceNo !== undefined ? trimmed(e.invoiceNo) : "";
    const invoicedOn = !locks.invoicedOn && e.invoicedOn !== undefined ? trimmed(e.invoicedOn) : "";
    if (receivedOn && !dateRe.test(receivedOn)) out.errors.push({ field: `stage:${key}:receivedOn`, message: `付款階段${label}的入帳日期格式不對。` });
    if (invoicedOn && !dateRe.test(invoicedOn)) out.errors.push({ field: `stage:${key}:invoicedOn`, message: `付款階段${label}的發票日期格式不對。` });
    if (invoiceNo.length > 40) out.errors.push({ field: `stage:${key}:invoiceNo`, message: `付款階段${label}的發票號碼最多 40 字。` });

    const rowScheduleChanges = (milestoneChanged ? 1 : 0) + (percentage !== undefined ? 1 : 0) + (amount !== undefined ? 1 : 0) + (noteChanged ? 1 : 0);
    out.changes += rowScheduleChanges + (receivedOn ? 1 : 0) + (invoiceNo ? 1 : 0);

    // 人工指定金額要理由（後端 override_reason_required）：沿用既有理由，否則要使用者自己填，不代填。
    let overrideReason: string | null = null;
    if (amount != null) {
      overrideReason = trimmed(e.overrideReason) || row.overrideReason || "";
      if (!overrideReason) {
        out.needsReason.push({ key, label });
        out.errors.push({ field: `stage:${key}:overrideReason`, message: `付款階段${label}改了金額（人工指定），請填理由。` });
      }
    }

    // 入帳要算得出金額（後端 amount_unknown）：這列存完後要有金額或百分比。
    const amountAfter = amount !== undefined ? amount : row.amount;
    const pctAfter = percentage !== undefined ? percentage : row.percentage;
    if (receivedOn && amountAfter == null && pctAfter == null) {
      out.errors.push({ field: `stage:${key}:receivedOn`, message: `付款階段${label}要先有金額或百分比，才能登記入帳日期。` });
    }

    if (row.id) {
      if (rowScheduleChanges === 0) {
        if (receivedOn && dateRe.test(receivedOn)) out.receipts.push({ key, label, receivedOn });
        if (invoiceNo) out.invoices.push({ key, label, invoiceNo, invoicedOn: dateRe.test(invoicedOn) ? invoicedOn : "" });
        continue;
      }
      const target = payload.find((p) => p.id === row.id);
      const saved = byId.get(row.id);
      if (!target || !saved) continue;
      scheduleChanged = true;
      // 整列清空：名稱、%、人工金額存完都是空，而且這次沒填發票／入帳 → 移除這一期。
      const milestoneAfter = milestoneChanged ? trimmed(e.milestone) : trimmed(base.milestone);
      const noteAfter = noteChanged ? trimmed(e.note) : trimmed(base.note);
      const overrideAfter = amount !== undefined ? amount : saved.overrideAmount;
      const cleared = milestoneAfter === "" && noteAfter === "" && pctAfter == null && overrideAfter == null && !receivedOn && !invoiceNo && !invoicedOn;
      if (cleared) {
        if (!saved.billedOn && !saved.invoiceNo && !saved.invoicedOn && !saved.receivedOn) {
          payload.splice(payload.indexOf(target), 1);
          out.removed.push({ key, label });
          continue;
        }
        // 已請款／開票／入帳的期別後端不准移除（409）：名稱照存空白，其他格維持原值，並說明原因（不默默還原）。
        out.warnings.push(`付款階段${label}已請款／開票或入帳，不能整列移除：項目說明會存成空白、其他格維持原值；要移除請先到下方「分期請款期程」撤銷。`);
      }
      if (milestoneChanged) target.milestone = textOrNull(e.milestone);
      if (noteChanged) target.note = textOrNull(e.note);
      if (percentage !== undefined) target.percentage = percentage;
      if (amount !== undefined) {
        target.overrideAmount = amount;
        target.overrideReason = amount === null ? null : overrideReason;
      }
    } else {
      // 空白列：說明／%／金額任一有填才新增一期；只填發票或入帳日也要先建出這一期。
      if (rowScheduleChanges === 0 && !receivedOn && !invoiceNo) continue;
      scheduleChanged = true;
      const installmentNo = nextNo++;
      payload.push({
        installmentNo,
        kind: row.kind,
        percentage: percentage ?? null,
        milestone: milestoneChanged ? textOrNull(e.milestone) : null,
        plannedOn: null,
        overrideAmount: amount ?? null,
        overrideReason: amount != null ? overrideReason : null,
        note: noteChanged ? textOrNull(e.note) : null,
      });
      out.created.push({ key, installmentNo, label });
    }
    if (receivedOn && dateRe.test(receivedOn)) out.receipts.push({ key, label, receivedOn });
    if (invoiceNo) out.invoices.push({ key, label, invoiceNo, invoicedOn: dateRe.test(invoicedOn) ? invoicedOn : "" });
  }
  if (scheduleChanged && total !== null && total > 0) {
    const summary = stageScheduleSummary(rows, draft.stageEdits, stageRowKey, total);
    if (summary.diff !== null && summary.diff !== 0) {
      out.warnings.push(
        `付款階段各期金額合計 ${formatMoney(summary.amountTotal)}（${formatStagePct(summary.pctTotal)}%）與銷售金額（未稅）${formatMoney(total)} 差 ${formatMoney(summary.diff)}：存檔後差額會加到最後一期（系統尾差規則）。`,
      );
    }
  }
  if (scheduleChanged) out.installments = payload;
  return out;
}

/* ======================================================== 發包單位 == */

const SUB_FIELDS = ["vendorName", "contact", "item", "amount", "billingBasis"] as const;

function subBaseValue(sub: Subcontract | null, field: (typeof SUB_FIELDS)[number]): string {
  if (!sub) return "";
  if (field === "amount") return String(sub.amount ?? 0);
  return sub[field] ?? "";
}

/** 副委託整批 PUT 的一列：照既有值原樣帶回（含 contractId、sortOrder，免得被清掉）。 */
function subPayloadOf(s: Subcontract): Subcontract {
  return {
    id: s.id,
    kind: s.kind,
    discipline: s.discipline ?? null,
    vendorId: s.vendorId ?? null,
    vendorName: s.vendorName ?? null,
    contact: s.contact ?? null,
    item: s.item ?? null,
    amount: s.amount ?? 0,
    billingBasis: s.billingBasis ?? null,
    orderType: s.orderType ?? null,
    contractId: s.contractId ?? null,
    withholdingRate: s.withholdingRate,
    withholdingThreshold: s.withholdingThreshold,
    ...(s.sortOrder !== undefined ? { sortOrder: s.sortOrder } : {}),
    note: s.note ?? null,
  };
}

export interface SubPlan {
  subcontracts: Subcontract[] | null;
  changes: number;
  errors: SheetError[];
  warnings: string[];
  /** 草稿裡對不到任何列的 subEdits key（空列已被別人新增的副委託佔走，或那筆已被移除）。 */
  orphanKeys: string[];
  /** 這次有移除既有副委託時的理由（PUT 的 deleteReason）；沒移除＝null。 */
  deleteReason: string | null;
}

export function subcontractPlan(ctx: SheetSaveContext, draft: ApplicationSheetDraft): SubPlan {
  const out: SubPlan = { subcontracts: null, changes: 0, errors: [], warnings: [], orphanKeys: [], deleteReason: null };
  if (!ctx.canFinance) return out;
  const slots = applicationSubcontractRows(ctx.subcontracts, draft.subExtraRows, draft.subEdits);
  const slotKeys = new Set(slots.map((sl) => sl.key));
  out.orphanKeys = Object.entries(draft.subEdits)
    .filter(([key, edit]) => !slotKeys.has(key) && Object.values(edit).some((v) => trimmed(v) !== ""))
    .map(([key]) => key);
  const orphanCount = out.orphanKeys.length;
  if (orphanCount > 0) {
    out.warnings.push(`發包有 ${orphanCount} 列的修改對不到副委託（已在別處新增或移除），不會送出；請按「還原」後重填。`);
  }
  // 標記移除的既有列（對不到的 id＝已被別處移除，忽略）：整批 PUT 不帶＝後端軟刪，要理由；已付款的不准移除。
  const removedIds = new Set((draft.subRemovedIds ?? []).filter((id) => ctx.subcontracts.some((s) => s.id === id)));
  const payload = ctx.subcontracts.filter((s) => !(s.id && removedIds.has(s.id))).map(subPayloadOf);
  let nextSort = ctx.subcontracts.reduce((m, s, i) => Math.max(m, s.sortOrder ?? i), -1) + 1;
  let changed = false;
  if (removedIds.size > 0) {
    changed = true;
    out.changes += removedIds.size;
    slots.forEach((slot, idx) => {
      if (slot.sub?.id && removedIds.has(slot.sub.id) && subcontractHasPaid(slot.sub)) {
        out.errors.push({ field: `sub:${slot.key}:remove`, message: `發包第 ${idx + 1} 列已有付款紀錄，不能移除；要移除請先到下方「副委託」撤銷付款。` });
      }
    });
    const reason = trimmed(draft.subDeleteReason);
    if (reason === "") out.errors.push({ field: "subDeleteReason", message: "移除發包必須填理由。" });
    else out.deleteReason = reason;
  }
  slots.forEach((slot, idx) => {
    const edit: SubEdit | undefined = draft.subEdits[slot.key];
    if (!edit) return;
    if (slot.sub?.id && removedIds.has(slot.sub.id)) return; // 要移除的列，改的格子不送
    const diff: Partial<Record<(typeof SUB_FIELDS)[number], string>> = {};
    for (const f of SUB_FIELDS) {
      const v = edit[f];
      if (v === undefined) continue;
      if (f === "amount") {
        const n = parseNumber(v, { min: 0, max: 1e12 });
        if (n === "invalid") {
          out.errors.push({ field: `sub:${slot.key}:amount`, message: `發包第 ${idx + 1} 列的發包金額必須是 0 以上的數字。` });
          continue;
        }
        if ((n ?? 0) !== Number(subBaseValue(slot.sub, "amount") || 0)) diff.amount = String(n ?? 0);
      } else if (textOrNull(v) !== textOrNull(subBaseValue(slot.sub, f))) {
        diff[f] = v;
      }
    }
    const n = Object.keys(diff).length;
    if (n === 0) return;
    out.changes += n;
    changed = true;
    const apply = (row: Subcontract) => {
      if (diff.vendorName !== undefined) {
        const name = textOrNull(diff.vendorName);
        const match = name ? ctx.vendors.find((v) => v.name === name) : undefined;
        row.vendorName = name;
        row.vendorId = match?.id ?? null;
      }
      if (diff.contact !== undefined) row.contact = textOrNull(diff.contact);
      if (diff.item !== undefined) row.item = textOrNull(diff.item);
      if (diff.billingBasis !== undefined) row.billingBasis = textOrNull(diff.billingBasis);
      if (diff.amount !== undefined) row.amount = Number(diff.amount);
    };
    if (slot.sub) {
      const target = payload.find((p) => p.id === slot.sub?.id);
      if (target) apply(target);
    } else {
      // 新的一筆：預設值同下方副委託卡的「新增」（下包、扣繳 10%、起扣 20,000）。
      const row: Subcontract = {
        kind: "subcontract",
        discipline: null,
        vendorId: null,
        vendorName: null,
        contact: null,
        item: null,
        amount: 0,
        billingBasis: null,
        orderType: null,
        withholdingRate: 0.1,
        withholdingThreshold: 20000,
        sortOrder: nextSort++,
        note: null,
      };
      apply(row);
      payload.push(row);
    }
  });
  if (changed) out.subcontracts = payload;
  return out;
}

/* ==================================================== 每期獎金分潤 == */

export interface SharePlanItem {
  key: string;
  label: string;
  /** 既有期別 id；新建的期別存完才知道（null）。 */
  billingId: string | null;
  bonusPaidOn: string | null;
  shares: Array<{ employeeId: string; amount: number }>;
  /**
   * 要刪的期別、草稿已把分潤與發獎金日清空：存檔時**先**送這筆清除，再送期程（刪期別），
   * 否則後端（API＋DB 觸發器）會因為該期還有分潤回 409。
   */
  beforeSchedule?: boolean;
}

export interface SharePlan {
  items: SharePlanItem[];
  changes: number;
  errors: SheetError[];
  /**
   * 每期分潤的比較基準（key → 存後該期金額，以後端尾差規則預估；null＝沒有金額）。
   * 分潤編輯器的 % 與「超過該期金額」也用它，跟存檔檢查一致。
   */
  limits: Record<string, number | null>;
}

/** 該期在畫面上的金額（金額格有改用草稿，否則已存的有效金額）；空白或不合法＝null。 */
export function stageScreenAmount(row: ApplicationStageRow, edit: StageEdit | undefined): number | null {
  // 期別金額不受分潤「最多小數 2 位」限制（那是分潤金額的規則），這裡只要 0 以上的數字。
  const n = parseNumber(stageAmountDisplay(row, edit), { min: 0 });
  return typeof n === "number" ? n : null;
}

/** 金額轉整數「分」再比（避免浮點誤差，同後端）。 */
function cents(n: number): number {
  return Math.round(n * 100);
}

/** 分潤合計是否超過該期金額（合計 > 0 且沒有金額也算超過）。 */
export function sharesOverLimit(total: number, limit: number | null): boolean {
  if (!(cents(total) > 0)) return false;
  return limit === null || cents(total) > cents(limit);
}

/**
 * 預估存檔後每一列（stageRowKey）的期別金額：照後端尾差規則（billing-schedule-predict.ts）重算整份期程。
 * 期程沒變（stages.installments＝null）→ 回 null（沿用已存的金額）。
 */
export function predictedStageAmounts(
  ctx: SheetSaveContext,
  draft: ApplicationSheetDraft,
  stages: Pick<StagePlan, "installments" | "created">,
): Map<string, number | null> | null {
  if (!stages.installments) return null;
  const byId = new Map(ctx.billings.map((b) => [b.id.toLowerCase(), b]));
  const total = stageContractTotal(ctx.money, ctx.contracts, draft);
  const byNo = predictScheduleAmounts(
    stages.installments.map((i) => {
      const saved = i.id ? byId.get(i.id.toLowerCase()) : undefined;
      return {
        installmentNo: i.installmentNo,
        kind: i.kind ?? saved?.kind ?? "installment",
        percentage: i.percentage ?? null,
        overrideAmount: i.overrideAmount ?? null,
        billed: !!saved?.billedOn,
        billedAmount: saved?.billedAmount ?? null,
      };
    }),
    total,
  );
  const out = new Map<string, number | null>();
  for (const i of stages.installments) if (i.id) out.set(i.id, byNo.get(i.installmentNo) ?? null);
  for (const c of stages.created) out.set(c.key, byNo.get(c.installmentNo) ?? null);
  return out;
}

/**
 * 每期款獎金分潤的存檔計畫：只送有改的期別（每期整批換掉）。
 * - 比較基準＝**存後的期別金額**（依後端尾差規則預估，見 predictedStageAmounts），不是畫面上的金額。
 * - 分潤有改、或該期金額會變（含被尾差影響）→ 檢查分潤合計 ≤ 該期金額；超過 → 擋存，紅底標在 `stage:<key>:shares`。
 * - 技師公會代墊（代墊款）不可設分潤：略過。
 * - 要移除的期別（stages.removed）：已有分潤或發獎金日時看草稿——草稿已清空（且有權改）→ 送一筆清除、標 beforeSchedule
 *   （存檔先清分潤、再刪期別）；沒清空 → 擋存（請先清除），否則後端 409。
 */
export function sharePlan(
  ctx: SheetSaveContext,
  draft: ApplicationSheetDraft,
  stages: Pick<StagePlan, "installments" | "created" | "removed"> = stagePlan(ctx, draft),
): SharePlan {
  const out: SharePlan = { items: [], changes: 0, errors: [], limits: {} };
  const view = ctx.billingShares ?? null;
  if (!ctx.canFinance || !view || !view.available) return out;
  const removedKeys = new Set(stages.removed.map((r) => r.key));
  const createdKeys = new Set(stages.created.map((c) => c.key));
  const predicted = predictedStageAmounts(ctx, draft, stages);
  for (const row of applicationStageRows(ctx.billings)) {
    const key = stageRowKey(row);
    const set = shareSetOf(view, row.id);
    const label = stageLabel(row);
    const field = `stage:${key}:shares`;
    if (row.kind === "guild_advance") continue;
    if (removedKeys.has(key)) {
      if (savedHasShares(set)) {
        if (view.canEdit && row.id && draftClearsShares(set, draft.shareEdits?.[key])) {
          out.changes += 1;
          out.items.push({ key, label, billingId: row.id, bonusPaidOn: null, shares: [], beforeSchedule: true });
        } else {
          out.errors.push({ field, message: `付款階段${label}此期已有獎金分潤／發獎金日，請先清除。` });
        }
      }
      continue;
    }
    const savedAmount = set ? set.billingAmount : row.amount;
    const limit = predicted?.has(key) ? (predicted.get(key) ?? null) : predicted && !row.id ? stageScreenAmount(row, draft.stageEdits[key]) : savedAmount;
    out.limits[key] = limit;
    if (!view.canEdit) continue;

    const edit: ShareEdit | undefined = draft.shareEdits?.[key];
    const lines = filledShareLines(currentShareLines(set, edit));
    const linesChanged = edit?.lines !== undefined && !sameShareLines(edit.lines, savedShareLines(set));
    const date = trimmed(currentBonusPaidOn(set, edit));
    const dateChanged = edit?.bonusPaidOn !== undefined && date !== (set?.bonusPaidOn ?? "");
    const amountChanged = !!row.id && (limit === null ? savedAmount !== null : savedAmount === null || cents(limit) !== cents(savedAmount));
    if (!linesChanged && !dateChanged) {
      // 分潤沒改、但這次存檔會讓該期金額變（含被尾差影響）：已存的分潤超過新金額 → 擋存（有分潤權限的人）。
      const total = set?.total ?? 0;
      if (amountChanged && sharesOverLimit(total, limit)) {
        out.errors.push({
          field,
          message:
            limit === null
              ? `付款階段${label}存檔後沒有金額，但已設定獎金分潤 ${formatMoney(total)}：請先清除分潤。`
              : `付款階段${label}存檔後金額為 ${formatMoney(limit)}，已設定的獎金分潤合計 ${formatMoney(total)} 超過本期金額，請先調整分潤。`,
        });
      }
      continue;
    }
    out.changes += (linesChanged ? 1 : 0) + (dateChanged ? 1 : 0);

    const shares: SharePlanItem["shares"] = [];
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      const n = parseShareAmount(l.amount);
      const id = l.employeeId.trim().toLowerCase();
      if (!id) out.errors.push({ field, message: `付款階段${label}獎金分潤第 ${i + 1} 位沒有選員工。` });
      else if (seen.has(id)) out.errors.push({ field, message: `付款階段${label}獎金分潤同一位員工重複。` });
      if (n === "invalid" || n === null) out.errors.push({ field, message: `付款階段${label}獎金分潤第 ${i + 1} 位的金額必須是 0 以上的數字（最多小數 2 位）。` });
      seen.add(id);
      if (id && typeof n === "number") shares.push({ employeeId: l.employeeId, amount: n });
    });
    const total = shareLinesTotal(lines);
    if (sharesOverLimit(total, limit)) {
      out.errors.push({
        field,
        message:
          limit === null
            ? `付款階段${label}還沒有金額，不能設定獎金分潤。`
            : `付款階段${label}獎金分潤合計 ${formatMoney(total)} 超過該期金額 ${formatMoney(limit)}${amountChanged ? "（存檔後的金額，含尾差）" : ""}。`,
      });
    }
    if (date && !dateRe.test(date)) out.errors.push({ field: `stage:${key}:bonusPaidOn`, message: `付款階段${label}的發獎金日格式不對。` });
    if (!row.id && !createdKeys.has(key)) {
      out.errors.push({ field, message: `付款階段${label}還沒有這一期：請先填項目說明或金額，再設定獎金分潤。` });
    }
    out.items.push({ key, label, billingId: row.id, bonusPaidOn: date || null, shares });
  }
  return out;
}

/* ========================================================== 總計畫 == */

export interface SheetSavePlan {
  project: UpdateProjectExtBody | null;
  client: { id: string; name: string; body: Partial<Record<ClientSheetField, string | null>> } | null;
  contract: ContractStep | null;
  stages: StagePlan;
  subcontracts: Subcontract[] | null;
  /** 移除既有副委託時的理由（PUT deleteReason）；沒移除＝null。 */
  subDeleteReason: string | null;
  /** 每期款獎金分潤（2026-11-11）。 */
  shares: SharePlan;
  /** 未儲存的格子數（存檔鈕旁、離開頁面提醒）。 */
  dirtyCount: number;
  errors: SheetError[];
  warnings: string[];
}

export function applicationSheetPlan(ctx: SheetSaveContext, draft: ApplicationSheetDraft): SheetSavePlan {
  const projectPatch = applicationSheetPatch(ctx.project, draft, { disciplines: ctx.disciplines, canFinance: ctx.canFinance });
  const projectCount = Object.keys(projectPatch).length;
  const canEditClient = ctx.canFinance && ctx.canEditClient !== false;
  const clientBody = canEditClient ? clientSheetPatch(ctx.client, draft.clientEdits) : null;
  const contract = contractPlan(ctx, draft);
  const stages = stagePlan(ctx, draft);
  const subs = subcontractPlan(ctx, draft);
  const shares = sharePlan(ctx, draft, stages);
  const errors = [...contract.errors, ...stages.errors, ...subs.errors, ...shares.errors];
  const taxId = draft.clientEdits.taxId;
  if (canEditClient && ctx.client && taxId !== undefined && trimmed(taxId) !== "" && !/^\d{8}$/.test(trimmed(taxId))) {
    errors.push({ field: "taxId", message: "統一編號須為 8 碼數字。" });
  }
  return {
    project: projectCount > 0 ? projectPatch : null,
    client: clientBody && ctx.client ? { id: ctx.client.id, name: ctx.client.name, body: clientBody } : null,
    contract: contract.step,
    stages,
    subcontracts: subs.subcontracts,
    subDeleteReason: subs.deleteReason,
    shares,
    dirtyCount:
      projectCount + (clientBody ? Object.keys(clientBody).length : 0) + contract.changes + stages.changes + subs.changes + shares.changes,
    errors,
    warnings: [...stages.warnings, ...subs.warnings],
  };
}

/* ========================================================== 執行 == */

export type SheetSaveSection = "project" | "client" | "contract" | "billings" | "invoice" | "receipt" | "subcontracts" | "shares";

export interface SheetSaveStep {
  section: SheetSaveSection;
  /** 給人看的「哪一部分」。 */
  label: string;
  /** warning＝已送出、但有部分內容沒寫進去（例如期別在讀取後被刪除，row_gone）：黃色提示，不算失敗也不算全部成功。 */
  status: "ok" | "failed" | "skipped" | "warning";
  message?: string;
}

export interface SheetSaveApi {
  updateProject(body: UpdateProjectExtBody): Promise<unknown>;
  /** 回存檔提示（例如統編與其他客戶相同）；沒有回 null。 */
  updateClient(id: string, body: Partial<Record<ClientSheetField, string | null>>): Promise<string | null>;
  upsertMainContract(body: { amount: number }): Promise<unknown>;
  updateContract(id: string, body: { amount: number | null }): Promise<unknown>;
  createQuotation(body: { amount: number | null }): Promise<unknown>;
  saveBillingSchedule(
    installments: InstallmentInputExt[],
  ): Promise<{ installments: Array<{ id: string; installmentNo: number; kind?: string | null }>; warnings?: ReadonlyArray<BillingScheduleWarning> }>;
  invoiceBilling(id: string, invoiceNo: string, invoicedOn?: string): Promise<unknown>;
  receiveBilling(id: string, receivedOn: string): Promise<unknown>;
  /** deleteReason：這次有移除既有副委託（payload 沒帶到的列）時必帶。 */
  putSubcontracts(subcontracts: Subcontract[], deleteReason?: string): Promise<unknown>;
  /**
   * 整批 PUT 前重抓最新清單（選填）：用最新資料重建 payload 再套上這次的修改，
   * 免得頁面開了很久、別人剛新增的期別被當成「不在清單裡」軟刪除，或剛改的欄位被舊值蓋回。
   */
  fetchBillings?(): Promise<BillingExt[]>;
  fetchSubcontracts?(): Promise<Subcontract[]>;
  /** 每期款獎金分潤（只換掉有帶到的期別）；省略＝不送（分潤修改留在草稿）。 */
  saveBillingShares?(billings: BillingShareSetInput[]): Promise<unknown>;
  humanize(section: SheetSaveSection, err: unknown): string;
}

export interface SheetSaveResult {
  steps: SheetSaveStep[];
  notices: string[];
  /** 存完剩下的草稿：已存成的格子拿掉、沒存成的留著（新建期別的發票／入帳改掛到新 id 上）。 */
  residual: ApplicationSheetDraft;
}

function withoutKeys<T extends object>(obj: T, keys: Array<keyof T>): T {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/** 後端 409 billing_has_bonus_shares（API 預檢或 DB 觸發器）：apiFetch 的 message 是 `[409] billing_has_bonus_shares`。 */
export function isBonusSharesConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return !!e && (e.code === "billing_has_bonus_shares" || (typeof e.message === "string" && e.message.includes("billing_has_bonus_shares")));
}

/** 期程 PUT 有期別在讀取後被刪除（warnings 帶 row_gone；可能整個專案已刪除）時給使用者的提示（2026-11-12）。 */
export const BILLING_ROW_GONE_NOTICE = "部分期別已被刪除（或專案已刪除），沒有儲存，請重新整理";

/** 期程卡存檔後要顯示的提示（update_failed 與 row_gone 可能同時發生，兩個都要）。 */
export function billingSaveNotices(warnings: ReadonlyArray<BillingScheduleWarning> | undefined): string[] {
  const out: string[] = [];
  if (billingUpdateFailedIds(warnings).size > 0) out.push(BILLING_UPDATE_FAILED_NOTICE);
  if (hasBillingRowGone(warnings)) out.push(BILLING_ROW_GONE_NOTICE);
  return out;
}

/** warnings 裡有沒有 row_gone。 */
export function hasBillingRowGone(warnings: ReadonlyArray<BillingScheduleWarning> | undefined): boolean {
  return (warnings ?? []).some((w) => typeof w !== "string" && w.code === "row_gone");
}

/** 期程 PUT 有期別寫入失敗（warnings 帶 update_failed）時給使用者的提示。 */
export const BILLING_UPDATE_FAILED_NOTICE = "部分期別未儲存成功，請重試";

/**
 * 期程 PUT 回的 warnings 裡「這一期寫入失敗」（code: update_failed；後端其他期照存）→ 期別 id（小寫）。
 * 這些期別的草稿不能清掉，要留著讓使用者重試。
 */
export function billingUpdateFailedIds(warnings: ReadonlyArray<BillingScheduleWarning> | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of warnings ?? []) {
    if (typeof w === "string" || w.code !== "update_failed" || !w.billingId) continue;
    out.add(w.billingId.toLowerCase());
  }
  return out;
}

/**
 * 期程卡（BillingsCard）存檔後：重新載入的草稿 `fresh` 裡，寫入失敗（`failed`，小寫 id）的期別換回剛才送出的那一列，
 * 其他期別用最新資料。失敗的期別若已不在最新資料裡（例如軟刪除失敗）就不補回。
 */
export function keepFailedBillingDraftRows<T extends { id?: string | null }>(
  fresh: readonly T[],
  sent: readonly T[],
  failed: ReadonlySet<string>,
): T[] {
  if (failed.size === 0) return [...fresh];
  const sentById = new Map(sent.filter((r) => r.id).map((r) => [String(r.id).toLowerCase(), r]));
  return fresh.map((row) => {
    const id = row.id ? row.id.toLowerCase() : null;
    if (!id || !failed.has(id)) return row;
    return sentById.get(id) ?? row;
  });
}

/**
 * 期程 PUT 回的 warnings 裡「某期分潤超過新的期別金額」（只提示，不擋會計改金額）→ 黃色提示文字。
 * 期別用申請單上的稱呼（一般期別依期別編號排第 N 列；代墊款＝技師公會代墊），不帶任何分潤內容。
 */
export function shareExceedNotices(
  warnings: ReadonlyArray<BillingScheduleWarning> | undefined,
  installments: ReadonlyArray<{ id: string; installmentNo: number; kind?: string | null }>,
): string[] {
  const out: string[] = [];
  const ordered = installments.filter((i) => i.kind !== "guild_advance").sort((a, b) => a.installmentNo - b.installmentNo);
  for (const w of warnings ?? []) {
    if (typeof w === "string" || w.code !== "shares_exceed_amount") continue;
    const id = w.billingId.toLowerCase();
    const hit = installments.find((i) => i.id.toLowerCase() === id);
    const idx = ordered.findIndex((i) => i.id.toLowerCase() === id);
    const label = hit?.kind === "guild_advance" ? "技師公會代墊" : idx >= 0 ? `第 ${idx + 1} 列` : "某一期";
    out.push(`付款階段${label}的獎金分潤超過本期金額（期別金額已變小），請老闆調整分潤。`);
  }
  return out;
}

/**
 * 依序存：專案欄位 → 客戶名冊 → 合約（金額會牽動期程試算，所以排在期程前）→ 請款期程 → 開票 → 入帳 → 副委託。
 * 每一步各自 try：失敗記下來、不中斷其他來源；只有「依賴前一步」的（新建期別的開票／入帳、
 * 期程沒存成時的開票／入帳）標成未送出。已存成的不會在下一次儲存重送（residual 已拿掉、且重新載入後跟新資料比對）。
 */
export async function runApplicationSheetSave(
  plan: SheetSavePlan,
  draft: ApplicationSheetDraft,
  api: SheetSaveApi,
  ctx?: SheetSaveContext,
): Promise<SheetSaveResult> {
  const steps: SheetSaveStep[] = [];
  const notices: string[] = [];
  let residual: ApplicationSheetDraft = { ...draft, stageEdits: { ...draft.stageEdits } };

  async function attempt(section: SheetSaveSection, label: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      steps.push({ section, label, status: "ok" });
      return true;
    } catch (err) {
      steps.push({ section, label, status: "failed", message: api.humanize(section, err) });
      return false;
    }
  }

  if (plan.project) {
    const body = plan.project;
    await attempt("project", "申請單欄位", () => api.updateProject(body).then(() => undefined));
  }

  if (plan.client) {
    const { id, name, body } = plan.client;
    const ok = await attempt("client", `客戶名冊「${name}」`, async () => {
      const notice = await api.updateClient(id, body);
      if (notice) notices.push(notice);
    });
    if (ok) residual = { ...residual, clientEdits: {} };
  }

  /** 銷售金額（合約）沒存成時，同次的開票／入帳不送：入帳金額取當下應收，會用舊合約算錯（驗收 2026-10-27）。 */
  let contractOk = true;
  if (plan.contract) {
    const step = plan.contract;
    const label =
      step.kind === "main" ? (step.created ? "訂單（建立合約書）／銷售金額" : "銷售金額（主合約）") : step.kind === "quotation-create" ? "訂單（建立報價單）" : "銷售金額（報價單）";
    const ok = await attempt("contract", label, async () => {
      if (step.kind === "main") await api.upsertMainContract({ amount: step.amount });
      else if (step.kind === "quotation-update") await api.updateContract(step.id, { amount: step.amount });
      else await api.createQuotation({ amount: step.amount });
    });
    if (ok) residual = { ...residual, orderDocType: "", amountUntaxed: null };
    contractOk = ok;
  }

  let stages = plan.stages;
  if (stages.installments && plan.contract && !contractOk) {
    // 合約金額沒存成：期別 % 依新總額換算，送出會讓金額錯位 → 付款階段整段不送（發票／入帳同樣跳過）。
    steps.push({ section: "billings", label: "付款階段（項目說明／金額／%）", status: "skipped", message: "銷售金額沒存成，付款階段未送出（避免依舊金額換算）。" });
    stages = { ...stages, installments: null, created: [] };
  }
  if (stages.installments && ctx && api.fetchBillings) {
    try {
      const fresh = await api.fetchBillings();
      // 以「存檔前畫面上的金額」為準重新規劃（合約金額已先存成新值時，重抓的期程金額已依新總額變動）。
      const replanned = stagePlan({ ...ctx, billings: fresh }, pinStageScreenAmounts(ctx, draft));
      if (replanned.errors.length > 0) throw new Error(replanned.errors.map((e) => e.message).join(" "));
      notices.push(...replanned.warnings);
      stages = replanned;
    } catch (err) {
      steps.push({ section: "billings", label: "付款階段（重抓最新期程）", status: "failed", message: api.humanize("billings", err) });
      stages = { ...stages, installments: null, invoices: [], receipts: [], created: [] };
      for (const inv of plan.stages.invoices) steps.push({ section: "invoice", label: `付款階段${inv.label}發票號碼`, status: "skipped", message: "付款階段沒存成，這格未送出。" });
      for (const rc of plan.stages.receipts) steps.push({ section: "receipt", label: `付款階段${rc.label}入帳日期`, status: "skipped", message: "付款階段沒存成，這格未送出。" });
    }
  }
  // 要刪的期別若已有獎金分潤：草稿已清空的，先送分潤清除、再送期程（刪期別）；清除沒成功 → 期程不送（後端也會 409）。
  const removedNow = new Set(stages.removed.map((r) => r.key));
  const preClear = stages.installments ? (plan.shares?.items ?? []).filter((i) => i.beforeSchedule && i.billingId && removedNow.has(i.key)) : [];
  if (preClear.length > 0) {
    const save = api.saveBillingShares;
    const ok = save
      ? await attempt("shares", "付款階段（先清除要刪期別的獎金分潤／發獎金日）", () =>
          save(preClear.map((i) => ({ billingId: i.billingId!, bonusPaidOn: null, shares: [] }))).then(() => undefined),
        )
      : false;
    if (ok) {
      const next = { ...(residual.shareEdits ?? {}) };
      for (const i of preClear) delete next[i.key];
      residual = { ...residual, shareEdits: next };
    } else {
      steps.push({ section: "billings", label: "付款階段（項目說明／金額／%）", status: "skipped", message: "要刪的期別獎金分潤沒清除成功，付款階段未送出。" });
      stages = { ...stages, installments: null, created: [] };
    }
  }
  /** 草稿 key → 已存在的期別 id（既有列 key 就是 id；新建的存完才知道）。 */
  const idOf = new Map<string, string>();
  for (const key of Object.keys(draft.stageEdits)) if (!key.startsWith("new-")) idOf.set(key, key);
  let scheduleOk = true;
  /** 期程 PUT 回 update_failed 的期別（小寫 id）：草稿保留不清。 */
  let failedStageIds = new Set<string>();
  let rowGone = false;
  if (stages.installments) {
    const installments = stages.installments;
    const autoShells = stages.autoShells ?? [];
    scheduleOk = await attempt("billings", "付款階段（項目說明／百分比／金額）", async () => {
      let res: Awaited<ReturnType<SheetSaveApi["saveBillingSchedule"]>>;
      try {
        res = await api.saveBillingSchedule(installments);
      } catch (err) {
        // 自動移除的空殼上其實有獎金分潤（會計看不到分潤，不知道）：把空殼放回去重送一次——保留、不擋存。
        if (autoShells.length === 0 || !isBonusSharesConflict(err)) throw err;
        res = await api.saveBillingSchedule([...installments, ...autoShells].sort((a, b) => a.installmentNo - b.installmentNo));
        notices.push("付款階段有空白期別已設定獎金分潤或發獎金日，已保留未移除（要刪請老闆先移除分潤）。");
      }
      for (const c of stages.created) {
        const row = res.installments.find((i) => i.installmentNo === c.installmentNo);
        if (row) idOf.set(c.key, row.id);
      }
      notices.push(...shareExceedNotices(res.warnings, res.installments));
      failedStageIds = billingUpdateFailedIds(res.warnings);
      if (failedStageIds.size > 0) notices.push(BILLING_UPDATE_FAILED_NOTICE);
      rowGone = hasBillingRowGone(res.warnings);
    });
    if (scheduleOk && failedStageIds.size > 0) {
      // 有期別 update_failed：這一步不能標 ok（步驟狀態沒有「部分成功」→ 標 failed 並說明）。
      // scheduleOk 仍為 true——其餘期別確實存成了，下面的草稿清理（失敗那幾期保留）照舊。
      const idx = steps.map((s) => s.section).lastIndexOf("billings");
      if (idx >= 0 && steps[idx]!.status === "ok") steps[idx] = { ...steps[idx]!, status: "failed", message: BILLING_UPDATE_FAILED_NOTICE };
    }
    if (scheduleOk && rowGone) {
      // 有期別在讀取後被刪除（row_gone）：沒有 update_failed 時這一步標成警告（黃），不是 ok；兩者都有時 failed 優先、另附提示。
      const idx = steps.map((s) => s.section).lastIndexOf("billings");
      if (idx >= 0 && steps[idx]!.status === "ok") steps[idx] = { ...steps[idx]!, status: "warning", message: BILLING_ROW_GONE_NOTICE };
      else notices.push(BILLING_ROW_GONE_NOTICE);
    }
    if (scheduleOk) {
      const next: Record<string, StageEdit> = {};
      for (const [key, edit] of Object.entries(residual.stageEdits)) {
        // 後端說這一期沒寫成（update_failed）：整個草稿留著，下次儲存重送。
        if (failedStageIds.has((idOf.get(key) ?? key).toLowerCase())) {
          next[key] = edit;
          continue;
        }
        const rest = withoutKeys(edit, ["milestone", "percentage", "amount", "overrideReason", "note"]);
        if (Object.keys(rest).length === 0) continue;
        next[idOf.get(key) ?? key] = rest;
      }
      residual = { ...residual, stageEdits: next };
      // 分潤修改跟著換成新期別的 id（新建的空白列）。
      const nextShares: Record<string, ShareEdit> = {};
      for (const [key, edit] of Object.entries(residual.shareEdits ?? {})) nextShares[idOf.get(key) ?? key] = edit;
      residual = { ...residual, shareEdits: nextShares };
    }
  }

  const stageKeyNow = (key: string) => (scheduleOk ? (idOf.get(key) ?? key) : key);
  const dropStageField = (key: string, field: keyof StageEdit) => {
    const k = stageKeyNow(key);
    const edit = residual.stageEdits[k];
    if (!edit) return;
    const rest = withoutKeys(edit, [field]);
    const next = { ...residual.stageEdits };
    if (Object.keys(rest).length === 0) delete next[k];
    else next[k] = rest;
    residual = { ...residual, stageEdits: next };
  };

  for (const inv of stages.invoices) {
    const label = `付款階段${inv.label}發票號碼`;
    const id = scheduleOk ? idOf.get(inv.key) : undefined;
    if (!id) {
      steps.push({ section: "invoice", label, status: "skipped", message: "付款階段沒存成，這格未送出。" });
      continue;
    }
    if (!contractOk) {
      steps.push({ section: "invoice", label, status: "skipped", message: "銷售金額沒存成，這格未送出（避免用舊金額登記）。" });
      continue;
    }
    if (await attempt("invoice", label, () => api.invoiceBilling(id, inv.invoiceNo, inv.invoicedOn || undefined).then(() => undefined))) { dropStageField(inv.key, "invoiceNo"); dropStageField(inv.key, "invoicedOn"); }
  }
  for (const rc of stages.receipts) {
    const label = `付款階段${rc.label}入帳日期`;
    const id = scheduleOk ? idOf.get(rc.key) : undefined;
    if (!id) {
      steps.push({ section: "receipt", label, status: "skipped", message: "付款階段沒存成，這格未送出。" });
      continue;
    }
    if (!contractOk) {
      steps.push({ section: "receipt", label, status: "skipped", message: "銷售金額沒存成，這格未送出（避免用舊金額登記）。" });
      continue;
    }
    if (await attempt("receipt", label, () => api.receiveBilling(id, rc.receivedOn).then(() => undefined))) dropStageField(rc.key, "receivedOn");
  }

  const shareItems = (plan.shares?.items ?? []).filter((i) => !i.beforeSchedule);
  if (shareItems.length > 0) {
    const ready: Array<{ key: string; input: BillingShareSetInput }> = [];
    for (const item of shareItems) {
      const id = item.billingId ?? (scheduleOk ? idOf.get(item.key) : undefined);
      if (!id) {
        steps.push({ section: "shares", label: `付款階段${item.label}獎金分潤`, status: "skipped", message: "付款階段沒存成，這格未送出。" });
        continue;
      }
      ready.push({ key: item.key, input: { billingId: id, bonusPaidOn: item.bonusPaidOn, shares: item.shares } });
    }
    if (ready.length > 0 && api.saveBillingShares) {
      const save = api.saveBillingShares;
      const ok = await attempt("shares", "付款階段（獎金分潤／發獎金日）", () => save(ready.map((r) => r.input)).then(() => undefined));
      if (ok) {
        const next = { ...(residual.shareEdits ?? {}) };
        for (const r of ready) {
          delete next[r.key];
          delete next[r.input.billingId];
        }
        residual = { ...residual, shareEdits: next };
      }
    }
  }

  if (plan.subcontracts) {
    let subs = plan.subcontracts;
    let deleteReason = plan.subDeleteReason;
    /** 重抓後對不到的修改（空欄「new-<序號>」被別人剛新增的副委託佔走等）：不能當成已存。 */
    let orphanKeys: string[] = [];
    const ok = await attempt("subcontracts", "發包單位", async () => {
      if (ctx && api.fetchSubcontracts) {
        const replanned = subcontractPlan({ ...ctx, subcontracts: await api.fetchSubcontracts() }, draft);
        if (replanned.errors.length > 0) throw new Error(replanned.errors.map((e) => e.message).join(" "));
        orphanKeys = replanned.orphanKeys;
        if (!replanned.subcontracts) return; // 最新資料已跟草稿一致（或只剩對不到的修改），不必再送
        subs = replanned.subcontracts;
        deleteReason = replanned.deleteReason;
      }
      if (deleteReason) await api.putSubcontracts(subs, deleteReason);
      else await api.putSubcontracts(subs);
    });
    if (ok && orphanKeys.length > 0) {
      // 對得到的欄位已存；對不到的不送、草稿保留，這步改標失敗並說明原因（同付款階段：不默默吞掉）。
      const step = steps[steps.length - 1];
      steps[steps.length - 1] = {
        ...step,
        status: "failed",
        message: `有 ${orphanKeys.length} 列的修改對不到副委託（存檔前別人剛新增或移除了副委託，空列位置已變），這幾列沒有送出、草稿已保留；請看過最新的發包列表後按「還原」重填。`,
      };
      const kept: Record<string, SubEdit> = {};
      for (const key of orphanKeys) kept[key] = draft.subEdits[key];
      residual = { ...residual, subEdits: kept, subRemovedIds: [], subDeleteReason: "" };
    } else if (ok) {
      residual = { ...residual, subEdits: {}, subExtraRows: 0, subRemovedIds: [], subDeleteReason: "" };
    }
  }

  return { steps, notices, residual };
}

/* ===================================================== 存檔結果歸屬 == */

/** 存檔結果連同它屬於哪一案一起存：頁面換專案（例如複製為追加減後導到新案）時，上一案的結果不能顯示在新案上。 */
export interface ProjectScopedReport<T> {
  projectId: string;
  report: T;
}

/** 只回傳屬於目前這一案的存檔結果；別案的（或沒有）回 null。純函式。 */
export function reportForProject<T>(stored: ProjectScopedReport<T> | null, projectId: string): T | null {
  return stored && stored.projectId === projectId ? stored.report : null;
}
