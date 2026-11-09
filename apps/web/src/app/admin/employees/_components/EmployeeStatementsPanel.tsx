"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Empty, ErrorText, Pill, useToast } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import { StatementTable } from "@/components/StatementTable";
import { apiErrorMessage } from "@/lib/api-client";
import {
  downloadStatementXlsx,
  getEmployeeStatements,
  recomputeNote,
  type EmployeeStatements,
  type StatementGrid,
} from "@/lib/statements-api";

/**
 * 員工內頁的「出勤統計表／薪資明細表」分頁（2026-10-27 業主：格式跟公司現行 Excel 一模一樣）。
 *
 * 一次讀兩張表（GET /employees/:id/statements），切分頁不重抓；月份預設由 API 決定（上個月有資料就上個月，
 * 否則最新有資料的月份）。會計：API 只回出勤統計表、金額已遮成「—」；薪資明細表分頁由頁面隱藏、API 也擋。
 *
 * `live`（2026-11-09 後台「出勤統計表」頁）：開畫面即重算未核准月份（API 端節流）、「重新整理」鈕強制重算；
 * 分頁「出勤｜請假單｜支出表」（照客戶 Excel 三個工作表）、「顯示假日列」切換（預設隱藏＝Excel 印出狀態）、
 * 已核准月份顯示凍結提示與核准時間；視覺照客戶 Excel 原樣（variant="excel"）。下載 Excel＝同一份資料三個工作表。
 *
 * 受控月份（2026-11-09 出勤統計表合併頁）：帶 `period` 時月份由頁面決定（頁首的月份選擇），面板不顯示自己的
 * 月份選擇；`reloadKey` 變動＝重抓（簽核動作後）；`onLoaded` 回報每次讀到的資料（重算後頁面同步刷新月表清單）。
 */

export type StatementTab = "attendance" | "payslip";
type SheetTab = "attendance" | "leaveForm" | "expenseSheet";

const SHEET_TABS: Array<{ key: SheetTab; label: string }> = [
  { key: "attendance", label: "出勤" },
  { key: "leaveForm", label: "請假單" },
  { key: "expenseSheet", label: "支出表" },
];

function sourceNote(data: EmployeeStatements, kind: StatementTab): string | null {
  const summary = kind === "attendance" ? data.attendance : data.payslip;
  if (!summary) return null;
  const notes: string[] = [];
  if (!summary.hasAttendance) notes.push("此月尚無出勤月表，逐日與時數為空白");
  if (data.canSeeMoney) {
    if (summary.moneySource === "preview") notes.push("尚未產生薪資單，金額為月表試算");
    else if (summary.moneySource === null) notes.push("沒有薪資資料（未設定薪資結構或尚未產生薪資單），金額顯示「—」");
    else if (summary.payslipStatus === "draft") notes.push("薪資單尚未定案（草稿）");
  } else if (kind === "attendance") {
    notes.push("金額欄位僅 HR 可見");
  }
  return notes.length > 0 ? notes.join("；") : null;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function EmployeeStatementsPanel({
  employeeId,
  kind,
  live = false,
  period: controlledPeriod,
  reloadKey = 0,
  onLoaded,
}: {
  employeeId: string;
  kind: StatementTab;
  /** 後台「出勤統計表」頁：開畫面即重算＋三頁分頁＋假日列切換＋凍結提示（見檔頭）。 */
  live?: boolean;
  /** 受控月份（見檔頭）；省略＝面板自己決定與切換月份。 */
  period?: string;
  /** 變動＝用同一個月份重抓。 */
  reloadKey?: number;
  /** 每次讀取成功後回報（含重新整理）。 */
  onLoaded?: (data: EmployeeStatements, refreshed: boolean) => void;
}) {
  const controlled = controlledPeriod !== undefined;
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);
  const toast = useToast();
  const [period, setPeriod] = useState<string | undefined>(undefined);
  const [data, setData] = useState<EmployeeStatements | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [sheetTab, setSheetTab] = useState<SheetTab>("attendance");
  const [showHolidays, setShowHolidays] = useState(false);

  const load = useCallback(
    async (p?: string, refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await getEmployeeStatements(employeeId, p, live ? { live: true, refresh } : {});
        setData(res);
        setPeriod(res.period);
        onLoadedRef.current?.(res, refresh);
        if (refresh) {
          const note = recomputeNote(res.recompute);
          if (note) toast.show(note, res.recompute?.ran ? "success" : "info");
        }
      } catch (err) {
        setError(apiErrorMessage(err, "讀取失敗"));
      } finally {
        setLoading(false);
      }
    },
    [employeeId, live, toast],
  );

  useEffect(() => {
    void load(controlledPeriod);
    // 換員工（受控時換月份或 reloadKey）才重抓；load 依賴 toast（每次 render 穩定），不要讓它觸發重抓。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, live, controlledPeriod, reloadKey]);

  const summary = data ? (kind === "attendance" ? data.attendance : data.payslip) : null;
  const label = kind === "attendance" ? "出勤統計表" : "薪資明細表";
  let grid: StatementGrid | null = summary?.grid ?? null;
  if (live && data && kind === "attendance") {
    if (sheetTab === "leaveForm") grid = data.attendance.leaveForm ?? null;
    else if (sheetTab === "expenseSheet") grid = data.attendance.expenseSheet ?? null;
  }

  async function download() {
    if (!data || !period) return;
    setDownloading(true);
    try {
      await downloadStatementXlsx(employeeId, kind, period, data.employee.empNo);
    } catch (err) {
      toast.show(apiErrorMessage(err, "下載失敗"), "error");
    } finally {
      setDownloading(false);
    }
  }

  const note = data ? sourceNote(data, kind) : null;
  const att = data?.attendance;
  const frozen = live && att?.frozen === true;
  const liveNote = live && data && !frozen ? recomputeNote(data.recompute ?? null) : null;

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-gray-900">{label}</h2>
          {data && period && data.periods.includes(period) && <Pill tone="green">有資料</Pill>}
          {live && att && (frozen ? <Pill tone="blue">已核准（凍結）</Pill> : att.hasAttendance ? <Pill tone="amber">未核准（即時）</Pill> : null)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {period && !controlled && <MonthPicker value={period} onChange={(p) => void load(p)} disabled={loading} />}
          {live && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load(period, true)}
              disabled={!data || loading || frozen}
              title={frozen ? "已核准的月份顯示核准當時的凍結版本，不重算" : "依最新打卡、補登、請假、加班紀錄重算本月"}
            >
              重新整理
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!grid || loading}>
            列印
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void download()} loading={downloading} disabled={!summary || loading}>
            下載 Excel
          </Button>
        </div>
      </div>
      {live && data && kind === "attendance" && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <div role="tablist" aria-label="工作表" className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
            {SHEET_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={sheetTab === t.key}
                onClick={() => setSheetTab(t.key)}
                className={`rounded-md px-3 py-1 text-sm ${sheetTab === t.key ? "bg-white font-medium text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {sheetTab !== "expenseSheet" && (
            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={showHolidays} onChange={(e) => setShowHolidays(e.target.checked)} />
              顯示假日列
            </label>
          )}
        </div>
      )}
      {!live && kind === "attendance" && summary && (
        <div className="mb-3 flex justify-end print:hidden">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={showHolidays} onChange={(e) => setShowHolidays(e.target.checked)} />
            顯示假日列
          </label>
        </div>
      )}
      {frozen && (
        <p className="mb-3 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-800 print:hidden">
          已核准凍結版本（核准於 {fmtDateTime(att?.approvedAt)}
          {att?.lockedAt ? `；鎖定於 ${fmtDateTime(att.lockedAt)}` : ""}）：逐日起迄、請假時數與假別、加班沿用核准當時的快照，不重算；
          請假單的時段與事由、假日名稱為目前紀錄（表上有加註）；支出表與表尾「支出」為目前即時的報銷紀錄（含已送出待核銷，表上有標註）；金額來源見下方說明。
        </p>
      )}
      {liveNote && (
        <p className="mb-3 text-xs text-gray-500 print:hidden">
          {liveNote}
          {att?.computedAt ? `（最後計算 ${fmtDateTime(att.computedAt)}）` : ""}
        </p>
      )}
      {note && <p className="mb-3 text-xs text-amber-700 print:hidden">{note}</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {loading && !data && <Empty>載入中…</Empty>}
      {data && !summary && <Empty>只有 HR 可以查看薪資明細表。</Empty>}
      {summary && grid && (
        <div className={loading ? "opacity-60" : undefined}>
          <StatementTable
            grid={grid}
            fitControl
            printing
            showHiddenRows={kind === "attendance" && showHolidays}
            variant={live ? "excel" : "admin"}
          />
        </div>
      )}
    </Card>
  );
}
