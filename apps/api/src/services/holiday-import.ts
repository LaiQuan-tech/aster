import { supabaseAdmin } from "../lib/supabase.js"
import { isMissingTableError } from "../lib/schema-compat.js"
import { addDaysKey, diffDaysKey, weekdayOfKey, todayKey, DEFAULT_TIMEZONE, type DateKey } from "../lib/tz.js"
import { generateTenantCalendar, planTenantCalendar, type CalendarGenerateResult } from "./imports/writers.js"
import { DEFAULT_WEEKEND_POLICY, loadTenantWeekendPolicy, type WeekendPolicy } from "./day-type.js"
import { enqueue } from "./notify.js"
import { findClosedPeriods } from "./period-lock.js"
import { writeAuditLog } from "./audit.js"
import { TW_HOLIDAYS } from "../lib/tw-holidays.js"

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
 *   • 「調整放假」（為配合補行上班而放的週間假，例 2025-01-27）≠「補假」（國定假日逢週末的補假，民間適用）：
 *     kind='adjusted'，草稿預設不採用（adopt=false），HR 勾選才寫入；官方 CSV 備註常只寫俗名，
 *     所以有補行上班的年份、週間放假且名稱不是民間法定節日 → 也判 adjusted；新北分類（調整放假日）可校正。
 *   • 租戶週休（tenants.features.attendance）非週六日：政府補假只在補的那天對租戶也是例假／休息日時才需要，
 *     其餘預設不採用並附註；草稿警示「政府補假日期僅供參考，請依施行細則 23-1 協商」（tenantizeHolidays）。
 *   • 新北「特定節日」（軍人節等）排除；唯一例外是描述寫「勞工放假」的勞動節（新北把 2025、2026 的勞動節歸在特定節日）。
 *   • 勞動節（5/1）是勞工法定假日，114 年以前的行政機關辦公日曆不列 → 缺了自動補上並在 warnings 註明。
 *   • 補假日期勞雇可協商、選舉投票日不在來源中 → HR 在草稿編輯（PATCH）後再核准。
 *
 * 流程：fetch → 草稿（calendar_import_drafts.status='draft'）→ HR 預覽／編輯 → 核准（寫 tenant_calendar_days，
 * 只覆寫 source generated／import 的列，HR 手動 manual 列不動；舊核准版有、新版沒有的 import 列刪掉；
 * 狀態轉換走 DB 函式 approve_calendar_import_draft 單一交易）。
 * 下載只允許 data.gov.tw／www.dgpa.gov.tw／data.ntpc.gov.tw（轉址也只能在白名單內）、單一回應上限 2 MB、逾時 12 秒。
 * 排程（worker 每日 → POST /internal/calendar/holiday-import，runHolidayImportJob）：7/1 起下一年沒有已核准行事曆
 * → 自動建草稿＋通知 HR；每月 1 日重抓當年與下一年，官方修正版與已核准（或待核准）不同 → 建新草稿＋通知，不自動覆蓋
 * （待核准草稿 HR 已編輯 → 不取代，記 pendingRevision 提示「新版可用」）。抓取連續 3 天失敗或 12 月仍無下一年 → 通知 HR。
 */

/* ── 型別 ─────────────────────────────────────────────────────────── */

export type HolidayKind = "holiday" | "make_up" | "adjusted" | "extra"

export interface DraftHoliday {
  /** YYYY-MM-DD */
  date: string
  label: string
  /** holiday＝節日本日；make_up＝補假；adjusted＝調整放假；extra＝HR 加的（例如選舉投票日）。 */
  kind: HolidayKind
  /**
   * official（政府原樣）：落在週六／週日（政府行事曆的週末，配對補假用）。
   * 草稿 holidays：落在**租戶**的例假／休息日（tenants.features.attendance，services/day-type.ts）。
   */
  weekend: boolean
  /** 補假補的是哪一天（找得到才有）。 */
  makeUpFor?: string | null
  /**
   * 是否寫入行事曆（核准時只寫採用的日子）。未設＝依 kind：adjusted（調整放假）預設不採用、其他採用。
   * 租戶週休非週六日時，「補的那天對貴公司是工作日」的政府補假也預設不採用（見 tenantizeHolidays）。
   */
  adopt?: boolean
  /** 系統附註（為何預設不採用等），給 HR 看。 */
  note?: string | null
}

/** 這一天核准時會不會寫進行事曆。純函式。 */
export function isAdopted(h: Pick<DraftHoliday, "kind" | "adopt">): boolean {
  return h.adopt ?? h.kind !== "adjusted"
}

/** 草稿清單 → 核准／預覽實際使用的清單（只留採用的）。純函式。 */
export function effectiveHolidays<T extends Pick<DraftHoliday, "kind" | "adopt">>(holidays: readonly T[]): T[] {
  return holidays.filter(isAdopted)
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
  /** 建草稿時套用的租戶週休設定（S8）。 */
  policy?: WeekendPolicy
  /** 依租戶週休產生的提醒（週休非週六日 → 政府補假僅供參考等）。 */
  tenantWarnings?: string[]
  /** 每月重抓發現官方有新版、但這份草稿 HR 已編輯 → 不取代，記在這裡提示 HR（S10a）。 */
  pendingRevision?: PendingRevision | null
}

export interface PendingRevision {
  officialKey: string
  fetchedAt: string
  source: HolidaySource
  resource: SourceResource
  /** 新版有、目前草稿的官方版沒有的放假日。 */
  added: Array<{ date: string; label: string; kind: HolidayKind }>
  /** 目前草稿的官方版有、新版沒有的放假日。 */
  removed: Array<{ date: string; label: string; kind: HolidayKind }>
  /** 同一天但類型（kind）不同。 */
  kindChanged: Array<{ date: string; from: HolidayKind; to: HolidayKind }>
  notifiedAt?: string | null
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

/** 政府行事曆的週末（週六／週日）——只用在解析官方資料、配對政府補假；租戶的休息日／例假用 isTenantOffDay。 */
function isWeekendKey(date: string): boolean {
  const wd = weekdayOfKey(date)
  return wd === 0 || wd === 6
}

/** 落在租戶的例假或休息日（tenants.features.attendance，沿用 services/day-type.ts 的讀法）。純函式。 */
export function isTenantOffDay(date: string, policy: WeekendPolicy): boolean {
  const wd = weekdayOfKey(date)
  return wd === policy.regularLeaveWeekday || wd === policy.restDayWeekday
}

/** 租戶週休＝週六＋週日（不論哪天例假、哪天休息日）——政府補假日期才直接適用。純函式。 */
export function isStandardWeekend(policy: WeekendPolicy): boolean {
  const s = new Set([policy.regularLeaveWeekday, policy.restDayWeekday])
  return s.size === 2 && s.has(0) && s.has(6)
}

/**
 * 民間適用的紀念日及節日名稱（紀念日及節日實施條例＋勞基法施行細則第 23 條）。
 * 小年夜（除夕前一日）2026 年起才是法定節日——2025 年 1/27 的小年夜是行政機關「調整放假」（2/8 補行上班）。
 */
const STATUTORY_NAME_RE = /開國紀念|元旦|除夕|春節|和平紀念|兒童節|民族掃墓|清明|勞動節|端午|中秋|孔子誕辰|教師節|國慶|光復|古寧頭|行憲紀念/
function isStatutoryName(note: string, year: number): boolean {
  if (STATUTORY_NAME_RE.test(note)) return true
  return year >= 2026 && note.includes("小年夜")
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

function adjustmentWarnings(holidays: DraftHoliday[], workdayAdjustments: WorkdayAdjustment[]): string[] {
  const adjusted = holidays.filter((h) => h.kind === "adjusted")
  const out = [
    `本年有 ${workdayAdjustments.length} 個週末補行上班日（${workdayAdjustments.map((w) => w.date).join("、")}），` +
      "是行政機關調整放假用，民間企業不適用、已忽略" +
      (adjusted.length > 0
        ? `；對應的調整放假日（${adjusted.map((h) => h.date).join("、")}）民間不適用，草稿預設不寫入，公司若要比照放假請在草稿勾選「採用」`
        : "；對應的調整放假日是否給假請 HR 確認"),
  ]
  if (adjusted.length < workdayAdjustments.length) {
    out.push(`補行上班 ${workdayAdjustments.length} 天、但只辨識出 ${adjusted.length} 個調整放假日，請 HR 核對是否有調整放假日被當成國定假日`)
  }
  return out
}

/** 人事行政總處逐日清單 → 年度假日（規則見檔頭）。純函式。 */
export function holidayYearFromDgpa(days: DgpaDay[], year: number): HolidayYear {
  const holidays: DraftHoliday[] = []
  const workdayAdjustments: WorkdayAdjustment[] = []
  const ignored: IgnoredDay[] = []
  const warnings: string[] = []
  // 有週末補行上班的年份，政府一定有對應的「調整放假」日。官方 CSV 的備註常只寫節日俗名（2025-01-27 只寫「小年夜」），
  // 所以：備註寫調整／彈性放假 → adjusted；否則週間放假、名稱不是民間法定節日 → 也當 adjusted（民間不適用，預設不寫入）。
  const hasWorkdayAdjustment = days.some((d) => d.date.startsWith(`${year}-`) && !d.off && isWeekendKey(d.date))
  for (const d of days) {
    if (!d.date.startsWith(`${year}-`)) continue
    const weekend = isWeekendKey(d.date)
    if (d.off && d.note) {
      const kind: HolidayKind = /調整放假|彈性放假/.test(d.note)
        ? "adjusted"
        : d.note.includes("補假")
          ? "make_up"
          : !weekend && hasWorkdayAdjustment && !isStatutoryName(d.note, year)
            ? "adjusted"
            : "holiday"
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
    warnings.push(...adjustmentWarnings(holidays, workdayAdjustments))
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
  if (workdayAdjustments.length > 0) warnings.push(...adjustmentWarnings(holidays, workdayAdjustments))
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

/**
 * 官方內容指紋：每月重抓時判斷「官方是否修正」。只比「週間（週一～五）放假日期＋kind」的集合——與來源（人事行政總處／新北）、
 * 名稱寫法都無關，主來源與備援交替時不會產生假修正版（S10c）。
 * 週六日的節日不進指紋：新北常不列週末節日（2026-02-15 小年夜），兩邊本來就不一致；而官方新增週末節日一定伴隨週間補假，
 * 補假日會進指紋，修正照樣偵測得到。日期用星期判斷（不看 weekend 旗標，草稿 holidays 的旗標是租戶週休）。純函式。
 */
export function officialKey(h: Pick<HolidayYear, "holidays">): string {
  return `v2:${[...new Set(h.holidays.filter((x) => !isWeekendKey(x.date)).map((x) => `${x.date}:${x.kind}`))].sort().join(",")}`
}

/** 指紋只對日期＋kind：old／new 官方版的差異（新版可用提示用）。純函式。 */
export function diffOfficial(
  oldH: readonly DraftHoliday[],
  newH: readonly DraftHoliday[],
): Pick<PendingRevision, "added" | "removed" | "kindChanged"> {
  const o = new Map(oldH.map((h) => [h.date, h]))
  const n = new Map(newH.map((h) => [h.date, h]))
  const added = [...n.values()].filter((h) => !o.has(h.date)).map((h) => ({ date: h.date, label: h.label, kind: h.kind }))
  const removed = [...o.values()].filter((h) => !n.has(h.date)).map((h) => ({ date: h.date, label: h.label, kind: h.kind }))
  const kindChanged = [...n.values()]
    .filter((h) => o.has(h.date) && o.get(h.date)!.kind !== h.kind)
    .map((h) => ({ date: h.date, from: o.get(h.date)!.kind, to: h.kind }))
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date)
  return { added: added.sort(byDate), removed: removed.sort(byDate), kindChanged: kindChanged.sort(byDate) }
}

/**
 * 主來源與新北對同一天「節日／調整放假」判斷不同 → 以新北的分類（holidaycategory 明寫「調整放假日」）為準。
 * 讓主來源成功與改用備援時同一天的 kind 一致（指紋不會因來源交替而變）。補假不動。純函式（回新物件）。
 */
export function reconcileKinds(primary: HolidayYear, backup: HolidayYear | null): HolidayYear {
  if (!backup) return primary
  const b = new Map(backup.holidays.map((h) => [h.date, h.kind]))
  const changed: string[] = []
  const holidays = primary.holidays.map((h) => {
    const bk = b.get(h.date)
    if ((h.kind === "holiday" || h.kind === "adjusted") && (bk === "holiday" || bk === "adjusted") && bk !== h.kind) {
      changed.push(`${h.date}（${bk === "adjusted" ? "調整放假" : "節日"}）`)
      return { ...h, kind: bk }
    }
    return h
  })
  if (changed.length === 0) return primary
  const warnings = [
    ...primary.warnings.filter((w) => !w.startsWith("本年有") && !w.startsWith("補行上班")),
    ...(primary.workdayAdjustments.length > 0 ? adjustmentWarnings(holidays, primary.workdayAdjustments) : []),
    `依新北資料的分類更正類型：${changed.join("、")}`,
  ]
  return { ...primary, holidays, warnings }
}

/* ── 來源挑選與抓取 ───────────────────────────────────────────────── */

export const DGPA_DATASET_URL = "https://data.gov.tw/api/v2/rest/dataset/14718"
export const NTPC_DATASET_URL = "https://data.ntpc.gov.tw/api/datasets/308DCD75-6434-45BC-A95F-584DA4FED251/json"
const NTPC_PAGE_SIZE = 1000
const NTPC_MAX_PAGES = 8
export const DEFAULT_FETCH_TIMEOUT_MS = 12_000
/** 下載網址只允許這些網域（S10d）；轉址也只能轉到這些網域。 */
export const ALLOWED_SOURCE_HOSTS: readonly string[] = ["data.gov.tw", "www.dgpa.gov.tw", "data.ntpc.gov.tw"]
/** 單一回應上限：官方 CSV 約 10 KB、新北一頁約 200 KB，2 MB 綽綽有餘。 */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3

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

export interface FetchLikeResponse {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | null
  arrayBuffer(): Promise<ArrayBuffer>
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "manual" },
) => Promise<FetchLikeResponse>

export interface FetchOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
  now?: Date
  /** 測試用：覆寫回應大小上限。 */
  maxBytes?: number
}

/**
 * 網址白名單（S10d）：只允許 ALLOWED_SOURCE_HOSTS；http 一律升 https；帳密、非預設 port 拒絕。
 * 不合格 → HolidaySourceError('invalid_format')。純函式。
 */
export function assertAllowedSourceUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new HolidaySourceError("invalid_format", `下載網址不合法：${raw.slice(0, 80)}`)
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HolidaySourceError("invalid_format", `不允許的協定：${u.protocol}`)
  if (u.username || u.password || (u.port && u.port !== "443" && u.port !== "80")) {
    throw new HolidaySourceError("invalid_format", `不允許的下載網址：${u.host}`)
  }
  const host = u.hostname.toLowerCase()
  if (!ALLOWED_SOURCE_HOSTS.includes(host)) throw new HolidaySourceError("invalid_format", `下載網址網域不在白名單：${host}`)
  u.protocol = "https:"
  u.port = ""
  return u.toString()
}

async function readCapped(res: FetchLikeResponse, maxBytes: number, url: string): Promise<Uint8Array> {
  const tooBig = () => new HolidaySourceError("invalid_format", `回應超過 ${Math.round(maxBytes / 1024)} KB 上限（${url.slice(0, 80)}）`)
  const declared = Number(res.headers?.get("content-length") ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig()
  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > maxBytes) throw tooBig()
    return buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooBig()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

async function getBytes(url: string, opts: FetchOptions): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
  try {
    // 轉址自己跟（redirect: manual），每一跳都過白名單，最多 MAX_REDIRECTS 跳。
    let current = assertAllowedSourceUrl(url)
    for (let hop = 0; ; hop += 1) {
      const res = await fetchImpl(current, {
        signal: controller.signal,
        redirect: "manual",
        headers: { accept: "*/*", "user-agent": "aster-hr-holiday-import/1.0" },
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers?.get("location")
        if (!location) throw new HolidaySourceError("http_error", `HTTP ${res.status} 轉址沒有 Location（${current.slice(0, 80)}）`)
        if (hop >= MAX_REDIRECTS) throw new HolidaySourceError("http_error", `轉址超過 ${MAX_REDIRECTS} 次（${url.slice(0, 80)}）`)
        current = assertAllowedSourceUrl(new URL(location, current).toString())
        continue
      }
      if (!res.ok) throw new HolidaySourceError("http_error", `HTTP ${res.status}（${current.slice(0, 80)}）`)
      return await readCapped(res, opts.maxBytes ?? MAX_RESPONSE_BYTES, current)
    }
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
      data: reconcileKinds(primary.value.data, backup.status === "fulfilled" ? backup.value.data : null),
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

export const NON_STANDARD_WEEKEND_WARNING = "此租戶週休非週六日，政府補假日期僅供參考，請 HR 依勞基法施行細則 23-1 協商"
const ADJUSTED_NOTE = "調整放假：政府為配合週末補行上班而放假，民間企業不適用，預設不寫入；公司要比照放假請勾選採用"

/**
 * 官方清單 → 這個租戶的草稿清單（S7＋S8）。純函式。
 *   • weekend 改成「落在租戶例假／休息日」（政府週六日只用來配對補假）。
 *   • 調整放假（adjusted）預設不採用。
 *   • 租戶週休非週六日：政府補假只在「補的那天對租戶也是例假／休息日」時才需要；
 *     補的那天是租戶工作日（節日當天已放）或補假日本身落在租戶休息日 → 預設不採用並附註；
 *     節日落在租戶例假／休息日但政府沒給補假（因為那天不是週六日）→ 提醒 HR 協商補假日（施行細則 23-1）。
 */
export function tenantizeHolidays(
  official: readonly DraftHoliday[],
  policy: WeekendPolicy,
): { holidays: DraftHoliday[]; warnings: string[] } {
  const standard = isStandardWeekend(policy)
  const warnings: string[] = []
  const needsMakeUp: string[] = []
  const notNeeded: string[] = []
  const holidays = official.map((h): DraftHoliday => {
    const out: DraftHoliday = { ...h, weekend: isTenantOffDay(h.date, policy) }
    if (h.kind === "adjusted") return { ...out, adopt: false, note: ADJUSTED_NOTE }
    if (standard) return out
    if (h.kind === "make_up") {
      if (h.makeUpFor && !isTenantOffDay(h.makeUpFor, policy)) {
        notNeeded.push(h.date)
        return { ...out, adopt: false, note: `政府補 ${h.makeUpFor}（週末）的假；該日對貴公司是工作日、節日當天已放假，不需補假` }
      }
      if (out.weekend) {
        notNeeded.push(h.date)
        return { ...out, adopt: false, note: "政府補假日落在貴公司例假／休息日，請另與勞工協商補假日" }
      }
      return { ...out, note: "政府補假日期僅供參考，請依施行細則 23-1 與勞工協商" }
    }
    if (h.kind === "holiday" && out.weekend && !isWeekendKey(h.date)) needsMakeUp.push(h.date)
    return out
  })
  if (!standard) {
    warnings.push(NON_STANDARD_WEEKEND_WARNING)
    if (notNeeded.length > 0) warnings.push(`政府補假 ${notNeeded.join("、")} 對貴公司不需要（或日期不適用），草稿預設不採用`)
    if (needsMakeUp.length > 0) {
      warnings.push(`節日 ${needsMakeUp.join("、")} 落在貴公司例假／休息日、政府沒有對應補假，請與勞工協商補假日後在草稿加上`)
    }
  }
  return { holidays, warnings }
}

export function buildDraftPayload(fetched: FetchedHolidayYear, policy: WeekendPolicy = DEFAULT_WEEKEND_POLICY): DraftPayload {
  const { holidays, warnings } = tenantizeHolidays(fetched.data.holidays, policy)
  return {
    version: 1,
    year: fetched.year,
    source: fetched.source,
    resource: fetched.resource,
    official: fetched.data,
    officialKey: officialKey(fetched.data),
    holidays,
    edited: false,
    fetchErrors: fetched.errors,
    policy,
    tenantWarnings: warnings,
    pendingRevision: null,
  }
}

export interface EditedHolidayInput {
  date: string
  label: string
  kind?: HolidayKind
  makeUpFor?: string | null
  adopt?: boolean
  note?: string | null
}

/**
 * HR 編輯後的清單 → 正規化（同日最後一筆為準、限該年、依日期排序、weekend 依租戶週休重算）。
 * adopt 未給 → 依 kind（調整放假預設不採用）。不合法 → InvalidHolidaysError。純函式。
 */
export function normalizeEditedHolidays(
  year: number,
  input: EditedHolidayInput[],
  policy: WeekendPolicy = DEFAULT_WEEKEND_POLICY,
): DraftHoliday[] {
  const byDate = new Map<string, DraftHoliday>()
  for (const h of input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date) || !h.date.startsWith(`${year}-`)) throw new InvalidHolidaysError(`日期 ${h.date} 不在 ${year} 年`)
    const label = h.label.trim()
    if (!label) throw new InvalidHolidaysError(`${h.date} 缺名稱`)
    byDate.set(h.date, {
      date: h.date,
      label: label.slice(0, 120),
      kind: h.kind ?? "extra",
      weekend: isTenantOffDay(h.date, policy),
      ...(h.makeUpFor ? { makeUpFor: h.makeUpFor } : {}),
      ...(typeof h.adopt === "boolean" ? { adopt: h.adopt } : {}),
      ...(h.note ? { note: h.note.slice(0, 200) } : {}),
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
  /**
   * add＝新增列；change＝改日別或名稱；remove＝舊匯入列（新版沒有）會刪掉；keep_manual＝HR 手動列不動（但與新版不同）；
   * locked＝落在已結算（發薪鎖）月份，核准時不改。
   */
  action: "add" | "change" | "remove" | "keep_manual" | "locked"
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
  /** 已結算月份（YYYY-MM）：這些月份會改到的日子標 locked。 */
  closedPeriods?: readonly string[]
}): { changes: PreviewChange[]; counts: Record<PreviewChange["action"], number> } {
  const closed = new Set(input.closedPeriods ?? [])
  const existingByDate = new Map(input.existing.filter((r) => r.date.startsWith(`${input.year}-`)).map((r) => [r.date, r]))
  const existingSources = new Map([...existingByDate.values()].map((r) => [r.date, r.source ?? "generated"]))
  const plan = planTenantCalendar({ year: input.year, holidays: effectiveHolidays(input.holidays), policy: input.policy })
  const planned = new Map([...plan.weekendRows, ...plan.holidayRows].map((r) => [r.date, r]))
  const changes: PreviewChange[] = []
  const dates = new Set([...planned.keys(), ...existingByDate.keys()])
  const push = (c: PreviewChange) => changes.push(closed.has(c.date.slice(0, 7)) && c.action !== "keep_manual" ? { ...c, action: "locked" } : c)
  for (const date of [...dates].sort()) {
    const cur = existingByDate.get(date) ?? null
    const nxt = planned.get(date) ?? null
    const current = cur ? { dayType: cur.day_type, label: cur.label, source: cur.source } : null
    const next = nxt ? { dayType: nxt.day_type, label: nxt.label } : null
    if (cur && existingSources.get(date) === "manual") {
      if (!nxt || nxt.day_type !== cur.day_type) push({ date, weekday: weekdayOfKey(date), current, next, action: "keep_manual" })
      continue
    }
    if (!cur && nxt) {
      // 週末列沒寫過也只是把預設寫進去，不算變動；節日（有 label）才列。
      if (nxt.day_type === "fixed_holiday" || nxt.label) push({ date, weekday: weekdayOfKey(date), current, next, action: "add" })
      continue
    }
    if (cur && !nxt) {
      if (cur.source === "import") push({ date, weekday: weekdayOfKey(date), current, next, action: "remove" })
      continue
    }
    if (cur && nxt && (cur.day_type !== nxt.day_type || (cur.label ?? null) !== (nxt.label ?? null))) {
      push({ date, weekday: weekdayOfKey(date), current, next, action: "change" })
    }
  }
  const counts = { add: 0, change: 0, remove: 0, keep_manual: 0, locked: 0 }
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

/** 建草稿：同租戶同年既有的 draft 先標 superseded（每租戶每年最多一筆 draft）。草稿清單依租戶週休調整（tenantizeHolidays）。 */
export async function createImportDraft(tenantId: string, fetched: FetchedHolidayYear, actorEmpId: string | null): Promise<DraftRow> {
  const policy = await loadTenantWeekendPolicy(tenantId)
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
      payload: buildDraftPayload(fetched, policy),
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
  const [policy, existing, closedPeriods] = await Promise.all([
    loadTenantWeekendPolicy(tenantId),
    loadCalendarRows(tenantId, draft.year),
    findClosedPeriods(tenantId, { ranges: [{ from: `${draft.year}-01`, to: `${draft.year}-12` }] }),
  ])
  return { ...previewDraftApply({ year: draft.year, holidays: draft.payload.holidays ?? [], policy, existing, closedPeriods }), closedPeriods }
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
  const normalized = normalizeEditedHolidays(draft.year, holidays, await loadTenantWeekendPolicy(tenantId))
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

/** DB 函式 approve_calendar_import_draft（sql/0061）還沒建：PostgREST 找不到函式（PGRST202）或 PG 42883。 */
function isMissingFunctionError(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "")
}

/**
 * 核准狀態轉換（S6）：「把草稿標 approved」與「把同年其他 approved 標 superseded」要原子化。
 *   主路徑：DB 函式 approve_calendar_import_draft（單一交易；advisory lock 依租戶＋年份序列化；
 *           只在草稿仍是 draft 時才動，作廢條件排除自己）→ 回核准後的列；草稿已不是 draft → 回空 → conflict。
 *   函式未建（舊庫）→ 退回應用層：作廢他人時排除自己、核准以「仍為 draft」為條件；核准失敗 → 把剛作廢的還原，
 *           不作廢他人。同時核准兩次最後恰好一筆 approved（另一個拿到 conflict）。
 */
async function transitionToApproved(tenantId: string, draft: DraftRow, actorEmpId: string | null): Promise<DraftRow> {
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("approve_calendar_import_draft", {
    p_tenant_id: tenantId,
    p_draft_id: draft.id,
    p_actor_emp_id: actorEmpId,
  })
  if (!rpcErr) {
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as DraftRow | null | undefined
    if (!row || !row.id) throw new DraftStateError("not_editable", "草稿狀態已變更（可能已被核准或被新草稿取代），請重新整理")
    return row
  }
  if (!isMissingFunctionError(rpcErr)) throw dbError("approveImportDraft (rpc)", rpcErr)

  const nowIso = new Date().toISOString()
  const { data: supData, error: supErr } = await supabaseAdmin
    .from("calendar_import_drafts")
    .update({ status: "superseded", updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("year", draft.year)
    .eq("status", "approved")
    .neq("id", draft.id)
    .select("id")
  if (supErr) throw dbError("approveImportDraft (supersede)", supErr)
  const supersededIds = ((supData ?? []) as Array<{ id: string }>).map((r) => r.id)
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .update({ status: "approved", approved_by_emp_id: actorEmpId, approved_at: nowIso, updated_at: nowIso })
    .eq("tenant_id", tenantId)
    .eq("id", draft.id)
    .eq("status", "draft")
    .select(DRAFT_COLS)
  const row = (data ?? [])[0] as DraftRow | undefined
  if (error || !row) {
    // 核准失敗：剛剛作廢的舊核准還原（若期間已有別人核准成功，唯一索引會擋還原——那就維持作廢）。
    if (supersededIds.length > 0) {
      const { data: still } = await supabaseAdmin
        .from("calendar_import_drafts")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("year", draft.year)
        .eq("status", "approved")
      if ((still ?? []).length === 0) {
        await supabaseAdmin
          .from("calendar_import_drafts")
          .update({ status: "approved", updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("status", "superseded")
          .in("id", supersededIds.slice(0, 1))
      }
    }
    if (error) throw dbError("approveImportDraft (approve)", error)
    throw new DraftStateError("not_editable", "草稿狀態已變更（可能已被核准或被新草稿取代），請重新整理")
  }
  return row
}

/**
 * 核准：用草稿清單中「採用」的日子（effectiveHolidays；調整放假預設不採用）寫行事曆
 * （writers.generateTenantCalendar，HR 手動列不動、舊核准版的過期 import 列刪掉；
 * 已結算（發薪鎖）月份的日子不寫不刪，會改到的列在 calendar.lockedUnchanged、warnings 提醒 HR），
 * 再原子地把草稿標 approved、同年其他 approved 標 superseded（transitionToApproved）。寫行事曆是冪等的，
 * 所以先寫行事曆、再改狀態（改狀態失敗重按一次即可，不會留下「已核准卻沒寫進行事曆」）。
 */
export async function approveImportDraft(
  tenantId: string,
  id: string,
  actorEmpId: string | null,
): Promise<{ draft: DraftRow; calendar: CalendarGenerateResult; warnings: string[] }> {
  const draft = await getImportDraft(tenantId, id)
  if (!draft) throw new DraftStateError("not_found", "草稿不存在")
  if (draft.status !== "draft") throw new DraftStateError("not_editable", "只有待核准的草稿可以核准", draft.status)

  const adopted = effectiveHolidays(draft.payload.holidays ?? [])
  const calendar = await generateTenantCalendar(
    tenantId,
    draft.year,
    adopted.map((h) => ({ date: h.date, label: h.label })),
    "approveImportDraft",
    { pruneStaleImports: true, skipClosedPeriods: true },
  )
  const locked = calendar.lockedUnchanged ?? []
  const warnings =
    locked.length > 0
      ? [
          `${locked.length} 天落在已結算月份（${(calendar.lockedPeriods ?? []).join("、")}）未變更：${locked.map((l) => l.date).join("、")}。` +
            "如需更正，請先重新開放該月再重新匯入核准，或由 HR 手動處理並評估補發／扣回。",
        ]
      : []

  const row = await transitionToApproved(tenantId, draft, actorEmpId)

  await writeAuditLog({
    tenantId,
    tableName: "calendar_import_drafts",
    recordId: id,
    action: "UPDATE",
    oldRow: { status: "draft" },
    newRow: { status: "approved", year: draft.year, source: draft.source, edited: draft.payload.edited, calendar, warnings },
    actorEmpId,
    context: `核准 ${draft.year} 年國定假日行事曆`,
  })
  return { draft: row, calendar, warnings }
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

async function hrEmployeeIds(tenantId: string): Promise<string[]> {
  const { data: hr, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .in("role", HR_ROLES)
  if (error) throw new Error(`hrEmployeeIds: ${error.message}`)
  return (hr ?? []).map((e) => e.id as string)
}

export async function notifyHrOfDraft(tenantId: string, draft: DraftRow, reason: "new" | "revision"): Promise<number> {
  const ids = await hrEmployeeIds(tenantId)
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

/** 官方有新版、但草稿已被 HR 編輯 → 不取代，通知「新版可用」（S10a）。 */
async function notifyHrOfRevisionAvailable(tenantId: string, draft: DraftRow, rev: PendingRevision): Promise<number> {
  const ids = await hrEmployeeIds(tenantId)
  if (ids.length === 0) return 0
  const parts = [
    rev.added.length > 0 ? `新增 ${rev.added.map((h) => h.date).join("、")}` : "",
    rev.removed.length > 0 ? `取消 ${rev.removed.map((h) => h.date).join("、")}` : "",
    rev.kindChanged.length > 0 ? `類型變更 ${rev.kindChanged.map((h) => h.date).join("、")}` : "",
  ].filter(Boolean)
  return enqueue({
    tenantId,
    employeeIds: ids,
    type: "calendar_import_revision",
    title: `${draft.year} 年政府辦公日曆有新版（您編輯中的草稿未被取代）`,
    body:
      `政府資料有修正${parts.length > 0 ? `（${parts.join("；")}）` : ""}。您已編輯的草稿保留不動；` +
      "請到後台 → 行事曆 → 從政府資料匯入查看差異，決定手動調整或改用新版重建草稿。",
    payload: { key: `calendar_import_revision|${draft.id}|${rev.officialKey}`, draftId: draft.id, year: draft.year },
  })
}

/** 抓取持續失敗（S10b）通知。 */
async function notifyHrOfFetchFailure(tenantId: string, year: number, reason: string): Promise<number> {
  const ids = await hrEmployeeIds(tenantId)
  if (ids.length === 0) return 0
  return enqueue({
    tenantId,
    employeeIds: ids,
    type: "calendar_import_fetch_failed",
    title: `${year} 年政府辦公日曆無法自動取得`,
    body:
      `${reason}。請到後台 → 行事曆 → 從政府資料匯入手動重試；仍失敗請依人事行政總處公告手動建立 ${year} 年國定假日，` +
      "避免薪資結算用錯日別。",
    payload: { key: `calendar_import_fetch_failed|${year}`, year },
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
  /** 這一年沒處理成的租戶數（抓取失敗＋租戶錯誤）。 */
  failed: number
  /** 抓取連續失敗天數（calendar_import_fetch_status；表未建 → null）。 */
  consecutiveFailures?: number | null
  /** 這次發出「抓取持續失敗」通知的租戶數。 */
  alerted: number
  tenants: Array<{
    tenantId: string
    action: "created" | "revision" | "revision_available" | "unchanged" | "has_draft" | "approved" | "error"
    draftId?: string
    error?: string
  }>
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

/** 既有草稿／核准的官方指紋——用存下來的 official 重算（指紋格式改版後不會整批誤判成修正版）。 */
export function baseOfficialKey(payload: DraftPayload | null | undefined): string | null {
  if (!payload) return null
  if (payload.official && Array.isArray(payload.official.holidays)) return officialKey(payload.official)
  return payload.officialKey ?? null
}

/** 草稿已編輯、官方有新版 → 記 pendingRevision（同一版只記一次、只通知一次）。回是否新記錄。 */
async function markRevisionAvailable(tenantId: string, draft: DraftRow, f: FetchedHolidayYear): Promise<PendingRevision | null> {
  const key = officialKey(f.data)
  if (draft.payload.pendingRevision?.officialKey === key) return null
  const rev: PendingRevision = {
    officialKey: key,
    fetchedAt: f.fetchedAt,
    source: f.source,
    resource: f.resource,
    ...diffOfficial(draft.payload.official?.holidays ?? [], f.data.holidays),
    notifiedAt: new Date().toISOString(),
  }
  const { data, error } = await supabaseAdmin
    .from("calendar_import_drafts")
    .update({ payload: { ...draft.payload, pendingRevision: rev }, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", draft.id)
    .eq("status", "draft")
    .select("id")
  if (error) throw dbError("markRevisionAvailable", error)
  if ((data ?? []).length === 0) throw new DraftStateError("conflict", "草稿狀態已變更")
  return rev
}

/* ── 抓取失敗追蹤（S10b）──────────────────────────────────────────── */

export const FETCH_FAILURE_ALERT_DAYS = 3
const FETCH_ALERT_REPEAT_DAYS = 7

export interface FetchStatusRow {
  year: number
  consecutive_failures: number
  last_attempt_on: string | null
  last_outcome: string | null
  last_error: string | null
  alerted_on: string | null
}

/**
 * 純函式：記一次抓取結果 → 新狀態。失敗（failed）同一天重跑不重複累計；成功或未公布 → 歸零。
 * not_published 不算失敗（官方本來就還沒公布），只有 December 規則會看它。
 */
export function nextFetchStatus(prev: FetchStatusRow | null, year: number, outcome: "ok" | "not_published" | "failed", today: string, error: string | null): FetchStatusRow {
  if (outcome !== "failed") {
    return { year, consecutive_failures: 0, last_attempt_on: today, last_outcome: outcome, last_error: null, alerted_on: outcome === "ok" ? null : (prev?.alerted_on ?? null) }
  }
  const prevCount = prev?.last_outcome === "failed" ? prev.consecutive_failures : 0
  const sameDay = prev?.last_attempt_on === today
  const consecutive = prev?.last_attempt_on && !sameDay && diffDaysKey(prev.last_attempt_on, today) > 1 ? 1 : sameDay ? Math.max(prevCount, 1) : prevCount + 1
  return { year, consecutive_failures: consecutive, last_attempt_on: today, last_outcome: "failed", last_error: error, alerted_on: prev?.alerted_on ?? null }
}

/**
 * 純函式：要不要發「抓取持續失敗」通知。
 *   • 連續失敗 ≥ 3 天；或
 *   • 12 月了、下一年（year = 今年＋1）還沒拿到（failed 或 not_published）。
 * 已通知過 → 7 天內不重發。
 */
export function shouldAlertFetchFailure(input: {
  status: FetchStatusRow | null
  outcome: "ok" | "not_published" | "failed"
  year: number
  today: string
}): string | null {
  if (input.outcome === "ok") return null
  const { status, today } = input
  if (status?.alerted_on && diffDaysKey(status.alerted_on, today) < FETCH_ALERT_REPEAT_DAYS) return null
  const thisYear = Number(today.slice(0, 4))
  if (input.outcome === "failed" && (status?.consecutive_failures ?? 0) >= FETCH_FAILURE_ALERT_DAYS) {
    return `政府辦公日曆已連續 ${status!.consecutive_failures} 天抓取失敗（${status!.last_error ?? "原因不明"}）`
  }
  if (today.slice(5, 7) === "12" && input.year === thisYear + 1) {
    return input.outcome === "not_published"
      ? `已經 12 月，政府尚未公布 ${input.year} 年辦公日曆（或資料平台尚未上架）`
      : `已經 12 月，仍無法取得 ${input.year} 年辦公日曆`
  }
  return null
}

async function loadFetchStatus(year: number): Promise<{ row: FetchStatusRow | null; available: boolean }> {
  const { data, error } = await supabaseAdmin.from("calendar_import_fetch_status").select("*").eq("year", year).maybeSingle()
  if (error) {
    if (isMissingTableError(error)) return { row: null, available: false }
    throw new Error(`loadFetchStatus: ${error.message}`)
  }
  return { row: (data as FetchStatusRow | null) ?? null, available: true }
}

async function saveFetchStatus(row: FetchStatusRow): Promise<void> {
  const { error } = await supabaseAdmin
    .from("calendar_import_fetch_status")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "year" })
  if (error && !isMissingTableError(error)) throw new Error(`saveFetchStatus: ${error.message}`)
}

/**
 * 排程本體（POST /internal/calendar/holiday-import，worker 每日呼叫）。
 *   • 7/1 起：下一年（Y+1）沒有已核准、也沒有待核准草稿的租戶 → 抓、建草稿、通知 HR。
 *   • 每月 1 日（或 force）：重抓 Y 與 Y+1；租戶的已核准（或待核准）版本與官方指紋（日期＋kind，與來源無關）不同 →
 *     待核准草稿 HR 沒編輯過 → 建新草稿（取代）＋通知；**HR 編輯過 → 不取代**，記 pendingRevision＋通知「新版可用」；
 *     完全沒有的（例如新租戶的當年）→ 建草稿＋通知。從不自動核准、從不直接改行事曆。
 *   官方還沒公布（兩個來源都沒有這一年）→ 該年記 not_published，不通知，隔天再試。同一年只抓一次、所有租戶共用。
 *   抓取失敗：沒處理到的租戶記 error（failed 計數）；連續 3 天失敗、或 12 月仍沒有下一年 → 通知 HR（7 天內不重發）。
 */
export async function runHolidayImportJob(opts: {
  today?: DateKey
  force?: boolean
  fetchOptions?: FetchOptions
  tenantIds?: string[]
}): Promise<{ today: string; failed: number; years: HolidayJobYearResult[] }> {
  const today = opts.today ?? todayKey(DEFAULT_TIMEZONE)
  const y = Number(today.slice(0, 4))
  const isRecheck = opts.force === true || today.slice(8, 10) === "01"
  const plan: Array<{ year: number; mode: HolidayJobYearResult["mode"] }> = []
  if (isRecheck) plan.push({ year: y, mode: "recheck" }, { year: y + 1, mode: "recheck" })
  else if (today.slice(5) >= "07-01") plan.push({ year: y + 1, mode: "next_year" })
  if (plan.length === 0) return { today, failed: 0, years: [] }

  let tenantIds = opts.tenantIds
  if (!tenantIds) {
    const { data, error } = await supabaseAdmin.from("tenants").select("id").eq("status", "active")
    if (error) throw new Error(`runHolidayImportJob (tenants): ${error.message}`)
    tenantIds = (data ?? []).map((r) => r.id as string)
  }

  const results: HolidayJobYearResult[] = []
  for (const { year, mode } of plan) {
    const result: HolidayJobYearResult = { year, mode, fetch: "skipped", created: 0, notified: 0, failed: 0, alerted: 0, tenants: [] }
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

    const waiting: string[] = [] // 需要官方資料、但沒拿到的租戶
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
        if (!f) {
          waiting.push(tenantId)
          continue
        }
        const key = officialKey(f.data)
        if (base && baseOfficialKey(base.payload) === key) {
          result.tenants.push({ tenantId, action: "unchanged", draftId: base.id })
          continue
        }
        if (state.pending && state.pending.payload?.edited) {
          const rev = await markRevisionAvailable(tenantId, state.pending, f)
          if (rev) result.notified += await notifyHrOfRevisionAvailable(tenantId, state.pending, rev)
          result.tenants.push({ tenantId, action: "revision_available", draftId: state.pending.id })
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

    if (fetchTried) {
      const outcome = result.fetch === "ok" ? "ok" : result.fetch === "not_published" ? "not_published" : "failed"
      const { row: prev, available } = await loadFetchStatus(year)
      const status = nextFetchStatus(prev, year, outcome, today, result.error ?? null)
      result.consecutiveFailures = available ? status.consecutive_failures : null
      // 表未建（舊庫）：沒有連續天數也沒有去重——只剩 12 月規則，且只在每月 1 日／15 日發，避免天天轟炸。
      const alertReason =
        available || ["01", "15"].includes(today.slice(8, 10))
          ? shouldAlertFetchFailure({ status: available ? status : null, outcome, year, today })
          : null
      if (outcome === "failed") {
        for (const tenantId of waiting) result.tenants.push({ tenantId, action: "error", error: `抓取失敗：${result.error ?? ""}` })
      }
      if (alertReason) {
        for (const tenantId of waiting) {
          try {
            const n = await notifyHrOfFetchFailure(tenantId, year, alertReason)
            result.notified += n
            if (n > 0) result.alerted += 1
          } catch {
            /* 通知失敗不影響排程結果 */
          }
        }
        if (result.alerted > 0) status.alerted_on = today
      }
      if (available) await saveFetchStatus(status)
    }
    result.failed = result.tenants.filter((t) => t.action === "error").length
    results.push(result)
  }
  return { today, failed: results.reduce((sum, r) => sum + r.failed, 0), years: results }
}

/* ── 改週休設定後重新產生（S9）──────────────────────────────────── */

export interface RegenerateYearResult {
  year: number
  holidaySource: "approved_draft" | "builtin" | "none"
  calendar: CalendarGenerateResult
  /** 舊週休產生、新週休不再是例假／休息日的 generated 列（已刪；已結算月不刪）。 */
  removedStaleWeekend: number
  lockedPeriods: string[]
}

/**
 * HR 改了例假／休息日後，重新產生未結算月份的行事曆（HR 按鈕觸發，不自動執行）。
 * 每年：有已核准草稿 → 用它採用的日子（並刪過期匯入列）；沒有 → 內建清單（TW_HOLIDAYS，沒有就只產生例假／休息日）。
 * 呼叫 generateTenantCalendar（skipClosedPeriods）；再刪掉「舊週休產生、現在已不是例假／休息日」的 generated 列
 * （generateTenantCalendar 只 upsert，不會清掉舊週休的列）。HR 手動列與已結算月份一律不動。
 */
export async function regenerateOpenCalendar(tenantId: string, years: number[]): Promise<RegenerateYearResult[]> {
  const out: RegenerateYearResult[] = []
  for (const year of years) {
    const state = await loadTenantYearState(tenantId, year).catch((err) => {
      if (err instanceof CalendarImportNotMigratedError) return { approved: null, pending: null } as TenantYearState
      throw err
    })
    const holidays = state.approved
      ? effectiveHolidays(state.approved.payload.holidays ?? []).map((h) => ({ date: h.date, label: h.label }))
      : undefined
    const calendar = await generateTenantCalendar(tenantId, year, holidays, "regenerateOpenCalendar", {
      skipClosedPeriods: true,
      pruneStaleImports: !!state.approved,
    })
    const lockedPeriods = calendar.lockedPeriods ?? []
    const closed = new Set(lockedPeriods)
    const policy = await loadTenantWeekendPolicy(tenantId)
    const rows = await loadCalendarRows(tenantId, year)
    const stale = rows
      .filter((r) => r.source === "generated" && !closed.has(r.date.slice(0, 7)) && !isTenantOffDay(r.date, policy))
      .map((r) => r.date)
    let removedStaleWeekend = 0
    if (stale.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("tenant_calendar_days")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("source", "generated")
        .in("date", stale)
        .select("id")
      if (error) throw new Error(`regenerateOpenCalendar (stale): ${error.message}`)
      removedStaleWeekend = (data ?? []).length
    }
    out.push({
      year,
      holidaySource: state.approved ? "approved_draft" : TW_HOLIDAYS[year] ? "builtin" : "none",
      calendar,
      removedStaleWeekend,
      lockedPeriods,
    })
  }
  return out
}
