import { round0 } from "./project-money.js"

/**
 * 專案獎金「季發放批次」的拆算——**純函式**，不碰 DB（IO 在 bonus-run-store.ts）。
 *
 * 客戶的規則（會議紀錄）：專案獎金隨請款**入帳進度同比例**拆發、按季發放
 * （中秋／端午／過年），每季發放結果存成獨立快照嚴禁覆蓋前一季，並有歷年
 * 累計總表。獎金池維持人工填（`projects.bonus_pool`），系統只做拆算與快照。
 *
 * ── 每個專案 ────────────────────────────────────────────────────────
 *   contract_total = 我方承攬合約＋追加減合計（billing-store.ts contractTotal 同口徑）
 *                    null／0 → 該案跳過並記入 totals.skipped[{reason:'no_contract'}]
 *   received_total = Σ project_billings.received_amount（截至 asOf）
 *   received_pct   = min(1, received_total / contract_total)   ← 收超過合約也只發到 100%
 *
 * ── 每位成員 ────────────────────────────────────────────────────────
 *   pool_pct     → entitled_cumulative = bonus_pool × received_pct × share_pct/100
 *   fixed_amount → entitled_cumulative = share_amount × received_pct
 *   paid_before  = Σ 先前 status='paid' 且未刪 runs 中同 (project, employee) 的 amount
 *   amount       = max(0, entitled_cumulative − paid_before)
 *   entitled < paid_before → overpaid=true、差額記在 overpaidBy（UI 紅字，**不自動追討**：
 *   例如專案結案後合約總額下修，錢已經發出去，追不追是老闆的決定，系統只標出來）。
 *
 * 金額四捨五入到**元**（`round0`）；received_pct 存到小數 4 位，但拆算用未捨入的比例，
 * 避免 0.3333 × 大金額累積出幾十元的尾差。
 *
 * ── 為什麼「累計應得 − 歷史已發」而不是「本季入帳 × 比例」──────────────
 * 直接拿本季入帳金額算，成員分潤比例在季中調整、或前季少算漏算時就對不回來；
 * 用累計口徑，任何一季重算都能自動把前面的差額補上（或標成 overpaid），
 * 歷年加總永遠等於「累計應得」，這是老闆要的「歷年累計總表」對得起來的前提。
 */

export const BONUS_RUN_STATUSES = ["draft", "paid"] as const
export type BonusRunStatus = (typeof BONUS_RUN_STATUSES)[number]

export const SHARE_MODES = ["pool_pct", "fixed_amount"] as const
export type ShareMode = (typeof SHARE_MODES)[number]

export type BonusMemberInput = {
  employeeId: string
  roleInProject?: string | null
  sharePct: number | null
  shareAmount: number | null
}

export type BonusProjectInput = {
  projectId: string
  /** 'pool_pct' | 'fixed_amount'（未知值一律當 fixed_amount 的 0 處理，不丟例外）。 */
  shareMode: string
  bonusPool: number | null
  /** null＝沒有我方承攬合約 → 跳過。 */
  contractTotal: number | null
  receivedTotal: number
  members: BonusMemberInput[]
}

export type BonusSkipReason = "no_contract" | "no_pool"
export type BonusSkipped = { projectId: string; reason: BonusSkipReason }

export type BonusItemCalc = {
  projectId: string
  employeeId: string
  roleInProject: string | null
  shareMode: string
  sharePct: number | null
  shareAmount: number | null
  bonusPool: number | null
  contractTotal: number
  receivedTotal: number
  /** 0～1，四位小數（顯示用；拆算用未捨入值）。 */
  receivedPct: number
  entitledCumulative: number
  paidBefore: number
  amount: number
  overpaid: boolean
  /** overpaid 時的差額（paid_before − entitled），否則 0。 */
  overpaidBy: number
}

export type BonusTotals = {
  amount: number
  entitledCumulative: number
  paidBefore: number
  itemCount: number
  employeeCount: number
  projectCount: number
  overpaidCount: number
  skipped: BonusSkipped[]
}

export type BonusRunCalc = { items: BonusItemCalc[]; totals: BonusTotals }

export const BONUS_RUN_KINDS = ["regular", "reversal"] as const
export type BonusRunKind = (typeof BONUS_RUN_KINDS)[number]

/* ──────────────────────────────────────────────────────────────────
 * 紅字沖銷（reversal）
 *
 * paid 批次凍結不可改。要「作廢」一批已發放的獎金，開一批 reversal：
 *   • 每列 amount 取負（-0 正規化成 0）
 *   • paidBefore 接在原批之後（原 paidBefore + 原 amount）——沖銷當下的
 *     「已發放累計」就是這個數，payRun 的 stale_paid_before 一致性檢查照樣有效
 *   • entitledCumulative／received／share 等事實欄位原樣複製（那是原批當時的世界）
 *   • overpaid 一律 false：沖銷不是新的發放判斷
 * 發放後 loadPaidBefore 對同 (project, employee) 的加總 = 原 amount + (−原 amount) = 0，
 * 下一季重算等於原批沒發生過（少發的補發回來、多發的不再標 overpaid）。
 * ────────────────────────────────────────────────────────────────── */

const negate = (n: number): number => (n === 0 ? 0 : -n)

export function reversalItemsOf(items: BonusItemCalc[]): BonusItemCalc[] {
  return items.map((it) => ({
    ...it,
    paidBefore: round2(it.paidBefore + it.amount),
    amount: negate(round2(it.amount)),
    overpaid: false,
    overpaidBy: 0,
  }))
}

export function reversalTotalsOf(totals: BonusTotals, items: BonusItemCalc[]): BonusTotals {
  const reversed = reversalItemsOf(items)
  return {
    // 沖銷列本身已是負數，直接加總；negate 只用來把 -0 正規化
    amount: negate(negate(round2(reversed.reduce((s, i) => s + i.amount, 0)))),
    // 沖銷批次的「累計應發／已發放」沿用原批口徑，讓詳情頁對得上原批
    entitledCumulative: totals.entitledCumulative,
    paidBefore: round2(reversed.reduce((s, i) => s + i.paidBefore, 0)),
    itemCount: reversed.length,
    employeeCount: new Set(reversed.map((i) => i.employeeId)).size,
    projectCount: new Set(reversed.map((i) => i.projectId)).size,
    overpaidCount: 0,
    skipped: [],
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** paid_before 的 Map key：同 (project, employee) 一格。 */
export function paidBeforeKey(projectId: string, employeeId: string): string {
  return `${projectId}:${employeeId}`
}

/** 入帳比例：分母 ≤ 0 → 0；收超過合約夾在 1。 */
export function receivedPctOf(contractTotal: number | null, receivedTotal: number): number {
  if (contractTotal === null || !(contractTotal > 0)) return 0
  const raw = receivedTotal / contractTotal
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw >= 1 ? 1 : raw
}

/** 累計應得（到元）。分潤設定缺值（pct／amount 為 null）→ 0，不丟例外。 */
export function entitledCumulativeOf(
  shareMode: string,
  bonusPool: number | null,
  sharePct: number | null,
  shareAmount: number | null,
  receivedPct: number,
): number {
  if (shareMode === "pool_pct") {
    if (bonusPool === null || sharePct === null) return 0
    return round0(bonusPool * receivedPct * (sharePct / 100))
  }
  if (shareAmount === null) return 0
  return round0(shareAmount * receivedPct)
}

function pct4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * 整批試算。`paidBefore`：(projectId:employeeId) → 歷史已發放合計（由 store 從
 * 先前 paid 且未刪的 runs 加總；重算某個 draft 時要排除它自己）。
 * 沒有成員的專案不進結果也不進 skipped（本來就不在發放範圍）。
 */
export function computeBonusRun(
  projects: BonusProjectInput[],
  paidBefore: ReadonlyMap<string, number> | Record<string, number>,
): BonusRunCalc {
  const paidOf = (key: string): number => {
    const v = paidBefore instanceof Map ? paidBefore.get(key) : (paidBefore as Record<string, number>)[key]
    return typeof v === "number" && Number.isFinite(v) ? v : 0
  }

  const items: BonusItemCalc[] = []
  const skipped: BonusSkipped[] = []
  const employees = new Set<string>()
  const projectIds = new Set<string>()

  for (const p of projects) {
    if (p.members.length === 0) continue
    if (p.contractTotal === null || !(p.contractTotal > 0)) {
      skipped.push({ projectId: p.projectId, reason: "no_contract" })
      continue
    }
    if (p.shareMode === "pool_pct" && (p.bonusPool === null || !(p.bonusPool > 0))) {
      skipped.push({ projectId: p.projectId, reason: "no_pool" })
      continue
    }
    const rawPct = receivedPctOf(p.contractTotal, p.receivedTotal)
    for (const m of p.members) {
      const entitled = entitledCumulativeOf(p.shareMode, p.bonusPool, m.sharePct, m.shareAmount, rawPct)
      const paid = round0(paidOf(paidBeforeKey(p.projectId, m.employeeId)))
      const diff = entitled - paid
      const overpaid = diff < 0
      items.push({
        projectId: p.projectId,
        employeeId: m.employeeId,
        roleInProject: m.roleInProject ?? null,
        shareMode: p.shareMode,
        sharePct: m.sharePct,
        shareAmount: m.shareAmount,
        bonusPool: p.bonusPool,
        contractTotal: p.contractTotal,
        receivedTotal: p.receivedTotal,
        receivedPct: pct4(rawPct),
        entitledCumulative: entitled,
        paidBefore: paid,
        amount: overpaid ? 0 : diff,
        overpaid,
        overpaidBy: overpaid ? -diff : 0,
      })
      employees.add(m.employeeId)
      projectIds.add(p.projectId)
    }
  }

  const totals: BonusTotals = {
    amount: items.reduce((s, i) => s + i.amount, 0),
    entitledCumulative: items.reduce((s, i) => s + i.entitledCumulative, 0),
    paidBefore: items.reduce((s, i) => s + i.paidBefore, 0),
    itemCount: items.length,
    employeeCount: employees.size,
    projectCount: projectIds.size,
    overpaidCount: items.filter((i) => i.overpaid).length,
    skipped,
  }
  return { items, totals }
}

/* ──────────────────────────────────────────────────────────────────
 * 期別標籤："YYYY-Qn"
 * ────────────────────────────────────────────────────────────────── */

const LABEL_RE = /^(\d{4})-Q([1-4])$/

export function quarterOf(dateKey: string): number {
  const m = Number(dateKey.slice(5, 7))
  return Math.min(4, Math.max(1, Math.ceil(m / 3)))
}

/** 預設期別標籤：基準日所在的年-季，如 2026-08-15 → "2026-Q3"。 */
export function defaultRunLabel(dateKey: string): string {
  return `${dateKey.slice(0, 4)}-Q${quarterOf(dateKey)}`
}

export function parseRunLabel(label: string): { year: number; quarter: number } | null {
  const m = LABEL_RE.exec(label.trim())
  if (!m) return null
  return { year: Number(m[1]), quarter: Number(m[2]) }
}

/* ──────────────────────────────────────────────────────────────────
 * 歷年累計／上季對比（純函式；輸入只要 paid 且未刪的 runs 與其 items）
 * ────────────────────────────────────────────────────────────────── */

export type SummaryRunInput = {
  id: string
  label: string
  asOf: string
  paidOn: string | null
}

export type SummaryItemInput = {
  runId: string
  projectId: string
  employeeId: string
  amount: number
  employeeName?: string | null
  empNo?: string | null
}

export type SummaryQuarter = {
  runId: string
  label: string
  year: number
  quarter: number
  paidOn: string | null
  amount: number
  employeeCount: number
  projectCount: number
}

export type SummaryEmployee = {
  employeeId: string
  employeeName: string | null
  empNo: string | null
  /** 篩選年度內合計（未指定年度＝全部）。 */
  amountYear: number
  amountAllTime: number
  runCount: number
}

export type SummaryComparison = {
  latest: SummaryQuarter | null
  previous: SummaryQuarter | null
  delta: number | null
  deltaPct: number | null
  byEmployee: Array<{
    employeeId: string
    employeeName: string | null
    empNo: string | null
    latest: number
    previous: number
    delta: number
  }>
}

export type BonusSummary = {
  years: number[]
  year: number | null
  yearTotal: number
  allTimeTotal: number
  byQuarter: SummaryQuarter[]
  byEmployee: SummaryEmployee[]
  comparison: SummaryComparison
}

/** run 的年／季：標籤能 parse 就用標籤，否則退用發放日／基準日。 */
export function runPeriod(run: SummaryRunInput): { year: number; quarter: number } {
  const parsed = parseRunLabel(run.label)
  if (parsed) return parsed
  const key = run.paidOn ?? run.asOf
  return { year: Number(key.slice(0, 4)), quarter: quarterOf(key) }
}

export function buildBonusSummary(
  runs: SummaryRunInput[],
  items: SummaryItemInput[],
  filter: { year?: number | null; employeeId?: string | null } = {},
): BonusSummary {
  const year = filter.year ?? null
  const empFilter = filter.employeeId ?? null
  const scopedItems = empFilter ? items.filter((i) => i.employeeId === empFilter) : items

  const itemsByRun = new Map<string, SummaryItemInput[]>()
  for (const it of scopedItems) {
    const arr = itemsByRun.get(it.runId) ?? []
    arr.push(it)
    itemsByRun.set(it.runId, arr)
  }

  const quarters: SummaryQuarter[] = runs
    .map((r) => {
      const period = runPeriod(r)
      const list = itemsByRun.get(r.id) ?? []
      return {
        runId: r.id,
        label: r.label,
        year: period.year,
        quarter: period.quarter,
        paidOn: r.paidOn,
        amount: list.reduce((s, i) => s + i.amount, 0),
        employeeCount: new Set(list.map((i) => i.employeeId)).size,
        projectCount: new Set(list.map((i) => i.projectId)).size,
      }
    })
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter || (a.paidOn ?? "").localeCompare(b.paidOn ?? ""))

  const years = [...new Set(quarters.map((q) => q.year))].sort((a, b) => a - b)
  const inYear = year === null ? quarters : quarters.filter((q) => q.year === year)
  const yearRunIds = new Set(inYear.map((q) => q.runId))

  const empMap = new Map<string, SummaryEmployee>()
  for (const it of scopedItems) {
    const e = empMap.get(it.employeeId) ?? {
      employeeId: it.employeeId,
      employeeName: it.employeeName ?? null,
      empNo: it.empNo ?? null,
      amountYear: 0,
      amountAllTime: 0,
      runCount: 0,
    }
    e.amountAllTime += it.amount
    if (yearRunIds.has(it.runId)) e.amountYear += it.amount
    if (!e.employeeName && it.employeeName) e.employeeName = it.employeeName
    if (!e.empNo && it.empNo) e.empNo = it.empNo
    empMap.set(it.employeeId, e)
  }
  const runsByEmp = new Map<string, Set<string>>()
  for (const it of scopedItems) {
    const s = runsByEmp.get(it.employeeId) ?? new Set<string>()
    s.add(it.runId)
    runsByEmp.set(it.employeeId, s)
  }
  const byEmployee = [...empMap.values()]
    .map((e) => ({ ...e, runCount: runsByEmp.get(e.employeeId)?.size ?? 0 }))
    .sort((a, b) => b.amountYear - a.amountYear || b.amountAllTime - a.amountAllTime)

  // 上季對比：本年度最後一期 vs 全部期別中它的前一期（Q1 的前一期是去年 Q4）。
  const latest = inYear.length > 0 ? inYear[inYear.length - 1] : null
  const latestIdx = latest ? quarters.findIndex((q) => q.runId === latest.runId) : -1
  const previous = latestIdx > 0 ? quarters[latestIdx - 1] : null
  const perEmp = (runId: string | undefined): Map<string, number> => {
    const m = new Map<string, number>()
    if (!runId) return m
    for (const it of itemsByRun.get(runId) ?? []) m.set(it.employeeId, (m.get(it.employeeId) ?? 0) + it.amount)
    return m
  }
  const latestEmp = perEmp(latest?.runId)
  const prevEmp = perEmp(previous?.runId)
  const cmpIds = new Set([...latestEmp.keys(), ...prevEmp.keys()])
  const comparison: SummaryComparison = {
    latest,
    previous,
    delta: latest && previous ? latest.amount - previous.amount : null,
    deltaPct:
      latest && previous && previous.amount > 0
        ? Math.round(((latest.amount - previous.amount) / previous.amount) * 1000) / 10
        : null,
    byEmployee: [...cmpIds]
      .map((id) => ({
        employeeId: id,
        employeeName: empMap.get(id)?.employeeName ?? null,
        empNo: empMap.get(id)?.empNo ?? null,
        latest: latestEmp.get(id) ?? 0,
        previous: prevEmp.get(id) ?? 0,
        delta: (latestEmp.get(id) ?? 0) - (prevEmp.get(id) ?? 0),
      }))
      .sort((a, b) => b.latest - a.latest),
  }

  return {
    years,
    year,
    yearTotal: inYear.reduce((s, q) => s + q.amount, 0),
    allTimeTotal: quarters.reduce((s, q) => s + q.amount, 0),
    byQuarter: inYear,
    byEmployee,
    comparison,
  }
}
