/**
 * 晚餐勾選（2026-10-17，一例一休第三段）：員工端打卡首頁的「今天有用公司晚餐」勾選框。
 *
 * 公司規則是「有用公司晚餐才扣晚餐時間」（overtime.mealBreak.mode='opt_in'）時，GET /punch/today 會回
 * `dinnerPrompt: { optIn, fromAt, workDate }`：從 `fromAt` 起打下班卡＝當天有延長工時（勾了才會扣）。
 * 上班中、而且現在已過 `fromAt` 才顯示勾選框（預設不勾）；下班打卡時帶 `dinnerTaken`（勾＝true、沒勾＝false）。
 * 判斷全在 API（services/settlement.ts dinnerPromptForOpenShift，與結算同一個引擎），這裡只比時間。
 */

export interface DinnerPrompt {
  optIn: boolean;
  /** ISO；null＝今天不適用。 */
  fromAt: string | null;
  workDate: string | null;
}

/** 現在要不要在下班打卡鈕旁顯示「今天有用公司晚餐」。 */
export function showDinnerCheckbox(
  prompt: DinnerPrompt | null | undefined,
  phase: string,
  nowMs: number,
): boolean {
  if (phase !== "working" || !prompt?.optIn || !prompt.fromAt) return false;
  const from = Date.parse(prompt.fromAt);
  return Number.isFinite(from) && nowMs >= from;
}

/** 下班打卡要帶的欄位：顯示勾選框時一律明確帶 true／false（沒顯示就不帶＝沒問到）。 */
export function dinnerBodyFor(
  type: "in" | "out",
  visible: boolean,
  checked: boolean,
): { dinnerTaken?: boolean } {
  return type === "out" && visible ? { dinnerTaken: checked } : {};
}
