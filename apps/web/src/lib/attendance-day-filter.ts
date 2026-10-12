/**
 * 「這天有沒有事」的判斷（2026-10-11，0930 會議）：出勤月表預設只顯示有事的日子、打卡紀錄頁預設
 * 只列需要處理的日子，平淡的正常出勤收起來，另提供「顯示全月」開關，避免畫面冗長。
 * 純函式、不碰 React／DOM；測試在 `__tests__/attendance-day-filter.test.ts`。
 *
 * ── 月表（SheetDayView）：符合任一條就是「有事」，預設顯示 ──────────────────────────
 *   error     有錯誤級異常（缺卡、有卡無法配對、有排班無打卡、請假與工時重疊、超額加班沒有核准單…）。
 *             **永遠不能藏**：員工送出前要在表格裡逐項說明這些日子（見 attendance-sheets-api 的
 *             unacknowledgedErrors），主管審核也要看得到。
 *   warn      有警示級異常（遲到、早退、加班被覆寫、單日加班超上限、假日出勤、外出未配對、補打卡、
 *             跨午夜）。判斷：顯示。它們全是「這天不尋常、可能需要說明或核對」的訊號，數量遠少於整月；
 *             藏起來，遲到、補打卡這種要核對的日子就得打開全月才找得到。
 *   info      只有資訊級（延長工時扣晚餐、超額另計的說明）→ 不算。它們只會出現在本來就有加班的日子。
 *   no_punch  員工本人月表的「無打卡紀錄」（2026-10-12）：上班日整天沒打卡、也沒請假／在家／出差公出。
 *             單看當天資料判斷不出來（要今天、計算時間、到職日、出差單），由頁面用 lib/sheet-no-punch.ts
 *             算好、經 partitionSheetDays 的 `extraOf` 傳進來；不傳就沒有這一條（後台、主管審核頁）。
 *   leave     有請假
 *   overtime  有加班（含月上限之外改為另行給付的分鐘）
 *   override  加班時數被人工覆寫（審核覆寫）——即使覆寫成 0 也算，那是一筆需要留意的紀錄
 *   late      遲到／早退分鐘 > 0（與合計卡片的「遲到」對得起來；通常 warn 已涵蓋，這裡是保險）
 *   outing    外出分鐘 > 0（與合計卡片的「外出時數」對得起來）
 *   note      有人手動填過內容／外出地點／備註／異常說明，或指定了專案（這些欄位都是人填的，不是系統帶入）
 * 不算「有事」：平常上下班、休息日／國定假日沒有任何紀錄、單純在家工作（只掛「在家」標籤）。
 * 原則：合計卡片上的特殊數字（遲到、請假、加班、超額、外出），都能在預設顯示的日子裡找到來源。
 *
 * ── 打卡紀錄頁（DayRow）：沒有請假／加班資料（那在月表），只看打卡本身 ──────────────
 *   today       今天（還在進行中，不該憑空消失）
 *   missing_in／missing_out／no_punch  缺上班卡、缺下班卡、上班日完全沒打卡（寧可列出讓員工自己判斷要不要補卡）
 *   holiday     國定假日沒打卡（2026-10-12 業主要求：一律列出、標「國定假日」）——預設顯示，但不算 no_punch（不是缺卡）
 *   covered     上班日沒打卡、但整天有已核准的請假／公出／在家工作／出差（頁面傳 `coveredDates`）——
 *               預設顯示（員工一眼看到「請假・特休（事由）」），但不算 no_punch（不是缺卡）
 *   bad_order   上下班都有但時長算不出來（下班早於上班）
 *   non_workday 休息日、國定假日有打卡（buildDayRows 只在非上班日有紀錄時才列）。哪天是上班日（2026-10-12）：
 *               頁面傳了行事曆裁定（dayType）就照裁定——平日的國定假日去加班要列、補班的週六完整打卡不列；
 *               沒有裁定（含行事曆抓不到）＝週六日（leave-hours 的 isWorkday，與 buildDayRows 補空列同一條規則）。
 *   上下班都完整的上班日 → 不算。
 *
 * ── 開關記憶 ───────────────────────────────────────────────────────────────────
 * 用 localStorage 當 per-viewer 的便利記憶（ESS 與後台各自一份）；讀寫都包 try/catch，
 * 私密視窗／封鎖網站資料／儲存空間滿了都只會退回「預設關」，不影響畫面。
 */
import type { SheetDayView } from "./attendance-sheets-api";
import { isWorkday, type DayType } from "./leave-hours";
import type { DayRow } from "./punch-history";

/* ------------------------------------------------------------ 月表 --- */

export type SheetDayReason =
  | "error"
  | "warn"
  | "no_punch"
  | "leave"
  | "overtime"
  | "override"
  | "late"
  | "outing"
  | "note";

/** 單看當天資料判斷不出來、由頁面另外算好傳進來的「有事」。 */
export interface SheetDayExtra {
  /** 員工本人月表的「無打卡紀錄」（lib/sheet-no-punch.ts）。 */
  noPunch?: boolean;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const hasText = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/**
 * 這一天為什麼「有事」（空陣列＝平淡的正常出勤）。順序固定：error、warn、no_punch、leave、overtime、
 * override、late、outing、note。欄位缺漏（舊版快照）一律當沒有，不會丟例外。
 * `extra` 是頁面另外算好的判斷（目前只有 no_punch）；不帶＝只看當天資料。
 */
export function sheetDayReasons(day: SheetDayView, extra: SheetDayExtra = {}): SheetDayReason[] {
  const reasons: SheetDayReason[] = [];
  const anomalies = Array.isArray(day.anomalies) ? day.anomalies : [];
  if (anomalies.some((a) => a?.severity === "error")) reasons.push("error");
  if (anomalies.some((a) => a?.severity === "warn")) reasons.push("warn");
  if (extra.noPunch === true) reasons.push("no_punch");
  if (num(day.leaveMinutes) > 0 || hasText(day.leaveSummary)) reasons.push("leave");

  const ot = day.overtime;
  const overtimeMinutes = Math.max(
    num(ot?.effective),
    num(ot?.computed),
    num(ot?.tier1) + num(ot?.tier2) + num(ot?.tier3),
    num(ot?.beyondCap),
  );
  if (overtimeMinutes > 0) reasons.push("overtime");
  if (ot?.override != null) reasons.push("override");

  if (num(day.lateMinutes) > 0 || num(day.earlyLeaveMinutes) > 0) reasons.push("late");
  if (num(day.outingMinutes) > 0) reasons.push("outing");
  if (
    hasText(day.content) ||
    hasText(day.outingNote) ||
    hasText(day.note) ||
    hasText(day.anomalyAck) ||
    hasText(day.projectId) ||
    hasText(day.projectName)
  ) {
    reasons.push("note");
  }
  return reasons;
}

/** 月表這天有事嗎（預設要顯示）。 */
export function isNotableSheetDay(day: SheetDayView, extra?: SheetDayExtra): boolean {
  return sheetDayReasons(day, extra).length > 0;
}

/* ------------------------------------------------------ 打卡紀錄頁 --- */

export type PunchRowReason =
  | "today"
  | "missing_in"
  | "missing_out"
  | "no_punch"
  | "holiday"
  | "covered"
  | "bad_order"
  | "non_workday";

/** 單看打卡判斷不出來、由頁面另外算好傳進來的資訊。 */
export interface PunchRowExtra {
  /** 這天整天有已核准的請假／公出／在家工作／出差（punch-day-status 的 `approvedCoverageByDate` 的 `full`）。 */
  covered?: boolean;
}

/** 行事曆裁定（`GET /calendar` 的 date → day_type，同 buildDayRows 的 `dayTypeByDate`）；沒有那天＝週一～五上班。 */
export type DayTypeByDate = Readonly<Record<string, DayType | undefined>>;

/**
 * 打卡紀錄頁這一列為什麼要預設顯示（空陣列＝上下班都完整的上班日）。`today` 是 `YYYY-MM-DD`（當地今天）。
 * `dayType`（選填）＝這天的行事曆裁定：workday（補班）算上班日、rest_day／fixed_holiday 不算；省略＝週一～五。
 * 沒打卡的日子：國定假日 → holiday、整天有已核准的單（`extra.covered`）→ covered，其餘 → no_punch（缺卡）。
 */
export function punchRowReasons(
  row: Pick<DayRow, "date" | "status" | "durationMin">,
  today: string,
  dayType?: DayType,
  extra: PunchRowExtra = {},
): PunchRowReason[] {
  const reasons: PunchRowReason[] = [];
  const holidayNoPunch = row.status === "none" && dayType === "fixed_holiday";
  if (row.date === today) reasons.push("today");
  if (row.status === "missing_in") reasons.push("missing_in");
  else if (row.status === "missing_out") reasons.push("missing_out");
  else if (row.status === "none") reasons.push(holidayNoPunch ? "holiday" : extra.covered ? "covered" : "no_punch");
  else if (row.durationMin == null) reasons.push("bad_order");
  // non_workday＝休息日、國定假日「有打卡」；國定假日沒打卡已經是 holiday，不重複。
  if (!holidayNoPunch && !isWorkday(row.date, dayType)) reasons.push("non_workday");
  return reasons;
}

export function isNotablePunchRow(
  row: Pick<DayRow, "date" | "status" | "durationMin">,
  today: string,
  dayType?: DayType,
  extra?: PunchRowExtra,
): boolean {
  return punchRowReasons(row, today, dayType, extra).length > 0;
}

/* ------------------------------------------------------------ 分組 --- */

export interface PartitionEntry<T> {
  item: T;
  /** 有事（預設會顯示）。 */
  notable: boolean;
  /** 目前畫面上要收起來（沒開「顯示全月」而且沒事）。 */
  hidden: boolean;
}

export interface Partition<T> {
  /** 全部項目，保持原順序；畫面依 `hidden` 決定顯示與否（列印時仍可全部印出）。 */
  entries: PartitionEntry<T>[];
  total: number;
  notableCount: number;
  /** 目前被收起來的天數（開了「顯示全月」＝0）。 */
  hiddenCount: number;
  /** 目前畫面上看得到的天數。 */
  visibleCount: number;
}

export function partitionNotable<T>(items: readonly T[], isNotable: (item: T) => boolean, showAll: boolean): Partition<T> {
  const entries = items.map((item) => {
    const notable = isNotable(item);
    return { item, notable, hidden: !showAll && !notable };
  });
  const hiddenCount = entries.filter((entry) => entry.hidden).length;
  return {
    entries,
    total: entries.length,
    notableCount: entries.filter((entry) => entry.notable).length,
    hiddenCount,
    visibleCount: entries.length - hiddenCount,
  };
}

/**
 * 月表分組。`extraOf`（選填）逐日回傳頁面另外算好的判斷（員工本人月表傳「無打卡紀錄」），
 * 成立的日子跟其他有事的日子一樣預設顯示、不會被「顯示全月」收起；不帶＝只看當天資料（後台、主管審核頁）。
 */
export function partitionSheetDays(
  days: readonly SheetDayView[],
  showAll: boolean,
  extraOf?: (day: SheetDayView) => SheetDayExtra | undefined,
): Partition<SheetDayView> {
  return partitionNotable(days, (day) => isNotableSheetDay(day, extraOf?.(day)), showAll);
}

/**
 * 打卡紀錄頁分組。`dayTypeByDate`（選填）＝行事曆裁定，判斷哪天是上班日（見 punchRowReasons）；
 * 不帶或沒有那天＝週一～五（行事曆抓不到時的舊規則）。`coveredDates`（選填）＝整天有已核准單的日期。
 * 國定假日、整天有已核准單的日子一律預設顯示（理由是 holiday／covered，不是缺卡）。
 */
export function partitionPunchRows<T extends Pick<DayRow, "date" | "status" | "durationMin">>(
  rows: readonly T[],
  showAll: boolean,
  today: string,
  dayTypeByDate?: DayTypeByDate,
  coveredDates?: ReadonlySet<string>,
): Partition<T> {
  return partitionNotable(
    rows,
    (row) => isNotablePunchRow(row, today, dayTypeByDate?.[row.date], { covered: coveredDates?.has(row.date) ?? false }),
    showAll,
  );
}

/* ------------------------------------------------------------ 文案 --- */

export const SHEET_FILTER_TEXT = {
  showAll: (total: number) => `顯示全月（${total} 天）`,
  hidden: (hidden: number) => `已隱藏 ${hidden} 天正常出勤`,
  emptyTitle: "本月沒有請假、加班或異常",
  emptyHint: (total: number) => `這個月的 ${total} 天都是正常出勤；打開上方「顯示全月」可以看每一天。`,
} as const;

export const PUNCH_FILTER_TEXT = {
  showAll: (total: number) => `顯示全部日期（${total} 天）`,
  hidden: (hidden: number) => `已隱藏 ${hidden} 天打卡正常的日子`,
  emptyTitle: "這段期間的打卡都正常",
  emptyHint: (total: number) =>
    `沒有缺卡、未打卡、國定假日、整天請假或休息日出勤的日子；打開上方「顯示全部日期」可以看全部 ${total} 天。`,
} as const;

/* ------------------------------------------------------ 開關記憶 --- */

/** 月表開關記憶的範圍：員工前台與後台各記各的。 */
export type SheetFilterScope = "ess" | "admin";

export const SHEET_SHOW_ALL_STORAGE_KEY: Record<SheetFilterScope, string> = {
  ess: "hr.ess.attendance-sheet.show-all.v1",
  admin: "hr.admin.attendance-sheet.show-all.v1",
};

export const PUNCHES_SHOW_ALL_STORAGE_KEY = "hr.ess.punches.show-all.v1";

/** `window.localStorage` 的最小介面（測試用假物件即可）。 */
export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 取瀏覽器的 localStorage；伺服端、被封鎖（存取就丟 SecurityError）一律回 null。
 * 讀寫函式吃 null 就退回「預設關」。
 */
export function browserStorage(): FlagStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 讀開關記憶：只有存了 "1" 才是開；沒記憶、讀取失敗、storage 不存在一律預設關。 */
export function readStoredFlag(storage: Pick<FlagStorage, "getItem"> | null | undefined, key: string): boolean {
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** 寫開關記憶（關＝移除該鍵，保持儲存空間乾淨）。失敗不丟例外，回傳是否寫成功。 */
export function writeStoredFlag(storage: Pick<FlagStorage, "setItem" | "removeItem"> | null | undefined, key: string, value: boolean): boolean {
  if (!storage) return false;
  try {
    if (value) storage.setItem(key, "1");
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
