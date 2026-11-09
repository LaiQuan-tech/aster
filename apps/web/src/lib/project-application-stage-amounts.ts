/**
 * 申請單「付款階段」金額依 % 預填（2026-11-09 業主：「% 決定後金額就要帶出來，之後還能改」）。
 *
 * 規則（與後端 billing-schedule.ts computeInstallments 同口徑，前端鏡像）：
 * - 一般分期：round(合約總額 × %)；尾差由最後一個「未請款且未人工指定」的期別吸收，合計＝合約總額。
 * - 已請款的期別金額凍結（以目前金額參與合計，不重算）；人工指定的期別以指定金額參與合計。
 * - 技師公會代墊不進尾差：round(合約總額 × %)。
 * - 沒有合約總額（只有報價單、還沒勾合約書）→ 後端不試算，這裡也不預填（回 null）。
 *
 * 草稿語意：stageEdits[key].amount
 * - undefined／""：跟著 % 走（畫面顯示試算值；"" 另表示「取消既有人工指定」）。
 * - 其他：使用者手打的金額；等於試算值時視同跟著 % 走（不算人工指定、不要理由）。
 */
import type { ApplicationStageRow, StageEdit } from "./project-application-sheet";
import { stageRowKey } from "./project-application-sheet";
import type { BillingExt } from "./projects-ext-api";

function parseAmount(value: string | undefined): number | null | "invalid" {
  if (value === undefined) return null;
  const t = value.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

/** 草稿裡這列的 %（沒改或打錯 → 用已存的 %）。 */
export function stageDraftPercentage(row: Pick<ApplicationStageRow, "percentage">, edit: StageEdit | undefined): number | null {
  if (edit?.percentage === undefined) return row.percentage;
  const p = parseAmount(edit.percentage);
  if (p === "invalid" || (p !== null && p > 100)) return row.percentage;
  return p;
}

/** 這列目前算不算「金額凍結」（已請款或已入帳；同 stageLocks.amount）。 */
function amountLocked(row: ApplicationStageRow): boolean {
  return row.billed || !!row.receivedOn;
}

/** 已存的人工指定金額（沒有＝null）。 */
export function savedOverrideOf(row: ApplicationStageRow, billings: readonly BillingExt[]): number | null {
  if (!row.id) return null;
  return billings.find((b) => b.id === row.id)?.overrideAmount ?? null;
}

/**
 * 這列「人工指定」的金額（參與別列尾差計算用）：草稿有打非空的值 → 那個值；草稿 "" → 取消指定；
 * 沒動 → 已存的人工指定金額。
 */
function manualAmountOf(row: ApplicationStageRow, edit: StageEdit | undefined, savedOverride: number | null): number | null {
  if (edit?.amount !== undefined) {
    const a = parseAmount(edit.amount);
    return a === "invalid" ? null : a;
  }
  return savedOverride;
}

interface ScheduleItem {
  key: string;
  percentage: number | null;
  /** 凍結金額（已請款）；null＝不凍結。 */
  frozen: number | null;
  override: number | null;
}

/** 前端鏡像 computeInstallments：回各列有效金額（null＝無法試算）。 */
function computeSchedule(items: readonly ScheduleItem[], total: number): Map<string, number | null> {
  const out = new Map<string, number | null>();
  let sum = 0;
  for (const it of items) {
    const v = it.frozen ?? (it.override !== null ? Math.round(it.override) : Math.round(total * ((it.percentage ?? 0) / 100)));
    out.set(it.key, v);
    sum += v;
  }
  const residue = Math.round(total - sum);
  if (residue !== 0) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.frozen === null && it.override === null) {
        out.set(it.key, (out.get(it.key) ?? 0) + residue);
        break;
      }
    }
  }
  return out;
}

/**
 * 每一列「依 % 試算」的金額（key → 金額；null＝不試算：沒有合約總額、空白列沒填 %、金額凍結）。
 * 算某一列時把該列當成「跟著 % 走」，其他列照草稿（人工指定的就以指定金額參與合計）。
 */
export function stageAutoAmounts(
  rows: readonly ApplicationStageRow[],
  billings: readonly BillingExt[],
  stageEdits: Readonly<Record<string, StageEdit>>,
  contractTotal: number | null,
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const installments = rows.filter((r) => r.kind === "installment");
  // 參與排程的一般分期：已存在的期別，或草稿這次填了 % 的空白列（存檔後會新增）。
  const scheduled = installments.filter((r) => r.exists || stageDraftPercentage(r, stageEdits[stageRowKey(r)]) !== null);
  const base: ScheduleItem[] = scheduled.map((r) => {
    const key = stageRowKey(r);
    const edit = stageEdits[key];
    return {
      key,
      percentage: stageDraftPercentage(r, edit),
      frozen: r.billed ? (r.amount ?? 0) : null,
      override: r.billed ? null : manualAmountOf(r, edit, savedOverrideOf(r, billings)),
    };
  });
  for (const r of rows) {
    const key = stageRowKey(r);
    const pct = stageDraftPercentage(r, stageEdits[key]);
    if (contractTotal === null || !Number.isFinite(contractTotal) || amountLocked(r) || pct === null) {
      result.set(key, null);
      continue;
    }
    if (r.kind === "guild_advance") {
      result.set(key, Math.round(contractTotal * (pct / 100)));
      continue;
    }
    const items = base.map((it) => (it.key === key ? { ...it, override: null } : it));
    result.set(key, computeSchedule(items, contractTotal).get(key) ?? null);
  }
  return result;
}

export interface StageAmountView {
  /** 依 % 試算的金額（null＝不試算）。 */
  auto: number | null;
  /** 金額格要顯示的值（純數字字串，MoneyInput 會加千分位）。 */
  display: string;
  /** 人工指定（金額與 % 試算不同）：存檔要理由。 */
  manual: boolean;
}

/** 金額格的顯示與狀態。 */
export function stageAmountView(row: ApplicationStageRow, edit: StageEdit | undefined, savedOverride: number | null, auto: number | null): StageAmountView {
  const savedText = row.amount != null ? String(row.amount) : "";
  if (amountLocked(row)) return { auto: null, display: savedText, manual: false };
  if (edit?.amount !== undefined && edit.amount.trim() !== "") {
    const a = parseAmount(edit.amount);
    return { auto, display: edit.amount, manual: a === "invalid" || auto === null || a !== auto };
  }
  if (edit?.amount === undefined && savedOverride !== null) {
    return { auto, display: savedText, manual: auto === null || savedOverride !== auto };
  }
  return { auto, display: auto !== null ? String(auto) : edit?.amount === "" ? "" : savedText, manual: false };
}

/**
 * 使用者改了某列的 %：% 是主要輸入，金額一律改回「跟著 % 走」（草稿金額設成 ""，
 * 既有人工指定在存檔時取消）。回傳新的 stageEdits，以及「原本是人工指定、被重算覆蓋」的旗標（畫面提示用）。
 */
export function applyStagePercentageEdit(
  stageEdits: Readonly<Record<string, StageEdit>>,
  row: ApplicationStageRow,
  percentage: string,
  savedOverride: number | null,
  autoBefore: number | null,
): { stageEdits: Record<string, StageEdit>; recalculated: boolean } {
  const key = stageRowKey(row);
  const edit = stageEdits[key] ?? {};
  const next: StageEdit = { ...edit, percentage };
  let recalculated = false;
  if (!amountLocked(row)) {
    const view = stageAmountView(row, edit, savedOverride, autoBefore);
    recalculated = view.manual && view.display.trim() !== "";
    if (edit.amount !== undefined || savedOverride !== null) next.amount = "";
    if (recalculated) delete next.overrideReason;
  }
  return { stageEdits: { ...stageEdits, [key]: next }, recalculated };
}

/**
 * 未稅（合約總額）要變動前呼叫：草稿裡手打但「剛好等於目前試算值」的金額改回跟著 % 走（""），
 * 未稅變了才會跟著重算；真正人工指定（與試算不同）的金額保留。
 */
export function releaseAutoEqualAmounts(
  stageEdits: Readonly<Record<string, StageEdit>>,
  autosBefore: ReadonlyMap<string, number | null>,
): Record<string, StageEdit> {
  const next: Record<string, StageEdit> = { ...stageEdits };
  for (const [key, edit] of Object.entries(stageEdits)) {
    if (edit.amount === undefined || edit.amount.trim() === "") continue;
    const a = parseAmount(edit.amount);
    const auto = autosBefore.get(key) ?? null;
    if (a !== "invalid" && a !== null && auto !== null && a === auto) next[key] = { ...edit, amount: "" };
  }
  return next;
}
