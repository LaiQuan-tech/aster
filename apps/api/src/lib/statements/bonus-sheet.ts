import { parseRunLabel, quarterOf, type BonusBasis } from "../../services/bonus-run.js"
import { GridBuilder, formatCellText, thousands, type CellInput, type GridBorder, type StatementGrid } from "./grid.js"

/**
 * 「專案獎金總表」（公司現行 Excel：03-02-專案獎金總表）的格線——純函式，無 IO。
 *
 * 2026-10-27 業主：後台「專案與財務」加「獎金分潤」頁籤，格式要跟公司現行的專案獎金總表一模一樣，
 * 老闆一眼對得上原本的表。原檔有四張工作表，這裡重現其中兩張資料表：
 *   • 「未結案」：序號｜專案單號｜工程名稱｜含稅｜已收款｜已收款%｜本次請款%｜累積%｜本次請款｜累積%｜本次獎金｜
 *     獎金比例 %／總獎金｜經理｜組員1–4｜支援（姓名｜%＋金額）｜尚未分配（%＋金額）｜備註。表頭兩列＋一列 10pt 間隔列，
 *     本次欄淡綠底，有本次的列已收款欄淡藍底、灰字。
 *     2026-10-27 業主調整（與原檔不同處）：拿掉原檔 B 欄「本期標記」（期別表頭＋列上的 V），期別改寫在標題區
 *     「本期：2026. 07-09」；成員與尚未分配格改成同格兩行（上行 %、下行金額），原檔經理／組員1–3 的「本次金額」欄
 *     因此拿掉（金額已在同格）。
 *   • 「已結案」（22 欄 A–V）：序號｜專案單號｜工程名稱｜含稅｜已收款｜已收款%｜獎金比例 %／金額｜
 *     經理／組員1–4／支援（姓名｜%）｜尚未分配｜（備註）。
 *   「分配說明」（級距說明文字）與「115 7-9」（單季撥款表＝獎金季發放的匯出，lib/xlsx/bonus-runs.ts）不在這裡。
 *
 * 欄寬、列高、合併、框線（細線／表頭雙線）、字型字級、底色、紅字欄、數字格式都照原檔量出來的值。
 * 左上標誌：格子標 `logo: true`（值仍是「ASTER」當替代文字）；畫面畫 /brand/aster-logo.svg，Excel 插
 * lib/brand/aster-logo.ts 的 PNG（自製幾何字形，不是第三方素材）。
 *
 * 數字口徑（2026-10-27 業主：照原 Excel；獎金引擎同步改成含稅累計入帳×比例×個人%，所以本次金額直接用批次值）：
 *   • 系統的合約與入帳一律是**未稅**；表頭是「含稅」，金額欄（含稅／已收款／本次請款）＝未稅 ×（1＋營業稅率）
 *     四捨五入到元（同專案頁 MoneyCard 的含稅總額算法）；百分比是未稅入帳 ÷ 未稅合約，與含稅無關。
 *   • 已收款／已收款% ＝上一個已發放批次時的累計入帳（原檔 F＝E×G、I＝G＋H 的「之前」）；
 *     本次請款／本次請款% ＝之後到基準日的入帳；累積% ＝截至基準日的累計入帳比例。
 *   • 總獎金＝含稅 × 獎金比例（原檔 N＝M×E；已結案表 H＝G×D）；沒設比例的案空白。
 *   • 本次獎金＝該批次（或即時試算）該案各成員本次金額合計，成員本次金額＝批次明細的 amount
 *     （引擎算法＝含稅入帳×比例×個人%，與原檔 L＝J×M、Q＝L×P 一致）。
 *   • 不在批次內的專案（沒有成員、或試算不列的案）沒有「本次」，累計入帳都算在已收款。
 *   • 成員格下行金額（2026-10-27 業主）：本輪的列（isInThisRound）＝該成員本次金額；不在本輪的列＝該成員累計應得
 *     （批次明細的 entitled_cumulative；批次外的案用同一引擎算法即時算），數字前加「累」字。尚未分配的金額一律是
 *     累計口徑（「累」）＝成員累計應得合計 ÷ 已分配% × 未分配%（池按 % 等比分）；固定金額制沒有未分配金額。
 *   • 備註（2026-10-27 業主）：系統註記與專案說明之後，換行列出專案進行中的分潤調整（services/bonus-sheet-revisions.ts）。
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
  /** 累計應得（批次 entitled_cumulative，或批次外即時算）；算不出 null。 */
  entitled: number | null
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
  /** 分潤調整（備註換行附在後面）；沒有 null／省略。 */
  revisionNote?: string | null
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

/** 總獎金（原檔 N＝含稅×比例）：沒比例或沒合約 null。 */
export function excelPoolOf(p: Pick<BonusSheetProject, "contractTotal" | "bonusRatePct">, vatRate: number): number | null {
  const contract = taxed(p.contractTotal, vatRate)
  if (contract === null || p.bonusRatePct === null) return null
  return Math.round(contract * (p.bonusRatePct / 100))
}

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

/** 這一列算不算「本次」（本次欄上色、成員金額用本次）：有本次入帳或有本次獎金。 */
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
  const base = [
    p.basis === "legacy_pool" ? `舊制（手填獎金池${p.pool !== null ? ` ${Math.round(p.pool).toLocaleString("zh-TW")}` : ""}）` : p.basis === "fixed_amount" ? "固定金額" : null,
    p.skipped ? SKIP_TEXT[p.skipped] : null,
    overflow.length > 0 ? `其他分配：${overflow.map((m) => `${m.name ?? "—"} ${shareText(m)}`).join("、")}` : null,
    p.overpaidBy > 0 ? `超發 ${Math.round(p.overpaidBy).toLocaleString("zh-TW")}` : null,
    p.note?.trim() || null,
  ]
    .filter(Boolean)
    .join("；")
  const rev = p.revisionNote?.trim()
  return rev ? (base ? `${base}\n分潤調整：\n${rev}` : `分潤調整：\n${rev}`) : base
}

/** 成員格下行：本輪＝本次金額；否則「累」＋累計應得；沒有就空。 */
export function memberAmountLine(m: Pick<BonusSheetMember, "amount" | "entitled">, inRound: boolean): string {
  if (inRound) return m.amount === 0 ? "0" : formatCellText(Math.round(m.amount), "intRed")
  return m.entitled === null ? "" : `累 ${thousands(Math.round(m.entitled), 0)}`
}

/** 尚未分配的累計金額：成員累計應得合計 ÷ 已分配% × 未分配%；固定金額制或沒有已分配% null。 */
export function unallocatedAmountOf(p: Pick<BonusSheetProject, "members" | "unallocatedPct">): number | null {
  if (p.unallocatedPct === null) return null
  const pool = p.members.filter((m) => m.shareMode === "pool_pct")
  const allocated = pool.reduce((s, m) => s + (m.sharePct ?? 0), 0)
  if (allocated <= 0 || pool.some((m) => m.entitled === null)) return null
  const entitled = pool.reduce((s, m) => s + (m.entitled ?? 0), 0)
  return Math.round((entitled / allocated) * p.unallocatedPct)
}

/** 備註欄列高：依換行與欄寬估行數（中文字約 2 個字寬單位），至少 base。 */
export function noteRowHeight(note: string, colWidthChars: number, fontPt: number, base: number): number {
  if (!note) return base
  const perLine = Math.max(4, Math.floor((colWidthChars * 2 * 10) / (fontPt * 2.1)))
  let lines = 0
  for (const seg of note.split("\n")) {
    let w = 0
    for (const ch of seg) w += /[\u0000-\u00ff]/.test(ch) ? 1 : 2
    lines += Math.max(1, Math.ceil(w / perLine))
  }
  return Math.max(base, Math.ceil(lines * fontPt * 1.25 + 4))
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
const ORIGINAL_OPEN_COLUMNS = [
  5.82, 8.43, 8.43, 11.18, 14.91, 11.91, 8.73, 7.54, 7.54, 12.09, 6.27, 10.54, 9.45, 8.43, 8.82, 8.43, 9.91, 8.82, 8.43,
  8.43, 8.82, 8.43, 8.43, 8.82, 8.43, 8.43, 8.82, 8.43, 8.82, 8.18, 8.82, 18.82, 0.54,
]
/** 拿掉的原檔欄：B（本期標記）與經理／組員1–3 的本次金額欄（原 Q／T／W／Z）。 */
const REMOVED_OPEN_COLUMNS = new Set([1, 16, 19, 22, 25])
export const OPEN_COLUMNS = ORIGINAL_OPEN_COLUMNS.filter((_, i) => !REMOVED_OPEN_COLUMNS.has(i))

/** 經理、組員1–4、支援的欄（0 起算）：姓名｜%＋金額（同格兩行）。 */
export const OPEN_SLOTS: ReadonlyArray<{ label: string; name: number; pct: number }> = [
  { label: "經理", name: 13, pct: 14 },
  { label: "組員1", name: 15, pct: 16 },
  { label: "組員2", name: 17, pct: 18 },
  { label: "組員3", name: 19, pct: 20 },
  { label: "組員4", name: 21, pct: 22 },
  { label: "支援", name: 23, pct: 24 },
]
const O = { seq: 0, code: 1, name: 2, contract: 3, prev: 4, prevPct: 5, curPct: 6, cumPct: 7, cur: 8, cumPct2: 9, bonus: 10, rate: 11, pool: 12, unalloc: 25, note: 26 } as const
const OPEN_LAST = 26 // 備註（最後一欄只是 0.54 寬的留白欄）
export const OPEN_HEADER_ROWS = 5 // 標題 2 列＋表頭 2 列＋間隔列

function slotsOf(s: MemberSlots): Array<BonusSheetMember | null> {
  return [s.manager, ...s.team, s.support]
}

/** 成員格（同格兩行）：上行 %（固定金額制＝設定金額）、下行金額（memberAmountLine）。 */
function pctCell(m: BonusSheetMember, inRound: boolean): CellInput {
  const top =
    m.shareMode === "pool_pct"
      ? m.sharePct === null
        ? "—"
        : formatCellText(m.sharePct / 100, "pct1")
      : m.shareAmount === null
        ? "—"
        : formatCellText(Math.round(m.shareAmount), "intRed")
  const bottom = memberAmountLine(m, inRound)
  return { value: bottom ? `${top}\n${bottom}` : top, format: "text", wrap: true, size: 9 }
}

/** 尚未分配格：上行 %、下行「累」＋金額。 */
function unallocCell(p: BonusSheetProject): CellInput {
  if (p.unallocatedPct === null) return { value: null, format: "pct1" }
  const amount = unallocatedAmountOf(p)
  const top = formatCellText(p.unallocatedPct / 100, "pct1")
  return { value: amount === null ? top : `${top}\n累 ${thousands(amount, 0)}`, format: "text", wrap: true, size: 9 }
}

/** 成員 % 欄的表頭：上行 %、下行金額（本輪＝本次；「累」＝累計應得）。 */
export const MEMBER_HEAD_HINT = "%\n金額"

export function buildOpenSheet(projectsIn: readonly BonusSheetProject[], ctx: BonusSheetContext): StatementGrid {
  const g = new GridBuilder()
  const projects = sortProjects(projectsIn)

  // ── 標題（1–2 列）：A–B 文字標誌、C–F 公司名稱、G–K 本期（期別）、L–AE 表名 ──
  // 2026-10-27 業主：拿掉原檔 B 欄「本期標記」（表頭期別＋列上的 V）；期別改放標題區，本輪列的底色照舊。
  g.set(0, 0, { value: BONUS_SHEET_WORDMARK, logo: true, rowSpan: 2, colSpan: 2, bold: true, size: 18, color: NAVY, align: "center" })
  g.set(0, 2, { value: ctx.companyName, rowSpan: 2, colSpan: 4, size: 12, align: "center", border: { bottom: "thin" } })
  g.set(0, 6, { value: `本期：${ctx.periodLabel}`, rowSpan: 2, colSpan: 5, size: 11, bold: true, align: "center" })
  g.set(0, 11, { value: "獎金分配(員工自行向行政申報)", rowSpan: 2, colSpan: OPEN_LAST - 11 + 1, size: 16, align: "center", border: { bottom: "thin" } })
  for (let c = 0; c <= 1; c += 1) g.border(1, c, { bottom: "thin" })
  for (let c = 6; c <= 10; c += 1) g.border(1, c, { bottom: "double" })

  // ── 表頭（3–4 列）──
  const head = (col: number, text: string, opts: Partial<CellInput> = {}) =>
    g.set(2, col, { value: text, rowSpan: 2, bold: true, size: 10, align: "center", wrap: true, border: { left: "thin", right: "thin", top: "double", bottom: "double" }, ...opts })
  head(O.seq, "序號")
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
    head(slot.pct, MEMBER_HEAD_HINT, { size: 8, bold: false })
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
    set(O.pool, { value: excelPoolOf(p, ctx.vatRate), format: "intRed", color: RED })
    const slots = memberSlots(p.members)
    slotsOf(slots).forEach((m, i) => {
      const slot = OPEN_SLOTS[i]!
      set(slot.name, { value: m?.name ?? (m ? "—" : null), fill: GRAY_FILL, align: "center" })
      set(slot.pct, { ...(m ? pctCell(m, inRound) : { value: null, format: "pct1" }), color: RED, align: "center" })
    })
    set(O.unalloc, { ...unallocCell(p), color: RED, align: "center" })
    const note = noteOf(p, slots.overflow)
    set(O.note, { value: note || null, size: 10, wrap: true, color: BLUE_TEXT, align: "left" })
    if (inRound) sumCur += curTaxed
    sumBonus += inRound ? Math.round(p.currentBonus) : 0
    sumPool += excelPoolOf(p, ctx.vatRate) ?? 0
    rowHeights.push(noteRowHeight(note, OPEN_COLUMNS[O.note]!, 10, 34))
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
    freeze: { rows: 4, cols: 3 },
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

  g.set(0, 0, { value: BONUS_SHEET_WORDMARK, logo: true, rowSpan: 2, colSpan: 3, bold: true, size: 18, color: NAVY, align: "center", border: { bottom: "double" } })
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
    head(slot.pct, MEMBER_HEAD_HINT, { size: 8, bold: false })
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
    set(C.pool, { value: excelPoolOf(p, ctx.vatRate), format: "intRed", color: RED })
    const slots = memberSlots(p.members)
    // 已結案表沒有本次欄：成員金額一律是累計應得（「累」）。
    slotsOf(slots).forEach((m, i) => {
      const slot = CLOSED_SLOTS[i]!
      set(slot.name, { value: m?.name ?? (m ? "—" : null), fill: GRAY_FILL, align: "center" })
      set(slot.pct, { ...(m ? pctCell(m, false) : { value: null, format: "pct1" }), color: RED, align: "center" })
    })
    set(C.unalloc, { ...unallocCell(p), color: RED, align: "center" })
    const note = noteOf(p, slots.overflow)
    set(C.note, { value: note || null, size: 10, wrap: true, align: "left" })
    sumPool += excelPoolOf(p, ctx.vatRate) ?? 0
    rowHeights.push(noteRowHeight(note, CLOSED_COLUMNS[C.note]!, 10, 51))
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
