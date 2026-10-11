import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { periodClosedErrorHandler } from "../middleware/period-closed.js"
import { payrollPeriodsRouter } from "../routes/payroll-periods.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 發薪鎖定的月結流程（routes/payroll-periods.ts ＋ services/backup-snapshot.ts closePeriod／reopenPeriod）：
 *   • GET  /payroll-periods                  每個月的狀態（開放中／已結算／已重新開放）＋ canClose／canReopen
 *   • GET  /payroll-periods/:period/checklist  HR 看檢查清單
 *   • POST /payroll-periods/:period/close      四項全過才能鎖；沒有強制略過
 *   • POST /payroll-periods/:period/reopen     只有老闆與老闆指定的人（HR 不行）；理由至少 5 字
 * 重新開放：locked 月表回 approved、finalized 薪資單回 draft、period_closes 記誰／何時／為何、寫 audit、通知老闆與 HR；
 * 之後要再鎖必須重新過一次檢查清單。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(payrollPeriodsRouter)
app.use(periodClosedErrorHandler)
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
afterEach(() => {
  vi.useRealTimers()
})

const PERIOD = "2026-09"
const BOSS = "b0000000-0000-4000-8000-000000000001"
const DESIGNEE = "b0000000-0000-4000-8000-000000000002"
const HR = "b0000000-0000-4000-8000-000000000003"
const HR2 = "b0000000-0000-4000-8000-000000000004"
const EMP1 = "b0000000-0000-4000-8000-000000000005"
const EMP2 = "b0000000-0000-4000-8000-000000000006"
const TOKENS = { boss: "u-boss", designee: "u-designee", hr: "u-hr", hr2: "u-hr2", emp1: "u-emp1", emp2: "u-emp2", ghost: "u-ghost" } as const

const as = (token: string) => ({
  get: (path: string) => request(server).get(path).set("Authorization", `Bearer ${token}`),
  post: (path: string) => request(server).post(path).set("Authorization", `Bearer ${token}`),
})

const employee = (id: string, userId: string, role: string, name: string): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: null,
  status: "active",
  hire_date: "2026-01-05",
  terminated_at: null,
})

/** 九月該有的都有：每位在職員工一張月表（approved 或 locked）、有薪資結構的兩人薪資單已定稿、沒有未核銷假單或報銷。 */
function seedClosable() {
  fake.db.employees = [
    employee(BOSS, TOKENS.boss, "employee", "老闆"),
    employee(DESIGNEE, TOKENS.designee, "employee", "財務長"),
    employee(HR, TOKENS.hr, "hr_admin", "人資甲"),
    employee(HR2, TOKENS.hr2, "hr_admin", "人資乙"),
    employee(EMP1, TOKENS.emp1, "employee", "員工一"),
    employee(EMP2, TOKENS.emp2, "employee", "員工二"),
  ]
  const ids = [BOSS, DESIGNEE, HR, HR2, EMP1, EMP2]
  fake.db.attendance_sheets = ids.map((employeeId, i) => ({
    id: `sheet-${i + 1}`,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    period: PERIOD,
    status: i % 2 === 0 ? "approved" : "locked",
    version: 3,
    locked_at: i % 2 === 0 ? null : "2026-10-01T00:00:00.000Z",
    snapshot: { frozen: true },
  }))
  fake.db.salary_structures = [EMP1, EMP2].map((employeeId, i) => ({ id: `sal-${i}`, tenant_id: TENANT_ID, employee_id: employeeId }))
  fake.db.payslips = [EMP1, EMP2].map((employeeId, i) => ({
    id: `slip-${i + 1}`,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    period: PERIOD,
    status: "finalized",
  }))
  fake.db.leave_requests = []
  fake.db.expense_claims = []
}

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-11T10:00:00+08:00"))
  fake.db.tenants = [
    {
      id: TENANT_ID,
      timezone: "Asia/Taipei",
      features: { approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } },
    },
  ]
  seedClosable()
})

const closes = () => (fake.db.period_closes ?? []).filter((r) => r.tenant_id === TENANT_ID)
const closeRowOf = (period = PERIOD) => closes().find((r) => r.period === period) as Row
const sheetStatuses = () => fake.db.attendance_sheets.map((s) => s.status)
const slipStatuses = () => fake.db.payslips.map((s) => s.status)
const noticesTo = (employeeId: string) => (fake.db.notifications ?? []).filter((n) => n.employee_id === employeeId)

describe("POST /payroll-periods/:period/close — 完成本月發薪並鎖定", () => {
  it("四項全過 → 200，approved 月表轉 locked、寫 period_closes（closed、誰、何時、張數）、寫 audit", async () => {
    const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ period: PERIOD, status: "closed", closedByEmpId: HR, sheetCount: 6, lockedCount: 6, lockedNow: 3 })
    expect(typeof res.body.closedAt).toBe("string")

    expect(sheetStatuses()).toEqual(Array(6).fill("locked"))
    expect(closes()).toHaveLength(1)
    expect(closeRowOf()).toMatchObject({ status: "closed", closed_by_emp_id: HR, sheet_count: 6, locked_count: 6, snapshot_manifest_path: null })
    const audits = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "period_closes")
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: "INSERT", actor_emp_id: HR })
    // 鎖定月表會通知員工（沿用 lockSheet）；已經是 locked 的不重複通知。
    expect((fake.db.notifications ?? []).filter((n) => n.type === "attendance_sheet")).toHaveLength(3)
  })

  it("檢查清單沒過 → 409 checklist_incomplete 附整份清單（誰、哪張），什麼都不鎖、不寫 period_closes；沒有任何強制略過", async () => {
    fake.db.attendance_sheets[2] = { ...fake.db.attendance_sheets[2], status: "submitted" }
    fake.db.payslips[0] = { ...fake.db.payslips[0], status: "draft" }
    fake.db.leave_requests = [
      { id: "lv1", tenant_id: TENANT_ID, employee_id: EMP1, kind: "leave", status: "approved", deleted_at: null, leave_type_id: null, hours: 8, start_at: new Date("2026-09-10T09:00:00+08:00").toISOString(), end_at: new Date("2026-09-10T18:00:00+08:00").toISOString(), settled_at: null },
    ]
    fake.db.expense_claims = [{ id: "cl1", tenant_id: TENANT_ID, employee_id: EMP2, period: PERIOD, status: "submitted", amount: 500 }]

    const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`).send({ force: true })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("checklist_incomplete")
    expect(res.body.period).toBe(PERIOD)
    expect(res.body.checklist.ready).toBe(false)
    expect(res.body.checklist.items.map((i: { key: string; passed: boolean }) => [i.key, i.passed])).toEqual([
      ["sheets", false],
      ["leave_settlement", false],
      ["expense_settlement", false],
      ["payslips", false],
    ])
    expect(res.body.checklist.items[0].pending[0]).toMatchObject({ employeeId: HR, status: "submitted" })
    expect(res.body.checklist.items[3].pending[0]).toMatchObject({ employeeId: EMP1, status: "draft" })
    // 一張都沒鎖、沒有月結紀錄。
    expect(sheetStatuses()).toEqual(["approved", "locked", "submitted", "locked", "approved", "locked"])
    expect(closes()).toHaveLength(0)
  })

  it("四項裡任何一項沒過都擋：逐項各改壞一次", async () => {
    const breakers: Array<[string, () => void]> = [
      ["sheets", () => (fake.db.attendance_sheets[0] = { ...fake.db.attendance_sheets[0], status: "draft" })],
      ["leave_settlement", () => (fake.db.leave_requests = [{ id: "lv", tenant_id: TENANT_ID, employee_id: EMP1, kind: "leave", status: "approved", deleted_at: null, leave_type_id: null, hours: 8, start_at: new Date("2026-09-10T09:00:00+08:00").toISOString(), end_at: new Date("2026-09-10T18:00:00+08:00").toISOString(), settled_at: null }])],
      ["expense_settlement", () => (fake.db.expense_claims = [{ id: "cl", tenant_id: TENANT_ID, employee_id: EMP1, period: PERIOD, status: "submitted", amount: 1 }])],
      ["payslips", () => (fake.db.payslips = [])],
    ]
    for (const [key, breakIt] of breakers) {
      seedClosable()
      breakIt()
      const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
      expect(res.status, key).toBe(409)
      expect(res.body.error, key).toBe("checklist_incomplete")
      const failed = res.body.checklist.items.filter((i: { passed: boolean }) => !i.passed).map((i: { key: string }) => i.key)
      expect(failed, key).toEqual([key])
      expect(closes(), key).toHaveLength(0)
    }
  })

  it("已經鎖過 → 409 already_closed，不覆蓋第一次鎖定的人與時間", async () => {
    expect((await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)).status).toBe(200)
    const first = { ...closeRowOf() }
    const again = await as(TOKENS.hr2).post(`/payroll-periods/${PERIOD}/close`)
    expect(again.status).toBe(409)
    expect(again.body).toEqual({ error: "already_closed", period: PERIOD })
    expect(closeRowOf().closed_by_emp_id).toBe(first.closed_by_emp_id)
    expect(closeRowOf().closed_at).toBe(first.closed_at)
  })

  it("兩個人同時第一次鎖：後到的撞唯一鍵 → 409 already_closed", async () => {
    fake.injectError({ table: "period_closes", action: "insert", error: { message: "duplicate key", code: "23505" } })
    const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "already_closed", period: PERIOD })
  })

  it("鎖月表的途中有新的寫入（主管核准了一張 9 月假單、還沒核銷）→ 事後複查不通過：409 checklist_incomplete、不寫已結算；處理完再按一次就鎖得起來", async () => {
    // 在鎖第一張月表的瞬間（attendance_sheets 的第一個 UPDATE）塞進一張已核准、未核銷的 9 月假單，模擬空窗內的寫入。
    const original = fake.from.bind(fake)
    let injected = false
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const builder = original(table)
      if (table === "attendance_sheets" && !injected) {
        const realUpdate = builder.update.bind(builder)
        builder.update = (value: Row) => {
          if (!injected) {
            injected = true
            fake.db.leave_requests = [
              ...(fake.db.leave_requests ?? []),
              { id: "late-approved", tenant_id: TENANT_ID, employee_id: EMP1, kind: "leave", status: "approved", deleted_at: null, leave_type_id: null, hours: 8, start_at: new Date("2026-09-12T09:00:00+08:00").toISOString(), end_at: new Date("2026-09-12T18:00:00+08:00").toISOString(), settled_at: null },
            ]
          }
          return realUpdate(value)
        }
      }
      return builder
    })
    const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
    spy.mockRestore()
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toBe("checklist_incomplete")
    const leave = res.body.checklist.items.find((i: { key: string }) => i.key === "leave_settlement")
    expect(leave).toMatchObject({ passed: false, done: 0, total: 1 })
    expect(leave.pending[0].refId).toBe("late-approved")
    expect(closes()).toHaveLength(0) // 沒有寫下已結算
    // HR 把假單核銷後再按一次：已鎖的月表冪等、其餘補鎖，成功。
    fake.db.leave_requests = fake.db.leave_requests.map((l) => ({ ...l, settled_at: "2026-10-11T00:00:00Z" }))
    const again = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(sheetStatuses()).toEqual(Array(6).fill("locked"))
    expect(closeRowOf().status).toBe("closed")
  })

  it("只有 HR 能鎖：員工、老闆（不是 HR 角色）、查無員工列的帳號都 403；期別格式不對 400", async () => {
    for (const token of [TOKENS.emp1, TOKENS.boss, TOKENS.designee, TOKENS.ghost]) {
      expect((await as(token).post(`/payroll-periods/${PERIOD}/close`)).status, token).toBe(403)
    }
    expect(closes()).toHaveLength(0)
    expect((await as(TOKENS.hr).post("/payroll-periods/2026-13/close")).status).toBe(400)
    expect((await as(TOKENS.hr).post("/payroll-periods/202609/close")).body).toEqual({ error: "invalid_period" })
  })

  it("表還沒遷移（period_closes 不存在）→ 503 period_closes_not_migrated，不留半套", async () => {
    fake.injectError({ table: "period_closes", action: "select", error: { message: "no table", code: "PGRST205" } })
    const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
    expect(res.status).toBe(503)
    expect(res.body.error).toBe("period_closes_not_migrated")
    expect(sheetStatuses()).toEqual(["approved", "locked", "approved", "locked", "approved", "locked"])
  })
})

describe("POST /payroll-periods/:period/reopen — 重新開放", () => {
  async function closeIt() {
    const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  }

  it("老闆（角色只是 employee，權限來自 features.approval.fallbackApproverEmpId）→ 200：月表回 approved、薪資單回 draft、記誰／何時／理由", async () => {
    await closeIt()
    expect(sheetStatuses()).toEqual(Array(6).fill("locked"))
    expect(slipStatuses()).toEqual(["finalized", "finalized"])

    const res = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "  老闆要補一筆漏算的加班費  " })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({
      period: PERIOD,
      status: "reopened",
      reopenedByEmpId: BOSS,
      reopenReason: "老闆要補一筆漏算的加班費",
      unlockedSheets: 6,
      revertedPayslips: 2,
    })
    expect(sheetStatuses()).toEqual(Array(6).fill("approved"))
    expect(fake.db.attendance_sheets.every((s) => s.locked_at === null)).toBe(true)
    // 核准當時凍結的 snapshot 不動。
    expect(fake.db.attendance_sheets.every((s) => (s.snapshot as { frozen?: boolean })?.frozen === true)).toBe(true)
    expect(slipStatuses()).toEqual(["draft", "draft"])
    expect(closeRowOf()).toMatchObject({
      status: "reopened",
      reopened_by_emp_id: BOSS,
      reopen_reason: "老闆要補一筆漏算的加班費",
      closed_by_emp_id: HR,
    })
    expect(typeof closeRowOf().reopened_at).toBe("string")
  })

  it("老闆指定的人（角色 employee）也可以；寫 audit、通知老闆與所有 HR（內文含誰、哪個月、理由）", async () => {
    await closeIt()
    const res = await as(TOKENS.designee).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "會計說有一筆代墊款要更正" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.reopenedByEmpId).toBe(DESIGNEE)

    const audit = (fake.db.audit_logs ?? []).filter((a) => a.table_name === "period_closes" && a.action === "UPDATE")
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_emp_id: DESIGNEE })
    expect(String(audit[0].context)).toContain("重新開放 2026-09")
    expect(audit[0].new_row).toMatchObject({ status: "reopened", reopen_reason: "會計說有一筆代墊款要更正", unlockedSheets: 6, revertedPayslips: 2 })

    const recipients = (fake.db.notifications ?? []).filter((n) => n.type === "payroll_period").map((n) => n.employee_id).sort()
    expect(recipients).toEqual([BOSS, HR, HR2].sort())
    const notice = noticesTo(BOSS).find((n) => n.type === "payroll_period") as Row
    expect(notice.title).toBe("2026-09 月結已重新開放")
    expect(notice.body).toBe("財務長 重新開放了 2026-09，理由：會計說有一筆代墊款要更正")
    expect(res.body.notified).toBe(3)
  })

  it("HR（沒被指定）不行：403 unlock_forbidden，月表、薪資單、月結紀錄都沒動", async () => {
    await closeIt()
    const res = await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "我是 HR 但我想解鎖" })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("unlock_forbidden")
    expect(sheetStatuses()).toEqual(Array(6).fill("locked"))
    expect(slipStatuses()).toEqual(["finalized", "finalized"])
    expect(closeRowOf().status).toBe("closed")
    expect((fake.db.notifications ?? []).filter((n) => n.type === "payroll_period")).toHaveLength(0)
  })

  it("一般員工、查無員工列的帳號：403；老闆沒設定且名單空 → 連 HR 都解不了（fail closed）", async () => {
    await closeIt()
    for (const token of [TOKENS.emp1, TOKENS.ghost]) {
      expect((await as(token).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "我也想解鎖看看" })).status, token).toBe(403)
    }
    fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: {} }]
    expect((await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "沒有老闆也沒有名單" })).status).toBe(403)
    expect(closeRowOf().status).toBe("closed")
  })

  it("理由太短（trim 後少於 5 個字）→ 400，什麼都不動；剛好 5 個字可以；太長 400", async () => {
    await closeIt()
    for (const reason of ["", "   ", "1234", "  1234  ", "改一下"]) {
      const res = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason })
      expect(res.status, JSON.stringify(reason)).toBe(400)
      expect(res.body.error).toBe("reason_too_short")
    }
    expect((await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({})).status).toBe(400)
    expect((await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "長".repeat(501) })).body.error).toBe("reason_too_long")
    expect(closeRowOf().status).toBe("closed")
    expect(sheetStatuses()).toEqual(Array(6).fill("locked"))
    const ok = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "剛好五個字" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("理由長度以『字』計：3 個 emoji 是 3 個字（不是 6 個）→ 400；5 個 emoji 才夠", async () => {
    await closeIt()
    const short = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "😀😀😀" })
    expect(short.status).toBe(400)
    expect(short.body.error).toBe("reason_too_short")
    expect(closeRowOf().status).toBe("closed")
    const ok = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "😀😀😀😀😀" })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it("解鎖途中失敗（月表與薪資單都回復了，翻 reopened 那一步出錯）→ 仍是 closed、重打補完（這次沒東西可回復，只翻狀態）", async () => {
    await closeIt()
    fake.injectError({ table: "period_closes", action: "update", error: { message: "boom", code: "XX000" } })
    const failed = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "翻狀態那一步出錯" })
    expect(failed.status).toBe(500)
    expect(closeRowOf().status).toBe("closed")
    expect(sheetStatuses()).toEqual(Array(6).fill("approved"))
    expect(slipStatuses()).toEqual(["draft", "draft"])
    const retry = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "重打補完它" })
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
    expect(retry.body).toMatchObject({ status: "reopened", unlockedSheets: 0, revertedPayslips: 0 })
    expect(closeRowOf().status).toBe("reopened")
  })

  it("沒鎖過的月份 → 404 period_not_closed；已經重新開放過 → 409 already_reopened（不重複解鎖、不重複通知）；期別格式不對 400", async () => {
    expect((await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "還沒鎖就想解" })).status).toBe(404)
    await closeIt()
    expect((await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "第一次重新開放" })).status).toBe(200)
    const noticesAfterFirst = (fake.db.notifications ?? []).filter((n) => n.type === "payroll_period").length
    const second = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "第二次重新開放" })
    expect(second.status).toBe(409)
    expect(second.body).toEqual({ error: "already_reopened", period: PERIOD })
    expect((fake.db.notifications ?? []).filter((n) => n.type === "payroll_period")).toHaveLength(noticesAfterFirst)
    expect((await as(TOKENS.boss).post("/payroll-periods/2026-00/reopen").send({ reason: "格式不對的期別" })).status).toBe(400)
  })

  it("重新開放後必須再過一次檢查清單才能再鎖：薪資單回 draft 所以第一次再鎖被擋；重新定稿後才鎖得起來，誰鎖的更新、解鎖紀錄保留", async () => {
    await closeIt()
    expect((await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "重算薪資單" })).status).toBe(200)

    const blocked = await as(TOKENS.hr2).post(`/payroll-periods/${PERIOD}/close`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error).toBe("checklist_incomplete")
    expect(blocked.body.checklist.items.map((i: { key: string; passed: boolean }) => [i.key, i.passed])).toEqual([
      ["sheets", true],
      ["leave_settlement", true],
      ["expense_settlement", true],
      ["payslips", false],
    ])
    expect(closeRowOf().status).toBe("reopened")

    // HR 重新試算、定稿（這裡直接改資料代表）。
    fake.db.payslips = fake.db.payslips.map((s) => ({ ...s, status: "finalized" }))
    const again = await as(TOKENS.hr2).post(`/payroll-periods/${PERIOD}/close`)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body).toMatchObject({ status: "closed", closedByEmpId: HR2, lockedNow: 6 })
    expect(sheetStatuses()).toEqual(Array(6).fill("locked"))
    expect(closeRowOf()).toMatchObject({ status: "closed", closed_by_emp_id: HR2, reopened_by_emp_id: BOSS, reopen_reason: "重算薪資單" })
    expect(closes()).toHaveLength(1)
  })

  it("兩個人同時重新開放：後到的條件式更新沒命中 → 409 already_reopened", async () => {
    await closeIt()
    // 先到的那位已經把狀態翻成 reopened（模擬在後到者讀完資料、寫入之前）。
    const original = fake.from.bind(fake)
    let flipped = false
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const builder = original(table)
      if (table === "period_closes" && !flipped) {
        const realUpdate = builder.update.bind(builder)
        builder.update = (value: Row) => {
          flipped = true
          fake.db.period_closes = (fake.db.period_closes ?? []).map((r) => ({ ...r, status: "reopened" }))
          return realUpdate(value)
        }
      }
      return builder
    })
    const res = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "同時按下的第二個人" })
    spy.mockRestore()
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("already_reopened")
  })

  it("解鎖途中失敗（月表更新時資料庫出錯）→ 月份仍是 closed，重打一次可以補完；不會卡在半開", async () => {
    await closeIt()
    // 狀態翻成 reopened 放在最後一步：前面解鎖月表／回復薪資單失敗時，月份還是 closed（寫入照擋），重打即可。
    fake.injectError({ table: "attendance_sheets", action: "update", error: { message: "boom", code: "XX000" } })
    const failed = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "第一次遇到資料庫錯誤" })
    expect(failed.status).toBe(500)
    expect(closeRowOf().status).toBe("closed")
    const retry = await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "再試一次補完它" })
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
    expect(sheetStatuses()).toEqual(Array(6).fill("approved"))
    expect(slipStatuses()).toEqual(["draft", "draft"])
    expect(closeRowOf().status).toBe("reopened")
  })
})

describe("GET /payroll-periods — 每個月的狀態", () => {
  it("HR：最近 12 個月（新的在前、含當月 2026-10），沒有紀錄的是開放中；canClose=true、canReopen=false", async () => {
    const res = await as(TOKENS.hr).get("/payroll-periods")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.currentPeriod).toBe("2026-10")
    expect(res.body.canClose).toBe(true)
    expect(res.body.canReopen).toBe(false)
    expect(res.body.periods).toHaveLength(12)
    expect(res.body.periods[0]).toMatchObject({ period: "2026-10", status: "open", closedAt: null })
    expect(res.body.periods[11].period).toBe("2025-11")
    expect(res.body.periods.every((p: { status: string }) => p.status === "open")).toBe(true)
  })

  it("鎖定後顯示已結算（誰、何時）；重新開放後顯示已重新開放（誰、何時、理由）；?months= 可調", async () => {
    expect((await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)).status).toBe(200)
    let list = (await as(TOKENS.hr).get("/payroll-periods?months=3")).body
    expect(list.periods.map((p: { period: string }) => p.period)).toEqual(["2026-10", "2026-09", "2026-08"])
    expect(list.periods[1]).toMatchObject({ period: PERIOD, status: "closed", closedByEmpId: HR, closedByName: "人資甲", sheetCount: 6, lockedCount: 6, reopenedAt: null })

    expect((await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "補一筆漏算的獎金" })).status).toBe(200)
    list = (await as(TOKENS.hr).get("/payroll-periods?months=3")).body
    expect(list.periods[1]).toMatchObject({
      status: "reopened",
      closedByName: "人資甲",
      reopenedByEmpId: BOSS,
      reopenedByName: "老闆",
      reopenReason: "補一筆漏算的獎金",
    })
    expect(typeof list.periods[1].reopenedAt).toBe("string")

    expect((await as(TOKENS.hr).get("/payroll-periods?months=0")).status).toBe(400)
    expect((await as(TOKENS.hr).get("/payroll-periods?months=99")).status).toBe(400)
  })

  it("老闆與老闆指定的人（不是 HR）看得到、canReopen=true、canClose=false；一般員工與查無員工列 403；別的租戶的月結不會混進來", async () => {
    fake.db.period_closes = [{ id: "x", tenant_id: OTHER_TENANT_ID, period: PERIOD, status: "closed", closed_at: "2026-10-01T00:00:00Z", closed_by_emp_id: null, sheet_count: 1, locked_count: 1, snapshot_manifest_path: null, note: null, reopened_at: null, reopened_by_emp_id: null, reopen_reason: null, created_at: "", updated_at: "" }]
    for (const token of [TOKENS.boss, TOKENS.designee]) {
      const res = await as(token).get("/payroll-periods")
      expect(res.status, token).toBe(200)
      expect(res.body).toMatchObject({ canClose: false, canReopen: true })
      expect(res.body.periods.find((p: { period: string }) => p.period === PERIOD).status).toBe("open")
    }
    expect((await as(TOKENS.emp1).get("/payroll-periods")).status).toBe(403)
    expect((await as(TOKENS.ghost).get("/payroll-periods")).status).toBe(403)
    expect((await request(server).get("/payroll-periods")).status).toBe(401)
  })
})

describe("GET /payroll-periods/:period/checklist", () => {
  it("HR 看得到四項各自的完成數／應完成數；狀態一併回；老闆（不是 HR）與員工 403", async () => {
    const res = await as(TOKENS.hr).get(`/payroll-periods/${PERIOD}/checklist`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.status).toBe("open")
    expect(res.body.checklist.ready).toBe(true)
    expect(res.body.checklist.items.map((i: { key: string; done: number; total: number }) => [i.key, i.done, i.total])).toEqual([
      ["sheets", 6, 6],
      ["leave_settlement", 0, 0],
      ["expense_settlement", 0, 0],
      ["payslips", 2, 2],
    ])
    expect((await as(TOKENS.boss).get(`/payroll-periods/${PERIOD}/checklist`)).status).toBe(403)
    expect((await as(TOKENS.emp1).get(`/payroll-periods/${PERIOD}/checklist`)).status).toBe(403)
    expect((await as(TOKENS.hr).get("/payroll-periods/2026-13/checklist")).status).toBe(400)
  })

  it("已鎖的月份狀態是 closed、重新開放後是 reopened", async () => {
    await as(TOKENS.hr).post(`/payroll-periods/${PERIOD}/close`)
    expect((await as(TOKENS.hr).get(`/payroll-periods/${PERIOD}/checklist`)).body.status).toBe("closed")
    await as(TOKENS.boss).post(`/payroll-periods/${PERIOD}/reopen`).send({ reason: "確認狀態會變化" })
    expect((await as(TOKENS.hr).get(`/payroll-periods/${PERIOD}/checklist`)).body.status).toBe("reopened")
  })
})
