import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts）；auth.admin 用 spy 換掉，不連任何 DB／GoTrue。
const adminAuth = vi.hoisted(() => ({
  generateLink: vi.fn(),
  updateUserById: vi.fn(),
  deleteUser: vi.fn(),
}))
vi.mock("../lib/supabase.js", async () => {
  const base = (await import("./helpers/fake-supabase.js")).fakeSupabaseModule()
  return { ...base, supabaseAdmin: { ...base.supabaseAdmin, auth: { admin: adminAuth } } }
})

import { bulkInviteFromCsv } from "../services/auth-invite.js"
import { runImport } from "../services/imports/run.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 批次建立帳號（bulkInviteFromCsv，POST /employees/bulk-invite 與 POST /imports/employees 共用）的權限邊界
 * （2026-10-11 業主拍板；services/privileged-accounts.ts）：
 *   • CSV 任何一列的角色欄是 platform_admin → 只有 platform_admin 能指派，否則整份拒絕（PrivilegeError，403
 *     `platform_admin_required`），一列都不處理、不建任何 auth 帳號；
 *   • 綁到既有的**未綁帳號**列，而那一列是受保護帳號（老闆、老闆指定的解鎖人、hr_admin、platform_admin）→
 *     只有老闆或 platform_admin 能綁，否則該列 skipped（`not_boss: …`），其餘列照常——不然 HR 填自己的 Email
 *     就能認領「尚未開通的老闆列」；
 *   • 一般員工的列照舊。
 * ⚠️ 識別碼、名稱、Email 都是明顯的假值（repo 是公開的）。
 */

const BOSS = "b0000000-0000-4000-8000-000000000001" // hr_admin，已開通，是老闆
const HR = "b0000000-0000-4000-8000-000000000003"
const PA = "b0000000-0000-4000-8000-000000000006"
const FREE_EMP = "c0000000-0000-4000-8000-000000000001" // 一般員工，尚未開通
const FREE_HR = "c0000000-0000-4000-8000-000000000002" // hr_admin，尚未開通
const FREE_PA = "c0000000-0000-4000-8000-000000000003" // platform_admin，尚未開通
const FREE_DESIGNEE = "c0000000-0000-4000-8000-000000000004" // 一般員工，尚未開通，是老闆指定的解鎖人
const FREE_BOSS = "c0000000-0000-4000-8000-000000000005" // 一般員工，尚未開通，是老闆（features 指向他）

const employee = (id: string, userId: string | null, role: string, name: string, empNo: string | null): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: empNo,
  dept_id: null,
  hire_date: null,
  status: "active",
})

function seed(features: Record<string, unknown> = { approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [FREE_DESIGNEE] } }) {
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", branding: {}, features }]
  fake.db.departments = []
  fake.db.employees = [
    employee(BOSS, "au-boss", "hr_admin", "老闆", "B001"),
    employee(HR, "au-hr", "hr_admin", "人資甲", "H001"),
    employee(PA, "au-pa", "platform_admin", "平台管理員", "P001"),
    employee(FREE_EMP, null, "employee", "待開通員工", "E100"),
    employee(FREE_HR, null, "hr_admin", "待開通人資", "H100"),
    employee(FREE_PA, null, "platform_admin", "待開通平台管理員", "P100"),
    employee(FREE_DESIGNEE, null, "employee", "待開通財務長", "F100"),
    employee(FREE_BOSS, null, "employee", "待開通老闆", "B100"),
  ]
}

const HEADER = "name,email,empNo,role"
const csvOf = (...rows: string[]) => [HEADER, ...rows].join("\n")
const rowOf = (id: string) => fake.db.employees.find((r) => r.id === id) as Row
const bulk = (csv: string, actorEmpId: string | null) =>
  bulkInviteFromCsv({ tenantId: TENANT_ID, csv, dryRun: true, actorEmpId, context: "test" })

let seq = 0
beforeEach(() => {
  seq = 0
  fake.reset()
  seed()
  // 沒有任何既有 auth 帳號：每一列都走 invite（建新帳號）。
  fake.rpcHandlers.auth_user_by_email = async () => ({ data: null, error: null })
  adminAuth.generateLink.mockReset().mockImplementation(async (arg: { email: string }) => {
    seq += 1
    return { data: { user: { id: `au-new-${seq}`, email: arg.email, app_metadata: {} }, properties: { hashed_token: `tok-${seq}` } }, error: null }
  })
  adminAuth.updateUserById.mockReset().mockImplementation(async (id: string, attrs: { app_metadata?: Record<string, unknown> }) => ({
    data: { user: { id, app_metadata: attrs.app_metadata ?? {} } },
    error: null,
  }))
  adminAuth.deleteUser.mockReset().mockResolvedValue({ data: null, error: null })
})

describe("CSV 角色欄是 platform_admin", () => {
  it("HR 帶了 platform_admin 的列 → 整份拒絕（PrivilegeError），一列都不處理：沒建 auth 帳號、沒寫 employees", async () => {
    const csv = csvOf("一般新人,new1@example.com,,employee", "想當平台管理員,new2@example.com,,platform_admin")
    const err = await bulk(csv, HR).catch((e) => e)
    expect(err).toMatchObject({ name: "PrivilegeError", code: "platform_admin_required", httpStatus: 403 })
    expect(adminAuth.generateLink).not.toHaveBeenCalled()
    expect(fake.writes).toHaveLength(0)
    expect(fake.db.employees).toHaveLength(8) // 沒多出新的列
  })

  it("換大小寫、前後空白（Platform_Admin）也擋；老闆（不是 platform_admin）也擋；查不到操作者也擋", async () => {
    for (const actor of [HR, BOSS, null]) {
      const err = await bulk(csvOf("x,odd@example.com,, Platform_Admin "), actor).catch((e) => e)
      expect(err).toMatchObject({ code: "platform_admin_required" })
    }
    expect(adminAuth.generateLink).not.toHaveBeenCalled()
  })

  it("platform_admin 可以：新建的列角色就是 platform_admin", async () => {
    const summary = await bulk(csvOf("新平台管理員,pa-new@example.com,,platform_admin"), PA)
    expect(summary).toMatchObject({ created: 1, skipped: 0 })
    const created = fake.db.employees.find((r) => r.name === "新平台管理員") as Row
    expect(created).toMatchObject({ role: "platform_admin", user_id: "au-new-1" })
  })

  it("HR 建立 hr_admin／會計／沒帶角色 → 照舊（只擋 platform_admin）", async () => {
    const summary = await bulk(csvOf("新人資,hr-new@example.com,,hr_admin", "新會計,acc-new@example.com,,accountant", "新同仁,emp-new@example.com,,"), HR)
    expect(summary).toMatchObject({ created: 3, skipped: 0 })
    const roles = ["新人資", "新會計", "新同仁"].map((n) => (fake.db.employees.find((r) => r.name === n) as Row).role)
    expect(roles).toEqual(["hr_admin", "accountant", "employee"])
  })
})

describe("綁到既有的未綁帳號列", () => {
  it("HR 綁一般員工 → 照舊 bound，user_id 被填上", async () => {
    const summary = await bulk(csvOf("待開通員工,free@example.com,E100,"), HR)
    expect(summary).toMatchObject({ bound: 1, skipped: 0 })
    expect(rowOf(FREE_EMP).user_id).toBe("au-new-1")
  })

  it("HR 綁尚未開通的 hr_admin／platform_admin／老闆指定的解鎖人／老闆本人 → 各自 skipped（not_boss），沒建 auth 帳號、列仍未綁", async () => {
    seed({ approval: { fallbackApproverEmpId: FREE_BOSS }, payroll: { periodUnlockEmpIds: [FREE_DESIGNEE] } })
    const csv = csvOf(
      "待開通人資,mine1@example.com,H100,",
      "待開通平台管理員,mine2@example.com,P100,",
      "待開通財務長,mine3@example.com,F100,",
      "待開通老闆,mine4@example.com,B100,",
    )
    const summary = await bulk(csv, HR)
    expect(summary.skipped).toBe(4)
    expect(summary.bound + summary.created).toBe(0)
    expect(summary.errors.map((e) => e.error.split(":")[0])).toEqual(["not_boss", "not_boss", "not_boss", "not_boss"])
    expect(summary.errors[0].error).toContain("老闆")
    expect(adminAuth.generateLink).not.toHaveBeenCalled()
    for (const id of [FREE_HR, FREE_PA, FREE_DESIGNEE, FREE_BOSS]) expect(rowOf(id).user_id).toBeNull()
  })

  it("混在同一份 CSV：被擋的列 skipped，一般員工的列照常處理", async () => {
    const summary = await bulk(csvOf("待開通人資,mine1@example.com,H100,", "待開通員工,free@example.com,E100,"), HR)
    expect(summary).toMatchObject({ bound: 1, skipped: 1 })
    expect(rowOf(FREE_HR).user_id).toBeNull()
    expect(rowOf(FREE_EMP).user_id).not.toBeNull()
    expect(adminAuth.generateLink).toHaveBeenCalledTimes(1) // 只替一般員工那列產 token
  })

  it("老闆可以綁 hr_admin／解鎖人；platform_admin 可以綁任何人", async () => {
    const byBoss = await bulk(csvOf("待開通人資,hr-ok@example.com,H100,", "待開通財務長,fin-ok@example.com,F100,"), BOSS)
    expect(byBoss).toMatchObject({ bound: 2, skipped: 0 })
    const byPa = await bulk(csvOf("待開通平台管理員,pa-ok@example.com,P100,"), PA)
    expect(byPa).toMatchObject({ bound: 1, skipped: 0 })
  })

  it("查不到操作者（系統呼叫、沒帶 actorEmpId）：一般員工照綁，受保護的列一律擋", async () => {
    const summary = await bulk(csvOf("待開通員工,free@example.com,E100,", "待開通人資,mine1@example.com,H100,"), null)
    expect(summary).toMatchObject({ bound: 1, skipped: 1 })
    expect(rowOf(FREE_HR).user_id).toBeNull()
  })
})

describe("POST /imports/employees 的 dryRun 預判（只驗證，不建帳號）也講同一句", () => {
  const importRow = (line: number, name: string, email: string, empNo: string) => ({
    line,
    values: { name, email, empNo, deptName: "", employmentType: "", hireDate: "", role: "" },
  })

  it("HR：綁到未開通的 hr_admin 那列 → 預判就報 not_boss；一般員工那列 OK；全程沒產生 token", async () => {
    const res = await runImport(
      "employees",
      TENANT_ID,
      [importRow(2, "待開通人資", "mine@example.com", "H100"), importRow(3, "待開通員工", "free@example.com", "E100")],
      { dryRun: true, actorEmpId: HR },
    )
    expect(res.valid).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatchObject({ line: 2 })
    expect(res.errors[0].message).toMatch(/^not_boss:/)
    expect(adminAuth.generateLink).not.toHaveBeenCalled()
  })

  it("老闆：同一份檔案兩列都通過", async () => {
    const res = await runImport(
      "employees",
      TENANT_ID,
      [importRow(2, "待開通人資", "mine@example.com", "H100"), importRow(3, "待開通員工", "free@example.com", "E100")],
      { dryRun: true, actorEmpId: BOSS },
    )
    expect(res.valid).toBe(2)
    expect(res.errors).toHaveLength(0)
  })
})
