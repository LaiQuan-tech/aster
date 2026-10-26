import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { employeesRouter } from "../routes/employees.js"
import { meRouter } from "../routes/me.js"
import { canGrantGroupFinancials, canSeeGroupFinancials, loadGroupFinancialsAccess } from "../services/financial-visibility.js"
import { normalizeEmployeeFeatures } from "../services/employee-features.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 集團財務可見性（2026-10-26 業主：老闆與一般 HR 分開；services/financial-visibility.ts）。
 * 看得到：老闆（fallbackApproverEmpId）、platform_admin、features.seeGroupFinancials=true 的 hr_admin。
 * 授權旗標只有老闆／platform_admin 能改。⚠️ 識別碼、名稱都是明顯的假值。
 */

const app = express()
app.use(express.json())
app.use(employeesRouter)
app.use(meRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = { boss: emp(1), hr: emp(2), grantedHr: emp(3), platform: emp(4), accountant: emp(5), staff: emp(6), flaggedStaff: emp(7) }
const T = { boss: "boss-user", hr: "hr-user", grantedHr: "granted-hr-user", platform: "platform-user", accountant: "accountant-user", staff: "staff-user", flaggedStaff: "flagged-staff-user" }
const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

function row(id: string, userId: string, role: string, features: Record<string, unknown> = {}) {
  return { id, tenant_id: TENANT_ID, user_id: userId, name: "測試人員", role, dept_id: null, emp_no: null, status: "active", employment_type: "regular", must_change_password: false, features, default_shift_id: null }
}

function seed(bossId: string | null = E.boss.toUpperCase()) {
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: bossId ? { approval: { fallbackApproverEmpId: bossId } } : {} }]
  fake.db.employees = [
    row(E.boss, T.boss, "hr_admin"),
    row(E.hr, T.hr, "hr_admin", { wfhPunch: true }),
    row(E.grantedHr, T.grantedHr, "hr_admin", { seeGroupFinancials: true }),
    row(E.platform, T.platform, "platform_admin"),
    row(E.accountant, T.accountant, "accountant", { seeGroupFinancials: true }),
    row(E.staff, T.staff, "employee"),
    row(E.flaggedStaff, T.flaggedStaff, "employee", { seeGroupFinancials: true }),
  ]
  fake.db.departments = []
  fake.db.companies = []
}

const empUpdates = () => fake.writes.filter((w) => w.table === "employees" && w.action === "update")

beforeEach(() => {
  fake.reset()
  seed()
})

describe("canSeeGroupFinancials／canGrantGroupFinancials — 純函式", () => {
  it("老闆（大小寫不拘、不論角色）、platform_admin、授權 HR 看得到；未授權 HR、會計、一般員工看不到", () => {
    const boss = "AAAA-1"
    expect(canSeeGroupFinancials({ id: "aaaa-1", role: "employee" }, boss, null)).toBe(true)
    expect(canSeeGroupFinancials({ id: "x", role: "platform_admin" }, null, null)).toBe(true)
    expect(canSeeGroupFinancials({ id: "x", role: "hr_admin" }, boss, { seeGroupFinancials: true })).toBe(true)
    expect(canSeeGroupFinancials({ id: "x", role: "hr_admin" }, boss, { seeGroupFinancials: false })).toBe(false)
    expect(canSeeGroupFinancials({ id: "x", role: "hr_admin" }, null, null)).toBe(false)
    // 旗標只對 hr_admin 有效
    expect(canSeeGroupFinancials({ id: "x", role: "accountant" }, boss, { seeGroupFinancials: true })).toBe(false)
    expect(canSeeGroupFinancials({ id: "x", role: "employee" }, boss, { seeGroupFinancials: true })).toBe(false)
  })

  it("只有老闆與 platform_admin 能授權", () => {
    expect(canGrantGroupFinancials({ id: "aaaa-1", role: "employee" }, "AAAA-1")).toBe(true)
    expect(canGrantGroupFinancials({ id: "x", role: "platform_admin" }, null)).toBe(true)
    expect(canGrantGroupFinancials({ id: "x", role: "hr_admin" }, "AAAA-1")).toBe(false)
    expect(canGrantGroupFinancials({ id: "x", role: "hr_admin" }, null)).toBe(false)
  })

  it("normalize：seeGroupFinancials 只認 true", () => {
    expect(normalizeEmployeeFeatures({ seeGroupFinancials: true }).seeGroupFinancials).toBe(true)
    expect(normalizeEmployeeFeatures({ seeGroupFinancials: "true" }).seeGroupFinancials).toBe(false)
    expect(normalizeEmployeeFeatures(null).seeGroupFinancials).toBe(false)
  })

  it("loadGroupFinancialsAccess 讀老闆與本人旗標", async () => {
    expect(await loadGroupFinancialsAccess(TENANT_ID, { id: E.boss, role: "hr_admin" })).toMatchObject({ canSee: true, canGrant: true })
    expect(await loadGroupFinancialsAccess(TENANT_ID, { id: E.hr, role: "hr_admin" })).toMatchObject({ canSee: false, canGrant: false })
    expect(await loadGroupFinancialsAccess(TENANT_ID, { id: E.grantedHr, role: "hr_admin" })).toMatchObject({ canSee: true, canGrant: false })
    expect(await loadGroupFinancialsAccess(TENANT_ID, { id: E.platform, role: "platform_admin" })).toMatchObject({ canSee: true, canGrant: true })
    expect(await loadGroupFinancialsAccess(TENANT_ID, { id: E.accountant, role: "accountant" })).toMatchObject({ canSee: false, canGrant: false })
  })
})

describe("GET /me — canSeeGroupFinancials／canGrantGroupFinancials", () => {
  const me = async (token: string) => (await as(token)(request(app).get("/me"))).body
  it("各角色", async () => {
    expect(await me(T.boss)).toMatchObject({ canSeeGroupFinancials: true, canGrantGroupFinancials: true })
    expect(await me(T.platform)).toMatchObject({ canSeeGroupFinancials: true, canGrantGroupFinancials: true })
    expect(await me(T.grantedHr)).toMatchObject({ canSeeGroupFinancials: true, canGrantGroupFinancials: false })
    expect(await me(T.hr)).toMatchObject({ canSeeGroupFinancials: false, canGrantGroupFinancials: false })
    expect(await me(T.accountant)).toMatchObject({ canSeeGroupFinancials: false, canGrantGroupFinancials: false })
    expect(await me(T.flaggedStaff)).toMatchObject({ canSeeGroupFinancials: false, canGrantGroupFinancials: false })
  })
  it("沒設老闆：只有 platform_admin 與授權 HR", async () => {
    seed(null)
    expect(await me(T.boss)).toMatchObject({ canSeeGroupFinancials: false, canGrantGroupFinancials: false })
    expect(await me(T.grantedHr)).toMatchObject({ canSeeGroupFinancials: true })
    expect(await me(T.platform)).toMatchObject({ canSeeGroupFinancials: true, canGrantGroupFinancials: true })
  })
})

describe("PATCH /employees/:id — features.seeGroupFinancials 只有老闆／platform_admin 能改", () => {
  const patch = (token: string, id: string, body: unknown) => as(token)(request(app).patch(`/employees/${id}`)).send(body)

  it("老闆授權 HR → 200，合併寫入、保留其他鍵", async () => {
    const res = await patch(T.boss, E.hr, { features: { seeGroupFinancials: true } })
    expect(res.status).toBe(200)
    expect(empUpdates()[0]?.payload).toEqual({ features: { wfhPunch: true, seeGroupFinancials: true } })
  })

  it("platform_admin 取消授權 → 200", async () => {
    const res = await patch(T.platform, E.grantedHr, { features: { seeGroupFinancials: false } })
    expect(res.status).toBe(200)
    expect(empUpdates()[0]?.payload).toEqual({ features: { seeGroupFinancials: false } })
  })

  it("一般 HR 授權別人／自己、已授權 HR 再授權別人 → 403 group_financials_grant_forbidden，不寫入", async () => {
    for (const [token, id] of [[T.hr, E.grantedHr], [T.hr, E.hr], [T.grantedHr, E.hr]] as const) {
      const res = await patch(token, id, { features: { seeGroupFinancials: true } })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe("group_financials_grant_forbidden")
    }
    expect(empUpdates()).toHaveLength(0)
  })

  it("HR 改其他 features 鍵照舊 → 200", async () => {
    const res = await patch(T.hr, E.staff, { features: { wfhPunch: true } })
    expect(res.status).toBe(200)
  })

  it("沒設老闆：HR 也不能改 → 403", async () => {
    seed(null)
    const res = await patch(T.boss, E.hr, { features: { seeGroupFinancials: true } })
    expect(res.status).toBe(403)
  })

  it("型別錯 → 400", async () => {
    const res = await patch(T.boss, E.hr, { features: { seeGroupFinancials: "yes" } })
    expect(res.status).toBe(400)
  })
})
