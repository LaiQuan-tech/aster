import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

// employees.company_id（migration 0072）套了沒：旗標切換「未套」情境（降級）。
const schema = vi.hoisted(() => ({ companyReady: true }))
vi.mock("../lib/schema-compat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/schema-compat.js")>()),
  employeesHaveCompany: async () => schema.companyReady,
}))

import { groupOverviewRouter } from "../routes/group-overview.js"
import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import { buildGroupModel, monthOfPeriod, summarizeGroupOverview, type GroupOverviewData } from "../services/group-overview.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 集團總覽的人事（2026-10-25）：各公司在職人數、薪資成本、毛利扣人事成本後，未指派另列不分攤。
 * ⚠️ 全部是明顯的假資料。
 *
 * 情境（2026 年）：甲（預設）、乙兩家公司；
 *   員工：甲 2 人在職＋1 人離職、乙 1 人在職、未指派 1 人在職（HR 本人）、別租戶 1 人。
 *   薪資單：甲在職 3 月 40,000（定稿）＋4 月 40,000（草稿）、甲離職者 3 月 30,000、乙 3 月 50,000、
 *           未指派 3 月 20,000、別租戶 3 月 99,999、2025-12 的甲 12,345（不在 2026）。
 *   收入：甲 3 月入帳 500,000；放款：乙 3 月 10,000。
 */

const app = express()
app.use(express.json())
app.use(groupOverviewRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const CO_A = "cccccccc-0000-4000-8000-00000000000a"
const CO_B = "cccccccc-0000-4000-8000-00000000000b"
const CO_OTHER_TENANT = "cccccccc-0000-4000-8000-0000000000ff"
const E_HR = "bbbbbbbb-0000-4000-8000-000000000001"
const E_A1 = "bbbbbbbb-0000-4000-8000-000000000002"
const E_A2 = "bbbbbbbb-0000-4000-8000-000000000003"
const E_A_LEFT = "bbbbbbbb-0000-4000-8000-000000000004"
const E_B1 = "bbbbbbbb-0000-4000-8000-000000000005"
const E_OTHER = "bbbbbbbb-0000-4000-8000-000000000009"
const PJ = "ffffffff-0000-4000-8000-000000000001"

const slip = (employee_id: string, period: string, gross: number | string, status = "finalized", tenant_id = TENANT_ID): Row => ({
  id: `${employee_id}-${period}`, tenant_id, employee_id, period, gross, status,
})

function seed() {
  fake.db.employees = [
    { id: E_HR, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", status: "active", company_id: null },
    { id: E_A1, tenant_id: TENANT_ID, user_id: null, role: "employee", status: "active", company_id: CO_A },
    { id: E_A2, tenant_id: TENANT_ID, user_id: null, role: "employee", status: "active", company_id: CO_A },
    { id: E_A_LEFT, tenant_id: TENANT_ID, user_id: null, role: "employee", status: "inactive", company_id: CO_A },
    { id: E_B1, tenant_id: TENANT_ID, user_id: null, role: "employee", status: "active", company_id: CO_B },
    { id: E_OTHER, tenant_id: OTHER_TENANT_ID, user_id: null, role: "employee", status: "active", company_id: CO_OTHER_TENANT },
  ]
  fake.db.companies = [
    { id: CO_A, tenant_id: TENANT_ID, name: "測試公司甲", is_default: true, is_active: true },
    { id: CO_B, tenant_id: TENANT_ID, name: "測試公司乙", is_default: false, is_active: true },
    { id: CO_OTHER_TENANT, tenant_id: OTHER_TENANT_ID, name: "別租戶的公司", is_default: true, is_active: true },
  ]
  fake.db.projects = [{ id: PJ, tenant_id: TENANT_ID, code: "T-001", name: "測試專案", company_id: CO_A, client_id: null }]
  fake.db.clients = []
  fake.db.vendors = []
  fake.db.project_billings = [
    { id: "B1", tenant_id: TENANT_ID, project_id: PJ, deleted_at: null, billed_on: null, billed_amount: null, override_amount: null, calculated_amount: 500000, invoiced_on: null, received_on: "2026-03-20", received_amount: 500000 },
  ]
  fake.db.disbursements = [
    { id: "D1", tenant_id: TENANT_ID, status: "paid", paid_on: "2026-03-10", paying_company_id: CO_B, vendor_id: null, payee_kind: "other", payee_name: "測試收款人", amount: 10000, withheld_amount: 0 },
  ]
  fake.db.payslips = [
    slip(E_A1, "2026-03", 40000),
    slip(E_A1, "2026-04", "40000.50", "draft"),
    slip(E_A_LEFT, "2026-03", 30000),
    slip(E_B1, "2026-03", 50000),
    slip(E_HR, "2026-03", 20000),
    slip(E_OTHER, "2026-03", 99999, "finalized", OTHER_TENANT_ID),
    slip(E_A1, "2025-12", 12345),
  ]
}

type Overview = Record<string, any>
async function getOverview(query: Record<string, string> = { year: "2026" }): Promise<Overview> {
  const res = await request(app).get("/group-overview").set("Authorization", `Bearer ${HR_TOKEN}`).query(query)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body as Overview
}
const company = (body: Overview, id: string) => body.companies.find((c: Overview) => c.id === id)

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  schema.companyReady = true
  seed()
})

describe("GET /group-overview — 人事（在職人數、薪資成本）", () => {
  it("在職人數依員工所屬公司（離職不算）；未指派另列", async () => {
    const body = await getOverview()
    expect(company(body, CO_A).headcount).toBe(2)
    expect(company(body, CO_B).headcount).toBe(1)
    expect(body.group.unassignedHeadcount).toBe(1)
    expect(body.group.headcount).toBe(4)
  })

  it("薪資成本＝期間內薪資單應發合計（草稿＋定稿、離職者照算、別租戶與別年度不混）", async () => {
    const body = await getOverview()
    expect(company(body, CO_A).payrollCost).toBe(110000.5)
    expect(company(body, CO_B).payrollCost).toBe(50000)
    expect(body.group.unassignedPayrollCost).toBe(20000)
    expect(body.group.payrollCost).toBe(180000.5)
    expect(body.payroll).toEqual({ hasData: true, slipCount: 5, draftSlipCount: 1, companyAssignmentReady: true, employerCostIncluded: false })
  })

  it("扣人事成本後：公司＝毛利－自己的薪資（未指派不分攤）；集團＝集團毛利－（納入公司＋未指派）", async () => {
    const body = await getOverview()
    expect(company(body, CO_A).grossProfit).toBe(500000)
    expect(company(body, CO_A).grossProfitAfterPayroll).toBe(389999.5)
    expect(company(body, CO_B).grossProfitAfterPayroll).toBe(-60000)
    expect(body.group.grossProfit).toBe(490000)
    expect(body.group.grossProfitAfterPayroll).toBe(309999.5)
  })

  it("單月：只算該月薪資單；該月沒有薪資單 → null（尚無薪資資料），人數照常", async () => {
    const april = await getOverview({ year: "2026", month: "4" })
    expect(company(april, CO_A).payrollCost).toBe(40000.5)
    expect(company(april, CO_B).payrollCost).toBe(0)
    expect(april.payroll).toMatchObject({ hasData: true, slipCount: 1, draftSlipCount: 1 })
    const may = await getOverview({ year: "2026", month: "5" })
    expect(may.payroll.hasData).toBe(false)
    expect(company(may, CO_A).payrollCost).toBeNull()
    expect(company(may, CO_A).grossProfitAfterPayroll).toBeNull()
    expect(may.group.payrollCost).toBeNull()
    expect(may.group.unassignedPayrollCost).toBeNull()
    expect(may.group.grossProfitAfterPayroll).toBeNull()
    expect(company(may, CO_A).headcount).toBe(2)
  })

  it("完全沒有薪資資料（正式庫現況）：payrollCost 全是 null、hasData false", async () => {
    fake.db.payslips = []
    const body = await getOverview()
    expect(body.payroll).toMatchObject({ hasData: false, slipCount: 0 })
    for (const c of body.companies) expect(c.payrollCost).toBeNull()
    expect(body.group.payrollCost).toBeNull()
  })

  it("排除的公司：人數與薪資不計入集團合計（未指派仍計入）", async () => {
    const body = await getOverview({ year: "2026", exclude: CO_B })
    expect(company(body, CO_B).payrollCost).toBe(50000)
    expect(body.group.headcount).toBe(3)
    expect(body.group.payrollCost).toBe(130000.5)
    expect(body.group.grossProfitAfterPayroll).toBe(500000 - 130000.5)
  })

  it("員工指到不在本租戶名冊的公司 → 算未指派", async () => {
    fake.db.employees!.find((e) => e.id === E_B1)!.company_id = CO_OTHER_TENANT
    const body = await getOverview()
    expect(company(body, CO_B).headcount).toBe(0)
    expect(body.group.unassignedHeadcount).toBe(2)
    expect(body.group.unassignedPayrollCost).toBe(70000)
  })

  it("停用的公司全年沒往來但有員工 → 照列（人數才看得到）", async () => {
    fake.db.companies!.find((c) => c.id === CO_B)!.is_active = false
    fake.db.disbursements = []
    const body = await getOverview()
    expect(company(body, CO_B)).toMatchObject({ isActive: false, headcount: 1, payrollCost: 50000 })
  })

  it("0072 未套（降級）：全部人列在未指派、companyAssignmentReady false，不 500", async () => {
    schema.companyReady = false
    const body = await getOverview()
    expect(company(body, CO_A).headcount).toBe(0)
    expect(company(body, CO_A).payrollCost).toBe(0)
    expect(body.group.unassignedHeadcount).toBe(4)
    expect(body.group.unassignedPayrollCost).toBe(180000.5)
    expect(body.group.payrollCost).toBe(180000.5)
    expect(body.payroll.companyAssignmentReady).toBe(false)
  })
})

describe("純函式", () => {
  it("monthOfPeriod：只認 'YYYY-MM' 且是該年", () => {
    expect(monthOfPeriod("2026-03", 2026)).toBe(3)
    expect(monthOfPeriod("2025-03", 2026)).toBeNull()
    expect(monthOfPeriod("2026-13", 2026)).toBeNull()
    expect(monthOfPeriod("2026-03-01", 2026)).toBeNull()
    expect(monthOfPeriod(null, 2026)).toBeNull()
  })

  it("沒帶人事原料（舊呼叫端）：人數 0、薪資 null，原本的數字不變", () => {
    const data: GroupOverviewData = {
      year: 2026,
      companies: [{ id: CO_A, name: "測試公司甲", isDefault: true, isActive: true }],
      billings: [], undatedReceived: [], projects: [], clients: [], disbursements: [], vendors: [],
    }
    const r = summarizeGroupOverview(buildGroupModel(data), { month: null, excluded: new Set() })
    expect(r.companies[0]).toMatchObject({ headcount: 0, payrollCost: null, grossProfitAfterPayroll: null })
    expect(r.group).toMatchObject({ headcount: 0, unassignedHeadcount: 0, payrollCost: null })
    expect(r.payroll.companyAssignmentReady).toBe(true)
  })
})
