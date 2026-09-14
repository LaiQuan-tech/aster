/**
 * 台灣（中華民國）政府行政機關辦公日曆表的放假日——不含例假日（週六、週日），
 * 供 POST /calendar/generate 在租戶未自帶清單時匯入為 fixed_holiday。
 *
 * 內容與 packages/db/seed/tw-holidays-2026.json 的 `holidays` 陣列逐筆相同
 * （JSON 是人工核對用的原始檔，這裡是程式可 import 的型別化版本；apps/api 另
 * 有一份同內容的常數，並以測試釘住三者一致，見
 * apps/api/src/__tests__/tw-holidays.test.ts）。新年度的清單請同時加進 JSON 與
 * 這裡的 Record。
 *
 * `type` 只在補假／調整放假時出現（'make_up' | 'adjusted'），一般放假日省略。
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
