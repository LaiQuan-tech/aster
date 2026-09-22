import { describe, it, expect } from "vitest"
import {
  datesBetween,
  generateRoster,
  weekdayOf,
  workingDaysIn,
} from "../services/duty-roster"

/**
 * 值日生／總機輪播（M8）的純邏輯。整個排班的正確性只有兩件事：
 * 「只排工作日」與「照名單順序繞」，兩者都在這裡定死。
 */

const FIVE = ["e1", "e2", "e3", "e4", "e5"]

describe("workingDaysIn — 只排工作日", () => {
  it("2026-09 只留週一到週五（無行事曆覆寫時退回週末判斷）", () => {
    const days = workingDaysIn("2026-09-01", "2026-09-30", new Map())
    expect(days.length).toBe(22) // 9 月 30 天，週末 8 天
    expect(days[0]).toBe("2026-09-01")
    expect(days).not.toContain("2026-09-05") // 週六
    expect(days).not.toContain("2026-09-06") // 週日
    expect(days.every((d) => weekdayOf(d) !== 0 && weekdayOf(d) !== 6)).toBe(true)
  })

  it("行事曆覆寫優先：補班的週六要排、彈性放假的平日不排", () => {
    const calendar = new Map<string, string>([
      ["2026-09-05", "workday"], // 補班（週六）
      ["2026-09-28", "fixed_holiday"], // 教師節放假（週一）
    ])
    const days = workingDaysIn("2026-09-01", "2026-09-30", calendar)
    expect(days).toContain("2026-09-05")
    expect(days).not.toContain("2026-09-28")
  })
})

describe("generateRoster — 輪播順序", () => {
  it("5 人排 9 月工作日：依序繞回第一人", () => {
    const dates = workingDaysIn("2026-09-01", "2026-09-30", new Map())
    const roster = generateRoster({ participants: FIVE, dates })
    expect(roster).toHaveLength(dates.length)
    expect(roster.slice(0, 6).map((r) => r.employeeId)).toEqual(["e1", "e2", "e3", "e4", "e5", "e1"])
    // 每個人被排到的次數最多差一天（22 天 ÷ 5 人）。
    const counts = FIVE.map((id) => roster.filter((r) => r.employeeId === id).length)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it("startIndex 決定第一天是誰，且照樣繞回開頭", () => {
    const roster = generateRoster({
      participants: FIVE,
      dates: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-07", "2026-09-08"],
      startIndex: 3,
    })
    expect(roster.map((r) => r.employeeId)).toEqual(["e4", "e5", "e1", "e2", "e3", "e4"])
  })

  it("startIndex 超過人數自動取模；負數視為 0", () => {
    const dates = ["2026-09-01", "2026-09-02"]
    expect(generateRoster({ participants: FIVE, dates, startIndex: 7 }).map((r) => r.employeeId)).toEqual(["e3", "e4"])
    expect(generateRoster({ participants: FIVE, dates, startIndex: -1 }).map((r) => r.employeeId)).toEqual(["e1", "e2"])
  })

  it("名單重複的人只算一輪（否則他會輪到兩倍次數）", () => {
    const roster = generateRoster({
      participants: ["a", "b", "a", "c"],
      dates: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
    })
    expect(roster.map((r) => r.employeeId)).toEqual(["a", "b", "c", "a"])
  })

  it("沒有參與者或沒有日期 → 空排班（不是丟錯）", () => {
    expect(generateRoster({ participants: [], dates: ["2026-09-01"] })).toEqual([])
    expect(generateRoster({ participants: FIVE, dates: [] })).toEqual([])
  })
})

describe("datesBetween", () => {
  it("含頭含尾；to 早於 from 回空；超過上限截斷", () => {
    expect(datesBetween("2026-09-01", "2026-09-03")).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"])
    expect(datesBetween("2026-09-03", "2026-09-01")).toEqual([])
    expect(datesBetween("2026-01-01", "2030-01-01").length).toBe(400)
  })
})
