import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換記憶體版；bulkInviteFromCsv 與補簽服務換成假的，只驗「匯入後補簽」的接線。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

const invite = vi.hoisted(() => ({ created: 1, bound: 0, add: [] as string[] }))
const seedSpy = vi.hoisted(() => vi.fn(async () => 2))

vi.mock("../services/hire-acknowledgements.js", () => ({ seedHireAcknowledgements: seedSpy }))
vi.mock("../services/auth-invite.js", async (orig) => {
  const actual = await orig<typeof import("../services/auth-invite.js")>()
  return {
    ...actual,
    bulkInviteFromCsv: vi.fn(async () => {
      const { fake, TENANT_ID } = await import("./helpers/fake-supabase.js")
      for (const id of invite.add) fake.db.employees.push({ id, tenant_id: TENANT_ID, name: "新人", status: "active" })
      return { created: invite.created, bound: invite.bound, skipped: 0, errors: [], rows: [] }
    }),
  }
})

import { runImport } from "../services/imports/run.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

const rows = [{ line: 4, values: { name: "新人", email: "new@example.com", empNo: "", deptName: "", employmentType: "", hireDate: "", role: "" } }]

describe("POST /imports/employees 建帳號後補新人公告待簽", () => {
  beforeEach(() => {
    fake.reset()
    seedSpy.mockClear()
    fake.db.employees = [{ id: "old-1", tenant_id: TENANT_ID, name: "舊員工", status: "active" }]
    fake.db.departments = []
    invite.created = 1
    invite.bound = 0
    invite.add = ["new-1"]
  })

  it("只對新建的員工補簽，既有員工不動", async () => {
    const res = await runImport("employees", TENANT_ID, rows, { dryRun: false })
    expect(res.imported).toBe(1)
    expect(seedSpy.mock.calls.map((c) => (c as unknown[])[1])).toEqual(["new-1"])
  })

  it("dryRunInvite（不建帳號）與只有綁定、沒新建 → 不補簽", async () => {
    await runImport("employees", TENANT_ID, rows, { dryRun: false, options: { dryRunInvite: true } })
    invite.created = 0
    invite.bound = 1
    invite.add = []
    await runImport("employees", TENANT_ID, rows, { dryRun: false })
    expect(seedSpy).not.toHaveBeenCalled()
  })

  it("補簽丟錯不影響匯入結果（best-effort）", async () => {
    seedSpy.mockRejectedValueOnce(new Error("boom"))
    const res = await runImport("employees", TENANT_ID, rows, { dryRun: false })
    expect(res.imported).toBe(1)
  })
})
