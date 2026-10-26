import { createHash } from "node:crypto"
import { DEFAULT_VAT_RATE, round0 } from "./project-money.js"

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
 * ── 2026-10-26 改版（業主決定 8／#4／#5）──────────────────────────────
 *   獎金池三種基礎（basis），每個專案擇一：
 *   • gross_profit（設了 bonus_rate_pct 的 pool_pct 專案）：
 *       累計已實現毛利 GP＝累計入帳（未稅）－累計已發生專案成本（services/project-gross-profit.ts）
 *       pool＝max(0, GP) × bonus_rate_pct/100；entitled＝pool × share_pct/100（不乘入帳比例、不截 100%）。
 *       不需要合約（沒有合約只是算不出入帳比例與「超過合約」警示）。
 *   • legacy_pool（pool_pct 但沒設比例、只有手填 bonus_pool）：維持舊算法
 *       entitled＝bonus_pool × min(1, 入帳比例) × share_pct/100，結果標「舊制（手填獎金池）」。
 *   • fixed_amount：entitled＝share_amount × min(1, 入帳比例)（舊算法，不變）。
 *   received_pct 存**未截斷**的實際比例（可 > 1）；入帳超過合約 → overContractPct＝超出幾 %，
 *   totals.warnings 列「入帳超過合約 N%」。舊制／固定金額的拆算仍以 min(1, 比例) 計，不會因超收多發。
 *
 * 金額四捨五入到**元**（`round0`）；received_pct 存到小數 4 位，但拆算用未捨入的比例，
 * 避免 0.3333 × 大金額累積出幾十元的尾差。
 *
 * ── 為什麼「累計應得 − 歷史已發」而不是「本季入帳 × 比例」──────────────
 * 直接拿本季入帳金額算，成員分潤比例在季中調整、或前季少算漏算時就對不回來；
 * 用累計口徑，任何一季重算都能自動把前面的差額補上（或標成 overpaid），
 * 歷年加總永遠等於「累計應得」，這是老闆要的「歷年累計總表」對得起來的前提。
 */

export const BONUS_RUN_STATUSES = ["draft", "pending_approval", "approved", "paid"] as const
export type BonusRunStatus = (typeof BONUS_RUN_STATUSES)[number]

export const BONUS_RUN_STATUS_LABEL: Record<BonusRunStatus, string> = {
  draft: "草稿",
  pending_approval: "送審中",
  approved: "已核准",
  paid: "已發放",
}

/* ──────────────────────────────────────────────────────────────────
 * 核准狀態機（#7，2026-10-26）——純函式；IO 在 bonus-run-store.ts
 *
 *   draft ──submit(HR)──▶ pending_approval ──approve(老闆)──▶ approved ──pay(HR)──▶ paid
 *     ▲                     │ return(老闆，需原因)／withdraw(HR，需原因，限送審中) │
 *     └─────────────────────┴───────────────────────────────────┘
 *   重算（手動 PATCH、入帳／成本／分潤設定變動的自動重算）在 pending_approval／approved 也會跑；
 *   每列金額的指紋（amountFingerprint）跟送審時存的不同 → 退回 draft，需重新送審。
 *   金額沒變 → 維持原狀態（例如只是成本拆分、備註變了）。
 *   刪除只收 draft；發放只收 approved。沖銷批次走同一套。
 * ────────────────────────────────────────────────────────────────── */

export type BonusRunAction = "submit" | "approve" | "return" | "withdraw" | "pay" | "delete"

export type TransitionResult =
  | { ok: true; next: BonusRunStatus }
  | { ok: false; code: "not_draft" | "not_pending" | "not_returnable" | "not_withdrawable" | "not_approved" }

export function transitionOf(status: string, action: BonusRunAction): TransitionResult {
  switch (action) {
    case "submit":
      return status === "draft" ? { ok: true, next: "pending_approval" } : { ok: false, code: "not_draft" }
    case "approve":
      return status === "pending_approval" ? { ok: true, next: "approved" } : { ok: false, code: "not_pending" }
    case "return":
      return status === "pending_approval" || status === "approved"
        ? { ok: true, next: "draft" }
        : { ok: false, code: "not_returnable" }
    case "withdraw":
      // HR 撤回只限送審中；已核准後只能由老闆退回。
      return status === "pending_approval" ? { ok: true, next: "draft" } : { ok: false, code: "not_withdrawable" }
    case "pay":
      if (status === "approved") return { ok: true, next: "paid" }
      // 已發放再按一次沿用舊錯誤碼 not_draft（「已經不是可處理的狀態」）。
      return { ok: false, code: status === "paid" ? "not_draft" : "not_approved" }
    case "delete":
      return status === "draft" ? { ok: true, next: "draft" } : { ok: false, code: "not_draft" }
  }
}

/** 每列金額的指紋：非 0 的 (project, employee, amount) 排序後 sha256。 */
export function amountFingerprint(items: ReadonlyArray<{ projectId: string; employeeId: string; amount: number }>): string {
  // 金額 0 的列不進指紋：只是「這個人這案這次沒錢」，有沒有那一列不影響發放金額。
  const lines = items
    .map((i) => ({ key: `${i.projectId}:${i.employeeId}`, cents: Math.round(i.amount * 100) }))
    .filter((i) => i.cents !== 0)
    .map((i) => `${i.key}:${i.cents}`)
    .sort()
  return createHash("sha256").update(lines.join("|")).digest("hex")
}

/** 重算後的狀態：送審中／已核准且金額指紋變了 → 退回 draft。 */
export function statusAfterRecompute(
  status: string,
  reviewedFingerprint: string | null,
  newFingerprint: string,
): { status: string; returned: boolean } {
  if (status !== "pending_approval" && status !== "approved") return { status, returned: false }
  if (reviewedFingerprint !== null && reviewedFingerprint === newFingerprint) return { status, returned: false }
  return { status: "draft", returned: true }
}

export const AMOUNT_CHANGED_RETURN_REASON = "重算後金額與送審／核准時不同，系統自動退回草稿，請重新送審"

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
  /** 有值時以合約額乘此比例衍生獎金池；null 才沿用 bonusPool。 */
  bonusRatePct: number | null
  projectNote: string | null
  /** null＝沒有我方承攬合約 → 舊制／固定金額跳過；毛利制照算。 */
  contractTotal: number | null
  /** 累計已入帳（未稅）＝毛利的收入端。 */
  receivedTotal: number
  /** 累計已發生專案成本（毛額）；省略＝0。見 services/project-gross-profit.ts。 */
  cost?: number
  /** 成本拆分（顯示用）。 */
  disbursementCost?: number
  subcontractCost?: number
  /** 已封存（非複製取代）：全部成員結清就不列（見 isSettled）。 */
  archived?: boolean
  /** 租戶獎金池口徑；省略＝tax_inclusive_receipts（Excel 制）。 */
  poolBasis?: BonusPoolBasis
  /** 營業稅率（0.05＝5%，project_settings.vat_rate）；含稅入帳＝未稅入帳 × (1＋稅率)。省略＝0.05。 */
  vatRate?: number
  members: BonusMemberInput[]
}

export type BonusSkipReason = "no_contract" | "no_pool"
export type BonusSkipped = { projectId: string; reason: BonusSkipReason }

/** 獎金池基礎：毛利制／舊制手填獎金池／固定金額。 */
export const BONUS_BASES = ["tax_inclusive_receipts", "gross_profit", "legacy_pool", "fixed_amount"] as const
export type BonusBasis = (typeof BONUS_BASES)[number]

/**
 * 租戶的獎金池口徑（tenants.features.bonus.poolBasis，2026-10-27 業主決定）：
 *   tax_inclusive_receipts（預設）＝公司原 Excel：每人累計應得＝累計含稅入帳 × 比例 × 個人趴數，不扣任何成本；
 *   gross_profit＝10/26 的毛利制（保留程式路徑供日後切換）。只影響「有設獎金比例的 pool_pct 專案」。
 */
export const BONUS_POOL_BASES = ["tax_inclusive_receipts", "gross_profit"] as const
export type BonusPoolBasis = (typeof BONUS_POOL_BASES)[number]
export const DEFAULT_BONUS_POOL_BASIS: BonusPoolBasis = "tax_inclusive_receipts"

export function parseBonusPoolBasis(v: unknown): BonusPoolBasis {
  return v === "gross_profit" ? "gross_profit" : DEFAULT_BONUS_POOL_BASIS
}

export const BONUS_BASIS_LABEL: Record<BonusBasis, string> = {
  tax_inclusive_receipts: "含稅入帳制",
  gross_profit: "毛利制",
  legacy_pool: "舊制（手填獎金池）",
  fixed_amount: "固定金額",
}

export type BonusWarning = { projectId: string; kind: "over_contract"; overContractPct: number; message: string }

export type ProjectBonusBasis = {
  basis: BonusBasis
  /** 本專案（累計）獎金池；舊制沒填／毛利制沒比例 → null。fixed_amount 為 null。 */
  pool: number | null
  revenue: number
  cost: number
  disbursementCost: number
  subcontractCost: number
  grossProfit: number
  /** 營業稅率與累計含稅入帳（＝未稅入帳 × (1＋稅率)，到分）。 */
  vatRate: number
  taxInclusiveRevenue: number
  /** Excel「總獎金」＝含稅合約額 × 比例（顯示用；沒合約或沒比例 → null）。 */
  contractPool: number | null
  /** 實際入帳比例（未截斷，0 起，可 > 1）；沒有合約 → 0。 */
  receivedRatio: number
  /** 入帳超過合約幾 %（一位小數）；沒超過或沒合約 → null。 */
  overContractPct: number | null
}

export type BonusItemCalc = {
  projectId: string
  employeeId: string
  roleInProject: string | null
  shareMode: string
  sharePct: number | null
  shareAmount: number | null
  bonusPool: number | null
  bonusRatePct: number | null
  /** 毛利制且沒有合約時為 null。 */
  contractTotal: number | null
  receivedTotal: number
  basis: BonusBasis
  cost: number
  disbursementCost: number
  subcontractCost: number
  grossProfit: number
  vatRate: number
  taxInclusiveRevenue: number
  overContractPct: number | null
  previousReceived: number
  previousReceivedPct: number
  currentReceived: number
  currentReceivedPct: number
  unallocatedPct: number
  projectNote: string | null
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
  /** 入帳超過合約等提醒（舊批次沒有這個鍵）。 */
  warnings?: BonusWarning[]
}

export type BonusRunCalc = {
  items: BonusItemCalc[]
  totals: BonusTotals
  /** 封存且已結清（或算不出來）而不列的專案。 */
  settledArchived?: string[]
}

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
    warnings: [],
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** paid_before 的 Map key：同 (project, employee) 一格。 */
export function paidBeforeKey(projectId: string, employeeId: string): string {
  return `${projectId}:${employeeId}`
}

/** 實際入帳比例（不截斷）：分母 ≤ 0 → 0；負數 → 0；收超過合約可 > 1。 */
export function receivedRatioOf(contractTotal: number | null, receivedTotal: number): number {
  if (contractTotal === null || !(contractTotal > 0)) return 0
  const raw = receivedTotal / contractTotal
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return raw
}

/** 舊制／固定金額拆算用的入帳比例：分母 ≤ 0 → 0；收超過合約夾在 1。 */
export function receivedPctOf(contractTotal: number | null, receivedTotal: number): number {
  const raw = receivedRatioOf(contractTotal, receivedTotal)
  return raw >= 1 ? 1 : raw
}

/** 入帳超過合約幾 %（一位小數）；沒超過（含剛好收足）或沒合約 → null。 */
export function overContractPctOf(contractTotal: number | null, receivedTotal: number): number | null {
  if (contractTotal === null || !(contractTotal > 0)) return null
  if (!(receivedTotal > contractTotal)) return null
  const pct = Math.round(((receivedTotal - contractTotal) / contractTotal) * 1000) / 10
  return pct > 0 ? pct : null
}

export function overContractMessage(pct: number): string {
  return `入帳超過合約 ${pct}%`
}

/* ──────────────────────────────────────────────────────────────────
 * 封存專案要不要納入試算（#4 結案後尾款；2026-10-26 驗收修正）
 *   • 「複製專案而封存的原案」（archive_reason＝project-duplicate.ts archiveReasonFor：
 *     「已由 {新 code} 取代：…」）→ 一律排除：新案帶著同一批成員分潤，原案再算就重複採計。
 *   • 其他封存（結案自動封存、手動封存）→ 先照常計算；只要有任何成員「累計應得 ≠ 已發」
 *     （還有沒發的，或超發）就納入，全部結清才不列（computeBonusRun 的 archived 旗標）。
 *     例：10/5 進尾款、10/20 結案自動封存，之後沒有任何新動靜——尾款的獎金還沒發，仍要列。
 *   • 封存日在試算基準日之後（補做舊季批次）＝基準日當時還沒封存 → 當作未封存。
 * ────────────────────────────────────────────────────────────────── */

const DUPLICATE_ARCHIVE_RE = /^已由 .+ 取代：/

export function isDuplicateReplacedArchive(archiveReason: string | null | undefined): boolean {
  return typeof archiveReason === "string" && DUPLICATE_ARCHIVE_RE.test(archiveReason)
}

export type ArchiveStage = "active" | "duplicate_replaced" | "archived"

/** archivedOn：封存日（租戶當地 'YYYY-MM-DD'）；null＝未封存。asOf：試算基準日。 */
export function archiveStageOf(archivedOn: string | null, archiveReason: string | null | undefined, asOf?: string | null): ArchiveStage {
  if (archivedOn === null) return "active"
  if (asOf && archivedOn > asOf) return "active"
  if (isDuplicateReplacedArchive(archiveReason)) return "duplicate_replaced"
  return "archived"
}

/** 封存案是否已結清：每位成員累計應得＝已發（沒有待發、也沒有超發）。 */
export function isSettled(items: ReadonlyArray<Pick<BonusItemCalc, "amount" | "overpaid">>): boolean {
  return items.every((i) => i.amount === 0 && !i.overpaid)
}

/** 毛利制累計獎金池（未捨入）：max(0, 毛利) × 比例。 */
function grossProfitPoolRaw(grossProfit: number, bonusRatePct: number): number {
  return Math.max(0, grossProfit) * (bonusRatePct / 100)
}

/**
 * 專案層的獎金基礎（純函式）：用哪一制、池多少、收入／成本／毛利、入帳比例與超過合約。
 * 獎金試算（computeBonusRun）與估算服務（bonus-estimate.ts）共用這一支。
 */
export function projectBonusBasisOf(p: BonusProjectInput): ProjectBonusBasis {
  const revenue = p.receivedTotal
  const cost = p.cost ?? 0
  const grossProfit = Math.round((revenue - cost) * 100) / 100
  const vatRate = p.vatRate ?? DEFAULT_VAT_RATE
  const taxInclusiveRevenue = taxInclusiveOf(revenue, vatRate)
  const poolBasis = p.poolBasis ?? DEFAULT_BONUS_POOL_BASIS
  const basis: BonusBasis =
    p.shareMode === "pool_pct"
      ? p.bonusRatePct !== null
        ? poolBasis === "gross_profit" ? "gross_profit" : "tax_inclusive_receipts"
        : "legacy_pool"
      : "fixed_amount"
  const pool =
    basis === "gross_profit"
      ? round0(grossProfitPoolRaw(grossProfit, p.bonusRatePct as number))
      : basis === "tax_inclusive_receipts"
        ? round0(taxInclusiveRevenue * (p.bonusRatePct as number) / 100)
        : basis === "legacy_pool"
          ? p.bonusPool
          : null
  const contractPool =
    p.bonusRatePct !== null && p.contractTotal !== null && p.contractTotal > 0
      ? round0(taxInclusiveOf(p.contractTotal, vatRate) * p.bonusRatePct / 100)
      : null
  return {
    basis,
    pool,
    revenue,
    cost,
    disbursementCost: p.disbursementCost ?? 0,
    subcontractCost: p.subcontractCost ?? 0,
    grossProfit,
    vatRate,
    taxInclusiveRevenue,
    contractPool,
    receivedRatio: receivedRatioOf(p.contractTotal, revenue),
    overContractPct: overContractPctOf(p.contractTotal, revenue),
  }
}

/** 未稅 → 含稅（到分）。 */
export function taxInclusiveOf(untaxed: number, vatRate: number): number {
  return Math.round(untaxed * (1 + vatRate) * 100) / 100
}

/** 每人累計應得的「池基礎」（未捨入）：Excel 制＝含稅入帳 × 比例；毛利制＝max(0, 毛利) × 比例；其他 0（走舊算法）。 */
function ratePoolRaw(b: ProjectBonusBasis, bonusRatePct: number | null): number {
  if (bonusRatePct === null) return 0
  if (b.basis === "gross_profit") return grossProfitPoolRaw(b.grossProfit, bonusRatePct)
  if (b.basis === "tax_inclusive_receipts") return b.taxInclusiveRevenue * (bonusRatePct / 100)
  return 0
}

/** 比例制（Excel 含稅入帳制或毛利制）：不需要合約、不乘入帳比例、不截 100%。 */
export function isRateBasis(basis: BonusBasis): boolean {
  return basis === "gross_profit" || basis === "tax_inclusive_receipts"
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

export function effectiveBonusPoolOf(
  contractTotal: number | null,
  bonusRatePct: number | null,
  legacyBonusPool: number | null,
): number | null {
  if (bonusRatePct === null) return legacyBonusPool
  if (contractTotal === null || !(contractTotal > 0)) return null
  return round0(contractTotal * bonusRatePct / 100)
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
  previousReceived: ReadonlyMap<string, number> | Record<string, number> = new Map(),
): BonusRunCalc {
  const paidOf = (key: string): number => {
    const v = paidBefore instanceof Map ? paidBefore.get(key) : (paidBefore as Record<string, number>)[key]
    return typeof v === "number" && Number.isFinite(v) ? v : 0
  }

  const items: BonusItemCalc[] = []
  const skipped: BonusSkipped[] = []
  const employees = new Set<string>()
  const projectIds = new Set<string>()

  const warnings: BonusWarning[] = []
  const settledArchived: string[] = []
  for (const p of projects) {
    if (p.members.length === 0) continue
    const b = projectBonusBasisOf(p)
    const hasContract = p.contractTotal !== null && p.contractTotal > 0
    if (!isRateBasis(b.basis) && !hasContract) {
      if (p.archived) settledArchived.push(p.projectId)
      else skipped.push({ projectId: p.projectId, reason: "no_contract" })
      continue
    }
    if (b.basis === "legacy_pool" && (b.pool === null || !(b.pool > 0))) {
      if (p.archived) settledArchived.push(p.projectId)
      else skipped.push({ projectId: p.projectId, reason: "no_pool" })
      continue
    }
    const projectItems: BonusItemCalc[] = []
    const rawPct = receivedPctOf(p.contractTotal, p.receivedTotal)
    const ratePool = ratePoolRaw(b, p.bonusRatePct)
    const previousRaw = previousReceived instanceof Map
      ? previousReceived.get(p.projectId)
      : (previousReceived as Record<string, number>)[p.projectId]
    const previous = Math.max(0, Math.min(p.receivedTotal, typeof previousRaw === "number" && Number.isFinite(previousRaw) ? previousRaw : 0))
    const current = Math.max(0, p.receivedTotal - previous)
    const allocatedPct = p.members.reduce((sum, member) => sum + (member.sharePct ?? 0), 0)
    const unallocatedPct = Math.max(0, Math.round((100 - allocatedPct) * 10000) / 10000)
    for (const m of p.members) {
      const entitled =
        isRateBasis(b.basis)
          ? m.sharePct === null
            ? 0
            : round0(ratePool * (m.sharePct / 100))
          : entitledCumulativeOf(p.shareMode, b.pool, m.sharePct, m.shareAmount, rawPct)
      const paid = round0(paidOf(paidBeforeKey(p.projectId, m.employeeId)))
      const diff = entitled - paid
      const overpaid = diff < 0
      projectItems.push({
        projectId: p.projectId,
        employeeId: m.employeeId,
        roleInProject: m.roleInProject ?? null,
        shareMode: p.shareMode,
        sharePct: m.sharePct,
        shareAmount: m.shareAmount,
        bonusPool: b.pool,
        bonusRatePct: p.bonusRatePct,
        contractTotal: hasContract ? p.contractTotal : null,
        receivedTotal: p.receivedTotal,
        basis: b.basis,
        cost: b.cost,
        disbursementCost: b.disbursementCost,
        subcontractCost: b.subcontractCost,
        grossProfit: b.grossProfit,
        vatRate: b.vatRate,
        taxInclusiveRevenue: b.taxInclusiveRevenue,
        overContractPct: b.overContractPct,
        previousReceived: previous,
        previousReceivedPct: pct4(receivedRatioOf(p.contractTotal, previous)),
        currentReceived: current,
        currentReceivedPct: pct4(receivedRatioOf(p.contractTotal, current)),
        unallocatedPct,
        projectNote: p.projectNote,
        // 存實際比例（未截斷）：超收的案子 HR 要看得到 120%，不是被夾成 100%。
        receivedPct: pct4(b.receivedRatio),
        entitledCumulative: entitled,
        paidBefore: paid,
        amount: overpaid ? 0 : diff,
        overpaid,
        overpaidBy: overpaid ? -diff : 0,
      })
    }
    // 封存案：全部結清 → 不列（不進明細、不進警示）。
    if (p.archived && isSettled(projectItems)) {
      settledArchived.push(p.projectId)
      continue
    }
    if (b.overContractPct !== null) {
      warnings.push({ projectId: p.projectId, kind: "over_contract", overContractPct: b.overContractPct, message: overContractMessage(b.overContractPct) })
    }
    for (const it of projectItems) {
      items.push(it)
      employees.add(it.employeeId)
      projectIds.add(it.projectId)
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
    warnings,
  }
  return { items, totals, settledArchived }
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
