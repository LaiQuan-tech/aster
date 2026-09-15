import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env 由 vitest setupFile（src/__tests__/setup.ts）在任何模組 import 前載入，
// 底下 eager 建立的 supabase client 才拿得到真的憑證。
import type { RuleConfig } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { zonedTimeToUtc } from "../lib/tz"
import { app } from "../app"

/**
 * C4 規則版本「依計算月份選版」— live 合約測試。
 *
 * 純函式（pickRuleConfigVersion / nextPeriodFirstDay）已在 rule-config.test.ts
 * 測過；這裡驗的是真的打 HTTP、真的寫 Supabase 之後的端到端行為：
 *
 *   租戶 V（版本選擇）：
 *     PUT v1（effectiveFrom 'now'）→ PUT v2（下個月1號生效）
 *     → GET /rule-config 必須回 v1（新版還沒到生效日），不是剛存的 v2
 *     → GET /rule-config/versions 兩筆、新到舊、active 只落在最後存的那筆
 *     → /versions 是 requireHrAdmin、/rule-config 任何成員都能讀
 *     → 不帶 effectiveFrom 預設下個月1號；亂填 → 400 invalid_effective_from
 *
 *   租戶 S（補跑上月結算）：
 *     上月生效的 v1（加班 ×1.34）＋上月與本月各一天加班打卡
 *     → 今天再存 v2（本月生效 ×3）、v3（下月生效 ×5）
 *     → 對「上個月」跑 POST /attendance-sheets/generate
 *     → attendance_sheets.rule_config_version 必須是 1（不是剛存的 3）
 *     → 同一租戶對「本月」跑 → 2；加班費隨版本倍率差，舊月份的錢不被今天的
 *       規則改動（這是這條功能真正要守住的東西）。
 *
 * 正式庫尚未套上 rule_configs.effective_from / attendance_sheets 時整組
 * describe.skipIf 跳過（先探測）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""
const TPE = "Asia/Taipei"

async function ruleVersioningMigrated(): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false
  const rc = await supabaseAdmin.from("rule_configs").select("version, effective_from").limit(1)
  if (rc.error) return false
  const sh = await supabaseAdmin.from("attendance_sheets").select("id, rule_config_version").limit(1)
  return !sh.error
}
const migrated = await ruleVersioningMigrated()

/* ── 日期（刻意不 import 實作的 helper，測試自己算，才是黑箱驗證）──────── */

/** 今天（Asia/Taipei）'YYYY-MM-DD'——PUT effectiveFrom:'now' 應該解析成這個。 */
function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TPE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

/** 'YYYY-MM' ± n 個月。 */
function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split("-").map(Number)
  const zero = y * 12 + (m - 1) + delta
  return `${Math.floor(zero / 12)}-${String((zero % 12) + 1).padStart(2, "0")}`
}

/**
 * `period` 當月第一個週一～週四的日期。避開週末（settlement 沒有 calendar 時
 * 週六日預設 rest_day，會套到不同的加班倍率規則），也避開週五省得跨日打卡。
 * 任何月份的前 7 天必定包含一個週一～週四。
 */
function firstWeekdayOf(period: string): string {
  for (let d = 1; d <= 7; d++) {
    const key = `${period}-${String(d).padStart(2, "0")}`
    const wd = new Date(`${key}T00:00:00Z`).getUTCDay()
    if (wd >= 1 && wd <= 4) return key
  }
  throw new Error(`firstWeekdayOf(${period}): 找不到平日`)
}

const TODAY = taipeiToday()
const CURRENT_PERIOD = TODAY.slice(0, 7)
const LAST_PERIOD = shiftPeriod(CURRENT_PERIOD, -1)
const NEXT_MONTH_FIRST = `${shiftPeriod(CURRENT_PERIOD, 1)}-01`
const LAST_MONTH_FIRST = `${LAST_PERIOD}-01`
const HIRE_DATE = `${shiftPeriod(CURRENT_PERIOD, -6)}-01`
const OT_DAY_LAST = firstWeekdayOf(LAST_PERIOD)
const OT_DAY_CURRENT = firstWeekdayOf(CURRENT_PERIOD)

/* ── 規則 DSL（除了平日加班倍率外，三版完全相同）─────────────────────── */

function dsl(weekdayOtMultiplier: number): RuleConfig {
  return {
    attendance_bonus: {
      base: 2000,
      tiers: [
        { lateMinutesUpTo: 5, deduct: 0 },
        { lateMinutesUpTo: null, deduct: 600 },
      ],
    },
    overtime: {
      rules: [
        { when: "weekday_ot", multiplier: weekdayOtMultiplier },
        { when: "rest_day", multiplier: 1.67 },
        { when: "fixed_holiday", multiplier: 2 },
      ],
    },
    night: { window: { from: "00:00", to: "08:30" }, multiplier: 2 },
    payroll: { method: "monthly", dailyRegularHours: 8 },
  }
}

const OT_OLD = 1.34 // 上個月生效的那版
const OT_NOW = 3 // 今天起生效
const OT_NEXT = 5 // 下個月起生效（剛存的最新版，補跑舊月份時絕不能被選到）

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

/* ── 租戶 V：版本選擇 ─────────────────────────────────────────────── */
let vTenantId: string
let vAdminToken: string
let vEmpToken: string

/* ── 租戶 S：補跑上月結算 ─────────────────────────────────────────── */
let sTenantId: string
let sAdminToken: string
let sEmpId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asVAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${vAdminToken}`)
}
function asVEmployee(req: request.Test) {
  return req.set("Authorization", `Bearer ${vEmpToken}`)
}
function asSAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${sAdminToken}`)
}

/** 該租戶目前所有版本（新到舊），直接讀 DB 當交叉驗證。 */
async function dbVersions(tenantId: string) {
  const { data, error } = await supabaseAdmin
    .from("rule_configs")
    .select("version, effective_from, active")
    .eq("tenant_id", tenantId)
    .order("version", { ascending: false })
  if (error) throw new Error(`dbVersions: ${error.message}`)
  return (data ?? []) as Array<{ version: number; effective_from: string | null; active: boolean }>
}

interface SheetProbe {
  ruleConfigVersion: number | null
  otTotal: number
  otPay: number
}

/** 對 period 產月表，回傳 DB 記下的版本＋API 算出的加班分鐘／加班費。 */
async function generateAndRead(period: string): Promise<SheetProbe> {
  const gen = await asSAdmin(request(app).post("/attendance-sheets/generate")).send({ period, employeeId: sEmpId })
  expect(gen.status).toBe(200)

  const { data: row, error } = await supabaseAdmin
    .from("attendance_sheets")
    .select("id, rule_config_version")
    .eq("tenant_id", sTenantId)
    .eq("employee_id", sEmpId)
    .eq("period", period)
    .single()
  if (error || !row) throw new Error(`generateAndRead(${period}): 沒有月表 — ${error?.message}`)

  const view = await asSAdmin(request(app).get(`/attendance-sheets/${row.id as string}`))
  expect(view.status).toBe(200)
  const sheet = view.body.sheet as {
    totals: { otTotal: number }
    money: { otPay: number } | null
  }
  if (!sheet.money) throw new Error(`generateAndRead(${period}): money 為 null（薪資結構沒生效？）`)
  return {
    ruleConfigVersion: (row.rule_config_version as number | null) ?? null,
    otTotal: sheet.totals.otTotal,
    otPay: sheet.money.otPay,
  }
}

describe.skipIf(!migrated)("C4 規則版本生效日 — live", () => {
  beforeAll(async () => {
    /* 租戶 V ------------------------------------------------------------- */
    const vAdminEmail = `rcv-${stamp}-admin@example.com`
    const vAdminPassword = `Pw-${stamp}-Aa1!`
    const v = await provisionTenant({ name: `RCV ${stamp}`, adminEmail: vAdminEmail, adminPassword: vAdminPassword })
    vTenantId = v.tenantId
    createdTenantIds.push(v.tenantId)
    createdUserIds.push(v.userId)
    vAdminToken = await signIn(vAdminEmail, vAdminPassword)

    const vEmpEmail = `rcv-${stamp}-emp@example.com`
    const vEmpPassword = `Pw-${stamp}-Bb2!`
    const vEmp = await asVAdmin(request(app).post("/employees")).send({
      email: vEmpEmail,
      name: "版本頁一般員工",
      password: vEmpPassword,
      role: "employee",
    })
    if (vEmp.status !== 201) throw new Error(`create V employee (${vEmp.status}): ${JSON.stringify(vEmp.body)}`)
    createdUserIds.push(vEmp.body.userId)
    vEmpToken = await signIn(vEmpEmail, vEmpPassword)

    /* 租戶 S ------------------------------------------------------------- */
    const sAdminEmail = `rcs-${stamp}-admin@example.com`
    const sAdminPassword = `Pw-${stamp}-Cc3!`
    const s = await provisionTenant({ name: `RCS ${stamp}`, adminEmail: sAdminEmail, adminPassword: sAdminPassword })
    sTenantId = s.tenantId
    createdTenantIds.push(s.tenantId)
    createdUserIds.push(s.userId)
    sAdminToken = await signIn(sAdminEmail, sAdminPassword)

    // hireDate 必須早於上個月月底，否則 generateSheets 判定「該月未在職」而跳過。
    const sEmp = await asSAdmin(request(app).post("/employees")).send({
      email: `rcs-${stamp}-emp@example.com`,
      name: "結算測試員工",
      password: `Pw-${stamp}-Dd4!`,
      role: "employee",
      hireDate: HIRE_DATE,
    })
    if (sEmp.status !== 201) throw new Error(`create S employee (${sEmp.status}): ${JSON.stringify(sEmp.body)}`)
    sEmpId = sEmp.body.employeeId
    createdUserIds.push(sEmp.body.userId)

    // 時薪明寫 → 月表的 money.otPay 才算得出來（引擎不猜時薪）。
    const sal = await asSAdmin(request(app).put(`/salary/${sEmpId}`)).send({
      method: "monthly",
      baseSalary: 48000,
      hourlyWage: 200,
    })
    if (sal.status !== 200) throw new Error(`PUT salary (${sal.status}): ${JSON.stringify(sal.body)}`)

    // 班表 09:00–18:00（休息 60），上月與本月各排一天。
    const { data: shift, error: shiftErr } = await supabaseAdmin
      .from("shifts")
      .insert({ tenant_id: sTenantId, name: "日班", start_time: "09:00", end_time: "18:00", break_minutes: 60 })
      .select("id")
      .single()
    if (shiftErr || !shift) throw new Error(`seed shift: ${shiftErr?.message}`)
    const { error: schedErr } = await supabaseAdmin.from("schedules").insert(
      [OT_DAY_LAST, OT_DAY_CURRENT].map((work_date) => ({
        tenant_id: sTenantId,
        employee_id: sEmpId,
        work_date,
        shift_id: shift.id as string,
      })),
    )
    if (schedErr) throw new Error(`seed schedules: ${schedErr.message}`)

    // 09:00 進 21:00 出 → 工時 660、正常 480 → 加班有數字可比。直接塞 punch_records
    // （打卡 API 只會蓋 now），時間用租戶時區換算成 UTC。
    const punch = (date: string, type: "in" | "out", hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number)
      return {
        tenant_id: sTenantId,
        employee_id: sEmpId,
        type,
        source: "web",
        punch_at: zonedTimeToUtc(date, h, m, TPE).toISOString(),
      }
    }
    const { error: punchErr } = await supabaseAdmin.from("punch_records").insert([
      punch(OT_DAY_LAST, "in", "09:00"),
      punch(OT_DAY_LAST, "out", "21:00"),
      punch(OT_DAY_CURRENT, "in", "09:00"),
      punch(OT_DAY_CURRENT, "out", "21:00"),
    ])
    if (punchErr) throw new Error(`seed punches: ${punchErr.message}`)

    // 「上個月當時生效」的規則：加班 ×1.34。這是補跑上月時應該被選到的那版。
    const v1 = await asSAdmin(request(app).put("/rule-config")).send({
      ...dsl(OT_OLD),
      effectiveFrom: LAST_MONTH_FIRST,
    })
    if (v1.status !== 200) throw new Error(`seed rule v1 (${v1.status}): ${JSON.stringify(v1.body)}`)
    expect(v1.body.version).toBe(1)
    expect(v1.body.effectiveFrom).toBe(LAST_MONTH_FIRST)
  }, 90_000)

  afterAll(async () => {
    // 子表在前、tenant/auth user 在後（FK 安全順序）。
    for (const tid of createdTenantIds) {
      await supabaseAdmin.from("attendance_sheet_days").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_sheets").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("punch_records").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("schedules").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("shifts").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("salary_structures").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("rule_configs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      // audit_logs 放在 employees 之後、tenants 之前：刪員工會再觸發 audit trigger 寫新列（employees 掛 audit_all），
      // 先刪 audit_logs 會留孤兒；tenants 刪掉後 is_disposable_tenant 回 false，append-only trigger 就不放行了。
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("PUT effectiveFrom → GET 回的是「今天所屬月份」生效的版本", () => {
    it("沒存過任何版本 → GET /rule-config 回預設樣板（version 0、isDefault）、/versions 回空陣列", async () => {
      const res = await asVAdmin(request(app).get("/rule-config"))
      expect(res.status).toBe(200)
      expect(res.body.isDefault).toBe(true)
      expect(res.body.version).toBe(0)
      expect(res.body.effectiveFrom).toBeNull()
      expect(res.body.config?.payroll).toBeTruthy()

      // 沒存過規則的租戶是正常狀態 → 空陣列，不是 404。
      const versions = await asVAdmin(request(app).get("/rule-config/versions"))
      expect(versions.status).toBe(200)
      expect(versions.body).toEqual([])
    })

    it("v1：effectiveFrom 'now' → 存成今天（Asia/Taipei）", async () => {
      const res = await asVAdmin(request(app).put("/rule-config")).send({ ...dsl(OT_OLD), effectiveFrom: "now" })
      expect(res.status).toBe(200)
      expect(res.body.version).toBe(1)
      expect(res.body.effectiveFrom).toBe(TODAY)
    })

    it("v2：effectiveFrom 下個月1號 → 存成該日", async () => {
      const res = await asVAdmin(request(app).put("/rule-config")).send({
        ...dsl(OT_NEXT),
        effectiveFrom: NEXT_MONTH_FIRST,
      })
      expect(res.status).toBe(200)
      expect(res.body.version).toBe(2)
      expect(res.body.effectiveFrom).toBe(NEXT_MONTH_FIRST)
    })

    it("★ GET /rule-config 回的是 v1，不是剛存的 v2（v2 還沒到生效日）", async () => {
      const res = await asVAdmin(request(app).get("/rule-config"))
      expect(res.status).toBe(200)
      // 核心斷言：不是最後存的那版。
      expect(res.body.version).not.toBe(2)
      expect(res.body.version).toBe(1)
      expect(res.body.effectiveFrom).toBe(TODAY)
      expect(res.body.isDefault).toBe(false)
      // 規則本體也必須是 v1 的那份（倍率 1.34，不是 v2 的 5）。
      const weekday = (res.body.config.overtime.rules as Array<{ when: string; multiplier: number }>).find(
        (r) => r.when === "weekday_ot",
      )
      expect(weekday?.multiplier).toBe(OT_OLD)
    })

    it("★ GET /rule-config/versions → 兩筆、新到舊、active 只在最後存的 v2", async () => {
      const res = await asVAdmin(request(app).get("/rule-config/versions"))
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body).toHaveLength(2)
      expect(res.body[0]).toMatchObject({ version: 2, effectiveFrom: NEXT_MONTH_FIRST, active: true })
      expect(res.body[1]).toMatchObject({ version: 1, effectiveFrom: TODAY, active: false })
      expect(typeof res.body[0].createdAt).toBe("string")
      // 交叉驗證 DB：PUT 每存一版就把舊列翻 false，只留一筆 active。
      const rows = await dbVersions(vTenantId)
      expect(rows.map((r) => r.version)).toEqual([2, 1])
      expect(rows.filter((r) => r.active)).toHaveLength(1)
    })

    it("權限分層：/versions 是 requireHrAdmin（員工 403），/rule-config 一般成員讀得到", async () => {
      const denied = await asVEmployee(request(app).get("/rule-config/versions"))
      expect(denied.status).toBe(403)

      const allowed = await asVEmployee(request(app).get("/rule-config"))
      expect(allowed.status).toBe(200)
      expect(allowed.body.version).toBe(1)

      const deniedPut = await asVEmployee(request(app).put("/rule-config")).send({ ...dsl(OT_NOW), effectiveFrom: "now" })
      expect(deniedPut.status).toBe(403)
    })

    it("不帶 effectiveFrom → 預設下個月1號；亂填 → 400 invalid_effective_from（且不寫入）", async () => {
      const before = await dbVersions(vTenantId)

      const bad = await asVAdmin(request(app).put("/rule-config")).send({ ...dsl(OT_NOW), effectiveFrom: "下週一" })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("invalid_effective_from")
      expect(await dbVersions(vTenantId)).toHaveLength(before.length)

      const omitted = await asVAdmin(request(app).put("/rule-config")).send(dsl(OT_NOW))
      expect(omitted.status).toBe(200)
      expect(omitted.body.version).toBe(3)
      expect(omitted.body.effectiveFrom).toBe(NEXT_MONTH_FIRST)

      // 又多一版下個月生效的，本月讀到的仍然是 v1。
      const get = await asVAdmin(request(app).get("/rule-config"))
      expect(get.body.version).toBe(1)
    })
  })

  describe("補跑上個月的結算，用的是上個月當時生效的那版", () => {
    it("今天再存兩版（本月生效 ×3、下月生效 ×5）", async () => {
      const v2 = await asSAdmin(request(app).put("/rule-config")).send({ ...dsl(OT_NOW), effectiveFrom: "now" })
      expect(v2.status).toBe(200)
      expect(v2.body).toMatchObject({ version: 2, effectiveFrom: TODAY })

      const v3 = await asSAdmin(request(app).put("/rule-config")).send({
        ...dsl(OT_NEXT),
        effectiveFrom: NEXT_MONTH_FIRST,
      })
      expect(v3.status).toBe(200)
      expect(v3.body).toMatchObject({ version: 3, effectiveFrom: NEXT_MONTH_FIRST })

      const versions = await asSAdmin(request(app).get("/rule-config/versions"))
      expect(versions.body.map((r: { version: number }) => r.version)).toEqual([3, 2, 1])
    })

    it("★ generate 上個月 → rule_config_version = 1（不是剛存的 3，也不是本月的 2）", async () => {
      const last = await generateAndRead(LAST_PERIOD)
      expect(last.ruleConfigVersion).toBe(1)
      expect(last.ruleConfigVersion).not.toBe(3)
      // 有真的算出加班，版本號才不是在一張空表上比對。
      expect(last.otTotal).toBeGreaterThan(0)
      expect(last.otPay).toBeGreaterThan(0)

      // 加班費 = 時薪 200 × 分鐘/60 × 1.34（舊版倍率），不是 ×5。
      const hours = last.otTotal / 60
      expect(last.otPay).toBeCloseTo(200 * hours * OT_OLD, 0)
      expect(last.otPay).toBeLessThan(200 * hours * OT_NEXT)
    })

    it("★ 同一租戶 generate 本月 → rule_config_version = 2，加班費隨倍率變高（舊月份的錢不動）", async () => {
      const current = await generateAndRead(CURRENT_PERIOD)
      expect(current.ruleConfigVersion).toBe(2)

      const last = await generateAndRead(LAST_PERIOD) // 重跑一次，上月仍是 v1
      expect(last.ruleConfigVersion).toBe(1)

      // 兩個月打卡完全一樣 → 加班分鐘相同，只有倍率不同。
      expect(current.otTotal).toBe(last.otTotal)
      expect(current.otPay).toBeGreaterThan(last.otPay)
      expect(current.otPay).toBeCloseTo((last.otPay * OT_NOW) / OT_OLD, 0)
    })
  })

  describe("afterAll 前的清理前置檢查", () => {
    it("這次建立的兩個租戶目前確實有資料（清理後由 afterAll 之外的查詢確認為 0）", async () => {
      const { count: tenantCount } = await supabaseAdmin
        .from("tenants")
        .select("id", { count: "exact", head: true })
        .in("id", createdTenantIds)
      expect(tenantCount).toBe(2)
    })
  })
})
