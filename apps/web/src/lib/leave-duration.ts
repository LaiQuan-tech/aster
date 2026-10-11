/**
 * 請假時數的「天＋時」顯示（2026-10-11 業主決定：請假相關的時數一律顯示成天＋時）。
 *
 * **只改顯示**：資料庫、API 欄位、計算全部仍是小時（`leave_balances.entitled／used／deferred`、
 * `leave_requests.hours`…）；這裡只是把小時換算成人看得懂的字。純函式、不碰 React／DOM，有單元測試。
 *
 * 1 天 ＝ `payroll.dailyRegularHours` 小時（規則參數，預設 8）。前端拿得到就傳進來（例：年度請假表、
 * 年度給假結果、`GET /leave-balances` 的 `dailyRegularHours`），拿不到就用預設 8。
 *
 * API 端有一份**相同實作**：`apps/api/src/lib/leave-duration.ts`（xlsx、通知文字用）。web 與 api 是各自的
 * build 邊界，只能各寫一份；兩邊用同一組案例表（`apps/api/src/__tests__/leave-duration-cases.ts`）測，
 * `__tests__/leave-duration.test.ts` 還會直接 import API 那份逐案例比對——改任何一邊，那裡就會紅。
 */

import { fmtHours } from "./ess-format";

/** 規則參數 `payroll.dailyRegularHours` 的預設值；前端拿不到規則時用它。 */
export const DEFAULT_LEAVE_HOURS_PER_DAY = 8;

/** 負數（超用）前面的符號：U+2212 減號（不是連字號 `-`）。 */
export const LEAVE_NEGATIVE_SIGN = "−";

/** 負的剩餘額度（超用）前面的字。 */
export const LEAVE_OVERUSE_LABEL = "超用";

type HoursInput = number | string | null | undefined;

function toFinite(value: HoursInput): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

/** 每日工時：不是正的有限數字（沒給、0、負數、NaN）→ 退回預設 8。 */
export function normalizeHoursPerDay(hoursPerDay?: HoursInput): number {
  const n = toFinite(hoursPerDay);
  return n != null && n > 0 ? n : DEFAULT_LEAVE_HOURS_PER_DAY;
}

/**
 * 總分鐘 → 「N 天 N 時 N 分」。
 *
 *   - 天 ＝ floor(分 ÷ (每日工時 × 60))，剩下的拆成時、分。
 *   - 只寫非零的部分、順序固定天 → 時 → 分、中間空一格（不會出現「1 天 0 時 30 分」）。
 *   - 全為 0 →「0 天」。
 *   - 負數（超用／調減）→ 前面加「−」；要寫成「超用 …」用 `formatLeaveRemaining`。
 *   - 不是有限數字（null、undefined、NaN、空字串）→「—」。
 *
 * 分鐘先四捨五入成整數，所以 `7.999` 小時會進位成「1 天」，不會出現「7 時 60 分」。
 */
export function formatLeaveDurationMinutes(totalMinutes: HoursInput, hoursPerDay?: HoursInput): string {
  const raw = toFinite(totalMinutes);
  if (raw == null) return "—";
  const minutes = Math.round(Math.abs(raw));
  const dayMinutes = Math.max(1, Math.round(normalizeHoursPerDay(hoursPerDay) * 60));
  const days = Math.floor(minutes / dayMinutes);
  const rest = minutes - days * dayMinutes;
  const h = Math.floor(rest / 60);
  const m = rest % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (h > 0) parts.push(`${h} 時`);
  if (m > 0) parts.push(`${m} 分`);
  if (parts.length === 0) return "0 天";
  return `${raw < 0 ? LEAVE_NEGATIVE_SIGN : ""}${parts.join(" ")}`;
}

/**
 * 小時數 → 「N 天 N 時 N 分」（規則見 `formatLeaveDurationMinutes`）。
 *
 *   formatLeaveDuration(56)   // "7 天"
 *   formatLeaveDuration(108)  // "13 天 4 時"
 *   formatLeaveDuration(2.5)  // "2 時 30 分"
 *   formatLeaveDuration(-4)   // "−4 時"
 *
 * 後端常把 numeric 欄位以字串（"56.00"）回來，字串也收。
 */
export function formatLeaveDuration(hours: HoursInput, hoursPerDay?: HoursInput): string {
  const n = toFinite(hours);
  return n == null ? "—" : formatLeaveDurationMinutes(n * 60, hoursPerDay);
}

/**
 * 「剩餘額度」專用：負數是超用，寫成「超用 1 天 4 時」（比「剩 −1 天 4 時」好懂）；其餘同 `formatLeaveDuration`。
 * 調整額度的輸入框即時換算不要用這支——輸入 −4 是「減 4 小時」，不是超用。
 */
export function formatLeaveRemaining(hours: HoursInput, hoursPerDay?: HoursInput): string {
  const n = toFinite(hours);
  if (n == null) return "—";
  // 先四捨五入到分鐘：微小的負數（−0.001 小時）捨成 0 分，不算超用。
  const minutes = Math.round(Math.abs(n) * 60);
  if (n < 0 && minutes > 0) return `${LEAVE_OVERUSE_LABEL} ${formatLeaveDurationMinutes(minutes, hoursPerDay)}`;
  return formatLeaveDurationMinutes(minutes, hoursPerDay);
}

/**
 * 申請單的時數文字：**請假**（kind='leave'）→「N 天 N 時」；其他類型（加班、在家工作、出差…）→「N 小時」。
 * 簽核頁的「內容」欄、簽核卡這種「各種申請混在一起」的地方用——只有請假改天＋時，加班等維持小時。
 */
export function formatRequestHours(kind: string | null | undefined, hours: HoursInput, hoursPerDay?: HoursInput): string {
  return kind === "leave" ? formatLeaveDuration(hours, hoursPerDay) : fmtHours(hours);
}

/**
 * 「以小時輸入」的欄位旁邊即時換算成天＋時的提示（HR 手動給假／調整額度的輸入框用）。
 *
 *   ""／不是數字 →「以小時輸入」
 *   "56"        →「以小時輸入 · = 7 天」
 *   "-4"        →「以小時輸入 · = −4 時」（輸入負數是調減，照實顯示，不是超用）
 *
 * 輸入框維持小時（資料與 API 都是小時），這只是旁邊的換算提示。
 */
export function leaveHoursInputHint(value: string, hoursPerDay?: HoursInput): string {
  const n = toFinite(value);
  return n == null ? "以小時輸入" : `以小時輸入 · = ${formatLeaveDuration(n, hoursPerDay)}`;
}

/**
 * 出勤月表每天的請假摘要（`attendance_sheet_days.leave_summary`，API 算好存成字串）：
 * 「病假 1.5h；特休 8h」→「病假 1 時 30 分；特休 1 天」。
 *
 * 為什麼在 web 端轉：這是**存起來的顯示字串**，月表快照與已算好的舊列都是「N h」格式；API 那邊不改
 * （不動儲存），顯示時才逐段換。段落格式不是「名稱 數字h」就原樣保留，絕不丟字。
 */
export function reformatLeaveSummary(summary: string | null | undefined, hoursPerDay?: HoursInput): string | null {
  if (summary == null) return null;
  return summary
    .split("；")
    .map((part) => {
      const match = /^(.*\S)\s+(-?\d+(?:\.\d+)?)h$/.exec(part.trim());
      return match ? `${match[1]} ${formatLeaveDuration(Number(match[2]), hoursPerDay)}` : part;
    })
    .join("；");
}
