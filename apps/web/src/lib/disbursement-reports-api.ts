/**
 * B3：放款年度 × 廠商／付款公司／專案樞紐的 typed API 呼叫。
 * 後端見 apps/api/src/routes/disbursement-reports.ts。刻意獨立成新檔（樣板抄
 * disbursements-api.ts），不改後者。
 */
import { apiFetch, apiDownload } from "./api-client"

export const DISBURSEMENT_PIVOT_GROUP_BYS = ["vendor", "company", "project"] as const
export type DisbursementPivotGroupBy = (typeof DISBURSEMENT_PIVOT_GROUP_BYS)[number]

export interface DisbursementPivotRow {
  key: string
  label: string
  /** index 0 = 1月 … 11 = 12月。 */
  months: number[]
  total: number
  withheld: number
  count: number
  /** M16：已取得發票／收據的匯款筆數（舊版 API 沒有這欄，讀取要 optional）。 */
  invoicedCount?: number
  /** M16：沒發票也沒收據編號的金額合計。 */
  noReceiptAmount?: number
}

export interface DisbursementPivotTotals {
  months: number[]
  total: number
  withheld: number
  count: number
  invoicedCount?: number
  noReceiptAmount?: number
}

export interface DisbursementPivotResult {
  year: number
  groupBy: DisbursementPivotGroupBy
  rows: DisbursementPivotRow[]
  totals: DisbursementPivotTotals
}

// A `type` alias (not `interface`) so it structurally satisfies buildQuery's
// `Record<string, ...>` parameter without needing an explicit index signature
// (same gotcha noted in disbursements-api.ts's DisbursementListParams).
export type DisbursementPivotParams = {
  year?: number
  groupBy?: DisbursementPivotGroupBy
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `?${s}` : ""
}

/** GET /disbursements/pivot?year=&groupBy=；year 省略時後端取租戶當地今年。 */
export function getDisbursementPivot(params: DisbursementPivotParams = {}) {
  return apiFetch<DisbursementPivotResult>(`/disbursements/pivot${buildQuery(params)}`)
}

/** 跟 getDisbursementPivot 共用同一組參數，匯出的列數／欄位會跟畫面上看到的一致。 */
export function exportDisbursementPivotXlsx(params: DisbursementPivotParams = {}, filename = "放款年度樞紐.xlsx") {
  return apiDownload(`/disbursements/pivot.xlsx${buildQuery(params)}`, filename)
}

export const DISBURSEMENT_PIVOT_GROUP_BY_LABELS: Record<DisbursementPivotGroupBy, string> = {
  vendor: "廠商",
  company: "付款公司",
  project: "專案",
}
