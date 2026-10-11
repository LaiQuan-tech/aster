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
 *   missing_in／missing_out／no_punch  缺上班卡、缺下班卡、平日完全沒打卡（可能是請假或假日，
 *               這頁看不出來，寧可列出讓員工自己判斷要不要補卡）
 *   bad_order   上下班都有但時長算不出來（下班早於上班）
 *   weekend     休息日有打卡（buildDayRows 只在週六日有紀錄時才列）
 *   上下班都完整的平日 → 不算。
 *
 * ── 開關記憶 ───────────────────────────────────────────────────────────────────
 * 用 localStorage 當 per-viewer 的便利記憶（ESS 與後台各自一份）；讀寫都包 try/catch，
 * 私密視窗／封鎖網站資料／儲存空間滿了都只會退回「預設關」，不影響畫面。
 */
import type { SheetDayView } from "./attendance-sheets-api";
import { weekdayOf } from "./ess-format";
import type { DayRow } from "./punch-history";

/* ------------------------------------------------------------ 月表 --- */

export type SheetDayReason = "error" | "warn" | "leave" | "overtime" | "override" | "late" | "outing" | "note";

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const hasText = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/**
 * 這一天為什麼「有事」（空陣列＝平淡的正常出勤）。順序固定：error、warn、leave、overtime、
 * override、late、outing、note。欄位缺漏（舊版快照）一律當沒有，不會丟例外。
 */
export function sheetDayReasons(day: SheetDayView): SheetDayReason[] {
  const reasons: SheetDayReason[] = [];
  const anomalies = Array.isArray(day.anomalies) ? day.anomalies : [];
  if (anomalies.some((a) => a?.severity === "error")) reasons.push("error");
  if (anomalies.some((a) => a?.severity === "warn")) reasons.push("warn");
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
export function isNotableSheetDay(day: SheetDayView): boolean {
  return sheetDayReasons(day).length > 0;
}

/* ------------------------------------------------------ 打卡紀錄頁 --- */

export type PunchRowReason = "today" | "missing_in" | "missing_out" | "no_punch" | "bad_order" | "weekend";

/** 打卡紀錄頁這一列為什麼要預設顯示（空陣列＝上下班都完整的平日）。`today` 是 `YYYY-MM-DD`（當地今天）。 */
export function punchRowReasons(row: Pick<DayRow, "date" | "status" | "durationMin">, today: string): PunchRowReason[] {
  const reasons: PunchRowReason[] = [];
  if (row.date === today) reasons.push("today");
  if (row.status === "missing_in") reasons.push("missing_in");
  else if (row.status === "missing_out") reasons.push("missing_out");
  else if (row.status === "none") reasons.push("no_punch");
  else if (row.durationMin == null) reasons.push("bad_order");
  const weekday = weekdayOf(row.date);
  if (weekday === 0 || weekday === 6) reasons.push("weekend");
  return reasons;
}

export function isNotablePunchRow(row: Pick<DayRow, "date" | "status" | "durationMin">, today: string): boolean {
  return punchRowReasons(row, today).length > 0;
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

export function partitionSheetDays(days: readonly SheetDayView[], showAll: boolean): Partition<SheetDayView> {
  return partitionNotable(days, isNotableSheetDay, showAll);
}

export function partitionPunchRows<T extends Pick<DayRow, "date" | "status" | "durationMin">>(
  rows: readonly T[],
  showAll: boolean,
  today: string,
): Partition<T> {
  return partitionNotable(rows, (row) => isNotablePunchRow(row, today), showAll);
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
  emptyHint: (total: number) => `沒有缺卡、未打卡或休息日出勤的日子；打開上方「顯示全部日期」可以看全部 ${total} 天。`,
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
