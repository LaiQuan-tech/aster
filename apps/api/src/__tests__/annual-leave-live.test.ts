import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"
import { addMonthsKey, anniversaryPeriod } from "../services/annual-leave"
import { localDateKey } from "../lib/tz"

/**
 * 特休週年制（W1）— live 合約測試（throwaway 租戶）。
 *
 * 流程：HR＋主管＋四位員工（年資 6 年／1 年／1 個月／3 年）＋假別 code 'annual' →
 * dryRun 不寫入 → 正式發放（兩列 auto、一列 skip）→ 再跑 0 新增 →
 * 曆年列 migrate 成週年期（entitled／used 不變）→ 核准假單扣到週年桶 →
 * `?year=` 是「期間與該年重疊」。
 *
 * 正式庫尚未套 migration 0050（leave_balances.period_start／period_end／source／note）
 * 時整組 describe.skipIf 跳過；套完後直接
 * `npx vitest run src/__tests__/annual-leave-live.test.ts` 即可（欄位自動探測）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const r = await supabaseAdmin.from("leave_balances").select("period_start, period_end, source, note").limit(1)
  return !r.error
}
const ready = await migrated()
if (!ready && process.env.ANNUAL_LEAVE_MIGRATED) {
  console.warn("[annual-leave-live] ANNUAL_LEAVE_MIGRATED 已設，但正式庫還沒有 migration 0050 的期間欄——整組跳過")
}

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

/** 基準日固定成「租戶時區的今天」，所有到職日都由它往回推，跑在哪一天都成立。 */
const ASOF = localDateKey(new Date(), "Asia/Taipei")
const DAILY_HOURS = 8

let tenantId: string
let adminToken: string
let mgrId: string
let mgrToken: string
let annualTypeId: string
/** 年資 6 年（15 日）／1 年（7 日）／1 個月（未滿 6 個月）／3 年（曆年列待搬遷）。 */
let seniorId: string
let seniorToken: string
let juniorId: string
let newbieId: string
let legacyId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
async function createEmployee(opts: { label: string; role: string; hireDate?: string }) {
  const email = `annual-${stamp}-${opts.label}@example.com`
  const password = `Pw-${stamp}-${opts.label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${opts.label}-${stamp}`,
    password,
    role: opts.role,
    empNo: `A-${opts.label}`,
    hireDate: opts.hireDate ?? null,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${opts.label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, token: await signIn(email, password) }
}

async function grant(body: Record<string, unknown>) {
  const res = await as(adminToken, request(app).post("/leave-balances/annual-grant")).send(body)
  expect(res.status).toBe(200)
  return res.body as {
    asOf: string
    dryRun: boolean
    basis: string
    dailyRegularHours: number
    granted: Array<Record<string, unknown>>
    migrated: Array<Record<string, unknown>>
    skipped: Array<Record<string, unknown>>
  }
}

async function balancesOf(employeeId: string) {
  const { data, error } = await supabaseAdmin
    .from("leave_balances")
    .select("id, year, period_start, period_end, source, note, entitled, used, deferred")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("leave_type_id", annualTypeId)
    .order("period_start", { ascending: true })
  if (error) throw new Error(`balancesOf: ${error.message}`)
  return (data ?? []) as Array<{
    id: string
    year: number
    period_start: string
    period_end: string
    source: string
    note: string | null
    entitled: string
    used: string
    deferred: string
  }>
}

describe.skipIf(!ready)("特休週年制 — live", () => {
  beforeAll(async () => {
    const adminEmail = `annual-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `ANNUAL ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const mgr = await createEmployee({ label: "mgr", role: "manager" })
    mgrId = mgr.id
    mgrToken = mgr.token

    const senior = await createEmployee({ label: "senior", role: "employee", hireDate: addMonthsKey(ASOF, -72) })
    seniorId = senior.id
    seniorToken = senior.token
    juniorId = (await createEmployee({ label: "junior", role: "employee", hireDate: addMonthsKey(ASOF, -12) })).id
    newbieId = (await createEmployee({ label: "newbie", role: "employee", hireDate: addMonthsKey(ASOF, -1) })).id
    legacyId = (await createEmployee({ label: "legacy", role: "employee", hireDate: addMonthsKey(ASOF, -36) })).id

    const lt = await as(adminToken, request(app).post("/leave-types")).send({ code: "annual", name: "特休", paid: true })
    if (lt.status !== 201) throw new Error(`beforeAll: create leave type (${lt.status})`)
    annualTypeId = lt.body.id

    const flow = await as(adminToken, request(app).put("/approval-flows/leave")).send({ approverEmpIds: [mgrId] })
    if (flow.status !== 200) throw new Error(`beforeAll: PUT approval-flows/leave (${flow.status})`)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      try {
        await purgeTestTenant(tid)
      } catch (err) {
        console.warn(`[annual-leave-live] purge ${tid} 失敗：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  it("dryRun 只算不寫：清單有兩人可發，DB 一列都沒有", async () => {
    const res = await grant({ asOf: ASOF, dryRun: true })
    expect(res.basis).toBe("anniversary")
    expect(res.dailyRegularHours).toBe(DAILY_HOURS)
    expect(res.granted.map((g) => g.employeeId).sort()).toEqual([seniorId, juniorId].sort())
    expect(await balancesOf(seniorId)).toHaveLength(0)
    expect(await balancesOf(juniorId)).toHaveLength(0)
  }, 30_000)

  it("正式發放：三位員工 → 兩列 source='auto'（15 日／7 日）、一列未滿 6 個月 skip", async () => {
    const res = await grant({ asOf: ASOF })
    expect(res.dryRun).toBe(false)

    const senior = res.granted.find((g) => g.employeeId === seniorId)!
    expect(senior.days).toBe(15)
    expect(senior.entitledHours).toBe(15 * DAILY_HOURS)
    const junior = res.granted.find((g) => g.employeeId === juniorId)!
    expect(junior.days).toBe(7)
    expect(res.granted).toHaveLength(2)

    const skippedNewbie = res.skipped.find((s) => s.employeeId === newbieId)!
    expect(skippedNewbie.reason).toBe("under_six_months")

    const expected = anniversaryPeriod(addMonthsKey(ASOF, -72), ASOF)!
    const rows = await balancesOf(seniorId)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe("auto")
    expect(rows[0].period_start).toBe(expected.start)
    expect(rows[0].period_end).toBe(expected.end)
    expect(rows[0].year).toBe(Number(expected.start.slice(0, 4)))
    expect(Number(rows[0].entitled)).toBe(15 * DAILY_HOURS)
    expect(Number(rows[0].used)).toBe(0)
    // 未滿 6 個月的人不會被建空桶
    expect(await balancesOf(newbieId)).toHaveLength(0)
  }, 40_000)

  it("再跑一次 0 新增（同期間已有桶 → already_granted）", async () => {
    const res = await grant({ asOf: ASOF })
    expect(res.granted).toHaveLength(0)
    expect(res.migrated).toHaveLength(0)
    expect(res.skipped.find((s) => s.employeeId === seniorId)?.reason).toBe("already_granted")
    expect(await balancesOf(seniorId)).toHaveLength(1)
  }, 30_000)

  it("migrate：曆年列改成週年期、source='migrated'、entitled／used 原封不動", async () => {
    const year = Number(ASOF.slice(0, 4))
    const put = await as(adminToken, request(app).put("/leave-balances")).send({
      employeeId: legacyId,
      leaveTypeId: annualTypeId,
      year,
      entitled: 80,
    })
    expect(put.status).toBe(200)
    // 曆年制下「1 月到週年日之間」已用掉的時數（§3.7 的已知取捨：會併進新期間）
    const { error: usedErr } = await supabaseAdmin
      .from("leave_balances")
      .update({ used: 16 })
      .eq("id", put.body.id)
    expect(usedErr).toBeNull()

    const before = await balancesOf(legacyId)
    expect(before).toHaveLength(1)
    expect(before[0].period_start).toBe(`${year}-01-01`)
    expect(before[0].source).toBe("manual")

    const res = await grant({ asOf: ASOF, migrate: true })
    expect(res.granted).toHaveLength(0)
    expect(res.migrated).toHaveLength(1)
    expect(res.migrated[0].employeeId).toBe(legacyId)
    expect(res.migrated[0].fromYear).toBe(year)
    expect(res.migrated[0].usedHours).toBe(16)

    const expected = anniversaryPeriod(addMonthsKey(ASOF, -36), ASOF)!
    const after = await balancesOf(legacyId)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(put.body.id)
    expect(after[0].period_start).toBe(expected.start)
    expect(after[0].period_end).toBe(expected.end)
    expect(after[0].source).toBe("migrated")
    expect(after[0].note).toBe(`由曆年 ${year} 搬遷`)
    expect(Number(after[0].entitled)).toBe(80)
    expect(Number(after[0].used)).toBe(16)
  }, 40_000)

  it("核准假單扣到週年桶（不是曆年桶，也不會多開一列）", async () => {
    const filed = await as(seniorToken, request(app).post("/requests")).send({
      kind: "leave",
      leaveTypeId: annualTypeId,
      startAt: `${ASOF}T01:00:00.000Z`,
      endAt: `${ASOF}T09:00:00.000Z`,
      hours: 8,
      reason: "annual-leave-live",
    })
    expect(filed.status).toBe(201)

    const approve = await as(mgrToken, request(app).post(`/requests/${filed.body.requestId}/approve`)).send({ comment: "ok" })
    expect(approve.status).toBe(200)
    expect(approve.body.status).toBe("approved")

    const rows = await balancesOf(seniorId)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe("auto")
    expect(Number(rows[0].used)).toBe(8)
    expect(Number(rows[0].entitled) - Number(rows[0].used)).toBe(15 * DAILY_HOURS - 8)
  }, 40_000)

  it("GET /leave-balances?year= ＝『期間與該年重疊』：跨年的週年桶兩年都查得到", async () => {
    const expected = anniversaryPeriod(addMonthsKey(ASOF, -72), ASOF)!
    const startYear = Number(expected.start.slice(0, 4))
    const endYear = Number(expected.end.slice(0, 4))
    for (const y of new Set([startYear, endYear])) {
      const res = await as(adminToken, request(app).get(`/leave-balances?employeeId=${seniorId}&year=${y}`))
      expect(res.status).toBe(200)
      const balances = res.body.balances as Array<Record<string, unknown>>
      expect(balances).toHaveLength(1)
      expect(balances[0].period_start).toBe(expected.start)
      expect(balances[0].period_end).toBe(expected.end)
      expect(balances[0].source).toBe("auto")
    }
    // 期間完全沒碰到的年份查不到
    const far = await as(adminToken, request(app).get(`/leave-balances?employeeId=${seniorId}&year=${startYear - 2}`))
    expect(far.status).toBe(200)
    expect(far.body.balances).toHaveLength(0)
  }, 30_000)
})
