import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB／GoTrue。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { runWithRequestContext } from "../lib/request-context.js"
import { actorRoleOf, effectiveRole, isActiveStatus, isInactiveActor } from "../lib/actor-status.js"
import { isBossOrPlatformAdmin } from "../lib/boss.js"
import { privilegeErrorHandler } from "../middleware/privilege-error.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { requireHrAdmin } from "../middleware/role.js"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { resolveSelf } from "../middleware/scope.js"
import { employeesRouter } from "../routes/employees.js"
import { lateReportsRouter } from "../routes/late-reports.js"
import { canChangeStatusOf } from "../services/privileged-accounts.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 2026-10-27 業主追加：
 *   A. 停用／離職帳號（status ≠ 'active'）的有效角色降成 employee：requireRole 系列、resolveSelf、老闆判斷都走同一個有效角色；
 *      不停用 auth 帳號（仍可登入看自己的 ESS）。
 *   E. 不能決定自己的遲到說明 → 403 own_late_report（老闆、platform_admin 也一樣）。
 *   G. 受保護帳號（老闆、老闆指定解鎖人、hr_admin、platform_admin）的在職狀態只有老闆或 platform_admin 能改。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
// 與 app.ts 相同：每個請求一份操作者情境（非在職標記放這裡）。
app.use((req: Request, _res: Response, next: NextFunction) => runWithRequestContext({ route: req.path }, next))
// A：一支只給 HR 的探針路由（requireHrAdmin），驗有效角色。
app.get("/probe/hr-only", requireAuth, requireTenant, requireHrAdmin, (_req: Request, res: Response) => {
  res.status(200).json({ ok: true })
})
app.get("/probe/self", requireAuth, requireTenant, async (req: Request, res: Response) => {
  const self = await resolveSelf(res.locals.tenantId as string, req.auth!.userId)
  res.status(200).json({ self, inactiveMarked: isInactiveActor(self?.id), bossCheck: isBossOrPlatformAdmin(BOSS, self) })
})
app.use(employeesRouter)
app.use(lateReportsRouter)
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

const BOSS = "c0000000-0000-4000-8000-000000000001" // 老闆（一般員工角色）
const DESIGNEE = "c0000000-0000-4000-8000-000000000002" // 老闆指定解鎖人
const HR = "c0000000-0000-4000-8000-000000000003"
const HR2 = "c0000000-0000-4000-8000-000000000004"
const EMP = "c0000000-0000-4000-8000-000000000005"
const PA = "c0000000-0000-4000-8000-000000000006"
const HR_OFF = "c0000000-0000-4000-8000-000000000007" // 已停用的 hr_admin
const PA_OFF = "c0000000-0000-4000-8000-000000000008" // 已停用的 platform_admin
const T = { boss: "u-boss", hr: "u-hr", hr2: "u-hr2", emp: "u-emp", pa: "u-pa", hrOff: "u-hr-off", paOff: "u-pa-off" } as const

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
  patch: (path: string) => request(server).patch(path).set("Authorization", `Bearer ${token}`),
})

const employee = (id: string, userId: string | null, role: string, name: string, status = "active"): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: null,
  status,
})

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, branding: {}, features: { approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } } }]
  fake.db.employees = [
    employee(BOSS, T.boss, "employee", "老闆"),
    employee(DESIGNEE, null, "employee", "財務長"),
    employee(HR, T.hr, "hr_admin", "人資甲"),
    employee(HR2, T.hr2, "hr_admin", "人資乙"),
    employee(EMP, T.emp, "employee", "員工"),
    employee(PA, T.pa, "platform_admin", "平台管理員"),
    employee(HR_OFF, T.hrOff, "hr_admin", "已離職人資", "inactive"),
    employee(PA_OFF, T.paOff, "platform_admin", "已離職平台管理員", "inactive"),
  ]
})

const rowOf = (id: string) => fake.db.employees.find((r) => r.id === id) as Row

describe("A. 非在職帳號的有效角色", () => {
  it("純函式：在職保留角色、非在職一律 employee；缺值視為在職", () => {
    expect(effectiveRole("hr_admin", "active")).toBe("hr_admin")
    expect(effectiveRole("hr_admin", "inactive")).toBe("employee")
    expect(effectiveRole("platform_admin", "terminated")).toBe("employee")
    expect(effectiveRole("manager", undefined)).toBe("manager")
    expect(isActiveStatus(null)).toBe(true)
    expect(isActiveStatus("inactive")).toBe(false)
    // 沒有請求情境時 actorRoleOf 只回有效角色、不留標記。
    expect(actorRoleOf(HR_OFF, "hr_admin", "inactive")).toBe("employee")
    expect(isInactiveActor(HR_OFF)).toBe(false)
  })

  it("requireHrAdmin：停用的 hr_admin／platform_admin → 403；在職的照舊 200", async () => {
    expect((await as(T.hrOff).get("/probe/hr-only")).status).toBe(403)
    expect((await as(T.paOff).get("/probe/hr-only")).status).toBe(403)
    expect((await as(T.hr).get("/probe/hr-only")).status).toBe(200)
    expect((await as(T.pa).get("/probe/hr-only")).status).toBe(200)
    expect((await as(T.emp).get("/probe/hr-only")).status).toBe(403)
  })

  it("resolveSelf：停用帳號回 role=employee、active=false，並在本請求標記；老闆判斷因此為 false", async () => {
    const off = await as(T.paOff).get("/probe/self")
    expect(off.body).toMatchObject({ self: { id: PA_OFF, role: "employee", active: false }, inactiveMarked: true, bossCheck: false })
    const on = await as(T.pa).get("/probe/self")
    expect(on.body).toMatchObject({ self: { id: PA, role: "platform_admin", active: true }, inactiveMarked: false, bossCheck: true })
  })

  it("老闆本人被停用 → 老闆判斷 false（呼叫端明確帶 active=false 或請求內標記都擋）；在職老闆照舊 true", async () => {
    rowOf(BOSS).status = "inactive"
    const off = await as(T.boss).get("/probe/self")
    expect(off.body.bossCheck).toBe(false)
    expect(isBossOrPlatformAdmin(BOSS, { id: BOSS, role: "employee", active: false })).toBe(false)
    expect(isBossOrPlatformAdmin(BOSS, { id: BOSS, role: "employee" })).toBe(true)
  })

  it("停用的 hr_admin 不能用 HR 端點改別人（PATCH /employees/:id → 403 forbidden）", async () => {
    const res = await as(T.hrOff).patch(`/employees/${EMP}`).send({ name: "改名" })
    expect(res.status).toBe(403)
    expect(rowOf(EMP).name).toBe("員工")
  })
})

describe("G. 受保護帳號的在職狀態只有老闆或 platform_admin 能改", () => {
  it("純函式：判準同改角色——受保護帳號要老闆／platform_admin（本人除外），一般員工 HR 可改", () => {
    const policy = { bossEmpId: BOSS, designatedEmpIds: [DESIGNEE] }
    expect(canChangeStatusOf({ id: HR, role: "hr_admin" }, { id: HR2, role: "hr_admin" }, policy)).toBe(false)
    expect(canChangeStatusOf({ id: HR, role: "hr_admin" }, { id: EMP, role: "employee" }, policy)).toBe(true)
    expect(canChangeStatusOf({ id: BOSS, role: "employee" }, { id: HR2, role: "hr_admin" }, policy)).toBe(true)
    expect(canChangeStatusOf({ id: PA, role: "platform_admin" }, { id: BOSS, role: "employee" }, policy)).toBe(true)
    expect(canChangeStatusOf({ id: PA, role: "platform_admin", active: false }, { id: HR2, role: "hr_admin" }, policy)).toBe(false)
  })

  it.each([
    ["另一位 hr_admin", HR2],
    ["platform_admin", PA],
    ["老闆", BOSS],
    ["老闆指定的解鎖人", DESIGNEE],
  ])("HR 停用%s：PATCH status 與 POST deactivate 都 403 not_boss、狀態不變", async (_label, target) => {
    const patch = await as(T.hr).patch(`/employees/${target}`).send({ status: "inactive" })
    expect([patch.status, patch.body.error]).toEqual([403, "not_boss"])
    const deact = await as(T.hr).post(`/employees/${target}/deactivate`).send({})
    expect([deact.status, deact.body.error]).toEqual([403, "not_boss"])
    expect(rowOf(target).status).toBe("active")
  })

  it("HR 停用一般員工照舊可以（PATCH 與 deactivate）", async () => {
    const res = await as(T.hr).post(`/employees/${EMP}/deactivate`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rowOf(EMP).status).toBe("inactive")
    const back = await as(T.hr).patch(`/employees/${EMP}`).send({ status: "active" })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(rowOf(EMP).status).toBe("active")
  })

  it("platform_admin 可以停用／復職 hr_admin；HR 也不能把停用的 hr_admin 復職", async () => {
    const off = await as(T.pa).post(`/employees/${HR2}/deactivate`).send({})
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(rowOf(HR2).status).toBe("inactive")
    const hrRevive = await as(T.hr).patch(`/employees/${HR2}`).send({ status: "active" })
    expect([hrRevive.status, hrRevive.body.error]).toEqual([403, "not_boss"])
    const paRevive = await as(T.pa).patch(`/employees/${HR2}`).send({ status: "active" })
    expect(paRevive.status, JSON.stringify(paRevive.body)).toBe(200)
    expect(rowOf(HR2).status).toBe("active")
  })

  it("status 沒變（員工頁每次儲存都帶 status）→ 照常放行", async () => {
    const res = await as(T.hr).patch(`/employees/${HR2}`).send({ status: "active", name: "人資乙改名" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(rowOf(HR2).name).toBe("人資乙改名")
  })
})

describe("E. 不能決定自己的遲到說明", () => {
  const LR_OWN = "d0000000-0000-4000-8000-000000000001"
  const LR_EMP = "d0000000-0000-4000-8000-000000000002"
  const late = (id: string, employeeId: string): Row => ({
    id,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    work_date: "2027-03-10",
    punch_record_id: null,
    punch_at: "2027-03-10T02:30:00Z",
    late_minutes: 30,
    reason: "捷運故障",
    attendance_decision: null,
    decided_by_emp_id: null,
    decided_at: null,
    decision_note: null,
    created_at: "2027-03-10T03:00:00Z",
    updated_at: "2027-03-10T03:00:00Z",
  })

  beforeEach(() => {
    fake.db.late_reports = [late(LR_OWN, PA), late(LR_EMP, EMP)]
    fake.db.attendance_sheets = []
    fake.db.period_closes = []
  })

  it("platform_admin 決定自己的 → 403 own_late_report、不寫入；決定別人的照舊 200", async () => {
    const own = await as(T.pa).post(`/late-reports/${LR_OWN}/decision`).send({ decision: "exempt" })
    expect([own.status, own.body.error]).toEqual([403, "own_late_report"])
    expect(fake.db.late_reports?.[0]?.attendance_decision).toBeNull()
    const other = await as(T.pa).post(`/late-reports/${LR_EMP}/decision`).send({ decision: "exempt" })
    expect(other.status, JSON.stringify(other.body)).toBe(200)
    expect(fake.db.late_reports?.[1]?.attendance_decision).toBe("exempt")
  })

  it("老闆決定自己的也 403；老闆決定員工的照舊；HR 仍 403 not_boss", async () => {
    fake.db.late_reports = [late(LR_OWN, BOSS), late(LR_EMP, EMP)]
    const own = await as(T.boss).post(`/late-reports/${LR_OWN}/decision`).send({ decision: "affects" })
    expect([own.status, own.body.error]).toEqual([403, "own_late_report"])
    const ok = await as(T.boss).post(`/late-reports/${LR_EMP}/decision`).send({ decision: "affects" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const hr = await as(T.hr).post(`/late-reports/${LR_EMP}/decision`).send({ decision: "exempt" })
    expect([hr.status, hr.body.error]).toEqual([403, "not_boss"])
  })

  it("停用的 platform_admin 不能決定任何人的遲到說明（403 not_boss）", async () => {
    const res = await as(T.paOff).post(`/late-reports/${LR_EMP}/decision`).send({ decision: "exempt" })
    expect([res.status, res.body.error]).toEqual([403, "not_boss"])
  })
})
