import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import {
  PeriodClosedError,
  assertDateRangeOpen,
  assertInstantsOpen,
  assertPeriodOpen,
  assertRequestOpen,
  assertRequestsOpen,
  canEditUnlockList,
  canReopenPeriod,
  closedPeriodsOfRequest,
  findClosedPeriods,
  getPeriodLockState,
  isPeriodClosed,
  isPeriodClosedError,
  isRealDateKey,
  loadPeriodUnlockPolicy,
  periodOfDate,
  periodOfInstant,
  periodRangeOfInstants,
  periodsBetween,
  periodsOfRequest,
  requestSelector,
  sameEmployeeSet,
  shiftPeriod,
  unlockPolicyOf,
} from "../services/period-lock.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 發薪鎖定的核心（services/period-lock.ts）：
 *   • 日期歸月的純函式——以租戶時區為準、跨月邊界、半開區間 [start, end)、申請單碰到哪些月份。
 *   • 守門員 assertPeriodOpen／assertInstantsOpen／assertRequestOpen…：只有 status='closed' 會擋；
 *     'reopened'（已重新開放）與沒有列都是開放；別的租戶的鎖不影響我。
 *   • 解鎖權限：老闆與老闆指定的人；只有老闆（或 platform_admin）能改名單。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const BOSS = "b0550000-0000-4000-8000-000000000001"
const DESIGNEE = "b0550000-0000-4000-8000-000000000002"
const HR = "b0550000-0000-4000-8000-000000000003"

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
})

function closeRow(period: string, status: "closed" | "reopened" = "closed", tenantId = TENANT_ID): Row {
  return { id: `pc-${tenantId.slice(0, 4)}-${period}-${status}`, tenant_id: tenantId, period, status }
}

describe("periodOfDate — 日期／月份 → 月份", () => {
  it("'YYYY-MM-DD' 取前 7 碼，'YYYY-MM' 原樣", () => {
    expect(periodOfDate("2026-09-30")).toBe("2026-09")
    expect(periodOfDate("2026-10-01")).toBe("2026-10")
    expect(periodOfDate("2026-10")).toBe("2026-10")
  })

  it("時間點（ISO instant）、不存在的月份、亂格式一律丟錯，不會被悄悄切成錯的月", () => {
    expect(() => periodOfDate("2026-09-30T16:00:00.000Z")).toThrow()
    expect(() => periodOfDate("2026-13-01")).toThrow()
    expect(() => periodOfDate("2026-13")).toThrow()
    expect(() => periodOfDate("2026-9-3")).toThrow()
    expect(() => periodOfDate("")).toThrow()
  })
})

describe("periodOfInstant — 以租戶時區歸月（跨月邊界）", () => {
  it("台北（UTC+8）：UTC 9/30 16:00 已經是台北 10/1 00:00 → 歸 10 月；差 1 毫秒仍是 9 月", () => {
    expect(periodOfInstant("2026-09-30T15:59:59.999Z", "Asia/Taipei")).toBe("2026-09")
    expect(periodOfInstant("2026-09-30T16:00:00.000Z", "Asia/Taipei")).toBe("2026-10")
  })

  it("跨年：台北 2027-01-01 00:00 ＝ UTC 2026-12-31 16:00", () => {
    expect(periodOfInstant("2026-12-31T15:59:59Z", "Asia/Taipei")).toBe("2026-12")
    expect(periodOfInstant("2026-12-31T16:00:00Z", "Asia/Taipei")).toBe("2027-01")
  })

  it("換成別的時區結果跟著變：洛杉磯（夏令 UTC−7）UTC 10/1 06:59 還是 9 月，07:00 才是 10 月；UTC 時區就看 UTC 日期", () => {
    expect(periodOfInstant("2026-10-01T06:59:59Z", "America/Los_Angeles")).toBe("2026-09")
    expect(periodOfInstant("2026-10-01T07:00:00Z", "America/Los_Angeles")).toBe("2026-10")
    expect(periodOfInstant("2026-09-30T23:59:59Z", "UTC")).toBe("2026-09")
    expect(periodOfInstant("2026-10-01T00:00:00Z", "UTC")).toBe("2026-10")
  })
})

describe("periodRangeOfInstants — 半開區間 [start, end) 碰到的月份", () => {
  const tz = "Asia/Taipei"
  const tpe = (date: string, hms: string) => new Date(`${date}T${hms}+08:00`).toISOString()

  it("同一天、同一個月 → 只有那個月", () => {
    expect(periodRangeOfInstants(tpe("2026-09-15", "09:00:00"), tpe("2026-09-15", "18:00:00"), tz)).toEqual({ from: "2026-09", to: "2026-09" })
  })

  it("end 剛好是下個月 1 日當地 00:00 → 不算碰到下個月（最後被涵蓋的瞬間是前一天 23:59:59.999）", () => {
    expect(periodRangeOfInstants(tpe("2026-09-30", "09:00:00"), tpe("2026-10-01", "00:00:00"), tz)).toEqual({ from: "2026-09", to: "2026-09" })
  })

  it("end 晚 1 毫秒就碰到下個月", () => {
    expect(periodRangeOfInstants(tpe("2026-09-30", "18:00:00"), tpe("2026-10-01", "00:00:00.001"), tz)).toEqual({ from: "2026-09", to: "2026-10" })
  })

  it("跨午夜的加班（9/30 22:00 → 10/1 02:00）兩個月都碰到", () => {
    expect(periodRangeOfInstants(tpe("2026-09-30", "22:00:00"), tpe("2026-10-01", "02:00:00"), tz)).toEqual({ from: "2026-09", to: "2026-10" })
  })

  it("多月假單（8/28 → 10/3）涵蓋中間整個 9 月", () => {
    expect(periodRangeOfInstants(tpe("2026-08-28", "09:00:00"), tpe("2026-10-03", "18:00:00"), tz)).toEqual({ from: "2026-08", to: "2026-10" })
  })

  it("start 與 end 同一瞬間 → 單點；end 早於 start（資料有問題）→ 兩端都納入，寧可多擋", () => {
    expect(periodRangeOfInstants(tpe("2026-09-30", "23:00:00"), tpe("2026-09-30", "23:00:00"), tz)).toEqual({ from: "2026-09", to: "2026-09" })
    expect(periodRangeOfInstants(tpe("2026-10-02", "09:00:00"), tpe("2026-09-28", "09:00:00"), tz)).toEqual({ from: "2026-09", to: "2026-10" })
  })
})

describe("periodsOfRequest／requestSelector — 申請單碰到哪些月份（segments ∪ 起訖區間）", () => {
  const tz = "Asia/Taipei"
  const tpe = (date: string, hms: string) => new Date(`${date}T${hms}+08:00`).toISOString()

  it("單日請假：只有那個月", () => {
    expect(periodsOfRequest({ start_at: tpe("2026-09-10", "09:00:00"), end_at: tpe("2026-09-10", "18:00:00") }, tz)).toEqual(["2026-09"])
  })

  it("跨月請假（9/29 → 10/2）：兩個月都算；跨三個月會補上中間的月份", () => {
    expect(periodsOfRequest({ start_at: tpe("2026-09-29", "09:00:00"), end_at: tpe("2026-10-02", "18:00:00") }, tz)).toEqual(["2026-09", "2026-10"])
    expect(periodsOfRequest({ start_at: tpe("2026-08-31", "09:00:00"), end_at: tpe("2026-10-01", "18:00:00") }, tz)).toEqual(["2026-08", "2026-09", "2026-10"])
  })

  it("segments 的日期也算：起訖在 10 月、但有一段日期在 9 月 → 9、10 月都碰到", () => {
    const span = {
      start_at: tpe("2026-10-01", "09:00:00"),
      end_at: tpe("2026-10-01", "18:00:00"),
      segments: [
        { date: "2026-09-30", startTime: "09:00", endTime: "18:00", hours: 8 },
        { date: "2026-10-01", startTime: "09:00", endTime: "18:00", hours: 8 },
      ],
    }
    expect(periodsOfRequest(span, tz)).toEqual(["2026-09", "2026-10"])
    expect(requestSelector(span, tz).months).toEqual(["2026-09", "2026-10"])
  })

  it("格式不明的 segments 項目略過、沒有 segments 照樣用起訖；只有 start 時當單點", () => {
    expect(periodsOfRequest({ start_at: tpe("2026-09-10", "09:00:00"), end_at: tpe("2026-09-10", "18:00:00"), segments: [{ date: "不是日期" }, null, 5] }, tz)).toEqual(["2026-09"])
    expect(periodsOfRequest({ start_at: tpe("2026-09-10", "09:00:00"), end_at: null }, tz)).toEqual(["2026-09"])
    expect(periodsOfRequest({}, tz)).toEqual([])
  })

  it("以租戶時區為準：同一段 UTC 時間在台北歸 10 月、在洛杉磯歸 9 月", () => {
    const span = { start_at: "2026-09-30T20:00:00.000Z", end_at: "2026-09-30T21:00:00.000Z" }
    expect(periodsOfRequest(span, "Asia/Taipei")).toEqual(["2026-10"])
    expect(periodsOfRequest(span, "America/Los_Angeles")).toEqual(["2026-09"])
  })
})

describe("shiftPeriod／periodsBetween", () => {
  it("往前往後移月份、跨年", () => {
    expect(shiftPeriod("2026-10", 0)).toBe("2026-10")
    expect(shiftPeriod("2026-10", -1)).toBe("2026-09")
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12")
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01")
    expect(shiftPeriod("2026-10", -12)).toBe("2025-10")
    expect(shiftPeriod("2026-10", 14)).toBe("2027-12")
    expect(() => shiftPeriod("2026-13", 1)).toThrow()
  })

  it("區間展開（含頭尾、跨年）；from > to 回空；有上限保護", () => {
    expect(periodsBetween("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"])
    expect(periodsBetween("2026-10", "2026-10")).toEqual(["2026-10"])
    expect(periodsBetween("2026-10", "2026-09")).toEqual([])
    expect(periodsBetween("1900-01", "2999-12", 24)).toHaveLength(24)
  })
})

describe("PeriodClosedError", () => {
  it("單一月份：body 是 { error, period }；多個月份：period 是最早的、多帶 periods（升序去重）", () => {
    const one = new PeriodClosedError(["2026-09"])
    expect(one.httpStatus).toBe(409)
    expect(one.code).toBe("period_closed")
    expect(one.toBody()).toEqual({ error: "period_closed", period: "2026-09" })
    const many = new PeriodClosedError(["2026-10", "2026-09", "2026-10"])
    expect(many.period).toBe("2026-09")
    expect(many.toBody()).toEqual({ error: "period_closed", period: "2026-09", periods: ["2026-09", "2026-10"] })
    expect(isPeriodClosedError(many)).toBe(true)
    expect(isPeriodClosedError(new Error("x"))).toBe(false)
    expect(isPeriodClosedError(null)).toBe(false)
  })
})

describe("守門員 — 只有 status='closed' 會擋", () => {
  it("沒有任何月結紀錄 → 全部放行", async () => {
    await expect(assertPeriodOpen(TENANT_ID, "2026-09-15")).resolves.toBeUndefined()
    expect(await findClosedPeriods(TENANT_ID, { months: ["2026-09"] })).toEqual([])
    expect(await isPeriodClosed(TENANT_ID, "2026-09")).toBe(false)
    expect(await getPeriodLockState(TENANT_ID, "2026-09")).toBe("open")
  })

  it("已結算（closed）→ 409 period_closed；日期、月份、日期陣列三種輸入都認得", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertPeriodOpen(TENANT_ID, "2026-09-15")).rejects.toMatchObject({ code: "period_closed", period: "2026-09" })
    await expect(assertPeriodOpen(TENANT_ID, "2026-09")).rejects.toBeInstanceOf(PeriodClosedError)
    await expect(assertPeriodOpen(TENANT_ID, ["2026-10-01", "2026-09-30"])).rejects.toMatchObject({ period: "2026-09", periods: ["2026-09"] })
    await expect(assertPeriodOpen(TENANT_ID, ["2026-10-01", "2026-11-30"])).resolves.toBeUndefined()
    expect(await getPeriodLockState(TENANT_ID, "2026-09")).toBe("closed")
  })

  it("已重新開放（reopened）＝開放：不擋；狀態讀出來是 reopened", async () => {
    fake.db.period_closes = [closeRow("2026-09", "reopened")]
    await expect(assertPeriodOpen(TENANT_ID, "2026-09-15")).resolves.toBeUndefined()
    expect(await isPeriodClosed(TENANT_ID, "2026-09")).toBe(false)
    expect(await getPeriodLockState(TENANT_ID, "2026-09")).toBe("reopened")
  })

  it("別的租戶鎖了 9 月，不影響我（租戶隔離）", async () => {
    fake.db.period_closes = [closeRow("2026-09", "closed", OTHER_TENANT_ID)]
    await expect(assertPeriodOpen(TENANT_ID, "2026-09-15")).resolves.toBeUndefined()
    await expect(assertPeriodOpen(OTHER_TENANT_ID, "2026-09-15")).rejects.toBeInstanceOf(PeriodClosedError)
  })

  it("一次查詢就夠：不論要檢查幾個月份，只對 period_closes 打一句 SELECT", async () => {
    fake.db.period_closes = [closeRow("2026-05")]
    await assertPeriodOpen(TENANT_ID, ["2026-01", "2026-03", "2026-05", "2026-07"]).catch(() => undefined)
    expect(fake.reads.filter((t) => t === "period_closes")).toHaveLength(1)
  })

  it("離散月份只比對那幾個月：2026-05 已鎖、要查 01 與 12 → 放行（不能把中間的月份算進去）", async () => {
    fake.db.period_closes = [closeRow("2026-05")]
    expect(await findClosedPeriods(TENANT_ID, { months: ["2026-01", "2026-12"] })).toEqual([])
    expect(await findClosedPeriods(TENANT_ID, { ranges: [{ from: "2026-01", to: "2026-12" }] })).toEqual(["2026-05"])
  })

  it("DB 查詢失敗 → 照丟（不要因為 DB 抖動就悄悄放行寫入）；表不存在（舊庫）→ 視為沒有鎖", async () => {
    fake.injectError({ table: "period_closes", action: "select", error: { message: "boom", code: "XX000" } })
    await expect(assertPeriodOpen(TENANT_ID, "2026-09")).rejects.toThrow("period-lock (period_closes): boom")
    fake.injectError({ table: "period_closes", action: "select", error: { message: "no table", code: "PGRST205" } })
    await expect(assertPeriodOpen(TENANT_ID, "2026-09")).resolves.toBeUndefined()
    fake.injectError({ table: "period_closes", action: "select", error: { message: "boom", code: "XX000" } })
    await expect(getPeriodLockState(TENANT_ID, "2026-09")).rejects.toThrow("period-lock (state): boom")
  })
})

describe("assertInstantsOpen — 時間點以租戶時區歸月", () => {
  it("台北 9/30 23:59 還在 9 月（已鎖 → 擋）；台北 10/1 00:00 是 10 月（放行）", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertInstantsOpen(TENANT_ID, "2026-09-30T15:59:00.000Z")).rejects.toMatchObject({ period: "2026-09" })
    await expect(assertInstantsOpen(TENANT_ID, "2026-09-30T16:00:00.000Z")).resolves.toBeUndefined()
  })

  it("一組時間點只要有一個落在已鎖月就擋", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertInstantsOpen(TENANT_ID, ["2026-10-05T01:00:00.000Z", "2026-09-05T01:00:00.000Z"])).rejects.toMatchObject({ period: "2026-09" })
  })

  it("租戶換時區就換歸月：洛杉磯租戶 UTC 10/1 03:00 還是 9 月", async () => {
    fake.db.tenants = [{ id: TENANT_ID, timezone: "America/Los_Angeles", features: {} }]
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertInstantsOpen(TENANT_ID, "2026-10-01T03:00:00.000Z")).rejects.toMatchObject({ period: "2026-09" })
    await expect(assertInstantsOpen(TENANT_ID, "2026-10-01T08:00:00.000Z")).resolves.toBeUndefined()
  })
})

describe("assertRequestOpen／assertRequestsOpen／assertDateRangeOpen", () => {
  const tpe = (date: string, hms: string) => new Date(`${date}T${hms}+08:00`).toISOString()

  it("跨月申請單：9 月已鎖，9/29 → 10/2 的單一樣擋（碰到就擋）；整張都在 10 月則放行", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertRequestOpen(TENANT_ID, { start_at: tpe("2026-09-29", "09:00:00"), end_at: tpe("2026-10-02", "18:00:00") })).rejects.toMatchObject({ period: "2026-09" })
    await expect(assertRequestOpen(TENANT_ID, { start_at: tpe("2026-10-02", "09:00:00"), end_at: tpe("2026-10-02", "18:00:00") })).resolves.toBeUndefined()
  })

  it("end 剛好落在 10/1 00:00 的單（只請到 9/30）：10 月已鎖也不會被誤擋；9 月已鎖才擋", async () => {
    const span = { start_at: tpe("2026-09-30", "09:00:00"), end_at: tpe("2026-10-01", "00:00:00") }
    fake.db.period_closes = [closeRow("2026-10")]
    await expect(assertRequestOpen(TENANT_ID, span)).resolves.toBeUndefined()
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertRequestOpen(TENANT_ID, span)).rejects.toMatchObject({ period: "2026-09" })
  })

  it("只有 segment 落在已鎖月也擋（起訖都在別的月）", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    const span = {
      start_at: tpe("2026-10-05", "09:00:00"),
      end_at: tpe("2026-10-05", "18:00:00"),
      segments: [{ date: "2026-09-30", startTime: "09:00", endTime: "18:00", hours: 8 }],
    }
    await expect(assertRequestOpen(TENANT_ID, span)).rejects.toMatchObject({ period: "2026-09" })
    expect(await closedPeriodsOfRequest(TENANT_ID, span)).toEqual(["2026-09"])
    expect(await closedPeriodsOfRequest(TENANT_ID, { start_at: tpe("2026-10-05", "09:00:00"), end_at: tpe("2026-10-05", "18:00:00") })).toEqual([])
  })

  it("一批申請單（含額外月份）：任何一張碰到就擋；空批次不查 DB", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    const open = { start_at: tpe("2026-10-05", "09:00:00"), end_at: tpe("2026-10-05", "18:00:00") }
    const closed = { start_at: tpe("2026-09-05", "09:00:00"), end_at: tpe("2026-09-05", "18:00:00") }
    await expect(assertRequestsOpen(TENANT_ID, [open, open])).resolves.toBeUndefined()
    await expect(assertRequestsOpen(TENANT_ID, [open, closed])).rejects.toMatchObject({ period: "2026-09" })
    await expect(assertRequestsOpen(TENANT_ID, [open], ["2026-09"])).rejects.toMatchObject({ period: "2026-09" })
    const readsBefore = fake.reads.length
    await expect(assertRequestsOpen(TENANT_ID, [])).resolves.toBeUndefined()
    expect(fake.reads.length).toBe(readsBefore)
  })

  it("日期區間（出勤結算）：中間夾著已鎖的月份也算碰到", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertDateRangeOpen(TENANT_ID, "2026-08-20", "2026-10-05")).rejects.toMatchObject({ period: "2026-09" })
    await expect(assertDateRangeOpen(TENANT_ID, "2026-10-01", "2026-10-31")).resolves.toBeUndefined()
    await expect(assertDateRangeOpen(TENANT_ID, "2026-10-05", "2026-08-20")).rejects.toMatchObject({ period: "2026-09" })
  })
})

describe("解鎖權限：老闆＋老闆指定的人；只有老闆（或 platform_admin）能改名單", () => {
  it("unlockPolicyOf：沒設定＝沒有老闆、名單空；id 一律轉小寫並去重；亂格式忽略", () => {
    expect(unlockPolicyOf(null)).toEqual({ bossEmpId: null, designatedEmpIds: [] })
    expect(unlockPolicyOf({})).toEqual({ bossEmpId: null, designatedEmpIds: [] })
    expect(unlockPolicyOf({ approval: { fallbackApproverEmpId: "" }, payroll: { periodUnlockEmpIds: "x" } })).toEqual({ bossEmpId: null, designatedEmpIds: [] })
    expect(
      unlockPolicyOf({
        approval: { fallbackApproverEmpId: BOSS.toUpperCase() },
        payroll: { periodUnlockEmpIds: [DESIGNEE, DESIGNEE.toUpperCase(), 7, "", null] },
      }),
    ).toEqual({ bossEmpId: BOSS, designatedEmpIds: [DESIGNEE] })
  })

  it("canReopenPeriod：老闆可以、指定的人可以、HR（沒被指定）不行、沒登入的人不行；不分大小寫", () => {
    const policy = unlockPolicyOf({ approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } })
    expect(canReopenPeriod(policy, BOSS)).toBe(true)
    expect(canReopenPeriod(policy, BOSS.toUpperCase())).toBe(true)
    expect(canReopenPeriod(policy, DESIGNEE)).toBe(true)
    expect(canReopenPeriod(policy, HR)).toBe(false)
    expect(canReopenPeriod(policy, null)).toBe(false)
    expect(canReopenPeriod(policy, undefined)).toBe(false)
    // 沒有設定老闆也沒有名單 → 沒有人能解鎖（fail closed）。
    expect(canReopenPeriod(unlockPolicyOf({}), HR)).toBe(false)
  })

  it("canEditUnlockList：只有老闆與 platform_admin；被指定的人、HR 都不行；沒設老闆時只剩 platform_admin", () => {
    const policy = unlockPolicyOf({ approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } })
    expect(canEditUnlockList(policy, { id: BOSS, role: "employee" })).toBe(true)
    expect(canEditUnlockList(policy, { id: BOSS.toUpperCase(), role: "employee" })).toBe(true)
    expect(canEditUnlockList(policy, { id: HR, role: "platform_admin" })).toBe(true)
    expect(canEditUnlockList(policy, { id: HR, role: "hr_admin" })).toBe(false)
    expect(canEditUnlockList(policy, { id: DESIGNEE, role: "hr_admin" })).toBe(false)
    const noBoss = unlockPolicyOf({})
    expect(canEditUnlockList(noBoss, { id: HR, role: "hr_admin" })).toBe(false)
    expect(canEditUnlockList(noBoss, { id: HR, role: "platform_admin" })).toBe(true)
  })

  it("sameEmployeeSet：不分順序、不分大小寫、重複視為同一個人", () => {
    expect(sameEmployeeSet([BOSS, DESIGNEE], [DESIGNEE.toUpperCase(), BOSS])).toBe(true)
    expect(sameEmployeeSet([BOSS, BOSS], [BOSS])).toBe(true)
    expect(sameEmployeeSet([], [])).toBe(true)
    expect(sameEmployeeSet([BOSS], [])).toBe(false)
    expect(sameEmployeeSet([BOSS], [DESIGNEE])).toBe(false)
  })

  it("loadPeriodUnlockPolicy：從 tenants.features 讀；查無租戶＝沒有老闆也沒有名單", async () => {
    fake.db.tenants = [
      { id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } } },
    ]
    expect(await loadPeriodUnlockPolicy(TENANT_ID)).toEqual({ bossEmpId: BOSS, designatedEmpIds: [DESIGNEE] })
    expect(await loadPeriodUnlockPolicy(OTHER_TENANT_ID)).toEqual({ bossEmpId: null, designatedEmpIds: [] })
  })
})

describe("不存在的日期（會被進位）——月份歸屬保守處理，不讓 2026-08-32 被當成 8 月而溜過 9 月的鎖", () => {
  const tpe = (date: string, hms: string) => new Date(`${date}T${hms}+08:00`).toISOString()

  it("isRealDateKey：真的日曆日（含閏日）才算", () => {
    for (const ok of ["2026-09-30", "2026-02-28", "2028-02-29", "2026-12-31", "2026-01-01"]) expect(isRealDateKey(ok), ok).toBe(true)
    for (const bad of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-08-32", "2026-09-00", "2026-13-01", "2026-00-10", "2026-9-3", "2026-09-30T00:00:00Z", ""]) {
      expect(isRealDateKey(bad), bad).toBe(false)
    }
  })

  it("申請單 segment 日期不存在 → 進位前後兩個月都算（8/32 → 8、9 月；9/0 → 9、8 月；2/30 → 2、3 月）", () => {
    const at = tpe("2026-08-10", "09:00:00")
    const span = (date: string) => ({ start_at: at, end_at: at, segments: [{ date, startTime: "09:00", endTime: "09:00", hours: 0 }] })
    expect(periodsOfRequest(span("2026-08-32"), "Asia/Taipei")).toEqual(["2026-08", "2026-09"])
    expect(periodsOfRequest(span("2026-09-00"), "Asia/Taipei")).toEqual(["2026-08", "2026-09"])
    expect(periodsOfRequest(span("2026-02-30"), "Asia/Taipei")).toEqual(["2026-02", "2026-03", "2026-08"])
    expect(requestSelector(span("2026-12-40"), "Asia/Taipei").months).toEqual(["2026-12", "2027-01"])
  })

  it("守門員：9 月已結算，segment 填 2026-08-32 的單照樣被擋（進位後就是 9/1）", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    const at = tpe("2026-08-10", "09:00:00")
    await expect(
      assertRequestOpen(TENANT_ID, { start_at: at, end_at: at, segments: [{ date: "2026-08-32", startTime: "09:00", endTime: "09:00", hours: 0 }] }),
    ).rejects.toMatchObject({ period: "2026-09" })
  })

  it("assertPeriodOpen／assertDateRangeOpen 收到不存在的日期也保守：2026-08-32 算 8、9 月；格式錯誤（ISO 時間點）照樣丟錯", async () => {
    fake.db.period_closes = [closeRow("2026-09")]
    await expect(assertPeriodOpen(TENANT_ID, "2026-08-32")).rejects.toMatchObject({ period: "2026-09" })
    await expect(assertDateRangeOpen(TENANT_ID, "2026-08-32", "2026-08-32")).rejects.toMatchObject({ period: "2026-09" })
    await expect(assertDateRangeOpen(TENANT_ID, "2026-10", "2026-10")).resolves.toBeUndefined()
    await expect(assertPeriodOpen(TENANT_ID, "2026-09-30T16:00:00.000Z")).rejects.toThrow()
  })
})
