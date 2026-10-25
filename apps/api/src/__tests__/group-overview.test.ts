import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { groupOverviewRouter } from "../routes/group-overview.js"
import { clearTenantTimezoneCache } from "../lib/tenant-tz.js"
import {
  buildGroupModel,
  monthOfDate,
  parseExcludeIds,
  parseOverviewMonth,
  parseOverviewYear,
  periodOf,
  summarizeGroupOverview,
  UNASSIGNED_COMPANY_ID,
  type GroupOverviewData,
} from "../services/group-overview.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 集團總覽（services/group-overview.ts、routes/group-overview.ts）。
 * ⚠️ 全部是明顯的假資料（測試公司／客戶／廠商），不放任何真實名稱或統編。
 *
 * 固定情境（2026 年，金額皆為未稅）：
 *   甲公司（預設）、乙公司、丙公司（沒有任何往來）；客戶一般／關係企業；廠商一般／關係企業
 *     專案一（承接公司 null → 預設甲）、專案四（甲、已封存）：一般客戶
 *     專案二（乙）：一般客戶；專案三（乙）：關係企業客戶
 *   甲：入帳 1,600,000（3/31 的 1,000,000＋4/1 的 500,000＋12/31 的 100,000）、開票 1,600,000、放款毛額 112,000
 *   乙：入帳 2,200,000（其中關係企業 300,000）、開票 2,300,000（其中關係企業 300,000）、
 *       放款 250,000（其中關係企業 50,000）
 *   未歸屬：放款 3,000（付款公司 id 不在名冊裡）
 *   集團合計（全納入）：入帳 3,500,000、開票 3,600,000、放款 315,000，剔除關係企業 收入 300,000／開票 300,000／放款 50,000
 */

const app = express()
app.use(express.json())
app.use(groupOverviewRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const PLATFORM_TOKEN = "platform-user"
const ACCOUNTANT_TOKEN = "accountant-user"
const STAFF_TOKEN = "staff-user"
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)
const asHr = (req: request.Test) => as(HR_TOKEN, req)

const CO_A = "cccccccc-0000-4000-8000-00000000000a" // 預設公司
const CO_B = "cccccccc-0000-4000-8000-00000000000b"
const CO_C = "cccccccc-0000-4000-8000-00000000000c"
const CO_OTHER_TENANT = "cccccccc-0000-4000-8000-0000000000ff"
const CO_UNKNOWN = "cccccccc-0000-4000-8000-0000000000ee" // 不在任何名冊

const CL_NORMAL = "dddddddd-0000-4000-8000-000000000001"
const CL_SISTER = "dddddddd-0000-4000-8000-000000000002"
const VD_NORMAL = "eeeeeeee-0000-4000-8000-000000000001"
const VD_SISTER = "eeeeeeee-0000-4000-8000-000000000002"

const PJ1 = "ffffffff-0000-4000-8000-000000000001"
const PJ2 = "ffffffff-0000-4000-8000-000000000002"
const PJ3 = "ffffffff-0000-4000-8000-000000000003"
const PJ4 = "ffffffff-0000-4000-8000-000000000004"

function bill(id: string, over: Row): Row {
  return {
    id,
    tenant_id: TENANT_ID,
    project_id: PJ1,
    deleted_at: null,
    billed_on: null,
    billed_amount: null,
    override_amount: null,
    calculated_amount: null,
    invoiced_on: null,
    received_on: null,
    received_amount: null,
    ...over,
  }
}

function disb(id: string, over: Row): Row {
  return {
    id,
    tenant_id: TENANT_ID,
    status: "paid",
    paid_on: "2026-03-15",
    paying_company_id: CO_A,
    vendor_id: VD_NORMAL,
    payee_kind: "vendor",
    payee_name: "測試廠商甲（快照）",
    amount: 100000,
    withheld_amount: 0,
    ...over,
  }
}

function seedMain() {
  fake.db.employees = [
    { id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: PLATFORM_TOKEN, role: "platform_admin", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000003", tenant_id: TENANT_ID, user_id: ACCOUNTANT_TOKEN, role: "accountant", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000004", tenant_id: TENANT_ID, user_id: STAFF_TOKEN, role: "employee", dept_id: null },
  ]
  fake.db.companies = [
    { id: CO_A, tenant_id: TENANT_ID, name: "測試設計公司A", is_default: true, is_active: true },
    { id: CO_B, tenant_id: TENANT_ID, name: "測試工程公司B", is_default: false, is_active: true },
    { id: CO_C, tenant_id: TENANT_ID, name: "測試顧問公司C", is_default: false, is_active: true },
    { id: CO_OTHER_TENANT, tenant_id: OTHER_TENANT_ID, name: "別租戶的公司", is_default: true, is_active: true },
  ]
  fake.db.clients = [
    { id: CL_NORMAL, tenant_id: TENANT_ID, name: "測試客戶股份有限公司", short_name: "測試客戶", is_affiliate: false },
    { id: CL_SISTER, tenant_id: TENANT_ID, name: "測試姊妹客戶股份有限公司", short_name: null, is_affiliate: true },
  ]
  fake.db.vendors = [
    { id: VD_NORMAL, tenant_id: TENANT_ID, name: "測試廠商甲有限公司", short_name: "廠甲", is_affiliate: false },
    { id: VD_SISTER, tenant_id: TENANT_ID, name: "測試姊妹廠商有限公司", short_name: null, is_affiliate: true },
  ]
  fake.db.projects = [
    { id: PJ1, tenant_id: TENANT_ID, code: "T-001", name: "測試專案一", company_id: null, client_id: CL_NORMAL, archived_at: null },
    { id: PJ2, tenant_id: TENANT_ID, code: "T-002", name: "測試專案二", company_id: CO_B, client_id: CL_NORMAL, archived_at: null },
    { id: PJ3, tenant_id: TENANT_ID, code: "T-003", name: "測試專案三（姊妹客戶）", company_id: CO_B, client_id: CL_SISTER, archived_at: null },
    { id: PJ4, tenant_id: TENANT_ID, code: "T-004", name: "測試專案四（已封存）", company_id: CO_A, client_id: CL_NORMAL, archived_at: "2026-09-01T00:00:00.000Z" },
  ]
  fake.db.project_billings = [
    // B1：已請款（金額凍結在 billed_amount 100 萬，與試算／覆寫不同）；3/5 開票、3/31（月底）入帳
    bill("B1", { project_id: PJ1, billed_on: "2026-03-01", billed_amount: "1000000", override_amount: "1100000", calculated_amount: "1050000", invoiced_on: "2026-03-05", received_on: "2026-03-31", received_amount: "1000000" }),
    // B2：沒請款，有效金額＝覆寫 ?? 試算＝50 萬；4/1（下月初）開票與入帳
    bill("B2", { project_id: PJ1, calculated_amount: 500000, invoiced_on: "2026-04-01", received_on: "2026-04-01", received_amount: 500000 }),
    // B3：乙、一般客戶；開票 200 萬（5/12）、6/15 只入帳 190 萬（折讓）
    bill("B3", { project_id: PJ2, billed_on: "2026-05-10", billed_amount: "2000000", invoiced_on: "2026-05-12", received_on: "2026-06-15", received_amount: "1900000" }),
    // B4：乙、關係企業客戶；沒請款，覆寫 30 萬優先於試算 99 萬 9999
    bill("B4", { project_id: PJ3, override_amount: "300000", calculated_amount: "999999", invoiced_on: "2026-06-01", received_on: "2026-06-30", received_amount: "300000" }),
    // B5：甲、已封存專案：封存只是可見性，錢照算；12/31（年底）
    bill("B5", { project_id: PJ4, calculated_amount: "100000", invoiced_on: "2026-12-31", received_on: "2026-12-31", received_amount: "100000" }),
    // B6：不在 2026：入帳 2027/1/1、開票 2025/12/31
    bill("B6", { project_id: PJ1, calculated_amount: "400000", invoiced_on: "2025-12-31", received_on: "2027-01-01", received_amount: "777777" }),
    // B7：已軟刪
    bill("B7", { project_id: PJ1, deleted_at: "2026-03-20T00:00:00.000Z", invoiced_on: "2026-03-10", calculated_amount: "888888", received_on: "2026-03-10", received_amount: "888888" }),
    // B8：別租戶
    bill("B8", { tenant_id: OTHER_TENANT_ID, project_id: PJ1, received_on: "2026-03-10", received_amount: "5555555", invoiced_on: "2026-03-10", calculated_amount: "5555555" }),
  ]
  fake.db.disbursements = [
    // D1：甲付廠商甲，實付 9 萬＋代扣 1 萬＝毛額 10 萬
    disb("D1", { amount: 90000, withheld_amount: 10000, paid_on: "2026-03-15" }),
    // D2：乙付廠商甲 20 萬（6/30）
    disb("D2", { paying_company_id: CO_B, amount: 200000, paid_on: "2026-06-30" }),
    // D3：乙付關係企業廠商 5 萬（7/1）
    disb("D3", { paying_company_id: CO_B, vendor_id: VD_SISTER, amount: 50000, paid_on: "2026-07-01" }),
    // D4：作廢（匯款日還留著）— 不計
    disb("D4", { status: "void", amount: 70000, paid_on: "2026-03-20" }),
    // D5：草稿、D6：已核准未付 — 不計
    disb("D5", { status: "draft", amount: 60000, paid_on: null }),
    disb("D6", { status: "approved", amount: 40000, paid_on: null }),
    // D7：甲付「其他」收款方（無廠商主檔），12/31
    disb("D7", { vendor_id: null, payee_kind: "other", payee_name: "測試印刷行", amount: 12000, paid_on: "2026-12-31" }),
    // D8：2025/12/31 — 不在 2026
    disb("D8", { amount: 5000, paid_on: "2025-12-31" }),
    // D9：付款公司 id 不在名冊 → 未歸屬
    disb("D9", { paying_company_id: CO_UNKNOWN, amount: 3000, paid_on: "2026-08-01" }),
    // D10：別租戶
    disb("D10", { tenant_id: OTHER_TENANT_ID, amount: 9999999, paid_on: "2026-03-15" }),
  ]
}

beforeEach(() => {
  fake.reset()
  clearTenantTimezoneCache()
  seedMain()
})

afterEach(() => {
  vi.useRealTimers()
})

type Overview = {
  period: { year: number; month: number | null; from: string; to: string }
  companies: Array<{
    id: string
    name: string
    isDefault: boolean
    isActive: boolean
    excluded: boolean
    revenue: number
    invoiced: number
    expense: number
    grossProfit: number
    grossMarginPct: number | null
    affiliate: { revenue: number; invoiced: number; expense: number }
    monthly: Array<{ month: number; revenue: number; invoiced: number; expense: number; grossProfit: number }>
  }>
  group: {
    includedCompanyIds: string[]
    revenue: number
    invoiced: number
    expense: number
    grossProfit: number
    grossMarginPct: number | null
    eliminated: { revenue: number; invoiced: number; expense: number; total: number }
    monthly: Array<{ month: number; revenue: number; invoiced: number; expense: number; grossProfit: number }>
  }
  dataQuality: {
    undatedReceived: { count: number; amount: number; sample: Array<Record<string, unknown>> }
    receivedOverEffective: { count: number; excess: number; sample: Array<Record<string, unknown>> }
  }
  payroll: Record<string, unknown>
}

async function getOverview(query: Record<string, string | string[]> = { year: "2026" }): Promise<Overview> {
  const res = await asHr(request(app).get("/group-overview")).query(query)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body as Overview
}

const company = (body: Overview, id: string) => {
  const found = body.companies.find((c) => c.id === id)
  expect(found, `company ${id}`).toBeDefined()
  return found as Overview["companies"][number]
}

describe("權限：只有 hr_admin／platform_admin", () => {
  it("沒帶 token → 401；一般員工 → 403；會計也 403（跨公司的老闆視角，requireFinance 不夠）", async () => {
    for (const path of ["/group-overview?year=2026", `/group-overview/detail?companyId=${CO_A}&year=2026&kind=revenue`]) {
      expect((await request(app).get(path)).status).toBe(401)
      const staff = await as(STAFF_TOKEN, request(app).get(path))
      expect(staff.status).toBe(403)
      expect(staff.body.error).toBe("forbidden")
      expect((await as(ACCOUNTANT_TOKEN, request(app).get(path))).status).toBe(403)
    }
  })

  it("HR 與平台管理員都可讀；403 時完全不查業務資料表", async () => {
    expect((await as(HR_TOKEN, request(app).get("/group-overview?year=2026"))).status).toBe(200)
    expect((await as(PLATFORM_TOKEN, request(app).get("/group-overview?year=2026"))).status).toBe(200)

    fake.reads.length = 0
    await as(STAFF_TOKEN, request(app).get("/group-overview?year=2026"))
    expect(fake.reads.filter((t) => t !== "employees")).toEqual([])
  })

  it("不是這個租戶的員工列（沒有 employees 紀錄）→ 403", async () => {
    fake.db.employees = fake.db.employees!.filter((e) => e.user_id !== HR_TOKEN)
    const res = await asHr(request(app).get("/group-overview?year=2026"))
    expect(res.status).toBe(403)
  })
})

describe("GET /group-overview — 公司歸屬", () => {
  it("專案承接公司 null 歸預設公司；有填的歸那家；放款歸付款公司", async () => {
    const body = await getOverview()
    const a = company(body, CO_A)
    const b = company(body, CO_B)
    // 甲：專案一（null）與專案四（明填甲）的入帳；付款公司是甲的放款
    expect(a.revenue).toBe(1_600_000)
    expect(a.invoiced).toBe(1_600_000)
    expect(a.expense).toBe(112_000)
    // 乙：專案二、三的入帳；付款公司是乙的放款
    expect(b.revenue).toBe(2_200_000)
    expect(b.invoiced).toBe(2_300_000)
    expect(b.expense).toBe(250_000)
    expect(a.isDefault).toBe(true)
    expect(b.isDefault).toBe(false)
  })

  it("沒有往來的公司也列出（全 0、毛利率 null）；別租戶的公司與資料不混進來", async () => {
    const body = await getOverview()
    expect(body.companies.map((c) => c.id)).toEqual([CO_A, CO_B, CO_C, UNASSIGNED_COMPANY_ID])
    const c = company(body, CO_C)
    expect(c).toMatchObject({ revenue: 0, invoiced: 0, expense: 0, grossProfit: 0, grossMarginPct: null })
    expect(body.companies.some((x) => x.id === CO_OTHER_TENANT)).toBe(false)
    // 別租戶的 B8（555 萬入帳）、D10（999 萬放款）都沒算進來
    expect(body.group.revenue).toBe(3_500_000)
    expect(body.group.expense).toBe(315_000)
  })

  it("付款公司 id 不在名冊 → 歸「（未歸屬公司）」假列，錢不會從合計裡消失", async () => {
    const body = await getOverview()
    const u = company(body, UNASSIGNED_COMPANY_ID)
    expect(u.name).toBe("（未歸屬公司）")
    expect(u.expense).toBe(3_000)
    expect(u.revenue).toBe(0)
    expect(body.group.includedCompanyIds).toContain(UNASSIGNED_COMPANY_ID)
    expect(body.group.expense).toBe(112_000 + 200_000 + 3_000)
  })

  it("沒有任何預設公司時，承接公司 null 的專案歸「未歸屬」", async () => {
    fake.db.companies = fake.db.companies!.map((c) => ({ ...c, is_default: false }))
    const body = await getOverview()
    const u = company(body, UNASSIGNED_COMPANY_ID)
    // 專案一（B1＋B2）的入帳落到未歸屬；專案四明填甲仍歸甲
    expect(u.revenue).toBe(1_500_000)
    expect(company(body, CO_A).revenue).toBe(100_000)
  })

  it("只有一家公司（正式庫現況）：照常顯示，集團合計＝這家扣掉關係企業往來", async () => {
    fake.db.companies = [{ id: CO_A, tenant_id: TENANT_ID, name: "測試設計公司A", is_default: true, is_active: true }]
    fake.db.projects = fake.db.projects!.map((p) => ({ ...p, company_id: null }))
    fake.db.disbursements = fake.db.disbursements!.map((d) => ({ ...d, paying_company_id: CO_A }))
    const body = await getOverview()
    expect(body.companies.map((c) => c.id)).toEqual([CO_A])
    const a = company(body, CO_A)
    expect(a.revenue).toBe(3_800_000) // 1,600,000 ＋ 乙原本的 2,200,000
    expect(a.affiliate).toEqual({ revenue: 300_000, invoiced: 300_000, expense: 50_000 })
    expect(body.group.revenue).toBe(3_500_000)
    expect(body.group.expense).toBe(315_000)
  })

  it("停用的公司：全年沒有往來就不列；有往來照列並標 isActive:false", async () => {
    fake.db.companies = fake.db.companies!.map((c) => (c.id === CO_C || c.id === CO_B ? { ...c, is_active: false } : c))
    const body = await getOverview()
    // 丙：停用且沒往來 → 不列；乙：停用但有往來 → 列出
    expect(body.companies.map((c) => c.id)).toEqual([CO_A, CO_B, UNASSIGNED_COMPANY_ID])
    expect(company(body, CO_B).isActive).toBe(false)
  })
})

describe("GET /group-overview — 未稅換算（金額原樣加總，不乘也不除 1.05）", () => {
  it("收入＝實收金額原樣：乙入帳 190 萬（折讓）就是 190 萬，不是 ÷1.05 也不是開票的 200 萬", async () => {
    const body = await getOverview({ year: "2026", month: "6" })
    const b = company(body, CO_B)
    expect(b.revenue).toBe(1_900_000 + 300_000)
    expect(b.revenue).not.toBe(Math.round(2_200_000 / 1.05))
    expect(b.revenue).not.toBe(Math.round(2_200_000 * 1.05))
  })

  it("開票＝該期有效金額（已請款 ?? 覆寫 ?? 試算）：凍結的請款金額優先於覆寫與試算；沒請款時覆寫優先於試算", async () => {
    const mar = await getOverview({ year: "2026", month: "3" })
    // B1 已請款：billed_amount 100 萬（不是覆寫 110 萬、也不是試算 105 萬）
    expect(company(mar, CO_A).invoiced).toBe(1_000_000)
    const jun = await getOverview({ year: "2026", month: "6" })
    // B4 沒請款：覆寫 30 萬（不是試算 99 萬 9999）
    expect(company(jun, CO_B).invoiced).toBe(300_000)
    const apr = await getOverview({ year: "2026", month: "4" })
    // B2 沒請款也沒覆寫：用試算 50 萬
    expect(company(apr, CO_A).invoiced).toBe(500_000)
  })

  it("開票金額與入帳金額各依自己的日期歸月：乙 5 月開票 200 萬、6 月才入帳 190 萬", async () => {
    const may = await getOverview({ year: "2026", month: "5" })
    expect(company(may, CO_B)).toMatchObject({ invoiced: 2_000_000, revenue: 0 })
    const jun = await getOverview({ year: "2026", month: "6" })
    expect(company(jun, CO_B).revenue).toBe(2_200_000)
  })

  it("金額以「分」整數加總：0.1＋0.2 等於 0.3（不是 0.30000000000000004），每月與合計一致", async () => {
    fake.db.project_billings = [
      bill("F1", { received_on: "2026-02-02", received_amount: "0.1" }),
      bill("F2", { received_on: "2026-02-03", received_amount: 0.2 }),
      bill("F3", { received_on: "2026-02-04", received_amount: "1234.56" }),
    ]
    fake.db.disbursements = []
    const body = await getOverview()
    expect(company(body, CO_A).revenue).toBe(1234.86)
    expect(body.group.revenue).toBe(1234.86)
    expect(body.group.monthly[1]?.revenue).toBe(1234.86)
  })
})

describe("GET /group-overview — 月份邊界（入帳日、匯款日落在月底與下月初）", () => {
  it("3/31 入帳歸 3 月、4/1 入帳歸 4 月，互不串月", async () => {
    const mar = await getOverview({ year: "2026", month: "3" })
    expect(company(mar, CO_A).revenue).toBe(1_000_000)
    const apr = await getOverview({ year: "2026", month: "4" })
    expect(company(apr, CO_A).revenue).toBe(500_000)
    // 全年：兩筆都在
    expect(company(await getOverview(), CO_A).monthly.map((m) => m.revenue).slice(0, 5)).toEqual([0, 0, 1_000_000, 500_000, 0])
  })

  it("匯款日 6/30 歸 6 月、7/1 歸 7 月", async () => {
    const jun = await getOverview({ year: "2026", month: "6" })
    expect(company(jun, CO_B).expense).toBe(200_000)
    const jul = await getOverview({ year: "2026", month: "7" })
    expect(company(jul, CO_B).expense).toBe(50_000)
  })

  it("年底 12/31 屬 2026、2027/1/1 屬 2027，2025/12/31 屬 2025：跨年不混", async () => {
    const dec = await getOverview({ year: "2026", month: "12" })
    expect(company(dec, CO_A)).toMatchObject({ revenue: 100_000, invoiced: 100_000, expense: 12_000 })
    const y2027 = await getOverview({ year: "2027" })
    expect(company(y2027, CO_A)).toMatchObject({ revenue: 777_777, invoiced: 0, expense: 0 })
    expect(y2027.group.monthly[0]?.revenue).toBe(777_777)
    const y2025 = await getOverview({ year: "2025" })
    expect(company(y2025, CO_A)).toMatchObject({ revenue: 0, invoiced: 400_000, expense: 5_000 })
    expect(y2025.group.monthly[11]).toMatchObject({ month: 12, invoiced: 400_000, expense: 5_000 })
    // 2026 全年看不到這三筆
    expect(company(await getOverview(), CO_A)).toMatchObject({ revenue: 1_600_000, invoiced: 1_600_000, expense: 112_000 })
  })

  it("單月期間回傳 period 的起訖日（含閏年 2 月）", async () => {
    const feb = await getOverview({ year: "2028", month: "2" })
    expect(feb.period).toEqual({ year: 2028, month: 2, from: "2028-02-01", to: "2028-02-29" })
    expect((await getOverview({ year: "2026", month: "02" })).period).toEqual({ year: 2026, month: 2, from: "2026-02-01", to: "2026-02-28" })
    expect((await getOverview({ year: "2026" })).period).toEqual({ year: 2026, month: null, from: "2026-01-01", to: "2026-12-31" })
  })

  it("單月檢視時月趨勢仍是整年 12 個月", async () => {
    const jun = await getOverview({ year: "2026", month: "6" })
    expect(jun.group.monthly.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(jun.group.monthly[2]?.revenue).toBe(1_000_000) // 3 月仍在趨勢裡
    expect(company(jun, CO_A).monthly).toHaveLength(12)
  })
})

describe("GET /group-overview — 放款：只算已匯款，作廢／草稿／未付不計", () => {
  it("void 與 draft、approved 不計；已匯款取代扣前毛額（實付＋代扣）", async () => {
    const body = await getOverview()
    const a = company(body, CO_A)
    // D1 毛額 100,000（實付 90,000＋代扣 10,000）＋ D7 12,000；D4（void 7 萬）、D5（draft）、D6（approved）不計
    expect(a.expense).toBe(112_000)
    const mar = await getOverview({ year: "2026", month: "3" })
    expect(company(mar, CO_A).expense).toBe(100_000)
  })

  it("查詢只撈 status=paid，且記憶體裡再擋一次（原料裡混進 void 也不計）", async () => {
    const data: GroupOverviewData = {
      year: 2026,
      companies: [{ id: CO_A, name: "測試設計公司A", isDefault: true, isActive: true }],
      billings: [],
      undatedReceived: [],
      projects: [],
      clients: [],
      vendors: [],
      disbursements: [
        { id: "x1", status: "void", paid_on: "2026-03-20", paying_company_id: CO_A, vendor_id: null, payee_name: "甲", amount: 70000, withheld_amount: 0 },
        { id: "x2", status: "paid", paid_on: "2026-03-21", paying_company_id: CO_A, vendor_id: null, payee_name: "乙", amount: 1000, withheld_amount: 100 },
      ],
    }
    const result = summarizeGroupOverview(buildGroupModel(data), { month: null, excluded: new Set() })
    expect(result.companies[0]?.expense).toBe(1100)
  })
})

describe("GET /group-overview — 關係企業剔除（只影響集團合計）", () => {
  it("各公司自己的數字含關係企業往來，另列「其中關係企業」；集團合計剔除", async () => {
    const body = await getOverview()
    const b = company(body, CO_B)
    // 乙自己的數字照常包含關係企業
    expect(b.revenue).toBe(2_200_000)
    expect(b.expense).toBe(250_000)
    expect(b.affiliate).toEqual({ revenue: 300_000, invoiced: 300_000, expense: 50_000 })
    // 甲沒有關係企業往來
    expect(company(body, CO_A).affiliate).toEqual({ revenue: 0, invoiced: 0, expense: 0 })
    // 集團合計：入帳 160 萬＋（220 萬−30 萬）、開票 160 萬＋（230 萬−30 萬）、放款 11.2 萬＋（25 萬−5 萬）＋未歸屬 0.3 萬
    expect(body.group).toMatchObject({ revenue: 3_500_000, invoiced: 3_600_000, expense: 315_000, grossProfit: 3_185_000, grossMarginPct: 91 })
    expect(body.group.eliminated).toEqual({ revenue: 300_000, invoiced: 300_000, expense: 50_000, total: 350_000 })
  })

  it("單月：只剔除該月的關係企業往來", async () => {
    const jun = await getOverview({ year: "2026", month: "6" })
    // 6 月：乙入帳 220 萬（含關係企業 30 萬）、開票 30 萬（全是關係企業）、放款 20 萬（一般廠商）
    expect(jun.group).toMatchObject({ revenue: 1_900_000, invoiced: 0, expense: 200_000 })
    expect(jun.group.eliminated).toEqual({ revenue: 300_000, invoiced: 300_000, expense: 0, total: 300_000 })
    const jul = await getOverview({ year: "2026", month: "7" })
    // 7 月：只有付給關係企業廠商的 5 萬放款
    expect(jul.group.expense).toBe(0)
    expect(jul.group.eliminated.expense).toBe(50_000)
  })

  it("月趨勢：公司那條含關係企業、集團那條已剔除", async () => {
    const body = await getOverview()
    const jun = 5
    expect(company(body, CO_B).monthly[jun]?.revenue).toBe(2_200_000)
    expect(body.group.monthly[jun]?.revenue).toBe(1_900_000)
    expect(body.group.monthly[jun]?.expense).toBe(200_000)
    expect(body.group.monthly[jun]?.grossProfit).toBe(1_700_000)
  })

  it("廠商被標成關係企業之後（其他廠商不受影響）：放款才被剔除", async () => {
    fake.db.vendors = fake.db.vendors!.map((v) => (v.id === VD_SISTER ? { ...v, is_affiliate: false } : v))
    const body = await getOverview()
    expect(body.group.eliminated.expense).toBe(0)
    expect(body.group.expense).toBe(315_000 + 50_000)
    expect(company(body, CO_B).affiliate.expense).toBe(0)
  })
})

describe("GET /group-overview — 排除公司", () => {
  it("被排除的公司不計入集團合計，列仍回傳（excluded:true）且數字不變；它的關係企業往來也不算「已剔除」", async () => {
    const body = await getOverview({ year: "2026", exclude: CO_B })
    expect(company(body, CO_B)).toMatchObject({ excluded: true, revenue: 2_200_000, expense: 250_000 })
    expect(company(body, CO_A).excluded).toBe(false)
    expect(body.group.includedCompanyIds).toEqual([CO_A, CO_C, UNASSIGNED_COMPANY_ID])
    expect(body.group).toMatchObject({ revenue: 1_600_000, invoiced: 1_600_000, expense: 115_000 })
    expect(body.group.eliminated).toEqual({ revenue: 0, invoiced: 0, expense: 0, total: 0 })
    // 月趨勢的集團那條也沒有乙
    expect(body.group.monthly[5]?.revenue).toBe(0)
  })

  it("可排除多家（逗號分隔或重複參數）、前後空白與不認得的 id 忽略", async () => {
    const byComma = await getOverview({ year: "2026", exclude: ` ${CO_A} , ${CO_B},not-a-company,` })
    expect(byComma.group.includedCompanyIds).toEqual([CO_C, UNASSIGNED_COMPANY_ID])
    expect(byComma.group.revenue).toBe(0)
    expect(byComma.group.expense).toBe(3_000)

    const byRepeat = await getOverview({ year: "2026", exclude: [CO_A, CO_B] })
    expect(byRepeat.group).toMatchObject({ revenue: 0, expense: 3_000 })
    expect(byRepeat.companies.filter((c) => c.excluded).map((c) => c.id)).toEqual([CO_A, CO_B])
  })

  it("全部排除：合計全 0、毛利率 null", async () => {
    const body = await getOverview({ year: "2026", exclude: [CO_A, CO_B, CO_C, UNASSIGNED_COMPANY_ID].join(",") })
    expect(body.group).toMatchObject({ includedCompanyIds: [], revenue: 0, invoiced: 0, expense: 0, grossProfit: 0, grossMarginPct: null })
  })

  it("可以排除「（未歸屬公司）」那一列", async () => {
    const body = await getOverview({ year: "2026", exclude: UNASSIGNED_COMPANY_ID })
    expect(company(body, UNASSIGNED_COMPANY_ID).excluded).toBe(true)
    expect(body.group.expense).toBe(312_000)
  })
})

describe("GET /group-overview — 毛利與毛利率", () => {
  it("毛利＝入帳−放款；毛利率＝毛利÷入帳（一位小數）；收入 0 → null", async () => {
    const body = await getOverview()
    expect(company(body, CO_A)).toMatchObject({ grossProfit: 1_488_000, grossMarginPct: 93 })
    expect(company(body, CO_B)).toMatchObject({ grossProfit: 1_950_000, grossMarginPct: 88.6 })
    // 沒有入帳只有放款：毛利為負、毛利率 null（畫面顯示「—」）
    expect(company(body, UNASSIGNED_COMPANY_ID)).toMatchObject({ revenue: 0, expense: 3_000, grossProfit: -3_000, grossMarginPct: null })
    expect(company(body, CO_C).grossMarginPct).toBeNull()
  })

  it("入帳小於放款：毛利率為負數", async () => {
    fake.db.project_billings = [bill("N1", { received_on: "2026-01-10", received_amount: 1000 })]
    fake.db.disbursements = [disb("N2", { amount: 1500, paid_on: "2026-01-12" })]
    const body = await getOverview()
    expect(company(body, CO_A)).toMatchObject({ revenue: 1000, expense: 1500, grossProfit: -500, grossMarginPct: -50 })
  })
})

describe("GET /group-overview — 查詢量與分頁", () => {
  it("每個資料表只查一輪，與公司家數無關（不是每家公司各打一輪）", async () => {
    fake.reads.length = 0
    await getOverview()
    const count = (table: string) => fake.reads.filter((t) => t === table).length
    expect(count("companies")).toBe(1)
    expect(count("project_billings")).toBe(3) // 該年入帳、該年開票、沒有入帳日的金額各一條
    expect(count("disbursements")).toBe(1)
    expect(count("projects")).toBe(1)
    expect(count("clients")).toBe(1)
    expect(count("vendors")).toBe(1)

    // 公司變成 10 家，查詢次數不變
    for (let i = 0; i < 7; i++) {
      fake.db.companies!.push({ id: `cccccccc-0000-4000-8000-0000000001${i}0`, tenant_id: TENANT_ID, name: `測試公司${i}`, is_default: false, is_active: true })
    }
    fake.reads.length = 0
    const body = await getOverview()
    expect(body.companies.length).toBeGreaterThanOrEqual(10)
    expect(count("project_billings")).toBe(3)
    expect(count("disbursements")).toBe(1)
  })

  it("放款超過 1000 筆：用 .range() 分頁撈完，一筆不漏", async () => {
    fake.db.project_billings = []
    fake.db.disbursements = Array.from({ length: 2_305 }, (_, i) => disb(`P${String(i).padStart(5, "0")}`, { amount: 10, paid_on: "2026-05-05" }))
    fake.reads.length = 0
    const body = await getOverview()
    expect(company(body, CO_A).expense).toBe(23_050)
    expect(fake.reads.filter((t) => t === "disbursements")).toHaveLength(3) // 1000＋1000＋305
  })

  it("入帳期別超過 1000 筆同樣分頁，且同一期同時在「入帳」與「開票」兩條查詢裡只算一次", async () => {
    fake.db.disbursements = []
    fake.db.project_billings = Array.from({ length: 1_050 }, (_, i) =>
      bill(`Q${String(i).padStart(5, "0")}`, { calculated_amount: 7, invoiced_on: "2026-02-02", received_on: "2026-02-03", received_amount: 5 }),
    )
    const body = await getOverview()
    expect(company(body, CO_A)).toMatchObject({ revenue: 5_250, invoiced: 7_350 })
  })

  it("引用到上百個專案／客戶／廠商也只分批查名冊（.in 分批），結果不漏", async () => {
    const projects: Row[] = []
    const billings: Row[] = []
    for (let i = 0; i < 250; i++) {
      const id = `ffffffff-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`
      projects.push({ id, tenant_id: TENANT_ID, code: `M-${i}`, name: `測試專案${i}`, company_id: CO_B, client_id: i % 2 === 0 ? CL_SISTER : CL_NORMAL })
      billings.push(bill(`R${String(i).padStart(4, "0")}`, { project_id: id, received_on: "2026-08-08", received_amount: 100 }))
    }
    fake.db.projects = projects
    fake.db.project_billings = billings
    fake.db.disbursements = []
    fake.reads.length = 0
    const body = await getOverview()
    // 250 個專案一半是關係企業客戶：乙自己 25,000、其中關係企業 12,500；集團 12,500
    expect(company(body, CO_B)).toMatchObject({ revenue: 25_000 })
    expect(company(body, CO_B).affiliate.revenue).toBe(12_500)
    expect(body.group.revenue).toBe(12_500)
    expect(fake.reads.filter((t) => t === "projects")).toHaveLength(3) // 100＋100＋50
  })
})

describe("GET /group-overview — 參數", () => {
  it("year 不合法 → 400 invalid_year；month 不合法 → 400 invalid_month", async () => {
    for (const year of ["abc", "26", "115", "1999", "2101", "2026.5", ""]) {
      const res = await asHr(request(app).get("/group-overview")).query({ year })
      expect(res.status, `year=${year}`).toBe(400)
      expect(res.body.error).toBe("invalid_year")
    }
    for (const month of ["0", "13", "abc", "-1", "1.5", "100"]) {
      const res = await asHr(request(app).get("/group-overview")).query({ year: "2026", month })
      expect(res.status, `month=${month}`).toBe(400)
      expect(res.body.error).toBe("invalid_month")
    }
  })

  it("month 空字串＝全年；前導 0 可收", async () => {
    expect((await getOverview({ year: "2026", month: "" })).period.month).toBeNull()
    expect((await getOverview({ year: "2026", month: "03" })).period.month).toBe(3)
  })

  it("year 省略：取租戶當地今年（時區 Asia/Taipei：UTC 12/31 17:00 已是台北隔年 1/1）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-11T04:00:00Z"))
    expect((await asHr(request(app).get("/group-overview"))).body.period.year).toBe(2026)

    clearTenantTimezoneCache()
    vi.setSystemTime(new Date("2026-12-31T17:00:00Z"))
    expect((await asHr(request(app).get("/group-overview"))).body.period.year).toBe(2027)
    clearTenantTimezoneCache()
  })
})

describe("GET /group-overview/detail — 下鑽", () => {
  type Detail = {
    kind: string
    companyId: string
    companyName: string
    period: { year: number; month: number | null; from: string; to: string }
    total: number
    count: number
    truncated: boolean
    rows: Array<Record<string, unknown>>
  }
  async function getDetail(query: Record<string, string>): Promise<{ status: number; body: Detail }> {
    const res = await asHr(request(app).get("/group-overview/detail")).query(query)
    return { status: res.status, body: res.body as Detail }
  }

  it("revenue：列專案（編號、名稱、客戶、入帳金額），依金額由大到小；金額同總覽", async () => {
    const { status, body } = await getDetail({ companyId: CO_A, year: "2026", kind: "revenue" })
    expect(status).toBe(200)
    expect(body).toMatchObject({ kind: "revenue", companyId: CO_A, companyName: "測試設計公司A", total: 1_600_000, count: 2, truncated: false })
    expect(body.rows).toEqual([
      { projectId: PJ1, code: "T-001", name: "測試專案一", clientName: "測試客戶股份有限公司", clientShortName: "測試客戶", isAffiliate: false, amount: 1_500_000 },
      { projectId: PJ4, code: "T-004", name: "測試專案四（已封存）", clientName: "測試客戶股份有限公司", clientShortName: "測試客戶", isAffiliate: false, amount: 100_000 },
    ])
  })

  it("revenue：關係企業客戶的專案照列（公司自己的數字含），用 isAffiliate 標出來；月份只取該月", async () => {
    const { body } = await getDetail({ companyId: CO_B, year: "2026", month: "6", kind: "revenue" })
    expect(body.period).toEqual({ year: 2026, month: 6, from: "2026-06-01", to: "2026-06-30" })
    expect(body.total).toBe(2_200_000)
    expect(body.rows.map((r) => [r.code, r.amount, r.isAffiliate])).toEqual([
      ["T-002", 1_900_000, false],
      ["T-003", 300_000, true],
    ])
    expect(body.rows[1]?.clientShortName).toBeNull()
    expect(body.rows[1]?.clientName).toBe("測試姊妹客戶股份有限公司")
  })

  it("revenue：月份邊界——甲 3 月只有 3/31 的入帳，4 月只有 4/1 的", async () => {
    const mar = await getDetail({ companyId: CO_A, year: "2026", month: "3", kind: "revenue" })
    expect(mar.body.rows.map((r) => r.amount)).toEqual([1_000_000])
    const apr = await getDetail({ companyId: CO_A, year: "2026", month: "4", kind: "revenue" })
    expect(apr.body.rows.map((r) => r.amount)).toEqual([500_000])
  })

  it("expense：列廠商（廠商、放款金額、筆數），依金額排序；「其他」收款方依名稱分組；void／草稿不列", async () => {
    const { status, body } = await getDetail({ companyId: CO_A, year: "2026", kind: "expense" })
    expect(status).toBe(200)
    expect(body).toMatchObject({ kind: "expense", total: 112_000, count: 2, truncated: false })
    expect(body.rows).toEqual([
      { key: `v:${VD_NORMAL}`, vendorId: VD_NORMAL, name: "測試廠商甲有限公司", shortName: "廠甲", isAffiliate: false, amount: 100_000, count: 1 },
      { key: "o:測試印刷行", vendorId: null, name: "測試印刷行", shortName: null, isAffiliate: false, amount: 12_000, count: 1 },
    ])
  })

  it("expense：同一廠商多筆合併成一列並累計筆數；關係企業廠商標 isAffiliate", async () => {
    fake.db.disbursements!.push(disb("D11", { paying_company_id: CO_B, amount: 30000, paid_on: "2026-09-09" }))
    const { body } = await getDetail({ companyId: CO_B, year: "2026", kind: "expense" })
    expect(body.total).toBe(280_000)
    expect(body.rows).toEqual([
      { key: `v:${VD_NORMAL}`, vendorId: VD_NORMAL, name: "測試廠商甲有限公司", shortName: "廠甲", isAffiliate: false, amount: 230_000, count: 2 },
      { key: `v:${VD_SISTER}`, vendorId: VD_SISTER, name: "測試姊妹廠商有限公司", shortName: null, isAffiliate: true, amount: 50_000, count: 1 },
    ])
    const jul = await getDetail({ companyId: CO_B, year: "2026", month: "7", kind: "expense" })
    expect(jul.body.rows.map((r) => r.amount)).toEqual([50_000])
  })

  it("expense：廠商列已查不到（或沒主檔）時退回匯款當下的收款方名稱快照；沒填名稱顯示（未填收款方）", async () => {
    fake.db.vendors = []
    fake.db.disbursements = [
      disb("S1", { amount: 1000, payee_name: "舊名稱快照" }),
      disb("S2", { vendor_id: null, payee_kind: "other", payee_name: "  ", amount: 500 }),
    ]
    const { body } = await getDetail({ companyId: CO_A, year: "2026", kind: "expense" })
    expect(body.rows.map((r) => [r.name, r.amount, r.isAffiliate])).toEqual([
      ["舊名稱快照", 1000, false],
      ["（未填收款方）", 500, false],
    ])
  })

  it("最多 50 筆：依金額排序，total／count 仍是全部、truncated:true", async () => {
    const projects: Row[] = []
    const billings: Row[] = []
    for (let i = 0; i < 60; i++) {
      const id = `ffffffff-0000-4000-8000-${String(2000 + i).padStart(12, "0")}`
      projects.push({ id, tenant_id: TENANT_ID, code: `L-${String(i).padStart(2, "0")}`, name: `測試專案${i}`, company_id: CO_C, client_id: CL_NORMAL })
      billings.push(bill(`L${String(i).padStart(3, "0")}`, { project_id: id, received_on: "2026-10-10", received_amount: 1000 + i }))
    }
    fake.db.projects = projects
    fake.db.project_billings = billings
    const { body } = await getDetail({ companyId: CO_C, year: "2026", kind: "revenue" })
    expect(body.rows).toHaveLength(50)
    expect(body.count).toBe(60)
    expect(body.truncated).toBe(true)
    expect(body.total).toBe(60_000 + (59 * 60) / 2)
    const amounts = body.rows.map((r) => r.amount as number)
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a))
    expect(amounts[0]).toBe(1059)
    expect(amounts[49]).toBe(1010)
  })

  it("「（未歸屬公司）」也能下鑽；沒有往來的公司回空列", async () => {
    const u = await getDetail({ companyId: UNASSIGNED_COMPANY_ID, year: "2026", kind: "expense" })
    expect(u.status).toBe(200)
    expect(u.body.rows).toMatchObject([{ name: "測試廠商甲有限公司", amount: 3_000, count: 1 }])
    const c = await getDetail({ companyId: CO_C, year: "2026", kind: "revenue" })
    expect(c.status).toBe(200)
    expect(c.body).toMatchObject({ total: 0, count: 0, truncated: false, rows: [] })
  })

  it("停用且全年沒往來的公司仍可下鑽（回空列），公司不存在才 404", async () => {
    fake.db.companies = fake.db.companies!.map((c) => (c.id === CO_C ? { ...c, is_active: false } : c))
    expect((await getDetail({ companyId: CO_C, year: "2026", kind: "revenue" })).status).toBe(200)
    expect((await getDetail({ companyId: CO_OTHER_TENANT, year: "2026", kind: "revenue" })).status).toBe(404)
    const missing = await asHr(request(app).get("/group-overview/detail")).query({ companyId: "no-such", year: "2026", kind: "expense" })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe("company_not_found")
  })

  it("參數不合法 → 400（kind／companyId／year／month）", async () => {
    const bad = async (query: Record<string, string>) => (await asHr(request(app).get("/group-overview/detail")).query(query)).body.error
    expect(await bad({ companyId: CO_A, year: "2026", kind: "profit" })).toBe("invalid_kind")
    expect(await bad({ companyId: CO_A, year: "2026" })).toBe("invalid_kind")
    expect(await bad({ year: "2026", kind: "revenue" })).toBe("invalid_company")
    expect(await bad({ companyId: CO_A, year: "x", kind: "revenue" })).toBe("invalid_year")
    expect(await bad({ companyId: CO_A, year: "2026", month: "13", kind: "revenue" })).toBe("invalid_month")
  })
})

describe("GET /group-overview — 資料品質提醒（不改數字，只攤出可疑的列）", () => {
  it("固定情境：實收都不大於有效金額（含部分入帳 190 萬 < 200 萬）、也沒有無入帳日的金額 → 兩項都是 0", async () => {
    const body = await getOverview()
    expect(body.dataQuality).toEqual({
      undatedReceived: { count: 0, amount: 0, sample: [] },
      receivedOverEffective: { count: 0, excess: 0, sample: [] },
    })
  })

  it("有入帳金額、沒入帳日：不進任何月份的收入，列在 undatedReceived（租戶全部期別、不分年度）", async () => {
    fake.db.project_billings!.push(
      bill("U1", { project_id: PJ1, installment_no: 3, received_on: null, received_amount: 250000 }),
      bill("U2", { project_id: PJ2, installment_no: 1, received_on: null, received_amount: "90000.5" }),
      // 軟刪、別租戶、沒有入帳金額的不算
      bill("U3", { project_id: PJ1, deleted_at: "2026-01-01T00:00:00.000Z", received_amount: 111 }),
      bill("U4", { tenant_id: OTHER_TENANT_ID, project_id: PJ1, received_amount: 222 }),
      bill("U5", { project_id: PJ1, received_amount: null }),
    )
    const body = await getOverview()
    expect(body.dataQuality.undatedReceived).toEqual({
      count: 2,
      amount: 340000.5,
      sample: [
        { projectId: PJ1, code: "T-001", name: "測試專案一", installmentNo: 3, receivedOn: null, receivedAmount: 250000, effectiveAmount: null },
        { projectId: PJ2, code: "T-002", name: "測試專案二", installmentNo: 1, receivedOn: null, receivedAmount: 90000.5, effectiveAmount: null },
      ],
    })
    // 這些列沒有進收入（數字與固定情境一樣）
    expect(body.group.revenue).toBe(3_500_000)
    expect(company(body, CO_A).revenue).toBe(1_600_000)
  })

  it("實收大於有效金額超過 1 元：可能把含稅金額當成未稅填了 → 列在 receivedOverEffective，收入仍照填的金額算（不自動更正）", async () => {
    fake.db.project_billings = [
      // 已請款 100 萬、實收 105 萬（含稅 5%）→ 多 5 萬
      bill("O1", { project_id: PJ1, installment_no: 1, billed_on: "2026-02-01", billed_amount: 1000000, received_on: "2026-02-20", received_amount: 1050000 }),
      // 沒請款、試算 20 萬、實收 21 萬 → 多 1 萬
      bill("O2", { project_id: PJ2, installment_no: 2, calculated_amount: 200000, received_on: "2026-03-05", received_amount: 210000 }),
      // 剛好收足、部分入帳、多 1 元以內（四捨五入雜訊）、算不出有效金額 → 都不算
      bill("E1", { project_id: PJ1, billed_on: "2026-04-01", billed_amount: 500000, received_on: "2026-04-10", received_amount: 500000 }),
      bill("E2", { project_id: PJ1, billed_on: "2026-04-01", billed_amount: 500000, received_on: "2026-04-11", received_amount: 300000 }),
      bill("E3", { project_id: PJ1, billed_on: "2026-04-01", billed_amount: 500000, received_on: "2026-04-12", received_amount: 500001 }),
      bill("E4", { project_id: PJ1, received_on: "2026-04-13", received_amount: 999999 }),
      // 不在 2026 年入帳的不看
      bill("E5", { project_id: PJ1, billed_on: "2025-02-01", billed_amount: 1000, received_on: "2025-02-20", received_amount: 9999 }),
    ]
    const body = await getOverview()
    expect(body.dataQuality.receivedOverEffective).toEqual({
      count: 2,
      excess: 60000,
      sample: [
        { projectId: PJ1, code: "T-001", name: "測試專案一", installmentNo: 1, receivedOn: "2026-02-20", receivedAmount: 1050000, effectiveAmount: 1000000 },
        { projectId: PJ2, code: "T-002", name: "測試專案二", installmentNo: 2, receivedOn: "2026-03-05", receivedAmount: 210000, effectiveAmount: 200000 },
      ],
    })
    // 不改數字：收入照實收金額加總（105 萬＋21 萬＋50 萬＋30 萬＋50.0001 萬＋99.9999 萬）
    expect(company(body, CO_A).revenue).toBe(1_050_000 + 500_000 + 300_000 + 500_001 + 999_999)
    expect(company(body, CO_B).revenue).toBe(210_000)
  })

  it("明細最多 10 筆（依多出來的金額由大到小），count／合計仍是全部", async () => {
    fake.db.project_billings = Array.from({ length: 13 }, (_, i) =>
      bill(`W${String(i).padStart(2, "0")}`, { project_id: PJ1, installment_no: i + 1, billed_on: "2026-05-01", billed_amount: 1000, received_on: "2026-05-02", received_amount: 1100 + i * 10 }),
    )
    const { receivedOverEffective: over } = (await getOverview()).dataQuality
    expect(over.count).toBe(13)
    expect(over.excess).toBe(13 * 100 + 10 * ((12 * 13) / 2))
    expect(over.sample).toHaveLength(10)
    const excesses = over.sample.map((r) => (r.receivedAmount as number) - (r.effectiveAmount as number))
    expect(excesses).toEqual([...excesses].sort((a, b) => b - a))
    expect(excesses[0]).toBe(220)
  })

  it("提醒與月份、排除公司無關（租戶層級的資料問題）", async () => {
    fake.db.project_billings!.push(bill("U9", { project_id: PJ1, installment_no: 1, received_on: null, received_amount: 777 }))
    const month = await getOverview({ year: "2026", month: "6", exclude: CO_A })
    expect(month.dataQuality.undatedReceived.count).toBe(1)
    expect(month.dataQuality.undatedReceived.amount).toBe(777)
  })
})

describe("GET /group-overview — 查詢契約", () => {
  /** 記下每一條查詢（資料表）呼叫過哪些方法與參數；結果照舊回傳。 */
  function recordQueries() {
    const calls: Array<{ table: string; method: string; args: unknown[] }> = []
    const original = fake.from
    fake.from = (table: string) => {
      const builder = original(table)
      const wrap = (target: typeof builder): typeof builder =>
        new Proxy(target, {
          get(t, prop, receiver) {
            const value = Reflect.get(t, prop, receiver)
            if (typeof value !== "function" || typeof prop !== "string") return value
            return (...args: unknown[]) => {
              if (prop !== "then") calls.push({ table, method: prop, args })
              const result = (value as (...a: unknown[]) => unknown).apply(t, args)
              return result === t ? wrap(t) : result
            }
          },
        })
      return wrap(builder)
    }
    return { calls, restore: () => void (fake.from = original) }
  }

  it("每條查詢都綁租戶（.eq(tenant_id)）；分頁的查詢都有穩定排序（.order(id)）與 .range()", async () => {
    const rec = recordQueries()
    try {
      await getOverview()
    } finally {
      rec.restore()
    }
    const tables = ["companies", "project_billings", "disbursements", "projects", "clients", "vendors"]
    for (const table of tables) {
      const mine = rec.calls.filter((c) => c.table === table)
      expect(mine.length, table).toBeGreaterThan(0)
      expect(mine.some((c) => c.method === "eq" && c.args[0] === "tenant_id" && c.args[1] === TENANT_ID), `${table} tenant_id`).toBe(true)
    }
    // 筆數會隨資料量長大的查詢：billings（入帳／開票／無入帳日各一條）、disbursements 必須 order(id) 再 range
    for (const table of ["project_billings", "disbursements"]) {
      const mine = rec.calls.filter((c) => c.table === table)
      const orders = mine.filter((c) => c.method === "order")
      const ranges = mine.filter((c) => c.method === "range")
      expect(orders.length, `${table} order`).toBe(ranges.length)
      expect(orders.every((c) => c.args[0] === "id"), `${table} order(id)`).toBe(true)
      expect(ranges.every((c) => c.args[0] === 0 && c.args[1] === 999), `${table} range(0, 999)`).toBe(true)
    }
    // 放款只撈已匯款、billings 只撈未軟刪
    expect(rec.calls.some((c) => c.table === "disbursements" && c.method === "eq" && c.args[0] === "status" && c.args[1] === "paid")).toBe(true)
    expect(rec.calls.filter((c) => c.table === "project_billings" && c.method === "is" && c.args[0] === "deleted_at").length).toBe(3)
  })

  it("同一個 id 的放款出現兩次（offset 分頁遇到並發寫入可能在頁界重複）只算一次", async () => {
    const row = disb("DUP1", { amount: 5000, paid_on: "2026-05-05" })
    fake.db.disbursements = [row, { ...row }]
    const body = await getOverview()
    expect(company(body, CO_A).expense).toBe(5000)
  })
})

describe("回應形狀（web 的 lib/group-overview-api.ts 型別逐欄依賴這些欄位名）", () => {
  const keys = (o: object) => Object.keys(o).sort()

  it("GET /group-overview：period／companies／group（含 eliminated、monthly）的欄位固定", async () => {
    const body = await getOverview()
    expect(keys(body)).toEqual(["companies", "dataQuality", "group", "payroll", "period"])
    expect(keys(body.payroll)).toEqual(["companyAssignmentReady", "draftSlipCount", "employerCostIncluded", "hasData", "slipCount"])
    expect(keys(body.dataQuality)).toEqual(["receivedOverEffective", "undatedReceived"])
    expect(keys(body.dataQuality.undatedReceived)).toEqual(["amount", "count", "sample"])
    expect(keys(body.dataQuality.receivedOverEffective)).toEqual(["count", "excess", "sample"])
    expect(keys(body.period)).toEqual(["from", "month", "to", "year"])
    expect(keys(body.companies[0]!)).toEqual([
      "affiliate", "excluded", "expense", "grossMarginPct", "grossProfit", "grossProfitAfterPayroll", "headcount", "id", "invoiced", "isActive", "isDefault", "monthly", "name", "payrollCost", "revenue",
    ])
    expect(keys(body.companies[0]!.affiliate)).toEqual(["expense", "invoiced", "revenue"])
    expect(keys(body.companies[0]!.monthly[0]!)).toEqual(["expense", "grossProfit", "invoiced", "month", "revenue"])
    expect(keys(body.group)).toEqual([
      "eliminated", "expense", "grossMarginPct", "grossProfit", "grossProfitAfterPayroll", "headcount", "includedCompanyIds", "invoiced", "monthly", "payrollCost", "revenue",
      "unassignedHeadcount", "unassignedPayrollCost",
    ])
    expect(keys(body.group.eliminated)).toEqual(["expense", "invoiced", "revenue", "total"])
    expect(keys(body.group.monthly[0]!)).toEqual(["expense", "grossProfit", "invoiced", "month", "revenue"])
    // 金額一律是 number（不是字串），毛利率是 number 或 null
    for (const c of body.companies) {
      for (const v of [c.revenue, c.invoiced, c.expense, c.grossProfit]) expect(typeof v).toBe("number")
      expect(c.grossMarginPct === null || typeof c.grossMarginPct === "number").toBe(true)
    }
  })

  it("GET /group-overview/detail：revenue／expense 兩種的欄位固定", async () => {
    const rev = (await asHr(request(app).get("/group-overview/detail")).query({ companyId: CO_A, year: "2026", kind: "revenue" })).body
    expect(keys(rev)).toEqual(["companyId", "companyName", "count", "kind", "period", "rows", "total", "truncated"])
    expect(keys(rev.rows[0])).toEqual(["amount", "clientName", "clientShortName", "code", "isAffiliate", "name", "projectId"])
    const exp = (await asHr(request(app).get("/group-overview/detail")).query({ companyId: CO_A, year: "2026", kind: "expense" })).body
    expect(keys(exp)).toEqual(["companyId", "companyName", "count", "kind", "period", "rows", "total", "truncated"])
    expect(keys(exp.rows[0])).toEqual(["amount", "count", "isAffiliate", "key", "name", "shortName", "vendorId"])
  })
})

describe("純函式", () => {
  it("monthOfDate：只切字串取月；不是該年或格式不對 → null", () => {
    expect(monthOfDate("2026-03-31", 2026)).toBe(3)
    expect(monthOfDate("2026-04-01", 2026)).toBe(4)
    expect(monthOfDate("2026-12-31", 2026)).toBe(12)
    expect(monthOfDate("2027-01-01", 2026)).toBeNull()
    expect(monthOfDate("2025-12-31", 2026)).toBeNull()
    expect(monthOfDate("2026-00-10", 2026)).toBeNull()
    expect(monthOfDate("2026-13-10", 2026)).toBeNull()
    expect(monthOfDate("2026/03/10", 2026)).toBeNull()
    expect(monthOfDate("", 2026)).toBeNull()
    expect(monthOfDate(null, 2026)).toBeNull()
    expect(monthOfDate(undefined, 2026)).toBeNull()
    // 帶時間的字串也只看日期部分（不做時區換算）
    expect(monthOfDate("2026-09-30T23:59:59+08:00", 2026)).toBe(9)
  })

  it("periodOf／parse*：年份 2000–2100、月份 1–12、exclude 去重去空白上限 100", () => {
    expect(periodOf(2026, null)).toEqual({ year: 2026, month: null, from: "2026-01-01", to: "2026-12-31" })
    expect(periodOf(2026, 9)).toEqual({ year: 2026, month: 9, from: "2026-09-01", to: "2026-09-30" })
    expect(periodOf(2026, 12).to).toBe("2026-12-31")
    expect(periodOf(2100, 2).to).toBe("2100-02-28")
    expect(parseOverviewYear(undefined, 2030)).toBe(2030)
    expect(parseOverviewYear("2026", 2030)).toBe(2026)
    expect(parseOverviewYear(["2026"], 2030)).toBeNull()
    expect(parseOverviewMonth(undefined)).toBeNull()
    expect(parseOverviewMonth("")).toBeNull()
    expect(parseOverviewMonth("12")).toBe(12)
    expect(parseOverviewMonth("13")).toBeUndefined()
    expect(parseOverviewMonth(["1"])).toBeUndefined()
    expect([...parseExcludeIds(" a, b ,,a")]).toEqual(["a", "b"])
    expect([...parseExcludeIds(["a,b", "c"])]).toEqual(["a", "b", "c"])
    expect([...parseExcludeIds(undefined)]).toEqual([])
    expect([...parseExcludeIds(Array.from({ length: 300 }, (_, i) => `id${i}`).join(","))]).toHaveLength(100)
  })
})
