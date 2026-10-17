import { readFileSync } from "node:fs"
import type { Server } from "node:http"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，不連任何 DB；抓政府資料一律注入假的 fetch，不連外網。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { calendarImportRouter } from "../routes/calendar-import.js"
import {
  HolidayFetchError,
  approveImportDraft,
  buildDraftPayload,
  computeCalendarReadiness,
  decodeCsvBytes,
  diffAgainstBackup,
  fetchHolidayYear,
  holidayYearFromDgpa,
  holidayYearFromNtpc,
  normalizeEditedHolidays,
  officialKey,
  parseDgpaCsv,
  pickDgpaResource,
  previewDraftApply,
  runHolidayImportJob,
  type FetchLike,
  type FetchedHolidayYear,
  type NtpcEntry,
} from "../services/holiday-import.js"
import { planTenantCalendar } from "../services/imports/writers.js"
import { DEFAULT_WEEKEND_POLICY } from "../services/day-type.js"
import { TW_HOLIDAYS } from "../lib/tw-holidays.js"
import { SNAPSHOT_TABLES } from "../services/backup-snapshot.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 國定假日年度匯入（services/holiday-import.ts，2026-10-17）。
 *   • 解析：114 年（Big5）、115、116 年（UTF-8 BOM）官方 CSV；
 *   • 轉換：2026、2027 由官方 CSV 產生的行事曆與 2c585d9 內建清單產生的結果逐日一致（日別＋來源）；
 *   • 新北交叉比對：一致的年份 0 差異、2025 勞動節（官方 CSV 上班、新北放假）列為差異；
 *   • 主來源失敗改備援、兩者都失敗報錯（mock fetch）；
 *   • 核准不覆寫 HR 手動列、刪掉過期匯入列、狀態流轉。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../../../..")
const FIX = resolve(__dirname, "fixtures/holiday-import")
const bytes = (p: string) => new Uint8Array(readFileSync(p))
const CSV_114 = bytes(resolve(FIX, "dgpa-114-big5.csv"))
const CSV_115 = bytes(resolve(FIX, "dgpa-115.csv"))
const CSV_116 = bytes(resolve(ROOT, "packages/db/seed/dgpa-calendar-2027.csv"))
const NTPC = JSON.parse(readFileSync(resolve(FIX, "ntpc-2025-2027.json"), "utf8")) as NtpcEntry[]

const yearFromCsv = (b: Uint8Array, year: number) => holidayYearFromDgpa(parseDgpaCsv(decodeCsvBytes(b).text, year), year)

/** 行事曆計畫 → 「日期 → 日別/來源」（不比 label）。 */
function planKey(year: number, holidays: Array<{ date: string; label?: string | null }>) {
  const p = planTenantCalendar({ year, holidays, policy: DEFAULT_WEEKEND_POLICY })
  return [...p.weekendRows, ...p.holidayRows].map((r) => `${r.date}:${r.day_type}:${r.source}`).sort()
}

describe("decodeCsvBytes／parseDgpaCsv", () => {
  it("114 年是 Big5、115／116 年是 UTF-8 BOM，都解得出 365 列", () => {
    expect(decodeCsvBytes(CSV_114).encoding).toBe("big5")
    expect(decodeCsvBytes(CSV_115).encoding).toBe("utf-8")
    expect(decodeCsvBytes(CSV_116).encoding).toBe("utf-8")
    const d114 = parseDgpaCsv(decodeCsvBytes(CSV_114).text, 2025)
    expect(d114).toHaveLength(365)
    expect(d114[0]).toEqual({ date: "2025-01-01", off: true, note: "開國紀念日" })
    expect(parseDgpaCsv(decodeCsvBytes(CSV_115).text, 2026)).toHaveLength(365)
    expect(parseDgpaCsv(decodeCsvBytes(CSV_116).text, 2027)).toHaveLength(365)
  })

  it("年份不符、缺列、表頭不對 → invalid_format", () => {
    const text = decodeCsvBytes(CSV_115).text
    expect(() => parseDgpaCsv(text, 2027)).toThrow(/2027 年應有|日期不連續/)
    expect(() => parseDgpaCsv(text.split(/\r?\n/).slice(0, 100).join("\n"), 2026)).toThrow(/應有 365 列/)
    expect(() => parseDgpaCsv("a,b,c\n20260101,四,2,", 2026)).toThrow(/表頭不符/)
  })
})

describe("holidayYearFromDgpa — 轉換規則", () => {
  it("114 年：補行上班（2/8）忽略並警告；補假 label 記補哪天；兒童節與清明同日的補假找不到對象維持原名", () => {
    const y = yearFromCsv(CSV_114, 2025)
    expect(y.workdayAdjustments).toEqual([{ date: "2025-02-08", label: "補行上班" }])
    expect(y.warnings.join()).toContain("民間企業不適用")
    const byDate = new Map(y.holidays.map((h) => [h.date, h]))
    expect(byDate.get("2025-01-27")).toMatchObject({ label: "小年夜", kind: "holiday", weekend: false })
    expect(byDate.get("2025-05-30")).toMatchObject({ kind: "make_up", makeUpFor: "2025-05-31", label: "端午節補假（5/31適逢週六）" })
    expect(byDate.get("2025-09-29")?.label).toBe("孔子誕辰紀念日補假（9/28適逢週日）")
    expect(byDate.get("2025-04-03")).toMatchObject({ kind: "make_up", label: "補假" })
    // 114 年官方 CSV 勞動節是上班日（公務員不放）→ 依勞基法補為勞工放假日並警告
    expect(byDate.get("2025-05-01")).toMatchObject({ label: "勞動節", kind: "holiday", weekend: false })
    expect(y.warnings.join()).toContain("勞動節")
  })

  it("2026：與 2c585d9 內建清單產生的行事曆逐日一致（日別＋來源）", () => {
    const y = yearFromCsv(CSV_115, 2026)
    expect(planKey(2026, y.holidays)).toEqual(planKey(2026, TW_HOLIDAYS[2026]!))
    const byDate = new Map(y.holidays.map((h) => [h.date, h]))
    expect(byDate.get("2026-02-20")?.label).toBe("小年夜補假（2/15適逢週日）")
    expect(byDate.get("2026-02-27")?.label).toBe("和平紀念日補假（2/28適逢週六）")
    expect(byDate.get("2026-04-06")?.label).toBe("清明節補假（4/5適逢週日）")
    expect(y.workdayAdjustments).toEqual([])
  })

  it("2027：放假日集合與內建清單完全相同、行事曆逐日一致；12/31 是 2028 元旦補假、春節連假補假各對一天", () => {
    const y = yearFromCsv(CSV_116, 2027)
    expect(y.holidays.map((h) => h.date)).toEqual(TW_HOLIDAYS[2027]!.map((h) => h.date))
    expect(planKey(2027, y.holidays)).toEqual(planKey(2027, TW_HOLIDAYS[2027]!))
    const byDate = new Map(y.holidays.map((h) => [h.date, h]))
    expect(byDate.get("2027-12-31")).toMatchObject({ makeUpFor: "2028-01-01", label: "2028年元旦補假（2028/1/1適逢週六）" })
    expect(byDate.get("2027-02-09")?.makeUpFor).toBe("2027-02-06")
    expect(byDate.get("2027-02-10")?.makeUpFor).toBe("2027-02-07")
    expect(byDate.get("2027-04-30")?.label).toBe("勞動節補假（5/1適逢週六）")
    // 週末節日：核准時寫例假／休息日（label 註記），不寫 fixed_holiday
    const p = planTenantCalendar({ year: 2027, holidays: y.holidays, policy: DEFAULT_WEEKEND_POLICY })
    expect(p.weekendRows.find((r) => r.date === "2027-10-10")).toMatchObject({ day_type: "regular_leave" })
    expect(p.weekendRows.find((r) => r.date === "2027-10-10")?.label).toContain("國慶日")
    expect(p.holidayRows.some((r) => r.date === "2027-10-10")).toBe(false)
  })

  it("新北：特定節日排除（軍人節），但「勞工放假」的勞動節保留；補行上班列為忽略", () => {
    const y2026 = holidayYearFromNtpc(NTPC, 2026)
    expect(y2026.holidays.some((h) => h.date === "2026-09-03")).toBe(false)
    expect(y2026.ignored.find((i) => i.date === "2026-09-03")?.reason).toContain("特定節日")
    expect(y2026.holidays.find((h) => h.date === "2026-05-01")?.label).toBe("勞動節")
    const y2025 = holidayYearFromNtpc(NTPC, 2025)
    expect(y2025.workdayAdjustments.map((w) => w.date)).toEqual(["2025-02-08"])
  })
})

describe("diffAgainstBackup — 新北交叉比對", () => {
  it("2026、2027：官方 CSV 與新北一致，0 差異", () => {
    for (const [csv, year] of [[CSV_115, 2026], [CSV_116, 2027]] as const) {
      const d = diffAgainstBackup(yearFromCsv(csv, year), holidayYearFromNtpc(NTPC, year))
      expect(d.available).toBe(true)
      expect(d.items).toEqual([])
    }
  })

  it("2025：補上勞動節後與新北一致；新北少一天補假 → only_primary；官方 CSV 原樣（未補勞動節）→ only_backup", () => {
    const primary = yearFromCsv(CSV_114, 2025)
    expect(diffAgainstBackup(primary, holidayYearFromNtpc(NTPC, 2025)).items).toEqual([])
    const missing = holidayYearFromNtpc(NTPC.filter((e) => e.date !== "20251024"), 2025)
    expect(diffAgainstBackup(primary, missing).items).toEqual([
      { date: "2025-10-24", weekday: 5, kind: "only_primary", primaryLabel: "臺灣光復暨金門古寧頭大捷紀念日補假（10/25適逢週六）", backupLabel: null },
    ])
    const raw = { ...primary, holidays: primary.holidays.filter((h) => h.date !== "2025-05-01") }
    expect(diffAgainstBackup(raw, holidayYearFromNtpc(NTPC, 2025)).items).toEqual([
      { date: "2025-05-01", weekday: 4, kind: "only_backup", primaryLabel: null, backupLabel: "勞動節" },
    ])
  })

  it("新北沒有這一年／抓不到 → available=false", () => {
    const primary = yearFromCsv(CSV_116, 2027)
    expect(diffAgainstBackup(primary, holidayYearFromNtpc([], 2027))).toMatchObject({ available: false, reason: "新北資料尚無 2027 年" })
    expect(diffAgainstBackup(primary, null, "逾時")).toMatchObject({ available: false, reason: "逾時" })
  })
})

describe("pickDgpaResource", () => {
  const url = (ym: string, n: string) => `https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/${ym}/${n}.csv`
  const dist = [
    { resourceDescription: "114年中華民國政府行政機關辦公日曆表", resourceFormat: "CSV", resourceDownloadUrl: url("202407", "a") },
    { resourceDescription: "114年中華民國政府行政機關辦公日曆表_Google行事曆專用", resourceFormat: "CSV", resourceDownloadUrl: url("202407", "b") },
    { resourceDescription: "114年中華民國政府行政機關辦公日曆表(1141020更新)", resourceFormat: "CSV", resourceDownloadUrl: url("202510", "c") },
    { resourceDescription: "114年中華民國政府行政機關辦公日曆表_Google行事曆專用(修正版)", resourceFormat: "CSV", resourceDownloadUrl: url("202507", "d") },
    { resourceDescription: "116年中華民國政府行政機關辦公日曆表", resourceFormat: "CSV", resourceDownloadUrl: url("202607", "e") },
  ]
  it("修正版取最新、排除 Google 專用檔；還沒公布 → null", () => {
    expect(pickDgpaResource(dist, 2025)).toMatchObject({ version: "202510", url: url("202510", "c") })
    expect(pickDgpaResource(dist, 2027)).toMatchObject({ version: "202607" })
    expect(pickDgpaResource(dist, 2028)).toBeNull()
    expect(pickDgpaResource(undefined, 2027)).toBeNull()
  })
})

/* ── 抓取（mock fetch）────────────────────────────────────────────── */

const META = {
  result: {
    distribution: [
      { resourceDescription: "116年中華民國政府行政機關辦公日曆表", resourceFormat: "CSV", resourceDownloadUrl: "https://dgpa.test/files/202607/116.csv" },
      { resourceDescription: "116年中華民國政府行政機關辦公日曆表_Google行事曆專用", resourceFormat: "CSV", resourceDownloadUrl: "https://dgpa.test/files/202607/116g.csv" },
    ],
  },
}
const okRes = (b: Uint8Array | string) => {
  const buf = typeof b === "string" ? new TextEncoder().encode(b) : b
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }
}
const ntpcPage = (url: string) => (/[?&]page=0/.test(url) ? JSON.stringify(NTPC) : "[]")

function mockFetch(routes: { meta?: "ok" | "fail" | "hang" | "empty"; ntpc?: "ok" | "fail" | "empty" }): { fn: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fn: FetchLike = async (url, init) => {
    urls.push(url)
    if (url.includes("data.gov.tw")) {
      if (routes.meta === "fail") return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }
      if (routes.meta === "hang") {
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
      }
      return okRes(JSON.stringify(routes.meta === "empty" ? { result: { distribution: [] } } : META))
    }
    if (url.includes("dgpa.test/files/202607/116.csv")) return okRes(CSV_116)
    if (url.includes("data.ntpc.gov.tw")) {
      if (routes.ntpc === "fail") throw new Error("ECONNRESET")
      return okRes(routes.ntpc === "empty" ? "[]" : ntpcPage(url))
    }
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  return { fn, urls }
}

describe("fetchHolidayYear — 主來源／備援", () => {
  it("主來源成功：用人事行政總處、拿新北做差異（0 差異）", async () => {
    const { fn, urls } = mockFetch({ meta: "ok", ntpc: "ok" })
    const r = await fetchHolidayYear(2027, { fetchImpl: fn, timeoutMs: 500 })
    expect(r.source).toBe("dgpa")
    expect(r.resource.url).toContain("116.csv")
    expect(urls.some((u) => u.includes("116g.csv"))).toBe(false)
    expect(r.data.holidays.map((h) => h.date)).toEqual(TW_HOLIDAYS[2027]!.map((h) => h.date))
    expect(r.diff).toMatchObject({ available: true, items: [] })
  })

  it("主來源逾時 → 改用新北備援（warnings 註明、無法交叉比對）；行事曆結果與主來源一致", async () => {
    const { fn } = mockFetch({ meta: "hang", ntpc: "ok" })
    const r = await fetchHolidayYear(2027, { fetchImpl: fn, timeoutMs: 50 })
    expect(r.source).toBe("ntpc")
    expect(r.errors[0]).toContain("逾時")
    expect(r.data.warnings[0]).toContain("改用新北備援")
    expect(r.diff.available).toBe(false)
    expect(planKey(2027, r.data.holidays)).toEqual(planKey(2027, TW_HOLIDAYS[2027]!))
  })

  it("兩者都失敗 → HolidayFetchError（不是未公布）；兩者都沒有這一年 → notPublished", async () => {
    await expect(fetchHolidayYear(2027, { fetchImpl: mockFetch({ meta: "fail", ntpc: "fail" }).fn, timeoutMs: 200 })).rejects.toMatchObject({
      name: "HolidayFetchError",
      notPublished: false,
    })
    const err = await fetchHolidayYear(2028, { fetchImpl: mockFetch({ meta: "empty", ntpc: "empty" }).fn, timeoutMs: 200 }).catch((e) => e)
    expect(err).toBeInstanceOf(HolidayFetchError)
    expect((err as HolidayFetchError).notPublished).toBe(true)
  })
})

/* ── 草稿編輯、預覽、就緒（純函式）───────────────────────────────── */

describe("normalizeEditedHolidays／previewDraftApply／computeCalendarReadiness", () => {
  it("編輯：加選舉日（extra）、同日最後一筆為準、不在該年 → 錯", () => {
    const out = normalizeEditedHolidays(2027, [
      { date: "2027-11-27", label: "地方選舉投票日" },
      { date: "2027-03-01", label: "和平紀念日補假", kind: "make_up" },
      { date: "2027-03-01", label: "和平紀念日補假（改）", kind: "make_up" },
    ])
    expect(out).toEqual([
      { date: "2027-03-01", label: "和平紀念日補假（改）", kind: "make_up", weekend: false },
      { date: "2027-11-27", label: "地方選舉投票日", kind: "extra", weekend: true },
    ])
    expect(() => normalizeEditedHolidays(2027, [{ date: "2026-12-31", label: "x" }])).toThrow(/不在 2027 年/)
  })

  it("預覽：HR 手動列不動（keep_manual）、新版沒有的舊匯入列 remove、新節日 add", () => {
    const y = yearFromCsv(CSV_116, 2027)
    const { changes, counts } = previewDraftApply({
      year: 2027,
      holidays: y.holidays,
      policy: DEFAULT_WEEKEND_POLICY,
      existing: [
        { date: "2027-02-09", day_type: "workday", label: "公司照常上班", source: "manual" },
        { date: "2027-03-15", day_type: "fixed_holiday", label: "舊版錯的補假", source: "import" },
        { date: "2027-01-01", day_type: "fixed_holiday", label: "元旦（開國紀念日）", source: "import" },
      ],
    })
    const byDate = new Map(changes.map((c) => [c.date, c]))
    expect(byDate.get("2027-02-09")?.action).toBe("keep_manual")
    expect(byDate.get("2027-03-15")?.action).toBe("remove")
    expect(byDate.get("2027-01-01")?.action).toBe("change") // label 從內建清單改成官方 CSV 的名稱
    expect(byDate.get("2027-12-31")?.action).toBe("add")
    expect(counts.keep_manual).toBe(1)
  })

  it("就緒：當年要有；12 月起下一年也要有；legacy（上線前已產生）算就緒", () => {
    const approved = new Map([[2026, "2026-01-02T00:00:00Z"]])
    expect(computeCalendarReadiness({ date: "2026-11-30", approved, pendingDrafts: new Map(), legacyYears: new Set() })).toMatchObject({ ready: true, missing: [] })
    const dec = computeCalendarReadiness({ date: "2026-12-01", approved, pendingDrafts: new Map([[2027, "d1"]]), legacyYears: new Set() })
    expect(dec).toMatchObject({ ready: false, missing: [2027] })
    expect(dec.years[1]).toMatchObject({ year: 2027, status: "pending_draft", draftId: "d1" })
    expect(computeCalendarReadiness({ date: "2026-12-01", approved: new Map(), pendingDrafts: new Map(), legacyYears: new Set([2026, 2027]) }).ready).toBe(true)
  })
})

/* ── 核准（fake supabase）──────────────────────────────────────────── */

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const DRAFT_ID = "cccccccc-0000-4000-8000-000000000001"
const OLD_APPROVED_ID = "cccccccc-0000-4000-8000-000000000002"

function fetched2027(): FetchedHolidayYear {
  return {
    year: 2027,
    source: "dgpa",
    resource: { url: "https://dgpa.test/files/202607/116.csv", description: "116年", version: "202607" },
    data: yearFromCsv(CSV_116, 2027),
    diff: { available: true, backupSource: "ntpc", items: [] },
    fetchedAt: "2026-10-17T00:00:00.000Z",
    errors: [],
  }
}

function draftRow(id: string, status: string, over: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT_ID,
    year: 2027,
    source: "dgpa",
    fetched_at: "2026-10-17T00:00:00.000Z",
    payload: buildDraftPayload(fetched2027()),
    diff: { available: true, backupSource: "ntpc", items: [] },
    status,
    created_by_emp_id: null,
    approved_by_emp_id: null,
    approved_at: status === "approved" ? "2026-07-02T00:00:00.000Z" : null,
    created_at: "2026-10-17T00:00:00.000Z",
    updated_at: "2026-10-17T00:00:00.000Z",
    ...over,
  }
}

const app = express()
app.use(express.json())
app.use(calendarImportRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s))
  })
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe("approveImportDraft — 寫行事曆", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.tenants = [{ id: TENANT_ID, status: "active", features: {}, timezone: "Asia/Taipei" }]
    fake.db.employees = [{ id: HR_ID, tenant_id: TENANT_ID, user_id: "user-hr", role: "hr_admin", status: "active", dept_id: null }]
    fake.db.audit_logs = []
    fake.db.notifications = []
    fake.db.calendar_import_drafts = [draftRow(DRAFT_ID, "draft"), draftRow(OLD_APPROVED_ID, "approved")]
    fake.db.tenant_calendar_days = [
      { id: "m1", tenant_id: TENANT_ID, date: "2027-02-09", day_type: "workday", label: "公司照常上班", source: "manual" },
      { id: "i1", tenant_id: TENANT_ID, date: "2027-03-15", day_type: "fixed_holiday", label: "舊版錯的補假", source: "import" },
      { id: "g1", tenant_id: TENANT_ID, date: "2027-01-03", day_type: "rest_day", label: null, source: "generated" },
    ]
    fake.uniques.tenant_calendar_days = [["tenant_id", "date"]]
  })

  it("HR 手動列不動、過期匯入列刪除、國定假日寫入；草稿 approved、舊核准 superseded", async () => {
    const res = await request(server).post(`/calendar/import/drafts/${DRAFT_ID}/approve`).set("Authorization", "Bearer user-hr")
    expect(res.status).toBe(200)
    expect(res.body.calendar).toMatchObject({ year: 2027, skipped: 1, pruned: 1 })
    const days = new Map((fake.db.tenant_calendar_days ?? []).map((r) => [r.date as string, r]))
    expect(days.get("2027-02-09")).toMatchObject({ day_type: "workday", source: "manual", label: "公司照常上班" })
    expect(days.has("2027-03-15")).toBe(false)
    expect(days.get("2027-02-10")).toMatchObject({ day_type: "fixed_holiday", source: "import" })
    expect(days.get("2027-12-31")?.label).toBe("2028年元旦補假（2028/1/1適逢週六）")
    expect(days.get("2027-01-03")).toMatchObject({ day_type: "regular_leave", source: "generated" }) // 週日例假更正
    expect(days.get("2027-10-10")).toMatchObject({ day_type: "regular_leave", source: "generated" })
    const drafts = new Map((fake.db.calendar_import_drafts ?? []).map((r) => [r.id as string, r]))
    expect(drafts.get(DRAFT_ID)).toMatchObject({ status: "approved", approved_by_emp_id: HR_ID })
    expect(drafts.get(OLD_APPROVED_ID)?.status).toBe("superseded")
    expect((fake.db.audit_logs ?? []).some((a) => a.table_name === "calendar_import_drafts" && a.record_id === DRAFT_ID)).toBe(true)
  })

  it("已結算（發薪鎖）月份的日子不改：不寫、不刪，列在 lockedUnchanged 並警告；未鎖月份照改", async () => {
    fake.db.period_closes = [
      { tenant_id: TENANT_ID, period: "2027-03", status: "closed" },
      { tenant_id: TENANT_ID, period: "2027-04", status: "reopened" },
    ]
    const before = fake.db.tenant_calendar_days!.length
    const res = await request(server).post(`/calendar/import/drafts/${DRAFT_ID}/approve`).set("Authorization", "Bearer user-hr")
    expect(res.status).toBe(200)
    expect(res.body.calendar.lockedPeriods).toEqual(["2027-03"])
    const locked = (res.body.calendar.lockedUnchanged as Array<{ date: string; current: string; planned: string | null }>)
    // 3/1 補假本來要寫 fixed_holiday、3/15 舊匯入列本來要刪；3 月的週日（例假）只是把預設寫進去、不算變動
    expect(locked).toEqual([
      { date: "2027-03-01", current: "workday", planned: "fixed_holiday" },
      { date: "2027-03-15", current: "fixed_holiday", planned: null },
    ])
    expect(res.body.warnings[0]).toContain("已結算月份（2027-03）未變更：2027-03-01、2027-03-15")
    const days = new Map((fake.db.tenant_calendar_days ?? []).map((r) => [r.date as string, r]))
    expect(days.has("2027-03-01")).toBe(false)
    expect(days.get("2027-03-15")).toMatchObject({ day_type: "fixed_holiday", source: "import", label: "舊版錯的補假" })
    expect([...days.keys()].filter((d) => d.startsWith("2027-03-"))).toEqual(["2027-03-15"])
    // reopened 的 4 月照改
    expect(days.get("2027-04-06")).toMatchObject({ day_type: "fixed_holiday", source: "import" })
    expect(fake.db.tenant_calendar_days!.length).toBeGreaterThan(before)
    expect(res.body.calendar.pruned).toBe(0)
  })

  it("預覽：已結算月份會改到的日子標 locked", async () => {
    fake.db.period_closes = [{ tenant_id: TENANT_ID, period: "2027-03", status: "closed" }]
    const res = await request(server).get(`/calendar/import/drafts/${DRAFT_ID}`).set("Authorization", "Bearer user-hr")
    expect(res.status).toBe(200)
    const byDate = new Map((res.body.preview.changes as Row[]).map((c) => [c.date, c.action]))
    expect(byDate.get("2027-03-01")).toBe("locked")
    expect(byDate.get("2027-03-15")).toBe("locked")
    expect(byDate.get("2027-04-06")).toBe("add")
    expect(res.body.preview.closedPeriods).toEqual(["2027-03"])
  })

  it("已核准的草稿不能再核准／編輯（409）；非 HR 403", async () => {
    await approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID)
    const again = await request(server).post(`/calendar/import/drafts/${DRAFT_ID}/approve`).set("Authorization", "Bearer user-hr")
    expect(again.status).toBe(409)
    const patch = await request(server)
      .patch(`/calendar/import/drafts/${DRAFT_ID}`)
      .set("Authorization", "Bearer user-hr")
      .send({ holidays: [{ date: "2027-11-27", label: "選舉日" }] })
    expect(patch.status).toBe(409)
    fake.db.employees!.push({ id: "e2", tenant_id: TENANT_ID, user_id: "user-staff", role: "employee", status: "active" })
    expect((await request(server).get("/calendar/import/drafts").set("Authorization", "Bearer user-staff")).status).toBe(403)
  })

  it("編輯草稿（加選舉日）後核准：選舉日寫成 fixed_holiday", async () => {
    fake.db.calendar_import_drafts = [draftRow(DRAFT_ID, "draft")]
    const holidays = [...(draftRow(DRAFT_ID, "draft").payload.holidays as Array<Row>), { date: "2027-11-26", label: "地方選舉投票日", kind: "extra" }]
    const patch = await request(server).patch(`/calendar/import/drafts/${DRAFT_ID}`).set("Authorization", "Bearer user-hr").send({ holidays })
    expect(patch.status).toBe(200)
    expect(patch.body.draft.payload.edited).toBe(true)
    expect(patch.body.preview.changes.some((c: Row) => c.date === "2027-11-26" && c.action === "add")).toBe(true)
    await approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID)
    expect((fake.db.tenant_calendar_days ?? []).find((r) => r.date === "2027-11-26")).toMatchObject({ day_type: "fixed_holiday", label: "地方選舉投票日" })
  })
})

describe("runHolidayImportJob — 排程", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.tenants = [{ id: TENANT_ID, status: "active", features: {} }]
    fake.db.employees = [{ id: HR_ID, tenant_id: TENANT_ID, user_id: "user-hr", role: "hr_admin", status: "active" }]
    fake.db.notifications = []
    fake.db.calendar_import_drafts = []
  })

  it("6/30 什麼都不做；7/1 起下一年沒有核准 → 建草稿＋通知 HR；隔天有草稿就不重建", async () => {
    const opts = { fetchOptions: { fetchImpl: mockFetch({ meta: "ok", ntpc: "ok" }).fn, timeoutMs: 500 } }
    expect((await runHolidayImportJob({ today: "2026-06-30", ...opts })).years).toEqual([])
    const r1 = await runHolidayImportJob({ today: "2026-07-02", ...opts })
    expect(r1.years[0]).toMatchObject({ year: 2027, mode: "next_year", fetch: "ok", created: 1, notified: 1 })
    expect(fake.db.notifications?.[0]).toMatchObject({ employee_id: HR_ID, type: "calendar_import_draft" })
    const r2 = await runHolidayImportJob({ today: "2026-07-03", ...opts })
    expect(r2.years[0]).toMatchObject({ created: 0, fetch: "skipped" })
    expect(r2.years[0]!.tenants[0]!.action).toBe("has_draft")
  })

  it("每月 1 日重抓：官方與已核准相同 → 不動；官方修正 → 建新草稿＋通知（不自動核准）", async () => {
    fake.db.calendar_import_drafts = [draftRow(OLD_APPROVED_ID, "approved")]
    const opts = { fetchOptions: { fetchImpl: mockFetch({ meta: "ok", ntpc: "ok" }).fn, timeoutMs: 500 }, force: false }
    const same = await runHolidayImportJob({ today: "2026-11-01", ...opts })
    const y2027 = same.years.find((y) => y.year === 2027)!
    expect(y2027.tenants[0]!.action).toBe("unchanged")
    // 已核准的指紋改成舊版（模擬官方後來公布修正版）
    const old = fake.db.calendar_import_drafts!.find((r) => r.id === OLD_APPROVED_ID)!
    old.payload = { ...old.payload, officialKey: `${officialKey(old.payload.official)}x` }
    const rev = await runHolidayImportJob({ today: "2026-12-01", ...opts })
    expect(rev.years.find((y) => y.year === 2027)).toMatchObject({ created: 1, notified: 1 })
    expect(fake.db.calendar_import_drafts!.find((r) => r.id === OLD_APPROVED_ID)?.status).toBe("approved")
    expect(fake.db.notifications!.some((n) => String(n.title).includes("有修正"))).toBe(true)
  })

  it("官方還沒公布那一年 → not_published、不建草稿不通知", async () => {
    const r = await runHolidayImportJob({ today: "2027-07-05", fetchOptions: { fetchImpl: mockFetch({ meta: "empty", ntpc: "empty" }).fn, timeoutMs: 200 } })
    expect(r.years[0]).toMatchObject({ year: 2028, fetch: "not_published", created: 0, notified: 0 })
    expect(fake.db.notifications).toEqual([])
  })
})

describe("每月快照", () => {
  it("calendar_import_drafts 在 SNAPSHOT_TABLES（緊接 tenant_calendar_days）", () => {
    const names = SNAPSHOT_TABLES.map((t) => t.name)
    expect(names).toContain("calendar_import_drafts")
    expect(names.indexOf("calendar_import_drafts")).toBe(names.indexOf("tenant_calendar_days") + 1)
  })
})
