import { describe, expect, it } from "vitest"
import type { ShiftDef } from "@hr/rules"
import { resolveDayShift } from "../services/employee-shifts.js"
import { checkWfhPunch, normalizeEmployeeFeatures } from "../services/employee-features.js"
import { wfhPunchDates } from "../services/punch-pairing.js"

// 2026-10-13 員工個人設定：班別解析（排班 → 個人預設班別 → 公司規則）、功能開關、在家打卡日。純函式。

const SCHEDULED: ShiftDef = { start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "12:00" }
const PERSONAL: ShiftDef = { start: "14:30", end: "22:30", breakMinutes: 0, breakStart: null }

describe("resolveDayShift — 四個讀取點共用的優先序", () => {
  it("有排班 → 排班優先（就算有個人預設班別）", () => {
    expect(resolveDayShift({ scheduledShift: SCHEDULED, defaultShift: PERSONAL, dayType: "workday" })).toEqual({
      shift: SCHEDULED,
      source: "schedule",
    })
  })

  it("排班在例假日也照用（歷史排班本來就這樣）", () => {
    expect(resolveDayShift({ scheduledShift: SCHEDULED, defaultShift: PERSONAL, dayType: "rest_day" }).source).toBe("schedule")
  })

  it("沒排班的工作日 → 個人預設班別", () => {
    expect(resolveDayShift({ scheduledShift: null, defaultShift: PERSONAL, dayType: "workday" })).toEqual({
      shift: PERSONAL,
      source: "default",
    })
  })

  it("沒排班的例假日／國定假日 → 不套個人預設班別（走公司規則：整天、不扣午休）", () => {
    for (const dayType of ["rest_day", "fixed_holiday"] as const) {
      expect(resolveDayShift({ scheduledShift: null, defaultShift: PERSONAL, dayType })).toEqual({ shift: null, source: null })
    }
  })

  it("都沒有 → null（工作日走彈性上班 attendance.flex）", () => {
    expect(resolveDayShift({ scheduledShift: undefined, defaultShift: undefined, dayType: "workday" })).toEqual({
      shift: null,
      source: null,
    })
  })
})

describe("employee features", () => {
  it("normalizeEmployeeFeatures：只認 wfhPunch === true", () => {
    expect(normalizeEmployeeFeatures({ wfhPunch: true })).toEqual({ wfhPunch: true, noNightPremium: false })
    expect(normalizeEmployeeFeatures({ wfhPunch: "true", noNightPremium: true })).toEqual({ wfhPunch: false, noNightPremium: true })
    expect(normalizeEmployeeFeatures(null)).toEqual({ wfhPunch: false, noNightPremium: false })
    expect(normalizeEmployeeFeatures([true])).toEqual({ wfhPunch: false, noNightPremium: false })
  })

  it("checkWfhPunch：沒帶／false 放行；true 要開通", () => {
    expect(checkWfhPunch(undefined, { wfhPunch: false, noNightPremium: false })).toEqual({ ok: true })
    expect(checkWfhPunch(false, { wfhPunch: false, noNightPremium: false })).toEqual({ ok: true })
    expect(checkWfhPunch(true, { wfhPunch: true, noNightPremium: false })).toEqual({ ok: true })
    expect(checkWfhPunch(true, { wfhPunch: false, noNightPremium: false })).toEqual({ ok: false, error: "wfh_punch_not_enabled" })
  })
})

describe("wfhPunchDates — 在家打卡算在哪一天（Asia/Taipei）", () => {
  const TZ = "Asia/Taipei"
  // 台北 = UTC+8。

  it("上班卡勾在家 → 當天", () => {
    const dates = wfhPunchDates(
      [
        { type: "in", punch_at: "2026-10-13T06:30:00Z", wfh: true }, // 14:30
        { type: "out", punch_at: "2026-10-13T14:30:00Z", wfh: false }, // 22:30
      ],
      TZ,
    )
    expect([...dates]).toEqual(["2026-10-13"])
  })

  it("跨午夜的下班卡勾在家 → 算上班卡那天，不會把隔天標成在家", () => {
    const dates = wfhPunchDates(
      [
        { type: "in", punch_at: "2026-10-13T06:30:00Z", wfh: true }, // 10/13 14:30
        { type: "out", punch_at: "2026-10-13T16:10:00Z", wfh: true }, // 10/14 00:10
      ],
      TZ,
    )
    expect([...dates]).toEqual(["2026-10-13"])
  })

  it("沒有任何 wfh 打卡 → 空集合；舊 API 沒有 wfh 欄位也一樣", () => {
    expect(wfhPunchDates([{ type: "in", punch_at: "2026-10-13T06:30:00Z" }], TZ).size).toBe(0)
  })
})

import { withinEmployment } from "../services/employee-shifts.js"
import { coveredByRequests, windowCovered } from "../services/absence-cover.js"

describe("withinEmployment／在職期間外不套個人預設班別", () => {
  it("到職日當天起、離職日當天止；空值不限", () => {
    const e = { hireDate: "2026-09-15", terminatedAt: "2026-12-31" }
    expect(withinEmployment("2026-09-14", e)).toBe(false)
    expect(withinEmployment("2026-09-15", e)).toBe(true)
    expect(withinEmployment("2026-12-31", e)).toBe(true)
    expect(withinEmployment("2027-01-01", e)).toBe(false)
    expect(withinEmployment("2000-01-01", { hireDate: null, terminatedAt: null })).toBe(true)
    expect(resolveDayShift({ scheduledShift: null, defaultShift: PERSONAL, dayType: "workday", date: "2026-09-14", employment: e }).source).toBeNull()
  })
})

describe("windowCovered／coveredByRequests — 班別整段被核准單蓋滿", () => {
  it("聯集蓋滿才算；扣掉明確午休", () => {
    const w = { start: 0, end: 100 }
    expect(windowCovered(w, null, [{ start: 0, end: 60 }, { start: 50, end: 100 }])).toBe(true)
    expect(windowCovered(w, null, [{ start: 0, end: 40 }, { start: 50, end: 100 }])).toBe(false)
    expect(windowCovered(w, { start: 40, end: 50 }, [{ start: 0, end: 40 }, { start: 50, end: 100 }])).toBe(true)
  })

  it("日班 09–18 午休 12–13：上午、下午兩段 segments 合起來算整天", () => {
    const req = {
      employee_id: "e1",
      kind: "leave",
      start_at: "2026-09-01T01:00:00Z",
      end_at: "2026-09-01T10:00:00Z",
      segments: [
        { date: "2026-09-01", startTime: "09:00", endTime: "12:00" },
        { date: "2026-09-01", startTime: "13:00", endTime: "18:00" },
      ],
    }
    expect(coveredByRequests([req], "e1", "2026-09-01", SCHEDULED, "Asia/Taipei")).toBe(true)
    expect(coveredByRequests([{ ...req, segments: [req.segments[0]!] }], "e1", "2026-09-01", SCHEDULED, "Asia/Taipei")).toBe(false)
    expect(coveredByRequests([req], "e2", "2026-09-01", SCHEDULED, "Asia/Taipei")).toBe(false)
  })
})

import { computePayslip, type AttendanceDay } from "@hr/rules"
import { applyNightPolicy } from "../services/employee-features.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"

describe("applyNightPolicy — 薪資引擎入口的不計夜間加給", () => {
  const day: AttendanceDay = {
    date: "2026-09-01",
    workedMinutes: 480,
    lateMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 30,
    dayType: "workday",
  }
  const salary = { method: "monthly" as const, baseSalary: 36000 }
  const off = { wfhPunch: false, noNightPremium: false }
  const on = { wfhPunch: false, noNightPremium: true }

  it("開 → 夜間分鐘 0、倍率 0、夜間加給 0；不動原陣列與原規則", () => {
    const p = applyNightPolicy(on, [day], DEFAULT_RULE_CONFIG)
    expect(p.days[0]!.nightMinutes).toBe(0)
    expect(p.rules.night.multiplier).toBe(0)
    expect(day.nightMinutes).toBe(30)
    expect(DEFAULT_RULE_CONFIG.night.multiplier).toBe(1.34)
    expect(computePayslip(p.days, salary, p.rules).nightPay).toBe(0)
  })

  it("關（或沒有開關）→ 原樣，22:00–22:30 照算夜間加給", () => {
    for (const f of [off, null, undefined]) {
      const p = applyNightPolicy(f, [day], DEFAULT_RULE_CONFIG)
      expect(p.days[0]).toBe(day)
      expect(p.rules).toBe(DEFAULT_RULE_CONFIG)
      expect(computePayslip(p.days, salary, p.rules).nightPay).toBeGreaterThan(0)
    }
  })
})
