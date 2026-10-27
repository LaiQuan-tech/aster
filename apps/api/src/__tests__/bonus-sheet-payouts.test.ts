import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，獎金批次 store 換成 mock；不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../services/bonus-run-store.js", () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  previewRun: vi.fn(),
  loadInputs: vi.fn(),
  listProjectRunItems: vi.fn(),
  tenantToday: vi.fn(async () => "2026-10-27"),
}))

import { bonusSheetRouter } from "../routes/bonus-sheet.js"
import { getRun, listProjectRunItems, listRuns, loadInputs, previewRun, type SerializedItem, type SerializedRun } from "../services/bonus-run-store.js"
import { buildProjectPayouts, rowProjectsOf } from "../services/bonus-sheet.js"
import { groupShareRevisions, revisionNoteOf, rocDate, type ShareAdjustmentRow } from "../services/bonus-sheet-revisions.js"
import { OPEN_HEADER_ROWS, type BonusSheetProject } from "../lib/statements/bonus-sheet.js"
import type { GridCell } from "../lib/statements/grid.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 獎金分潤總表：展開的「發放歷程」（GET /bonus-sheet/projects/:projectId/payouts）與分潤調整備註。
 * ⚠️ 全部是明顯的假值（測試員甲／測試案一／T-0001），不放任何真實姓名、案名、金額。
 */

const P1 = "aaaaaaaa-0000-4000-8000-000000000001"
const P_OTHER_TENANT = "aaaaaaaa-0000-4000-8000-000000000099"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = { boss: emp(1), hr: emp(2), grantedHr: emp(3), platform: emp(4), accountant: emp(5), staff: emp(6), a: emp(11), b: emp(12), c: emp(13) }
const T = { boss: "boss-user", hr: "hr-user", grantedHr: "granted-hr-user", platform: "platform-user", accountant: "accountant-user", staff: "staff-user" }
const runId = (n: number) => `cccccccc-0000-4000-8000-00000000000${n}`
const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

function empRow(id: string, userId: string | null, role: string, name = "測試人員", features: Record<string, unknown> = {}) {
  return { id, tenant_id: TENANT_ID, user_id: userId, name, role, dept_id: null, emp_no: null, status: "active", employment_type: "regular", must_change_password: false, features, default_shift_id: null }
}

function run(n: number, over: Partial<SerializedRun> = {}): SerializedRun {
  return {
    id: runId(n), label: `2026-Q${n}`, asOf: `2026-0${n * 3}-09`, status: "paid", kind: "regular", reversesRunId: null, reversedByRunId: null, reversedByStatus: null,
    paidOn: `2026-0${n * 3}-10`, totals: { amount: 0, entitledCumulative: 0, paidBefore: 0, itemCount: 0, employeeCount: 0, projectCount: 0, overpaidCount: 0, skipped: [] },
    note: null, createdByEmpId: null, paidByEmpId: null, createdAt: `2026-0${n * 3}-09T00:00:00Z`, updatedAt: `2026-0${n * 3}-09T00:00:00Z`,
    submittedAt: `2026-0${n * 3}-09T01:00:00Z`, submittedByEmpId: null, approvedAt: `2026-0${n * 3}-09T02:00:00Z`, approvedByEmpId: null, approvedAmount: null,
    returnedAt: null, returnedByEmpId: null, returnReason: null, selfApproved: false,
    ...over,
  }
}

function item(over: Partial<SerializedItem> & { runId: string; employeeId: string }): SerializedItem {
  return {
    id: null, projectId: P1, projectCode: "T-0001", projectName: "測試案一", employeeName: "測試員甲", empNo: null, roleInProject: "manager",
    shareMode: "pool_pct", sharePct: 50, shareAmount: null, bonusPool: 40000, bonusRatePct: 10, contractTotal: 1000000, receivedTotal: 500000,
    receivedPct: 0.5, previousReceived: 0, previousReceivedPct: 0, currentReceived: 500000, currentReceivedPct: 0.5, unallocatedPct: 0,
    projectNote: null, entitledCumulative: 0, paidBefore: 0, amount: 0, overpaid: false, overpaidBy: 0, basis: "tax_inclusive_receipts",
    revenue: 500000, cost: null, disbursementCost: null, subcontractCost: null, grossProfit: null, overContractPct: null,
    ...over,
  }
}

const project = { id: P1, code: "T-0001", name: "測試案一" }

describe("buildProjectPayouts（純函式）", () => {
  it("依時間排序、草稿不列、累計只算已發放、成員依角色排、沖銷／補發／超發標示", () => {
    const q1 = run(1)
    const q2 = run(2)
    const rev = run(3, { label: "沖銷 2026-Q2", kind: "reversal", reversesRunId: runId(2), paidOn: "2026-09-20", asOf: "2026-09-20", createdAt: "2026-09-20T00:00:00Z" })
    const q4 = run(4, { label: "2026-Q4", status: "approved", paidOn: null, asOf: "2026-10-09", approvedAt: "2026-10-12T02:00:00Z" })
    const draft = run(5, { label: "2026-Q4 草稿", status: "draft", paidOn: null, asOf: "2026-12-09", approvedAt: null, submittedAt: null })
    const runs = [draft, q4, rev, q2, q1] // 清單是新到舊，結果要舊到新
    const items = [
      item({ runId: q1.id, employeeId: E.b, employeeName: "測試員乙", roleInProject: "member", sharePct: 30, amount: 3000, paidBefore: 0 }),
      item({ runId: q1.id, employeeId: E.a, amount: 5000, paidBefore: 0 }),
      item({ runId: q2.id, employeeId: E.a, amount: 2000, paidBefore: 5000 }),
      item({ runId: q2.id, employeeId: E.b, employeeName: "測試員乙", roleInProject: "member", amount: 0, paidBefore: 3000, overpaid: true, overpaidBy: 400 }),
      item({ runId: rev.id, employeeId: E.a, amount: -2000, paidBefore: 7000 }),
      item({ runId: q4.id, employeeId: E.a, amount: 2500, paidBefore: 5000 }),
      item({ runId: draft.id, employeeId: E.a, amount: 999, paidBefore: 5000 }),
      item({ runId: q1.id, employeeId: E.c, projectId: "other-project", amount: 77777 }), // 別的專案不列
    ]
    const r = buildProjectPayouts(project, runs, items)
    expect(r.runs.map((x) => x.label)).toEqual(["2026-Q1", "2026-Q2", "沖銷 2026-Q2", "2026-Q4"])
    expect(r.draftCount).toBe(1)
    expect(r.runs.map((x) => x.total)).toEqual([8000, 2000, -2000, 2500])
    expect(r.runs.map((x) => x.cumulativePaid)).toEqual([8000, 10000, 8000, 8000])
    expect(r.runs.map((x) => x.countsTowardPaid)).toEqual([true, true, true, false])
    expect(r.paidTotal).toBe(8000)
    expect(r.pendingTotal).toBe(2500)
    // 經理在前
    expect(r.runs[0]!.members.map((m) => m.name)).toEqual(["測試員甲", "測試員乙"])
    expect(r.runs[1]!.members.find((m) => m.employeeId === E.b)).toMatchObject({ adjustment: "overpaid", overpaidBy: 400 })
    expect(r.runs[2]).toMatchObject({ kind: "reversal", reversesLabel: "2026-Q2" })
    expect(r.runs[2]!.members[0]).toMatchObject({ adjustment: "reversal", amount: -2000 })
    expect(r.runs[3]!.members[0]).toMatchObject({ adjustment: "top_up" }) // 前一次已發放是沖銷 → 補發
    expect(r.runs[3]).toMatchObject({ status: "approved", paidOn: null, approvedAt: "2026-10-12T02:00:00Z" })
    expect(r.warnings).toEqual([])
  })

  it("一般批次負數＝追扣；凍結的「之前已發放」與歷程累計不符 → warning", () => {
    const r = buildProjectPayouts(project, [run(2), run(1)], [
      item({ runId: runId(1), employeeId: E.a, amount: 5000, paidBefore: 0 }),
      item({ runId: runId(2), employeeId: E.a, amount: -1000, paidBefore: 4000 }),
    ])
    expect(r.runs[1]!.members[0]!.adjustment).toBe("clawback")
    expect(r.paidTotal).toBe(4000)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain("2026-Q2")
  })

  it("沒有任何批次 → 空歷程", () => {
    expect(buildProjectPayouts(project, [], [])).toMatchObject({ runs: [], paidTotal: 0, pendingTotal: 0, draftCount: 0, revisions: [] })
  })
})

describe("分潤調整（groupShareRevisions）", () => {
  const names = new Map<string, string | null>([[E.a, "測試員甲"], [E.b, "測試員乙"], [E.c, "測試員丙"], [E.boss, "測試老闆"]])
  const roles = new Map<string, string | null>([[E.a, "manager"], [E.b, "lead"], [E.c, "member"]])
  let n = 0
  const adj = (over: Partial<ShareAdjustmentRow>): ShareAdjustmentRow => ({
    id: `adj-${String(++n).padStart(3, "0")}`, project_id: P1, employee_id: null, change_set_id: null, field: "pct", old_value: null, new_value: null,
    reason: null, changed_by_emp_id: E.boss, created_at: "2026-01-05T02:00:00Z", ...over,
  })

  it("開案當天的初始設定略過；整批修訂合成一組；角色、增減、比例都寫成精簡文字；依時間串接", () => {
    const rows = [
      // 開案（2026-01-05 台北）：設比例、加成員 → 初始設定，不列
      adj({ field: "bonus_rate", old_value: null, new_value: 3, change_set_id: "s0", reason: "開案" }),
      adj({ field: "member_add", employee_id: E.a, new_value: 40, change_set_id: "s0", reason: "開案" }),
      adj({ field: "pct", employee_id: E.b, old_value: null, new_value: 20 }), // 舊版 POST 成員，同日 → 初始
      // 2026-03-10：主辦 20→25、獎金比例 3→4
      adj({ field: "pct", employee_id: E.b, old_value: 20, new_value: 25, change_set_id: "s1", reason: "工作量增加", created_at: "2026-03-10T03:00:00Z" }),
      adj({ field: "bonus_rate", old_value: "3", new_value: "4", change_set_id: "s1", reason: "工作量增加", created_at: "2026-03-10T03:00:00Z" }),
      // 2026-05-01：丙 組員→支援、加入、移除
      adj({ field: "role", employee_id: E.c, old_value: 3, new_value: 4, change_set_id: "s2", reason: "調整分工", created_at: "2026-05-01T03:00:00Z" }),
      adj({ field: "member_remove", employee_id: E.a, old_value: 40, change_set_id: "s2", reason: "調整分工", created_at: "2026-05-01T03:00:00Z" }),
      adj({ field: "member_add", employee_id: E.c, new_value: 10, change_set_id: "s2", reason: "調整分工", created_at: "2026-05-01T03:00:00Z" }),
      // 舊版單筆固定金額（沒原因）
      adj({ field: "amount", employee_id: E.a, old_value: 10000, new_value: 12000, created_at: "2026-06-01T03:00:00Z" }),
    ]
    const revs = groupShareRevisions(rows, names, roles, "Asia/Taipei")
    expect(revs).toHaveLength(3)
    expect(revs[0]).toMatchObject({ date: "2026-03-10", changedByName: "測試老闆", reason: "工作量增加" })
    expect(revs[0]!.text).toBe("115/03/10 獎金比例 3%→4%；主辦 測試員乙 20%→25%（原因：工作量增加）")
    expect(revs[1]!.text).toBe("115/05/01 移除 經理 測試員甲（原 40%）；測試員丙 角色 組員→支援；加入 支援 測試員丙 10%（原因：調整分工）")
    expect(revs[2]!.text).toBe("115/06/01 經理 測試員甲 固定金額 10,000→12,000")
    expect(revisionNoteOf(revs).split("\n")).toHaveLength(3)
    expect(rocDate("2026-03-10")).toBe("115/03/10")
  })

  it("時區：UTC 前一天晚上＝台北當天", () => {
    const revs = groupShareRevisions(
      [adj({ created_at: "2026-01-01T00:00:00Z", field: "bonus_rate", new_value: 3 }), adj({ field: "bonus_rate", old_value: 3, new_value: 5, created_at: "2026-04-30T17:30:00Z" })],
      names,
      roles,
      "Asia/Taipei",
    )
    expect(revs.map((r) => r.date)).toEqual(["2026-05-01"])
  })
})

describe("rowProjectsOf：與格線同一個排序", () => {
  it("依單號排序後第 i 案在 headerRows＋i 列", () => {
    const p = (projectId: string, code: string) => ({ projectId, code, name: "測試" }) as BonusSheetProject
    expect(rowProjectsOf([p("x", "T-0002"), p("y", "T-0001")], OPEN_HEADER_ROWS)).toEqual([
      { row: OPEN_HEADER_ROWS, projectId: "y" },
      { row: OPEN_HEADER_ROWS + 1, projectId: "x" },
    ])
  })
})

// ── 路由 ─────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(bonusSheetRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", branding: {}, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: E.boss } } }]
  fake.db.employees = [
    empRow(E.boss, T.boss, "hr_admin", "測試老闆"),
    empRow(E.hr, T.hr, "hr_admin"),
    empRow(E.grantedHr, T.grantedHr, "hr_admin", "測試人員", { seeGroupFinancials: true }),
    empRow(E.platform, T.platform, "platform_admin"),
    empRow(E.accountant, T.accountant, "accountant", "測試人員", { seeGroupFinancials: true }),
    empRow(E.staff, T.staff, "employee"),
    empRow(E.a, null, "employee", "測試員甲"),
    empRow(E.b, null, "employee", "測試員乙"),
  ]
  fake.db.departments = []
  fake.db.companies = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: [] }]
  fake.db.projects = [
    { id: P1, tenant_id: TENANT_ID, code: "T-0001", name: "測試案一", status: "active", archived_at: null, archive_reason: null },
    { id: P_OTHER_TENANT, tenant_id: "99999999-9999-4999-8999-999999999999", code: "X-0001", name: "別租戶案", status: "active", archived_at: null, archive_reason: null },
  ]
  fake.db.project_members = [{ id: "m1", tenant_id: TENANT_ID, project_id: P1, employee_id: E.b, role_in_project: "lead", share_pct: "25" }]
  fake.db.project_share_adjustments = [
    { id: "adj-1", tenant_id: TENANT_ID, project_id: P1, employee_id: E.b, change_set_id: null, field: "pct", old_value: null, new_value: "20", reason: null, changed_by_emp_id: E.boss, created_at: "2026-01-05T02:00:00Z" },
    { id: "adj-2", tenant_id: TENANT_ID, project_id: P1, employee_id: E.b, change_set_id: "s1", field: "pct", old_value: "20", new_value: "25", reason: "工作量增加", changed_by_emp_id: E.boss, created_at: "2026-03-10T03:00:00Z" },
  ]
  const q1 = run(1)
  vi.mocked(listProjectRunItems).mockReset().mockResolvedValue({ runs: [q1], items: [item({ runId: q1.id, employeeId: E.b, employeeName: "測試員乙", roleInProject: "lead", amount: 3000 })] })
  vi.mocked(listRuns).mockReset().mockResolvedValue([q1])
  vi.mocked(getRun).mockReset().mockResolvedValue({
    run: q1,
    items: [item({ runId: q1.id, employeeId: E.b, employeeName: "測試員乙", roleInProject: "lead", sharePct: 25, amount: 3000, entitledCumulative: 3000 })],
    snapshot: { projects: [] },
  })
  vi.mocked(previewRun).mockReset()
  vi.mocked(loadInputs).mockReset().mockResolvedValue({ projects: [], projectMeta: new Map(), employeeMeta: new Map(), archiveStage: new Map() })
})

const URL = `/bonus-sheet/projects/${P1}/payouts`

describe("GET /bonus-sheet/projects/:projectId/payouts", () => {
  it("權限同總表：老闆、platform_admin、授權 HR → 200；未授權 HR、會計、一般員工 → 403 且不讀批次", async () => {
    for (const t of [T.boss, T.platform, T.grantedHr]) expect((await as(t)(request(app).get(URL))).status, t).toBe(200)
    vi.mocked(listProjectRunItems).mockClear()
    for (const t of [T.hr, T.accountant, T.staff]) {
      const res = await as(t)(request(app).get(URL))
      expect(res.status, t).toBe(403)
      expect(res.body).toEqual({ error: "group_financials_forbidden" })
    }
    expect(listProjectRunItems).not.toHaveBeenCalled()
    expect((await request(app).get(URL)).status).toBe(401)
  })

  it("回傳發放歷程＋分潤調整（初始設定不列）", async () => {
    const res = await as(T.boss)(request(app).get(URL))
    expect(res.body).toMatchObject({ project: { id: P1, code: "T-0001", name: "測試案一" }, paidTotal: 3000, pendingTotal: 0, draftCount: 0, warnings: [] })
    expect(res.body.runs).toHaveLength(1)
    expect(res.body.runs[0]).toMatchObject({ label: "2026-Q1", status: "paid", paidOn: "2026-03-10", total: 3000, cumulativePaid: 3000 })
    expect(res.body.runs[0].members[0]).toMatchObject({ name: "測試員乙", role: "lead", amount: 3000, adjustment: null })
    expect(res.body.revisions).toHaveLength(1)
    expect(res.body.revisions[0]).toMatchObject({ date: "2026-03-10", changedByName: "測試老闆", reason: "工作量增加", text: "115/03/10 主辦 測試員乙 20%→25%（原因：工作量增加）" })
    expect(listProjectRunItems).toHaveBeenCalledWith(TENANT_ID, P1)
  })

  it("別租戶或不存在的專案 → 404；格式錯 → 400", async () => {
    expect((await as(T.boss)(request(app).get(`/bonus-sheet/projects/${P_OTHER_TENANT}/payouts`))).status).toBe(404)
    expect((await as(T.boss)(request(app).get("/bonus-sheet/projects/aaaaaaaa-0000-4000-8000-000000000055/payouts"))).status).toBe(404)
    expect((await as(T.boss)(request(app).get("/bonus-sheet/projects/abc/payouts"))).body).toEqual({ error: "invalid_query", param: "projectId" })
    expect(listProjectRunItems).not.toHaveBeenCalled()
  })

  it("分潤調整讀取失敗 → 歷程照回，附 warning", async () => {
    fake.injectError({ table: "project_share_adjustments", action: "select", error: { message: "boom" } })
    const res = await as(T.boss)(request(app).get(URL))
    expect(res.status).toBe(200)
    expect(res.body.runs).toHaveLength(1)
    expect(res.body.revisions).toEqual([])
    expect(res.body.warnings).toContain("分潤調整紀錄讀取失敗，暫不顯示分潤調整")
  })
})

describe("GET /bonus-sheet：rowProjects 與備註裡的分潤調整", () => {
  it("rowProjects 指向格線上同一列；備註含分潤調整", async () => {
    const res = await as(T.boss)(request(app).get("/bonus-sheet"))
    expect(res.status).toBe(200)
    const cells = res.body.sheets.open.cells as GridCell[]
    const rp = res.body.rowProjects.open as Array<{ row: number; projectId: string }>
    expect(rp).toEqual([{ row: OPEN_HEADER_ROWS, projectId: P1 }])
    expect(cells.find((c) => c.row === rp[0]!.row && c.col === 1)?.value).toBe("T-0001")
    const note = cells.find((c) => c.row === rp[0]!.row && c.col === 26)?.value as string
    expect(note).toContain("分潤調整：\n115/03/10 主辦 測試員乙 20%→25%（原因：工作量增加）")
    // 成員格：本輪 → 本次金額
    expect(cells.find((c) => c.row === rp[0]!.row && c.col === 16)?.value).toBe("25.0 %\n3,000") // 主辦＝組員1 格
  })

  it("分潤調整讀取失敗 → 總表照出，備註不含調整，附 warning", async () => {
    fake.injectError({ table: "project_share_adjustments", action: "select", error: { message: "boom" } })
    const res = await as(T.boss)(request(app).get("/bonus-sheet"))
    expect(res.status).toBe(200)
    expect(res.body.warnings).toContain("分潤調整紀錄讀取失敗，備註暫不含分潤調整")
  })
})
