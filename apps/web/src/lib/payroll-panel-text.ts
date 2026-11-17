/**
 * 員工薪資頁下半部（固定津貼／歷程紀錄／健保眷屬／扶養親屬）精簡版 UI 的顯示字（2026-11-17 業主：「UI 改簡單一點」）。
 * 純函式，不 import React／DOM（單元測試 __tests__/payroll-panel-text.test.ts）。不碰任何資料邏輯。
 */

const fmt = (n: number) => n.toLocaleString("zh-TW");

/** 固定津貼精簡列摘要：沒有＝「無」；有＝「2 項・本月合計 3,000 元」。 */
export function fixedAllowanceSummaryText(count: number, activeTotal: number | null | undefined): string {
  if (count === 0) return "無";
  return activeTotal && activeTotal > 0 ? `${count} 項・本月合計 ${fmt(activeTotal)} 元` : `${count} 項`;
}

/** 歷程紀錄收合標題：「歷程紀錄（調薪 2・投保 1）」；都沒有＝「歷程紀錄（無紀錄）」。 */
export function historyTitle(salaryCount: number, insuredCount: number): string {
  if (salaryCount === 0 && insuredCount === 0) return "歷程紀錄（無紀錄）";
  return `歷程紀錄（調薪 ${salaryCount}・投保 ${insuredCount}）`;
}

/** 單段空白時的字：「無紀錄」；有＝「N 筆」。 */
export function countText(n: number, empty = "無紀錄"): string {
  return n === 0 ? empty : `${n} 筆`;
}

/**
 * 健保眷屬一行：「健保眷屬：2 人（依明細）」「健保眷屬：5 人（計費 3 人・直接輸入）」。
 * 還沒讀到人數（null）→「健保眷屬：明細 N 筆」。
 */
export function nhiHeadline(
  data: { effective: number; billable: number; override: number | null } | null,
  detailCount: number,
): string {
  if (!data) return `健保眷屬：明細 ${detailCount} 筆`;
  const source = data.override != null ? "直接輸入" : "依明細";
  const billing = data.billable !== data.effective ? `計費 ${data.billable} 人・` : "";
  return `健保眷屬：${data.effective} 人（${billing}${source}）`;
}

/** 扶養親屬一行：「扶養親屬：N 人」。 */
export function taxDependentsHeadline(count: number): string {
  return `扶養親屬：${count} 人`;
}
