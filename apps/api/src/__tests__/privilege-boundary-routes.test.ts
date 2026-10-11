import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts）；auth.admin 另外用 spy 換掉，不連任何 DB／GoTrue。
const adminAuth = vi.hoisted(() => ({
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
}))
vi.mock("../lib/supabase.js", async () => {
  const base = (await import("./helpers/fake-supabase.js")).fakeSupabaseModule()
  return { ...base, supabaseAdmin: { ...base.supabaseAdmin, auth: { admin: adminAuth } } }
})

// 寄信／發連結的服務層換成 spy：這裡只驗「該不該放行」，不驗信件內容（那是 auth-accounts-live 的事）。
const accountLink = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock("../services/auth-invite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/auth-invite.js")>()),
  sendEmployeeAccountLink: accountLink.send,
}))

import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { privilegeErrorHandler } from "../middleware/privilege-error.js"
import { authAccountsRouter } from "../routes/auth-accounts.js"
import { employeesRouter } from "../routes/employees.js"
import { tenantRouter } from "../routes/tenant.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 特權帳號的權限邊界（2026-10-11 業主拍板；services/privileged-accounts.ts）——HR 繞過發薪解鎖的三條路：
 *   ① 換老闆設定（PUT /api/tenant/settings）：有老闆時只有老闆本人（可交棒）或 platform_admin；沒老闆時 HR 可做第一次設定
 *   ② 指派 platform_admin 角色（POST /employees、PATCH /employees/:id）：只有 platform_admin；只擋「變成」
 *   ③ 重設／接管受保護帳號（老闆、老闆指定的解鎖人、hr_admin、platform_admin）的密碼或連結：只有老闆或 platform_admin
 * HR 重設一般員工照舊；HR 對自己不受影響。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(tenantRouter)
app.use(authAccountsRouter)
app.use(employeesRouter)
app.use(periodClosedErrorHandler)
app.use(privilegeErrorHandler)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const BOSS = "b0000000-0000-4000-8000-000000000001" // hr_admin，同時是老闆
const DESIGNEE = "b0000000-0000-4000-8000-000000000002" // 一般員工，老闆指定可以重新開放月份
const HR = "b0000000-0000-4000-8000-000000000003" // 一般 HR（不是老闆）
const HR2 = "b0000000-0000-4000-8000-000000000004" // 另一位 HR
const EMP = "b0000000-0000-4000-8000-000000000005" // 一般員工
const PA = "b0000000-0000-4000-8000-000000000006" // platform_admin
const PA2 = "b0000000-0000-4000-8000-000000000007" // 另一位 platform_admin
const NOACCT_HR = "b0000000-0000-4000-8000-000000000008" // hr_admin，尚未綁帳號
const T = { boss: "u-boss", designee: "u-designee", hr: "u-hr", hr2: "u-hr2", emp: "u-emp", pa: "u-pa", pa2: "u-pa2" } as const

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  put: (path: string) => request(server).put(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(server).patch(path).set("Authorization", `Bearer ${token}`),
})

const employee = (id: string, userId: string | null, role: string, name: string): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: null,
  status: "active",
})

function seed(features: Record<string, unknown> = { approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } }) {
  fake.db.tenants = [{ id: TENANT_ID, branding: {}, features }]
  fake.db.employees = [
    employee(BOSS, T.boss, "hr_admin", "老闆"),
    employee(DESIGNEE, T.designee, "employee", "財務長"),
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(HR2, T.hr2, "hr_admin", "人資乙"),
    employee(EMP, T.emp, "employee", "員工"),
    employee(PA, T.pa, "platform_admin", "平台管理員"),
    employee(PA2, T.pa2, "platform_admin", "平台管理員二"),
    employee(NOACCT_HR, null, "hr_admin", "未開通人資"),
  ]
}

const tenantFeatures = () => (fake.db.tenants[0]?.features ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const bossNow = () => tenantFeatures().approval?.fallbackApproverEmpId ?? null
const rowOf = (id: string) => fake.db.employees.find((r) => r.id === id) as Row
const tenantWrites = () => fake.writes.filter((w) => w.table === "tenants")
const employeeWrites = () => fake.writes.filter((w) => w.table === "employees")

beforeEach(() => {
  fake.reset()
  seed()
  accountLink.send.mockReset().mockResolvedValue({ sent: false, dryRun: true, type: "recovery", email: "x@example.com", action: "existing", link: "https://example.test/link" })
  adminAuth.createUser.mockReset().mockResolvedValue({ data: { user: { id: "new-user-1" } }, error: null })
  adminAuth.deleteUser.mockReset().mockResolvedValue({ data: null, error: null })
  adminAuth.getUserById.mockReset().mockImplementation(async (userId: string) => ({
    data: { user: { id: userId, email: `${userId}@example.com`, app_metadata: { tenant_id: TENANT_ID } } },
    error: null,
  }))
  adminAuth.updateUserById.mockReset().mockResolvedValue({ data: { user: {} }, error: null })
})

describe("① PUT /api/tenant/settings — 換老闆設定", () => {
  it("HR（不是老闆）換老闆 → 403 not_boss，老闆沒變、tenants 沒被寫", async () => {
    const res = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: HR } } })
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error).toBe("not_boss")
    expect(res.body.message).toContain("老闆")
    expect(bossNow()).toBe(BOSS)
    expect(tenantWrites()).toHaveLength(0)
  })

  it("HR 清除老闆（null）→ 403 not_boss；老闆沒變", async () => {
    const res = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: null } } })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("not_boss")
    expect(bossNow()).toBe(BOSS)
    expect(tenantWrites()).toHaveLength(0)
  })

  it("看有效值而不是看請求帶了什麼鍵：換成大寫的同一個老闆 id、或 approval: {} 都不算更換 → 200，老闆仍在", async () => {
    const same = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: BOSS.toUpperCase() } } })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect(bossNow()).toBe(BOSS) // 存的是小寫
    const empty = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: {} } })
    expect(empty.status).toBe(200)
    expect(bossNow()).toBe(BOSS) // 巢狀合併：approval: {} 不會把老闆洗成空
    expect(employeeWrites()).toHaveLength(0)
  })

  it("HR 帶其他設定（沒碰老闆）照常 200，老闆與解鎖名單原封不動", async () => {
    const res = await as(T.hr).put("/api/tenant/settings").send({ features: { adminModules: { payroll: true } }, branding: { appName: "測試公司" } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(bossNow()).toBe(BOSS)
    expect(tenantFeatures().payroll.periodUnlockEmpIds).toEqual([DESIGNEE])
    expect(tenantFeatures().adminModules).toEqual({ payroll: true })
  })

  it("老闆本人可以交棒給別人 → 200，寫 audit（誰、換成誰）；交棒後原老闆就不能再改回來", async () => {
    const res = await as(T.boss).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: HR } } })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.features.approval.fallbackApproverEmpId).toBe(HR)
    expect(bossNow()).toBe(HR)
    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "tenants" && String(a.context).includes("老闆"))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actor_emp_id: BOSS,
      old_row: { approval: { fallbackApproverEmpId: BOSS } },
      new_row: { approval: { fallbackApproverEmpId: HR } },
    })
    expect(String(audits[0].context)).toContain("更換老闆")

    const back = await as(T.boss).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: BOSS } } })
    expect(back.status).toBe(403)
    expect(back.body.error).toBe("not_boss")
    expect(bossNow()).toBe(HR)
  })

  it("老闆本人可以清除老闆設定 → 200；清除後 HR 是『沒有老闆』的初始狀態，可以做第一次設定", async () => {
    const clear = await as(T.boss).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: null } } })
    expect(clear.status, JSON.stringify(clear.body)).toBe(200)
    expect(bossNow()).toBeNull()

    const bootstrap = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: HR } } })
    expect(bootstrap.status, JSON.stringify(bootstrap.body)).toBe(200)
    expect(bossNow()).toBe(HR)
    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "tenants" && String(a.context).includes("老闆"))
    expect(audits.map((a) => a.context).join("|")).toContain("首次設定老闆")
  })

  it("platform_admin 可以換、可以清除（不必是老闆）", async () => {
    const swap = await as(T.pa).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: HR2 } } })
    expect(swap.status, JSON.stringify(swap.body)).toBe(200)
    expect(bossNow()).toBe(HR2)
    const clear = await as(T.pa).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: null } } })
    expect(clear.status).toBe(200)
    expect(bossNow()).toBeNull()
  })

  it("新老闆必須是本租戶員工：不存在或別租戶的 id → 400 invalid_employee（初始設定與交棒都一樣），設定不變", async () => {
    const ghost = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    const handOver = await as(T.boss).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: ghost } } })
    expect(handOver.status).toBe(400)
    expect(handOver.body).toMatchObject({ error: "invalid_employee", employeeIds: [ghost] })
    expect(bossNow()).toBe(BOSS)

    seed({}) // 沒有老闆
    const bootstrap = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: ghost } } })
    expect(bootstrap.status).toBe(400)
    expect(bossNow()).toBeNull()

    fake.db.employees.push({ ...employee("e0000000-0000-4000-8000-0000000000aa", "u-other", "employee", "別租戶"), tenant_id: "99999999-9999-4999-8999-999999999999" })
    const otherTenant = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: "e0000000-0000-4000-8000-0000000000aa" } } })
    expect(otherTenant.status).toBe(400)
  })

  it("沒有老闆時 HR 做第一次設定 → 200；設定之後 HR 自己（不是那位老闆）就不能再換了", async () => {
    seed({})
    const first = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: BOSS } } })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(bossNow()).toBe(BOSS)
    const again = await as(T.hr).put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: HR } } })
    expect(again.status).toBe(403)
    expect(bossNow()).toBe(BOSS)
  })

  it("同一個請求一邊換老闆一邊改解鎖名單：HR 先被老闆檢查擋下（403），兩邊都沒動", async () => {
    const res = await as(T.hr)
      .put("/api/tenant/settings")
      .send({ features: { approval: { fallbackApproverEmpId: HR }, payroll: { periodUnlockEmpIds: [HR] } } })
    expect(res.status).toBe(403)
    expect(bossNow()).toBe(BOSS)
    expect(tenantFeatures().payroll.periodUnlockEmpIds).toEqual([DESIGNEE])
    expect(tenantWrites()).toHaveLength(0)
  })

  it("沒有員工列的登入者（查不到呼叫者）過不了 requireHrAdmin → 403 forbidden，老闆沒動", async () => {
    const res = await as("u-ghost").put("/api/tenant/settings").send({ features: { approval: { fallbackApproverEmpId: HR } } })
    expect(res.status).toBe(403)
    expect(bossNow()).toBe(BOSS)
  })
})

describe("② POST /employees — 指派 platform_admin 角色", () => {
  const body = (role: string) => ({ email: "new@example.com", name: "新同仁", password: "Passw0rd-xyz", role })

  it("HR 建立 platform_admin → 403 platform_admin_required；沒建 auth 帳號、沒寫 employees", async () => {
    const res = await as(T.hr).post("/employees").send(body("platform_admin"))
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error).toBe("platform_admin_required")
    expect(res.body.message).toContain("平台管理員")
    expect(adminAuth.createUser).not.toHaveBeenCalled()
    expect(employeeWrites()).toHaveLength(0)
  })

  it("換大小寫、前後空白也擋（Platform_Admin）；老闆（非 platform_admin）也不行", async () => {
    const odd = await as(T.hr).post("/employees").send(body(" Platform_Admin "))
    expect(odd.status).toBe(403)
    const boss = await as(T.boss).post("/employees").send(body("platform_admin"))
    expect(boss.status).toBe(403)
    expect(adminAuth.createUser).not.toHaveBeenCalled()
  })

  it("platform_admin 可以建立 platform_admin → 201", async () => {
    const res = await as(T.pa).post("/employees").send(body("platform_admin"))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(adminAuth.createUser).toHaveBeenCalledTimes(1)
    expect(employeeWrites().some((w) => (w.payload as Row).role === "platform_admin")).toBe(true)
  })

  it("HR 建立 hr_admin／會計／一般員工（沒帶 role）照舊 201（這條只管 platform_admin）", async () => {
    for (const role of ["hr_admin", "accountant", "manager"]) {
      const res = await as(T.hr).post("/employees").send(body(role))
      expect(res.status, `${role}: ${JSON.stringify(res.body)}`).toBe(201)
    }
    const noRole = await as(T.hr).post("/employees").send({ email: "n2@example.com", name: "再一位", password: "Passw0rd-xyz" })
    expect(noRole.status).toBe(201)
    const created = employeeWrites().map((w) => (w.payload as Row).role)
    expect(created).toEqual(["hr_admin", "accountant", "manager", "employee"])
  })
})

describe("② PATCH /employees/:id — 把角色變成 platform_admin", () => {
  it("HR 把別人升成 platform_admin → 403；角色沒變", async () => {
    const res = await as(T.hr).patch(`/employees/${EMP}`).send({ role: "platform_admin" })
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error).toBe("platform_admin_required")
    expect(rowOf(EMP).role).toBe("employee")
    expect(employeeWrites()).toHaveLength(0)
  })

  it("HR 把自己升成 platform_admin → 403（HR 不能升自己）；老闆也不行", async () => {
    const self = await as(T.hr).patch(`/employees/${HR}`).send({ role: "platform_admin" })
    expect(self.status).toBe(403)
    expect(rowOf(HR).role).toBe("hr_admin")
    const boss = await as(T.boss).patch(`/employees/${BOSS}`).send({ role: "platform_admin", name: "老闆" })
    expect(boss.status).toBe(403)
    expect(rowOf(BOSS).role).toBe("hr_admin")
  })

  it("platform_admin 可以把人升成 platform_admin → 200", async () => {
    const res = await as(T.pa).patch(`/employees/${EMP}`).send({ role: "platform_admin" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rowOf(EMP).role).toBe("platform_admin")
  })

  it("目標本來就是 platform_admin：HR 帶著原值存檔（改姓名）照常 200——只擋『變成』", async () => {
    const res = await as(T.hr).patch(`/employees/${PA}`).send({ role: "platform_admin", name: "改個名字" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rowOf(PA)).toMatchObject({ role: "platform_admin", name: "改個名字" })
  })

  it("HR 改角色成 hr_admin／會計／主管、或根本沒帶 role → 照舊 200；不存在的 id → 404", async () => {
    // hr_admin 放最後：升成 hr_admin 之後那個人就是受保護帳號，HR 不能再改他的角色（見下面『變更受保護帳號的角色』）。
    for (const role of ["accountant", "manager", "employee", "hr_admin"]) {
      const res = await as(T.hr).patch(`/employees/${EMP}`).send({ role })
      expect(res.status, role).toBe(200)
      expect(rowOf(EMP).role).toBe(role)
    }
    const noRole = await as(T.hr).patch(`/employees/${EMP}`).send({ name: "只改名" })
    expect(noRole.status).toBe(200)
    const missing = await as(T.hr).patch("/employees/ffffffff-ffff-4fff-8fff-ffffffffffff").send({ role: "platform_admin" })
    expect(missing.status).toBe(404)
  })
})

describe("③ POST /employees/:id/reset-password — 重設受保護帳號的密碼", () => {
  const updated = () => adminAuth.updateUserById.mock.calls.map((c) => c[0] as string)

  it("HR 重設一般員工 → 200（照舊），回一組暫時密碼、must_change_password 設 true", async () => {
    const res = await as(T.hr).post(`/employees/${EMP}/reset-password`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(typeof res.body.password).toBe("string")
    expect(updated()).toEqual([T.emp])
    expect(rowOf(EMP).must_change_password).toBe(true)
  })

  it("HR 重設老闆（即使老闆的角色是 employee）→ 403 not_boss；沒動 auth、沒寫任何東西", async () => {
    fake.db.employees = fake.db.employees.map((r) => (r.id === BOSS ? { ...r, role: "employee" } : r))
    const res = await as(T.hr).post(`/employees/${BOSS}/reset-password`).send({ password: "Another-Pass-123" })
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error).toBe("not_boss")
    expect(res.body.message).toContain("密碼")
    expect(adminAuth.getUserById).not.toHaveBeenCalled()
    expect(adminAuth.updateUserById).not.toHaveBeenCalled()
    expect(fake.writes).toHaveLength(0)
  })

  it("HR 重設其他 hr_admin、platform_admin、老闆指定的解鎖人（雖然是一般員工）→ 全部 403", async () => {
    for (const target of [HR2, PA, DESIGNEE, BOSS]) {
      const res = await as(T.hr).post(`/employees/${target}/reset-password`).send({})
      expect(res.status, target).toBe(403)
      expect(res.body.error, target).toBe("not_boss")
    }
    expect(adminAuth.updateUserById).not.toHaveBeenCalled()
  })

  it("403 優先於 409 no_account：受保護帳號沒綁登入帳號時，HR 也得不到『有這列但沒帳號』以外的資訊", async () => {
    const res = await as(T.hr).post(`/employees/${NOACCT_HR}/reset-password`).send({})
    expect(res.status).toBe(403)
    // 老闆自己動這一列才會走到 409 no_account
    const byBoss = await as(T.boss).post(`/employees/${NOACCT_HR}/reset-password`).send({})
    expect(byBoss.status).toBe(409)
    expect(byBoss.body.error).toBe("no_account")
  })

  it("HR 對自己不受影響（自己的帳號不是接管）→ 200", async () => {
    const res = await as(T.hr).post(`/employees/${HR}/reset-password`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(updated()).toEqual([T.hr])
  })

  it("老闆可以重設 HR、解鎖人、platform_admin；platform_admin 可以重設老闆、其他 platform_admin、HR", async () => {
    for (const target of [HR, DESIGNEE, PA]) {
      const res = await as(T.boss).post(`/employees/${target}/reset-password`).send({})
      expect(res.status, `boss→${target}`).toBe(200)
    }
    for (const target of [BOSS, PA2, HR]) {
      const res = await as(T.pa).post(`/employees/${target}/reset-password`).send({})
      expect(res.status, `pa→${target}`).toBe(200)
    }
  })

  it("沒設老闆時：HR 一樣動不了其他 hr_admin／platform_admin（沒有老闆可代表）；platform_admin 可以", async () => {
    seed({})
    const hr = await as(T.hr).post(`/employees/${HR2}/reset-password`).send({})
    expect(hr.status).toBe(403)
    const pa = await as(T.pa).post(`/employees/${HR2}/reset-password`).send({})
    expect(pa.status).toBe(200)
  })

  it("不存在的員工 → 404；一般員工變成解鎖人之後 HR 就動不了他（名單是老闆指定的，HR 改不了）", async () => {
    const missing = await as(T.hr).post("/employees/ffffffff-ffff-4fff-8fff-ffffffffffff/reset-password").send({})
    expect(missing.status).toBe(404)
    seed({ approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE, EMP] } })
    const res = await as(T.hr).post(`/employees/${EMP}/reset-password`).send({})
    expect(res.status).toBe(403)
  })
})

describe("③ POST /employees/:id/send-reset 與 /invite — 發重設／邀請連結（dryRun 會把連結回給 HR，等於能設新密碼）", () => {
  it("HR 對一般員工 → 照舊放行（服務層被呼叫）", async () => {
    const reset = await as(T.hr).post(`/employees/${EMP}/send-reset`).send({ dryRun: true })
    expect(reset.status, JSON.stringify(reset.body)).toBe(200)
    const invite = await as(T.hr).post(`/employees/${EMP}/invite`).send({ dryRun: true })
    expect(invite.status).toBe(200)
    expect(accountLink.send).toHaveBeenCalledTimes(2)
  })

  it("HR 對老闆、其他 hr_admin、platform_admin、解鎖人 → 403 not_boss，服務層一次都沒被呼叫（不產生連結）", async () => {
    for (const target of [BOSS, HR2, PA, DESIGNEE, NOACCT_HR]) {
      const reset = await as(T.hr).post(`/employees/${target}/send-reset`).send({ dryRun: true })
      expect(reset.status, `send-reset ${target}`).toBe(403)
      expect(reset.body.error).toBe("not_boss")
      const invite = await as(T.hr).post(`/employees/${target}/invite`).send({ dryRun: true, email: "mine@example.com" })
      expect(invite.status, `invite ${target}`).toBe(403)
      expect(invite.body.error).toBe("not_boss")
    }
    expect(accountLink.send).not.toHaveBeenCalled()
  })

  it("HR 對自己、老闆對 HR、platform_admin 對老闆 → 放行", async () => {
    expect((await as(T.hr).post(`/employees/${HR}/send-reset`).send({ dryRun: true })).status).toBe(200)
    expect((await as(T.boss).post(`/employees/${HR2}/send-reset`).send({ dryRun: true })).status).toBe(200)
    expect((await as(T.boss).post(`/employees/${NOACCT_HR}/invite`).send({ dryRun: true, email: "hr@example.com" })).status).toBe(200)
    expect((await as(T.pa).post(`/employees/${BOSS}/send-reset`).send({ dryRun: true })).status).toBe(200)
    expect(accountLink.send).toHaveBeenCalledTimes(4)
  })

  it("不存在的員工 → 404（先於權限檢查，不洩漏哪些 id 是受保護帳號）", async () => {
    const res = await as(T.hr).post("/employees/ffffffff-ffff-4fff-8fff-ffffffffffff/send-reset").send({ dryRun: true })
    expect(res.status).toBe(404)
  })
})

describe("② PATCH /employees/:id — 變更受保護帳號的角色（含降級）只有老闆或 platform_admin", () => {
  it("HR 把另一位 HR 降成一般員工 → 403 not_boss，角色沒變；接著重設他的密碼也被擋（降級→重設→升回的繞過走不通）", async () => {
    const res = await as(T.hr).patch(`/employees/${HR2}`).send({ role: "employee" })
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error).toBe("not_boss")
    expect(res.body.message).toContain("角色")
    expect(rowOf(HR2).role).toBe("hr_admin")
    expect(employeeWrites()).toHaveLength(0)
    expect((await as(T.hr).post(`/employees/${HR2}/reset-password`).send({})).status).toBe(403)
  })

  it("HR 降 platform_admin、降老闆（角色是 hr_admin 的那位）、降解鎖人 → 全部 403", async () => {
    seed({ approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } })
    fake.db.employees = fake.db.employees.map((r) => (r.id === DESIGNEE ? { ...r, role: "manager" } : r))
    for (const [target, role] of [[PA, "hr_admin"], [BOSS, "employee"], [DESIGNEE, "employee"]] as const) {
      const res = await as(T.hr).patch(`/employees/${target}`).send({ role })
      expect(res.status, `${target}→${role}`).toBe(403)
      expect(res.body.error).toBe("not_boss")
    }
    expect(rowOf(PA).role).toBe("platform_admin")
    expect(rowOf(BOSS).role).toBe("hr_admin")
  })

  it("角色沒變就不受影響：HR 編輯另一位 HR 的姓名並帶原 role → 200（員工管理頁每次儲存都帶 role）", async () => {
    const res = await as(T.hr).patch(`/employees/${HR2}`).send({ role: "hr_admin", name: "改名" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rowOf(HR2)).toMatchObject({ role: "hr_admin", name: "改名" })
  })

  it("老闆與 platform_admin 可以降級；HR 可以降自己；HR 把一般員工升成 hr_admin 照舊", async () => {
    expect((await as(T.boss).patch(`/employees/${HR2}`).send({ role: "employee" })).status).toBe(200)
    expect((await as(T.pa).patch(`/employees/${HR}`).send({ role: "manager" })).status).toBe(200)
    expect((await as(T.pa).patch(`/employees/${HR}`).send({ role: "hr_admin" })).status).toBe(200)
    expect((await as(T.hr).patch(`/employees/${HR}`).send({ role: "employee" })).status).toBe(200) // 本人
    expect((await as(T.boss).patch(`/employees/${EMP}`).send({ role: "hr_admin" })).status).toBe(200)
  })

  it("角色字串寫入前統一成標準寫法：帶 Platform_Admin 存給原本就是 platform_admin 的人，不會讓他默默失去權限", async () => {
    const res = await as(T.hr).patch(`/employees/${PA}`).send({ role: " Platform_Admin ", name: "仍是平台管理員" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rowOf(PA).role).toBe("platform_admin")
    const asHr = await as(T.hr).patch(`/employees/${EMP}`).send({ role: "HR_ADMIN" })
    expect(asHr.status).toBe(200)
    expect(rowOf(EMP).role).toBe("hr_admin")
    const promote = await as(T.hr).patch(`/employees/${EMP}`).send({ role: "PLATFORM_ADMIN" })
    expect(promote.status).toBe(403)
    expect(promote.body.error).toBe("platform_admin_required")
  })
})

describe("② POST /employees — 角色標準寫法與平台操作員白名單 email", () => {
  it("建立時角色統一成標準寫法（HR 建 Hr_Admin → 存成 hr_admin）", async () => {
    const res = await as(T.hr).post("/employees").send({ email: "canon@example.com", name: "新同仁", password: "Passw0rd-xyz", role: "Hr_Admin" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(employeeWrites().some((w) => (w.payload as Row).role === "hr_admin")).toBe(true)
  })

  it("PLATFORM_ADMIN_EMAILS 白名單的 email 不能拿來建員工帳號（409 email_in_other_tenant），沒建 auth 帳號、沒寫 employees", async () => {
    const saved = process.env.PLATFORM_ADMIN_EMAILS
    process.env.PLATFORM_ADMIN_EMAILS = "operator@example.com"
    try {
      const res = await as(T.hr).post("/employees").send({ email: "Operator@Example.com", name: "冒牌", password: "Passw0rd-xyz" })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("email_in_other_tenant")
      expect(adminAuth.createUser).not.toHaveBeenCalled()
      expect(employeeWrites()).toHaveLength(0)
    } finally {
      if (saved === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
      else process.env.PLATFORM_ADMIN_EMAILS = saved
    }
  })
})

describe("② 非標準寫法的既有列（Platform_Admin）——帶原值存檔不能變成真的 platform_admin", () => {
  it("目前存的是 Platform_Admin（沒有權限）：HR 帶原值或標準寫法存檔 → 403 platform_admin_required，角色不變；platform_admin 可以", async () => {
    fake.db.employees = fake.db.employees.map((r) => (r.id === EMP ? { ...r, role: "Platform_Admin" } : r))
    for (const role of ["Platform_Admin", "platform_admin"]) {
      const res = await as(T.hr).patch(`/employees/${EMP}`).send({ role, name: "只想改名" })
      expect(res.status, role).toBe(403)
      expect(res.body.error).toBe("platform_admin_required")
    }
    expect(rowOf(EMP).role).toBe("Platform_Admin")
    expect(rowOf(EMP).name).not.toBe("只想改名")
    const byPa = await as(T.pa).patch(`/employees/${EMP}`).send({ role: "Platform_Admin" })
    expect(byPa.status).toBe(200)
    expect(rowOf(EMP).role).toBe("platform_admin")
  })
})

describe("③ 邀請信——受保護帳號、還沒綁登入帳號：收件信箱要明確輸入（HR 改得動 My Data 的信箱）", () => {
  const lastCall = () => accountLink.send.mock.calls.at(-1)?.[0] as { requireExplicitEmail?: boolean; email?: string } | undefined

  it("受保護的未開通列（hr_admin）：老闆邀請時路由要求明確信箱（requireExplicitEmail=true）；一般員工不要求", async () => {
    const protectedInvite = await as(T.boss).post(`/employees/${NOACCT_HR}/invite`).send({ dryRun: true, email: "chosen@example.com" })
    expect(protectedInvite.status, JSON.stringify(protectedInvite.body)).toBe(200)
    expect(lastCall()).toMatchObject({ requireExplicitEmail: true, email: "chosen@example.com" })

    accountLink.send.mockClear()
    const ordinary = await as(T.hr).post(`/employees/${EMP}/invite`).send({ dryRun: true })
    expect(ordinary.status).toBe(200)
    expect(lastCall()?.requireExplicitEmail).toBe(false)
  })

  it("老闆指定的解鎖人也算受保護（沒帶信箱時同樣要求明確輸入）", async () => {
    fake.db.employees = fake.db.employees.map((r) => (r.id === DESIGNEE ? { ...r, user_id: null } : r))
    const res = await as(T.boss).post(`/employees/${DESIGNEE}/invite`).send({ dryRun: true })
    expect(res.status).toBe(200)
    expect(lastCall()?.requireExplicitEmail).toBe(true)
  })
})
