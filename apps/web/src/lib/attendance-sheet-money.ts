/**
 * 出勤月表「薪資試算」卡片的三段（應發／應扣／實發）資料列。純函式（單元測試 __tests__/attendance-sheet-money.test.ts）。
 *
 * 2026-11-08：「補貼」那列＝定額補貼＋固定津貼應稅部分（後端 attendance-sheets toMoney 已併在 allowances），
 * 固定津貼的免稅部分（伙食費免稅額內）不在應發、但已含在實發 → 實發段另列「免稅津貼（不計應發）」，
 * 畫面上 應發合計 − 應扣合計 ＋ 免稅津貼 ＝ 實發金額 對得起來。沒有免稅津貼時版面與以前相同（不多一列）。
 */
import type { SheetMoney } from "./attendance-sheets-api";

export const SHEET_MONEY_STRONG = ["應發合計", "應扣合計", "實發金額", "薪資＋代墊"];

export function sheetMoneySections(
  m: SheetMoney,
  tierLabels: [string, string, string],
): Array<{ title: string; rows: Array<[string, number | undefined]> }> {
  const taxFree = Number(m.fixedAllowancesTaxFree ?? 0) || 0;
  return [
    {
      title: "應發",
      rows: [
        ["本薪", m.base],
        [`加班費 ${tierLabels[0]}`, m.otPayByTier.tier1],
        [`加班費 ${tierLabels[1]}`, m.otPayByTier.tier2],
        [`加班費 ${tierLabels[2]}`, m.otPayByTier.tier3],
        ["夜間加給", m.nightPay],
        ["全勤獎金", m.attendanceBonus],
        ["定額補貼＋固定津貼（應稅）", m.allowances],
        ["應發合計", m.gross],
      ],
    },
    {
      title: "應扣",
      rows: [
        ["勞保自付", m.laborInsurance],
        ["健保自付", m.healthInsurance],
        ["勞退自提", m.pensionVoluntary],
        ["預支扣回", m.advance],
        ["請假扣款", m.leaveDeduction],
        ["遲到早退扣款", m.lateEarlyDeduction],
        ["應扣合計", m.totalDeductions],
      ],
    },
    {
      title: "實發",
      rows: [
        ...(taxFree !== 0 ? ([["免稅津貼（不計應發）", taxFree]] as Array<[string, number]>) : []),
        ["實發金額", m.net],
        ["代墊支出（不計薪資所得）", m.expenses],
        ["薪資＋代墊", m.netPlusExpenses],
      ],
    },
  ];
}
