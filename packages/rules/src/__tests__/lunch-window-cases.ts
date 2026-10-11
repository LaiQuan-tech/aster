/**
 * 午休區間的共用測試案例（2026-10-11）。
 *
 * 同一份表給兩邊用：
 *   • packages/rules/src/__tests__/lunch-window.test.ts → @hr/rules 的 lunchWindowOf
 *   • apps/web/src/lib/__tests__/lunch-window-parity.test.ts → web leave-hours 的 lunchWindowOfShift
 * 兩份實作必須對每一筆給出同一個答案（web 不依賴 @hr/rules，只能各寫一份，用這張表鎖住）。
 * 刻意不 import 任何東西，web 的 tsc／vitest 直接吃得到。
 *
 * 時間軸＝班別座標：自上班那天 00:00 起算的分鐘，跨日班的隔日時刻 +1440。
 */

export interface LunchCase {
  name: string;
  shift: { start: string; end: string; breakMinutes: number; breakStart?: string | null };
  expected: { start: number; end: number; source: "break_start" | "noon" | "legacy" } | null;
}

export const LUNCH_CASES: LunchCase[] = [
  // ── 規則 1：班別明設午休開始 ──
  {
    name: "日班 09:00–18:00 休 60、午休 12:00 → 12:00–13:00",
    shift: { start: "09:00", end: "18:00", breakMinutes: 60, breakStart: "12:00" },
    expected: { start: 720, end: 780, source: "break_start" },
  },
  {
    name: "日班明設 12:30、休 45 → 12:30–13:15",
    shift: { start: "09:00", end: "18:00", breakMinutes: 45, breakStart: "12:30" },
    expected: { start: 750, end: 795, source: "break_start" },
  },
  {
    name: "午班 14:00–22:00 明設晚餐 18:00 → 18:00–19:00",
    shift: { start: "14:00", end: "22:00", breakMinutes: 60, breakStart: "18:00" },
    expected: { start: 1080, end: 1140, source: "break_start" },
  },
  {
    name: "夜班 22:00–06:00 明設 02:00 → 隔日 02:00–03:00（+1440）",
    shift: { start: "22:00", end: "06:00", breakMinutes: 60, breakStart: "02:00" },
    expected: { start: 1560, end: 1620, source: "break_start" },
  },
  {
    name: "夜班 22:00–06:00 明設 23:00 → 當日 23:00–24:00",
    shift: { start: "22:00", end: "06:00", breakMinutes: 60, breakStart: "23:00" },
    expected: { start: 1380, end: 1440, source: "break_start" },
  },
  {
    name: "DB time 欄位的 HH:MM:SS 也吃",
    shift: { start: "09:00:00", end: "18:00:00", breakMinutes: 60, breakStart: "12:00" },
    expected: { start: 720, end: 780, source: "break_start" },
  },
  // ── 規則 2：沒設、涵蓋 12:00 ──
  {
    name: "日班 09:00–18:00 休 60（沒設）→ 12:00–13:00",
    shift: { start: "09:00", end: "18:00", breakMinutes: 60 },
    expected: { start: 720, end: 780, source: "noon" },
  },
  {
    name: "晚到班 10:00–19:00 休 60 → 12:00–13:00",
    shift: { start: "10:00", end: "19:00", breakMinutes: 60, breakStart: null },
    expected: { start: 720, end: 780, source: "noon" },
  },
  {
    name: "09:00–17:50 休 45 → 12:00–12:45",
    shift: { start: "09:00", end: "17:50", breakMinutes: 45 },
    expected: { start: 720, end: 765, source: "noon" },
  },
  {
    name: "08:00–13:00 休 60：午休剛好收在下班 → 12:00–13:00",
    shift: { start: "08:00", end: "13:00", breakMinutes: 60 },
    expected: { start: 720, end: 780, source: "noon" },
  },
  {
    name: "跨日長班 20:00–14:00 涵蓋隔日 12:00 → 隔日 12:00–13:00",
    shift: { start: "20:00", end: "14:00", breakMinutes: 60 },
    expected: { start: 2160, end: 2220, source: "noon" },
  },
  // ── 規則 3：舊推算（工作時數中點） ──
  {
    name: "午班 14:00–22:00 休 60 → 17:30–18:30（不涵蓋 12:00，行為不變）",
    shift: { start: "14:00", end: "22:00", breakMinutes: 60 },
    expected: { start: 1050, end: 1110, source: "legacy" },
  },
  {
    name: "夜班 22:00–06:00 休 60 → 01:30–02:30（+1440）",
    shift: { start: "22:00", end: "06:00", breakMinutes: 60 },
    expected: { start: 1530, end: 1590, source: "legacy" },
  },
  {
    name: "12:00 才上班（12:00–21:00 休 60）不算涵蓋 → 中點 16:00–17:00",
    shift: { start: "12:00", end: "21:00", breakMinutes: 60 },
    expected: { start: 960, end: 1020, source: "legacy" },
  },
  {
    name: "午休放不進班內（08:00–12:30 休 60）→ 中點 09:45–10:45",
    shift: { start: "08:00", end: "12:30", breakMinutes: 60 },
    expected: { start: 585, end: 645, source: "legacy" },
  },
  {
    name: "00:00–08:30 休 30（夜間班）→ 中點 04:00–04:30",
    shift: { start: "00:00", end: "08:30", breakMinutes: 30 },
    expected: { start: 240, end: 270, source: "legacy" },
  },
  {
    name: "工時奇數分鐘：13:00–20:05 休 60 → 中點起點有小數（16:02.5）",
    shift: { start: "13:00", end: "20:05", breakMinutes: 60 },
    expected: { start: 962.5, end: 1022.5, source: "legacy" },
  },
  // ── 沒有午休 ──
  {
    name: "休 0 分 → null（就算有設午休開始）",
    shift: { start: "09:00", end: "18:00", breakMinutes: 0, breakStart: "12:00" },
    expected: null,
  },
  {
    name: "短班 09:00–13:00 休 0 → null",
    shift: { start: "09:00", end: "13:00", breakMinutes: 0 },
    expected: null,
  },
  {
    name: "時間格式不對 → null",
    shift: { start: "9am", end: "18:00", breakMinutes: 60 },
    expected: null,
  },
];
