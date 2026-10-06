import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { DEFAULT_COPY_OPTIONS, duplicateProject } from "../services/project-duplicate.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const SOURCE_ID = "dddddddd-0000-4000-8000-0000000000a1"
const COMPANY_SECOND = "cccccccc-0000-4000-8000-000000000002"
const ACTOR = "bbbbbbbb-0000-4000-8000-000000000001"

function sourceRow(over: Row = {}): Row {
  return {
    id: SOURCE_ID,
    tenant_id: TENANT_ID,
    name: "測試專案",
    code: "T-115-001",
    fiscal_year: 2026,
    description: null,
    status: "active",
    archived_at: null,
    starts_on: null,
    ends_on: null,
    dept_id: null,
    lead_emp_id: null,
    share_mode: "pool_pct",
    client_id: null,
    parent_project_id: null,
    kind: "main",
    reserved_at: null,
    site_address: null,
    site_area_m2: null,
    design_scope: [],
    invoice_type: null,
    payment_method: null,
    closing_day: null,
    payment_day: null,
    engineers: {},
    company_id: null,
    ...over,
  }
}

const duplicate = (over: Partial<Parameters<typeof duplicateProject>[0]> = {}) =>
  duplicateProject({
    tenantId: TENANT_ID,
    sourceProjectId: SOURCE_ID,
    actorEmpId: ACTOR,
    kind: "change",
    amount: 100_000,
    reason: "測試複製",
    archiveOriginal: false,
    copy: DEFAULT_COPY_OPTIONS,
    openedOn: "2026-10-07",
    ...over,
  })

const writesTo = (table: string, action: "insert" | "update") =>
  fake.writes.filter((write) => write.table === table && write.action === action)

beforeEach(() => {
  fake.reset()
  fake.db.projects = [sourceRow()]
  fake.db.contracts = []
  fake.db.project_settings = []
  fake.db.project_billings = []
  fake.db.project_subcontracts = []
  fake.db.project_members = []
})

describe("複製專案（追加減／加做）— 承接公司", () => {
  it("新案的承接公司與原案相同", async () => {
    fake.db.projects = [sourceRow({ company_id: COMPANY_SECOND })]

    const result = await duplicate()

    expect(result.ok).toBe(true)
    expect(writesTo("projects", "insert")).toHaveLength(1)
    expect(writesTo("projects", "insert")[0]?.payload).toMatchObject({
      company_id: COMPANY_SECOND,
      parent_project_id: SOURCE_ID,
      kind: "change",
      code: "T-115-001-1",
    })
  })

  it("原案是 null（沿用租戶預設公司）時，新案也是 null，不會被偷偷釘成某一間", async () => {
    const result = await duplicate({ kind: "addition" })

    expect(result.ok).toBe(true)
    expect(writesTo("projects", "insert")[0]?.payload).toHaveProperty("company_id", null)
  })

  it("封存原案時只寫封存欄位，不會動到原案的承接公司", async () => {
    fake.db.projects = [sourceRow({ company_id: COMPANY_SECOND })]

    const result = await duplicate({ archiveOriginal: true })

    expect(result.ok).toBe(true)
    const archive = writesTo("projects", "update")
    expect(archive).toHaveLength(1)
    expect(archive[0]?.payload).not.toHaveProperty("company_id")
    expect(fake.db.projects.find((row) => row.id === SOURCE_ID)?.company_id).toBe(COMPANY_SECOND)
  })
})
