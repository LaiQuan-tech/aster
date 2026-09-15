import { computeInstallments, type InstallmentInput } from "./billing-schedule.js"
import { isOurContract } from "../lib/contract-role.js"

/**
 * 專案申請單的錢——**純函式**，不碰 DB（IO 在 project-application-store.ts）。
 *
 * 亞斯特老闆的 Excel「年度專案申請單總表」每一列是：金額（未稅）｜稅金｜含稅｜
 * 已收｜未收｜各科別發包……。本模組把那幾格的算法收斂在一個地方，
 * `GET /projects/:id`、申請單、年度總表、未收款清單四個投影都讀同一份。
 *
 * ── 一律以「未稅」為基準 ────────────────────────────────────────────
 * 分期請款的分母是合約總額（未稅），各期金額也是未稅；開票時才加 5% 營業稅。
 * 所以 `billedTotal`／`receivedTotal`／`unreceived` 都是未稅口徑，
 * 稅金另欄顯示（`taxAmount`＝未稅 × 稅率，四捨五入到元）。
 * 混用含稅與未稅是對帳對不起來的第一大原因，這裡不給選。
 *
 * ── 分母的來源 ──────────────────────────────────────────────────────
 * 優先用 `contractTotal()`（我方承攬的合約＋追加減，見 billing-store.ts）。
 * 一張合約都沒有時退而用**最新的報價單**金額並標 `amountSource:'quotation'`：
 * 申請單通常在簽約前就要立，那時只有報價單，總表上仍要看得到預估金額；
 * 但要標明來源，否則會把「報價」當成「合約」去追款。兩者都沒有就是 null。
 *
 * ── guild_advance（公會制估驗預付款）────────────────────────────────
 * 只是一筆金額，**不進百分比與尾差計算**（帳本「尾差落末期」只算 installment）。
 * 但它一樣會請款／開票／入帳，所以計入 billedTotal／receivedTotal。
 */

export const BILLING_KINDS = ["installment", "guild_advance"] as const
export type BillingKind = (typeof BILLING_KINDS)[number]

export const SUBCONTRACT_KINDS = ["subcontract", "technician"] as const
export type SubcontractKind = (typeof SUBCONTRACT_KINDS)[number]

export const PROJECT_KINDS = ["main", "change", "addition", "advance"] as const
export type ProjectKind = (typeof PROJECT_KINDS)[number]

export const INVOICE_TYPES = ["duplicate", "triplicate"] as const
export const PAYMENT_METHODS = ["transfer", "check"] as const

/** 營業稅 5%。與 project_settings.vat_rate 的 default 對齊。 */
export const DEFAULT_VAT_RATE = 0.05
/** 執行業務所得就源扣繳 10%、起扣門檻 20,000（所得稅法 §89-1）。 */
export const DEFAULT_WITHHOLDING_RATE = 0.1
export const DEFAULT_WITHHOLDING_THRESHOLD = 20000

/** 金額到「元」。 */
export function round0(n: number): number {
  return Math.round(n)
}

/** 百分比到小數第一位；分母為 null／0 回 null（不猜）。 */
export function pct1(part: number, whole: number | null): number | null {
  if (whole === null || !Number.isFinite(whole) || whole === 0) return null
  return Math.round((part / whole) * 1000) / 10
}

export type AmountSource = "contract" | "quotation" | null

/** 合約總額優先；沒有合約才退用最新報價單。 */
export function resolveAmountUntaxed(
  contractTotal: number | null,
  latestQuotation: number | null,
): { amountUntaxed: number | null; amountSource: AmountSource } {
  if (contractTotal !== null) return { amountUntaxed: contractTotal, amountSource: "contract" }
  if (latestQuotation !== null) return { amountUntaxed: latestQuotation, amountSource: "quotation" }
  return { amountUntaxed: null, amountSource: null }
}

export type MoneyBillingInput = {
  kind: string
  /** 有效金額 = 已請款 ?? 人工覆寫 ?? 試算（未稅）。 */
  effectiveAmount: number | null
  billedOn: string | null
  billedAmount: number | null
  invoicedOn: string | null
  receivedOn: string | null
  receivedAmount: number | null
}

export type MoneySubcontractInput = {
  kind: string
  amount: number
}

export type ProjectMoney = {
  amountUntaxed: number | null
  amountSource: AmountSource
  vatRate: number
  taxAmount: number | null
  amountTotal: number | null
  billedTotal: number
  invoicedTotal: number
  receivedTotal: number
  /** 未稅口徑：分母 − 已收。分母未知時 null。 */
  unreceived: number | null
  billingProgressPct: number | null
  receiptProgressPct: number | null
  /** 下包（kind=subcontract）＋技師費（kind=technician）合計。 */
  subcontractTotal: number
  technicianTotal: number
  otherExpenses: number
  /** 未稅 − 發包（含技師費）− 其他支出。分母未知時 null。 */
  profit: number | null
  grossMarginPct: number | null
}

/** 有效金額 = 已請款 ?? 人工覆寫 ?? 試算。與 billings.ts 的 serialize 同一條規則。 */
export function effectiveBillingAmount(row: {
  billed_on: string | null
  billed_amount: number | string | null
  override_amount: number | string | null
  calculated_amount: number | string | null
}): number | null {
  if (row.billed_on !== null) return toNum(row.billed_amount)
  return toNum(row.override_amount) ?? toNum(row.calculated_amount)
}

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

export function computeMoney(input: {
  amountUntaxed: number | null
  amountSource: AmountSource
  vatRate: number
  billings: MoneyBillingInput[]
  subcontracts: MoneySubcontractInput[]
  otherExpenses: number
}): ProjectMoney {
  const amountUntaxed = input.amountUntaxed
  const taxAmount = amountUntaxed === null ? null : round0(amountUntaxed * input.vatRate)
  const amountTotal = amountUntaxed === null || taxAmount === null ? null : amountUntaxed + taxAmount

  let billedTotal = 0
  let invoicedTotal = 0
  let receivedTotal = 0
  for (const b of input.billings) {
    if (b.billedOn) billedTotal += b.billedAmount ?? b.effectiveAmount ?? 0
    // 開票沒有自己的金額欄：開的是這一期的有效金額。
    if (b.invoicedOn) invoicedTotal += b.effectiveAmount ?? 0
    if (b.receivedOn) receivedTotal += b.receivedAmount ?? 0
  }

  let subcontractTotal = 0
  let technicianTotal = 0
  for (const s of input.subcontracts) {
    if (s.kind === "technician") technicianTotal += s.amount
    else subcontractTotal += s.amount
  }
  const outgo = subcontractTotal + technicianTotal + input.otherExpenses
  const profit = amountUntaxed === null ? null : round0(amountUntaxed - outgo)

  return {
    amountUntaxed,
    amountSource: input.amountSource,
    vatRate: input.vatRate,
    taxAmount,
    amountTotal,
    billedTotal: round0(billedTotal),
    invoicedTotal: round0(invoicedTotal),
    receivedTotal: round0(receivedTotal),
    unreceived: amountUntaxed === null ? null : round0(amountUntaxed - receivedTotal),
    billingProgressPct: pct1(billedTotal, amountUntaxed),
    receiptProgressPct: pct1(receivedTotal, amountUntaxed),
    subcontractTotal: round0(subcontractTotal + technicianTotal),
    technicianTotal: round0(technicianTotal),
    otherExpenses: input.otherExpenses,
    profit,
    grossMarginPct: profit === null ? null : pct1(profit, amountUntaxed),
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 期程：installment 走尾差演算法，guild_advance 只是一筆金額
 * ────────────────────────────────────────────────────────────────── */

export type ScheduleRowInput = InstallmentInput & { kind: string }

export type ScheduleRowOutput = {
  installmentNo: number
  kind: string
  calculatedAmount: number | null
  residueApplied: number
  effectiveAmount: number | null
}

/**
 * 把整份期程算出來：
 *   • kind=installment → `computeInstallments()`（尾差落最後一個未請款期）
 *   • kind=guild_advance → 不進尾差；有百分比就算 round(分母 × %)，否則 null；
 *     覆寫／已請款照舊優先。
 * `percentageTotal` 與 `unallocatedResidue` 只看 installment。
 */
export function computeSchedule(rows: ScheduleRowInput[], contractTotal: number | null) {
  const installments = rows.filter((r) => r.kind !== "guild_advance")
  const advances = rows.filter((r) => r.kind === "guild_advance")
  const result = computeInstallments(installments, contractTotal)
  const out: ScheduleRowOutput[] = result.rows.map((r) => ({ ...r, kind: "installment" }))
  let guildAdvanceTotal = 0
  for (const a of advances) {
    let calculated: number | null = null
    if (contractTotal !== null && a.percentage !== null) calculated = round0(contractTotal * (a.percentage / 100))
    const effective = a.billed ? a.billedAmount : a.overrideAmount !== null ? round0(a.overrideAmount) : calculated
    guildAdvanceTotal += effective ?? 0
    out.push({
      installmentNo: a.installmentNo,
      kind: "guild_advance",
      calculatedAmount: a.billed || a.overrideAmount !== null ? null : calculated,
      residueApplied: 0,
      effectiveAmount: effective,
    })
  }
  out.sort((x, y) => x.installmentNo - y.installmentNo)
  return {
    rows: out,
    percentageTotal: result.percentageTotal,
    /** installment 的有效金額合計（分母有值時＝合約總額）。 */
    effectiveTotal: result.effectiveTotal,
    unallocatedResidue: result.unallocatedResidue,
    guildAdvanceTotal: round0(guildAdvanceTotal),
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 副委託期款與代扣
 * ────────────────────────────────────────────────────────────────── */

/**
 * 就源扣繳：單期金額超過門檻才扣（所得稅法 §89-1 執行業務所得；
 * 門檻 20,000 是「每次給付」的門檻，所以按期算，不按合約總額算）。
 *   25,000 × 10% = 2,500；18,000 未達門檻 → 0。
 */
export function withheldAmount(amount: number | null, rate: number, threshold: number): number {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return 0
  return amount > threshold ? round0(amount * rate) : 0
}

export type SubcontractPaymentInput = {
  installmentNo: number
  percentage: number | null
  overrideAmount: number | null
  /** 已付款：凍結在存下來的金額（毛額，未扣代扣）。 */
  paid: boolean
  paidGrossAmount: number | null
}

export type SubcontractPaymentOutput = {
  installmentNo: number
  /** 系統試算（含尾差）。已付或覆寫的期別回 null。 */
  calculatedAmount: number | null
  residueApplied: number
  /** 有效毛額 = 已付凍結 ?? 覆寫 ?? 試算。 */
  effectiveAmount: number | null
  withheldAmount: number
  /** 實付（毛額 − 代扣）。 */
  netAmount: number | null
}

/**
 * 副委託期款＝同一套尾差演算法（`computeInstallments`）：百分比 × 下包金額，
 * 末期吸收尾差，已付的凍結。代扣按每期有效毛額算。
 */
export function computeSubcontractPayments(
  rows: SubcontractPaymentInput[],
  contractAmount: number | null,
  withholdingRate: number,
  withholdingThreshold: number,
): { rows: SubcontractPaymentOutput[]; effectiveTotal: number; withheldTotal: number; unallocatedResidue: number } {
  const result = computeInstallments(
    rows.map((r) => ({
      installmentNo: r.installmentNo,
      percentage: r.percentage,
      overrideAmount: r.overrideAmount,
      billed: r.paid,
      billedAmount: r.paidGrossAmount,
    })),
    contractAmount,
  )
  let withheldTotal = 0
  const out = result.rows.map((r) => {
    const withheld = withheldAmount(r.effectiveAmount, withholdingRate, withholdingThreshold)
    withheldTotal += withheld
    return {
      installmentNo: r.installmentNo,
      calculatedAmount: r.calculatedAmount,
      residueApplied: r.residueApplied,
      effectiveAmount: r.effectiveAmount,
      withheldAmount: withheld,
      netAmount: r.effectiveAmount === null ? null : r.effectiveAmount - withheld,
    }
  })
  return {
    rows: out,
    effectiveTotal: result.effectiveTotal,
    withheldTotal,
    unallocatedResidue: result.unallocatedResidue,
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 未收款清單
 * ────────────────────────────────────────────────────────────────── */

export type OverdueBasis = "billed" | "invoiced"

/**
 * 「已收足」——這一期算不算收完了。
 *
 * `/billings/:id/receive` 支援部分入帳（實收可以小於該期有效金額：分批匯、折讓
 * 待補），所以「有入帳日」不等於「收完了」：收 30 萬／應收 100 萬的期別還有
 * 70 萬要催，逾期清單與狀態 badge 不能因為 received_on 有值就把它當 received
 * （驗收抓到的 B 批次問題 2）。
 *
 * `unreceived` 是呼叫端算好的未收（有效金額 − 實收，未稅；見 buildReceivables）：
 *   • `undefined`（沒帶）：相容舊呼叫，退回「有入帳日就算收完」。
 *   • `null`：有效金額未知（沒合約也沒報價單），算不出未收——有入帳日就當收完，
 *     清單上本來就無從標它欠多少。
 *   • 數字：<= 0 才是收足；> 0 是部分入帳，仍要追。
 */
export function isFullyReceived(receivedOn: string | null, unreceived?: number | null): boolean {
  if (!receivedOn) return false
  if (unreceived === undefined || unreceived === null) return true
  return unreceived <= 0
}

/**
 * 逾期天數。`basis` 決定起算日：
 * - `'invoiced'`（省略時的預設，相容舊呼叫）：已開票且未入帳，從開票日起算——原本唯一的行為。
 * - `'billed'`（B5 新增）：已請款且未入帳，從請款日起算，不需要已開票。這是 B5 的重點：
 *   已請款但還沒開票的錢，舊邏輯永遠不會顯示逾期，老闆看不到「該催的錢」。
 *   `billedOn` 缺席（例如先開票才補請款、或請款被取消但開票沒撤——見
 *   routes/billings.ts 的 `invoiced_before_billed` 警告與 `unbill` 保留 invoiced_on）
 *   時退回用 `invoicedOn`：這兩種情形都代表錢已經跑出去該收了，不能因為
 *   請款日剛好沒登記就讓這筆錢從逾期清單消失。
 * 已收足一律 null（`unreceived` 的判讀見 `isFullyReceived`：部分入帳不算收足，
 * 逾期起算日不變、繼續從請款／開票日算）；兩個起算日都不存在也是 null。
 */
export function overdueDays(
  invoicedOn: string | null,
  receivedOn: string | null,
  today: string,
  basis: OverdueBasis = "invoiced",
  billedOn: string | null = null,
  unreceived?: number | null,
): number | null {
  if (isFullyReceived(receivedOn, unreceived)) return null
  const startOn = basis === "billed" ? (billedOn ?? invoicedOn) : invoicedOn
  if (!startOn) return null
  const days = diffDays(startOn, today)
  return days < 0 ? 0 : days
}

function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number)
  const [by, bm, bd] = b.split("-").map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

export type ReceivableState = "unbilled" | "billed" | "invoiced" | "overdue" | "received"

/**
 * 請款三段狀態＋逾期（B5）：已收足 > 逾期 > 已開票未入帳 > 已請款未開票 > 未請款。
 * 「逾期」的優先序蓋掉 billed／invoiced，跟 `/projects/receivables` 的 `overdueCount`
 * 定義一致（未收足且 overdueDays > 0，起算基準由呼叫端解析後傳入 `overdueDays`）。
 *
 * `received` 只給**已收足**的期別（`isFullyReceived`）：部分入帳的列維持
 * billed／invoiced／overdue 的判斷，`unreceived` 沒帶時相容舊行為（有入帳日即 received）。
 */
export function receivableState(input: {
  billedOn: string | null
  invoicedOn: string | null
  receivedOn: string | null
  overdueDays: number | null
  /** 未收（有效金額 − 實收）；見 `isFullyReceived` 對 undefined／null／數字的判讀。 */
  unreceived?: number | null
}): ReceivableState {
  if (isFullyReceived(input.receivedOn, input.unreceived)) return "received"
  if (input.overdueDays !== null && input.overdueDays > 0) return "overdue"
  if (input.invoicedOn) return "invoiced"
  if (input.billedOn) return "billed"
  return "unbilled"
}

export type ReceivableSortKey = {
  /** 該專案的未收比例（未收 ÷ 分母）；分母未知時 null，排最後。 */
  projectUnreceivedPct: number | null
  overdueDays: number | null
  projectCode: string | null
  installmentNo: number
}

/**
 * 未收款清單的排序：專案未收比例 desc → 逾期天數 desc → 編號 → 期別。
 * 比例排前面是因為清單的用途是「先追誰」：一個 90% 沒收的案子比一個
 * 5% 沒收的案子急，跟金額大小無關（金額大的案子未收 5% 也可能是保留款）。
 */
export function compareReceivables<T extends ReceivableSortKey>(a: T, b: T): number {
  const pa = a.projectUnreceivedPct
  const pb = b.projectUnreceivedPct
  if (pa !== pb) {
    if (pa === null) return 1
    if (pb === null) return -1
    if (pb !== pa) return pb - pa
  }
  const oa = a.overdueDays ?? -1
  const ob = b.overdueDays ?? -1
  if (oa !== ob) return ob - oa
  const ca = a.projectCode ?? ""
  const cb = b.projectCode ?? ""
  if (ca !== cb) return ca < cb ? -1 : 1
  return a.installmentNo - b.installmentNo
}

/* ──────────────────────────────────────────────────────────────────
 * 民國年
 * ────────────────────────────────────────────────────────────────── */

export const ROC_OFFSET = 1911

export function rocYear(adYear: number): number {
  return adYear - ROC_OFFSET
}

/** 'YYYY-MM-DD' → 'yyy.m.d'（老闆總表上的日期寫法，不補零）。 */
export function rocDate(dateKey: string | null | undefined): string | null {
  if (!dateKey) return null
  const m = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return `${Number(m[1]) - ROC_OFFSET}.${Number(m[2])}.${Number(m[3])}`
}

/** 'YYYY-MM-DD' → 'yyy.mm'（月份分組鍵）。 */
export function rocMonthKey(dateKey: string): string {
  const [y, mth] = dateKey.split("-").map(Number)
  return `${y - ROC_OFFSET}.${String(mth).padStart(2, "0")}`
}

/**
 * `?year=115` 與 `?year=2026` 都收：< 1911 視為民國年。
 * 不合法回 null（呼叫端回 400）。
 */
export function parseYearParam(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{2,4}$/.test(v)) return null
  const n = Number(v)
  const ad = n < ROC_OFFSET ? n + ROC_OFFSET : n
  if (ad < 1912 || ad > 2200) return null
  return ad
}

/* ──────────────────────────────────────────────────────────────────
 * 合約列的彙總（純函式版的 billing-store.contractTotal，給批次用）
 * ────────────────────────────────────────────────────────────────── */

export type ContractLite = {
  id?: string
  doc_type: string
  our_role: string
  title?: string | null
  amount: number | string | null
  signed_on: string | null
  created_at: string
  deleted_at?: string | null
}

export type ContractSummary = {
  /** 合約一張都沒有時 null（同 billing-store.contractTotal）。 */
  total: number | null
  base: number
  changeOrders: number
  /** 最新報價單金額（我方承攬、未作廢）；沒有就 null。 */
  latestQuotation: number | null
  /** 申請單上要印的「最新文件」：有合約用合約，否則最新報價單。 */
  latest: ContractLite | null
}

function newer(a: ContractLite, b: ContractLite): boolean {
  // 簽訂日新的優先；沒簽訂日的排後面；再比建立時間。
  if (a.signed_on !== b.signed_on) {
    if (a.signed_on === null) return false
    if (b.signed_on === null) return true
    return a.signed_on > b.signed_on
  }
  return a.created_at > b.created_at
}

export function summarizeContracts(rows: ContractLite[]): ContractSummary {
  let base = 0
  let changeOrders = 0
  let hasContract = false
  let latestContract: ContractLite | null = null
  let latestQuotationRow: ContractLite | null = null
  for (const r of rows) {
    if (r.deleted_at) continue
    if (!isOurContract(r.our_role)) continue
    const amount = toNum(r.amount) ?? 0
    if (r.doc_type === "quotation") {
      if (!latestQuotationRow || newer(r, latestQuotationRow)) latestQuotationRow = r
      continue
    }
    if (r.doc_type === "change_order") {
      hasContract = true
      changeOrders += amount
      continue
    }
    if (r.doc_type === "contract") {
      hasContract = true
      base += amount
      if (!latestContract || newer(r, latestContract)) latestContract = r
    }
  }
  return {
    total: hasContract ? base + changeOrders : null,
    base,
    changeOrders,
    latestQuotation: latestQuotationRow ? toNum(latestQuotationRow.amount) : null,
    latest: latestContract ?? latestQuotationRow,
  }
}
