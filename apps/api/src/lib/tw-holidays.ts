/**
 * 台灣（中華民國）政府行政機關辦公日曆表的放假日——不含例假日（週六、週日），
 * POST /calendar/generate 在呼叫端未自帶 holidays 時匯入為 fixed_holiday。
 *
 * 這是 packages/db/src/seed/tw-holidays.ts（@hr/db 匯出的 TW_HOLIDAYS）的逐字
 * 副本：@hr/db 沒有 build 產物（package main 指向 .ts 原始碼、tsconfig noEmit），
 * apps/api 的 tsc（rootDir=src）與 Vercel 的部署都無法直接 import 它，所以 API
 * 端保留一份常數，並由 __tests__/tw-holidays.test.ts 釘住「JSON seed ＝ @hr/db
 * 匯出 ＝ 這份副本」三者一致——改任一份而沒同步另外兩份，測試就會紅。
 */
export interface TwHoliday {
  date: string
  label: string
  type?: "make_up" | "adjusted"
}

export const TW_HOLIDAYS: Record<number, TwHoliday[]> = {
  2026: [
    { date: "2026-01-01", label: "元旦" },
    { date: "2026-02-16", label: "春節（除夕）" },
    { date: "2026-02-17", label: "春節（初一）" },
    { date: "2026-02-18", label: "春節（初二）" },
    { date: "2026-02-19", label: "春節（初三）" },
    { date: "2026-02-20", label: "小年夜調整放假（小年夜2/15適逢週日，調整至本日放假）", type: "adjusted" },
    { date: "2026-02-27", label: "和平紀念日補假（2/28適逢週六）", type: "make_up" },
    { date: "2026-02-28", label: "和平紀念日" },
    { date: "2026-04-03", label: "兒童節補假（4/4適逢週六）", type: "make_up" },
    { date: "2026-04-04", label: "兒童節" },
    { date: "2026-04-05", label: "清明節" },
    { date: "2026-04-06", label: "清明節補假（4/5適逢週日）", type: "make_up" },
    { date: "2026-05-01", label: "勞動節" },
    { date: "2026-06-19", label: "端午節" },
    { date: "2026-09-25", label: "中秋節" },
    { date: "2026-09-28", label: "教師節" },
    { date: "2026-10-09", label: "國慶日補假（10/10適逢週六）", type: "make_up" },
    { date: "2026-10-10", label: "國慶日" },
    { date: "2026-10-25", label: "台灣光復暨金門古寧頭大捷紀念日" },
    { date: "2026-10-26", label: "台灣光復暨金門古寧頭大捷紀念日補假（10/25適逢週日）", type: "make_up" },
    { date: "2026-12-25", label: "行憲紀念日" },
  ],
}
