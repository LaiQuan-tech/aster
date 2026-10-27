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
 *
 * 權限一律交給後端既有檢查（前端只在 canFinance=false 時整張唯讀），這裡不放寬任何東西。
 *
 * ⚠️ vitest 沒設 `@/` 別名：只能用相對路徑。
 */
import { isOurContract, type Contract } from "./projects-api";
import type {
  BillingExt,
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
  applicationSubcontractSlots,
  latestOrderDocument,
  stageRowKey,
  type ApplicationSheetDraft,
  type ApplicationStageRow,
  type ClientSheetField,
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
export function contractPlan(ctx: SheetSaveContext, draft: ApplicationSheetDraft): { step: ContractStep | null; changes: number; errors: string[] } {
  const errors: string[] = [];
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
    errors.push("銷售金額（未稅）必須是 0 以上的數字。");
    return { step: null, changes: 0, errors };
  }
  const amountChanged = draft.amountUntaxed !== null && parsed !== base;
  const changes = (pending ? 1 : 0) + (amountChanged ? 1 : 0);
  if (changes === 0) return { step: null, changes, errors };

  const changeOrders = changeOrderTotal(ctx.contracts);
  const toMain = (amount: number | null, created: boolean): ContractStep | null => {
    if (amount === null) {
      errors.push(created ? "勾選「合約書」要一併填銷售金額（未稅）。" : "合約金額不能清空（要作廢合約請到下方「合約與報價單」）。");
      return null;
    }
    const main = amount - changeOrders;
    if (main < 0) {
      errors.push(`銷售金額（未稅）不能小於追加減帳合計 ${changeOrders.toLocaleString()}。`);
      return null;
    }
    return { kind: "main", amount: main, created };
  };

  let step: ContractStep | null = null;
  if (pending === "contract") step = toMain(parsed, true);
  else if (source === "contract") step = toMain(parsed, false);
  else if (orderDoc?.docType === "quotation") step = { kind: "quotation-update", id: orderDoc.id, amount: parsed };
  else if (pending === "quotation") step = { kind: "quotation-create", amount: parsed };
  else errors.push("本案還沒有合約或報價單：請先在「訂單」格勾選合約書或報價單，再填銷售金額。");
  return { step, changes, errors };
}

/* ======================================================== 付款階段 == */

interface StageBase {
  milestone: string;
  percentage: string;
  amount: string;
  receivedOn: string;
  invoiceNo: string;
}

export function stageBaseValues(row: ApplicationStageRow): StageBase {
  return {
    milestone: row.milestone,
    percentage: row.percentage != null ? String(row.percentage) : "",
    amount: row.amount != null ? String(row.amount) : "",
    receivedOn: row.receivedOn ?? "",
    invoiceNo: row.invoiceNo ?? "",
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
  };
}

export interface StagePlan {
  /** PUT /billings 的整批內容（含所有既有期別）；說明／%／金額都沒變＝null。 */
  installments: InstallmentInputExt[] | null;
  /** 新增的期別：草稿 key → 期別編號（存完用編號找回新 id）。 */
  created: Array<{ key: string; installmentNo: number; label: string }>;
  invoices: Array<{ key: string; label: string; invoiceNo: string }>;
  receipts: Array<{ key: string; label: string; receivedOn: string }>;
  /** 改了金額、要使用者填人工指定理由的列（沒有既有理由可沿用）。 */
  needsReason: Array<{ key: string; label: string }>;
  changes: number;
  errors: string[];
  /** 草稿裡對不到任何列的修改（那一列已被別處新增／移除）：不送出，提醒使用者。 */
  warnings: string[];
}

function stageLabel(row: ApplicationStageRow): string {
  return row.kind === "guild_advance" ? "技師公會代墊" : `第 ${row.no} 列`;
}

export function stagePlan(ctx: SheetSaveContext, draft: ApplicationSheetDraft): StagePlan {
  const out: StagePlan = { installments: null, created: [], invoices: [], receipts: [], needsReason: [], changes: 0, errors: [], warnings: [] };
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
    if (!edit) continue;
    const base = stageBaseValues(row);
    const locks = stageLocks(row);
    const label = stageLabel(row);

    const milestoneChanged = edit.milestone !== undefined && trimmed(edit.milestone) !== trimmed(base.milestone);
    let percentage: number | null | undefined;
    if (edit.percentage !== undefined && !locks.percentage) {
      const p = parseNumber(edit.percentage, { min: 0, max: 100 });
      if (p === "invalid") out.errors.push(`付款階段${label}的百分比必須是 0～100 的數字。`);
      else if (p !== row.percentage) percentage = p;
    }
    let amount: number | null | undefined;
    if (edit.amount !== undefined && !locks.amount) {
      const a = parseNumber(edit.amount, { min: 0 });
      if (a === "invalid") out.errors.push(`付款階段${label}的金額必須是 0 以上的數字。`);
      else if (a !== row.amount) amount = a;
    }
    const receivedOn = !locks.receivedOn && edit.receivedOn !== undefined ? trimmed(edit.receivedOn) : "";
    const invoiceNo = !locks.invoiceNo && edit.invoiceNo !== undefined ? trimmed(edit.invoiceNo) : "";
    if (receivedOn && !dateRe.test(receivedOn)) out.errors.push(`付款階段${label}的入帳日期格式不對。`);
    if (invoiceNo.length > 40) out.errors.push(`付款階段${label}的發票號碼最多 40 字。`);

    const rowScheduleChanges = (milestoneChanged ? 1 : 0) + (percentage !== undefined ? 1 : 0) + (amount !== undefined ? 1 : 0);
    out.changes += rowScheduleChanges + (receivedOn ? 1 : 0) + (invoiceNo ? 1 : 0);

    // 人工指定金額要理由（後端 override_reason_required）：沿用既有理由，否則要使用者自己填，不代填。
    let overrideReason: string | null = null;
    if (amount != null) {
      overrideReason = trimmed(edit.overrideReason) || row.overrideReason || "";
      if (!overrideReason) {
        out.needsReason.push({ key, label });
        out.errors.push(`付款階段${label}改了金額（人工指定），請填理由。`);
      }
    }

    // 入帳要算得出金額（後端 amount_unknown）：這列存完後要有金額或百分比。
    const amountAfter = amount !== undefined ? amount : row.amount;
    const pctAfter = percentage !== undefined ? percentage : row.percentage;
    if (receivedOn && amountAfter == null && pctAfter == null) {
      out.errors.push(`付款階段${label}要先有金額或百分比，才能登記入帳日期。`);
    }

    if (row.id) {
      if (rowScheduleChanges === 0) {
        if (receivedOn && dateRe.test(receivedOn)) out.receipts.push({ key, label, receivedOn });
        if (invoiceNo) out.invoices.push({ key, label, invoiceNo });
        continue;
      }
      const target = payload.find((p) => p.id === row.id);
      const saved = byId.get(row.id);
      if (!target || !saved) continue;
      scheduleChanged = true;
      if (milestoneChanged) target.milestone = textOrNull(edit.milestone);
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
        milestone: milestoneChanged ? textOrNull(edit.milestone) : row.kind === "guild_advance" ? row.milestone : null,
        plannedOn: null,
        overrideAmount: amount ?? null,
        overrideReason: amount != null ? overrideReason : null,
        note: null,
      });
      out.created.push({ key, installmentNo, label });
    }
    if (receivedOn && dateRe.test(receivedOn)) out.receipts.push({ key, label, receivedOn });
    if (invoiceNo) out.invoices.push({ key, label, invoiceNo });
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
  errors: string[];
  warnings: string[];
  /** 草稿裡對不到任何欄位的 subEdits key（空欄已被別人新增的副委託佔走，或那筆已被移除）。 */
  orphanKeys: string[];
}

export function subcontractPlan(ctx: SheetSaveContext, draft: ApplicationSheetDraft): SubPlan {
  const out: SubPlan = { subcontracts: null, changes: 0, errors: [], warnings: [], orphanKeys: [] };
  if (!ctx.canFinance) return out;
  const slots = applicationSubcontractSlots(ctx.subcontracts, draft.subExtraBlocks, draft.subEdits).flat();
  const slotKeys = new Set(slots.map((sl) => sl.key));
  out.orphanKeys = Object.entries(draft.subEdits)
    .filter(([key, edit]) => !slotKeys.has(key) && Object.values(edit).some((v) => trimmed(v) !== ""))
    .map(([key]) => key);
  const orphanCount = out.orphanKeys.length;
  if (orphanCount > 0) {
    out.warnings.push(`發包單位有 ${orphanCount} 欄的修改對不到副委託（已在別處新增或移除），不會送出；請按「還原」後重填。`);
  }
  const payload = ctx.subcontracts.map(subPayloadOf);
  let nextSort = ctx.subcontracts.reduce((m, s, i) => Math.max(m, s.sortOrder ?? i), -1) + 1;
  let changed = false;
  slots.forEach((slot, idx) => {
    const edit: SubEdit | undefined = draft.subEdits[slot.key];
    if (!edit) return;
    const diff: Partial<Record<(typeof SUB_FIELDS)[number], string>> = {};
    for (const f of SUB_FIELDS) {
      const v = edit[f];
      if (v === undefined) continue;
      if (f === "amount") {
        const n = parseNumber(v, { min: 0, max: 1e12 });
        if (n === "invalid") {
          out.errors.push(`發包單位第 ${idx + 1} 欄的發包金額必須是 0 以上的數字。`);
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

/* ========================================================== 總計畫 == */

export interface SheetSavePlan {
  project: UpdateProjectExtBody | null;
  client: { id: string; name: string; body: Partial<Record<ClientSheetField, string | null>> } | null;
  contract: ContractStep | null;
  stages: StagePlan;
  subcontracts: Subcontract[] | null;
  /** 未儲存的格子數（存檔鈕旁、離開頁面提醒）。 */
  dirtyCount: number;
  errors: string[];
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
  const errors = [...contract.errors, ...stages.errors, ...subs.errors];
  const taxId = draft.clientEdits.taxId;
  if (canEditClient && ctx.client && taxId !== undefined && trimmed(taxId) !== "" && !/^\d{8}$/.test(trimmed(taxId))) {
    errors.push("統一編號須為 8 碼數字。");
  }
  return {
    project: projectCount > 0 ? projectPatch : null,
    client: clientBody && ctx.client ? { id: ctx.client.id, name: ctx.client.name, body: clientBody } : null,
    contract: contract.step,
    stages,
    subcontracts: subs.subcontracts,
    dirtyCount:
      projectCount + (clientBody ? Object.keys(clientBody).length : 0) + contract.changes + stages.changes + subs.changes,
    errors,
    warnings: [...stages.warnings, ...subs.warnings],
  };
}

/* ========================================================== 執行 == */

export type SheetSaveSection = "project" | "client" | "contract" | "billings" | "invoice" | "receipt" | "subcontracts";

export interface SheetSaveStep {
  section: SheetSaveSection;
  /** 給人看的「哪一部分」。 */
  label: string;
  status: "ok" | "failed" | "skipped";
  message?: string;
}

export interface SheetSaveApi {
  updateProject(body: UpdateProjectExtBody): Promise<unknown>;
  /** 回存檔提示（例如統編與其他客戶相同）；沒有回 null。 */
  updateClient(id: string, body: Partial<Record<ClientSheetField, string | null>>): Promise<string | null>;
  upsertMainContract(body: { amount: number }): Promise<unknown>;
  updateContract(id: string, body: { amount: number | null }): Promise<unknown>;
  createQuotation(body: { amount: number | null }): Promise<unknown>;
  saveBillingSchedule(installments: InstallmentInputExt[]): Promise<{ installments: Array<{ id: string; installmentNo: number }> }>;
  invoiceBilling(id: string, invoiceNo: string): Promise<unknown>;
  receiveBilling(id: string, receivedOn: string): Promise<unknown>;
  putSubcontracts(subcontracts: Subcontract[]): Promise<unknown>;
  /**
   * 整批 PUT 前重抓最新清單（選填）：用最新資料重建 payload 再套上這次的修改，
   * 免得頁面開了很久、別人剛新增的期別被當成「不在清單裡」軟刪除，或剛改的欄位被舊值蓋回。
   */
  fetchBillings?(): Promise<BillingExt[]>;
  fetchSubcontracts?(): Promise<Subcontract[]>;
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
  }

  let stages = plan.stages;
  if (stages.installments && ctx && api.fetchBillings) {
    try {
      const fresh = await api.fetchBillings();
      const replanned = stagePlan({ ...ctx, billings: fresh }, draft);
      if (replanned.errors.length > 0) throw new Error(replanned.errors.join(" "));
      notices.push(...replanned.warnings);
      stages = replanned;
    } catch (err) {
      steps.push({ section: "billings", label: "付款階段（重抓最新期程）", status: "failed", message: api.humanize("billings", err) });
      stages = { ...stages, installments: null, invoices: [], receipts: [], created: [] };
      for (const inv of plan.stages.invoices) steps.push({ section: "invoice", label: `付款階段${inv.label}發票號碼`, status: "skipped", message: "付款階段沒存成，這格未送出。" });
      for (const rc of plan.stages.receipts) steps.push({ section: "receipt", label: `付款階段${rc.label}入帳日期`, status: "skipped", message: "付款階段沒存成，這格未送出。" });
    }
  }
  /** 草稿 key → 已存在的期別 id（既有列 key 就是 id；新建的存完才知道）。 */
  const idOf = new Map<string, string>();
  for (const key of Object.keys(draft.stageEdits)) if (!key.startsWith("new-")) idOf.set(key, key);
  let scheduleOk = true;
  if (stages.installments) {
    const installments = stages.installments;
    scheduleOk = await attempt("billings", "付款階段（項目說明／百分比／金額）", async () => {
      const res = await api.saveBillingSchedule(installments);
      for (const c of stages.created) {
        const row = res.installments.find((i) => i.installmentNo === c.installmentNo);
        if (row) idOf.set(c.key, row.id);
      }
    });
    if (scheduleOk) {
      const next: Record<string, StageEdit> = {};
      for (const [key, edit] of Object.entries(residual.stageEdits)) {
        const rest = withoutKeys(edit, ["milestone", "percentage", "amount", "overrideReason"]);
        if (Object.keys(rest).length === 0) continue;
        next[idOf.get(key) ?? key] = rest;
      }
      residual = { ...residual, stageEdits: next };
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
    if (await attempt("invoice", label, () => api.invoiceBilling(id, inv.invoiceNo).then(() => undefined))) dropStageField(inv.key, "invoiceNo");
  }
  for (const rc of stages.receipts) {
    const label = `付款階段${rc.label}入帳日期`;
    const id = scheduleOk ? idOf.get(rc.key) : undefined;
    if (!id) {
      steps.push({ section: "receipt", label, status: "skipped", message: "付款階段沒存成，這格未送出。" });
      continue;
    }
    if (await attempt("receipt", label, () => api.receiveBilling(id, rc.receivedOn).then(() => undefined))) dropStageField(rc.key, "receivedOn");
  }

  if (plan.subcontracts) {
    let subs = plan.subcontracts;
    /** 重抓後對不到的修改（空欄「new-<序號>」被別人剛新增的副委託佔走等）：不能當成已存。 */
    let orphanKeys: string[] = [];
    const ok = await attempt("subcontracts", "發包單位", async () => {
      if (ctx && api.fetchSubcontracts) {
        const replanned = subcontractPlan({ ...ctx, subcontracts: await api.fetchSubcontracts() }, draft);
        if (replanned.errors.length > 0) throw new Error(replanned.errors.join(" "));
        orphanKeys = replanned.orphanKeys;
        if (!replanned.subcontracts) return; // 最新資料已跟草稿一致（或只剩對不到的修改），不必再送
        subs = replanned.subcontracts;
      }
      await api.putSubcontracts(subs);
    });
    if (ok && orphanKeys.length > 0) {
      // 對得到的欄位已存；對不到的不送、草稿保留，這步改標失敗並說明原因（同付款階段：不默默吞掉）。
      const step = steps[steps.length - 1];
      steps[steps.length - 1] = {
        ...step,
        status: "failed",
        message: `有 ${orphanKeys.length} 欄的修改對不到副委託（存檔前別人剛新增或移除了副委託，空欄位置已變），這幾欄沒有送出、草稿已保留；請看過最新的發包單位後按「還原」重填。`,
      };
      const kept: Record<string, SubEdit> = {};
      for (const key of orphanKeys) kept[key] = draft.subEdits[key];
      residual = { ...residual, subEdits: kept };
    } else if (ok) {
      residual = { ...residual, subEdits: {}, subExtraBlocks: 0 };
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
