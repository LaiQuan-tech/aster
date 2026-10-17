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
import { tenantRouter, weekendChangeHint } from "../routes/tenant.js"
import {
  DraftStateError,
  HolidayFetchError,
  MAX_RESPONSE_BYTES,
  NON_STANDARD_WEEKEND_WARNING,
  approveImportDraft,
  assertAllowedSourceUrl,
  effectiveHolidays,
  isAdopted,
  nextFetchStatus,
  reconcileKinds,
  shouldAlertFetchFailure,
  tenantizeHolidays,
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
    // 2025 的小年夜是行政機關「調整放假」（2/8 補行上班），官方 CSV 備註只寫「小年夜」→ 仍辨識為 adjusted（S7）
    expect(byDate.get("2025-01-27")).toMatchObject({ label: "小年夜", kind: "adjusted", weekend: false })
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
      { resourceDescription: "116年中華民國政府行政機關辦公日曆表", resourceFormat: "CSV", resourceDownloadUrl: "https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/202607/116.csv" },
      { resourceDescription: "116年中華民國政府行政機關辦公日曆表_Google行事曆專用", resourceFormat: "CSV", resourceDownloadUrl: "https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/202607/116g.csv" },
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
    if (url.includes("www.dgpa.gov.tw/") && url.includes("files/202607/116.csv")) return okRes(CSV_116)
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
    resource: { url: "https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/202607/116.csv", description: "116年", version: "202607" },
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

/**
 * 仿 DB 函式 approve_calendar_import_draft（sql/0061）：同一交易內「草稿仍為 draft 才核准、作廢同年其他 approved（排除自己）」，
 * 草稿已不是 draft → 回 0 列。fake 是單執行緒、handler 內沒有 await，所以整段天然原子（等同 advisory lock 序列化）。
 */
function registerApproveRpc() {
  fake.rpcHandlers.approve_calendar_import_draft = (args) => {
    const rows = fake.db.calendar_import_drafts ?? []
    const draft = rows.find((r) => r.id === args.p_draft_id && r.tenant_id === args.p_tenant_id && r.status === "draft")
    if (!draft) return { data: [], error: null }
    const now = new Date().toISOString()
    for (const r of rows) {
      if (r.tenant_id === args.p_tenant_id && r.year === draft.year && r.status === "approved" && r.id !== draft.id) {
        r.status = "superseded"
        r.updated_at = now
      }
    }
    Object.assign(draft, { status: "approved", approved_by_emp_id: args.p_actor_emp_id, approved_at: now, updated_at: now })
    return { data: [{ ...draft }], error: null }
  }
}

const app = express()
app.use(express.json())
app.use(calendarImportRouter)
app.use(tenantRouter)
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
    registerApproveRpc()
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
    // 已核准的官方內容改成舊版（模擬官方後來公布修正版：少了選舉日以外的一天）
    const old = fake.db.calendar_import_drafts!.find((r) => r.id === OLD_APPROVED_ID)!
    old.payload = {
      ...old.payload,
      official: { ...old.payload.official, holidays: old.payload.official.holidays.filter((h: Row) => h.date !== "2027-12-31") },
    }
    expect(officialKey(old.payload.official)).not.toBe(officialKey(yearFromCsv(CSV_116, 2027)))
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

/* ══ 2026-10-17 獨立驗收 S6–S10 ══════════════════════════════════════ */

const OTHER_DRAFT_ID = "cccccccc-0000-4000-8000-000000000003"
const PGRST202 = { data: null, error: { code: "PGRST202", message: "Could not find the function public.approve_calendar_import_draft" } }

function setupApproveDb() {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, status: "active", features: {}, timezone: "Asia/Taipei", branding: {} }]
  fake.db.employees = [{ id: HR_ID, tenant_id: TENANT_ID, user_id: "user-hr", role: "hr_admin", status: "active", dept_id: null }]
  fake.db.audit_logs = []
  fake.db.notifications = []
  fake.db.calendar_import_drafts = [draftRow(DRAFT_ID, "draft"), draftRow(OLD_APPROVED_ID, "approved")]
  fake.db.tenant_calendar_days = []
  fake.uniques.tenant_calendar_days = [["tenant_id", "date"]]
}
const approvedRows = () => (fake.db.calendar_import_drafts ?? []).filter((r) => r.status === "approved")

describe("S6 核准原子化", () => {
  beforeEach(setupApproveDb)

  it("DB 函式路徑：同時核准兩次 → 一個成功、一個 conflict，最後恰好一筆 approved、舊核准 superseded", async () => {
    registerApproveRpc()
    const results = await Promise.allSettled([approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID), approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(DraftStateError)
    expect(approvedRows().map((r) => r.id)).toEqual([DRAFT_ID])
    expect(fake.db.calendar_import_drafts!.find((r) => r.id === OLD_APPROVED_ID)?.status).toBe("superseded")
    expect(fake.rpcCalls.filter((c) => c.name === "approve_calendar_import_draft")).toHaveLength(2)
  })

  it("函式未建（PGRST202）退回應用層：同時核准兩次最後也恰好一筆 approved（作廢排除自己）", async () => {
    fake.rpcHandlers.approve_calendar_import_draft = () => PGRST202
    const results = await Promise.allSettled([approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID), approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(approvedRows().map((r) => r.id)).toEqual([DRAFT_ID])
  })

  it("退回應用層時核准失敗（草稿剛被新草稿取代）→ 409，且不作廢現行核准", async () => {
    fake.rpcHandlers.approve_calendar_import_draft = () => {
      // 模擬：檢查完狀態後、改狀態前，排程建了新草稿把這份標 superseded
      fake.db.calendar_import_drafts!.find((r) => r.id === DRAFT_ID)!.status = "superseded"
      return PGRST202
    }
    await expect(approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID)).rejects.toBeInstanceOf(DraftStateError)
    expect(approvedRows().map((r) => r.id)).toEqual([OLD_APPROVED_ID])
  })

  it("DB 函式回 0 列（草稿已非 draft）→ 409 draft_not_editable，不作廢他人", async () => {
    fake.rpcHandlers.approve_calendar_import_draft = () => ({ data: [], error: null })
    const res = await request(server).post(`/calendar/import/drafts/${DRAFT_ID}/approve`).set("Authorization", "Bearer user-hr")
    expect(res.status).toBe(409)
    expect(approvedRows().map((r) => r.id)).toEqual([OLD_APPROVED_ID])
  })
})

/* ── S7 調整放假 ─────────────────────────────────────────────────── */

function fetched2025(): FetchedHolidayYear {
  return {
    year: 2025,
    source: "dgpa",
    resource: { url: "https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/202407/114.csv", description: "114年", version: "202407" },
    data: yearFromCsv(CSV_114, 2025),
    diff: { available: true, backupSource: "ntpc", items: [] },
    fetchedAt: "2026-10-17T00:00:00.000Z",
    errors: [],
  }
}

describe("S7 調整放假 vs 補假", () => {
  it("2025-01-27 調整放假：草稿 kind=adjusted、預設不採用（附註）；補假（5/30、9/29）照常採用", () => {
    const payload = buildDraftPayload(fetched2025())
    const byDate = new Map(payload.holidays.map((h) => [h.date, h]))
    expect(byDate.get("2025-01-27")).toMatchObject({ kind: "adjusted", adopt: false })
    expect(byDate.get("2025-01-27")?.note).toContain("民間企業不適用")
    expect(isAdopted(byDate.get("2025-05-30")!)).toBe(true)
    expect(byDate.get("2025-05-30")?.kind).toBe("make_up")
    expect(isAdopted(byDate.get("2025-09-29")!)).toBe(true)
    expect(effectiveHolidays(payload.holidays).some((h) => h.date === "2025-01-27")).toBe(false)
    expect(payload.official.warnings.join()).toContain("2025-01-27")
    // 新北分類明寫「調整放假日」→ 同樣 adjusted
    expect(holidayYearFromNtpc(NTPC, 2025).holidays.find((h) => h.date === "2025-01-27")?.kind).toBe("adjusted")
  })

  it("預覽：預設不寫 1/27；HR 勾選採用後才 add 成 fixed_holiday；舊資料沒有 adopt 欄位時 adjusted 仍不寫", () => {
    const payload = buildDraftPayload(fetched2025())
    const base = { year: 2025, policy: DEFAULT_WEEKEND_POLICY, existing: [] }
    expect(previewDraftApply({ ...base, holidays: payload.holidays }).changes.some((c) => c.date === "2025-01-27")).toBe(false)
    const adopted = payload.holidays.map((h) => (h.date === "2025-01-27" ? { ...h, adopt: true } : h))
    expect(previewDraftApply({ ...base, holidays: adopted }).changes.find((c) => c.date === "2025-01-27")).toMatchObject({
      action: "add",
      next: { dayType: "fixed_holiday" },
    })
    const legacy = payload.holidays.map(({ adopt: _a, ...h }) => h)
    expect(previewDraftApply({ ...base, holidays: legacy }).changes.some((c) => c.date === "2025-01-27")).toBe(false)
  })

  it("reconcileKinds：主來源判節日、新北判調整放假 → 依新北改 adjusted（反之亦然），補假不動", () => {
    const primary = { year: 2025, holidays: [{ date: "2025-01-27", label: "小年夜", kind: "holiday" as const, weekend: false }], workdayAdjustments: [{ date: "2025-02-08", label: "補行上班" }], ignored: [], warnings: [] }
    const out = reconcileKinds(primary, holidayYearFromNtpc(NTPC, 2025))
    expect(out.holidays[0]!.kind).toBe("adjusted")
    expect(out.warnings.join()).toContain("依新北資料的分類更正類型")
  })

  it("核准（API）：預設不寫調整放假；PATCH 勾選採用後核准才寫 fixed_holiday", async () => {
    setupApproveDb()
    registerApproveRpc()
    const row2025 = (id: string) => draftRow(id, "draft", { year: 2025, payload: buildDraftPayload(fetched2025()) })
    fake.db.calendar_import_drafts = [row2025(DRAFT_ID)]
    await approveImportDraft(TENANT_ID, DRAFT_ID, HR_ID)
    const day = (d: string) => (fake.db.tenant_calendar_days ?? []).find((r) => r.date === d)
    expect(day("2025-01-27")).toBeUndefined()
    expect(day("2025-05-30")).toMatchObject({ day_type: "fixed_holiday" })

    fake.db.tenant_calendar_days = []
    fake.db.calendar_import_drafts = [row2025(OTHER_DRAFT_ID)]
    const holidays = (fake.db.calendar_import_drafts[0]!.payload.holidays as Row[]).map((h) => (h.date === "2025-01-27" ? { ...h, adopt: true } : h))
    const patch = await request(server).patch(`/calendar/import/drafts/${OTHER_DRAFT_ID}`).set("Authorization", "Bearer user-hr").send({ holidays })
    expect(patch.status).toBe(200)
    expect(patch.body.draft.payload.holidays.find((h: Row) => h.date === "2025-01-27")).toMatchObject({ kind: "adjusted", adopt: true })
    await approveImportDraft(TENANT_ID, OTHER_DRAFT_ID, HR_ID)
    expect(day("2025-01-27")).toMatchObject({ day_type: "fixed_holiday", source: "import" })
  })
})

/* ── S8 週休非週六日 ─────────────────────────────────────────────── */

describe("S8 依租戶例假／休息日判斷", () => {
  const MON_TUE = { regularLeaveWeekday: 1, restDayWeekday: 2 }
  const official = yearFromCsv(CSV_116, 2027).holidays

  it("週六日（不論哪天例假）→ 政府補假直接適用、沒有額外警示", () => {
    for (const policy of [DEFAULT_WEEKEND_POLICY, { regularLeaveWeekday: 6, restDayWeekday: 0 }]) {
      const { holidays, warnings } = tenantizeHolidays(official, policy)
      expect(warnings).toEqual([])
      expect(effectiveHolidays(holidays).map((h) => h.date)).toEqual(official.map((h) => h.date))
    }
  })

  it("週一例假／週二休息日：警示協商；補「週六」節日的政府補假不需要（預設不採用）；weekend 改依租戶", () => {
    const { holidays, warnings } = tenantizeHolidays(official, MON_TUE)
    expect(warnings[0]).toBe(NON_STANDARD_WEEKEND_WARNING)
    const byDate = new Map(holidays.map((h) => [h.date, h]))
    // 2027-04-30（五）補 5/1（六）勞動節：週六對這家公司是工作日、5/1 當天已放 → 不需補假
    expect(byDate.get("2027-04-30")).toMatchObject({ kind: "make_up", adopt: false })
    expect(byDate.get("2027-04-30")?.note).toContain("不需補假")
    // 2027-12-31 補 2028/1/1（六）→ 同理不需要
    expect(byDate.get("2027-12-31")?.adopt).toBe(false)
    // 週六節日對這家公司是工作日 → weekend=false，核准時寫 fixed_holiday
    expect(byDate.get("2027-05-01")?.weekend).toBe(false)
    const plan = planTenantCalendar({ year: 2027, holidays: effectiveHolidays(holidays), policy: MON_TUE })
    expect(plan.holidayRows.find((r) => r.date === "2027-05-01")).toMatchObject({ day_type: "fixed_holiday" })
    expect(plan.holidayRows.some((r) => r.date === "2027-04-30")).toBe(false)
    // 落在週一／週二（租戶休息日）、但政府沒給補假的節日 → 提醒協商
    const onTenantOff = official.filter((h) => h.kind === "holiday" && [1, 2].includes(new Date(`${h.date}T00:00:00Z`).getUTCDay()))
    expect(onTenantOff.length).toBeGreaterThan(0)
    for (const h of onTenantOff) expect(byDate.get(h.date)?.weekend).toBe(true)
    expect(warnings.join()).toContain(onTenantOff[0]!.date)
  })

  it("建草稿讀租戶設定（tenants.features.attendance）：payload 帶 policy 與警示", async () => {
    setupApproveDb()
    fake.db.tenants![0]!.features = { attendance: MON_TUE }
    fake.db.calendar_import_drafts = []
    const { createImportDraft } = await import("../services/holiday-import.js")
    const draft = await createImportDraft(TENANT_ID, fetched2027(), HR_ID)
    expect(draft.payload.policy).toEqual(MON_TUE)
    expect(draft.payload.tenantWarnings?.[0]).toBe(NON_STANDARD_WEEKEND_WARNING)
    expect(draft.payload.holidays.find((h) => h.date === "2027-04-30")?.adopt).toBe(false)
    // 官方原樣不受租戶設定影響（指紋與來源比對都用它）
    expect(draft.payload.official.holidays.find((h) => h.date === "2027-05-01")?.weekend).toBe(true)
  })
})

/* ── S9 改週休設定 → 提示重新產生 ────────────────────────────────── */

describe("S9 改例假／休息日後重新產生未結算月份", () => {
  beforeEach(() => {
    setupApproveDb()
    fake.db.calendar_import_drafts = [draftRow(OLD_APPROVED_ID, "approved")]
    fake.db.tenant_calendar_days = [
      { id: "g-jan", tenant_id: TENANT_ID, date: "2027-01-03", day_type: "regular_leave", label: null, source: "generated" },
      { id: "g-jan2", tenant_id: TENANT_ID, date: "2027-01-02", day_type: "rest_day", label: null, source: "generated" },
      { id: "g-mar", tenant_id: TENANT_ID, date: "2027-03-07", day_type: "regular_leave", label: null, source: "generated" },
      { id: "m-jan", tenant_id: TENANT_ID, date: "2027-01-09", day_type: "rest_day", label: "HR 手動", source: "manual" },
    ]
    fake.db.period_closes = [{ tenant_id: TENANT_ID, period: "2027-03", status: "closed" }]
  })

  it("weekendChangeHint：沒變 → null；有變 → 提示與動作（不自動執行）", () => {
    expect(weekendChangeHint(DEFAULT_WEEKEND_POLICY, { ...DEFAULT_WEEKEND_POLICY })).toBeNull()
    expect(weekendChangeHint(DEFAULT_WEEKEND_POLICY, { regularLeaveWeekday: 1, restDayWeekday: 2 })).toMatchObject({
      action: { method: "POST", path: "/calendar/import/regenerate" },
    })
  })

  it("PUT /api/tenant/settings 改週休：回應帶 calendarRegeneration、行事曆不動；不改週休不帶", async () => {
    const before = JSON.stringify(fake.db.tenant_calendar_days)
    const res = await request(server)
      .put("/api/tenant/settings")
      .set("Authorization", "Bearer user-hr")
      .send({ features: { attendance: { regularLeaveWeekday: 1, restDayWeekday: 2 } } })
    expect(res.status).toBe(200)
    expect(res.body.calendarRegeneration).toMatchObject({ reason: "weekend_policy_changed", after: { regularLeaveWeekday: 1, restDayWeekday: 2 } })
    expect(res.body.calendarRegeneration.action.path).toBe("/calendar/import/regenerate")
    expect(JSON.stringify(fake.db.tenant_calendar_days)).toBe(before)
    const again = await request(server).put("/api/tenant/settings").set("Authorization", "Bearer user-hr").send({ branding: { name: "x" } })
    expect(again.status).toBe(200)
    expect(again.body.calendarRegeneration).toBeUndefined()
  })

  it("POST /calendar/import/regenerate：未結算月依新週休重產、舊週休的 generated 列刪掉；已結算月與 HR 手動列不動", async () => {
    fake.db.tenants![0]!.features = { attendance: { regularLeaveWeekday: 1, restDayWeekday: 2 } }
    const res = await request(server).post("/calendar/import/regenerate").set("Authorization", "Bearer user-hr").send({ years: [2027] })
    expect(res.status).toBe(200)
    expect(res.body.years[0]).toMatchObject({ year: 2027, holidaySource: "approved_draft", lockedPeriods: ["2027-03"] })
    expect(res.body.years[0].removedStaleWeekend).toBeGreaterThanOrEqual(2)
    const days = new Map((fake.db.tenant_calendar_days ?? []).map((r) => [r.date as string, r]))
    expect(days.has("2027-01-03")).toBe(false) // 舊週日例假刪掉
    expect(days.has("2027-01-02")).toBe(false) // 舊週六休息日刪掉
    expect(days.get("2027-01-04")).toMatchObject({ day_type: "regular_leave", source: "generated" }) // 週一例假
    expect(days.get("2027-01-05")).toMatchObject({ day_type: "rest_day", source: "generated" }) // 週二休息日
    expect(days.get("2027-01-09")).toMatchObject({ source: "manual", label: "HR 手動" })
    expect(days.get("2027-03-07")).toMatchObject({ day_type: "regular_leave", source: "generated" }) // 已結算月不動
    expect(days.has("2027-03-08")).toBe(false)
    expect(res.body.warnings.join()).toContain("2027-03")
  })
})

/* ── S10 排程與抓取 ──────────────────────────────────────────────── */

describe("S10c 指紋與來源無關", () => {
  it("2025–2027：主來源（含新北分類校正）與只用新北的指紋相同", () => {
    for (const [csv, year] of [[CSV_114, 2025], [CSV_115, 2026], [CSV_116, 2027]] as const) {
      const ntpc = holidayYearFromNtpc(NTPC, year)
      const dgpa = reconcileKinds(yearFromCsv(csv, year), ntpc)
      expect(officialKey(dgpa)).toBe(officialKey(ntpc))
      // 不經校正（新北抓不到）也一樣——調整放假靠補行上班＋法定節日名稱辨識
      expect(officialKey(yearFromCsv(csv, year))).toBe(officialKey(ntpc))
    }
  })

  it("label 改字不算修正；kind 改變才算", () => {
    const y = yearFromCsv(CSV_116, 2027)
    expect(officialKey({ holidays: y.holidays.map((h) => ({ ...h, label: `${h.label}!` })) })).toBe(officialKey(y))
    expect(officialKey({ holidays: y.holidays.map((h, i) => (i === 0 ? { ...h, kind: "adjusted" as const } : h)) })).not.toBe(officialKey(y))
    // 週末節日有無（新北常不列）不影響；週間補假日改一天就算修正
    expect(officialKey({ holidays: y.holidays.filter((h) => h.date !== "2027-10-10") })).toBe(officialKey(y))
    expect(officialKey({ holidays: y.holidays.map((h) => (h.date === "2027-12-31" ? { ...h, date: "2027-12-30" } : h)) })).not.toBe(officialKey(y))
  })

  it("排程：已核准版來自人事行政總處，這次主來源失敗改用新北 → unchanged，不建假修正版", async () => {
    fake.reset()
    fake.db.tenants = [{ id: TENANT_ID, status: "active", features: {} }]
    fake.db.employees = [{ id: HR_ID, tenant_id: TENANT_ID, user_id: "user-hr", role: "hr_admin", status: "active" }]
    fake.db.notifications = []
    fake.db.calendar_import_drafts = [draftRow(OLD_APPROVED_ID, "approved")]
    const r = await runHolidayImportJob({ today: "2026-11-01", fetchOptions: { fetchImpl: mockFetch({ meta: "fail", ntpc: "ok" }).fn, timeoutMs: 500 } })
    const y2027 = r.years.find((y) => y.year === 2027)!
    expect(y2027).toMatchObject({ fetch: "ok", source: "ntpc", created: 0 })
    expect(y2027.tenants[0]!.action).toBe("unchanged")
  })
})

describe("S10a 草稿已編輯 → 不取代、提示新版可用", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.tenants = [{ id: TENANT_ID, status: "active", features: {} }]
    fake.db.employees = [{ id: HR_ID, tenant_id: TENANT_ID, user_id: "user-hr", role: "hr_admin", status: "active" }]
    fake.db.notifications = []
    const edited = draftRow(DRAFT_ID, "draft")
    const official = { ...edited.payload.official, holidays: edited.payload.official.holidays.filter((h: Row) => h.date !== "2027-12-31") }
    edited.payload = {
      ...edited.payload,
      official,
      holidays: [...edited.payload.holidays.filter((h: Row) => h.date !== "2027-12-31"), { date: "2027-11-26", label: "地方選舉投票日", kind: "extra", weekend: false }],
      edited: true,
    }
    fake.db.calendar_import_drafts = [edited]
  })

  it("每月重抓：保留 HR 編輯、不建新草稿；記 pendingRevision（差異）並通知一次，下個月同版不重複通知", async () => {
    const opts = { fetchOptions: { fetchImpl: mockFetch({ meta: "ok", ntpc: "ok" }).fn, timeoutMs: 500 } }
    const r = await runHolidayImportJob({ today: "2026-11-01", ...opts })
    const y2027 = r.years.find((y) => y.year === 2027)!
    expect(y2027.tenants[0]).toMatchObject({ action: "revision_available", draftId: DRAFT_ID })
    expect(y2027.created).toBe(0)
    const drafts2027 = fake.db.calendar_import_drafts!.filter((d) => d.year === 2027)
    expect(drafts2027).toHaveLength(1)
    const d = drafts2027[0]!
    expect(d.status).toBe("draft")
    expect(d.payload.holidays.some((h: Row) => h.date === "2027-11-26")).toBe(true) // HR 編輯保留
    expect(d.payload.pendingRevision).toMatchObject({ added: [{ date: "2027-12-31" }], removed: [], kindChanged: [] })
    const revNotes = () => fake.db.notifications!.filter((n) => n.type === "calendar_import_revision")
    expect(revNotes()).toHaveLength(1)
    expect(String(revNotes()[0]!.title)).toContain("新版")
    await runHolidayImportJob({ today: "2026-12-01", ...opts })
    expect(revNotes()).toHaveLength(1)
  })

  it("沒編輯過的草稿 → 照舊取代成新草稿", async () => {
    fake.db.calendar_import_drafts![0]!.payload.edited = false
    const r = await runHolidayImportJob({ today: "2026-11-01", fetchOptions: { fetchImpl: mockFetch({ meta: "ok", ntpc: "ok" }).fn, timeoutMs: 500 } })
    expect(r.years.find((y) => y.year === 2027)!.tenants[0]!.action).toBe("revision")
    expect(fake.db.calendar_import_drafts!.find((d) => d.id === DRAFT_ID)?.status).toBe("superseded")
  })
})

describe("S10b 抓取持續失敗 → 通知 HR、回報 failed", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.tenants = [{ id: TENANT_ID, status: "active", features: {} }]
    fake.db.employees = [{ id: HR_ID, tenant_id: TENANT_ID, user_id: "user-hr", role: "hr_admin", status: "active" }]
    fake.db.notifications = []
    fake.db.calendar_import_drafts = []
    fake.db.calendar_import_fetch_status = []
    fake.uniques.calendar_import_fetch_status = [["year"]]
  })
  const failing = { fetchOptions: { fetchImpl: mockFetch({ meta: "fail", ntpc: "fail" }).fn, timeoutMs: 200 } }
  const alerts = () => fake.db.notifications!.filter((n) => n.type === "calendar_import_fetch_failed")

  it("連續 3 天失敗才通知（第 1、2 天只記 failed）；同日重跑不重複累計；7 天內不重發；成功後歸零", async () => {
    const d1 = await runHolidayImportJob({ today: "2026-07-02", ...failing })
    expect(d1.failed).toBe(1)
    expect(d1.years[0]).toMatchObject({ fetch: "failed", failed: 1, consecutiveFailures: 1, alerted: 0 })
    expect(d1.years[0]!.tenants[0]).toMatchObject({ action: "error" })
    await runHolidayImportJob({ today: "2026-07-02", ...failing })
    expect(fake.db.calendar_import_fetch_status![0]).toMatchObject({ consecutive_failures: 1 })
    await runHolidayImportJob({ today: "2026-07-03", ...failing })
    expect(alerts()).toHaveLength(0)
    const d3 = await runHolidayImportJob({ today: "2026-07-04", ...failing })
    expect(d3.years[0]).toMatchObject({ consecutiveFailures: 3, alerted: 1 })
    expect(alerts()).toHaveLength(1)
    expect(String(alerts()[0]!.body)).toContain("手動")
    await runHolidayImportJob({ today: "2026-07-05", ...failing })
    expect(alerts()).toHaveLength(1)
    const ok = await runHolidayImportJob({ today: "2026-07-06", fetchOptions: { fetchImpl: mockFetch({ meta: "ok", ntpc: "ok" }).fn, timeoutMs: 500 } })
    expect(ok.years[0]).toMatchObject({ fetch: "ok", failed: 0, consecutiveFailures: 0 })
  })

  it("12 月仍沒有下一年（官方未公布）→ 通知；11 月不通知", async () => {
    const empty = { fetchOptions: { fetchImpl: mockFetch({ meta: "empty", ntpc: "empty" }).fn, timeoutMs: 200 } }
    await runHolidayImportJob({ today: "2027-11-20", ...empty })
    expect(alerts()).toHaveLength(0)
    const dec = await runHolidayImportJob({ today: "2027-12-02", ...empty })
    expect(dec.years[0]).toMatchObject({ year: 2028, fetch: "not_published", alerted: 1 })
    expect(String(alerts()[0]!.body)).toContain("12 月")
  })

  it("nextFetchStatus／shouldAlertFetchFailure（純函式）", () => {
    let st = nextFetchStatus(null, 2027, "failed", "2026-07-01", "x")
    expect(st.consecutive_failures).toBe(1)
    st = nextFetchStatus(st, 2027, "failed", "2026-07-02", "x")
    st = nextFetchStatus(st, 2027, "failed", "2026-07-03", "x")
    expect(st.consecutive_failures).toBe(3)
    expect(shouldAlertFetchFailure({ status: st, outcome: "failed", year: 2027, today: "2026-07-03" })).toContain("連續 3 天")
    expect(nextFetchStatus(st, 2027, "failed", "2026-07-10", "x").consecutive_failures).toBe(1) // 中斷就重算
    expect(nextFetchStatus(st, 2027, "ok", "2026-07-04", null).consecutive_failures).toBe(0)
    expect(shouldAlertFetchFailure({ status: { ...st, alerted_on: "2026-07-01" }, outcome: "failed", year: 2027, today: "2026-07-03" })).toBeNull()
    expect(shouldAlertFetchFailure({ status: null, outcome: "not_published", year: 2027, today: "2026-11-30" })).toBeNull()
    expect(shouldAlertFetchFailure({ status: null, outcome: "not_published", year: 2027, today: "2026-12-01" })).toContain("12 月")
  })
})

describe("S10d 下載安全：網域白名單、轉址、大小上限", () => {
  it("assertAllowedSourceUrl：白名單網域（http 升 https）；其他網域、帳密、怪 port、非 http 拒絕", () => {
    expect(assertAllowedSourceUrl("http://www.dgpa.gov.tw/FileConversion?filename=a.csv")).toBe("https://www.dgpa.gov.tw/FileConversion?filename=a.csv")
    expect(assertAllowedSourceUrl("https://data.gov.tw/api/v2/rest/dataset/14718")).toContain("https://data.gov.tw/")
    for (const bad of [
      "https://evil.example/a.csv",
      "https://data.gov.tw.evil.example/a.csv",
      "https://dgpa.gov.tw/a.csv",
      "https://u:p@data.gov.tw/a",
      "https://data.gov.tw:8443/a",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(() => assertAllowedSourceUrl(bad), bad).toThrow()
    }
  })

  function withCsv(handler: (url: string) => ReturnType<FetchLike> | null) {
    const base = mockFetch({ meta: "ok", ntpc: "ok" }).fn
    const urls: string[] = []
    const fn: FetchLike = async (url, init) => {
      urls.push(url)
      return (await handler(url)) ?? base(url, init)
    }
    return { fn, urls }
  }

  it("dataset 列的下載網址不在白名單 → 不連線、改用新北備援", async () => {
    const meta = { result: { distribution: [{ resourceDescription: "116年中華民國政府行政機關辦公日曆表", resourceFormat: "CSV", resourceDownloadUrl: "https://evil.example/files/202607/116.csv" }] } }
    const { fn, urls } = withCsv((url) => (url.includes("data.gov.tw/") ? Promise.resolve(okRes(JSON.stringify(meta))) : null))
    const r = await fetchHolidayYear(2027, { fetchImpl: fn, timeoutMs: 500 })
    expect(r.source).toBe("ntpc")
    expect(r.errors[0]).toContain("白名單")
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false)
  })

  it("轉址到白名單外 → 拒絕；轉址到白名單內 → 跟過去；轉址太多次 → 拒絕", async () => {
    const redirect = (location: string) => Promise.resolve({ ok: false, status: 302, headers: { get: (n: string) => (n === "location" ? location : null) }, arrayBuffer: async () => new ArrayBuffer(0) })
    const evil = withCsv((url) => (url.includes("116.csv") ? redirect("https://evil.example/116.csv") : null))
    const r1 = await fetchHolidayYear(2027, { fetchImpl: evil.fn, timeoutMs: 500 })
    expect(r1.source).toBe("ntpc")
    expect(r1.errors[0]).toContain("白名單")
    expect(evil.urls.some((u) => u.includes("evil.example"))).toBe(false)

    const ok = withCsv((url) =>
      url.includes("116.csv") ? redirect("/FileConversion?filename=dgpa/files/202607/116-moved.dat") : url.includes("116-moved") ? Promise.resolve(okRes(CSV_116)) : null,
    )
    const r2 = await fetchHolidayYear(2027, { fetchImpl: ok.fn, timeoutMs: 500 })
    expect(r2.source).toBe("dgpa")
    expect(ok.urls.some((u) => u.startsWith("https://www.dgpa.gov.tw/FileConversion?filename=dgpa/files/202607/116-moved"))).toBe(true)

    let n = 0
    const loop = withCsv((url) => (url.includes("www.dgpa.gov.tw") ? redirect(`https://www.dgpa.gov.tw/loop${n++}`) : null))
    const r3 = await fetchHolidayYear(2027, { fetchImpl: loop.fn, timeoutMs: 500 })
    expect(r3.errors[0]).toContain("轉址超過")
  })

  it("回應超過上限 → 拒絕（content-length 宣告、或實際讀到超過都擋）", async () => {
    expect(MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024)
    const declared = withCsv((url) =>
      url.includes("116.csv")
        ? Promise.resolve({ ...okRes(CSV_116), headers: { get: (h: string) => (h === "content-length" ? String(3 * 1024 * 1024) : null) } })
        : null,
    )
    const r1 = await fetchHolidayYear(2027, { fetchImpl: declared.fn, timeoutMs: 500 })
    expect(r1.source).toBe("ntpc")
    expect(r1.errors[0]).toContain("上限")
    // 沒宣告長度、串流讀到超過 maxBytes
    const big = new Uint8Array(4096)
    const streamed = withCsv((url) =>
      url.includes("116.csv")
        ? Promise.resolve({
            ok: true,
            status: 200,
            body: {
              getReader: () => {
                let i = 0
                return { read: async () => (i++ < 10 ? { done: false, value: big } : { done: true }), cancel: async () => undefined }
              },
            },
            arrayBuffer: async () => new ArrayBuffer(0),
          })
        : null,
    )
    await expect(fetchHolidayYear(2027, { fetchImpl: streamed.fn, timeoutMs: 500, maxBytes: 16 * 1024 }).then((r) => r.errors[0])).resolves.toContain("上限")
  })
})
