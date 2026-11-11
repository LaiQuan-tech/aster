/**
 * 專案申請單「每期款獎金分潤」的純資料層（2026-11-11，API routes/billing-shares.ts，migration 0091）。
 *
 * 付款階段每一期多兩欄：「獎金分潤」（誰分多少，可多人；每人填金額、旁邊自動顯示佔該期金額的 %）與「發獎金日」。
 * 這是**按期另外發**的紀錄，獨立於季獎金（專案分潤% × 累計入帳、季發），不寫入月結薪資或季獎金批次。
 * 只有看得到分潤＋毛利的人（access.billingShares）看得到這兩欄；能改的人（access.editBillingShares）才能編輯。
 *
 * ⚠️ vitest 沒設 `@/` 別名：只能用相對路徑、且只 import 型別或不依賴 `@/` 的模組。
 */
import { formatMoney } from "./money";
import type { BillingShareSet, BillingSharesState } from "./projects-ext-api";

/** 分潤編輯中的一列（字串保存，輸入中途不轉型）。 */
export interface ShareLine {
  employeeId: string;
  amount: string;
}

/** 付款階段一列的分潤修改（草稿疊加層；key 同 stageRowKey）。 */
export interface ShareEdit {
  /** 整份分潤名單（有動過才有；undefined＝沿用已存的）。 */
  lines?: ShareLine[];
  /** 發獎金日 'YYYY-MM-DD'；"" ＝清掉。undefined＝沿用已存的。 */
  bonusPaidOn?: string;
}

/** 申請單上分潤兩欄的資料來源；null＝看不到（無權限、migration 未套用或讀取失敗）＝不畫兩欄。 */
export type BillingSharesView = BillingSharesState | null;

export function shareSetOf(view: BillingSharesView, billingId: string | null): BillingShareSet | null {
  if (!view || !billingId) return null;
  const id = billingId.toLowerCase();
  return view.billings.find((b) => b.billingId.toLowerCase() === id) ?? null;
}

/** 已存的分潤 → 編輯列。 */
export function savedShareLines(set: BillingShareSet | null): ShareLine[] {
  return (set?.shares ?? []).map((s) => ({ employeeId: s.employeeId, amount: String(s.amount) }));
}

/** 畫面上目前的分潤列（有改用草稿，沒改用已存）。 */
export function currentShareLines(set: BillingShareSet | null, edit: ShareEdit | undefined): ShareLine[] {
  return edit?.lines ?? savedShareLines(set);
}

/** 畫面上目前的發獎金日。 */
export function currentBonusPaidOn(set: BillingShareSet | null, edit: ShareEdit | undefined): string {
  return edit?.bonusPaidOn ?? set?.bonusPaidOn ?? "";
}

/**
 * 金額最多到「分」（小數 2 位）：同後端 zod（routes/billing-shares.ts amountSchema）的判準——
 * 數字轉回字串後不是「整數或小數 1～2 位」就不收（0.001、1e-7 都擋）。
 */
export function hasAtMostTwoDecimals(n: number): boolean {
  return /^\d+(\.\d{1,2})?$/.test(String(n));
}

/** "" → null；不是 0 以上、最多小數 2 位的數字 → "invalid"。可含千分位逗號。 */
export function parseShareAmount(value: string): number | null | "invalid" {
  const t = value.trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && hasAtMostTwoDecimals(n) ? n : "invalid";
}

/** 金額轉整數「分」（合計逐筆轉分再加，同後端 toCents，避免 0.1+0.2 這類浮點誤差）。 */
export function shareCents(n: number): number {
  return Math.round(n * 100);
}

/** 完全空白的列（沒選人也沒填金額）不算數、不送出。 */
export function filledShareLines(lines: readonly ShareLine[]): ShareLine[] {
  return lines.filter((l) => l.employeeId.trim() !== "" || l.amount.trim() !== "");
}

/** 合計（無效金額當 0）：逐筆轉成「分」再加、最後除回元（同後端 validateBillingShares／loadBillingShares）。 */
export function shareLinesTotal(lines: readonly ShareLine[]): number {
  const cents = lines.reduce((sum, l) => {
    const n = parseShareAmount(l.amount);
    return sum + (typeof n === "number" ? shareCents(n) : 0);
  }, 0);
  return cents / 100;
}

/** % ＝分潤金額 ÷ 該期金額（小數 2 位，去掉多餘的 0）；該期沒有金額或金額不合法 → ""。 */
export function sharePctText(amount: string | number, stageAmount: number | null): string {
  const n = typeof amount === "number" ? amount : parseShareAmount(amount);
  if (typeof n !== "number" || stageAmount === null || !(stageAmount > 0)) return "";
  const pct = Math.round((n / stageAmount) * 10000) / 100;
  return `${pct}%`;
}

/** 表格格子的摘要：「3 人 · 45,000」；沒有分潤＝""。 */
export function shareSummaryText(lines: readonly ShareLine[]): string {
  const filled = filledShareLines(lines);
  if (filled.length === 0) return "";
  return `${filled.length} 人 · ${formatMoney(shareLinesTotal(filled))}`;
}

/** 兩份分潤名單是否相同（比對送出用的正規化結果：員工＋金額，順序有意義）。 */
export function sameShareLines(a: readonly ShareLine[], b: readonly ShareLine[]): boolean {
  const norm = (lines: readonly ShareLine[]) =>
    filledShareLines(lines).map((l) => {
      const n = parseShareAmount(l.amount);
      return `${l.employeeId.trim().toLowerCase()}=${typeof n === "number" ? n : l.amount.trim()}`;
    });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
