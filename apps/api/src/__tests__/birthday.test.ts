import { describe, it, expect } from "vitest"
import { birthdaysBetween, birthdaysInMonth, isLeapYear } from "../services/birthday"

/**
 * 生日提醒（M7）的純邏輯。兩個容易錯的地方在這裡釘死：
 * **跨年區間**（12/30 → 1/2 的 T+3 提醒）與 **2/29**（平年要視為 2/28，
 * 否則那位同仁四年才會被提醒一次）。
 */

const people = [
  { employeeId: "a", name: "元旦寶寶", birthday: "1990-01-01" },
  { employeeId: "b", name: "跨年夜", birthday: "1985-12-31" },
  { employeeId: "c", name: "閏日", birthday: "1996-02-29" },
  { employeeId: "d", name: "二月底", birthday: "1992-02-28" },
  { employeeId: "e", name: "沒填生日", birthday: null },
]

describe("birthdaysBetween — 跨年", () => {
  it("12/30 到 1/2 同時抓到 12/31 與 1/1 的壽星", () => {
    const hits = birthdaysBetween(people, "2026-12-30", "2027-01-02")
    expect(hits.map((h) => h.employeeId)).toEqual(["b", "a"])
    expect(hits[0]).toMatchObject({ date: "2026-12-31", age: 2026 - 1985 })
    expect(hits[1]).toMatchObject({ date: "2027-01-01", age: 2027 - 1990 })
  })

  it("沒填生日的人永遠不出現", () => {
    expect(birthdaysBetween(people, "2026-01-01", "2026-12-31").some((h) => h.employeeId === "e")).toBe(false)
  })

  it("區間內沒有人過生日 → 空陣列", () => {
    expect(birthdaysBetween(people, "2026-06-01", "2026-06-30")).toEqual([])
  })
})

describe("birthdaysBetween — 2/29", () => {
  it("閏年 2/29 當天就是他的生日，2/28 不是", () => {
    expect(birthdaysBetween(people, "2028-02-29", "2028-02-29").map((h) => h.employeeId)).toEqual(["c"])
    expect(birthdaysBetween(people, "2028-02-28", "2028-02-28").map((h) => h.employeeId)).toEqual(["d"])
  })

  it("平年 2/28 同時是 2/28 與 2/29 出生者的生日", () => {
    const hits = birthdaysBetween(people, "2026-02-28", "2026-02-28")
    expect(hits.map((h) => h.employeeId).sort()).toEqual(["c", "d"])
    // 原始生日保留，方便 UI 顯示「2/29（今年以 2/28 計）」。
    expect(hits.find((h) => h.employeeId === "c")?.birthday).toBe("1996-02-29")
  })

  it("平年整個二月只會出現一次，不會漏掉閏日出生者", () => {
    const feb = birthdaysInMonth(people, "2026-02")
    expect(feb.map((h) => h.employeeId).sort()).toEqual(["c", "d"])
    expect(feb.every((h) => h.date === "2026-02-28")).toBe(true)
  })
})

describe("birthdaysInMonth", () => {
  it("只回該月的壽星；月份格式不對回空", () => {
    expect(birthdaysInMonth(people, "2026-01").map((h) => h.employeeId)).toEqual(["a"])
    expect(birthdaysInMonth(people, "2026-12").map((h) => h.employeeId)).toEqual(["b"])
    expect(birthdaysInMonth(people, "2026-13")).toEqual([])
  })
})

describe("isLeapYear", () => {
  it("400 年規則", () => {
    expect([2024, 2028, 2000].map(isLeapYear)).toEqual([true, true, true])
    expect([2026, 2027, 1900, 2100].map(isLeapYear)).toEqual([false, false, false, false])
  })
})
