import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  DEFAULT_ANNUAL_LEAVE_INCREMENT,
  DEFAULT_ANNUAL_LEAVE_TABLE,
  resolveAnnualLeavePolicy,
} from "@hr/rules"
import {
  AnnualLeaveError,
  addMonthsKey,
  annualLeaveDays,
  anniversaryPeriod,
  entitledHoursFor,
  grantAnnualLeave,
  monthsBetweenKeys,
} from "../services/annual-leave.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"

/**
 * 特休週年制（services/annual-leave.ts，W1）：
 *   ① 純函式——期間切法、年資→天數、天→小時（不碰 DB）。
 *   ② grantAnnualLeave 的判斷邏輯——用假的 PostgREST builder 餵資料，驗
 *      「發放／搬遷／跳過」各自的條件與寫出去的 payload。正式庫還沒套 migration 0050
 *      （期間欄），真打 DB 的合約測試在 annual-leave-live.test.ts 會整組跳過，
 *      所以這一層先把邏輯釘住。
 */

/* ── grantAnnualLeave 的 DB 替身 ─────────────────────────────────────── */

type Row = Record<string, any>
/** 期間欄探測結果（false 時 grantAnnualLeave 應該直接丟 not_migrated）。 */
let hasPeriodColumns = true
let fakeDb: Record<string, Row[]> = {}
let insertedRows: Row[] = []

vi.mock("../lib/schema-compat.js", () => ({
  columnsExist: async () => hasPeriodColumns,
}))
vi.mock("../lib/tenant-tz.js", () => ({
  getTenantTimezone: async () => "Asia/Taipei",
}))
/** 非 null 時蓋掉 loadRuleConfigFor 回的規則（測曆年制分支用）。 */
let ruleOverride: Record<string, unknown> | null = null
vi.mock("../services/payroll-inputs.js", async () => {
  const { DEFAULT_RULE_CONFIG: defaults } = await import("../lib/default-rule-config.js")
  return {
    loadRuleConfigFor: async () => ({
      rules: ruleOverride ?? defaults,
      version: 1,
      effectiveFrom: null,
      isDefault: ruleOverride === null,
    }),
  }
})
vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: (table: string) => fakeFrom(table) },
}))

/**
 * 夠用的 PostgREST 假 builder：支援 select/eq/lte/gte/not/order/limit 與
 * maybeSingle/single，以及 insert(...).select().single()、update(...).eq()。
 * builder 本身是 thenable，所以 `await supabase.from(...).select(...)` 也拿得到結果。
 */
function fakeFrom(table: string) {
  const preds: Array<(r: Row) => boolean> = []
  let mode: "select" | "insert" | "update" = "select"
  let patch: Row | null = null
  let staged: Row | null = null

  const rows = () => (fakeDb[table] ?? []).filter((r) => preds.every((p) => p(r)))
  const result = () => {
    if (mode === "insert") return { data: staged ? [staged] : [], error: null }
    if (mode === "update") {
      const targets = rows()
      for (const t of targets) Object.assign(t, patch)
      return { data: targets, error: null }
    }
    return { data: rows(), error: null }
  }

  const builder: any = {
    select: () => builder,
    eq: (col: string, val: unknown) => (preds.push((r) => r[col] === val), builder),
    lte: (col: string, val: string) => (preds.push((r) => r[col] <= val), builder),
    gte: (col: string, val: string) => (preds.push((r) => r[col] >= val), builder),
    not: (col: string) => (preds.push((r) => r[col] != null), builder),
    order: () => builder,
    limit: () => builder,
    insert: (row: Row) => {
      mode = "insert"
      staged = { id: `bal-${(fakeDb[table] ?? []).length + 1}`, ...row }
      fakeDb[table] = [...(fakeDb[table] ?? []), staged]
      insertedRows.push(staged)
      return builder
    },
    update: (p: Row) => ((mode = "update"), (patch = p), builder),
    maybeSingle: async () => ({ data: (result().data as Row[])[0] ?? null, error: null }),
    single: async () => ({ data: (result().data as Row[])[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
  }
  return builder
}

const TENANT = "11111111-1111-1111-1111-111111111111"
const ASOF = "2026-09-22"

const TABLE = DEFAULT_ANNUAL_LEAVE_TABLE
const INC = DEFAULT_ANNUAL_LEAVE_INCREMENT

function daysAt(hireDate: string, asOf: string): { start: string; end: string; months: number; days: number } {
  const p = anniversaryPeriod(hireDate, asOf)
  if (!p) throw new Error(`anniversaryPeriod(${hireDate}, ${asOf}) 回 null`)
  return { start: p.start, end: p.end, months: p.seniorityMonths, days: annualLeaveDays(p.seniorityMonths, TABLE, INC) }
}

describe("anniversaryPeriod — 含 asOf 的那一段週年期間", () => {
  it("到職 2020-05-10、基準日 2026-09-22 → 2026-05-10～2027-05-09、年資 72 個月、15 日", () => {
    expect(daysAt("2020-05-10", "2026-09-22")).toEqual({
      start: "2026-05-10",
      end: "2027-05-09",
      months: 72,
      days: 15,
    })
  })

  it("到職 2026-04-01、基準日 2026-10-01（滿 6 個月當天）→ 2026-10-01～2027-03-31、3 日", () => {
    expect(daysAt("2026-04-01", "2026-10-01")).toEqual({
      start: "2026-10-01",
      end: "2027-03-31",
      months: 6,
      days: 3,
    })
  })

  it("同一個人在 2026-09-22 還在「未滿 6 個月」那一段（2026-04-01～2026-09-30）→ 0 日", () => {
    expect(daysAt("2026-04-01", "2026-09-22")).toEqual({
      start: "2026-04-01",
      end: "2026-09-30",
      months: 0,
      days: 0,
    })
  })

  it("到職 2026-08-01、基準日 2026-09-22 → 未滿 6 個月 → 0 日（發放時 skip）", () => {
    expect(daysAt("2026-08-01", "2026-09-22")).toEqual({
      start: "2026-08-01",
      end: "2027-01-31",
      months: 0,
      days: 0,
    })
  })

  it("滿 1 年當天進入第一個整年期間（到職 2026-04-01、基準日 2027-04-01）→ 7 日", () => {
    expect(daysAt("2026-04-01", "2027-04-01")).toEqual({
      start: "2027-04-01",
      end: "2028-03-31",
      months: 12,
      days: 7,
    })
  })

  it("到職日當天就有期間（未滿 6 個月那段），基準日早於到職日 → null", () => {
    expect(anniversaryPeriod("2026-08-01", "2026-08-01")?.start).toBe("2026-08-01")
    expect(anniversaryPeriod("2026-08-01", "2026-07-31")).toBeNull()
  })

  it("月底到職夾月底：2024-08-31 + 6 個月 ＝ 2025-02-28，期間迄日是前一天", () => {
    const p = anniversaryPeriod("2024-08-31", "2024-12-01")
    expect(p).toEqual({ start: "2024-08-31", end: "2025-02-27", seniorityMonths: 0 })
  })

  it("閏日到職：2024-02-29 的一週年期間是 2025-02-28～2026-02-27", () => {
    const p = anniversaryPeriod("2024-02-29", "2025-06-01")
    expect(p).toEqual({ start: "2025-02-28", end: "2026-02-27", seniorityMonths: 12 })
  })
})

describe("annualLeaveDays — 勞基法 §38 年資表＋每年 +1 上限 30", () => {
  it.each([
    [0, 0],
    [5, 0],
    [6, 3],
    [11, 3],
    [12, 7],
    [24, 10],
    [36, 14],
    [60, 15],
    [108, 15],
    [120, 16], // 滿 10 年
    [132, 17], // 11 年
    [288, 30], // 24 年（16 + 14）
    [300, 30], // 25 年仍 30（上限）
    [480, 30], // 40 年也是 30
  ])("年資 %i 個月 → %i 日", (months, days) => {
    expect(annualLeaveDays(months, TABLE, INC)).toBe(days)
  })

  it("年資表可自訂（客戶要優於法令時直接改規則參數）", () => {
    const table = [
      { minMonths: 6, days: 5 },
      { minMonths: 12, days: 10 },
    ]
    expect(annualLeaveDays(6, table, INC)).toBe(5)
    expect(annualLeaveDays(24, table, INC)).toBe(10)
  })

  it("上限低於表上的天數時以表為準（設定打錯不會反而扣假）", () => {
    expect(annualLeaveDays(120, TABLE, { afterMonths: 120, perYearDays: 1, maxDays: 5 })).toBe(16)
  })
})

describe("entitledHoursFor — 天 → 小時（leave_balances 存小時）", () => {
  it("15 日 × 每日 8 小時 ＝ 120 小時", () => {
    expect(entitledHoursFor(15, 8)).toBe(120)
  })
  it("3 日 × 每日 7.5 小時 ＝ 22.5 小時", () => {
    expect(entitledHoursFor(3, 7.5)).toBe(22.5)
  })
})

describe("日期小工具", () => {
  it("addMonthsKey 落不到的日子夾到月底", () => {
    expect(addMonthsKey("2026-01-31", 1)).toBe("2026-02-28")
    expect(addMonthsKey("2024-01-31", 1)).toBe("2024-02-29")
    expect(addMonthsKey("2026-12-15", 1)).toBe("2027-01-15")
    expect(addMonthsKey("2026-03-31", -1)).toBe("2026-02-28")
  })
  it("monthsBetweenKeys 把夾月底算成滿一個月", () => {
    expect(monthsBetweenKeys("2026-01-31", "2026-02-28")).toBe(1)
    expect(monthsBetweenKeys("2026-01-31", "2026-02-27")).toBe(0)
    expect(monthsBetweenKeys("2020-05-10", "2026-09-22")).toBe(76)
    expect(monthsBetweenKeys("2026-08-01", "2026-07-31")).toBe(-1)
  })
})

describe("規則 resolver 串接（@hr/rules）", () => {
  it("DEFAULT_RULE_CONFIG 沒設 leave.* → 週年制＋法定年資表＋特休 code 'annual'", () => {
    const policy = resolveAnnualLeavePolicy(DEFAULT_RULE_CONFIG)
    expect(policy.basis).toBe("anniversary")
    expect(policy.typeCode).toBe("annual")
    expect(annualLeaveDays(72, policy.table, policy.increment)).toBe(15)
    expect(entitledHoursFor(15, DEFAULT_RULE_CONFIG.payroll.dailyRegularHours)).toBe(120)
  })
})

describe("grantAnnualLeave — 發放／搬遷／跳過（假 DB）", () => {
  beforeEach(() => {
    hasPeriodColumns = true
    ruleOverride = null
    insertedRows = []
    fakeDb = {
      leave_types: [{ id: "lt-annual", tenant_id: TENANT, code: "annual" }],
      employees: [
        // 年資 6 年 → 15 日；週年期間 2026-05-10～2027-05-09
        { id: "e-senior", tenant_id: TENANT, emp_no: "A1", name: "資深", status: "active", hire_date: "2020-05-10" },
        // 年資 1 年 → 7 日
        { id: "e-junior", tenant_id: TENANT, emp_no: "A2", name: "一年", status: "active", hire_date: "2025-05-01" },
        // 年資 1 個月 → 未滿 6 個月
        { id: "e-newbie", tenant_id: TENANT, emp_no: "A3", name: "新人", status: "active", hire_date: "2026-08-01" },
      ],
      leave_balances: [],
    }
  })

  it("三位員工 → 兩列 auto（15 日／7 日）、一列未滿 6 個月 skip", async () => {
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF })
    expect(res.basis).toBe("anniversary")
    expect(res.leaveTypeId).toBe("lt-annual")
    expect(res.granted.map((g) => [g.employeeId, g.days, g.entitledHours])).toEqual([
      ["e-senior", 15, 120],
      ["e-junior", 7, 56],
    ])
    expect(res.skipped.map((s2) => [s2.employeeId, s2.reason])).toEqual([["e-newbie", "under_six_months"]])

    expect(insertedRows).toHaveLength(2)
    expect(insertedRows[0]).toMatchObject({
      tenant_id: TENANT,
      employee_id: "e-senior",
      leave_type_id: "lt-annual",
      year: 2026,
      period_start: "2026-05-10",
      period_end: "2027-05-09",
      source: "auto",
      entitled: 120,
      used: 0,
      deferred: 0,
    })
    expect(insertedRows[0].note).toBe("年度給假：年資 72 個月 → 15 日")
  })

  it("dryRun 只算不寫", async () => {
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF, dryRun: true })
    expect(res.dryRun).toBe(true)
    expect(res.granted).toHaveLength(2)
    expect(insertedRows).toHaveLength(0)
    expect(fakeDb.leave_balances).toHaveLength(0)
  })

  it("再跑一次 0 新增（同期間已有桶 → already_granted）", async () => {
    await grantAnnualLeave(TENANT, { asOf: ASOF })
    insertedRows = []
    const again = await grantAnnualLeave(TENANT, { asOf: ASOF })
    expect(again.granted).toHaveLength(0)
    expect(again.skipped.map((s2) => s2.reason)).toEqual(["already_granted", "already_granted", "under_six_months"])
    expect(insertedRows).toHaveLength(0)
    expect(fakeDb.leave_balances).toHaveLength(2)
  })

  it("migrate：曆年列改期間＋source='migrated'＋note 記原年份，entitled／used 不動", async () => {
    fakeDb.leave_balances = [
      {
        id: "bal-legacy",
        tenant_id: TENANT,
        employee_id: "e-senior",
        leave_type_id: "lt-annual",
        year: 2026,
        period_start: "2026-01-01",
        period_end: "2026-12-31",
        source: "manual",
        entitled: 120,
        used: 16,
        deferred: 0,
      },
    ]
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF, migrate: true })
    expect(res.migrated).toHaveLength(1)
    expect(res.migrated[0]).toMatchObject({ employeeId: "e-senior", fromYear: 2026, usedHours: 16, balanceId: "bal-legacy" })
    expect(fakeDb.leave_balances[0]).toMatchObject({
      id: "bal-legacy",
      period_start: "2026-05-10",
      period_end: "2027-05-09",
      source: "migrated",
      note: "由曆年 2026 搬遷",
      entitled: 120,
      used: 16,
    })
    // 另一位仍是新發放；未滿 6 個月的照舊 skip
    expect(res.granted.map((g) => g.employeeId)).toEqual(["e-junior"])
  })

  it("沒開 migrate 時曆年列原封不動，另外新增週年桶", async () => {
    fakeDb.leave_balances = [
      {
        id: "bal-legacy",
        tenant_id: TENANT,
        employee_id: "e-senior",
        leave_type_id: "lt-annual",
        year: 2026,
        period_start: "2026-01-01",
        period_end: "2026-12-31",
        source: "manual",
        entitled: 120,
        used: 16,
        deferred: 0,
      },
    ]
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF })
    expect(res.migrated).toHaveLength(0)
    expect(res.granted.map((g) => g.employeeId)).toEqual(["e-senior", "e-junior"])
    expect(fakeDb.leave_balances[0]).toMatchObject({ period_start: "2026-01-01", source: "manual", used: 16 })
  })

  it("已離職／沒到職日的人不在名單內（query 就篩掉）", async () => {
    fakeDb.employees.push(
      { id: "e-left", tenant_id: TENANT, emp_no: "A4", name: "離職", status: "inactive", hire_date: "2019-01-01" },
      { id: "e-nohire", tenant_id: TENANT, emp_no: "A5", name: "沒到職日", status: "active", hire_date: null },
    )
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF })
    const all = [...res.granted, ...res.migrated, ...res.skipped].map((r) => r.employeeId)
    expect(all).not.toContain("e-left")
    expect(all).not.toContain("e-nohire")
  })

  it("到職日晚於基準日 → not_hired_yet，不發假", async () => {
    fakeDb.employees = [
      { id: "e-future", tenant_id: TENANT, emp_no: "A9", name: "還沒到職", status: "active", hire_date: "2026-12-01" },
    ]
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF })
    expect(res.skipped.map((s2) => [s2.employeeId, s2.reason])).toEqual([["e-future", "not_hired_yet"]])
    expect(insertedRows).toHaveLength(0)
  })

  it("找不到規則指定的特休 code → leave_type_not_found（409 用）", async () => {
    fakeDb.leave_types = []
    await expect(grantAnnualLeave(TENANT, { asOf: ASOF })).rejects.toMatchObject({
      name: "AnnualLeaveError",
      code: "leave_type_not_found",
    })
  })

  it("期間欄還沒套 → not_migrated，不做任何寫入", async () => {
    hasPeriodColumns = false
    const err = await grantAnnualLeave(TENANT, { asOf: ASOF }).catch((e) => e)
    expect(err).toBeInstanceOf(AnnualLeaveError)
    expect((err as AnnualLeaveError).code).toBe("not_migrated")
    expect(insertedRows).toHaveLength(0)
  })

  it("規則設成曆年制 → 全部 skip（calendar_basis），一列都不寫", async () => {
    ruleOverride = { ...DEFAULT_RULE_CONFIG, leave: { annualLeaveBasis: "calendar" } }
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF })
    expect(res.basis).toBe("calendar")
    expect(res.granted).toHaveLength(0)
    expect(res.migrated).toHaveLength(0)
    expect(res.skipped.map((s2) => s2.reason)).toEqual(["calendar_basis", "calendar_basis", "calendar_basis"])
    expect(insertedRows).toHaveLength(0)
  })

  it("自訂年資表（優於法令）照著發：滿 6 個月就 5 日", async () => {
    ruleOverride = {
      ...DEFAULT_RULE_CONFIG,
      leave: { annualLeaveTable: [{ minMonths: 6, days: 5 }, { minMonths: 12, days: 12 }] },
    }
    const res = await grantAnnualLeave(TENANT, { asOf: ASOF })
    expect(res.granted.map((g) => [g.employeeId, g.days])).toEqual([
      ["e-senior", 12],
      ["e-junior", 12],
    ])
  })

  it("asOf 格式錯 → invalid_as_of", async () => {
    await expect(grantAnnualLeave(TENANT, { asOf: "2026/09/22" })).rejects.toMatchObject({ code: "invalid_as_of" })
  })
})
