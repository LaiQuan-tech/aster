/**
 * 申請單「付款階段」：金額是主要輸入、% 由金額算出（2026-11-09 業主）。
 *
 * 後端期程（billing-schedule.ts computeInstallments）仍以 % 為主：有效金額＝round(合約總額 × %)，
 * 尾差由最後一個「未請款、未人工指定」的一般期別吸收；人工指定金額（override_amount）必須附理由。
 * 不改 API 的做法：存檔時把使用者輸入的金額換成「剛好算回同一個金額」的 %（6～10 位小數），
 * 後端算出的金額就等於使用者輸入的金額，不必走人工指定、也不用理由。
 * 例外：
 * - 沒有合約總額（只有報價單、還沒勾合約書）→ 後端不試算，金額只能走人工指定（沿用理由規則）。
 * - 各期金額合計 ≠ 合約總額 → 後端會把差額加到最後一期（畫面提示）。
 *
 * 草稿語意：stageEdits[key].amount＝使用者輸入的金額；stageEdits[key].percentage＝使用者在 % 格輸入的值
 * （此時 amount 會同步換算好；之後改金額會清掉 percentage，讓 % 回到由金額算出）。
 */
import type { ApplicationStageRow, StageEdit } from "./project-application-sheet";
import type { BillingExt } from "./projects-ext-api";

/** 字串 → 0 以上的數字；空白＝null；不是數字＝"invalid"。可含逗號。 */
export function parseStageNumber(value: string | undefined | null): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  const t = value.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

/** % 顯示：小數 2 位、尾數 0 省略（5、14.29）。null＝空白。 */
export function formatStagePct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "";
  return String(Math.round(pct * 100) / 100);
}

/** 依 % 算金額（同後端：四捨五入到元）。 */
export function amountFromPct(pct: number, total: number): number {
  return Math.round(total * (pct / 100));
}

/**
 * 金額 → 存檔用的 %：至少 6 位小數（各期 % 合計才會剛好 100，下方期程卡的「合計不是 100%」不會誤報），
 * 必要時加到 10 位，讓 round(總額 × % ÷ 100) 剛好等於金額。總額不是正數＝null（無法換算）。
 */
export function pctFromAmount(amount: number, total: number | null): number | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  const exact = (amount / total) * 100;
  for (let d = 6; d <= 10; d++) {
    const f = 10 ** d;
    const p = Math.round(exact * f) / f;
    if (amountFromPct(p, total) === Math.round(amount)) return p;
  }
  return Math.round(exact * 1e10) / 1e10;
}

/** 已存的人工指定金額（沒有＝null）。 */
export function savedOverrideOf(row: Pick<ApplicationStageRow, "id">, billings: readonly BillingExt[]): number | null {
  if (!row.id) return null;
  return billings.find((b) => b.id === row.id)?.overrideAmount ?? null;
}

/** 這列金額凍結（已請款或已入帳；同 stageLocks.amount）。 */
function amountLocked(row: Pick<ApplicationStageRow, "billed" | "receivedOn">): boolean {
  return row.billed || !!row.receivedOn;
}

/** 金額格顯示的值（純數字字串，MoneyInput 加千分位）。 */
export function stageAmountDisplay(row: ApplicationStageRow, edit: StageEdit | undefined): string {
  if (!amountLocked(row) && edit?.amount !== undefined) return edit.amount;
  return row.amount != null ? String(row.amount) : "";
}

/**
 * % 格顯示的值：使用者正在 % 格輸入 → 原樣；否則＝金額 ÷ 總額（2 位小數）；沒有總額 → 已存的 %。
 * 金額凍結的列也照金額 ÷ 總額顯示（帳上的實際比例）。
 */
export function stagePctDisplay(row: ApplicationStageRow, edit: StageEdit | undefined, total: number | null): string {
  if (edit?.percentage !== undefined) return edit.percentage;
  const amount = parseStageNumber(stageAmountDisplay(row, edit));
  if (total !== null && total > 0) {
    if (amount === null) return edit?.amount !== undefined ? "" : formatStagePct(row.percentage);
    if (amount !== "invalid") return formatStagePct((amount / total) * 100);
  }
  return formatStagePct(row.percentage);
}

/** 使用者改了金額：記下金額、% 回到由金額算出。 */
export function applyStageAmountEdit(edit: StageEdit | undefined, amount: string): StageEdit {
  const next: StageEdit = { ...(edit ?? {}), amount };
  delete next.percentage;
  return next;
}

/** 使用者改了 %：記下 %，有總額時同步反算金額（以金額為準存檔）。 */
export function applyStagePctEdit(row: ApplicationStageRow, edit: StageEdit | undefined, pct: string, total: number | null): StageEdit {
  const next: StageEdit = { ...(edit ?? {}), percentage: pct };
  if (amountLocked(row) || total === null || total <= 0) return next;
  const p = parseStageNumber(pct);
  if (p === null) next.amount = "";
  else if (p !== "invalid" && p <= 100) next.amount = String(amountFromPct(p, total));
  return next;
}

/** 未稅（合約總額）要變動前呼叫：% 格的輸入改回由金額算出（金額不動，% 依新總額重算）。 */
export function releaseTypedPercentages(stageEdits: Readonly<Record<string, StageEdit>>): Record<string, StageEdit> {
  const next: Record<string, StageEdit> = {};
  for (const [key, edit] of Object.entries(stageEdits)) {
    if (edit.percentage !== undefined && edit.amount !== undefined) {
      const { percentage: _typed, ...rest } = edit;
      next[key] = rest;
    } else next[key] = edit;
  }
  return next;
}

export interface StageScheduleSummary {
  /** 一般分期金額合計（技師公會代墊不算，同後端尾差口徑）。 */
  amountTotal: number;
  /** 一般分期 % 合計（2 位小數）。 */
  pctTotal: number;
  /** 合約總額 − 金額合計（≠0 時後端把差額加到最後一期）。總額未知＝null。 */
  diff: number | null;
}

/** 付款階段合計（提示「合計不等於未稅／不是 100%」用）。 */
export function stageScheduleSummary(
  rows: readonly ApplicationStageRow[],
  stageEdits: Readonly<Record<string, StageEdit>>,
  keyOf: (row: ApplicationStageRow) => string,
  total: number | null,
): StageScheduleSummary {
  let amountTotal = 0;
  for (const r of rows) {
    if (r.kind !== "installment") continue;
    const a = parseStageNumber(stageAmountDisplay(r, stageEdits[keyOf(r)]));
    if (typeof a === "number") amountTotal += Math.round(a);
  }
  const pctTotal = total !== null && total > 0 ? Math.round((amountTotal / total) * 10000) / 100 : 0;
  return { amountTotal, pctTotal, diff: total !== null ? Math.round(total - amountTotal) : null };
}
