import { roundMoney, type SerializedDisbursement } from "./disbursements.js"

/**
 * B3：放款年度 × 廠商／付款公司／專案樞紐——純函式，不連 DB（方便單元測試，見
 * __tests__/disbursement-pivot.test.ts）。查表／分頁／xlsx 都在
 * routes/disbursement-reports.ts、lib/xlsx/disbursement-pivot.ts，這裡只做
 * 「一批已經序列化好的匯款單 → 依月份分欄聚合」。
 *
 * 呼叫端的分工（同 summarizeDisbursements 的慣例：「只算 status='paid' 的列，
 * 呼叫端先過濾」）：routes/disbursement-reports.ts 應該只傳「這個租戶、這個
 * 年度、status='paid'」的列進來（草稿還沒真的付錢、作廢已經反向沖銷，年底
 * 報稅要看的是「真的給出去多少」——跟老闆卡 buildSummary 的口徑一致）。這裡仍
 * 對 status==='void'、年份不符、沒有 paidOn 的列防呆略過，不假設呼叫端一定
 * 濾乾淨。
 *
 * 金額口徑：
 *   groupBy='vendor'｜'company' → 用 amount（實付淨額）／withheldAmount（該筆代扣）。
 *   groupBy='project'          → 用每筆 allocation.amount（毛額，含代扣）／
 *     withheldAmount（該分攤列代扣）按 projectId 拆；一筆分攤兩個專案就拆兩份、
 *     完全沒有分攤列的整筆（payeeKind='other' 常見，例如印刷、快遞）歸「未指定
 *     專案」，用該筆 disbursement 的 grossAmount／withheldAmount（沒有分攤列可拆）。
 */

export const DISBURSEMENT_PIVOT_GROUP_BYS = ["vendor", "company", "project"] as const
export type DisbursementPivotGroupBy = (typeof DISBURSEMENT_PIVOT_GROUP_BYS)[number]

export type DisbursementPivotRow = {
  key: string
  label: string
  /** index 0 = 1月 … 11 = 12月。 */
  months: number[]
  total: number
  withheld: number
  count: number
}

export type DisbursementPivotTotals = {
  months: number[]
  total: number
  withheld: number
  count: number
}

export type DisbursementPivotResult = {
  year: number
  groupBy: DisbursementPivotGroupBy
  rows: DisbursementPivotRow[]
  totals: DisbursementPivotTotals
}

/** project 分組、沒有任何分攤列的整筆匯款歸這一格。 */
export const UNASSIGNED_PROJECT_KEY = "__unassigned__"
export const UNASSIGNED_PROJECT_LABEL = "未指定專案"

function emptyMonths(): number[] {
  return new Array(12).fill(0) as number[]
}

/**
 * `paidOn` 是 'YYYY-MM-DD' 字串（租戶當地日期，見 lib/tz.ts）——直接切字串取
 * 年／月，不建 `Date` 物件，避開時區把邊界日推到隔月／隔年的問題。
 */
function yearOf(paidOn: string | null): number | null {
  if (!paidOn || paidOn.length < 4) return null
  const y = Number(paidOn.slice(0, 4))
  return Number.isInteger(y) ? y : null
}

function monthIndexOf(paidOn: string | null): number | null {
  if (!paidOn || paidOn.length < 7) return null
  const m = Number(paidOn.slice(5, 7))
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m - 1 : null
}

type Bucket = { label: string; months: number[]; total: number; withheld: number; count: number }

function newBucket(label: string): Bucket {
  return { label, months: emptyMonths(), total: 0, withheld: 0, count: 0 }
}

/** 累加一筆金額到桶子裡；每次加完就 roundMoney，避免累加多筆後浮點誤差變大
 * （同 summarizeDisbursements 的 `c.total = roundMoney(c.total + r.amount)` 慣例）。 */
function add(b: Bucket, monthIndex: number, amount: number, withheld: number): void {
  b.months[monthIndex] = roundMoney(b.months[monthIndex] + amount)
  b.total = roundMoney(b.total + amount)
  b.withheld = roundMoney(b.withheld + withheld)
  b.count += 1
}

export function pivotDisbursements(
  rows: SerializedDisbursement[],
  opts: { groupBy: DisbursementPivotGroupBy; year: number },
): DisbursementPivotResult {
  const { groupBy, year } = opts
  const buckets = new Map<string, Bucket>()
  const totals = newBucket("合計")

  for (const d of rows) {
    if (d.status === "void") continue
    if (yearOf(d.paidOn) !== year) continue
    const mi = monthIndexOf(d.paidOn)
    if (mi === null) continue

    if (groupBy === "project") {
      if (d.allocations.length === 0) {
        const b = buckets.get(UNASSIGNED_PROJECT_KEY) ?? newBucket(UNASSIGNED_PROJECT_LABEL)
        add(b, mi, d.grossAmount, d.withheldAmount)
        buckets.set(UNASSIGNED_PROJECT_KEY, b)
        add(totals, mi, d.grossAmount, d.withheldAmount)
        continue
      }
      for (const a of d.allocations) {
        const label = a.projectCode ? `${a.projectCode} ${a.projectName}` : a.projectName || a.projectId
        const b = buckets.get(a.projectId) ?? newBucket(label)
        add(b, mi, a.amount, a.withheldAmount)
        buckets.set(a.projectId, b)
        add(totals, mi, a.amount, a.withheldAmount)
      }
      continue
    }

    const key = groupBy === "vendor" ? (d.vendorId ?? `other:${d.payeeName}`) : d.payingCompanyId
    const label = groupBy === "vendor" ? d.payeeName : (d.payingCompanyName ?? "")
    const b = buckets.get(key) ?? newBucket(label)
    add(b, mi, d.amount, d.withheldAmount)
    buckets.set(key, b)
    add(totals, mi, d.amount, d.withheldAmount)
  }

  const outRows: DisbursementPivotRow[] = Array.from(buckets.entries())
    .map(([key, b]) => ({ key, label: b.label, months: b.months, total: b.total, withheld: b.withheld, count: b.count }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))

  return {
    year,
    groupBy,
    rows: outRows,
    totals: { months: totals.months, total: totals.total, withheld: totals.withheld, count: totals.count },
  }
}
