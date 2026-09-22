/**
 * 三節／節慶 Cash 獎金（M6，2026-09-23）——**純函式，不連 DB**。
 *
 * 客戶要的是「去年同期給多少，今年就先帶多少；到職未滿一年的按到職月數折算；
 * 老闆再逐人加減」。這裡只負責中間那段算術：
 *
 *   基準金額 = 去年同節的 final_amount（有就優先）?? 本次輸入的 baseAmount
 *   折算月數 = 到職滿 12 個月 → 12；未滿 → 到職日至基準日的**整月數**（最少 1，最多 12）
 *   建議金額 = 基準金額 × 折算月數 ÷ 12（四捨五入到元）
 *
 * 「整月數」以日為界：3/15 到 9/25 是 6 個月（3/15→9/15 滿 6 個月，剩下 10 天不計）；
 * 3/15 到 9/14 是 5 個月。沒有到職日（資料缺）→ 視為滿一年（12 個月），不因缺欄位
 * 少發錢；基準日早於到職日（還沒報到）→ 0 個月、建議 0。
 */

export const FESTIVALS = ["lunar_new_year", "dragon_boat", "mid_autumn", "other"] as const
export type Festival = (typeof FESTIVALS)[number]

export const FESTIVAL_LABEL: Record<Festival, string> = {
  lunar_new_year: "春節",
  dragon_boat: "端午",
  mid_autumn: "中秋",
  other: "其他",
}

export function festivalLabel(festival: string): string {
  return FESTIVAL_LABEL[festival as Festival] ?? festival
}

export interface FestivalSuggestionInput {
  /** 去年同節的實發金額（優先於 baseAmount）。 */
  lastYearFinal?: number | null
  /** 本次「產生」輸入的基準金額（全員同一個數字）。 */
  baseAmount?: number | null
  /** 員工到職日 'YYYY-MM-DD'；null／缺 → 視為滿一年。 */
  hireDate?: string | null
  /** 折算基準日 'YYYY-MM-DD'（通常是發放日或節日當天）。 */
  referenceDate: string
}

export interface FestivalSuggestion {
  /** 折算月數（0–12）。 */
  prorateMonths: number
  /** 建議金額（元，四捨五入）。 */
  suggested: number
  /** 實際採用的基準金額（去年同節 ?? baseAmount ?? 0）。 */
  base: number
}

function parseDate(s: string | null | undefined): { y: number; m: number; d: number } | null {
  if (typeof s !== "string") return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/**
 * 兩個日期之間的**整月數**（不足一個月不計）。to 早於 from → 0。
 * 只看年月日字串，不建 Date、不碰時區（HR 眼中的月份是日曆上的，不是 UTC 的）。
 */
export function wholeMonthsBetween(from: string, to: string): number {
  const a = parseDate(from)
  const b = parseDate(to)
  if (!a || !b) return 0
  let months = (b.y - a.y) * 12 + (b.m - a.m)
  if (b.d < a.d) months -= 1
  return months > 0 ? months : 0
}

/**
 * 到職月數折算 + 去年同期優先。
 *
 * 例（驗收）：到職 2026-03-15、基準日 2026-09-25、baseAmount 10000
 *   → prorateMonths 6、suggested 5000；若去年同節 final 是 12000 則改以 12000 為基準。
 */
export function computeFestivalSuggestion(input: FestivalSuggestionInput): FestivalSuggestion {
  const lastYear = typeof input.lastYearFinal === "number" && Number.isFinite(input.lastYearFinal) ? input.lastYearFinal : null
  const fallback = typeof input.baseAmount === "number" && Number.isFinite(input.baseAmount) ? input.baseAmount : 0
  const base = lastYear ?? fallback

  let prorateMonths = 12
  if (input.hireDate) {
    const served = wholeMonthsBetween(input.hireDate, input.referenceDate)
    // 滿 12 個月＝全額；未滿＝實際整月數，但已報到者至少算 1 個月
    // （3/15 到職、4/1 發節金＝0 個整月，仍給 1/12，這是客戶的意思）。
    prorateMonths = served >= 12 ? 12 : served > 0 ? served : hasReported(input.hireDate, input.referenceDate) ? 1 : 0
  }

  const suggested = Math.round((base * prorateMonths) / 12)
  return { prorateMonths, suggested, base }
}

/** 基準日 >= 到職日（已報到）。字串比較即可，'YYYY-MM-DD' 是字典序＝時序。 */
function hasReported(hireDate: string, referenceDate: string): boolean {
  return referenceDate.slice(0, 10) >= hireDate.slice(0, 10)
}
