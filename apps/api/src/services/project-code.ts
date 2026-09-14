import { supabaseAdmin } from "../lib/supabase.js"
import { ROC_OFFSET } from "./project-money.js"

/**
 * 專案編號的產生（模組四第 1 條；P3 專案申請單改為可設定格式）。
 *
 * ── 格式 ──────────────────────────────────────────────────────────
 * `{prefix}{sep}{年}{sep}{流水號}`，預設 `AT-115-001`：
 *   • `prefix`     租戶設定 `project_settings.code_prefix`（預設 AT）
 *   • `yearStyle`  'roc' 民國（year − 1911）| 'ad' 西元（`code_year_style`）
 *   • `seqDigits`  流水號補零位數（`code_seq_digits`，預設 3）
 *   • `separator`  固定 '-'
 *
 * 亞斯特老闆的 Word 申請單編號是 `AT-110-013`（AT-民國年-流水號）——
 * 這是客戶既有文件上的格式，系統跟著它走，不是反過來。
 * 格式由 `loadCodeFormat(tenantId)` 從 `project_settings` 載入；沒有設定列
 * 就用 `DEFAULT_CODE_FORMAT`。**改格式只影響之後產生的編號**——既有編號
 * 是識別碼，已經印在合約上了，永遠不回頭改。
 *
 * ── 年度為何只能取「建立年」 ──────────────────────────────────────
 * 編號會被印在合約、請款單、發票與往來文件上，一旦印出去就不能改。
 * 因此任何「事後才知道」的年度都不能拿來編號：
 *   • 簽約年 —— 立案時可能還沒簽約（先立案、後簽約），那時編不出號
 *   • 開工年 —— 更晚
 *   • 完工年 —— 2~4 年後才知道
 * 只有建立年在立案當下就確定。「建立年」取**台北當地**的年（`todayKey`），
 * 不是主機的 UTC 年——12/31 晚上十點立的案，編號要是舊年度。
 *
 * 歸屬年度另有 `projects.fiscal_year`，可人工調整、可與編號的年度不同。
 * **不要用編號表達歸屬。**
 *
 * ── 流水號每年重置 ────────────────────────────────────────────────
 * 編號既然含年度，流水號就該每年從 001 開始，否則年度那一段沒有意義。
 * 2~4 年的專案到了第 4 年仍是當初的編號，不隨時間改。
 *
 * ── 併發 ──────────────────────────────────────────────────────────
 * `MAX(seq) + 1` 在兩人同時建案時會拿到同一個號。真正的保證是
 * `projects_tenant_code_uq` 這個 unique index；本模組在衝突時重試，
 * **讓 DB 當最後防線，而不是靠應用層搶**。
 */

export type CodeYearStyle = "roc" | "ad"

export type CodeFormat = {
  prefix: string
  yearStyle: CodeYearStyle
  seqDigits: number
  separator: "-"
}

/** 沒有 project_settings 列時的預設值，與 schema 的 default 對齊。 */
export const DEFAULT_CODE_FORMAT: CodeFormat = {
  prefix: "AT",
  yearStyle: "roc",
  seqDigits: 3,
  separator: "-",
}

/** 同一年度內最多重試幾次（併發衝突時）。 */
export const MAX_CODE_ATTEMPTS = 5

/** 編號裡的年份段：roc 就換算成民國年，ad 照西元。 */
export function codeYear(fmt: CodeFormat, year: number): number {
  return fmt.yearStyle === "roc" ? year - ROC_OFFSET : year
}

export function formatCode(fmt: CodeFormat, year: number, seq: number): string {
  const y = codeYear(fmt, year)
  return `${fmt.prefix}${fmt.separator}${y}${fmt.separator}${String(seq).padStart(fmt.seqDigits, "0")}`
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 從編號字串取出流水號；格式不符回 null（人工輸入的舊編號不參與計算）。 */
export function parseSeq(fmt: CodeFormat, code: string, year: number): number | null {
  const re = new RegExp(
    `^${escapeRe(fmt.prefix)}${escapeRe(fmt.separator)}${codeYear(fmt, year)}${escapeRe(fmt.separator)}(\\d+)$`,
  )
  const m = code.match(re)
  return m ? Number(m[1]) : null
}

/** `LIKE` 前綴：`AT-115-%`。 */
export function codeLikePrefix(fmt: CodeFormat, year: number): string {
  return `${fmt.prefix}${fmt.separator}${codeYear(fmt, year)}${fmt.separator}%`
}

/** 把 project_settings 的三個欄位收斂成 CodeFormat；缺值或不合法就用預設。 */
export function toCodeFormat(row: {
  code_prefix?: string | null
  code_year_style?: string | null
  code_seq_digits?: number | string | null
} | null | undefined): CodeFormat {
  if (!row) return DEFAULT_CODE_FORMAT
  const prefix = (row.code_prefix ?? "").trim() || DEFAULT_CODE_FORMAT.prefix
  const yearStyle: CodeYearStyle = row.code_year_style === "ad" ? "ad" : "roc"
  const digits = Number(row.code_seq_digits)
  const seqDigits = Number.isInteger(digits) && digits >= 1 && digits <= 6 ? digits : DEFAULT_CODE_FORMAT.seqDigits
  return { prefix, yearStyle, seqDigits, separator: "-" }
}

/** 讀租戶的編號格式設定。沒有設定列就回預設（AT / roc / 3）。 */
export async function loadCodeFormat(tenantId: string): Promise<CodeFormat> {
  const { data, error } = await supabaseAdmin
    .from("project_settings")
    .select("code_prefix, code_year_style, code_seq_digits")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`loadCodeFormat: ${error.message}`)
  return toCodeFormat(data as Parameters<typeof toCodeFormat>[0])
}

/**
 * 取該租戶該年度的下一個編號。
 *
 * 只掃描「符合本格式」的既有編號——人工輸入的例外編號不參與流水號計算，
 * 否則一筆手打的 `ABC-999` 會把之後所有自動編號推到 1000。
 * `fmt` 省略時自動載入租戶設定。
 */
export async function nextProjectCode(
  tenantId: string,
  year: number,
  fmt?: CodeFormat,
): Promise<string> {
  const format = fmt ?? (await loadCodeFormat(tenantId))
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("code")
    .eq("tenant_id", tenantId)
    .like("code", codeLikePrefix(format, year))
  if (error) throw new Error(`nextProjectCode: ${error.message}`)

  let maxSeq = 0
  for (const row of data ?? []) {
    const seq = parseSeq(format, (row.code as string) ?? "", year)
    if (seq !== null && seq > maxSeq) maxSeq = seq
  }
  return formatCode(format, year, maxSeq + 1)
}

/** Postgres unique violation —— 併發撞號時重試的判斷依據。 */
export function isUniqueViolation(err: { code?: string } | null): boolean {
  return err?.code === "23505"
}

/* ──────────────────────────────────────────────────────────────────
 * 複製案（C2 追加減／加做）的編號：`{根 main 案 code}-{n}`
 * ──────────────────────────────────────────────────────────────────
 * 合約變更（1000 萬 → 2000 萬）**不改原案**，而是把原案複製成新案再封存原案：
 * `AT-115-013` → `AT-115-013-1`；從 `-1` 再複製一次是 `AT-115-013-2`，**不是**
 * `-1-1`——尾碼永遠掛在根 main 案的編號後面，同一條變更鏈一眼看得出來。
 *
 * 尾碼與年度流水號互不干擾：`parseSeq` 要求完整比對且錨定 `(\d+)$`，
 * `AT-115-013-1` 對年度格式回 null，不會把之後的年度流水號推到 014。
 * 反過來 `parseDupSuffix` 也只認 `{root}-{n}` 的完整形狀，`AT-115-0131`、
 * `AT-115-013-1-1` 都不算。
 *
 * 併發：同 nextProjectCode——MAX+1 會撞號，靠 `projects_tenant_code_uq`
 * 擋、撞到就重算重試（services/project-duplicate.ts）。
 */

/** `AT-115-013-7` 相對根案 `AT-115-013` → 7；非同源或格式不符回 null。 */
export function parseDupSuffix(rootCode: string, code: string): number | null {
  if (!rootCode || !code) return null
  const m = code.match(new RegExp(`^${escapeRe(rootCode)}-(\\d+)$`))
  return m ? Number(m[1]) : null
}

export function formatDupCode(rootCode: string, n: number): string {
  return `${rootCode}-${n}`
}

/**
 * 取根案底下的下一個複製案編號：掃 `code like '{root}-%'`，取符合
 * `^{root}-(\d+)$` 的最大尾碼 +1。LIKE 只是粗篩（`_`／`%` 當萬用字元只會多撈，
 * 不會漏），真正的判定在 parseDupSuffix。
 */
export async function nextDuplicateCode(tenantId: string, rootCode: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("code")
    .eq("tenant_id", tenantId)
    .like("code", `${rootCode}-%`)
  if (error) throw new Error(`nextDuplicateCode: ${error.message}`)

  let max = 0
  for (const row of data ?? []) {
    const n = parseDupSuffix(rootCode, (row.code as string) ?? "")
    if (n !== null && n > max) max = n
  }
  return formatDupCode(rootCode, max + 1)
}
