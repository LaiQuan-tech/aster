import { parseRunLabel, quarterOf, type BonusBasis } from "../../services/bonus-run.js"
import { GridBuilder, type CellFormat, type CellInput, type GridBorder, type StatementGrid } from "./grid.js"

/**
 * 「專案獎金總表」（公司現行 Excel：03-02-專案獎金總表）的格線——純函式，無 IO。
 *
 * 2026-10-27 業主：後台「專案與財務」加「獎金分潤」頁籤，格式要跟公司現行的專案獎金總表一模一樣，
 * 老闆一眼對得上原本的表。原檔有四張工作表，這裡重現其中兩張資料表：
 *   • 「未結案」（33 欄 A–AG）：序號｜日期(V)｜專案單號｜工程名稱｜含稅｜已收款｜已收款%｜本次請款%｜累積%｜
 *     本次請款｜累積%｜本次獎金｜獎金比例 %／總獎金｜經理｜組員1–3（姓名｜%｜本次金額）｜組員4｜支援（姓名｜%）｜
 *     尚未分配｜備註。表頭兩列＋一列 10pt 間隔列，本次欄（H／J／L）淡綠底，有本次的列已收款欄淡藍底、灰字。
 *   • 「已結案」（22 欄 A–V）：序號｜專案單號｜工程名稱｜含稅｜已收款｜已收款%｜獎金比例 %／金額｜
 *     經理／組員1–4／支援（姓名｜%）｜尚未分配｜（備註）。
 *   「分配說明」（級距說明文字）與「115 7-9」（單季撥款表＝獎金季發放的匯出，lib/xlsx/bonus-runs.ts）不在這裡。
 *
 * 欄寬、列高、合併、框線（細線／表頭雙線）、字型字級、底色、紅字欄、數字格式都照原檔量出來的值。
 * 原檔左上的 ASTER 標誌是圖片，repo 沒有這張標誌資產 → 用文字標誌（粗體深藍「ASTER」）佔同一位置。
 *
 * 數字口徑（照實顯示系統值，與原檔手算公式不同的地方在 docs 與回報裡列出）：
 *   • 系統的合約與入帳一律是**未稅**；表頭是「含稅」，金額欄（含稅／已收款／本次請款）＝未稅 ×（1＋營業稅率）
 *     四捨五入到元（同專案頁 MoneyCard 的含稅總額算法）；百分比是未稅入帳 ÷ 未稅合約，與含稅無關。
 *   • 已收款／已收款% ＝上一個已發放批次時的累計入帳（原檔 F＝E×G、I＝G＋H 的「之前」）；
 *     本次請款／本次請款% ＝之後到基準日的入帳；累積% ＝截至基準日的累計入帳比例。
 *   • 本次獎金＝該批次（或即時試算）該案各成員本次金額合計；總獎金＝系統獎金池（毛利制＝max(0,毛利)×比例；
 *     舊制＝手填獎金池）。原檔是「本次請款×比例」「含稅×比例」，系統 2026-10-26 起改毛利制，照實顯示系統值。
 *   • 成員：經理（manager）1 位、組員1–4（lead 主辦優先，再 member）、支援（support）1 位；
 *     多出來的成員寫進備註「其他分配：…」。組員4 與支援在原檔沒有本次金額欄，照原檔。
 */

export const BONUS_SHEET_FONT = "新細明體"

const GREEN = "#E2EFDA" // 原檔 accent6（70AD47）＋80% 淡化：本次欄
const BLUE = "#DDEBF7" // 原檔 accent5（5B9BD5）＋80% 淡化：本次列的已收款欄
const GRAY_FILL = "#E7E6E6" // 原檔 lt2：成員姓名欄
const RED = "#FF0000"
const GRAY_TEXT = "#808080" // 原檔 dk1＋50%：含稅／已收款／累積% 欄頭、本次列的已收款數字
const BLUE_TEXT = "#3333FF" // 備註
const NAVY = "#1F2F86" // 文字標誌
export const BONUS_SHEET_WORDMARK = "ASTER"

const THIN: GridBorder = { top: "thin", bottom: "thin", left: "thin", right: "thin" }

/* ──────────────────────────────────────────────────────────────────
 * 輸入模型
 * ────────────────────────────────────────────────────────────────── */

export type BonusSheetMember = {
  employeeId: string
  name: string | null
  empNo: string | null
  /** manager／lead／support／member（或 null）。 */
  role: string | null
  shareMode: string
  /** 百分點（10＝10%）。 */
  sharePct: number | null
  shareAmount: number | null
  /** 本次金額（批次或試算的 amount）。 */
  amount: number
}

export type BonusSheetProject = {
  projectId: string
  code: string | null
  name: string | null
  /** 已結案（結案／解約／封存）→ 放「已結案」表。 */
  closed: boolean
  /** 合約總額（未稅）；沒有合約 null。 */
  contractTotal: number | null
  /** 截至基準日累計入帳（未稅）。 */
  receivedTotal: number
  /** 上一個已發放批次時的累計入帳（未稅）。 */
  previousReceived: number
  /** receivedTotal − previousReceived。 */
  currentReceived: number
  /** 比例（0～1，可 >1）：累計／之前／本次 ÷ 合約。 */
  receivedRatio: number
  previousRatio: number
  currentRatio: number
  /** 百分點；null＝沒設比例。 */
  bonusRatePct: number | null
  /** 系統獎金池（毛利制或舊制手填）；固定金額或算不出 null。 */
  pool: number | null
  basis: BonusBasis | null
  /** 本次獎金（成員本次金額合計）。 */
  currentBonus: number
  /** 超發合計（>0 才寫備註）。 */
  overpaidBy: number
  /** 尚未分配（百分點）；固定金額制 null。 */
  unallocatedPct: number | null
  note: string | null
  /** 試算跳過（缺合約／缺獎金池）。 */
  skipped: "no_contract" | "no_pool" | null
  members: BonusSheetMember[]
}

export type BonusSheetContext = {
  companyName: string
  /** 營業稅率（0.05）。 */
  vatRate: number
  /** B 欄表頭，例「2026. 07-09」。 */
  periodLabel: string
  /** 本次欄日期，例「0909」。 */
  mmdd: string
}

/* ──────────────────────────────────────────────────────────────────
 * 小工具（有單元測試）
 * ────────────────────────────────────────────────────────────────── */

/** 未稅 → 含稅（到元）；null 照傳。 */
export function taxed(untaxed: number | null, vatRate: number): number | null {
  if (untaxed === null || !Number.isFinite(untaxed)) return null
  return Math.round(untaxed * (1 + vatRate))
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** B 欄表頭「2026. 07-09」：批次期別（YYYY-Qn）能解析就用它，否則用基準日所在的季。 */
export function periodLabelOf(runLabel: string | null | undefined, asOf: string): string {
  const parsed = runLabel ? parseRunLabel(runLabel) : null
  const year = parsed?.year ?? Number(asOf.slice(0, 4))
  const q = parsed?.quarter ?? quarterOf(asOf)
  return `${year}. ${pad2(q * 3 - 2)}-${pad2(q * 3)}`
}

/** 'YYYY-MM-DD' → 「0909」；slash＝「09/09」（本次獎金欄頭）。 */
export function mmddOf(asOf: string, slash = false): string {
  const mm = asOf.slice(5, 7)
  const dd = asOf.slice(8, 10)
  return slash ? `${mm}/${dd}` : `${mm}${dd}`
}

/** 這一列算不算「本次」（打 V、本次欄上色）：有本次入帳或有本次獎金。 */
export function isInThisRound(p: Pick<BonusSheetProject, "currentReceived" | "currentBonus">): boolean {
  return p.currentReceived > 0 || p.currentBonus !== 0
}

export type MemberSlots = {
  manager: BonusSheetMember | null
  /** 組員1–4（長度固定 4）。 */
  team: Array<BonusSheetMember | null>
  support: BonusSheetMember | null
  /** 放不進固定欄位的成員（寫進備註）。 */
  overflow: BonusSheetMember[]
}

const byEmployee = (a: BonusSheetMember, b: BonusSheetMember) =>
  (a.empNo ?? "").localeCompare(b.empNo ?? "") || (a.name ?? "").localeCompare(b.name ?? "") || a.employeeId.localeCompare(b.employeeId)

/** 成員依角色排欄：經理 1、組員 4（主辦優先）、支援 1，其餘進 overflow。 */
export function memberSlots(members: readonly BonusSheetMember[]): MemberSlots {
  const managers = members.filter((m) => m.role === "manager").sort(byEmployee)
  const supports = members.filter((m) => m.role === "support").sort(byEmployee)
  const rank = (role: string | null) => (role === "lead" ? 0 : role === "member" ? 1 : 2)
  const team = members
    .filter((m) => m.role !== "manager" && m.role !== "support")
    .sort((a, b) => rank(a.role) - rank(b.role) || byEmployee(a, b))
  const teamSlots: Array<BonusSheetMember | null> = team.slice(0, 4)
  while (teamSlots.length < 4) teamSlots.push(null)
  return {
    manager: managers[0] ?? null,
    team: teamSlots,
    support: supports[0] ?? null,
    overflow: [...managers.slice(1), ...team.slice(4), ...supports.slice(1)],
  }
}

function shareText(m: BonusSheetMember): string {
  if (m.shareMode === "pool_pct") return `${m.sharePct ?? 0}%`
  return Math.round(m.shareAmount ?? 0).toLocaleString("zh-TW")
}

const SKIP_TEXT = { no_contract: "未列入獎金試算：缺合約", no_pool: "未列入獎金試算：缺獎金池" } as const

/** 備註欄：系統註記（制度、跳過、多出的成員、超發）在前，專案說明在後。 */
export function noteOf(p: BonusSheetProject, overflow: readonly BonusSheetMember[]): string {
  return [
    p.basis === "legacy_pool" ? "舊制（手填獎金池）" : p.basis === "fixed_amount" ? "固定金額" : null,
    p.skipped ? SKIP_TEXT[p.skipped] : null,
    overflow.length > 0 ? `其他分配：${overflow.map((m) => `${m.name ?? "—"} ${shareText(m)}`).join("、")}` : null,
    p.overpaidBy > 0 ? `超發 ${Math.round(p.overpaidBy).toLocaleString("zh-TW")}` : null,
    p.note?.trim() || null,
  ]
    .filter(Boolean)
    .join("；")
}

/** 依專案單號、名稱排序（原檔依序號＝單號順序）。 */
export function sortProjects(projects: readonly BonusSheetProject[]): BonusSheetProject[] {
  return [...projects].sort(
    (a, b) => (a.code ?? "").localeCompare(b.code ?? "") || (a.name ?? "").localeCompare(b.name ?? "") || a.projectId.localeCompare(b.projectId),
  )
}

/* ──────────────────────────────────────────────────────────────────
 * 「未結案」
 * ────────────────────────────────────────────────────────────────── */

/** 原檔欄寬（A–AG；沒設的欄＝預設 8.43）。 */
export const OPEN_COLUMNS = [
  5.82, 8.43, 8.43, 11.18, 14.91, 11.91, 8.73, 7.54, 7.54, 12.09, 6.27, 10.54, 9.45, 8.43, 8.82, 8.43, 9.91, 8.82, 8.43,
  8.43, 8.82, 8.43, 8.43, 8.82, 8.43, 8.43, 8.82, 8.43, 8.82, 8.18, 8.82, 18.82, 0.54,
]

/** 經理、組員1–4、支援的欄（0 起算）；amount＝本次金額欄（組員4、支援沒有）。 */
export const OPEN_SLOTS: ReadonlyArray<{ label: string; name: number; pct: number; amount: number | null }> = [
  { label: "經理", name: 14, pct: 15, amount: 16 },
  { label: "組員1", name: 17, pct: 18, amount: 19 },
  { label: "組員2", name: 20, pct: 21, amount: 22 },
  { label: "組員3", name: 23, pct: 24, amount: 25 },
  { label: "組員4", name: 26, pct: 27, amount: null },
  { label: "支援", name: 28, pct: 29, amount: null },
]
const O = { seq: 0, mark: 1, code: 2, name: 3, contract: 4, prev: 5, prevPct: 6, curPct: 7, cumPct: 8, cur: 9, cumPct2: 10, bonus: 11, rate: 12, pool: 13, unalloc: 30, note: 31 } as const
const OPEN_LAST = 31 // AF（AG 只是 0.54 寬的留白欄）
export const OPEN_HEADER_ROWS = 5 // 標題 2 列＋表頭 2 列＋間隔列

function slotsOf(s: MemberSlots): Array<BonusSheetMember | null> {
  return [s.manager, ...s.team, s.support]
}

function pctCell(m: BonusSheetMember): CellInput {
  if (m.shareMode === "pool_pct") return { value: m.sharePct === null ? null : m.sharePct / 100, format: "pct1" }
  return { value: m.shareAmount === null ? null : Math.round(m.shareAmount), format: "intRed" }
}

export function buildOpenSheet(projectsIn: readonly BonusSheetProject[], ctx: BonusSheetContext): StatementGrid {
  const g = new GridBuilder()
  const projects = sortProjects(projectsIn)

  // ── 標題（1–2 列）：A–C 文字標誌、D–G 公司名稱、M–AF 表名 ──
  g.set(0, 0, { value: BONUS_SHEET_WORDMARK, rowSpan: 2, colSpan: 3, bold: true, size: 18, color: NAVY, align: "center" })
  g.set(0, 3, { value: ctx.companyName, rowSpan: 2, colSpan: 4, size: 12, align: "center", border: { bottom: "thin" } })
  g.set(0, 12, { value: "獎金分配(員工自行向行政申報)", rowSpan: 2, colSpan: OPEN_LAST - 12 + 1, size: 16, align: "center", border: { bottom: "thin" } })
  for (let c = 0; c <= 2; c += 1) g.border(1, c, { bottom: "thin" })
  for (let c = 7; c <= 11; c += 1) g.border(1, c, { bottom: "double" })

  // ── 表頭（3–4 列）──
  const head = (col: number, text: string, opts: Partial<CellInput> = {}) =>
    g.set(2, col, { value: text, rowSpan: 2, bold: true, size: 10, align: "center", wrap: true, border: { left: "thin", right: "thin", top: "double", bottom: "double" }, ...opts })
  head(O.seq, "序號")
  head(O.mark, ctx.periodLabel)
  head(O.code, "專案單號")
  head(O.name, "工程名稱")
  head(O.contract, "含稅", { color: GRAY_TEXT })
  head(O.prev, "已收款", { color: GRAY_TEXT })
  head(O.prevPct, "已收款%", { color: GRAY_TEXT })
  head(O.cumPct, "累積 %", { color: GRAY_TEXT })
  head(O.cumPct2, "累積 %", { color: GRAY_TEXT })
  // 本次三欄：上格「本次／請款%」（9pt）、下格日期，淡綠底。
  const current = (col: number, top: string, bottom: string, bold: boolean) => {
    g.set(2, col, { value: top, size: 9, bold, align: "center", wrap: true, fill: GREEN, border: { left: "thin", right: "thin", top: "thin" } })
    g.set(3, col, { value: bottom, size: 10, bold, align: "center", fill: GREEN, border: { left: "thin", right: "thin", bottom: "double" } })
  }
  current(O.curPct, "本次\n請款%", ctx.mmdd, true)
  current(O.cur, "本次\n請款", ctx.mmdd, false)
  current(O.bonus, "本次\n獎金", `${ctx.mmdd.slice(0, 2)}/${ctx.mmdd.slice(2, 4)}`, true)
  g.set(2, O.rate, { value: "獎金比例", colSpan: 2, bold: true, size: 10, align: "center", border: { left: "thin", right: "thin", top: "double", bottom: "thin" } })
  g.set(3, O.rate, { value: "%", size: 12, align: "center", border: { ...THIN, bottom: "double" } })
  g.set(3, O.pool, { value: "總獎金", size: 12, align: "center", border: { ...THIN, bottom: "double" } })
  for (const slot of OPEN_SLOTS) {
    head(slot.name, slot.label)
    for (const col of [slot.pct, slot.amount]) {
      if (col === null) continue
      g.set(2, col, { value: null, border: { left: "thin", right: "thin", top: "double" } })
      g.set(3, col, { value: null, border: { left: "thin", right: "thin", bottom: "double" } })
    }
  }
  head(O.unalloc, "尚未分配")
  head(O.note, "備註")

  // ── 間隔列（5 列，高 10）：只有左右細線，本次欄淡綠 ──
  for (let c = 0; c <= OPEN_LAST; c += 1) {
    const green = c === O.curPct || c === O.cur || c === O.bonus
    g.set(4, c, { value: null, border: { left: "thin", right: "thin" }, ...(green ? { fill: GREEN } : {}) })
  }

  // ── 資料列 ──
  let r = OPEN_HEADER_ROWS
  const rowHeights = [16.5, 17.5, 31, 21, 10]
  let sumCur = 0
  let sumBonus = 0
  let sumPool = 0
  projects.forEach((p, index) => {
    const inRound = isInThisRound(p)
    const grayText = inRound ? { color: GRAY_TEXT } : {}
    const set = (col: number, input: CellInput) => g.set(r, col, { size: 12, border: THIN, ...input })
    const curTaxed = taxed(p.currentReceived, ctx.vatRate) ?? 0
    set(O.seq, { value: index + 1, size: 8, align: "center" })
    set(O.mark, { value: inRound ? "V" : null, size: 8, align: "center" })
    set(O.code, { value: p.code ?? "", size: 8, align: "left" })
    set(O.name, { value: p.name ?? "", align: "center", wrap: true })
    set(O.contract, { value: taxed(p.contractTotal, ctx.vatRate), format: "intRed", ...grayText })
    set(O.prev, { value: taxed(p.previousReceived, ctx.vatRate), format: "intRed", ...grayText, ...(inRound ? { fill: BLUE } : {}) })
    set(O.prevPct, { value: p.contractTotal ? p.previousRatio : null, format: "pct0", ...grayText, ...(inRound ? { fill: BLUE } : {}) })
    set(O.curPct, { value: inRound && p.contractTotal ? p.currentRatio : null, format: "pct0", ...(inRound ? { fill: GREEN } : {}) })
    set(O.cumPct, { value: p.contractTotal ? p.receivedRatio : null, format: "pct0", size: 10, bold: true, ...grayText })
    set(O.cur, { value: inRound ? curTaxed : null, format: "intRed", ...(inRound ? { fill: GREEN } : {}) })
    set(O.cumPct2, { value: p.contractTotal ? p.receivedRatio : null, format: "pct0", size: 10, bold: true, ...grayText })
    set(O.bonus, { value: inRound ? Math.round(p.currentBonus) : null, format: "intRed", size: 10, bold: true, ...(inRound ? { fill: GREEN } : {}) })
    set(O.rate, { value: p.bonusRatePct === null ? null : p.bonusRatePct / 100, format: "pct1", color: RED, align: "center" })
    set(O.pool, { value: p.pool === null ? null : Math.round(p.pool), format: "intRed", color: RED })
    const slots = memberSlots(p.members)
    slotsOf(slots).forEach((m, i) => {
      const slot = OPEN_SLOTS[i]!
      set(slot.name, { value: m?.name ?? (m ? "—" : null), fill: GRAY_FILL, align: "center" })
      set(slot.pct, { ...(m ? pctCell(m) : { value: null, format: "pct1" }), color: RED, align: "center" })
      if (slot.amount !== null) set(slot.amount, { value: m && m.amount !== 0 ? Math.round(m.amount) : null, format: "intRed" })
    })
    set(O.unalloc, { value: p.unallocatedPct === null ? null : p.unallocatedPct / 100, format: "pct1", color: RED, align: "center" })
    set(O.note, { value: noteOf(p, slots.overflow) || null, size: 10, wrap: true, color: BLUE_TEXT, align: "left" })
    if (inRound) sumCur += curTaxed
    sumBonus += inRound ? Math.round(p.currentBonus) : 0
    sumPool += p.pool === null ? 0 : Math.round(p.pool)
    rowHeights.push(34)
    r += 1
  })

  // ── 合計列（原檔：本次請款、本次獎金小計，總獎金合計）──
  for (let c = 0; c <= OPEN_LAST; c += 1) g.set(r, c, { value: null, size: 12, border: THIN })
  g.set(r, O.name, { value: "合計", bold: true, align: "center" })
  for (const c of [O.prev, O.prevPct]) g.set(r, c, { fill: BLUE })
  g.set(r, O.curPct, { fill: GREEN })
  g.set(r, O.cur, { value: sumCur, format: "intRed", fill: GREEN })
  g.set(r, O.bonus, { value: sumBonus, format: "intRed", bold: true, fill: GREEN })
  g.set(r, O.pool, { value: sumPool, format: "intRed", color: RED })
  rowHeights.push(17)

  return {
    kind: "bonusSheet",
    title: "未結案",
    columns: OPEN_COLUMNS,
    rowHeights,
    font: BONUS_SHEET_FONT,
    cells: g.build(),
    freeze: { rows: 4, cols: 4 },
    page: { orientation: "landscape", paperSize: 8, printTitleRows: [1, 4] },
  }
}

/* ──────────────────────────────────────────────────────────────────
 * 「已結案」
 * ────────────────────────────────────────────────────────────────── */

export const CLOSED_COLUMNS = [
  5.82, 8.43, 8.43, 14.91, 12.18, 8.43, 8.82, 9.36, 8.82, 8.43, 8.82, 8.43, 8.82, 8.43, 8.82, 8.43, 8.82, 8.43, 8.82, 8.43, 8.82, 18.18,
]
export const CLOSED_SLOTS: ReadonlyArray<{ label: string; name: number; pct: number }> = [
  { label: "經理", name: 8, pct: 9 },
  { label: "組員1", name: 10, pct: 11 },
  { label: "組員2", name: 12, pct: 13 },
  { label: "組員3", name: 14, pct: 15 },
  { label: "組員4", name: 16, pct: 17 },
  { label: "支援", name: 18, pct: 19 },
]
const C = { seq: 0, code: 1, name: 2, contract: 3, received: 4, receivedPct: 5, rate: 6, pool: 7, unalloc: 20, note: 21 } as const
const CLOSED_LAST = 21
export const CLOSED_HEADER_ROWS = 4

export function buildClosedSheet(projectsIn: readonly BonusSheetProject[], ctx: BonusSheetContext): StatementGrid {
  const g = new GridBuilder()
  const projects = sortProjects(projectsIn)

  g.set(0, 0, { value: BONUS_SHEET_WORDMARK, rowSpan: 2, colSpan: 3, bold: true, size: 18, color: NAVY, align: "center", border: { bottom: "double" } })
  g.set(0, 3, { value: `${ctx.companyName} (已結案) 獎金分配(員工自行向行政申報)`, rowSpan: 2, colSpan: 17 - 3 + 1, size: 12, align: "center", border: { bottom: "double" } })

  const head = (col: number, text: string | null, opts: Partial<CellInput> = {}) =>
    g.set(2, col, { value: text, rowSpan: 2, bold: true, size: 10, align: "center", wrap: true, border: { left: "thin", right: "thin", top: "double", bottom: "double" }, ...opts })
  head(C.seq, "序號")
  head(C.code, "專案單號")
  head(C.name, "工程名稱")
  head(C.contract, "含稅")
  head(C.received, "已收款")
  head(C.receivedPct, "已收款%")
  g.set(2, C.rate, { value: "獎金比例", colSpan: 2, bold: true, size: 10, align: "center", border: { left: "thin", right: "thin", top: "double", bottom: "double" } })
  g.set(3, C.rate, { value: "%", size: 12, align: "center", border: THIN })
  g.set(3, C.pool, { value: "金額", size: 12, align: "center", border: THIN })
  for (const slot of CLOSED_SLOTS) {
    head(slot.name, slot.label, { fill: GRAY_FILL })
    head(slot.pct, null)
  }
  head(C.unalloc, "尚未分配", { fill: GRAY_FILL })
  head(C.note, null)

  let r = CLOSED_HEADER_ROWS
  const rowHeights = [16.25, 17.5, 20, 21]
  let sumPool = 0
  projects.forEach((p, index) => {
    const set = (col: number, input: CellInput) => g.set(r, col, { size: 12, border: THIN, ...input })
    set(C.seq, { value: index + 1, size: 8, align: "center" })
    set(C.code, { value: p.code ?? "", size: 8, align: "left" })
    set(C.name, { value: p.name ?? "", wrap: true, align: "left" })
    set(C.contract, { value: taxed(p.contractTotal, ctx.vatRate), format: "intRed" })
    set(C.received, { value: taxed(p.receivedTotal, ctx.vatRate), format: "intRed" })
    set(C.receivedPct, { value: p.contractTotal ? p.receivedRatio : null, format: "pct0" })
    set(C.rate, { value: p.bonusRatePct === null ? null : p.bonusRatePct / 100, format: "pct1", color: RED, align: "center" })
    set(C.pool, { value: p.pool === null ? null : Math.round(p.pool), format: "intRed", color: RED })
    const slots = memberSlots(p.members)
    slotsOf(slots).forEach((m, i) => {
      const slot = CLOSED_SLOTS[i]!
      set(slot.name, { value: m?.name ?? (m ? "—" : null), fill: GRAY_FILL, align: "center" })
      set(slot.pct, { ...(m ? pctCell(m) : { value: null, format: "pct1" as CellFormat }), color: RED, align: "center" })
    })
    set(C.unalloc, { value: p.unallocatedPct === null ? null : p.unallocatedPct / 100, format: "pct1", color: RED, align: "center" })
    set(C.note, { value: noteOf(p, slots.overflow) || null, size: 10, wrap: true, align: "left" })
    sumPool += p.pool === null ? 0 : Math.round(p.pool)
    rowHeights.push(51)
    r += 1
  })
  for (let c = 0; c <= CLOSED_LAST; c += 1) g.set(r, c, { value: null, size: 12, border: THIN })
  g.set(r, C.name, { value: "合計", bold: true, align: "center" })
  g.set(r, C.pool, { value: sumPool, format: "intRed", color: RED })
  rowHeights.push(17)

  return {
    kind: "bonusSheet",
    title: "已結案",
    columns: CLOSED_COLUMNS,
    rowHeights,
    font: BONUS_SHEET_FONT,
    cells: g.build(),
    freeze: { rows: 4, cols: 3 },
    page: { orientation: "landscape", paperSize: 9, printTitleRows: [1, 4] },
  }
}
