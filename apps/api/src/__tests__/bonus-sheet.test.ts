import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import ExcelJS from "exceljs"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，獎金批次 store 換成 mock；不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../services/bonus-run-store.js", () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  previewRun: vi.fn(),
  loadInputs: vi.fn(),
  tenantToday: vi.fn(async () => "2026-10-27"),
}))

import { bonusSheetRouter, parseBonusSheetQuery } from "../routes/bonus-sheet.js"
import { getRun, listRuns, loadInputs, previewRun, type SerializedItem, type SerializedRun } from "../services/bonus-run-store.js"
import { defaultRunOf, projectsFromItems } from "../services/bonus-sheet.js"
import {
  CLOSED_COLUMNS,
  OPEN_COLUMNS,
  OPEN_HEADER_ROWS,
  buildClosedSheet,
  buildOpenSheet,
  excelPoolOf,
  isInThisRound,
  memberSlots,
  mmddOf,
  noteOf,
  periodLabelOf,
  taxed,
  type BonusSheetMember,
  type BonusSheetProject,
} from "../lib/statements/bonus-sheet.js"
import { formatCellText, type GridCell, type StatementGrid } from "../lib/statements/grid.js"
import { buildStatementWorkbook } from "../lib/xlsx/statement-grid.js"
import { ASTER_LOGO_PNG_BASE64, ASTER_LOGO_PNG_HEIGHT, ASTER_LOGO_PNG_WIDTH } from "../lib/brand/aster-logo.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 獎金分潤總表（GET /bonus-sheet；lib/statements/bonus-sheet.ts、services/bonus-sheet.ts）。
 * ⚠️ 全部是明顯的假值（測試員甲／測試案一／T-0001），不放任何真實姓名、案名、金額。
 */

const ctx = { companyName: "測試公司", vatRate: 0.05, periodLabel: "2026. 07-09", mmdd: "0909" }

function member(over: Partial<BonusSheetMember> & { employeeId: string }): BonusSheetMember {
  return { name: `測試員${over.employeeId}`, empNo: null, role: "member", shareMode: "pool_pct", sharePct: 10, shareAmount: null, amount: 0, ...over }
}

function project(over: Partial<BonusSheetProject> = {}): BonusSheetProject {
  return {
    projectId: "p1",
    code: "T-0001",
    name: "測試案一",
    closed: false,
    contractTotal: 1000000,
    receivedTotal: 600000,
    previousReceived: 400000,
    currentReceived: 200000,
    receivedRatio: 0.6,
    previousRatio: 0.4,
    currentRatio: 0.2,
    bonusRatePct: 10,
    pool: 50000,
    basis: "gross_profit",
    currentBonus: 12000,
    overpaidBy: 0,
    unallocatedPct: 20,
    note: null,
    skipped: null,
    members: [
      member({ employeeId: "甲", role: "manager", sharePct: 40, amount: 6000 }),
      member({ employeeId: "乙", role: "member", sharePct: 20, amount: 3000 }),
      member({ employeeId: "丙", role: "lead", sharePct: 20, amount: 3000 }),
    ],
    ...over,
  }
}

const at = (grid: StatementGrid, row: number, col: number): GridCell | undefined => grid.cells.find((c) => c.row === row && c.col === col)

describe("純函式", () => {
  it("taxed：未稅 ×（1＋稅率）到元；null 照傳", () => {
    expect(taxed(1000000, 0.05)).toBe(1050000)
    expect(taxed(333, 0.05)).toBe(350)
    expect(taxed(null, 0.05)).toBeNull()
  })

  it("periodLabelOf／mmddOf：期別標籤優先，否則用基準日的季", () => {
    expect(periodLabelOf("2026-Q3", "2026-09-09")).toBe("2026. 07-09")
    expect(periodLabelOf("年中加發", "2026-02-10")).toBe("2026. 01-03")
    expect(periodLabelOf(null, "2026-12-31")).toBe("2026. 10-12")
    expect(mmddOf("2026-09-09")).toBe("0909")
    expect(mmddOf("2026-09-09", true)).toBe("09/09")
  })

  it("isInThisRound：有本次入帳或本次獎金才算", () => {
    expect(isInThisRound({ currentReceived: 1, currentBonus: 0 })).toBe(true)
    expect(isInThisRound({ currentReceived: 0, currentBonus: 5 })).toBe(true)
    expect(isInThisRound({ currentReceived: 0, currentBonus: 0 })).toBe(false)
  })

  it("memberSlots：經理 1、組員 4（主辦優先）、支援 1，多的進 overflow", () => {
    const s = memberSlots([
      member({ employeeId: "1", role: "member", empNo: "E1" }),
      member({ employeeId: "2", role: "lead", empNo: "E9" }),
      member({ employeeId: "3", role: "manager", empNo: "E2" }),
      member({ employeeId: "4", role: "manager", empNo: "E3" }),
      member({ employeeId: "5", role: "support", empNo: "E4" }),
      member({ employeeId: "6", role: "member", empNo: "E5" }),
      member({ employeeId: "7", role: null, empNo: "E6" }),
      member({ employeeId: "8", role: "member", empNo: "E7" }),
    ])
    expect(s.manager?.employeeId).toBe("3")
    expect(s.team.map((m) => m?.employeeId)).toEqual(["2", "1", "6", "8"])
    expect(s.support?.employeeId).toBe("5")
    expect(s.overflow.map((m) => m.employeeId)).toEqual(["4", "7"])
    expect(memberSlots([]).team).toEqual([null, null, null, null])
  })

  it("noteOf：制度、跳過、多出成員、超發在前，專案說明在後", () => {
    const p = project({ basis: "legacy_pool", overpaidBy: 1234, note: "說明文字", skipped: "no_pool" })
    expect(noteOf(p, [member({ employeeId: "戊", sharePct: 5 })])).toBe("舊制（手填獎金池 50,000）；未列入獎金試算：缺獎金池；其他分配：測試員戊 5%；超發 1,234；說明文字")
    expect(noteOf(project(), [])).toBe("")
  })

  it("excelPoolOf：含稅×比例；沒比例或沒合約 null", () => {
    expect(excelPoolOf({ contractTotal: 1000000, bonusRatePct: 8 }, 0.05)).toBe(84000)
    expect(excelPoolOf({ contractTotal: 1000000, bonusRatePct: null }, 0.05)).toBeNull()
    expect(excelPoolOf({ contractTotal: null, bonusRatePct: 8 }, 0.05)).toBeNull()
  })

  it("formatCellText：百分比與紅字千分位格式", () => {
    expect(formatCellText(0.125, "pct1")).toBe("12.5 %")
    expect(formatCellText(0.6, "pct0")).toBe("60%")
    expect(formatCellText(-1234, "intRed")).toBe("-1,234")
    expect(formatCellText(1234567, "intRed")).toBe("1,234,567")
  })
})

describe("buildOpenSheet（未結案）", () => {
  const grid = buildOpenSheet([project(), project({ projectId: "p2", code: "T-0002", name: "測試案二", currentReceived: 0, currentBonus: 0, currentRatio: 0 })], ctx)
  const r1 = OPEN_HEADER_ROWS
  const r2 = OPEN_HEADER_ROWS + 1

  it("欄數／欄寬／凍結／版面照原檔", () => {
    expect(grid.columns).toHaveLength(33)
    expect(grid.columns).toEqual(OPEN_COLUMNS)
    expect(grid.freeze).toEqual({ rows: 4, cols: 4 })
    expect(grid.page).toMatchObject({ orientation: "landscape", paperSize: 8, printTitleRows: [1, 4] })
    expect(grid.rowHeights.slice(0, 5)).toEqual([16.5, 17.5, 31, 21, 10])
  })

  it("表頭字串與合併", () => {
    const headers: Array<[number, number, string]> = [
      [2, 0, "序號"], [2, 1, "2026. 07-09"], [2, 2, "專案單號"], [2, 3, "工程名稱"], [2, 4, "含稅"], [2, 5, "已收款"], [2, 6, "已收款%"],
      [2, 7, "本次\n請款%"], [3, 7, "0909"], [2, 8, "累積 %"], [2, 9, "本次\n請款"], [3, 9, "0909"], [2, 10, "累積 %"],
      [2, 11, "本次\n獎金"], [3, 11, "09/09"], [2, 12, "獎金比例"], [3, 12, "%"], [3, 13, "總獎金"],
      [2, 14, "經理"], [2, 17, "組員1"], [2, 20, "組員2"], [2, 23, "組員3"], [2, 26, "組員4"], [2, 28, "支援"], [2, 30, "尚未分配"], [2, 31, "備註"],
    ]
    for (const [r, c, text] of headers) expect(at(grid, r, c)?.value, `${r}:${c}`).toBe(text)
    expect(at(grid, 2, 0)).toMatchObject({ rowSpan: 2 })
    expect(at(grid, 2, 12)).toMatchObject({ colSpan: 2 })
    expect(at(grid, 0, 12)).toMatchObject({ value: "獎金分配(員工自行向行政申報)", rowSpan: 2, colSpan: 20 })
    expect(at(grid, 0, 0)).toMatchObject({ value: "ASTER", logo: true, rowSpan: 2, colSpan: 3 })
    expect(at(grid, 0, 3)).toMatchObject({ value: "測試公司", colSpan: 4 })
    // 表頭雙線、本次欄淡綠
    expect(at(grid, 2, 0)?.border).toMatchObject({ top: "double", bottom: "double" })
    for (const c of [7, 9, 11]) expect(at(grid, 2, c)?.fill).toBe("#E2EFDA")
  })

  it("資料列：含稅＝未稅×1.05、百分比、紅字欄、本次列上色與 V", () => {
    expect(at(grid, r1, 1)?.value).toBe("V")
    expect(at(grid, r1, 4)).toMatchObject({ value: 1050000, text: "1,050,000" })
    expect(at(grid, r1, 5)).toMatchObject({ value: 420000, fill: "#DDEBF7" })
    expect(at(grid, r1, 6)).toMatchObject({ value: 0.4, text: "40%" })
    expect(at(grid, r1, 7)).toMatchObject({ value: 0.2, fill: "#E2EFDA" })
    expect(at(grid, r1, 8)?.text).toBe("60%")
    expect(at(grid, r1, 9)).toMatchObject({ value: 210000, fill: "#E2EFDA" })
    expect(at(grid, r1, 11)).toMatchObject({ value: 12000, fill: "#E2EFDA" })
    expect(at(grid, r1, 12)).toMatchObject({ text: "10.0 %", color: "#FF0000" })
    // 總獎金＝含稅×比例（原檔 N＝M×E）：1,050,000 × 10%
    expect(at(grid, r1, 13)).toMatchObject({ value: 105000, color: "#FF0000" })
    // 經理、組員1（主辦優先）、組員2
    expect(at(grid, r1, 14)).toMatchObject({ value: "測試員甲", fill: "#E7E6E6" })
    expect(at(grid, r1, 15)).toMatchObject({ text: "40.0 %", color: "#FF0000" })
    expect(at(grid, r1, 16)?.value).toBe(6000)
    expect(at(grid, r1, 17)?.value).toBe("測試員丙")
    expect(at(grid, r1, 20)?.value).toBe("測試員乙")
    expect(at(grid, r1, 30)).toMatchObject({ text: "20.0 %", color: "#FF0000" })
    // 沒有本次的列：不打 V、不上色、本次欄空白
    expect(at(grid, r2, 1)?.value).toBeNull()
    expect(at(grid, r2, 7)?.fill).toBeUndefined()
    expect(at(grid, r2, 9)?.value).toBeNull()
    expect(at(grid, r2, 5)?.fill).toBeUndefined()
  })

  it("合計列：本次請款、本次獎金、總獎金", () => {
    const tr = OPEN_HEADER_ROWS + 2
    expect(at(grid, tr, 3)?.value).toBe("合計")
    expect(at(grid, tr, 9)?.value).toBe(210000)
    expect(at(grid, tr, 11)?.value).toBe(12000)
    expect(at(grid, tr, 13)?.value).toBe(210000)
  })

  it("固定金額成員：% 欄顯示金額；沒合約的百分比空白", () => {
    const g = buildOpenSheet([project({ contractTotal: null, members: [member({ employeeId: "丁", role: "manager", shareMode: "fixed_amount", sharePct: null, shareAmount: 30000 })] })], ctx)
    expect(at(g, r1, 15)).toMatchObject({ value: 30000, text: "30,000" })
    expect(at(g, r1, 6)?.value).toBeNull()
    expect(at(g, r1, 4)?.value).toBeNull()
  })
})

describe("buildClosedSheet（已結案）", () => {
  it("欄數、表頭與資料", () => {
    const g = buildClosedSheet([project({ closed: true })], ctx)
    expect(g.columns).toHaveLength(22)
    expect(g.columns).toEqual(CLOSED_COLUMNS)
    expect(at(g, 0, 3)?.value).toBe("測試公司 (已結案) 獎金分配(員工自行向行政申報)")
    for (const [c, text] of [[0, "序號"], [1, "專案單號"], [2, "工程名稱"], [3, "含稅"], [4, "已收款"], [5, "已收款%"], [6, "獎金比例"], [8, "經理"], [10, "組員1"], [18, "支援"], [20, "尚未分配"]] as const)
      expect(at(g, 2, c)?.value, String(c)).toBe(text)
    expect(at(g, 3, 6)?.value).toBe("%")
    expect(at(g, 3, 7)?.value).toBe("金額")
    expect(at(g, 4, 4)?.value).toBe(630000)
    expect(at(g, 4, 7)).toMatchObject({ value: 105000, color: "#FF0000" })
  })
})

function item(over: Partial<SerializedItem> & { projectId: string; employeeId: string }): SerializedItem {
  return {
    id: null, runId: null, projectCode: "T-0001", projectName: "測試案一", employeeName: "測試員甲", empNo: null, roleInProject: "manager",
    shareMode: "pool_pct", sharePct: 50, shareAmount: null, bonusPool: 40000, bonusRatePct: 10, contractTotal: 1000000, receivedTotal: 500000,
    receivedPct: 0.5, previousReceived: 300000, previousReceivedPct: 0.3, currentReceived: 200000, currentReceivedPct: 0.2, unallocatedPct: 0,
    projectNote: null, entitledCumulative: 20000, paidBefore: 10000, amount: 10000, overpaid: false, overpaidBy: 0, basis: "gross_profit",
    revenue: 500000, cost: 100000, disbursementCost: 0, subcontractCost: 0, grossProfit: 400000, overContractPct: null,
    ...over,
  }
}

describe("projectsFromItems", () => {
  it("依專案分組、本次獎金加總、尚未分配以成員趴數重算；跳過的案補一列", () => {
    const projects = projectsFromItems(
      [
        item({ projectId: "p1", employeeId: "e1", amount: 10000 }),
        item({ projectId: "p1", employeeId: "e2", roleInProject: "member", employeeName: "測試員乙", sharePct: 30, amount: 6000, overpaid: true, overpaidBy: 500 }),
      ],
      {
        projects: [{ projectId: "p9", code: "T-0009", name: "測試案九", contractTotal: 200000, receivedTotal: 50000, bonusRatePct: null, bonusPool: null, basis: "legacy_pool", skipped: true }],
        skipped: [{ projectId: "p9", reason: "no_pool" }],
      },
    )
    expect(projects).toHaveLength(2)
    const p1 = projects.find((p) => p.projectId === "p1")!
    expect(p1).toMatchObject({ currentBonus: 16000, unallocatedPct: 20, overpaidBy: 500, pool: 40000, currentReceived: 200000, previousRatio: 0.3 })
    expect(p1.members.map((m) => m.role)).toEqual(["manager", "member"])
    const p9 = projects.find((p) => p.projectId === "p9")!
    expect(p9).toMatchObject({ skipped: "no_pool", members: [], receivedRatio: 0.25, currentReceived: 0, basis: "legacy_pool" })
  })
})

describe("xlsx 版面", () => {
  it("兩張工作表、欄數、合併、表頭字串、凍結、紅字、底色、雙線", async () => {
    const open = buildOpenSheet([project()], ctx)
    const closed = buildClosedSheet([project({ closed: true })], ctx)
    const wb = await buildStatementWorkbook([open, closed], "test", {
      logoPng: { base64: ASTER_LOGO_PNG_BASE64, width: ASTER_LOGO_PNG_WIDTH, height: ASTER_LOGO_PNG_HEIGHT },
    })
    const buf = await wb.xlsx.writeBuffer()
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(buf as ArrayBuffer)
    expect(back.worksheets.map((w) => w.name)).toEqual(["未結案", "已結案"])
    const ws = back.getWorksheet("未結案")!
    expect(ws.columnCount).toBe(32) // A–AF 有格子；AG 只是欄寬
    expect(ws.getColumn(33).width).toBeCloseTo(0.54)
    const merges = (ws.model as unknown as { merges: string[] }).merges
    for (const m of ["A1:C2", "D1:G2", "M1:AF2", "A3:A4", "B3:B4", "M3:N3", "O3:O4", "R3:R4", "AA3:AA4", "AC3:AC4", "AE3:AE4", "AF3:AF4"]) expect(merges).toContain(m)
    // 標誌：兩張表左上各插一張圖，標誌格不寫字
    expect(ws.getImages()).toHaveLength(1)
    expect(ws.getImages()[0]!.range.tl.nativeRow).toBe(0)
    expect(ws.getCell("A1").value).toBeNull()
    expect(back.getWorksheet("已結案")!.getImages()).toHaveLength(1)
    expect(ws.getCell("A3").value).toBe("序號")
    expect(ws.getCell("H3").value).toBe("本次\n請款%")
    expect(ws.getCell("H4").value).toBe("0909")
    expect(ws.getCell("M3").value).toBe("獎金比例")
    expect(ws.getCell("N4").value).toBe("總獎金")
    expect(ws.getCell("O3").value).toBe("經理")
    expect(ws.getCell("AE3").value).toBe("尚未分配")
    // 合併格的框線畫在範圍邊緣：A3:A4 上緣在 A3、下緣在 A4
    expect(ws.getCell("A3").border?.top?.style).toBe("double")
    expect(ws.getCell("A4").border?.bottom?.style).toBe("double")
    expect((ws.getCell("H3").fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFE2EFDA")
    expect(ws.getCell("M6").numFmt).toMatch(/^0\.0\\? %$/) // 原檔「0.0\ %」（exceljs 讀回時去掉跳脫）
    expect(ws.getCell("M6").font?.color?.argb).toBe("FFFF0000")
    expect(ws.getCell("E6").numFmt).toBe("#,##0;[Red]-#,##0")
    expect(ws.getCell("E6").value).toBe(1050000)
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 4, ySplit: 4 })
    expect(ws.pageSetup).toMatchObject({ orientation: "landscape", paperSize: 8 })
    const ws2 = back.getWorksheet("已結案")!
    expect(ws2.getCell("G3").value).toBe("獎金比例")
    expect(ws2.getCell("H4").value).toBe("金額")
    expect((ws2.model as unknown as { merges: string[] }).merges).toContain("G3:H3")
  })
})

// ── 路由：權限＋降級 ─────────────────────────────────────────────────

const app = express()
app.use(express.json())
app.use(bonusSheetRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = { boss: emp(1), hr: emp(2), grantedHr: emp(3), platform: emp(4), accountant: emp(5), staff: emp(6) }
const T = { boss: "boss-user", hr: "hr-user", grantedHr: "granted-hr-user", platform: "platform-user", accountant: "accountant-user", staff: "staff-user" }
const RUN_ID = "cccccccc-0000-4000-8000-000000000001"
const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)

function empRow(id: string, userId: string, role: string, features: Record<string, unknown> = {}) {
  return { id, tenant_id: TENANT_ID, user_id: userId, name: "測試人員", role, dept_id: null, emp_no: null, status: "active", employment_type: "regular", must_change_password: false, features, default_shift_id: null }
}

const run: SerializedRun = {
  id: RUN_ID, label: "2026-Q3", asOf: "2026-09-09", status: "paid", kind: "regular", reversesRunId: null, reversedByRunId: null, reversedByStatus: null,
  paidOn: "2026-09-10", totals: { amount: 0, entitledCumulative: 0, paidBefore: 0, itemCount: 0, employeeCount: 0, projectCount: 0, overpaidCount: 0, skipped: [] },
  note: null, createdByEmpId: null, paidByEmpId: null, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
  submittedAt: null, submittedByEmpId: null, approvedAt: null, approvedByEmpId: null, approvedAmount: null, returnedAt: null, returnedByEmpId: null, returnReason: null, selfApproved: false,
}

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, name: "測試公司", branding: {}, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: E.boss } } }]
  fake.db.employees = [
    empRow(E.boss, T.boss, "hr_admin"),
    empRow(E.hr, T.hr, "hr_admin"),
    empRow(E.grantedHr, T.grantedHr, "hr_admin", { seeGroupFinancials: true }),
    empRow(E.platform, T.platform, "platform_admin"),
    empRow(E.accountant, T.accountant, "accountant", { seeGroupFinancials: true }),
    empRow(E.staff, T.staff, "employee"),
  ]
  fake.db.departments = []
  fake.db.companies = []
  fake.db.project_settings = [{ tenant_id: TENANT_ID, vat_rate: "0.05", disciplines: [] }]
  fake.db.projects = [
    { id: "p1", tenant_id: TENANT_ID, status: "active", archived_at: null },
    { id: "p2", tenant_id: TENANT_ID, status: "closed", archived_at: null },
  ]
  vi.mocked(listRuns).mockReset().mockResolvedValue([run])
  vi.mocked(loadInputs).mockReset().mockResolvedValue({ projects: [], projectMeta: new Map(), employeeMeta: new Map(), archiveStage: new Map() })
  vi.mocked(getRun).mockReset().mockResolvedValue({
    run,
    // p2 已結案且這批沒有本次入帳／獎金 → 已結案表
    items: [item({ projectId: "p1", employeeId: "e1" }), item({ projectId: "p2", employeeId: "e1", projectCode: "T-0002", projectName: "測試案二", amount: 0, currentReceived: 0, currentReceivedPct: 0, previousReceived: 500000, previousReceivedPct: 0.5 })],
    snapshot: { projects: [] },
  })
  vi.mocked(previewRun).mockReset().mockResolvedValue({ asOf: "2026-10-27", items: [item({ projectId: "p1", employeeId: "e1" })], totals: run.totals, snapshot: { projects: [] }, calc: [], projectMeta: new Map(), employeeMeta: new Map() })
})

describe("GET /bonus-sheet — 權限", () => {
  it("老闆、platform_admin、授權 HR → 200；未授權 HR、會計（即使旗標誤設）、一般員工 → 403", async () => {
    for (const t of [T.boss, T.platform, T.grantedHr]) expect((await as(t)(request(app).get("/bonus-sheet"))).status, t).toBe(200)
    for (const t of [T.hr, T.accountant, T.staff]) {
      const res = await as(t)(request(app).get("/bonus-sheet"))
      expect(res.status, t).toBe(403)
      expect(res.body).toEqual({ error: "group_financials_forbidden" })
      expect((await as(t)(request(app).get("/bonus-sheet/export.xlsx"))).status, t).toBe(403)
    }
    expect(getRun).toHaveBeenCalledTimes(3)
  })
})

describe("GET /bonus-sheet — 資料與降級", () => {
  it("預設＝最新一般批次；未結案／已結案依專案狀態分表", async () => {
    const res = await as(T.boss)(request(app).get("/bonus-sheet"))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ source: "run", asOf: "2026-09-09", periodLabel: "2026. 07-09", mmdd: "0909", vatRate: 0.05, counts: { open: 1, closed: 1 }, warnings: [] })
    expect(res.body.run).toMatchObject({ id: RUN_ID, label: "2026-Q3" })
    expect(res.body.sheets.open.title).toBe("未結案")
    expect(res.body.sheets.closed.title).toBe("已結案")
    expect(getRun).toHaveBeenCalledWith(TENANT_ID, RUN_ID)
  })

  it("已結案但這批還有本次獎金 → 留在未結案（本次獎金不會從總表消失）", async () => {
    vi.mocked(getRun).mockResolvedValue({ run, items: [item({ projectId: "p2", employeeId: "e1", amount: 7000 })], snapshot: null })
    const res = await as(T.boss)(request(app).get("/bonus-sheet"))
    expect(res.body.counts).toEqual({ open: 1, closed: 0 })
  })

  it("預設批次：優先已發放且沒被沖銷的一般批次", async () => {
    const draft = { ...run, id: "cccccccc-0000-4000-8000-000000000002", asOf: "2026-12-01", status: "draft" as const }
    const reversed = { ...run, id: "cccccccc-0000-4000-8000-000000000003", asOf: "2026-11-01", reversedByRunId: "x" }
    const reversal = { ...run, id: "cccccccc-0000-4000-8000-000000000004", kind: "reversal" as const }
    expect(defaultRunOf([draft, reversed, reversal, run])?.id).toBe(RUN_ID)
    expect(defaultRunOf([draft, reversed])?.id).toBe(draft.id)
    expect(defaultRunOf([reversal])).toBeNull()
  })

  it("沒有成員（不在批次內）的專案也列出：成員欄空白、沒有本次；複製取代的原案不列", async () => {
    fake.db.projects.push(
      { id: "p3", tenant_id: TENANT_ID, status: "active", archived_at: null, archive_reason: null },
      { id: "p4", tenant_id: TENANT_ID, status: "active", archived_at: "2026-09-01T00:00:00Z", archive_reason: "已由 T-0099 取代：重開" },
    )
    vi.mocked(loadInputs).mockResolvedValue({
      projects: [{ projectId: "p3", shareMode: "pool_pct", bonusPool: null, bonusRatePct: 10, projectNote: null, contractTotal: 200000, receivedTotal: 100000, members: [] }],
      projectMeta: new Map([["p3", { id: "p3", code: "T-0003", name: "測試案三" }]]),
      employeeMeta: new Map(),
      archiveStage: new Map(),
    })
    const res = await as(T.boss)(request(app).get("/bonus-sheet"))
    expect(loadInputs).toHaveBeenCalledWith(TENANT_ID, "2026-09-09", { projectIds: ["p3"], archiveRule: "all" })
    expect(res.body.counts).toEqual({ open: 2, closed: 1 })
    const cells = res.body.sheets.open.cells as GridCell[]
    const row = cells.find((c) => c.value === "T-0003")!.row
    const cell = (col: number) => cells.find((c) => c.row === row && c.col === col)
    expect(cell(4)?.value).toBe(210000) // 含稅
    expect(cell(5)?.value).toBe(105000) // 已收款（累計都算之前）
    expect(cell(9)?.value).toBeNull() // 沒有本次請款
    expect(cell(13)?.value).toBe(21000) // 總獎金＝含稅×比例
    expect(cell(14)?.value).toBeNull() // 經理空白
    expect(cell(30)?.value).toBeNull() // 沒成員 → 尚未分配空白
  })

  it("asOf → 即時試算", async () => {
    const res = await as(T.boss)(request(app).get("/bonus-sheet?asOf=2026-10-01"))
    expect(res.body).toMatchObject({ source: "preview", asOf: "2026-10-01", mmdd: "1001", periodLabel: "2026. 10-12" })
    expect(previewRun).toHaveBeenCalledWith(TENANT_ID, "2026-10-01", null)
    expect(getRun).not.toHaveBeenCalled()
  })

  it("批次清單、批次明細讀取失敗 → 改用今天的試算，回 warnings", async () => {
    vi.mocked(listRuns).mockRejectedValue(new Error("boom"))
    let res = await as(T.boss)(request(app).get("/bonus-sheet"))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ source: "preview", runs: [], asOf: "2026-10-27" })
    expect(res.body.warnings).toContain("獎金批次清單讀取失敗，批次選單暫時空白")

    vi.mocked(listRuns).mockResolvedValue([run])
    vi.mocked(getRun).mockRejectedValue(new Error("boom"))
    res = await as(T.boss)(request(app).get(`/bonus-sheet?runId=${RUN_ID}`))
    expect(res.status).toBe(200)
    expect(res.body.source).toBe("preview")
    expect(res.body.warnings).toContain("獎金批次明細讀取失敗，改用今天的即時試算")
  })

  it("試算也失敗 → 空表；專案狀態、稅率、公司名稱讀不到 → 降級", async () => {
    vi.mocked(previewRun).mockRejectedValue(new Error("boom"))
    let res = await as(T.boss)(request(app).get("/bonus-sheet?asOf=2026-10-01"))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ source: "empty", counts: { open: 0, closed: 0 } })
    expect(res.body.warnings).toContain("即時試算失敗，總表暫時沒有資料")

    // 第一次讀 projects（批次以外的專案）、第二次（結案狀態）都失敗
    fake.injectError({ table: "projects", action: "select", error: { message: "boom" } })
    fake.injectError({ table: "projects", action: "select", error: { message: "boom" } })
    fake.injectError({ table: "project_settings", action: "select", error: { message: "boom" } })
    res = await as(T.boss)(request(app).get("/bonus-sheet"))
    expect(res.status).toBe(200)
    expect(res.body.counts).toEqual({ open: 2, closed: 0 })
    expect(res.body.vatRate).toBe(0.05)
    expect(res.body.warnings).toEqual(
      expect.arrayContaining(["批次以外的專案讀取失敗，只列批次內的專案", "專案結案狀態讀取失敗，全部列在「未結案」", "營業稅率讀取失敗，含稅金額暫以 5% 計"]),
    )
  })

  it("指定的批次不存在 → 404；參數格式錯 → 400", async () => {
    vi.mocked(getRun).mockResolvedValue(null)
    expect((await as(T.boss)(request(app).get(`/bonus-sheet?runId=${RUN_ID}`))).status).toBe(404)
    expect((await as(T.boss)(request(app).get("/bonus-sheet?runId=abc"))).body).toEqual({ error: "invalid_query", param: "runId" })
    expect((await as(T.boss)(request(app).get("/bonus-sheet?asOf=2026-02-30"))).body).toEqual({ error: "invalid_query", param: "asOf" })
    expect(parseBonusSheetQuery({})).toEqual({ ok: true, runId: null, asOf: null })
  })

  it("export.xlsx：回 xlsx、兩張工作表", async () => {
    const res = await as(T.grantedHr)(request(app).get("/bonus-sheet/export.xlsx"))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on("data", (c: Buffer) => chunks.push(c))
        r.on("end", () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
    expect(res.headers["content-disposition"]).toContain(encodeURIComponent("專案獎金總表-20260909.xlsx"))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(["未結案", "已結案"])
  })
})
