"use client";

import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Button, PrimaryButton } from "@/components/admin-ui";
import { ClientCombo } from "@/components/ClientCombo";
import type { Vendor } from "@/lib/company-api";
import { companyOptions } from "@/lib/company-options";
import type { Contract } from "@/lib/projects-api";
import {
  COMMON_DISCIPLINES,
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  disciplineLabel,
  humanizeProjectExtError,
  listClients,
  updateProjectFields,
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
  applicationSheetDraftOf,
  applicationSheetErrors,
  applicationSheetPatch,
  applicationStageRows,
  applicationSubcontractBlocks,
  designScopeText,
  latestOrderDocument,
  orderDocumentCells,
  rocDateParts,
  rocDots,
  SHEET_FIELD_PRINT_BLOCK,
  type ApplicationSheetDraft,
  type PrintBlockKey,
  type SheetField,
} from "@/lib/project-application-sheet";

import { selectedCompanyId } from "../../_components/project-application-form";
import { fmtMoney } from "./shared";

/** Word 原檔的淺藍底（shd DAEEF3）。 */
const SHADE = "#DAEEF3";
/** Word 原檔字型是標楷體；沒有就退回系統楷體／襯線。 */
const SHEET_FONT = '"DFKai-SB", "BiauKai", "標楷體", "Kaiti TC", "STKaiti", serif';
const GRID_TEMPLATE = APPLICATION_SHEET_COLUMNS.map((w) => `minmax(0, ${w}fr)`).join(" ");

/** 格子內的輸入框：平常像表格文字，滑過／聚焦才顯示框線。 */
const cellInput =
  "w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-[13px] text-gray-900 hover:border-gray-300 focus:border-[var(--brand)] focus:bg-white focus:outline-none";

type CellKind = "label" | "value" | "full";

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
}) {
  const style = {
    "--gc": `${col} / span ${span}`,
    "--gr": `${row} / span ${rowSpan}`,
    backgroundColor: shade ? SHADE : undefined,
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
}

/**
 * 專案明細頁上半部：版面照公司 Word「專案申請單」（抬頭、專案明細表、付款階段、發包單位），
 * 欄位直接在格子內編輯，按「儲存申請單」只送有變的欄位（lib/project-application-sheet.ts）。
 * 銷售金額、付款階段、發包單位是由合約／請款期程／副委託帶入的唯讀格，在下方各卡片維護。
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
}: ApplicationSheetProps) {
  const print = mode === "print";
  const [localDraft, setLocalDraft] = useState<ApplicationSheetDraft>(() => applicationSheetDraftOf(project, disciplines));
  const draft = controlledDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;
  const [clients, setClients] = useState<Client[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = canFinance && !print;
  const blockOn = (key: PrintBlockKey) => printChecked?.[key] ?? true;
  /** 未勾選的列印區塊：螢幕淡化、列印時文字透明（格線與標題照印）。 */
  const blankCls = (key: PrintBlockKey) => (blockOn(key) ? "" : "opacity-40 print:opacity-100 print:text-transparent print:**:text-transparent");

  useEffect(() => {
    if (print) return;
    listClients().then((r) => setClients(r.clients)).catch(() => {});
  }, [print]);

  const patchOpts = { disciplines, canFinance };
  const patch = useMemo(() => applicationSheetPatch(project, draft, patchOpts), [project, draft, disciplines, canFinance]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirtyCount = Object.keys(patch).length;
  const validation = applicationSheetErrors(draft, { canFinance });

  const set = <K extends keyof ApplicationSheetDraft>(key: K, value: ApplicationSheetDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function save() {
    if (validation.length > 0 || dirtyCount === 0) return;
    setSaving(true);
    setError(null);
    try {
      await updateProjectFields(project.id, patch);
      await load?.();
    } catch (err) {
      setError(humanizeProjectExtError(err, "儲存申請單失敗"));
    } finally {
      setSaving(false);
    }
  }

  // 客戶資料格：草稿裡選的客戶（還沒存也即時顯示它的名冊資料）。
  const client: Client | null =
    clients.find((c) => c.id === draft.clientId) ?? (draft.clientId && draft.clientId === project.clientId ? project.client : null);
  // 名冊讀不到（或還沒載入）時至少放進本案目前的客戶，免得客戶名稱格看起來是空的。
  const clientChoices = project.client && !clients.some((c) => c.id === project.client?.id) ? [project.client, ...clients] : clients;
  const orderDoc = latestDocument !== undefined ? latestDocument : latestOrderDocument(contracts);
  const stageRows = applicationStageRows(billings);
  const subBlocks = applicationSubcontractBlocks(subcontracts);
  const companyChoices = companyOptions(companies, draft.companyId, { markDefault: true });
  const companyLabel =
    companyChoices.find((c) => c.id === selectedCompanyId(draft.companyId, companies))?.label ?? project.companyName ?? "";
  const engineerKeys = Object.keys(draft.engineers).filter(
    (k) => disciplines.includes(k) || draft.engineers[k]?.vendorId || draft.engineers[k]?.name,
  );
  const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));
  const opened = rocDateParts(draft.openedOn);
  const moneyText = (n: number | null | undefined) => (canFinance && money ? fmtMoney(n) : "—");

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
            <ClientCombo clients={clientChoices} clientId={draft.clientId || null} onChange={(id) => set("clientId", id ?? "")} />
          </div>
        ) : (client?.name ?? "—");
      case "clientPhone":
        return client?.phone || "";
      case "invoiceAddress":
        return client?.invoiceAddress || "";
      case "orderDocument":
        return (
          <span className="flex flex-wrap gap-x-2" data-testid="sheet-order-document">
            {orderDocumentCells(orderDoc).map((c) => (
              <span key={c.label}>{c.checked ? "■" : "□"}{c.label}{c.date ? ` ${c.date}` : ""}</span>
            ))}
          </span>
        );
      case "clientContact":
        return [client?.contactName, client?.contactPhone].filter(Boolean).join(" ");
      case "clientFax":
        return client?.fax || "";
      case "clientTaxId":
        return client?.taxId || "";
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
        return moneyText(money?.amountUntaxed);
      case "taxAmount":
        return moneyText(money?.taxAmount);
      case "amountTotal":
        return moneyText(money?.amountTotal);
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
          <Cell key={key} col={start} span={cell.span} row={r + 1} rowSpan={cell.rowSpan} kind="value" align={numericFields.has(cell.field) ? "right" : "left"} testId={`sheet-${cell.field}`} className={blankCls(SHEET_FIELD_PRINT_BLOCK[cell.field])}>
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
    cells.push(
      <Cell key={`stage-${s.no}-0`} col={stageCols[0]} span={APPLICATION_STAGE_SPANS[0]} row={r} kind="label" shade testId={`sheet-stage-${s.no}`}>
        {`${s.no}.${s.milestone}`}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-1`} col={stageCols[1]} span={APPLICATION_STAGE_SPANS[1]} row={r} kind="value" align="center">
        {s.percentage != null ? `${s.percentage}%` : ""}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-2`} col={stageCols[2]} span={APPLICATION_STAGE_SPANS[2]} row={r} kind="value" align="right">
        {s.amount != null ? fmtMoney(s.amount) : ""}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-3`} col={stageCols[3]} span={APPLICATION_STAGE_SPANS[3]} row={r} kind="value">
        <span className="whitespace-pre">已於 {s.receivedOn ? rocDots(s.receivedOn) : "         "} 入賬</span>
      </Cell>,
      <Cell key={`stage-${s.no}-4`} col={stageCols[4]} span={APPLICATION_STAGE_SPANS[4]} row={r} kind="label" shade align="center">
        {guild ? "審迄還款:" : "發票號碼:"}
      </Cell>,
      <Cell className={blankCls("payment")} key={`stage-${s.no}-5`} col={stageCols[5]} span={APPLICATION_STAGE_SPANS[5]} row={r} kind="value">
        {guild ? "" : [s.invoiceNo, rocDots(s.invoicedOn)].filter(Boolean).join(" ")}
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
  subBlocks.forEach((block, b) => {
    APPLICATION_SUBCONTRACT_LABELS.forEach((label, i) => {
      const r = row++;
      const valueOf = (s: Subcontract | null): ReactNode => {
        if (!s) return "";
        if (i === 0) return s.vendorName || "";
        if (i === 1) return s.contact || "";
        if (i === 2) return s.item || "";
        if (i === 3) return fmtMoney(s.amount);
        return s.billingBasis || "";
      };
      cells.push(
        <Cell key={`sub-${b}-${i}-l`} col={subCols[0]} span={APPLICATION_SUBCONTRACT_SPANS[0]} row={r} kind="label" shade align="center">
          {label}
        </Cell>,
      );
      block.forEach((s, j) =>
        cells.push(
          <Cell className={blankCls("subcontract")} key={`sub-${b}-${i}-${j}`} col={subCols[1 + j]} span={APPLICATION_SUBCONTRACT_SPANS[1 + j]} row={r} kind="value" align={i === 3 ? "right" : "center"}>
            {valueOf(s)}
          </Cell>,
        ),
      );
      cells.push(
        <Cell key={`sub-${b}-${i}-sl`} col={subCols[4]} span={APPLICATION_SUBCONTRACT_SPANS[4]} row={r} kind="label" shade align="right">
          {b === 0 ? APPLICATION_SUMMARY_LABELS[i] : ""}
        </Cell>,
        <Cell className={blankCls("subcontract")} key={`sub-${b}-${i}-sv`} col={subCols[5]} span={APPLICATION_SUBCONTRACT_SPANS[5]} row={r} kind="value" align="right" testId={b === 0 && i === 1 ? "sheet-other-expenses" : undefined}>
          {b === 0 ? summaryValues[i] : ""}
        </Cell>,
      );
    });
  });

  return (
    <section aria-label="專案申請單" className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-5 print:rounded-none print:border-0 print:p-0 print:shadow-none" data-testid="application-sheet">
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
                <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(applicationSheetDraftOf(project, disciplines))}>還原</Button>
              </>
            ) : (
              <span className="text-sm text-gray-400">沒有未儲存的變更</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">唯讀：修改申請單需要本案的財務權限（HR／會計／本案經理、主辦／部門主管）。</p>
        )}
        {validation.length > 0 && editable && (
          <ul className="text-sm text-red-600">{validation.map((m) => <li key={m}>{m}</li>)}</ul>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <p className="text-xs text-gray-400">
          銷售金額由下方<a href="#project-contracts" className="underline">合約與報價單</a>帶入；付款階段在<a href="#project-billings" className="underline">分期請款期程</a>維護；發包單位在<a href="#project-subcontracts" className="underline">副委託與協力技師</a>維護。
          客戶的電話、發票地址、採購承辦、傳真、統一編號屬<a href="/admin/clients" className="underline">客戶名冊</a>，改名冊後所有專案一起更新。
        </p>
      </div>
      )}

      {/* 未儲存提醒：捲到下方其他卡片時也看得到（下方卡片存檔重新載入不會清掉草稿，但要提醒還沒存）。 */}
      {editable && dirtyCount > 0 && (
        <div role="status" className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-amber-200 bg-amber-50/95 px-4 py-2 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] backdrop-blur" data-testid="sheet-unsaved-bar">
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
