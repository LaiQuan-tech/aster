import { isValidTaiwanTaxId, TAX_ID_RE } from "./tax-id.js"

/**
 * 客供商名冊資料搬遷（2026-10-27，packages/db 0076 之後）——純函式，不碰 DB、不讀檔。
 *
 * 背景：2026-10-12 把業主兩份「客供商基本資料」Excel 匯進正式租戶時，系統沒有的欄位（FAX、區域、細目、付款方式…）
 * 擠進了備註，承辦窗口／Mobil／E-mail 也被拆過。0076 補齊欄位後，這裡依 Excel 原格把那批記錄的欄位重新填好：
 *   • 只碰備註裡有匯入標記〔…由客供商基本資料匯入…〕的記錄；以「名稱＋簡稱＋統編」對到 Excel 列，一對一，不新增記錄。
 *   • 匯入後沒人改過（updated_at 與 created_at 相差 ≤ 2 分鐘）→ Excel 有對應欄的欄位一律改成 Excel 原格；
 *     匯入後有人改過 → 只補空欄位，值不同的列進「衝突」清單（只記欄位名），不覆蓋。
 *   • 備註：移除「已確認搬進欄位」的匯入行（逐字比對 Excel 原格，對不上就留著），保留匯入標記行、
 *     人工加的內容與無法搬的說明行；Excel「備註」原文放在備註最前面。
 *   • 帳號／密碼／登入網址類的儲存格一律不讀、不寫（該欄維持原值），只計數。
 *   • Excel 有、系統沒有的列另列清單（不自動新增）。
 * 執行端：docs/test/roster-excel-fields-migrate.ts（讀 Excel、讀唯讀匯出的 DB JSON、印摘要、可輸出 SQL 計畫檔）。
 */

export type RosterSheetKind = "client" | "supplier" | "engineer" | "review_unit"
export type VendorRosterKind = Exclude<RosterSheetKind, "client">

/** Excel 工作表名稱 → 名冊（「Sheet1」是客戶編號編製說明，不是資料）。 */
export const SHEET_KINDS: Record<string, RosterSheetKind> = {
  客戶資料: "client",
  供應商資料: "supplier",
  技師資料: "engineer",
  送審相關單位: "review_unit",
}

export interface ExcelRosterRow {
  /** new＝新版（業主最新一份）、old＝2023 舊版（只有供應商資料、欄位較少）。 */
  file: "new" | "old"
  sheet: string
  kind: RosterSheetKind
  /** Excel 列號（1 起算），只用來回報。 */
  rowNumber: number
  /** 正規化表頭（見 headerKey）→ 儲存格字串（已 trim；空格＝不存在這個鍵）。 */
  cells: Record<string, string>
  /** 這份檔案有哪些欄（正規化表頭）。舊版缺的欄＝「不知道」，不是「空白」。 */
  headers: string[]
}

export interface DbVendorRow {
  id: string
  tenant_id: string
  name: string
  short_name?: string | null
  roster_kind?: string | null
  seq?: number | null
  category?: string | null
  sub_category?: string | null
  code?: string | null
  contact_name?: string | null
  title?: string | null
  phone?: string | null
  fax?: string | null
  mobile?: string | null
  email?: string | null
  address?: string | null
  tax_id?: string | null
  payment_terms?: string | null
  website?: string | null
  note?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface DbClientRow {
  id: string
  tenant_id: string
  name: string
  short_name?: string | null
  seq?: number | null
  region?: string | null
  code?: string | null
  phone?: string | null
  fax?: string | null
  contact_name?: string | null
  contact_phone?: string | null
  email?: string | null
  invoice_address?: string | null
  tax_id?: string | null
  payment_method?: string | null
  note?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

/* ── 儲存格／字串工具 ─────────────────────────────────────────────── */

/** 表頭正規化：拿掉所有空白（含全形對齊空白）、轉小寫（「E-mail」「e-mail」同一欄）。 */
export function headerKey(raw: unknown): string {
  return String(raw ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase()
}

/** exceljs 的儲存格值 → 字串（富文字串接、超連結取顯示字、公式取結果、整數不帶小數點）。 */
export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v.trim()
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : ""
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: unknown }>).map((r) => String(r.text ?? "")).join("").trim()
    if ("result" in o) return cellToString(o.result)
    if ("text" in o) return cellToString(o.text)
    if ("error" in o) return ""
  }
  return String(v).trim()
}

/** 帳號／密碼類憑證：這種儲存格整格不讀、不寫。 */
const CREDENTIAL_RE = /密碼|帳密|帳號|password|passwd|pwd|login|登入|(^|[^a-z])id\s*[:：]/i
export function isCredentialText(s: string): boolean {
  return CREDENTIAL_RE.test(s)
}

/** 登入頁類網址（IP 主機、帶連接埠、路徑像登入／後台）：不放進「網址」欄。 */
export function looksLikeLoginUrl(s: string): boolean {
  const v = s.trim()
  if (!v) return false
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(v)) return true
  if (/:\d{2,5}(\/|$)/.test(v.replace(/^https?:\/\//i, ""))) return true
  return /login|signin|sign-in|admin|portal|erp|webmail|帳號|密碼/i.test(v)
}

/** 比對用正規化：NFKC、小寫、拿掉空白、各式橫線統一。 */
export function norm(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/[‐-―−ー]/g, "-")
}
const digitsOf = (s: string) => s.replace(/\D/g, "")

/** Excel 統編 → 8 碼；Excel 數字格吃掉前導 0 的 7 碼補回。其餘形狀回 null（不寫）。 */
export function normalizeTaxId(raw: string): string | null {
  const s = raw.trim()
  if (/^\d{7}$/.test(s)) return `0${s}`
  return TAX_ID_RE.test(s) ? s : null
}

/* ── 匯入標記與備註 ───────────────────────────────────────────────── */

export const IMPORT_MARKER_RE = /〔[^〕]*由客供商基本資料匯入[^〕]*〕/
export const hasImportMarker = (note: string | null | undefined) => IMPORT_MARKER_RE.test(note ?? "")
const isOldVersionImport = (note: string | null | undefined) => /〔[^〕]*由客供商基本資料匯入[^〕]*舊版[^〕]*〕/.test(note ?? "")

/**
 * 10/12 匯入寫進備註、內容其實是某幾欄 Excel 原格的行（標籤 → 要比對的 Excel 欄）。
 * 0076 之後這些內容都有自己的欄位了；逐字確認在 Excel 原格裡才移除。
 */
const CONTACT_HEADERS = ["承辦窗口", "mobil", "e-mail", "tel"]
const MOVABLE_LABELS: Record<string, string[]> = {
  區域: ["區域"],
  傳真: ["fax"],
  主要窗口補充: CONTACT_HEADERS,
  其他窗口: CONTACT_HEADERS,
  未對應到窗口的聯絡資料: CONTACT_HEADERS,
  備註: ["備註"],
  付款方式: ["付款方式"],
  收款方式: ["收款方式"],
  編號: ["編號"],
  細目: ["細目"],
  "e-mail原文": ["e-mail"],
  mobil原文: ["mobil"],
}
/** 匯入時自己加的說明字，不算資料（比對時忽略）。 */
const STOPWORDS = new Set(
  ["分機", "手機", "電話", "市話", "傳真", "職稱", "窗口", "主要", "其他", "補充", "email", "e-mail", "mail", "mobil", "mobile", "tel", "fax", "ext", "原文", "未能完整拆解", "line"].map(norm),
)

const LABEL_RE = /^([^：:（(]{1,20})(?:[（(][^）)]*[）)])?\s*[：:]\s*(.*)$/

/** 這一行的內容是否全都找得到出處（haystack＝該列 Excel 對應欄的原格）。 */
function verifiedIn(value: string, haystack: string[]): boolean {
  const hay = norm(haystack.join("\n"))
  const hayDigits = digitsOf(haystack.join("\n"))
  if (!hay) return false
  const tokens = value
    .split(/[\s，,、；;／/｜|()（）:：#＃]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(norm(t)))
  if (tokens.length === 0) return false
  return tokens.every((t) => hay.includes(norm(t)) || (digitsOf(t).length >= 4 && hayDigits.includes(digitsOf(t))))
}

export interface NoteRebuild {
  note: string | null
  removed: number
  kept: number
  remarkAdded: boolean
}

/**
 * 重組備註：Excel「備註」原文（有的話）＋ 保留的行 ＋ 匯入標記行。
 * `cells`＝該列 Excel 原格（已剔除憑證格）；`remark`＝要放進備註的 Excel「備註」原文（null＝這份檔沒有／不寫）。
 * `settled`＝「搬遷後欄位最終值確實等於 Excel 原格」的表頭。一行匯入內容只有在它對應的每一欄（Excel 有值的）
 * 都 settled 時才刪——衝突沒覆蓋、被拒寫、超長、憑證略過、對應不到的值，該行一律保留。省略＝cells 全部視為 settled。
 */
export function rebuildNote(
  note: string | null | undefined,
  cells: Record<string, string>,
  remark: string | null,
  settled: Set<string> = new Set(Object.keys(cells)),
): NoteRebuild {
  const lines = String(note ?? "").split(/\r?\n/)
  const markers: string[] = []
  const kept: string[] = []
  let removed = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (IMPORT_MARKER_RE.test(line)) {
      markers.push(line)
      continue
    }
    const m = LABEL_RE.exec(line)
    const base = m ? norm(m[1]) : ""
    const sources = m ? MOVABLE_LABELS[Object.keys(MOVABLE_LABELS).find((k) => norm(k) === base) ?? ""] : undefined
    if (m && sources) {
      const withValue = sources.filter((h) => !!cells[h])
      const allSettled = withValue.length > 0 && withValue.every((h) => settled.has(h))
      const hay = withValue.map((h) => cells[h])
      if (allSettled && verifiedIn(m[2], hay)) {
        removed += 1
        continue
      }
    }
    kept.push(line)
  }
  const remarkText = remark?.trim() || ""
  const remarkAdded = !!remarkText && !kept.some((l) => norm(l) === norm(remarkText))
  const out = [...(remarkAdded ? [remarkText] : []), ...kept, ...markers].join("\n").trim()
  return { note: out || null, removed, kept: kept.length, remarkAdded }
}

/* ── 對應規則 ─────────────────────────────────────────────────────── */

type FieldRule = { header: string; column: string; max?: number; type?: "int" | "text" }

/** 廠商三個工作表共用（16 欄）。統編、備註、網址另有特別處理。 */
const VENDOR_RULES: FieldRule[] = [
  { header: "簡稱", column: "short_name", max: 40 },
  { header: "序", column: "seq", type: "int" },
  { header: "類別", column: "category", max: 60 },
  { header: "細目", column: "sub_category", max: 60 },
  { header: "編號", column: "code", max: 40 },
  { header: "公司名稱", column: "name", max: 120 },
  { header: "tel", column: "phone", max: 200 },
  { header: "fax", column: "fax", max: 200 },
  { header: "承辦窗口", column: "contact_name", max: 300 },
  { header: "mobil", column: "mobile", max: 200 },
  { header: "e-mail", column: "email", max: 500 },
  { header: "公司地址", column: "address", max: 300 },
  { header: "付款方式", column: "payment_terms", max: 100 },
  { header: "網址", column: "website", max: 200 },
]
/** 客戶資料（14 欄）。 */
const CLIENT_RULES: FieldRule[] = [
  { header: "簡稱", column: "short_name", max: 40 },
  { header: "序", column: "seq", type: "int" },
  { header: "區域", column: "region", max: 40 },
  { header: "編號", column: "code", max: 40 },
  { header: "公司名稱", column: "name", max: 200 },
  { header: "tel", column: "phone", max: 200 },
  { header: "fax", column: "fax", max: 200 },
  { header: "承辦窗口", column: "contact_name", max: 300 },
  { header: "mobil", column: "contact_phone", max: 200 },
  { header: "e-mail", column: "email", max: 500 },
  { header: "公司地址", column: "invoice_address", max: 300 },
]
const CLIENT_PAYMENT: Record<string, string> = { 匯款: "transfer", 轉帳: "transfer", 支票: "check" }

export type PlanValue = string | number | null

export interface PlannedUpdate {
  table: "vendors" | "clients"
  id: string
  tenantId: string
  /** 匯出 DB 當下的 updated_at；SQL 計畫以它做樂觀鎖，期間有人改過就整批回滾。 */
  seenUpdatedAt: string
  set: Record<string, PlanValue>
  source: { file: "new" | "old"; sheet: string; rowNumber: number }
}

export interface PlannedInsert {
  table: "vendors" | "clients"
  tenantId: string
  values: Record<string, PlanValue>
  source: { file: "new" | "old"; sheet: string; rowNumber: number }
}

export interface RosterPlanOptions {
  /** 只處理這個租戶（其他租戶的列一律忽略）；要新增記錄時必填。 */
  tenantId?: string
  /** 新版 Excel 有、系統沒有的列：新增（舊版沒對到的列永遠不新增）。 */
  insertUnmatchedNew?: boolean
  /** 新增記錄備註最後一行的匯入標記。 */
  insertMarker?: string
}

export const DEFAULT_INSERT_MARKER = "〔2026-10-27 由客供商基本資料匯入（補建）〕"

export interface RosterPlan {
  updates: PlannedUpdate[]
  /** 新增的記錄（業主決定補建的新版列）。 */
  inserts: PlannedInsert[]
  /** 已比對到、但沒有任何欄位要改的記錄數。 */
  unchanged: number
  matched: { vendors: number; clients: number }
  /** Excel 有、系統沒有（不自動新增）。 */
  unmatchedExcel: Array<{ file: "new" | "old"; sheet: string; rowNumber: number }>
  /** 一列對到多筆（或多列搶同一筆）、分數相同：不動，人工看。 */
  ambiguousExcel: Array<{ file: "new" | "old"; sheet: string; rowNumber: number }>
  /** 有匯入標記、卻沒有任何 Excel 列對得上的記錄。 */
  unmatchedDb: Array<{ table: "vendors" | "clients"; id: string }>
  /** 沒有名稱（簡稱、公司名稱都空）的 Excel 列，略過。 */
  namelessRows: number
  skippedCredentialCells: number
  skippedLoginUrls: number
  /** 匯入後有人改過的記錄：只補空欄位。 */
  editedAfterImport: Array<{ table: "vendors" | "clients"; id: string }>
  /** 改過的記錄裡 Excel 與現值不同、沒覆蓋的欄位。 */
  conflicts: Array<{ table: "vendors" | "clients"; id: string; column: string }>
  /** Excel 值不合格（統編檢查碼錯、超長、重複統編…）沒寫的欄位。 */
  rejected: Array<{ table: "vendors" | "clients"; id: string; column: string; reason: string }>
  notes: { linesRemoved: number; linesKept: number; remarksAdded: number }
}

/* ── 比對 ─────────────────────────────────────────────────────────── */

export function vendorKindOf(row: Pick<DbVendorRow, "roster_kind" | "category">): VendorRosterKind {
  if (row.roster_kind === "engineer" || row.roster_kind === "review_unit" || row.roster_kind === "supplier") {
    // 0076 剛套時預設都是 supplier，類別前綴（10/12 匯入的寫法）比較準
    if (row.roster_kind !== "supplier") return row.roster_kind
  }
  const c = row.category ?? ""
  if (c.startsWith("技師／")) return "engineer"
  if (c.startsWith("送審單位／") || c.startsWith("送審相關單位／")) return "review_unit"
  return "supplier"
}

type Candidate = { id: string; name: string; short: string; tax: string; kind: RosterSheetKind; old: boolean }

function scorePair(row: ExcelRosterRow, c: Candidate): number {
  if ((row.kind === "client") !== (c.kind === "client")) return 0
  const exName = norm(row.cells["公司名稱"])
  const exShort = norm(row.cells["簡稱"])
  const exTax = row.cells["統編"] ? normalizeTaxId(row.cells["統編"]) ?? "" : ""
  let score = 0
  if (exName && c.name === exName) score += 4
  else if (!exName && exShort && c.name === exShort) score += 3
  if (exShort && c.short === exShort) score += 2
  if (exTax && c.tax === exTax) score += 3
  if (score > 0 && row.kind !== "client" && row.kind !== c.kind) score -= 1
  return score
}
const MIN_SCORE = 4

function assign(rows: ExcelRosterRow[], cands: Candidate[], taken: Set<string>) {
  const pairs: Array<{ r: number; c: number; s: number }> = []
  rows.forEach((row, r) =>
    cands.forEach((cand, c) => {
      if (taken.has(cand.id)) return
      const s = scorePair(row, cand)
      if (s >= MIN_SCORE) pairs.push({ r, c, s })
    }),
  )
  pairs.sort((a, b) => b.s - a.s)
  const rowDone = new Set<number>()
  const result = new Map<number, number>()
  const ambiguous = new Set<number>()
  for (const p of pairs) {
    if (rowDone.has(p.r) || taken.has(cands[p.c].id)) continue
    const rivals = pairs.filter(
      (q) => q.s === p.s && ((q.r === p.r && q.c !== p.c && !taken.has(cands[q.c].id)) || (q.c === p.c && q.r !== p.r && !rowDone.has(q.r))),
    )
    if (rivals.length > 0) {
      ambiguous.add(p.r)
      rowDone.add(p.r)
      for (const q of rivals) if (q.c === p.c) {
        ambiguous.add(q.r)
        rowDone.add(q.r)
      }
      continue
    }
    rowDone.add(p.r)
    taken.add(cands[p.c].id)
    result.set(p.r, p.c)
  }
  return { result, ambiguous }
}

/* ── 欄位計畫 ─────────────────────────────────────────────────────── */

const EDIT_GRACE_MS = 2 * 60 * 1000
export function editedAfterImport(row: { created_at: string; updated_at: string }): boolean {
  return Date.parse(row.updated_at) - Date.parse(row.created_at) > EDIT_GRACE_MS
}
const same = (a: unknown, b: unknown) => (a === "" ? null : a ?? null) === (b === "" ? null : b ?? null)

interface BuildCtx {
  plan: RosterPlan
  table: "vendors" | "clients"
  db: Record<string, unknown> & { id: string; note?: string | null; title?: string | null }
  row: ExcelRosterRow
  edited: boolean
  /** 因為是憑證而略過的表頭：維持現值，不當成「Excel 是空白」。 */
  skipped: Set<string>
  set: Record<string, PlanValue>
  /** 表頭 → 依 Excel 該寫成的欄位值（有提議過的才有）；備註刪行前比對最終值用。 */
  expected: Map<string, { column: string; value: PlanValue }>
  /** 被拒寫的 Excel 原格（新增記錄時寫進備註，不讓資料消失）。 */
  rejectedRaw: Array<{ header: string; raw: string }>
  /** 新增記錄才有：備註最後一行的匯入標記。 */
  insertMarker?: string
}

/** 一欄的提議值；套用「沒人改過才覆蓋」規則，記錄衝突。 */
function propose(ctx: BuildCtx, column: string, value: PlanValue, header?: string) {
  if (header) ctx.expected.set(header, { column, value })
  const current = ctx.db[column]
  if (same(current, value)) return
  const currentEmpty = current === null || current === undefined || current === ""
  if (ctx.edited && !currentEmpty) {
    ctx.plan.conflicts.push({ table: ctx.table, id: ctx.db.id, column })
    return
  }
  // name 是 NOT NULL：Excel 公司名稱空白時不清（缺全名的那批維持用簡稱當名稱）
  if (column === "name" && (value === null || value === "")) return
  ctx.set[column] = value
}

function applyRules(ctx: BuildCtx, rules: FieldRule[], cells: Record<string, string>) {
  for (const rule of rules) {
    if (!ctx.row.headers.includes(rule.header)) continue // 這份檔沒有這一欄＝不知道，不動
    if (ctx.skipped.has(rule.header)) continue
    const raw = cells[rule.header] ?? ""
    if (rule.type === "int") {
      if (!raw) propose(ctx, rule.column, null, rule.header)
      else if (/^\d{1,5}$/.test(raw)) propose(ctx, rule.column, Number(raw), rule.header)
      else reject(ctx, rule.column, "not_integer", rule.header, raw)
      continue
    }
    if (rule.column === "website" && raw && looksLikeLoginUrl(raw)) {
      ctx.plan.skippedLoginUrls += 1
      continue
    }
    if (rule.max && raw.length > rule.max) {
      reject(ctx, rule.column, "too_long", rule.header, raw)
      continue
    }
    propose(ctx, rule.column, raw || null, rule.header)
  }
}

function reject(ctx: BuildCtx, column: string, reason: string, header: string, raw: string) {
  ctx.plan.rejected.push({ table: ctx.table, id: ctx.db.id, column, reason })
  ctx.rejectedRaw.push({ header, raw })
}

const newCtx = (plan: RosterPlan, table: "vendors" | "clients", db: unknown, row: ExcelRosterRow, edited: boolean, skipped: Set<string>, insertMarker?: string): BuildCtx => ({
  plan, table, db: db as BuildCtx["db"], row, edited, skipped, set: {}, expected: new Map(), rejectedRaw: [], insertMarker,
})

/** 剔除憑證格（計數）：回傳可用的儲存格，與因憑證而略過的表頭（那幾欄維持現值，不當成「Excel 是空白」）。 */
function safeCells(plan: RosterPlan, row: ExcelRosterRow): { cells: Record<string, string>; skipped: Set<string> } {
  const cells: Record<string, string> = {}
  const skipped = new Set<string>()
  for (const [h, v] of Object.entries(row.cells)) {
    if (isCredentialText(v)) {
      plan.skippedCredentialCells += 1
      skipped.add(h)
      continue
    }
    cells[h] = v
  }
  return { cells, skipped }
}

function buildVendor(plan: RosterPlan, db: DbVendorRow, row: ExcelRosterRow, edited: boolean, insertMarker?: string): Record<string, PlanValue> {
  const { cells, skipped } = safeCells(plan, row)
  const ctx = newCtx(plan, "vendors", db, row, edited, skipped, insertMarker)
  if (row.kind !== "client") propose(ctx, "roster_kind", row.kind)
  applyRules(ctx, VENDOR_RULES, cells)
  // 統編：不唯一、不驗檢查碼（廠商名冊既有規則），但要是 8 碼
  if (row.headers.includes("統編") && !skipped.has("統編")) {
    const raw = cells["統編"] ?? ""
    const tax = raw ? normalizeTaxId(raw) : null
    if (raw && !tax) reject(ctx, "tax_id", "not_8_digits", "統編", raw)
    else propose(ctx, "tax_id", tax, "統編")
  }
  // 職稱：10/12 從承辦窗口／細目拆出來的；原格回到 contact_name／sub_category 後就重複了
  if (!edited && db.title && ["承辦窗口", "細目"].some((h) => norm(cells[h]).includes(norm(db.title)))) propose(ctx, "title", null)
  const remark = row.headers.includes("備註") && !skipped.has("備註") ? cells["備註"] ?? null : null
  noteStep(ctx, cells, remark)
  return ctx.set
}

function buildClient(plan: RosterPlan, db: DbClientRow, row: ExcelRosterRow, edited: boolean, taxOwners: Map<string, string>, insertMarker?: string): Record<string, PlanValue> {
  const { cells, skipped } = safeCells(plan, row)
  const ctx = newCtx(plan, "clients", db, row, edited, skipped, insertMarker)
  applyRules(ctx, CLIENT_RULES, cells)
  // 統編：客戶要過檢查碼且同租戶唯一；不合格就維持現值（例：一格兩個統編）
  if (row.headers.includes("統編") && !skipped.has("統編")) {
    const raw = cells["統編"] ?? ""
    const tax = raw ? normalizeTaxId(raw) : null
    if (raw && (!tax || !isValidTaiwanTaxId(tax))) reject(ctx, "tax_id", "invalid_tax_id", "統編", raw)
    else if (tax && taxOwners.has(`${db.tenant_id}:${tax}`) && taxOwners.get(`${db.tenant_id}:${tax}`) !== db.id)
      reject(ctx, "tax_id", "tax_id_taken", "統編", raw)
    else {
      const before = ctx.set.tax_id
      propose(ctx, "tax_id", tax, "統編")
      if (ctx.set.tax_id !== before && tax) taxOwners.set(`${db.tenant_id}:${tax}`, db.id)
    }
  }
  if (row.headers.includes("收款方式") && !skipped.has("收款方式")) {
    const raw = cells["收款方式"] ?? ""
    if (!raw) propose(ctx, "payment_method", null, "收款方式")
    else if (CLIENT_PAYMENT[raw]) propose(ctx, "payment_method", CLIENT_PAYMENT[raw], "收款方式")
    else reject(ctx, "payment_method", "unknown_payment_method", "收款方式", raw)
  }
  const remark = row.headers.includes("備註") && !skipped.has("備註") ? cells["備註"] ?? null : null
  noteStep(ctx, cells, remark)
  return ctx.set
}

/** 最終值（這次要寫的，或沒動就是現值）確實等於 Excel 原格的表頭。 */
function settledHeaders(ctx: BuildCtx, remark: string | null): Set<string> {
  const out = new Set<string>()
  for (const [header, { column, value }] of ctx.expected) {
    const final = column in ctx.set ? ctx.set[column] : (ctx.db[column] as PlanValue | undefined)
    if (same(final, value)) out.add(header)
  }
  if (remark !== null) out.add("備註")
  return out
}

function noteStep(ctx: BuildCtx, cells: Record<string, string>, remark: string | null) {
  if (ctx.insertMarker) {
    // 新增記錄：Excel 備註＋被拒寫的原格（例：一格兩個統編）＋匯入標記；憑證格從來不進來
    const lines = [remark?.trim() || "", ...ctx.rejectedRaw.map((r) => `${r.header}（Excel 原格，未寫入欄位）：${r.raw}`), ctx.insertMarker].filter(Boolean)
    ctx.set.note = lines.join("\n")
    if (remark?.trim()) ctx.plan.notes.remarksAdded += 1
    return
  }
  const r = rebuildNote(ctx.db.note, cells, remark, settledHeaders(ctx, remark))
  if (!same(r.note, ctx.db.note ?? null)) {
    ctx.set.note = r.note
    ctx.plan.notes.linesRemoved += r.removed
    if (r.remarkAdded) ctx.plan.notes.remarksAdded += 1
  }
  ctx.plan.notes.linesKept += r.kept
}

/* ── 主流程 ───────────────────────────────────────────────────────── */

export function planRosterMigration(
  input: { rows: ExcelRosterRow[]; vendors: DbVendorRow[]; clients: DbClientRow[] },
  opts: RosterPlanOptions = {},
): RosterPlan {
  if (opts.insertUnmatchedNew && !opts.tenantId) throw new Error("insertUnmatchedNew 需要 tenantId")
  const plan: RosterPlan = {
    updates: [], inserts: [], unchanged: 0, matched: { vendors: 0, clients: 0 },
    unmatchedExcel: [], ambiguousExcel: [], unmatchedDb: [], namelessRows: 0,
    skippedCredentialCells: 0, skippedLoginUrls: 0, editedAfterImport: [], conflicts: [], rejected: [],
    notes: { linesRemoved: 0, linesKept: 0, remarksAdded: 0 },
  }
  const inTenant = (r: { tenant_id: string }) => !opts.tenantId || r.tenant_id === opts.tenantId
  const liveVendors = input.vendors.filter((v) => !v.deleted_at && inTenant(v))
  const liveClients = input.clients.filter((c) => !c.deleted_at && inTenant(c))
  const vendorById = new Map(liveVendors.map((v) => [v.id, v]))
  const clientById = new Map(liveClients.map((c) => [c.id, c]))
  const taxOwners = new Map(liveClients.filter((c) => c.tax_id).map((c) => [`${c.tenant_id}:${c.tax_id}`, c.id]))

  const cands: Candidate[] = [
    ...liveVendors.filter((v) => hasImportMarker(v.note)).map((v) => ({
      id: v.id, name: norm(v.name), short: norm(v.short_name), tax: v.tax_id ?? "", kind: vendorKindOf(v) as RosterSheetKind, old: isOldVersionImport(v.note),
    })),
    ...liveClients.filter((c) => hasImportMarker(c.note)).map((c) => ({
      id: c.id, name: norm(c.name), short: norm(c.short_name), tax: c.tax_id ?? "", kind: "client" as RosterSheetKind, old: false,
    })),
  ]

  const named = input.rows.filter((r) => {
    const ok = !!(r.cells["公司名稱"] || r.cells["簡稱"])
    if (!ok) plan.namelessRows += 1
    return ok
  })
  const newRows = named.filter((r) => r.file === "new")
  const oldRows = named.filter((r) => r.file === "old")
  const taken = new Set<string>()

  const matchedPairs: Array<{ row: ExcelRosterRow; cand: Candidate }> = []
  const pass1 = assign(newRows, cands, taken)
  newRows.forEach((row, i) => {
    const c = pass1.result.get(i)
    if (c !== undefined) matchedPairs.push({ row, cand: cands[c] })
    else (pass1.ambiguous.has(i) ? plan.ambiguousExcel : plan.unmatchedExcel).push({ file: row.file, sheet: row.sheet, rowNumber: row.rowNumber })
  })
  // 舊版列只拿來對「標記為舊版匯入」、而且新版沒對到的記錄；跟新版同名的舊版列不算「系統沒有」。
  const oldCands = cands.filter((c) => c.old)
  const pass2 = assign(oldRows, oldCands, taken)
  const newNames = new Set(newRows.flatMap((r) => [norm(r.cells["公司名稱"]), norm(r.cells["簡稱"])]).filter(Boolean))
  oldRows.forEach((row, i) => {
    const c = pass2.result.get(i)
    if (c !== undefined) matchedPairs.push({ row, cand: oldCands[c] })
    else if (pass2.ambiguous.has(i)) plan.ambiguousExcel.push({ file: row.file, sheet: row.sheet, rowNumber: row.rowNumber })
    else if (!newNames.has(norm(row.cells["公司名稱"])) && !newNames.has(norm(row.cells["簡稱"])))
      plan.unmatchedExcel.push({ file: row.file, sheet: row.sheet, rowNumber: row.rowNumber })
  })

  for (const c of cands) if (!taken.has(c.id)) plan.unmatchedDb.push({ table: c.kind === "client" ? "clients" : "vendors", id: c.id })

  for (const { row, cand } of matchedPairs) {
    const isClient = cand.kind === "client"
    const db = isClient ? clientById.get(cand.id)! : vendorById.get(cand.id)!
    const table = isClient ? "clients" : "vendors"
    plan.matched[table] += 1
    const edited = editedAfterImport(db)
    if (edited) plan.editedAfterImport.push({ table, id: db.id })
    const set = isClient ? buildClient(plan, db as DbClientRow, row, edited, taxOwners) : buildVendor(plan, db as DbVendorRow, row, edited)
    if (Object.keys(set).length === 0) plan.unchanged += 1
    else plan.updates.push({ table, id: db.id, tenantId: db.tenant_id, seenUpdatedAt: db.updated_at, set, source: { file: row.file, sheet: row.sheet, rowNumber: row.rowNumber } })
  }

  if (opts.insertUnmatchedNew && opts.tenantId) {
    const marker = opts.insertMarker ?? DEFAULT_INSERT_MARKER
    for (const ref of plan.unmatchedExcel.filter((r) => r.file === "new")) {
      const row = newRows.find((r) => r.sheet === ref.sheet && r.rowNumber === ref.rowNumber)!
      const stub = { id: `new:${row.sheet}:${row.rowNumber}`, tenant_id: opts.tenantId, name: "", note: null, created_at: "", updated_at: "" }
      const isClient = row.kind === "client"
      const values = isClient
        ? buildClient(plan, stub as DbClientRow, row, false, taxOwners, marker)
        : buildVendor(plan, stub as DbVendorRow, row, false, marker)
      // 名稱必填：缺全名時用簡稱（10/12 匯入同一做法）
      values.name = row.cells["公司名稱"] || row.cells["簡稱"]
      if (!isClient) values.source = "manual"
      plan.inserts.push({ table: isClient ? "clients" : "vendors", tenantId: opts.tenantId, values, source: { file: row.file, sheet: row.sheet, rowNumber: row.rowNumber } })
    }
  }
  return plan
}

/** 只含筆數與欄位名的摘要（可以貼進回報，不含任何儲存格內容）。 */
export function summarizePlan(plan: RosterPlan) {
  const fieldCounts: Record<string, number> = {}
  for (const u of plan.updates) for (const col of Object.keys(u.set)) fieldCounts[`${u.table}.${col}`] = (fieldCounts[`${u.table}.${col}`] ?? 0) + 1
  const countBy = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {})
  return {
    matched: plan.matched,
    toUpdate: countBy(plan.updates, (u) => u.table),
    toInsert: countBy(plan.inserts, (i) => i.table),
    insertFieldCounts: plan.inserts.reduce<Record<string, number>>((acc, i) => {
      for (const col of Object.keys(i.values)) acc[`${i.table}.${col}`] = (acc[`${i.table}.${col}`] ?? 0) + 1
      return acc
    }, {}),
    unchanged: plan.unchanged,
    fieldCounts: Object.fromEntries(Object.entries(fieldCounts).sort()),
    unmatchedExcel: countBy(plan.unmatchedExcel, (r) => `${r.file}:${r.sheet}`),
    ambiguousExcel: countBy(plan.ambiguousExcel, (r) => `${r.file}:${r.sheet}`),
    unmatchedDb: countBy(plan.unmatchedDb, (r) => r.table),
    namelessRows: plan.namelessRows,
    skippedCredentialCells: plan.skippedCredentialCells,
    skippedLoginUrls: plan.skippedLoginUrls,
    editedAfterImport: plan.editedAfterImport.length,
    conflicts: countBy(plan.conflicts, (c) => `${c.table}.${c.column}`),
    rejected: countBy(plan.rejected, (r) => `${r.table}.${r.column}:${r.reason}`),
    notes: plan.notes,
  }
}

const sqlLiteral = (v: PlanValue): string =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`

/**
 * SQL 計畫：一個 DO 區塊（單一交易），每筆 UPDATE 以「匯出當下的 updated_at」當樂觀鎖，
 * 任何一筆對不上（期間有人改過、被刪了）就 RAISE、整批回滾。⚠️ 內含個資，只能存在 repo 外。
 */
export function planToSql(plan: RosterPlan): string {
  const lines = [
    "-- 客供商名冊欄位搬遷計畫（docs/test/roster-excel-fields-migrate.ts 產生）。⚠️ 內含個資，勿進 repo。",
    "-- 前提：migration 0076（sql/0066）已套。單一交易：任何一筆在匯出後被改過就整批回滾。",
    "DO $roster$",
    "DECLARE n integer;",
    "BEGIN",
  ]
  for (const u of plan.updates) {
    const sets = Object.entries(u.set).map(([col, v]) => `${col} = ${sqlLiteral(v)}`)
    lines.push(
      `  UPDATE public.${u.table} SET ${sets.join(", ")}, updated_at = now() WHERE tenant_id = ${sqlLiteral(u.tenantId)} AND id = ${sqlLiteral(u.id)} AND deleted_at IS NULL AND updated_at = ${sqlLiteral(u.seenUpdatedAt)}::timestamptz;`,
      `  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'stale_or_missing %.%', ${sqlLiteral(u.table)}, ${sqlLiteral(u.id)}; END IF;`,
    )
  }
  for (const ins of plan.inserts) {
    const cols = ["tenant_id", ...Object.keys(ins.values)]
    const vals = [sqlLiteral(ins.tenantId), ...Object.values(ins.values).map(sqlLiteral)]
    const name = sqlLiteral(ins.values.name ?? null)
    lines.push(
      `  INSERT INTO public.${ins.table} (${cols.join(", ")}) SELECT ${vals.join(", ")} WHERE NOT EXISTS (SELECT 1 FROM public.${ins.table} WHERE tenant_id = ${sqlLiteral(ins.tenantId)} AND name = ${name} AND deleted_at IS NULL);`,
      `  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'already_exists %.%', ${sqlLiteral(ins.table)}, ${name}; END IF;`,
    )
  }
  lines.push("END $roster$;", "")
  return lines.join("\n")
}

/** 讀好的工作表（表頭列＋資料列，皆已轉字串）→ ExcelRosterRow。找不到表頭列（含「簡稱」與「TEL」）回空陣列。 */
export function sheetToRows(file: "new" | "old", sheet: string, grid: string[][]): ExcelRosterRow[] {
  const kind = SHEET_KINDS[sheet.trim()]
  if (!kind) return []
  const headerIdx = grid.slice(0, 10).findIndex((r) => r.map(headerKey).includes("簡稱") && r.map(headerKey).includes("tel"))
  if (headerIdx < 0) return []
  const headers = grid[headerIdx].map(headerKey)
  const named = headers.filter(Boolean)
  const out: ExcelRosterRow[] = []
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells: Record<string, string> = {}
    grid[i].forEach((v, j) => {
      const h = headers[j]
      if (h && v && v.trim()) cells[h] = v.trim()
    })
    if (Object.keys(cells).length === 0) continue
    out.push({ file, sheet: sheet.trim(), kind, rowNumber: i + 1, cells, headers: named })
  }
  return out
}
