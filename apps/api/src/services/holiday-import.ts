import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { addDaysKey, diffDaysKey, weekdayOfKey, todayKey, DEFAULT_TIMEZONE, type DateKey } from "../lib/tz.js"
import { generateTenantCalendar, planTenantCalendar, type CalendarGenerateResult } from "./imports/writers.js"
import { loadTenantWeekendPolicy, type WeekendPolicy } from "./day-type.js"
import { enqueue } from "./notify.js"
import { writeAuditLog } from "./audit.js"

/**
 * 國定假日年度匯入（2026-10-17）——薪資結算的日別要正確，行事曆每年都得換新。
 *
 * 資料來源（實測過格式）：
 *   主：人事行政總處「中華民國政府行政機關辦公日曆表」data.gov.tw 資料集 14718。
 *       metadata → distribution[]，挑描述含「{民國年}年」、不含「Google」的 CSV，有修正版取最新
 *       （下載網址 dgpa/files/{yyyymm}/ 的上傳月份當版本，同月以列表後者為準）。
 *       CSV：西元日期,星期,是否放假(0 上班／2 放假),備註；逐日 365／366 列；編碼可能是 Big5 或 UTF-8（含 BOM），自動偵測。
 *   備援／交叉比對：新北市資料開放平台的辦公日曆（只列非一般上班日；date,name,isholiday,holidaycategory,description）。
 *       主來源失敗（逾時、未公布、格式不符）→ 改用新北建草稿；兩者都失敗 → HolidayFetchError。
 *
 * 轉換規則（民間企業）：
 *   • 放假（2）且有備註的日子 → 假日清單（週間 → 核准後寫 fixed_holiday；補假也是，label 記「補哪天」）。
 *   • 週末的節日也留在清單（kind 不變、weekend=true），核准時由 writers.planTenantCalendar 依租戶例假／休息日設定
 *     寫 regular_leave／rest_day，label 註記節日名稱——與 2026-10-17 一例一休的行事曆產生邏輯完全同一支。
 *   • 週末標 0（補行上班）→ 行政機關調整放假用，民間不適用 → 忽略，只列在 workdayAdjustments／warnings。
 *   • 新北「特定節日」（軍人節等）排除；唯一例外是描述寫「勞工放假」的勞動節（新北把 2025、2026 的勞動節歸在特定節日）。
 *   • 勞動節（5/1）是勞工法定假日，114 年以前的行政機關辦公日曆不列 → 缺了自動補上並在 warnings 註明。
 *   • 補假日期勞雇可協商、選舉投票日不在來源中 → HR 在草稿編輯（PATCH）後再核准。
 *
 * 流程：fetch → 草稿（calendar_import_drafts.status='draft'）→ HR 預覽／編輯 → 核准（寫 tenant_calendar_days，
 * 只覆寫 source generated／import 的列，HR 手動 manual 列不動；舊核准版有、新版沒有的 import 列刪掉）。
 * 排程（worker 每日 → POST /internal/calendar/holiday-import，runHolidayImportJob）：7/1 起下一年沒有已核准行事曆
 * → 自動建草稿＋通知 HR；每月 1 日重抓當年與下一年，官方修正版與已核准（或待核准）不同 → 建新草稿＋通知，不自動覆蓋。
 */

/* ── 型別 ─────────────────────────────────────────────────────────── */

export type HolidayKind = "holiday" | "make_up" | "adjusted" | "extra"

export interface DraftHoliday {
  /** YYYY-MM-DD */
  date: string
  label: string
  /** holiday＝節日本日；make_up＝補假；adjusted＝調整放假；extra＝HR 加的（例如選舉投票日）。 */
  kind: HolidayKind
  /** 落在週六／週日（政府行事曆的週末；租戶自訂週休在核准時才套）。 */
  weekend: boolean
  /** 補假補的是哪一天（找得到才有）。 */
  makeUpFor?: string | null
}

export interface WorkdayAdjustment {
  date: string
  label: string
}

export interface IgnoredDay {
  date: string
  label: string
  reason: string
}

/** 某一年解析後的結果（官方原樣）。 */
export interface HolidayYear {
  year: number
  holidays: DraftHoliday[]
  /** 週末補行上班日（民間不適用，已忽略）。 */
  workdayAdjustments: WorkdayAdjustment[]
  ignored: IgnoredDay[]
  warnings: string[]
}

export type HolidaySource = "dgpa" | "ntpc"

export interface SourceResource {
  url: string
  description: string
  /** 上傳月份 yyyymm（dgpa）；新北為空字串。 */
  version: string
}

export interface DiffItem {
  date: string
  weekday: number
  kind: "only_primary" | "only_backup" | "workday_adjustment"
  primaryLabel: string | null
  backupLabel: string | null
}

export interface CalendarDiff {
  available: boolean
  backupSource: "ntpc"
  reason?: string
  items: DiffItem[]
}

export interface FetchedHolidayYear {
  year: number
  source: HolidaySource
  resource: SourceResource
  data: HolidayYear
  diff: CalendarDiff
  fetchedAt: string
  /** 主來源失敗、改用備援時的錯誤訊息。 */
  errors: string[]
}

export interface DraftPayload {
  version: 1
  year: number
  source: HolidaySource
  resource: SourceResource
  official: HolidayYear
  officialKey: string
  /** HR 可編輯的清單（核准時用這份）；初始＝official.holidays。 */
  holidays: DraftHoliday[]
  edited: boolean
  editedAt?: string | null
  editedByEmpId?: string | null
  fetchErrors: string[]
}

export type DraftStatus = "draft" | "approved" | "superseded"

export interface DraftRow {
  id: string
  tenant_id: string
  year: number
  source: HolidaySource
  fetched_at: string
  payload: DraftPayload
  diff: CalendarDiff | null
  status: DraftStatus
  created_by_emp_id: string | null
  approved_by_emp_id: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
}

/* ── 錯誤 ─────────────────────────────────────────────────────────── */

export type HolidaySourceErrorCode = "timeout" | "http_error" | "not_published" | "invalid_format" | "network"

export class HolidaySourceError extends Error {
  constructor(
    public readonly code: HolidaySourceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "HolidaySourceError"
  }
}

/** 主來源與備援都失敗。`notPublished`＝兩邊都只是「還沒有這一年」（排程視為正常、不通知）。 */
export class HolidayFetchError extends Error {
  constructor(
    public readonly year: number,
    public readonly errors: string[],
    public readonly notPublished: boolean,
  ) {
    super(`無法取得 ${year} 年辦公日曆：${errors.join("；")}`)
    this.name = "HolidayFetchError"
  }
}

/** calendar_import_drafts 尚未建表（sql/0061）。 */
export class CalendarImportNotMigratedError extends Error {
  constructor() {
    super("calendar_import_drafts is not available yet (packages/db migration 0071 / sql/0061)")
    this.name = "CalendarImportNotMigratedError"
  }
}

/** HR 編輯的清單不合法（日期不在該年、缺名稱）。 */
export class InvalidHolidaysError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidHolidaysError"
  }
}

export class DraftStateError extends Error {
  constructor(
    public readonly code: "not_found" | "not_editable" | "conflict",
    message: string,
    public readonly status?: string,
  ) {
    super(message)
    this.name = "DraftStateError"
  }
}

/* ── 純函式：編碼、解析、轉換 ─────────────────────────────────────── */

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"]

function daysInYear(year: number): number {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000
}

function isWeekendKey(date: string): boolean {
  const wd = weekdayOfKey(date)
  return wd === 0 || wd === 6
}

/** UTF-8 BOM → 去掉後以 UTF-8 解；合法 UTF-8 → UTF-8；否則 Big5（人事行政總處 114 年以前的檔案）。純函式。 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: "utf-8" | "big5" } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" }
  } catch {
    return { text: new TextDecoder("big5").decode(bytes), encoding: "big5" }
  }
}

export interface DgpaDay {
  date: string
  off: boolean
  note: string
}

/**
 * 人事行政總處 CSV → 逐日清單。純函式。
 * 驗證：表頭有「西元日期」「是否放假」；每列日期都在 `year`、整年逐日不缺不重（365／366 列）。不符 → HolidaySourceError('invalid_format')。
 */
export function parseDgpaCsv(text: string, year: number): DgpaDay[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) throw new HolidaySourceError("invalid_format", "CSV 是空的")
  const header = lines[0]!.split(",").map((h) => h.trim())
  const iDate = header.findIndex((h) => h.includes("西元日期"))
  const iOff = header.findIndex((h) => h.includes("是否放假"))
  const iNote = header.findIndex((h) => h.includes("備註"))
  if (iDate < 0 || iOff < 0) throw new HolidaySourceError("invalid_format", `CSV 表頭不符（${header.join(",")}）`)
  const out: DgpaDay[] = []
  for (const line of lines.slice(1)) {
    const cols = line.split(",")
    const raw = (cols[iDate] ?? "").trim()
    if (!/^\d{8}$/.test(raw)) throw new HolidaySourceError("invalid_format", `日期格式不符：${raw}`)
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    const flag = (cols[iOff] ?? "").trim()
    if (flag !== "0" && flag !== "2") throw new HolidaySourceError("invalid_format", `${date} 是否放假欄位不符：${flag}`)
    const note = iNote >= 0 ? cols.slice(iNote).join(",").trim() : ""
    out.push({ date, off: flag === "2", note })
  }
  const expected = daysInYear(year)
  if (out.length !== expected) throw new HolidaySourceError("invalid_format", `${year} 年應有 ${expected} 列，CSV 有 ${out.length} 列`)
  let d = `${year}-01-01`
  for (const row of out) {
    if (row.date !== d) throw new HolidaySourceError("invalid_format", `日期不連續：預期 ${d}、實際 ${row.date}`)
    d = addDaysKey(d, 1)
  }
  return out
}

function mdLabel(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`
}

/** 節日名稱去掉括號註解（「元旦（開國紀念日）」→「元旦」）。 */
function baseName(label: string): string {
  return label.replace(/（.*?）|\(.*?\)/g, "").trim() || label
}

/**
 * 補假 → 補的是哪個週末節日。依日期序，每個補假找 ±10 天內「最早、尚未被認領」的週末節日
 * （春節初一週六 → 2/9、初二週日 → 2/10 這種連假也對得上；兒童節與清明同一天的補假找不到 → 維持原 label）。
 * 找不到且是 12/31、隔年元旦逢週六 → 註記隔年元旦補假。純函式（會改 holidays 的 label／makeUpFor）。
 */
function labelMakeUps(holidays: DraftHoliday[], year: number): void {
  const weekendHolidays = holidays.filter((h) => h.weekend && h.kind === "holiday").sort((a, b) => a.date.localeCompare(b.date))
  const claimed = new Set<string>()
  for (const h of holidays.filter((x) => x.kind === "make_up").sort((a, b) => a.date.localeCompare(b.date))) {
    const target = weekendHolidays.find((w) => !claimed.has(w.date) && Math.abs(diffDaysKey(w.date, h.date)) <= 10)
    if (target) {
      claimed.add(target.date)
      h.makeUpFor = target.date
      h.label = `${baseName(target.label)}補假（${mdLabel(target.date)}適逢週${WEEKDAY_ZH[weekdayOfKey(target.date)]}）`
    } else if (h.date === `${year}-12-31` && weekdayOfKey(`${year + 1}-01-01`) === 6) {
      h.makeUpFor = `${year + 1}-01-01`
      h.label = `${year + 1}年元旦補假（${year + 1}/1/1適逢週六）`
    }
  }
}

/** 人事行政總處逐日清單 → 年度假日（規則見檔頭）。純函式。 */
export function holidayYearFromDgpa(days: DgpaDay[], year: number): HolidayYear {
  const holidays: DraftHoliday[] = []
  const workdayAdjustments: WorkdayAdjustment[] = []
  const ignored: IgnoredDay[] = []
  const warnings: string[] = []
  for (const d of days) {
    if (!d.date.startsWith(`${year}-`)) continue
    const weekend = isWeekendKey(d.date)
    if (d.off && d.note) {
      const kind: HolidayKind = d.note.includes("補假") ? "make_up" : d.note.includes("調整放假") ? "adjusted" : "holiday"
      holidays.push({ date: d.date, label: d.note, kind, weekend })
    } else if (d.off && !weekend) {
      holidays.push({ date: d.date, label: "放假（官方未註明名稱）", kind: "holiday", weekend })
      warnings.push(`${d.date} 官方標放假但沒有備註，請確認`)
    } else if (!d.off && weekend) {
      workdayAdjustments.push({ date: d.date, label: d.note || "補行上班" })
    } else if (!d.off && d.note) {
      ignored.push({ date: d.date, label: d.note, reason: "官方標為上班日" })
    }
  }
  // 勞動節（5/1）是勞工的法定假日（勞基法第 37 條、施行細則第 23 條），但 114 年以前的行政機關辦公日曆
  // 不列（公務員不放）——缺了就補上，並提醒 HR（新北資料也會列，交叉比對不會再標紅）。
  if (!holidays.some((h) => h.date === `${year}-05-01`)) {
    holidays.push({ date: `${year}-05-01`, label: "勞動節", kind: "holiday", weekend: isWeekendKey(`${year}-05-01`) })
    holidays.sort((a, b) => a.date.localeCompare(b.date))
    warnings.push(`行政機關辦公日曆未列 ${year}-05-01 勞動節（公務員不放假），已依勞基法補為勞工放假日`)
  }
  labelMakeUps(holidays, year)
  if (workdayAdjustments.length > 0) {
    warnings.push(
      `本年有 ${workdayAdjustments.length} 個週末補行上班日（${workdayAdjustments.map((w) => w.date).join("、")}），` +
        "是行政機關調整放假用，民間企業不適用、已忽略；對應的調整放假日是否給假請 HR 確認",
    )
  }
  return { year, holidays, workdayAdjustments, ignored, warnings }
}

export interface NtpcEntry {
  date: string
  name?: string | null
  isholiday?: string | null
  holidaycategory?: string | null
  description?: string | null
}

const NTPC_HOLIDAY_CATEGORIES = new Set(["放假之紀念日及節日", "補假", "調整放假日"])

/** 新北辦公日曆 → 年度假日（規則見檔頭；特定節日除勞動節外排除）。純函式。 */
export function holidayYearFromNtpc(entries: NtpcEntry[], year: number): HolidayYear {
  const byDate = new Map<string, DraftHoliday>()
  const workdayAdjustments: WorkdayAdjustment[] = []
  const ignored: IgnoredDay[] = []
  for (const e of entries) {
    if (!/^\d{8}$/.test(e.date ?? "") || !e.date.startsWith(String(year))) continue
    const date = `${e.date.slice(0, 4)}-${e.date.slice(4, 6)}-${e.date.slice(6, 8)}`
    const cat = (e.holidaycategory ?? "").trim()
    const name = (e.name ?? "").trim()
    const weekend = isWeekendKey(date)
    if (cat === "補行上班日") {
      workdayAdjustments.push({ date, label: name || "補行上班" })
      continue
    }
    if (cat === "特定節日") {
      if ((e.description ?? "").includes("勞工")) byDate.set(date, { date, label: name || "勞動節", kind: "holiday", weekend })
      else ignored.push({ date, label: name || cat, reason: "特定節日（非全體勞工放假）" })
      continue
    }
    if (cat === "星期六、星期日") {
      if (name) byDate.set(date, { date, label: name, kind: "holiday", weekend })
      continue
    }
    if (!NTPC_HOLIDAY_CATEGORIES.has(cat)) continue
    const kind: HolidayKind = cat === "補假" ? "make_up" : cat === "調整放假日" ? "adjusted" : "holiday"
    byDate.set(date, { date, label: name || (kind === "make_up" ? "補假" : cat), kind, weekend })
  }
  const holidays = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  labelMakeUps(holidays, year)
  const warnings: string[] = []
  if (workdayAdjustments.length > 0) {
    warnings.push(`本年有 ${workdayAdjustments.length} 個週末補行上班日，民間企業不適用、已忽略；對應的調整放假日是否給假請 HR 確認`)
  }
  return { year, holidays, workdayAdjustments, ignored, warnings }
}

/**
 * 主來源 vs 新北：比「週間放假日」與「補行上班日」兩個集合（週末節日只影響 label，不比）。純函式。
 * backup 為 null → available=false（reason 說明）。
 */
export function diffAgainstBackup(primary: HolidayYear, backup: HolidayYear | null, reason?: string | null): CalendarDiff {
  if (!backup) return { available: false, backupSource: "ntpc", reason: reason ?? "新北資料無法取得", items: [] }
  if (backup.holidays.length === 0 && backup.workdayAdjustments.length === 0) {
    return { available: false, backupSource: "ntpc", reason: `新北資料尚無 ${primary.year} 年`, items: [] }
  }
  const weekdayMap = (h: HolidayYear) => new Map(h.holidays.filter((x) => !x.weekend).map((x) => [x.date, x.label]))
  const p = weekdayMap(primary)
  const b = weekdayMap(backup)
  const items: DiffItem[] = []
  for (const [date, label] of p) {
    if (!b.has(date)) items.push({ date, weekday: weekdayOfKey(date), kind: "only_primary", primaryLabel: label, backupLabel: null })
  }
  for (const [date, label] of b) {
    if (!p.has(date)) items.push({ date, weekday: weekdayOfKey(date), kind: "only_backup", primaryLabel: null, backupLabel: label })
  }
  const pw = new Map(primary.workdayAdjustments.map((w) => [w.date, w.label]))
  const bw = new Map(backup.workdayAdjustments.map((w) => [w.date, w.label]))
  for (const date of new Set([...pw.keys(), ...bw.keys()])) {
    if (pw.has(date) !== bw.has(date)) {
      items.push({ date, weekday: weekdayOfKey(date), kind: "workday_adjustment", primaryLabel: pw.get(date) ?? null, backupLabel: bw.get(date) ?? null })
    }
  }
  items.sort((x, y) => x.date.localeCompare(y.date))
  return { available: true, backupSource: "ntpc", items }
}

/** 官方內容指紋（週間放假日｜週末節日｜補行上班日的日期集合）：每月重抓時判斷「官方是否修正」。label 改字不算修正。純函式。 */
export function officialKey(h: Pick<HolidayYear, "holidays" | "workdayAdjustments">): string {
  const weekday = h.holidays.filter((x) => !x.weekend).map((x) => x.date).sort()
  const weekend = h.holidays.filter((x) => x.weekend).map((x) => x.date).sort()
  const adj = h.workdayAdjustments.map((x) => x.date).sort()
  return `${weekday.join(",")}|${weekend.join(",")}|${adj.join(",")}`
}

/* ── 來源挑選與抓取 ───────────────────────────────────────────────── */

export const DGPA_DATASET_URL = "https://data.gov.tw/api/v2/rest/dataset/14718"
export const NTPC_DATASET_URL = "https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json"
const NTPC_PAGE_SIZE = 1000
const NTPC_MAX_PAGES = 8
export const DEFAULT_FETCH_TIMEOUT_MS = 12_000

interface DistributionItem {
  resourceDescription?: unknown
  resourceFormat?: unknown
  resourceDownloadUrl?: unknown
}

/** distribution[] → 該年的 CSV（不含 Google 行事曆專用檔）；多份（修正版）取上傳月份最新、同月取列表後者。純函式。 */
export function pickDgpaResource(distribution: unknown, year: number): SourceResource | null {
  if (!Array.isArray(distribution)) return null
  const roc = year - 1911
  const candidates: Array<SourceResource & { index: number }> = []
  distribution.forEach((raw, index) => {
    const item = (raw ?? {}) as DistributionItem
    const description = typeof item.resourceDescription === "string" ? item.resourceDescription : ""
    const url = typeof item.resourceDownloadUrl === "string" ? item.resourceDownloadUrl : ""
    const format = typeof item.resourceFormat === "string" ? item.resourceFormat : ""
    if (!url || !description.includes(`${roc}年`) || /google/i.test(description)) return
    if (format && format.toUpperCase() !== "CSV") return
    const version = /files\/(\d{6})\//.exec(url)?.[1] ?? ""
    candidates.push({ url, description, version, index })
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.version === b.version ? b.index - a.index : b.version.localeCompare(a.version)))
  const { index: _index, ...best } = candidates[0]!
  return best
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
}>

export interface FetchOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: Date
}

async function getBytes(url: string, opts: FetchOptions): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "*/*", "user-agent": "aster-hr-holiday-import/1.0" } })
    if (!res.ok) throw new HolidaySourceError("http_error", `HTTP ${res.status}（${url.slice(0, 80)}）`)
    return new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    if (err instanceof HolidaySourceError) throw err
    if (controller.signal.aborted) throw new HolidaySourceError("timeout", `逾時（${url.slice(0, 80)}）`)
    throw new HolidaySourceError("network", `連線失敗：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url: string, opts: FetchOptions): Promise<unknown> {
  const bytes = await getBytes(url, opts)
  try {
    return JSON.parse(decodeCsvBytes(bytes).text)
  } catch {
    throw new HolidaySourceError("invalid_format", `回應不是 JSON（${url.slice(0, 80)}）`)
  }
}

/** 主來源：人事行政總處（data.gov.tw 14718）。 */
export async function fetchDgpaYear(year: number, opts: FetchOptions = {}): Promise<{ data: HolidayYear; resource: SourceResource }> {
  const meta = (await getJson(DGPA_DATASET_URL, opts)) as { result?: { distribution?: unknown }; distribution?: unknown }
  const resource = pickDgpaResource(meta?.result?.distribution ?? meta?.distribution, year)
  if (!resource) throw new HolidaySourceError("not_published", `人事行政總處尚未公布 ${year - 1911} 年（${year}）辦公日曆表`)
  const { text } = decodeCsvBytes(await getBytes(resource.url, opts))
  const days = parseDgpaCsv(text, year)
  return { data: holidayYearFromDgpa(days, year), resource }
}

/** 備援：新北市辦公日曆（分頁，依日期排序；翻到超過該年或空頁為止）。 */
export async function fetchNtpcYear(year: number, opts: FetchOptions = {}): Promise<{ data: HolidayYear; resource: SourceResource }> {
  const entries: NtpcEntry[] = []
  for (let page = 0; page < NTPC_MAX_PAGES; page += 1) {
    const json = await getJson(`${NTPC_DATASET_URL}?page=${page}&size=${NTPC_PAGE_SIZE}`, opts)
    if (!Array.isArray(json)) throw new HolidaySourceError("invalid_format", "新北資料格式不符（不是陣列）")
    if (json.length === 0) break
    const rows = json as NtpcEntry[]
    for (const r of rows) if (typeof r?.date === "string" && r.date.startsWith(String(year))) entries.push(r)
    const lastYear = Number(String(rows[rows.length - 1]?.date ?? "").slice(0, 4))
    if (lastYear > year || rows.length < NTPC_PAGE_SIZE) break
  }
  if (entries.length === 0) throw new HolidaySourceError("not_published", `新北資料尚無 ${year} 年`)
  return {
    data: holidayYearFromNtpc(entries, year),
    resource: { url: NTPC_DATASET_URL, description: "新北市政府行政機關辦公日曆表（備援）", version: "" },
  }
}

/**
 * 抓某年：主、備援平行抓；主來源成功 → 用主來源、拿新北做差異；主來源失敗 → 用新北（warnings 註明）；
 * 兩者都失敗 → HolidayFetchError（兩邊都是 not_published → notPublished=true）。
 */
export async function fetchHolidayYear(year: number, opts: FetchOptions = {}): Promise<FetchedHolidayYear> {
  const fetchedAt = (opts.now ?? new Date()).toISOString()
  const [primary, backup] = await Promise.allSettled([fetchDgpaYear(year, opts), fetchNtpcYear(year, opts)])
  const msg = (r: PromiseRejectedResult) => (r.reason instanceof Error ? r.reason.message : String(r.reason))
  const code = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" && r.reason instanceof HolidaySourceError ? r.reason.code : null
  if (primary.status === "fulfilled") {
    return {
      year,
      source: "dgpa",
      resource: primary.value.resource,
      data: primary.value.data,
      diff: diffAgainstBackup(primary.value.data, backup.status === "fulfilled" ? backup.value.data : null, backup.status === "rejected" ? msg(backup) : null),
      fetchedAt,
      errors: [],
    }
  }
  const primaryError = `人事行政總處：${msg(primary)}`
  if (backup.status === "fulfilled") {
    const data = { ...backup.value.data, warnings: [`主來源失敗、改用新北備援資料（${primaryError}）`, ...backup.value.data.warnings] }
    return {
      year,
      source: "ntpc",
      resource: backup.value.resource,
      data,
      diff: { available: false, backupSource: "ntpc", reason: "主來源失敗，草稿即為新北資料，無法交叉比對", items: [] },
      fetchedAt,
      errors: [primaryError],
    }
  }
  throw new HolidayFetchError(
    year,
    [primaryError, `新北備援：${msg(backup)}`],
    code(primary) === "not_published" && code(backup) === "not_published",
  )
}

/* ── 純函式：草稿內容、預覽、核准就緒 ─────────────────────────────── */

export function buildDraftPayload(fetched: FetchedHolidayYear): DraftPayload {
  return {
    version: 1,
    year: fetched.year,
    source: fetched.source,
    resource: fetched.resource,
    official: fetched.data,
    officialKey: officialKey(fetched.data),
    holidays: fetched.data.holidays.map((h) => ({ ...h })),
    edited: false,
    fetchErrors: fetched.errors,
  }
}

export interface EditedHolidayInput {
  date: string
  label: string
  kind?: HolidayKind
  makeUpFor?: string | null
}

/** HR 編輯後的清單 → 正規化（同日最後一筆為準、限該年、依日期排序、weekend 重算）。不合法 → InvalidHolidaysError。純函式。 */
export function normalizeEditedHolidays(year: number, input: EditedHolidayInput[]): DraftHoliday[] {
  const byDate = new Map<string, DraftHoliday>()
  for (const h of input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date) || !h.date.startsWith(`${year}-`)) throw new InvalidHolidaysError(`日期 ${h.date} 不在 ${year} 年`)
    const label = h.label.trim()
    if (!label) throw new InvalidHolidaysError(`${h.date} 缺名稱`)
    byDate.set(h.date, {
      date: h.date,
      label: label.slice(0, 120),
      kind: h.kind ?? "extra",
      weekend: isWeekendKey(h.date),
      ...(h.makeUpFor ? { makeUpFor: h.makeUpFor } : {}),
    })
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export interface CalendarRowLite {
  date: string
  day_type: string
  label: string | null
  source: string | null
}

export interface PreviewChange {
  date: string
  weekday: number
  current: { dayType: string; label: string | null; source: string | null } | null
  next: { dayType: string; label: string | null } | null
  /** add＝新增列；change＝改日別或名稱；remove＝舊匯入列（新版沒有）會刪掉；keep_manual＝HR 手動列不動（但與新版不同）。 */
  action: "add" | "change" | "remove" | "keep_manual"
}

/**
 * 核准會對行事曆做什麼（逐日）。純函式——與 approveImportDraft 用同一支 planTenantCalendar。
 * 只列「會變」或「HR 手動列與新版不同」的日子。
 */
export function previewDraftApply(input: {
  year: number
  holidays: DraftHoliday[]
  policy: WeekendPolicy
  existing: CalendarRowLite[]
}): { changes: PreviewChange[]; counts: Record<PreviewChange["action"], number> } {
  const existingByDate = new Map(input.existing.filter((r) => r.date.startsWith(`${input.year}-`)).map((r) => [r.date, r]))
  const existingSources = new Map([...existingByDate.values()].map((r) => [r.date, r.source ?? "generated"]))
  const plan = planTenantCalendar({ year: input.year, holidays: input.holidays, policy: input.policy })
  const planned = new Map([...plan.weekendRows, ...plan.holidayRows].map((r) => [r.date, r]))
  const changes: PreviewChange[] = []
  const dates = new Set([...planned.keys(), ...existingByDate.keys()])
  for (const date of [...dates].sort()) {
    const cur = existingByDate.get(date) ?? null
    const nxt = planned.get(date) ?? null
    const current = cur ? { dayType: cur.day_type, label: cur.label, source: cur.source } : null
    const next = nxt ? { dayType: nxt.day_type, label: nxt.label } : null
    if (cur && existingSources.get(date) === "manual") {
      if (!nxt || nxt.day_type !== cur.day_type) changes.push({ date, weekday: weekdayOfKey(date), current, next, action: "keep_manual" })
      continue
    }
    if (!cur && nxt) {
      // 週末列沒寫過也只是把預設寫進去，不算變動；節日（有 label）才列。
      if (nxt.day_type === "fixed_holiday" || nxt.label) changes.push({ date, weekday: weekdayOfKey(date), current, next, action: "add" })
      continue
    }
    if (cur && !nxt) {
      if (cur.source === "import") changes.push({ date, weekday: weekdayOfKey(date), current, next, action: "remove" })
      continue
    }
    if (cur && nxt && (cur.day_type !== nxt.day_type || (cur.label ?? null) !== (nxt.label ?? null))) {
      changes.push({ date, weekday: weekdayOfKey(date), current, next, action: "change" })
    }
  }
  const counts = { add: 0, change: 0, remove: 0, keep_manual: 0 }
  for (const c of changes) counts[c.action] += 1
  return { changes, counts }
}

export type ReadinessStatus = "approved" | "legacy" | "pending_draft" | "missing"

export interface CalendarReadiness {
  date: string
  ready: boolean
  years: Array<{ year: number; status: ReadinessStatus; approvedAt: string | null; draftId: string | null }>
  missing: number[]
}

/**
 * 薪資前檢查用（純函式）：當年一定要有；12 月起下一年也要有。
 * approved＝有已核准草稿；legacy＝沒有核准紀錄但行事曆已有國定假日列（本功能上線前用「產生」或手動建的）——算就緒；
 * pending_draft／missing＝不就緒。
 */
export function computeCalendarReadiness(input: {
  date: string
  approved: Map<number, string>
  pendingDrafts: Map<number, string>
  legacyYears: Set<number>
}): CalendarReadiness {
  const y = Number(input.date.slice(0, 4))
  const month = Number(input.date.slice(5, 7))
  const required = month >= 12 ? [y, y + 1] : [y]
  const years = required.map((year) => {
    const approvedAt = input.approved.get(year) ?? null
    const draftId = input.pendingDrafts.get(year) ?? null
    const status: ReadinessStatus = approvedAt ? "approved" : input.legacyYears.has(year) ? "legacy" : draftId ? "pending_draft" : "missing"
    return { year, status, approvedAt, draftId }
  })
  const missing = years.filter((x) => x.status === "pending_draft" || x.status === "missing").map((x) => x.year)
  return { date: input.date, ready: missing.length === 0, years, missing }
}

/* ── DB ───────────────────────────────────────────────────────────── */

const DRAFT_COLS =
  "id, tenant_id, year, source, fetched_at, payload, diff, status, created_by_emp_id, approved_by_emp_id, approved_at, created_at, updated_at"

function dbError(context: string, error: { code?: string | null; message?: string | null }): Error {
  if (isMissingTableError(error)) return new CalendarImportNotMigratedError()
  return new Error(`${context}: ${error.message}`)
}

/** 建草稿：同租戶同年既有的 draft 先標 superseded（每租戶每年最多一筆 draft）。 */
export async function createImportDraft(tenantId: string, fetched: FetchedHolidayYear, actorEmpId: string | null): Promise<DraftRow> {
  const nowIso = new Date().toISOString()
  const { error: supErr } = await supabaseAdmin
    .from("calendar_import_drafts")
    .update({ status: "superseded", updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("year", fetched.year)
    .eq("status", "draft")
  if (supErr) throw dbError("createImportDraft (supersede)", supErr)
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .insert({
      tenant_id: tenantId,
      year: fetched.year,
      source: fetched.source,
      fetched_at: fetched.fetchedAt,
      payload: buildDraftPayload(fetched),
      diff: fetched.diff,
      status: "draft",
      created_by_emp_id: actorEmpId,
    })
    .select(DRAFT_COLS)
    .single()
  if (error) {
    if (error.code === "23505") throw new DraftStateError("conflict", "同一年已有另一筆草稿剛建立，請重新整理")
    throw dbError("createImportDraft (insert)", error)
  }
  return data as DraftRow
}

export async function listImportDrafts(tenantId: string, opts: { year?: number; limit?: number } = {}): Promise<DraftRow[]> {
  let q = supabaseAdmin.from("calendar_import_drafts").select(DRAFT_COLS).eq("tenant_id", tenantId)
  if (opts.year) q = q.eq("year", opts.year)
  const { data, error } = await q.order("created_at", { ascending: false }).limit(opts.limit ?? 50)
  if (error) throw dbError("listImportDrafts", error)
  return (data ?? []) as DraftRow[]
}

export async function getImportDraft(tenantId: string, id: string): Promise<DraftRow | null> {
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .select(DRAFT_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle()
  if (error) throw dbError("getImportDraft", error)
  return (data as DraftRow | null) ?? null
}

async function loadCalendarRows(tenantId: string, year: number): Promise<CalendarRowLite[]> {
  const { data, error } = await supabaseAdmin
    .from("tenant_calendar_days")
    .select("date, day_type, label, source")
    .eq("tenant_id", tenantId)
    .gte("date", `${year}-01-01`)
    .lte("date", `${year}-12-31`)
  if (error) {
    if (isMissingTableError(error)) return []
    throw new Error(`loadCalendarRows: ${error.message}`)
  }
  return (data ?? []) as CalendarRowLite[]
}

/** 草稿套用預覽（GET /calendar/import/drafts/:id）。 */
export async function previewImportDraft(tenantId: string, draft: DraftRow) {
  const [policy, existing] = await Promise.all([loadTenantWeekendPolicy(tenantId), loadCalendarRows(tenantId, draft.year)])
  return previewDraftApply({ year: draft.year, holidays: draft.payload.holidays ?? [], policy, existing })
}

/** HR 編輯草稿清單（只有 status='draft' 能改）。 */
export async function updateImportDraft(
  tenantId: string,
  id: string,
  holidays: EditedHolidayInput[],
  actorEmpId: string | null,
): Promise<DraftRow> {
  const draft = await getImportDraft(tenantId, id)
  if (!draft) throw new DraftStateError("not_found", "草稿不存在")
  if (draft.status !== "draft") throw new DraftStateError("not_editable", "只有待核准的草稿可以編輯", draft.status)
  const normalized = normalizeEditedHolidays(draft.year, holidays)
  const nowIso = new Date().toISOString()
  const payload: DraftPayload = { ...draft.payload, holidays: normalized, edited: true, editedAt: nowIso, editedByEmpId: actorEmpId }
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .update({ payload, updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", "draft")
    .select(DRAFT_COLS)
  if (error) throw dbError("updateImportDraft", error)
  const row = (data ?? [])[0] as DraftRow | undefined
  if (!row) throw new DraftStateError("not_editable", "草稿狀態已變更，請重新整理")
  return row
}

/**
 * 核准：用草稿清單寫行事曆（writers.generateTenantCalendar，HR 手動列不動、舊核准版的過期 import 列刪掉），
 * 再把草稿標 approved、同年舊的 approved 標 superseded。寫行事曆是冪等的，所以先寫行事曆、再改狀態
 * （改狀態失敗重按一次即可，不會留下「已核准卻沒寫進行事曆」）。
 */
export async function approveImportDraft(
  tenantId: string,
  id: string,
  actorEmpId: string | null,
): Promise<{ draft: DraftRow; calendar: CalendarGenerateResult }> {
  const draft = await getImportDraft(tenantId, id)
  if (!draft) throw new DraftStateError("not_found", "草稿不存在")
  if (draft.status !== "draft") throw new DraftStateError("not_editable", "只有待核准的草稿可以核准", draft.status)

  const calendar = await generateTenantCalendar(
    tenantId,
    draft.year,
    (draft.payload.holidays ?? []).map((h) => ({ date: h.date, label: h.label })),
    "approveImportDraft",
    { pruneStaleImports: true },
  )

  const nowIso = new Date().toISOString()
  const { error: supErr } = await supabaseAdmin
    .from("calendar_import_drafts")
    .update({ status: "superseded", updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("year", draft.year)
    .eq("status", "approved")
  if (supErr) throw dbError("approveImportDraft (supersede)", supErr)
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .update({ status: "approved", approved_by_emp_id: actorEmpId, approved_at: nowIso, updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("status", "draft")
    .select(DRAFT_COLS)
  if (error) throw dbError("approveImportDraft (approve)", error)
  const row = (data ?? [])[0] as DraftRow | undefined
  if (!row) throw new DraftStateError("not_editable", "草稿狀態已變更，請重新整理")

  await writeAuditLog({
    tenantId,
    tableName: "calendar_import_drafts",
    recordId: id,
    action: "UPDATE",
    oldRow: { status: "draft" },
    newRow: { status: "approved", year: draft.year, source: draft.source, edited: draft.payload.edited, calendar },
    actorEmpId,
    context: `核准 ${draft.year} 年國定假日行事曆`,
  })
  return { draft: row, calendar }
}

/** 薪資前檢查資料（GET /calendar/readiness）。 */
export async function calendarReadiness(tenantId: string, date: DateKey): Promise<CalendarReadiness> {
  const y = Number(date.slice(0, 4))
  const years = [y, y + 1]
  const approved = new Map<number, string>()
  const pendingDrafts = new Map<number, string>()
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .select("id, year, status, approved_at")
    .eq("tenant_id", tenantId)
    .in("year", years)
    .in("status", ["draft", "approved"])
  if (error && !isMissingTableError(error)) throw new Error(`calendarReadiness: ${error.message}`)
  for (const r of (data ?? []) as Array<{ id: string; year: number; status: string; approved_at: string | null }>) {
    if (r.status === "approved") approved.set(r.year, r.approved_at ?? "")
    else pendingDrafts.set(r.year, r.id)
  }
  const legacyYears = new Set<number>()
  for (const year of years) {
    if (approved.has(year)) continue
    const { data: rows, error: calErr } = await supabaseAdmin
      .from("tenant_calendar_days")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("day_type", "fixed_holiday")
      .gte("date", `${year}-01-01`)
      .lte("date", `${year}-12-31`)
      .limit(1)
    if (calErr && !isMissingTableError(calErr)) throw new Error(`calendarReadiness (calendar): ${calErr.message}`)
    if ((rows ?? []).length > 0) legacyYears.add(year)
  }
  return computeCalendarReadiness({ date, approved, pendingDrafts, legacyYears })
}

/* ── 通知與排程 ───────────────────────────────────────────────────── */

const HR_ROLES = ["hr_admin", "platform_admin"]

export async function notifyHrOfDraft(tenantId: string, draft: DraftRow, reason: "new" | "revision"): Promise<number> {
  const { data: hr, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .in("role", HR_ROLES)
  if (error) throw new Error(`notifyHrOfDraft (hr): ${error.message}`)
  const ids = (hr ?? []).map((e) => e.id as string)
  if (ids.length === 0) return 0
  const diffCount = draft.diff?.available ? draft.diff.items.length : 0
  const sourceLabel = draft.source === "dgpa" ? "人事行政總處" : "新北市（主來源暫時無法取得）"
  return enqueue({
    tenantId,
    employeeIds: ids,
    type: "calendar_import_draft",
    title:
      reason === "revision"
        ? `${draft.year} 年政府辦公日曆有修正，行事曆草稿待核准`
        : `${draft.year} 年國定假日行事曆草稿待核准`,
    body:
      `已從${sourceLabel}取得 ${draft.year} 年放假日並建立草稿` +
      (diffCount > 0 ? `（與新北資料有 ${diffCount} 處不一致，請特別確認）` : "") +
      "。請到後台 → 行事曆 → 從政府資料匯入，確認補假日、加上選舉投票日後核准；核准前不會改動行事曆。",
    payload: { key: `calendar_import_draft|${draft.id}`, draftId: draft.id, year: draft.year, reason },
  })
}

export interface HolidayJobYearResult {
  year: number
  mode: "next_year" | "recheck"
  fetch: "ok" | "not_published" | "failed" | "skipped"
  source?: HolidaySource
  error?: string
  created: number
  notified: number
  tenants: Array<{ tenantId: string; action: "created" | "revision" | "unchanged" | "has_draft" | "approved" | "error"; draftId?: string; error?: string }>
}

interface TenantYearState {
  approved: DraftRow | null
  pending: DraftRow | null
}

async function loadTenantYearState(tenantId: string, year: number): Promise<TenantYearState> {
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .select(DRAFT_COLS)
    .eq("tenant_id", tenantId)
    .eq("year", year)
    .in("status", ["draft", "approved"])
  if (error) throw dbError("loadTenantYearState", error)
  const rows = (data ?? []) as DraftRow[]
  return { approved: rows.find((r) => r.status === "approved") ?? null, pending: rows.find((r) => r.status === "draft") ?? null }
}

/**
 * 排程本體（POST /internal/calendar/holiday-import，worker 每日呼叫）。
 *   • 7/1 起：下一年（Y+1）沒有已核准、也沒有待核准草稿的租戶 → 抓、建草稿、通知 HR。
 *   • 每月 1 日（或 force）：重抓 Y 與 Y+1；租戶的已核准（或待核准）版本與官方指紋不同 → 建新草稿（取代舊草稿）＋通知；
 *     完全沒有的（例如新租戶的當年）→ 建草稿＋通知。從不自動核准、從不直接改行事曆。
 *   官方還沒公布（兩個來源都沒有這一年）→ 該年記 not_published，不通知，隔天再試。同一年只抓一次、所有租戶共用。
 */
export async function runHolidayImportJob(opts: {
  today?: DateKey
  force?: boolean
  fetchOptions?: FetchOptions
  tenantIds?: string[]
}): Promise<{ today: string; years: HolidayJobYearResult[] }> {
  const today = opts.today ?? todayKey(DEFAULT_TIMEZONE)
  const y = Number(today.slice(0, 4))
  const isRecheck = opts.force === true || today.slice(8, 10) === "01"
  const plan: Array<{ year: number; mode: HolidayJobYearResult["mode"] }> = []
  if (isRecheck) plan.push({ year: y, mode: "recheck" }, { year: y + 1, mode: "recheck" })
  else if (today.slice(5) >= "07-01") plan.push({ year: y + 1, mode: "next_year" })
  if (plan.length === 0) return { today, years: [] }

  let tenantIds = opts.tenantIds
  if (!tenantIds) {
    const { data, error } = await supabaseAdmin.from("tenants").select("id").eq("status", "active")
    if (error) throw new Error(`runHolidayImportJob (tenants): ${error.message}`)
    tenantIds = (data ?? []).map((r) => r.id as string)
  }

  const results: HolidayJobYearResult[] = []
  for (const { year, mode } of plan) {
    const result: HolidayJobYearResult = { year, mode, fetch: "skipped", created: 0, notified: 0, tenants: [] }
    let fetched: FetchedHolidayYear | null = null
    let fetchTried = false
    const getFetched = async (): Promise<FetchedHolidayYear | null> => {
      if (fetchTried) return fetched
      fetchTried = true
      try {
        fetched = await fetchHolidayYear(year, opts.fetchOptions)
        result.fetch = "ok"
        result.source = fetched.source
      } catch (err) {
        result.fetch = err instanceof HolidayFetchError && err.notPublished ? "not_published" : "failed"
        result.error = err instanceof Error ? err.message : String(err)
      }
      return fetched
    }

    for (const tenantId of tenantIds) {
      try {
        const state = await loadTenantYearState(tenantId, year)
        if (mode === "next_year") {
          if (state.approved) {
            result.tenants.push({ tenantId, action: "approved" })
            continue
          }
          if (state.pending) {
            result.tenants.push({ tenantId, action: "has_draft", draftId: state.pending.id })
            continue
          }
        }
        const base = state.pending ?? state.approved
        const f = await getFetched()
        if (!f) break
        if (base && base.payload?.officialKey === officialKey(f.data)) {
          result.tenants.push({ tenantId, action: "unchanged", draftId: base.id })
          continue
        }
        const draft = await createImportDraft(tenantId, f, null)
        result.created += 1
        result.notified += await notifyHrOfDraft(tenantId, draft, base ? "revision" : "new")
        result.tenants.push({ tenantId, action: base ? "revision" : "created", draftId: draft.id })
      } catch (err) {
        result.tenants.push({ tenantId, action: "error", error: err instanceof Error ? err.message : String(err) })
      }
    }
    results.push(result)
  }
  return { today, years: results }
}
