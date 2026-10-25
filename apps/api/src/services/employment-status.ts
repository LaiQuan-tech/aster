/**
 * 「某天在不在職」的唯一口徑（後台首頁人事區 boss-summary、集團總覽在職人數共用）：
 *   到職日 ≤ 那天，且（沒有離職日，或離職日 ≥ 那天）。沒填到職日視為一直在職（舊資料常沒填）。
 *   離職日當天仍算在職（最後上班日）。日期一律 'YYYY-MM-DD' 字串比較，`day` 是租戶當地日期。
 *   不看 employees.status：停用帳號但沒填離職日的人照算在職，與 /dashboard/headcount 一致。
 */
export type EmploymentDates = { hire_date?: string | null; terminated_at?: string | null }

export function isEmployedOn(e: EmploymentDates, day: string): boolean {
  const hired = e.hire_date ? e.hire_date.slice(0, 10) : "0000-01-01"
  const term = e.terminated_at ? e.terminated_at.slice(0, 10) : null
  return hired <= day && (!term || term >= day)
}
