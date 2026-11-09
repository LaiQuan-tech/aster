import type { Subcontract, SubcontractKind } from "./projects-ext-api"

/**
 * 專案頁「副委託與協力技師」卡：類型（含 2026-11-10 新增的「事務所」）與代扣提醒的純邏輯。
 *
 * - 類型＝事務所（firm）：顯示「代扣率%」「代扣日期」「起扣門檻」；不顯示發票。
 * - 其他類型（下包工程、技師簽證費）：顯示「發票號碼」「發票日期」；不顯示代扣欄。
 * - 提醒（只對事務所；不擋存）：金額 > 20,000 且代扣率 0 → 請確認是否需代扣 10%；
 *   金額 ≥ 20,000 → 提醒二代健保補充保費 2.11%。
 */

export const SUBCONTRACT_KIND_OPTIONS: ReadonlyArray<{ value: SubcontractKind; label: string }> = [
  { value: "subcontract", label: "下包工程" },
  { value: "technician", label: "技師簽證費" },
  { value: "firm", label: "事務所" },
]

export function subcontractKindLabel(kind: string | null | undefined): string {
  return SUBCONTRACT_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? "下包工程"
}

export function isFirmKind(kind: string | null | undefined): boolean {
  return kind === "firm"
}

/** 執行業務所得：單次給付「超過」此金額才扣 10% 所得稅（剛好 20,000 免扣）。 */
export const WITHHOLDING_TAX_THRESHOLD = 20000
/** 二代健保補充保費：單次給付「達」此金額即扣 2.11%。 */
export const SUPPLEMENTARY_PREMIUM_THRESHOLD = 20000
export const DEFAULT_FIRM_WITHHOLDING_RATE = 0.1

export const WITHHOLDING_TIP =
  "執行業務所得單次給付超過 20,000 元需代扣 10% 所得稅（剛好 20,000 元免扣，因稅額未超過 2,000 元）；達 20,000 元以上另需代扣二代健保補充保費 2.11%。"
export const THRESHOLD_TIP =
  "起扣門檻：每期金額「超過」此數才依代扣率算代扣（預設 20,000，與上方所得稅規則一致；剛好等於門檻不扣）。"

export interface WithholdingHints {
  /** 金額 > 20,000 而代扣率為 0：請確認是否需代扣 10%。 */
  confirmWithholding: boolean
  /** 金額 ≥ 20,000：另需代扣二代健保補充保費 2.11%。 */
  supplementaryPremium: boolean
}

export function withholdingHints(row: Pick<Subcontract, "kind" | "amount" | "withholdingRate">): WithholdingHints {
  if (!isFirmKind(row.kind)) return { confirmWithholding: false, supplementaryPremium: false }
  const amount = Number(row.amount) || 0
  const rate = Number(row.withholdingRate) || 0
  return {
    confirmWithholding: amount > WITHHOLDING_TAX_THRESHOLD && rate === 0,
    supplementaryPremium: amount >= SUPPLEMENTARY_PREMIUM_THRESHOLD,
  }
}

/**
 * 切換類型時要一起改的欄位：不相關的那一組清成 null（後端也會再清一次）。
 * 改成事務所且代扣率是 0 → 帶預設 10%；從事務所改成其他類型 → 代扣率歸 0（開發票不代扣）。
 */
export function kindChangePatch(
  row: Pick<Subcontract, "kind" | "withholdingRate">,
  next: SubcontractKind,
): Partial<Subcontract> {
  if (next === row.kind) return {}
  if (isFirmKind(next)) {
    return {
      kind: next,
      invoiceNo: null,
      invoiceDate: null,
      ...((Number(row.withholdingRate) || 0) === 0 ? { withholdingRate: DEFAULT_FIRM_WITHHOLDING_RATE } : {}),
    }
  }
  return {
    kind: next,
    withholdingDate: null,
    ...(isFirmKind(row.kind) ? { withholdingRate: 0 } : {}),
  }
}

/** 存檔 payload 裡 0089 三欄：依類型只送相關那組，另一組送 null。 */
export function subcontractExtraPayload(
  row: Pick<Subcontract, "kind" | "withholdingDate" | "invoiceNo" | "invoiceDate">,
): Pick<Subcontract, "withholdingDate" | "invoiceNo" | "invoiceDate"> {
  if (isFirmKind(row.kind)) {
    return { withholdingDate: row.withholdingDate || null, invoiceNo: null, invoiceDate: null }
  }
  return { withholdingDate: null, invoiceNo: row.invoiceNo?.trim() || null, invoiceDate: row.invoiceDate || null }
}
