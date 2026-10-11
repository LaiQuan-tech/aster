import { describe, expect, it } from "vitest"
import {
  DEFAULT_LEAVE_HOURS_PER_DAY,
  formatLeaveDuration,
  formatLeaveDurationMinutes,
  formatLeaveRemaining,
  normalizeHoursPerDay,
} from "../lib/leave-duration.js"
import { LEAVE_DURATION_CASES, LEAVE_MINUTES_CASES } from "./leave-duration-cases.js"

// 請假時數的「天＋時」顯示（純函式）。web 有逐字同一套演算法（apps/web/src/lib/leave-duration.ts），
// 兩邊用同一張案例表；web 那邊的測試還會 import 這份逐案例比對。

describe("formatLeaveDuration — 共用案例表", () => {
  it.each(LEAVE_DURATION_CASES)("$name", ({ hours, hoursPerDay, duration }) => {
    expect(formatLeaveDuration(hours, hoursPerDay)).toBe(duration)
  })
})

describe("formatLeaveRemaining — 負數寫成「超用」", () => {
  it.each(LEAVE_DURATION_CASES)("$name", ({ hours, hoursPerDay, remaining }) => {
    expect(formatLeaveRemaining(hours, hoursPerDay)).toBe(remaining)
  })
})

describe("formatLeaveDurationMinutes — 總分鐘版", () => {
  it.each(LEAVE_MINUTES_CASES)("$name", ({ minutes, hoursPerDay, expected }) => {
    expect(formatLeaveDurationMinutes(minutes, hoursPerDay)).toBe(expected)
  })
})

describe("格式規則", () => {
  it("只寫非零的部分，順序固定天 → 時 → 分，不會出現「0 時」「0 分」", () => {
    for (let minutes = 0; minutes <= 3 * 480; minutes += 1) {
      const text = formatLeaveDurationMinutes(minutes)
      expect(text, `${minutes} 分`).not.toMatch(/(^|\s)0 [時分]/)
      expect(text, `${minutes} 分`).toMatch(/^(\d+ 天)?( ?\d+ 時)?( ?\d+ 分)?$|^0 天$/)
    }
  })

  it("逐分鐘往上數，天＋時＋分換算回來剛好等於原本的分鐘（每日 8 時與 7.5 時）", () => {
    for (const perDay of [8, 7.5]) {
      const dayMinutes = Math.round(perDay * 60)
      for (let minutes = 0; minutes <= 3 * dayMinutes; minutes += 1) {
        const text = formatLeaveDurationMinutes(minutes, perDay)
        const days = Number(/(\d+) 天/.exec(text)?.[1] ?? 0)
        const h = Number(/(\d+) 時/.exec(text)?.[1] ?? 0)
        const m = Number(/(\d+) 分/.exec(text)?.[1] ?? 0)
        expect(days * dayMinutes + h * 60 + m, `${perDay} 時/日：${minutes} 分 → ${text}`).toBe(minutes)
        expect(h * 60 + m, `${text} 的時分部分必須小於一天`).toBeLessThan(dayMinutes)
      }
    }
  })

  it("預設每日工時是 8；不合法的每日工時退回 8", () => {
    expect(DEFAULT_LEAVE_HOURS_PER_DAY).toBe(8)
    expect(normalizeHoursPerDay()).toBe(8)
    expect(normalizeHoursPerDay(0)).toBe(8)
    expect(normalizeHoursPerDay(-3)).toBe(8)
    expect(normalizeHoursPerDay(Number.NaN)).toBe(8)
    expect(normalizeHoursPerDay(7.5)).toBe(7.5)
    expect(normalizeHoursPerDay("9")).toBe(9)
  })
})
