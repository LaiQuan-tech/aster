/**
 * 「請假時數 → 天＋時」的共用案例表（純資料，不是測試檔）。
 *
 * 兩份實作用同一張表測，演算法才不會悄悄分岔：
 *   - API：`lib/leave-duration.ts`      ← `__tests__/leave-duration.test.ts`
 *   - web：`apps/web/src/lib/leave-duration.ts` ← `apps/web/src/lib/__tests__/leave-duration.test.ts`
 *     （web 的測試另外直接 import API 那份，在更大的輸入格上逐筆比對）
 *
 * `duration`＝`formatLeaveDuration(hours, hoursPerDay)`；`remaining`＝`formatLeaveRemaining(...)`
 * （差別只在負數：「−4 時」vs「超用 4 時」）。`hoursPerDay` 省略＝8（規則參數 payroll.dailyRegularHours 的預設值）。
 */

export interface LeaveDurationCase {
  name: string
  hours: number | string | null | undefined
  hoursPerDay?: number | string | null
  duration: string
  remaining: string
}

/** duration 與 remaining 相同的案例用的小幫手。 */
function same(name: string, hours: LeaveDurationCase["hours"], expected: string, hoursPerDay?: LeaveDurationCase["hoursPerDay"]): LeaveDurationCase {
  return { name, hours, hoursPerDay, duration: expected, remaining: expected }
}

export const LEAVE_DURATION_CASES: LeaveDurationCase[] = [
  // ── 業主截圖（ESS 剩餘假別頁）與規格範例 ─────────────────────────────
  same("特休剩 48 時 → 6 天", 48, "6 天"),
  same("特休可用 56 時 → 7 天", 56, "7 天"),
  same("特休已用 8 時 → 1 天", 8, "1 天"),
  same("事假 108 時 → 13 天 4 時", 108, "13 天 4 時"),
  same("0 → 0 天", 0, "0 天"),
  same("不滿一天只寫時：4 → 4 時", 4, "4 時"),
  same("2.5 → 2 時 30 分", 2.5, "2 時 30 分"),
  same("有天、沒有時、有分：8.5 → 1 天 30 分（不寫 0 時）", 8.5, "1 天 30 分"),
  same("8.25 → 1 天 15 分", 8.25, "1 天 15 分"),
  same("只有分：0.5 → 30 分", 0.5, "30 分"),
  same("只有分：0.25 → 15 分", 0.25, "15 分"),
  same("天＋時：15 → 1 天 7 時", 15, "1 天 7 時"),
  same("整天數：24 → 3 天", 24, "3 天"),
  same("天＋時＋分：31.5 → 3 天 7 時 30 分", 31.5, "3 天 7 時 30 分"),
  same("1 → 1 時", 1, "1 時"),
  same("100 → 12 天 4 時", 100, "12 天 4 時"),
  same("1000 → 125 天", 1000, "125 天"),
  same("12 小時 20 分（浮點尾巴）→ 1 天 4 時 20 分", 12 + 20 / 60, "1 天 4 時 20 分"),

  // ── 四捨五入到分鐘 ────────────────────────────────────────────────
  same("7.99 → 7 時 59 分", 7.99, "7 時 59 分"),
  same("7.999 進位成整天 → 1 天（不會出現 7 時 60 分）", 7.999, "1 天"),
  same("7.9999 → 1 天", 7.9999, "1 天"),
  same("不到半分鐘 → 0 天", 0.0083, "0 天"),
  same("0.01 小時＝0.6 分 → 1 分", 0.01, "1 分"),
  same("0.1 + 0.2 的浮點尾巴 → 18 分", 0.1 + 0.2, "18 分"),
  same("1.1 的浮點尾巴 → 1 時 6 分", 1.1, "1 時 6 分"),

  // ── 字串（PostgREST 的 numeric 欄位）與不合法輸入 ─────────────────
  same("字串 \"56.00\" → 7 天", "56.00", "7 天"),
  same("字串 \"108\" → 13 天 4 時", "108", "13 天 4 時"),
  same("字串前後有空白 → 4 時", " 4 ", "4 時"),
  same("null → —", null, "—"),
  same("undefined → —", undefined, "—"),
  same("空字串 → —（不是 0 天）", "", "—"),
  same("全空白字串 → —", "   ", "—"),
  same("非數字字串 → —", "abc", "—"),
  same("NaN → —", Number.NaN, "—"),
  same("Infinity → —", Number.POSITIVE_INFINITY, "—"),
  same("-Infinity → —", Number.NEGATIVE_INFINITY, "—"),

  // ── 負數（超用／調減）────────────────────────────────────────────
  { name: "-4 → 「−4 時」；剩餘額度寫成「超用 4 時」", hours: -4, duration: "−4 時", remaining: "超用 4 時" },
  { name: "-8 → −1 天／超用 1 天", hours: -8, duration: "−1 天", remaining: "超用 1 天" },
  { name: "-108 → −13 天 4 時／超用 13 天 4 時", hours: -108, duration: "−13 天 4 時", remaining: "超用 13 天 4 時" },
  { name: "-0.5 → −30 分／超用 30 分", hours: -0.5, duration: "−30 分", remaining: "超用 30 分" },
  { name: "字串 \"-8.00\" → −1 天", hours: "-8.00", duration: "−1 天", remaining: "超用 1 天" },
  same("負的微小量（−0.001 小時）四捨五入到 0 分 → 0 天，不顯示符號、不算超用", -0.001, "0 天"),
  same("-0 → 0 天", -0, "0 天"),

  // ── 每日工時不是 8（規則參數 payroll.dailyRegularHours）─────────────
  same("每日 7.5 時：15 → 2 天", 15, "2 天", 7.5),
  same("每日 7.5 時：7.5 → 1 天", 7.5, "1 天", 7.5),
  same("每日 7.5 時：8 → 1 天 30 分", 8, "1 天 30 分", 7.5),
  same("每日 9 時：20 → 2 天 2 時", 20, "2 天 2 時", 9),
  same("每日 9 時：18 → 2 天", 18, "2 天", 9),
  same("每日 7 時：56 → 8 天", 56, "8 天", 7),
  same("每日 10 時：10 → 1 天", 10, "1 天", 10),
  same("每日 24 時：25 → 1 天 1 時", 25, "1 天 1 時", 24),
  same("每日工時是字串 \"7.5\"", 15, "2 天", "7.5"),
  same("每日工時是字串 \"8\"", 16, "2 天", "8"),

  // ── 每日工時不合法 → 退回 8 ──────────────────────────────────────
  same("每日工時 0 → 退回 8", 16, "2 天", 0),
  same("每日工時負數 → 退回 8", 16, "2 天", -1),
  same("每日工時 NaN → 退回 8", 16, "2 天", Number.NaN),
  same("每日工時 null → 退回 8", 16, "2 天", null),
  same("每日工時空字串 → 退回 8", 16, "2 天", ""),
  same("每日工時 Infinity → 退回 8", 16, "2 天", Number.POSITIVE_INFINITY),
]

/** `formatLeaveDurationMinutes`（總分鐘版）的案例；hoursPerDay 省略＝8。 */
export interface LeaveMinutesCase {
  name: string
  minutes: number | string | null | undefined
  hoursPerDay?: number | string | null
  expected: string
}

export const LEAVE_MINUTES_CASES: LeaveMinutesCase[] = [
  { name: "480 分 → 1 天", minutes: 480, expected: "1 天" },
  { name: "90 分 → 1 時 30 分", minutes: 90, expected: "1 時 30 分" },
  { name: "45 分 → 45 分", minutes: 45, expected: "45 分" },
  { name: "0 分 → 0 天", minutes: 0, expected: "0 天" },
  { name: "59.6 分四捨五入成 60 分 → 1 時", minutes: 59.6, expected: "1 時" },
  { name: "479.5 分四捨五入成 480 分 → 1 天", minutes: 479.5, expected: "1 天" },
  { name: "6480 分 → 13 天 4 時", minutes: 6480, expected: "13 天 4 時" },
  { name: "-90 分 → −1 時 30 分", minutes: -90, expected: "−1 時 30 分" },
  { name: "半分鐘四捨五入進位：0.5 分 → 1 分", minutes: 0.5, expected: "1 分" },
  { name: "負的半分鐘同樣遠離 0：-0.5 分 → −1 分", minutes: -0.5, expected: "−1 分" },
  { name: "不到半分鐘：-0.4 分 → 0 天（不顯示符號）", minutes: -0.4, expected: "0 天" },
  { name: "字串 \"1440\" → 3 天", minutes: "1440", expected: "3 天" },
  { name: "每日 7.5 時：900 分 → 2 天", minutes: 900, hoursPerDay: 7.5, expected: "2 天" },
  { name: "null → —", minutes: null, expected: "—" },
  { name: "NaN → —", minutes: Number.NaN, expected: "—" },
]
