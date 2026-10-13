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
    expect(normalizeEmployeeFeatures({ wfhPunch: true })).toEqual({ wfhPunch: true })
    expect(normalizeEmployeeFeatures({ wfhPunch: "true" })).toEqual({ wfhPunch: false })
    expect(normalizeEmployeeFeatures(null)).toEqual({ wfhPunch: false })
    expect(normalizeEmployeeFeatures([true])).toEqual({ wfhPunch: false })
  })

  it("checkWfhPunch：沒帶／false 放行；true 要開通", () => {
    expect(checkWfhPunch(undefined, { wfhPunch: false })).toEqual({ ok: true })
    expect(checkWfhPunch(false, { wfhPunch: false })).toEqual({ ok: true })
    expect(checkWfhPunch(true, { wfhPunch: true })).toEqual({ ok: true })
    expect(checkWfhPunch(true, { wfhPunch: false })).toEqual({ ok: false, error: "wfh_punch_not_enabled" })
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
