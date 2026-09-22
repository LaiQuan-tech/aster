"use client";

/**
 * 「本月加班累計」卡（M1 月加班上限）——**WP0 stub，回 null**；由 WP1 填：
 * 讀 `GET /my/overtime-cap?period=`（{ period, capMinutes, settledMinutes,
 * approvedRequestMinutes, beyondCapMinutes, alertHours }）顯示「本月加班累計 X／40 小時」
 * ＋進度條（≥36 橘、≥上限 紅），超額時加註「超過部分另行給付」。
 * 掛在 /ess 首頁「今日」卡之後（app/ess/page.tsx）。
 */
export function OvertimeCapCard(): null {
  return null;
}
