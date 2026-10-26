import type { SheetDayView, SheetView } from "../../services/attendance-sheet-types.js"
import type { StatementData, StatementMoney } from "../../lib/statements/types.js"
import { moneyFromBreakdown } from "../../services/employee-statements.js"

/**
 * 出勤統計表／薪資明細表的假資料（純測試與本機渲染用）。
 * ⚠️ 姓名、公司、金額全是明顯的假值；不要放真實個資。
 */

export const FAKE_EMPLOYEE_ID = "cccccccc-0000-4000-8000-000000000001"

/** 台北 08:mm → UTC ISO。 */
function tpe(date: string, hh: number, mm: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCHours(hh - 8, mm, 0, 0)
  return d.toISOString()
}

function day(date: string, weekday: number, partial: Partial<SheetDayView> = {}): SheetDayView {
  return {
    date,
    weekday,
    dayType: "workday",
    firstIn: null,
    lastOut: null,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    outingMinutes: 0,
    leaveMinutes: 0,
    leaveSummary: null,
    wfh: false,
    overtime: { computed: 0, override: null, overrideReason: null, effective: 0, tier1: 0, tier2: 0, tier3: 0, beyondCap: 0 },
    content: null,
    outingNote: null,
    projectId: null,
    projectName: null,
    note: null,
    anomalyAck: null,
    anomalies: [],
    ...partial,
  }
}

function ot(tier1: number, tier2 = 0, tier3 = 0) {
  const effective = tier1 + tier2 + tier3
  return { computed: effective, override: null, overrideReason: null, effective, tier1, tier2, tier3, beyondCap: 0 }
}

/** 2026-06：平日 20 天出勤、2 天請病假（一天半天）、平日加班與一個休息日加班。 */
export function fakeSheetView(opts: { regularLeaveWork?: boolean; ptoWork?: boolean } = {}): SheetView {
  const days: SheetDayView[] = []
  const workdays = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16, 17, 18, 22, 23, 24, 25, 26, 29, 30]
  for (const d of workdays) {
    const date = `2026-06-${String(d).padStart(2, "0")}`
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (d === 17) {
      days.push(day(date, weekday, { leaveMinutes: 240, leaveSummary: "病假 4h", firstIn: tpe(date, 13, 0), lastOut: tpe(date, 18, 0) }))
      continue
    }
    if (d === 8) {
      days.push(day(date, weekday, { firstIn: tpe(date, 13, 13), lastOut: tpe(date, 18, 21), leaveMinutes: 90, leaveSummary: "病假 1.5h" }))
      continue
    }
    const extra = d === 10 ? ot(120, 60) : d === 11 ? ot(90) : undefined
    days.push(
      day(date, weekday, {
        firstIn: tpe(date, 8, 10 + (d % 20)),
        lastOut: tpe(date, d === 10 ? 20 : d === 11 ? 19 : 17, 15 + (d % 30)),
        workedMinutes: 480,
        ...(extra ? { overtime: extra } : {}),
        ...(d === 10 ? { dinner: { taken: true, source: "punch" as const, optIn: true } } : {}),
        ...(d === 22 ? { outingNote: "客戶會議", content: "現場勘查" } : {}),
      }),
    )
  }
  // 休息日加班（週六）
  days.push(day("2026-06-13", 6, { dayType: "rest_day", firstIn: tpe("2026-06-13", 9, 0), lastOut: tpe("2026-06-13", 13, 0), overtime: ot(120, 120) }))
  if (opts.regularLeaveWork)
    days.push(day("2026-06-14", 0, { dayType: "regular_leave", firstIn: tpe("2026-06-14", 9, 0), lastOut: tpe("2026-06-14", 13, 0), overtime: ot(480) }))
  if (opts.ptoWork)
    days.push(
      day("2026-06-19", 5, {
        firstIn: tpe("2026-06-19", 9, 0),
        lastOut: tpe("2026-06-19", 17, 0),
        overtime: ot(480),
        anomalies: [{ code: "pto_work", severity: "warn", message: "特休日出勤" }],
      }),
    )
  days.sort((a, b) => a.date.localeCompare(b.date))
  const sum = (f: (d: SheetDayView) => number) => days.reduce((s, d) => s + f(d), 0)
  return {
    id: "dddddddd-0000-4000-8000-000000000001",
    employeeId: FAKE_EMPLOYEE_ID,
    employeeName: "測試員工甲",
    employeeNo: "T001",
    hireDate: "2021-03-15",
    department: "設計部",
    title: "設計師",
    period: "2026-06",
    status: "approved",
    managerEmpId: null,
    managerName: null,
    submittedAt: null,
    managerReviewedAt: null,
    approvedAt: null,
    lockedAt: null,
    returnedAt: null,
    returnReason: null,
    computedAt: null,
    days,
    monthAnomalies: [],
    totals: {
      attendanceDays: days.length,
      workedMinutes: sum((d) => d.workedMinutes),
      lateMinutes: 12,
      earlyLeaveMinutes: 0,
      leaveMinutes: sum((d) => d.leaveMinutes),
      leaveByType: { 病假: 330 },
      otTier1: sum((d) => d.overtime.tier1),
      otTier2: sum((d) => d.overtime.tier2),
      otTier3: sum((d) => d.overtime.tier3),
      otTotal: sum((d) => d.overtime.effective),
      overtimeBeyondCapMinutes: 0,
      overtimeMonthlyAlert: "none",
    },
    money: null,
    anomalyCount: { error: 0, warn: 0, info: 0 },
    frozen: true,
    ruleConfigVersion: 1,
  }
}

const HOURLY = 30000 / 240 // 125

/** 引擎輸出形狀的假薪資單 breakdown（本薪 30,000、時薪 125）。 */
export function fakeBreakdown(opts: { regularLeave?: boolean; pto?: boolean } = {}): Record<string, unknown> {
  const segments = [
    { when: "weekday_ot", multiplier: 1.334, hours: 3.5, amount: 3.5 * HOURLY * 1.334 },
    { when: "weekday_ot", multiplier: 1.666667, hours: 1, amount: 1 * HOURLY * 1.666667 },
    { when: "rest_day", multiplier: 1.334, hours: 2, amount: 2 * HOURLY * 1.334 },
    { when: "rest_day", multiplier: 1.666667, hours: 2, amount: 2 * HOURLY * 1.666667 },
  ]
  if (opts.regularLeave) segments.push({ when: "regular_leave", multiplier: 1, hours: 8, amount: 8 * HOURLY })
  if (opts.pto) segments.push({ when: "fixed_holiday", multiplier: 1, hours: 8, amount: 8 * HOURLY })
  const overtimePay = Math.round(segments.reduce((s, x) => s + x.amount, 0) * 100) / 100
  const leaveDeduction = Math.round(5.5 * HOURLY * 0.5 * 100) / 100
  const gross = 30000 + overtimePay
  const totalDeductions = 700 + 450 + leaveDeduction + 25
  return {
    base: 30000,
    hourlyWage: HOURLY,
    overtimePay,
    nightPay: 0,
    attendanceBonus: 0,
    attendanceDeduction: 0,
    allowances: 0,
    compTimeMinutes: 0,
    gross,
    overtimeSegments: segments.map((s) => ({ ...s, amount: Math.round(s.amount * 100) / 100 })),
    laborInsurance: 700,
    healthInsurance: 450,
    pensionVoluntary: 0,
    advance: 0,
    leaveDeduction,
    lateEarlyDeduction: 25,
    totalDeductions,
    expenses: 350,
    net: Math.round((gross - totalDeductions + 350) * 100) / 100,
    lines: [
      { label: "本俸(月薪)", amount: 30000 },
      { label: "請假扣款(sick)", amount: -leaveDeduction },
    ],
  }
}

export function fakeMoney(opts: { regularLeave?: boolean; pto?: boolean } = {}): StatementMoney {
  return moneyFromBreakdown(fakeBreakdown(opts), "finalized")!
}

export function fakeStatementData(
  opts: { regularLeave?: boolean; pto?: boolean; money?: boolean; attendance?: boolean } = {},
): StatementData {
  return {
    period: "2026-06",
    tz: "Asia/Taipei",
    employee: { id: FAKE_EMPLOYEE_ID, name: "測試員工甲", empNo: "T001", title: "設計師", hireDate: "2021-03-15" },
    company: { name: "測試設計顧問有限公司", address: "測試市測試區測試路 1 號", phone: "T:02-0000-0000 F:02-0000-0001" },
    attendance: opts.attendance === false ? null : fakeSheetView({ regularLeaveWork: opts.regularLeave, ptoWork: opts.pto }),
    money: opts.money === false ? null : fakeMoney(opts),
    expenses: [
      { date: "2026-06-05", amount: 50, description: "停車費", project: null },
      { date: "2026-06-12", amount: 300, description: "高鐵", project: null },
    ],
    salary: { laborInsuredSalary: 30300, nhiDependents: 2 },
    leaveNames: { sick: "病假", personal: "事假" },
    mealNote: "晚上加班若有用餐，晚餐(超過三小時)由公司提供，須扣除30分鐘",
    payDate: null,
    insuredSince: null,
  }
}
