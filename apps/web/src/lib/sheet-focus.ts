/**
 * 出勤月表狀態藥丸 → 可處理的地方（2026-11-17 業主）：純邏輯（不 import React），單元測試在
 * __tests__/sheet-focus.test.ts。
 *
 * 錨點（網址 hash）：
 *   #anomalies          展開異常清單
 *   #anomalies-error    展開異常清單、只看「需處理」
 *   #anomalies-warn     展開異常清單、只看「提醒」
 *   #approve            捲到月表卡片的核准／退回按鈕區
 * 跨頁連結：/admin/attendance-statements?employee=<id>&period=YYYY-MM#anomalies-error（sheetFocusHref）。
 * 同頁：requestSheetFocus 改 hash（replaceState，不新增瀏覽紀錄）並廣播 SHEET_FOCUS_EVENT，
 * 月表卡片（SheetReviewBar）聽事件與載入時的 hash 來展開／捲動。
 */
import type { AnomalySeverity, SheetAnomaly, SheetStatus } from "./attendance-sheets-api";

export type SheetFocus = "anomalies" | "anomalies-error" | "anomalies-warn" | "approve";

export const SHEET_FOCUS_EVENT = "aster:sheet-focus";

const FOCUSES: readonly SheetFocus[] = ["anomalies", "anomalies-error", "anomalies-warn", "approve"];

/** hash（含或不含 #）→ focus；不認得回 null。 */
export function parseSheetFocusHash(hash: string | null | undefined): SheetFocus | null {
  const h = (hash ?? "").replace(/^#/, "");
  return (FOCUSES as readonly string[]).includes(h) ? (h as SheetFocus) : null;
}

/** focus → 異常清單篩選（null＝全部）。approve 不篩。 */
export function severityFilterOf(focus: SheetFocus | null): AnomalySeverity | null {
  if (focus === "anomalies-error") return "error";
  if (focus === "anomalies-warn") return "warn";
  return null;
}

/** 某員工某月的出勤統計表、直接到指定區塊（跨頁用）。 */
export function sheetFocusHref(employeeId: string, period: string, focus: SheetFocus): string {
  const qs = new URLSearchParams({ employee: employeeId, period });
  return `/admin/attendance-statements?${qs.toString()}#${focus}`;
}

/** 同頁：改 hash（不新增瀏覽紀錄）並通知月表卡片。 */
export function requestSheetFocus(focus: SheetFocus): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.hash = focus;
  window.history.replaceState(window.history.state, "", url.toString());
  window.dispatchEvent(new CustomEvent<SheetFocus>(SHEET_FOCUS_EVENT, { detail: focus }));
}

/** 逐日月表某一天那一列的 DOM id（AttendanceSheetTable 的 <tr id>）。 */
export function sheetDayRowId(date: string): string {
  return `sheet-day-${date}`;
}

export interface PillLink {
  label: string;
  focus: SheetFocus;
  ariaLabel: string;
}

/** 月表卡片上方的異常藥丸（需處理／提醒）；數量 0 不出。 */
export function anomalyPills(count: { error: number; warn: number }): PillLink[] {
  const out: PillLink[] = [];
  if (count.error > 0)
    out.push({ label: `需處理 ${count.error}`, focus: "anomalies-error", ariaLabel: `需處理異常 ${count.error} 項：展開異常清單並只看需處理項目` });
  if (count.warn > 0)
    out.push({ label: `提醒 ${count.warn}`, focus: "anomalies-warn", ariaLabel: `提醒 ${count.warn} 項：展開異常清單並只看提醒項目` });
  return out;
}

/** 狀態藥丸可不可以點到「送出／核准」操作區（草稿、已送出、經理已審、退回＝還沒核准）。 */
export function statusPillFocus(status: SheetStatus): SheetFocus | null {
  return status === "draft" || status === "submitted" || status === "manager_reviewed" || status === "returned" ? "approve" : null;
}

/**
 * 核准區的前置條件說明（不是 null 就顯示在核准按鈕旁；focus 有值＝說明可點到異常清單）：
 *   - 草稿／退回：要先送出（API 送出時會擋「需處理且沒填說明」的逐日異常）→ 有需處理異常時「需先處理 N 項異常才能送出／核准」；
 *   - 已送出：待經理審核；
 *   - 經理已審（核准鈕可按）：仍有需處理異常 → 提醒先確認（API 不擋核准）；
 *   - 已核准／鎖定、或可直接核准且沒異常 → null。
 */
export function approveHint(status: SheetStatus, errorCount: number): { text: string; focus: SheetFocus | null } | null {
  if (status === "approved" || status === "locked") return null;
  const errFocus: SheetFocus | null = errorCount > 0 ? "anomalies-error" : null;
  if (status === "draft" || status === "returned") {
    const head = status === "draft" ? "月表尚未送出" : "月表已退回、待員工修正後重新送出";
    return errorCount > 0
      ? { text: `需先處理 ${errorCount} 項異常才能核准（${head}；需處理異常要逐日填寫說明才送得出）`, focus: errFocus }
      : { text: `${head}：送出並經主管審核後才能核准`, focus: null };
  }
  if (status === "submitted")
    return { text: `月表已送出、待主管審核；審核後才能核准${errorCount > 0 ? `（另有 ${errorCount} 項需處理異常）` : ""}`, focus: errFocus };
  return errorCount > 0 ? { text: `仍有 ${errorCount} 項需處理異常，核准前請先確認`, focus: errFocus } : null;
}

/**
 * 月份級異常 → 可處理的頁面（沒有對應頁＝null，只顯示文字）。
 * 異常本身沒有帶單號，所以假單類連到簽核頁的待處理清單／月底核銷頁。
 */
export function monthAnomalyHref(code: string, employeeId: string | null): string | null {
  switch (code) {
    case "pending_leave_in_period":
      return "/admin/approvals";
    case "unsettled_leave_in_period":
      return "/admin/leave-settlement";
    case "no_salary_structure":
      return employeeId ? `/admin/employees/${encodeURIComponent(employeeId)}?tab=salary` : null;
    default:
      return null;
  }
}

/** 異常清單依篩選留哪些（月份級＋逐日共用）。 */
export function filterBySeverity<T extends Pick<SheetAnomaly, "severity">>(items: readonly T[], severity: AnomalySeverity | null): T[] {
  return severity ? items.filter((a) => a.severity === severity) : [...items];
}
