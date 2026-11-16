import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
const schemaState = { extras: true }
vi.mock("../lib/schema-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/schema-compat.js")>()
  return {
    ...actual,
    columnsExist: async (table: string, columns: string) =>
      table === "project_subcontracts" && columns.includes("invoice_no") ? schemaState.extras : actual.columnsExist(table, columns),
  }
})

import { subcontractsRouter } from "../routes/subcontracts.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"
import { DEFAULT_WITHHOLDING_RATE } from "../services/project-money.js"

/**
 * 副委託代扣率預設（2026-11-16 業主核准；migration 0101）：
 * - 新建沒帶代扣率 → 0（不代扣），所有 kind 一樣。
 * - 更新沒帶代扣率 → 保留 DB 既有值（以前會被補回 10%）。
 * - 有帶就用帶的值。
 * ⚠️ 名稱都是明顯的假值（repo 是公開的）。
 */

const app = express()
app.use(express.json())
app.use(subcontractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const HR_EMP_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const PROJECT_ID = "dddddddd-0000-4000-8000-000000000001"
const SUB_TEN = "dddddddd-0000-4000-8000-0000000000b1"
const SUB_ZERO = "dddddddd-0000-4000-8000-0000000000b2"

const subRow = (id: string, rate: string, sort: number): Row => ({
  id, tenant_id: TENANT_ID, project_id: PROJECT_ID, kind: "subcontract", discipline: null, vendor_id: null,
  vendor_name: "測試廠商", item: null, amount: 30000, withholding_rate: rate, withholding_threshold: 20000,
  withholding_date: null, invoice_no: null, invoice_date: null,
  sort_order: sort, deleted_at: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
})
const rowOf = (id: string) => fake.db.project_subcontracts?.find((r) => r.id === id) as Row
const put = (items: Row[]) =>
  request(app).put(`/projects/${PROJECT_ID}/subcontracts`).set("Authorization", `Bearer ${HR_TOKEN}`).send({ subcontracts: items })
/** 既有兩列都放進 payload（沒放的會被視為移除）；不帶 withholdingRate。 */
const keepBoth = (over: Record<string, Row> = {}): Row[] => [
  { id: SUB_TEN, kind: "subcontract", vendorName: "測試廠商", amount: 30000, sortOrder: 0, ...over[SUB_TEN] },
  { id: SUB_ZERO, kind: "subcontract", vendorName: "測試廠商", amount: 30000, sortOrder: 1, ...over[SUB_ZERO] },
]

beforeEach(() => {
  schemaState.extras = true
  fake.reset()
  fake.db.employees = [{ id: HR_EMP_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null }]
  fake.db.projects = [{ id: PROJECT_ID, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: null }]
  fake.db.project_members = []
  fake.db.vendors = []
  fake.db.contracts = []
  fake.db.companies = []
  fake.db.project_subcontract_payments = []
  fake.db.project_subcontracts = [subRow(SUB_TEN, "0.1", 0), subRow(SUB_ZERO, "0", 1)]
})

describe("副委託代扣率預設", () => {
  it("DEFAULT_WITHHOLDING_RATE 是 0（不代扣）", () => {
    expect(DEFAULT_WITHHOLDING_RATE).toBe(0)
  })

  it.each(["subcontract", "technician", "firm"] as const)("新建（%s）沒帶代扣率 → 0", async (kind) => {
    const res = await put([...keepBoth(), { kind, vendorName: "新測試廠商", amount: 50000, sortOrder: 2 }])
    expect(res.status).toBe(200)
    const created = fake.db.project_subcontracts?.find((r) => r.vendor_name === "新測試廠商") as Row
    expect(created).toBeTruthy()
    expect(Number(created.withholding_rate)).toBe(0)
    const ins = fake.writes.filter((w) => w.table === "project_subcontracts" && w.action === "insert")
    expect(ins).toHaveLength(1)
    expect(ins[0].payload).toMatchObject({ withholding_rate: 0, withholding_threshold: 20000 })
  })

  it("新建有帶代扣率 → 用帶的值", async () => {
    const res = await put([...keepBoth(), { kind: "firm", vendorName: "新測試廠商", amount: 50000, withholdingRate: 0.1, sortOrder: 2 }])
    expect(res.status).toBe(200)
    const created = fake.db.project_subcontracts?.find((r) => r.vendor_name === "新測試廠商") as Row
    expect(Number(created.withholding_rate)).toBe(0.1)
  })

  it("更新沒帶代扣率 → 保留原值（原 10% 仍 10%、原 0 仍 0），且不送這欄", async () => {
    const res = await put(keepBoth({ [SUB_TEN]: { amount: 40000 }, [SUB_ZERO]: { amount: 45000 } }))
    expect(res.status).toBe(200)
    expect(rowOf(SUB_TEN)).toMatchObject({ amount: 40000, withholding_rate: "0.1" })
    expect(rowOf(SUB_ZERO)).toMatchObject({ amount: 45000, withholding_rate: "0" })
    const upd = fake.writes.filter((w) => w.table === "project_subcontracts" && w.action === "update" && (w.payload as Row).amount != null)
    expect(upd.length).toBe(2)
    for (const w of upd) expect(w.payload).not.toHaveProperty("withholding_rate")
  })

  it("更新帶 null 代扣率 → 也保留原值", async () => {
    const res = await put(keepBoth({ [SUB_TEN]: { withholdingRate: null } }))
    expect(res.status).toBe(200)
    expect(rowOf(SUB_TEN)).toMatchObject({ withholding_rate: "0.1" })
  })

  it("更新沒帶起扣門檻（或 null）→ 保留原值（原 50,000 仍 50,000），且不送這欄", async () => {
    rowOf(SUB_TEN).withholding_threshold = 50000
    rowOf(SUB_ZERO).withholding_threshold = 50000
    const res = await put(keepBoth({ [SUB_TEN]: { amount: 40000 }, [SUB_ZERO]: { withholdingThreshold: null } }))
    expect(res.status).toBe(200)
    expect(rowOf(SUB_TEN)).toMatchObject({ amount: 40000, withholding_threshold: 50000 })
    expect(rowOf(SUB_ZERO)).toMatchObject({ withholding_threshold: 50000 })
    const upd = fake.writes.filter((w) => w.table === "project_subcontracts" && w.action === "update" && (w.payload as Row).amount != null)
    expect(upd.length).toBe(2)
    for (const w of upd) expect(w.payload).not.toHaveProperty("withholding_threshold")
  })

  it("更新有帶起扣門檻 → 用帶的值；新建沒帶 → 20,000", async () => {
    const res = await put([...keepBoth({ [SUB_TEN]: { withholdingThreshold: 30000 } }), { kind: "firm", vendorName: "新測試廠商", amount: 50000, sortOrder: 2 }])
    expect(res.status).toBe(200)
    expect(rowOf(SUB_TEN)).toMatchObject({ withholding_threshold: 30000 })
    const created = fake.db.project_subcontracts?.find((r) => r.vendor_name === "新測試廠商") as Row
    expect(Number(created.withholding_threshold)).toBe(20000)
  })

  it("更新有帶代扣率 → 用帶的值（含改成 0、改成 5%）", async () => {
    const res = await put(keepBoth({ [SUB_TEN]: { withholdingRate: 0 }, [SUB_ZERO]: { withholdingRate: 0.05 } }))
    expect(res.status).toBe(200)
    expect(Number(rowOf(SUB_TEN).withholding_rate)).toBe(0)
    expect(Number(rowOf(SUB_ZERO).withholding_rate)).toBe(0.05)
  })
})
