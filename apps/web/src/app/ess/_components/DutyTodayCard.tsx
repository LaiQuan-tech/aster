"use client";

/**
 * 「今日值日／總機」卡（M8 輪播排班）——**WP0 stub，回 null**；由 WP8 填：
 * 讀 `GET /duty-rosters/today`（{ date, duty: { employeeId, name } | null, reception: … }）
 * 顯示「今日值日：○○　總機：○○」；兩者皆 null 時整張不顯示。
 * 掛在 /ess 首頁「今日」卡之後（app/ess/page.tsx）。
 */
export function DutyTodayCard(): null {
  return null;
}
