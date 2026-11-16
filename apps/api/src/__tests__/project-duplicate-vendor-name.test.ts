import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。假資料，與真實廠商無關。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { DEFAULT_COPY_OPTIONS, duplicateProject } from "../services/project-duplicate.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const SOURCE_ID = "dddddddd-0000-4000-8000-0000000000b1"
const ACTOR = "bbbbbbbb-0000-4000-8000-000000000001"
const OTHER_TENANT = "eeeeeeee-0000-4000-8000-000000000009"
const V_A = "aaaaaaaa-0000-4000-8000-0000000000a1"
const V_DELETED = "aaaaaaaa-0000-4000-8000-0000000000a2"
const V_OTHER_TENANT = "aaaaaaaa-0000-4000-8000-0000000000a3"
const V_MISSING = "aaaaaaaa-0000-4000-8000-0000000000a4"

function sourceRow(): Row {
  return {
    id: SOURCE_ID, tenant_id: TENANT_ID, name: "測試專案", code: "T-115-009", fiscal_year: 2026, description: null,
    status: "active", archived_at: null, starts_on: null, ends_on: null, dept_id: null, lead_emp_id: null,
    share_mode: "pool_pct", client_id: null, parent_project_id: null, kind: "main", reserved_at: null,
    site_address: null, site_area_m2: null, design_scope: [], invoice_type: null, payment_method: null,
    closing_day: null, payment_day: null, engineers: {}, company_id: null,
  }
}

let seq = 0
function sub(over: Row): Row {
  seq += 1
  return {
    id: `ffffffff-0000-4000-8000-${String(seq).padStart(12, "0")}`, tenant_id: TENANT_ID, project_id: SOURCE_ID,
    kind: "subcontract", discipline: null, vendor_id: null, vendor_name: null, contact: null, item: "測試項目",
    amount: 1000, billing_basis: null, order_type: null, withholding_rate: 0, withholding_threshold: 20000,
    sort_order: seq, note: null, created_at: `2026-10-0${seq}T00:00:00Z`, deleted_at: null, ...over,
  }
}

const duplicate = () =>
  duplicateProject({
    tenantId: TENANT_ID, sourceProjectId: SOURCE_ID, actorEmpId: ACTOR, kind: "change", amount: 100_000,
    reason: "測試複製", archiveOriginal: false, copy: DEFAULT_COPY_OPTIONS, openedOn: "2026-10-07",
  })

const insertedSubs = () =>
  fake.writes.filter((w) => w.table === "project_subcontracts" && w.action === "insert").flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload])) as Row[]

beforeEach(() => {
  seq = 0
  fake.reset()
  fake.db.projects = [sourceRow()]
  fake.db.contracts = []
  fake.db.project_settings = []
  fake.db.project_billings = []
  fake.db.project_members = []
  fake.db.vendors = [
    { id: V_A, tenant_id: TENANT_ID, name: "測試名冊甲廠商", deleted_at: null },
    { id: V_DELETED, tenant_id: TENANT_ID, name: "測試已刪廠商", deleted_at: "2026-10-01T00:00:00Z" },
    { id: V_OTHER_TENANT, tenant_id: OTHER_TENANT, name: "測試別租戶廠商", deleted_at: null },
  ]
})

describe("複製專案 — 副委託不帶舊的廠商名稱錯配（2026-11-16）", () => {
  it("vendor_id 在名冊但名稱不符 → 新案名稱改成名冊名稱、vendor_id 不變", async () => {
    fake.db.project_subcontracts = [sub({ vendor_id: V_A, vendor_name: "測試乙廠商（錯配）" })]
    const result = await duplicate()
    expect(result.ok).toBe(true)
    expect(insertedSubs()).toHaveLength(1)
    expect(insertedSubs()[0]).toMatchObject({ vendor_id: V_A, vendor_name: "測試名冊甲廠商" })
  })

  it("名稱 trim 後相同 → 保留原字串（不算錯配）；非登錄廠商（vendor_id null）原樣", async () => {
    fake.db.project_subcontracts = [
      sub({ vendor_id: V_A, vendor_name: " 測試名冊甲廠商 " }),
      sub({ vendor_id: null, vendor_name: "測試自由輸入廠商" }),
    ]
    await duplicate()
    expect(insertedSubs()[0]).toMatchObject({ vendor_id: V_A, vendor_name: " 測試名冊甲廠商 " })
    expect(insertedSubs()[1]).toMatchObject({ vendor_id: null, vendor_name: "測試自由輸入廠商" })
  })

  it("vendor_id 指向已刪／不存在／別租戶的廠商 → vendor_id 設 null、保留名稱", async () => {
    fake.db.project_subcontracts = [
      sub({ vendor_id: V_DELETED, vendor_name: "測試已刪廠商" }),
      sub({ vendor_id: V_MISSING, vendor_name: "測試不存在廠商" }),
      sub({ vendor_id: V_OTHER_TENANT, vendor_name: "測試別租戶廠商" }),
    ]
    const result = await duplicate()
    expect(result.ok).toBe(true)
    expect(insertedSubs().map((s) => [s.vendor_id, s.vendor_name])).toEqual([
      [null, "測試已刪廠商"],
      [null, "測試不存在廠商"],
      [null, "測試別租戶廠商"],
    ])
  })

  it("名冊批次查（不逐列查）：id 查一次＋同名比對分頁讀完（第五輪，含讀到空頁共 2 次）", async () => {
    fake.db.project_subcontracts = [sub({ vendor_id: V_A, vendor_name: "x" }), sub({ vendor_id: V_A, vendor_name: "y" }), sub({ vendor_id: null, vendor_name: "z" })]
    await duplicate()
    expect(fake.reads.filter((t) => t === "vendors")).toHaveLength(3)
    // 全部都是登錄廠商 → 不必查同名
    fake.reads.length = 0
    fake.db.project_subcontracts = [sub({ vendor_id: V_A, vendor_name: "x" }), sub({ vendor_id: V_A, vendor_name: "y" })]
    await duplicate()
    expect(fake.reads.filter((t) => t === "vendors")).toHaveLength(1)
  })
})

describe("複製專案 — 非登錄副委託撞名冊廠商名稱（2026-11-17 第五輪 #4）", () => {
  const V_B1 = "aaaaaaaa-0000-4000-8000-0000000000b1"
  const V_B2 = "aaaaaaaa-0000-4000-8000-0000000000b2"
  it("名冊恰好一家名稱完全相同（只差空白）→ 自動綁定、名稱改用名冊名稱並回 autobound 通知；第八輪：相近（差後綴）→ 不綁、回 similar；不撞名 → 保留非登錄", async () => {
    fake.db.project_subcontracts = [
      sub({ vendor_id: null, vendor_name: "測試名冊 甲廠商" }),
      sub({ vendor_id: null, vendor_name: "測試名冊甲廠商有限公司" }),
      sub({ vendor_id: null, vendor_name: "測試自由輸入廠商" }),
    ]
    const result = await duplicate()
    expect(result.ok).toBe(true)
    expect(insertedSubs().map((s) => [s.vendor_id, s.vendor_name])).toEqual([
      [V_A, "測試名冊甲廠商"],
      [null, "測試名冊甲廠商有限公司"],
      [null, "測試自由輸入廠商"],
    ])
    expect(result.ok && result.subcontractWarnings).toEqual([
      { vendorName: "測試名冊 甲廠商", candidates: 1, kind: "autobound", boundVendorName: "測試名冊甲廠商" },
      { vendorName: "測試名冊甲廠商有限公司", candidates: 1, kind: "similar", similarVendorNames: ["測試名冊甲廠商"] },
    ])
  })
  it("第六輪：來源綁的是已刪除廠商、名冊有同名新廠商 → 不自動綁定，保留非登錄並回 deleted_vendor 警告", async () => {
    fake.db.project_subcontracts = [sub({ vendor_id: V_DELETED, vendor_name: "(股)測試名冊甲廠商" })]
    const result = await duplicate()
    expect(result.ok).toBe(true)
    expect(insertedSubs().map((s) => [s.vendor_id, s.vendor_name])).toEqual([[null, "(股)測試名冊甲廠商"]])
    expect(result.ok && result.subcontractWarnings).toEqual([{ vendorName: "(股)測試名冊甲廠商", candidates: 0, kind: "deleted_vendor" }])
  })
  it("第九輪 H-3：只撞名冊廠商的帳戶戶名／簡稱 → 不自動綁定，只回 similar 警告；名稱 exact 恰好一家才綁", async () => {
    const V_H = "aaaaaaaa-0000-4000-8000-0000000000c1"
    fake.db.vendors!.push({ id: V_H, tenant_id: TENANT_ID, name: "測試陳大文水電行", short_name: "大文水電行", account_holder: "陳大文", deleted_at: null })
    fake.db.project_subcontracts = [
      sub({ vendor_id: null, vendor_name: "陳大文" }),
      sub({ vendor_id: null, vendor_name: "大文水電行" }),
      sub({ vendor_id: null, vendor_name: "測試陳大文 水電行" }),
    ]
    const result = await duplicate()
    expect(result.ok).toBe(true)
    expect(insertedSubs().map((s) => [s.vendor_id, s.vendor_name])).toEqual([
      [null, "陳大文"],
      [null, "大文水電行"],
      [V_H, "測試陳大文水電行"],
    ])
    expect(result.ok && result.subcontractWarnings).toEqual([
      { vendorName: "陳大文", candidates: 1, kind: "similar", similarVendorNames: ["測試陳大文水電行"] },
      { vendorName: "大文水電行", candidates: 1, kind: "similar", similarVendorNames: ["測試陳大文水電行"] },
      { vendorName: "測試陳大文 水電行", candidates: 1, kind: "autobound", boundVendorName: "測試陳大文水電行" },
    ])
  })
  it("收尾輪 F1／F2：名冊名稱核心＋地名／產業詞、或等於名冊 2 字簡稱 → 不自動綁定，只回 similar 警告", async () => {
    const V_K = "aaaaaaaa-0000-4000-8000-0000000000c2"
    fake.db.vendors!.push({ id: V_K, tenant_id: TENANT_ID, name: "測聯實業股份有限公司", short_name: "測聯", account_holder: null, deleted_at: null })
    fake.db.project_subcontracts = [
      sub({ vendor_id: null, vendor_name: "台中測聯國際有限公司" }),
      sub({ vendor_id: null, vendor_name: "測聯" }),
      sub({ vendor_id: null, vendor_name: "測聯社 台中" }),
    ]
    const result = await duplicate()
    expect(result.ok).toBe(true)
    expect(insertedSubs().map((s) => [s.vendor_id, s.vendor_name])).toEqual([
      [null, "台中測聯國際有限公司"],
      [null, "測聯"],
      [null, "測聯社 台中"],
    ])
    expect(result.ok && result.subcontractWarnings).toEqual([
      { vendorName: "台中測聯國際有限公司", candidates: 1, kind: "similar", similarVendorNames: ["測聯實業股份有限公司"] },
      { vendorName: "測聯", candidates: 1, kind: "similar", similarVendorNames: ["測聯實業股份有限公司"] },
      { vendorName: "測聯社 台中", candidates: 1, kind: "similar", similarVendorNames: ["測聯實業股份有限公司"] },
    ])
  })
  it("名冊多家同 key → 保留非登錄、回警告，不擋複製", async () => {
    fake.db.vendors!.push(
      { id: V_B1, tenant_id: TENANT_ID, name: "測試重名工程行", deleted_at: null },
      { id: V_B2, tenant_id: TENANT_ID, name: "測試重名 工程行", deleted_at: null },
    )
    fake.db.project_subcontracts = [sub({ vendor_id: null, vendor_name: "測試重名工程行" })]
    const result = await duplicate()
    expect(result.ok).toBe(true)
    expect(insertedSubs()[0]).toMatchObject({ vendor_id: null, vendor_name: "測試重名工程行" })
    expect(result.ok && result.subcontractWarnings).toEqual([{ vendorName: "測試重名工程行", candidates: 2, kind: "ambiguous" }])
  })
})
