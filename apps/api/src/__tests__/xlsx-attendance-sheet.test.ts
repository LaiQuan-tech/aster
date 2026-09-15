import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import ExcelJS from "exceljs"
import { buildAttendanceWorkbook, workbookToBuffer } from "../lib/xlsx/index.js"
import { weekdayOfKey, zonedTimeToUtc } from "../lib/tz.js"
import type {
  SheetAnomaly,
  SheetDayView,
  SheetMoney,
  SheetTotals,
  SheetView,
} from "../services/attendance-sheet-types.js"

/**
 * buildAttendanceWorkbook / workbookToBuffer — 用 docs/test/fixtures/
 * attendance-115-06/yu-yuzhe.json（余裕哲，23 天有加班、其餘天無資料，見該
 * 目錄的 README）造一個假的 SheetView，人工加註 1 筆 override（6/9）＋
 * 2 筆異常（6/10 error、6/16 warn，fixture 本身沒有異常欄，這兩筆是純粹為了
 * 驗收條件而加的）、money 採 fixture 的 summaryExcel 數字。
 *
 * 每一個小節（起迄、加班、override 註解、彙總、money、假日底色）都跑一次
 * write → workbookToBuffer → 用 exceljs 重新 load，斷言的是「真的寫進 xlsx
 * 位元組、又讀得回來」的值，不是建構時的記憶體物件。
 */

const TPE = "Asia/Taipei"
const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(
  __dirname,
  "../../../../docs/test/fixtures/attendance-115-06/yu-yuzhe.json",
)

interface FixtureDay {
  date: string
  in: string | null
  out: string | null
  leaveHours: number
  otExcel: { le2: number; h3to8: number; h9to12: number }
  content: string | null
  outing: string | null
  project: string | null
}

interface Fixture {
  employee: {
    name: string
    title: string
    baseSalary: number
    laborInsurance: number
    healthInsurance: number
    pensionVoluntary: number
  }
  days: FixtureDay[]
  summaryExcel: {
    leaveHours: number
    otLe2: number
    otH3to8: number
    otH9to12: number
    otTotal: number
    hourly: number
    otPay: number
    leaveDeduction: number
    net: number
    expenses: number
    netPlusExpenses: number
  }
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture

function hoursToMinutes(h: number): number {
  return Math.round(h * 60)
}

function parseHm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number)
  return [h, m]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// 人工加註的情境：SheetDayView 本身沒有這幾樣真值，fixture 也沒有，這裡固定
// 指定到某幾天上，純粹為了驗收「override 加註解」「異常影響底色」。
const OVERRIDE_DATE = "2026-06-09"
const OVERRIDE_REASON = "主管酌減"
const OVERRIDE_MINUTES = 90 // 該日系統試算 2h（120 分），覆寫為 1.5h
const ERROR_DATE = "2026-06-10"
const ERROR_ANOMALY: SheetAnomaly = { code: "missing_out", severity: "error", message: "測試用 error 異常" }
const WARN_DATE = "2026-06-16"
const WARN_ANOMALY: SheetAnomaly = { code: "manual_punch", severity: "warn", message: "測試用 warn 異常" }
// 平日但整月無打卡資料的 gap（6/19 端午節，週五）：驗證「缺資料的日期只靠
// weekday 推假日」這個 fallback 的已知限制——見任務回報的取捨說明，這裡不
// 應該被誤判成假日淡灰（builder 沒有國定假日行事曆可查）。
const KNOWN_GAP_WEEKDAY_HOLIDAY = "2026-06-19"

function toDayView(d: FixtureDay): SheetDayView {
  const weekday = weekdayOfKey(d.date)
  const tier1 = hoursToMinutes(d.otExcel.le2)
  const tier2 = hoursToMinutes(d.otExcel.h3to8)
  const tier3 = hoursToMinutes(d.otExcel.h9to12)
  const computed = tier1 + tier2 + tier3
  const isOverride = d.date === OVERRIDE_DATE
  const override = isOverride ? OVERRIDE_MINUTES : null
  const firstIn = d.in ? zonedTimeToUtc(d.date, ...parseHm(d.in), TPE).toISOString() : null
  const lastOut = d.out ? zonedTimeToUtc(d.date, ...parseHm(d.out), TPE).toISOString() : null
  const anomalies: SheetAnomaly[] =
    d.date === ERROR_DATE ? [ERROR_ANOMALY] : d.date === WARN_DATE ? [WARN_ANOMALY] : []

  return {
    date: d.date,
    weekday,
    dayType: weekday === 0 || weekday === 6 ? "rest_day" : "workday",
    firstIn,
    lastOut,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    outingMinutes: 0,
    leaveMinutes: hoursToMinutes(d.leaveHours),
    leaveSummary: null,
    wfh: false,
    overtime: {
      computed,
      override,
      overrideReason: isOverride ? OVERRIDE_REASON : null,
      effective: override ?? computed,
      tier1,
      tier2,
      tier3,
    },
    content: d.content,
    outingNote: d.outing,
    projectId: null,
    projectName: d.project,
    note: null,
    anomalyAck: null,
    anomalies,
  }
}

const days = fixture.days.map(toDayView)

const totals: SheetTotals = {
  attendanceDays: days.length,
  workedMinutes: 0,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  leaveMinutes: hoursToMinutes(fixture.summaryExcel.leaveHours),
  leaveByType: {},
  otTier1: hoursToMinutes(fixture.summaryExcel.otLe2),
  otTier2: hoursToMinutes(fixture.summaryExcel.otH3to8),
  otTier3: hoursToMinutes(fixture.summaryExcel.otH9to12),
  otTotal: hoursToMinutes(fixture.summaryExcel.otTotal),
  overtimeMonthlyAlert: "46",
}

// gross/totalDeductions 不在 fixture 裡（只有 net/otPay/扣項的其中幾樣），用
// 引擎同款公式（net = gross − totalDeductions）反推，剛好與 summaryExcel.net
// 對上，money 區塊因此是內部一致、有依據的數字，不是隨手編的。
const grossAmount = round2(fixture.employee.baseSalary + fixture.summaryExcel.otPay)
const totalDeductionsAmount = round2(
  fixture.summaryExcel.leaveDeduction +
    fixture.employee.laborInsurance +
    fixture.employee.healthInsurance +
    fixture.employee.pensionVoluntary,
)

const money: SheetMoney = {
  hourlyWage: fixture.summaryExcel.hourly,
  otPay: fixture.summaryExcel.otPay,
  otPayByTier: { tier1: 8785.82, tier2: 3294.68, tier3: 0 }, // 依 40:15 時數比例分攤 otPay
  leaveDeduction: fixture.summaryExcel.leaveDeduction,
  lateEarlyDeduction: 0,
  laborInsurance: fixture.employee.laborInsurance,
  healthInsurance: fixture.employee.healthInsurance,
  pensionVoluntary: fixture.employee.pensionVoluntary,
  advance: 0,
  gross: grossAmount,
  totalDeductions: totalDeductionsAmount,
  expenses: fixture.summaryExcel.expenses,
  net: fixture.summaryExcel.net,
  netPlusExpenses: fixture.summaryExcel.netPlusExpenses,
}

const view: SheetView = {
  id: "sheet-yu-yuzhe",
  employeeId: "emp-yu-yuzhe",
  employeeName: fixture.employee.name,
  employeeNo: null,
  department: null,
  title: fixture.employee.title,
  period: "2026-06",
  status: "approved",
  managerEmpId: null,
  managerName: null,
  submittedAt: null,
  managerReviewedAt: null,
  approvedAt: "2026-07-02T03:00:00.000Z",
  lockedAt: null,
  returnedAt: null,
  returnReason: null,
  computedAt: null,
  days,
  monthAnomalies: [],
  totals,
  money,
  anomalyCount: { error: 1, warn: 1, info: 0 },
  frozen: true,
  ruleConfigVersion: 1,
}

const OPTS = {
  companyName: "亞斯特設計顧問有限公司",
  address: "新北市三重區新北大道2段260號5樓之2",
  phone: "",
  tz: TPE,
}

/** row for 'YYYY-MM-06-DD' in a June sheet: header is row 5, 6/1 is row 6. */
function rowOfJuneDay(day: number): number {
  return 5 + day
}

function argbOf(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as ExcelJS.FillPattern | undefined
  return fill && "fgColor" in fill ? fill.fgColor?.argb : undefined
}

describe("buildAttendanceWorkbook — 余裕哲 115-06 fixture", () => {
  let ws: ExcelJS.Worksheet

  beforeAll(async () => {
    const wb = buildAttendanceWorkbook([view], OPTS)
    expect(wb.worksheets).toHaveLength(1)
    expect(wb.worksheets[0].name).toBe("余裕哲")

    const buffer = await workbookToBuffer(wb)
    const reloaded = new ExcelJS.Workbook()
    // exceljs's own .d.ts declares a global `Buffer extends ArrayBuffer` that
    // merges (badly) with @types/node's newer generic `Buffer<TArrayBuffer>`,
    // making the merged global `Buffer` type fail to structurally match
    // itself (a known upstream typings bug, not a runtime issue — the probe
    // script that validated this whole read/write round trip used the exact
    // same value at runtime with no cast at all). `as unknown as Buffer`
    // still resolves to that same broken type, so route through `any`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reloaded.xlsx.load(buffer as any)
    const sheet = reloaded.getWorksheet("余裕哲")
    if (!sheet) throw new Error("worksheet '余裕哲' missing after reload")
    ws = sheet
  })

  it("sheet 名稱＝姓名", () => {
    expect(ws.name).toBe("余裕哲")
  })

  it("A4 標題含民國年月與姓名", () => {
    const title = String(ws.getCell("A4").value)
    expect(title).toContain("115年6月")
    expect(title).toContain("余裕哲")
  })

  it("列 5 表頭 12 欄依序", () => {
    const row = ws.getRow(5)
    const labels = Array.from({ length: 12 }, (_, i) => row.getCell(i + 1).value)
    expect(labels).toEqual([
      "日期",
      "星期",
      "起",
      "迄",
      "請假",
      "加班(≤2h)",
      "3-8h",
      "9-12h",
      "內容",
      "外出／專案",
      "備註",
      "異常",
    ])
  })

  it("第 6 列（6/1）日期／星期／起迄／加班值", () => {
    const row = ws.getRow(rowOfJuneDay(1))
    const date = row.getCell(1).value as Date
    expect(date.getUTCFullYear()).toBe(2026)
    expect(date.getUTCMonth() + 1).toBe(6)
    expect(date.getUTCDate()).toBe(1)
    expect(row.getCell(2).value).toBe("一")

    const start = row.getCell(3).value as Date
    expect(start.getUTCHours()).toBe(19)
    expect(start.getUTCMinutes()).toBe(4)
    const end = row.getCell(4).value as Date
    expect(end.getUTCHours()).toBe(21)
    expect(end.getUTCMinutes()).toBe(9)

    expect(row.getCell(5).value).toBe(0) // 請假
    expect(row.getCell(6).value).toBe(2) // 加班(≤2h)：le2=2
    expect(row.getCell(7).value).toBe(0) // 3-8h
    expect(row.getCell(8).value).toBe(0) // 9-12h
    expect(row.getCell(12).value ?? "").toBe("") // 無異常
  })

  it("6/10 有外出地點、且 error 異常把整列填成淡紅底", () => {
    const row = ws.getRow(rowOfJuneDay(10))
    expect(row.getCell(10).value).toBe("高雄")
    expect(row.getCell(12).value).toBe("測試用 error 異常")
    expect(argbOf(row.getCell(1))).toBe("FFFFC7CE")
    expect(argbOf(row.getCell(12))).toBe("FFFFC7CE")
  })

  it("6/16 有外出地點、且 warn 異常把整列填成淡黃底", () => {
    const row = ws.getRow(rowOfJuneDay(16))
    expect(row.getCell(10).value).toBe("屏東")
    expect(row.getCell(12).value).toBe("測試用 warn 異常")
    expect(argbOf(row.getCell(1))).toBe("FFFFEB9C")
  })

  it("6/9 override：欄位仍顯示系統試算，(≤2h) 格帶註解", () => {
    const row = ws.getRow(rowOfJuneDay(9))
    const tier1Cell = row.getCell(6)
    expect(tier1Cell.value).toBe(2) // 系統試算 2h（未被 override 改變顯示值，見任務回報的取捨）
    expect(tier1Cell.note).toBe("系統 2.0 → 覆寫 1.5：主管酌減")
  })

  it("整月每天都列：週六（6/6，無資料）補一列且淡灰底", () => {
    const row = ws.getRow(rowOfJuneDay(6))
    const date = row.getCell(1).value as Date
    expect(date.getUTCDate()).toBe(6)
    expect(row.getCell(2).value).toBe("六")
    expect(row.getCell(3).value ?? null).toBeNull() // 無打卡
    expect(argbOf(row.getCell(1))).toBe("FFF2F2F2")
  })

  it("已知限制：缺資料的平日國定假日（6/19 端午）不會被誤判成假日淡灰", () => {
    const day = 19
    expect(KNOWN_GAP_WEEKDAY_HOLIDAY).toBe("2026-06-19")
    const row = ws.getRow(rowOfJuneDay(day))
    expect(row.getCell(2).value).toBe("五")
    expect(argbOf(row.getCell(1))).not.toBe("FFF2F2F2")
  })

  it("彙總區：加班總時數 55（40+15 小時）", () => {
    const labelRow = ws.getRow(37)
    expect(labelRow.getCell(5).value).toBe("加班總時數")
    const valueRow = ws.getRow(38)
    expect(valueRow.getCell(5).value).toBeCloseTo(55, 5)
  })

  it("money 區：實領 47533.5", () => {
    const labelRow = ws.getRow(40)
    expect(labelRow.getCell(14).value).toBe("實領")
    const valueRow = ws.getRow(41)
    expect(valueRow.getCell(14).value).toBeCloseTo(47533.5, 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

function minimalView(id: string, employeeName: string): SheetView {
  return {
    id,
    employeeId: id,
    employeeName,
    employeeNo: null,
    department: null,
    title: null,
    period: "2026-06",
    status: "draft",
    managerEmpId: null,
    managerName: null,
    submittedAt: null,
    managerReviewedAt: null,
    approvedAt: null,
    lockedAt: null,
    returnedAt: null,
    returnReason: null,
    computedAt: null,
    days: [],
    monthAnomalies: [],
    totals: {
      attendanceDays: 0,
      workedMinutes: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      leaveMinutes: 0,
      leaveByType: {},
      otTier1: 0,
      otTier2: 0,
      otTier3: 0,
      otTotal: 0,
      overtimeMonthlyAlert: "none",
    },
    money: null,
    anomalyCount: { error: 0, warn: 0, info: 0 },
    frozen: false,
    ruleConfigVersion: null,
  }
}

describe("buildAttendanceWorkbook — edge cases", () => {
  it("views=[] 回傳空 workbook、不丟錯，且能正常序列化", async () => {
    const wb = buildAttendanceWorkbook([], OPTS)
    expect(wb.worksheets).toHaveLength(0)
    const buffer = await workbookToBuffer(wb)
    expect(buffer.length).toBeGreaterThan(0)
  })

  it("兩個同名員工的 sheet 名不會相撞", () => {
    const wb = buildAttendanceWorkbook(
      [minimalView("a", "測試員工"), minimalView("b", "測試員工")],
      OPTS,
    )
    expect(wb.worksheets).toHaveLength(2)
    const names = wb.worksheets.map((s) => s.name)
    expect(new Set(names).size).toBe(2)
    expect(names[0]).toBe("測試員工")
    expect(names[1]).not.toBe("測試員工")
    expect(names[1]).toContain("測試員工")
  })
})
