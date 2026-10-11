import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { DEFAULT_COPY_OPTIONS, duplicateProject } from "../services/project-duplicate.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 複製專案（追加減／加做）— 新案的母案。
 *
 * 規則（services/project-duplicate.ts 檔頭）：母案只能是 main（routes/projects.ts validateParent：子案不可掛子案）。
 *   • 來源是主案            → 新案掛在原案底下（照舊）
 *   • 來源是有母案的子案    → 新案掛在它的根主案（不是這個子案；照舊）
 *   • 來源是「沒有母案的非主案」（母案改選填後常見）→ 沒有 main 可掛，母案留空 null；
 *     以前會掛在這個非主案底下，違反「子案不可掛子案」。
 * ⚠️ 識別碼都是明顯的假值。
 */

const MAIN_ID = "dddddddd-0000-4000-8000-0000000000a1"
const CHILD_ID = "dddddddd-0000-4000-8000-0000000000a2"
const ORPHAN_ID = "dddddddd-0000-4000-8000-0000000000a3"
const GHOST_ID = "dddddddd-0000-4000-8000-0000000000ff"
const ACTOR = "bbbbbbbb-0000-4000-8000-000000000001"

function projectRow(over: Row = {}): Row {
  return {
    id: MAIN_ID,
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

const duplicate = (sourceProjectId: string, over: Partial<Parameters<typeof duplicateProject>[0]> = {}) =>
  duplicateProject({
    tenantId: TENANT_ID,
    sourceProjectId,
    actorEmpId: ACTOR,
    kind: "change",
    amount: 100_000,
    reason: "測試複製",
    archiveOriginal: false,
    copy: DEFAULT_COPY_OPTIONS,
    openedOn: "2026-10-07",
    ...over,
  })

const projectInserts = () => fake.writes.filter((write) => write.table === "projects" && write.action === "insert")
const auditInserts = () => fake.writes.filter((write) => write.table === "audit_logs" && write.action === "insert")

beforeEach(() => {
  fake.reset()
  fake.db.projects = []
  fake.db.contracts = []
  fake.db.project_settings = []
  fake.db.project_billings = []
  fake.db.project_subcontracts = []
  fake.db.project_members = []
  fake.db.audit_logs = []
})

describe("複製專案 — 新案的母案", () => {
  it("來源是主案：新案掛在原案底下，回應的 parentProjectId 是原案 id", async () => {
    fake.db.projects = [projectRow()]

    const result = await duplicate(MAIN_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(projectInserts()).toHaveLength(1)
    expect(projectInserts()[0]?.payload).toMatchObject({ parent_project_id: MAIN_ID, kind: "change", code: "T-115-001-1" })
    expect(result.project).toMatchObject({ parentProjectId: MAIN_ID, rootCode: "T-115-001", code: "T-115-001-1" })
  })

  it("來源是有母案的子案：新案掛在根主案（不是這個子案），編號沿用根案的下一號", async () => {
    fake.db.projects = [
      projectRow(),
      projectRow({ id: CHILD_ID, code: "T-115-001-1", name: "測試專案（追加減 1）", kind: "addition", parent_project_id: MAIN_ID }),
    ]

    const result = await duplicate(CHILD_ID, { kind: "addition" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(projectInserts()[0]?.payload).toMatchObject({ parent_project_id: MAIN_ID, kind: "addition", code: "T-115-001-2" })
    expect(result.project).toMatchObject({ parentProjectId: MAIN_ID, rootCode: "T-115-001", code: "T-115-001-2" })
  })

  it("來源是沒有母案的非主案：母案留空（null），不掛在這個非主案底下；編號沿用來源的 code", async () => {
    // 母案選填後：追加案先開案、還沒補母案。
    fake.db.projects = [projectRow({ id: ORPHAN_ID, code: "T-115-009", name: "先開案的追加", kind: "addition", parent_project_id: null })]

    const result = await duplicate(ORPHAN_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const written = projectInserts()[0]?.payload as Row
    expect(written.parent_project_id).toBeNull()
    expect(written.parent_project_id).not.toBe(ORPHAN_ID)
    expect(written).toMatchObject({ kind: "change", code: "T-115-009-1" })
    expect(result.project).toMatchObject({ parentProjectId: null, rootCode: "T-115-009", code: "T-115-009-1" })
    // 其餘照常：新案依 amount 新建合約。
    expect(fake.writes.filter((w) => w.table === "contracts" && w.action === "insert")).toHaveLength(1)
  })

  it("沒有母案的非主案再複製第二次：兩張新案都不掛母案，編號遞增", async () => {
    fake.db.projects = [projectRow({ id: ORPHAN_ID, code: "T-115-009", kind: "advance", parent_project_id: null })]

    const first = await duplicate(ORPHAN_ID)
    const second = await duplicate(ORPHAN_ID)

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect([first.project.code, second.project.code]).toEqual(["T-115-009-1", "T-115-009-2"])
    expect([first.project.parentProjectId, second.project.parentProjectId]).toEqual([null, null])
  })

  it("鏈上斷在非主案（母案也是沒有母案的非主案）：同樣不掛", async () => {
    fake.db.projects = [
      projectRow({ id: ORPHAN_ID, code: "T-115-009", kind: "addition", parent_project_id: null }),
      projectRow({ id: CHILD_ID, code: "T-115-009-1", kind: "change", parent_project_id: ORPHAN_ID }),
    ]

    const result = await duplicate(CHILD_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((projectInserts()[0]?.payload as Row).parent_project_id).toBeNull()
    expect(result.project).toMatchObject({ parentProjectId: null, rootCode: "T-115-009" })
  })

  it("母案那一列不見了（資料被手動改壞）：當作沒有母案，不掛一個不存在的 id、也不 500", async () => {
    fake.db.projects = [projectRow({ id: CHILD_ID, code: "T-115-020-1", kind: "change", parent_project_id: GHOST_ID })]

    const result = await duplicate(CHILD_ID)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((projectInserts()[0]?.payload as Row).parent_project_id).toBeNull()
    expect(result.project.parentProjectId).toBeNull()
  })

  it("稽核紀錄的 parent_project_id 與實際寫進去的一致（有母案＝母案 id；沒有＝null）", async () => {
    fake.db.projects = [
      projectRow(),
      projectRow({ id: ORPHAN_ID, code: "T-115-009", kind: "addition", parent_project_id: null }),
    ]

    await duplicate(MAIN_ID)
    await duplicate(ORPHAN_ID)

    const parents = auditInserts()
      .map((w) => w.payload as Row)
      .filter((row) => row.table_name === "projects" && row.action === "INSERT")
      .map((row) => (row.new_row as Row).parent_project_id)
    expect(parents).toEqual([MAIN_ID, null])
  })

  it("封存原案照舊只動封存欄位（沒有母案時也一樣）", async () => {
    fake.db.projects = [projectRow({ id: ORPHAN_ID, code: "T-115-009", kind: "addition", parent_project_id: null })]

    const result = await duplicate(ORPHAN_ID, { archiveOriginal: true })

    expect(result.ok).toBe(true)
    const updates = fake.writes.filter((w) => w.table === "projects" && w.action === "update")
    expect(updates).toHaveLength(1)
    expect(updates[0]?.payload).not.toHaveProperty("parent_project_id")
    expect(fake.db.projects.find((row) => row.id === ORPHAN_ID)?.parent_project_id).toBeNull()
  })
})
