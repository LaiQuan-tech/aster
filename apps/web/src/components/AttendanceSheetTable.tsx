"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ess-ui";
import { fmtHm } from "@/lib/ess-format";
import { formatLeaveDurationMinutes, reformatLeaveSummary } from "@/lib/leave-duration";
import {
  SHEET_FILTER_TEXT,
  SHEET_SHOW_ALL_STORAGE_KEY,
  browserStorage,
  partitionSheetDays,
  readStoredFlag,
  writeStoredFlag,
  type SheetFilterScope,
} from "@/lib/attendance-day-filter";
import {
  friendlyError,
  otTierLabelsOf,
  visibleMonthAnomalies,
  type MonthAnomalyAudience,
  type SheetAnomaly,
  type SheetDayPatch,
  type SheetDayView,
  type SheetMoney,
  type SheetTotals,
  type SheetView,
} from "@/lib/attendance-sheets-api";
import { NO_PUNCH_HINT, NO_PUNCH_LABEL } from "@/lib/sheet-no-punch";

/**
 * 出勤月表共用表格：ESS 自助填報頁與 Admin 審核頁共用同一份版面，靠 `editable`／
 * `showMoney` 兩個 flag 決定是否可編輯、是否顯示薪資試算卡。欄位順序對齊
 * docs/test/fixtures/attendance-115-06/README.md 描述的 Excel 版面（日期｜星期｜
 * 起｜迄｜請假｜加班≤2h｜3-8h｜9-12h｜內容｜外出／專案｜備註），異常欄是新增的。
 *
 * 2026-09-23：三個加班欄名改吃 `totals.otTierLabels`（M24，後端依規則的 tiers 產生）；
 * 多一欄「超額(另計)」（M1 月加班上限之外、改為另行給付的分鐘）；在家工作的日子
 * 在「內容」欄前面掛一個「在家」標籤（M2）。三者都與匯出的 xlsx 版面一致。
 *
 * 2026-10-11（0930 會議）：預設只顯示「有事的日子」（請假、加班、異常、手動註記／審核覆寫；
 * 判斷規則見 lib/attendance-day-filter.ts），平淡的正常出勤收起來，表格上方有「顯示全月」開關。
 * 月表合計、總計列與薪資試算一律是全月數字，不受過濾影響；列印時收起來的日子仍會印出
 * （`hidden print:table-row`），印出來的出勤統計表維持完整一個月。開關狀態用 localStorage
 * 記在各自的瀏覽器裡（`preferenceScope`：ESS 與後台各記各的），沒記憶一律預設關。
 *
 * 2026-10-12（教育訓練驗收）：
 *   • 月份級異常（月加班門檻、連續遲到、假單待簽核…）不屬於任何一天，用 `SheetMonthAnomalies` 顯示；
 *     `showMonthAnomalies` 有帶就放在表格上方（後台詳細頁、主管審核頁），員工本人頁放在頁面下方的異常區。
 *   • `noPunchDates`（只有員工本人月表傳）：整天沒打卡又沒請假／在家／出差公出的上班日，異常欄顯示琥珀色
 *     「無打卡紀錄」、預設顯示；不寫進 anomalies，不需要填說明、不擋送出（判斷規則見 lib/sheet-no-punch.ts）。
 *   • 兩者都只上畫面、不印（.no-print）：印出來的出勤統計表跟改版前一樣——無打卡的日子異常欄印「—」、
 *     列底色不變；後台也不會把「尚未設定薪資結構」這類內部訊息印在統計表上。
 */

const WEEKDAY_LABEL = ["日", "一", "二", "三", "四", "五", "六"];

function weekdayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return WEEKDAY_LABEL[parsed.getUTCDay()];
}

/** firstIn/lastOut 的實際格式（純 HH:MM 或完整 ISO）目前後端尚未定案，兩種都接。 */
function hhmm(value: string | null): string {
  if (!value) return "—";
  // ISO 一律轉當地時區顯示（原本 slice(11,16) 是 UTC，會比台北少 8 小時）；純 HH:MM 原樣
  return value.length > 5 && value.includes("T") ? fmtHm(value) : value;
}

function hours(minutes: number, digits = 1): string {
  return (minutes / 60).toFixed(digits);
}

function longMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}時${abs % 60}分`;
}

function money(value: number): string {
  return Math.round(value).toLocaleString("zh-TW");
}

function moneyIfAvailable(value: number | undefined): string {
  return value == null ? "—" : money(value);
}

function minguoPeriod(period: string): { year: number; month: number } {
  const [y, m] = period.split("-").map(Number);
  return { year: (y || 1911) - 1911, month: m || 1 };
}

const SEVERITY_STYLE: Record<SheetAnomaly["severity"], string> = {
  error: "border border-red-200 bg-red-100 text-red-700",
  warn: "border border-amber-200 bg-amber-100 text-amber-700",
  info: "border border-gray-200 bg-gray-100 text-gray-600",
};

/** 嚴重度的文字（給螢幕報讀；畫面上靠顏色區分，與日級異常一致）。 */
const SEVERITY_TEXT: Record<SheetAnomaly["severity"], string> = {
  error: "錯誤",
  warn: "警示",
  info: "資訊",
};

const ALERT_STYLE: Record<SheetTotals["overtimeMonthlyAlert"], string> = {
  none: "bg-gray-100 text-gray-500",
  "36": "bg-amber-100 text-amber-700",
  "40": "bg-orange-100 text-orange-700",
  "46": "bg-red-100 text-red-700",
};

const ALERT_LABEL: Record<SheetTotals["overtimeMonthlyAlert"], string> = {
  none: "未達門檻",
  "36": "已達 36 小時",
  "40": "已達 40 小時",
  "46": "已達 46 小時上限",
};

function rowTone(day: SheetDayView, noPunch = false): string {
  if (day.anomalies.some((a) => a.severity === "error")) return "bg-red-50/70";
  if (day.anomalies.some((a) => a.severity === "warn")) return "bg-amber-50/70";
  // 「無打卡紀錄」只是畫面上的提示：琥珀底只上螢幕，列印維持原本（只標上班日，原本沒有底色）。
  if (noPunch) return "bg-amber-50/70 print:bg-transparent";
  if (day.dayType !== "workday") return "bg-gray-50";
  return "";
}

/**
 * 月份級異常區塊（2026-10-12）：配色與日級異常一致（error 紅、warn 琥珀、info 灰），顯示 API 的中文 message
 * （空白時用代碼對照的中文）。不需要說明、不擋送出。`audience="ess"`（員工端）不顯示只有 HR 能處理的項目
 * （未設定薪資結構）。只上畫面、列印不印（.no-print）：出勤統計表的列印版面維持改版前的樣子，後台「尚未設定
 * 薪資結構」這類內部訊息也不會印出去。沒有要顯示的就整塊不出現。
 */
export function SheetMonthAnomalies({
  anomalies,
  audience,
}: {
  anomalies: SheetView["monthAnomalies"] | null | undefined;
  audience: MonthAnomalyAudience;
}) {
  const items = visibleMonthAnomalies(anomalies, audience);
  if (items.length === 0) return null;
  return (
    <section aria-label="本月異常" className="no-print rounded-xl border border-gray-100 p-3">
      <p className="mb-2 text-xs font-medium text-gray-500">本月異常</p>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={`${item.code}-${i}`} className={`rounded-lg px-3 py-2 text-xs font-medium ${SEVERITY_STYLE[item.severity]}`}>
            <span className="sr-only">{SEVERITY_TEXT[item.severity]}：</span>
            {item.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AttendanceSheetTable({
  sheet,
  editable,
  showMoney,
  onPatchDay,
  preferenceScope,
  showMonthAnomalies,
  noPunchDates,
}: {
  sheet: SheetView;
  editable: boolean;
  showMoney: boolean;
  onPatchDay?: (date: string, patch: SheetDayPatch) => void | Promise<void>;
  /**
   * 「顯示全月」開關的記憶範圍：員工前台 `"ess"`、後台 `"admin"` 各記各的。
   * 不帶就不記憶（每次載入都預設關）。
   */
  preferenceScope?: SheetFilterScope;
  /**
   * 在表格上方（列印抬頭之後）顯示月份級異常：後台詳細頁 `"admin"`、主管審核頁 `"ess"`。
   * 不帶＝不顯示（員工本人頁自己放在頁面下方的異常區）。
   */
  showMonthAnomalies?: MonthAnomalyAudience;
  /**
   * 「無打卡紀錄」的日期（lib/sheet-no-punch.ts 算好；只有員工本人月表傳）。不帶＝不標
   * （後台、主管審核頁、核准快照）。標了的日子異常欄顯示琥珀色標籤、預設顯示，不需要說明、不擋送出。
   */
  noPunchDates?: ReadonlySet<string> | null;
}) {
  const { year, month } = minguoPeriod(sheet.period);
  const [overrideOpenFor, setOverrideOpenFor] = useState<string | null>(null);
  const tierLabels = otTierLabelsOf(sheet.totals);

  // 「顯示全月」：初始一律關；掛載後才讀 localStorage（不在 useState 初始值讀，避免 SSR 與掛載後內容對不上）。
  // 只在使用者按開關時寫回，不在 effect 裡寫——避免 StrictMode 重複執行時用預設值蓋掉原本的記憶。
  const storageKey = preferenceScope ? SHEET_SHOW_ALL_STORAGE_KEY[preferenceScope] : null;
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (storageKey) setShowAll(readStoredFlag(browserStorage(), storageKey));
  }, [storageKey]);

  function changeShowAll(next: boolean) {
    setShowAll(next);
    if (storageKey) writeStoredFlag(browserStorage(), storageKey, next);
  }

  // 「無打卡紀錄」的日子跟其他有事的日子一樣預設顯示（不被「顯示全月」收起）。
  const partition = useMemo(
    () =>
      partitionSheetDays(
        sheet.days,
        showAll,
        noPunchDates && noPunchDates.size > 0 ? (day) => ({ noPunch: noPunchDates.has(day.date) }) : undefined,
      ),
    [sheet.days, showAll, noPunchDates],
  );

  async function patch(date: string, value: SheetDayPatch) {
    if (!onPatchDay) return;
    await onPatchDay(date, value);
  }

  return (
    <div className="print-sheet space-y-4">
      <div className="print-sheet-header">
        亞斯特設計顧問有限公司／{year}年{month}月 出勤統計表－{sheet.employeeName}
      </div>

      {showMonthAnomalies && <SheetMonthAnomalies anomalies={sheet.monthAnomalies} audience={showMonthAnomalies} />}

      {partition.total > 0 && (
        <div className="no-print flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-gray-700 sm:min-h-9">
            <input
              type="checkbox"
              role="switch"
              checked={showAll}
              onChange={(event) => changeShowAll(event.target.checked)}
              className="h-5 w-5 cursor-pointer rounded accent-[var(--brand)]"
            />
            <span className="font-medium">{SHEET_FILTER_TEXT.showAll(partition.total)}</span>
          </label>
          {!showAll && partition.hiddenCount > 0 && (
            <span className="text-gray-500" aria-live="polite">
              {SHEET_FILTER_TEXT.hidden(partition.hiddenCount)}
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        {/* 最小寬 900px（原 1180px）：內容／外出／備註欄可換行，1280px 桌機後台不需左右捲動；手機仍可橫捲。 */}
        <table className="w-full min-w-[900px] text-left text-[13px] leading-[1.4] text-gray-900">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-600">
              <th className="py-2 pl-3 pr-2">日期</th>
              <th className="py-2 pr-2">星期</th>
              <th className="py-2 pr-2">起</th>
              <th className="py-2 pr-2">迄</th>
              <th className="py-2 pr-2">請假／假別</th>
              <th className="py-2 pr-2 text-right">加班 {tierLabels[0]}</th>
              <th className="py-2 pr-2 text-right">{tierLabels[1]}</th>
              <th className="py-2 pr-2 text-right">{tierLabels[2]}</th>
              <th className="py-2 pr-2 text-right" title="超過月加班上限、改為另行給付的時數">
                超額(另計)
              </th>
              <th className="py-2 pr-2">內容</th>
              <th className="py-2 pr-2">外出／專案</th>
              <th className="py-2 pr-2">備註</th>
              <th className="py-2 pr-3">異常</th>
            </tr>
          </thead>
          <tbody>
            {partition.entries.map(({ item: day, hidden }) => (
              <DayRow
                key={day.date}
                day={day}
                hidden={hidden}
                noPunch={noPunchDates?.has(day.date) ?? false}
                editable={editable}
                // 晚餐改的是結算輸入（加班分鐘會變）：核准後數字已凍結，只剩唯讀標籤。
                dinnerEditable={editable && sheet.status !== "approved" && sheet.status !== "locked"}
                overridePopoverOpen={overrideOpenFor === day.date}
                onOpenOverride={() => setOverrideOpenFor(day.date)}
                onCloseOverride={() => setOverrideOpenFor((cur) => (cur === day.date ? null : cur))}
                onPatch={(value) => patch(day.date, value)}
              />
            ))}
            {partition.total === 0 && (
              <tr>
                <td colSpan={13} className="py-6 text-center text-gray-400">
                  本期尚無資料
                </td>
              </tr>
            )}
            {partition.total > 0 && partition.visibleCount === 0 && (
              <tr className="print:hidden">
                <td colSpan={13} className="px-4 py-8 text-center">
                  <p className="text-sm font-medium text-gray-600">{SHEET_FILTER_TEXT.emptyTitle}</p>
                  <p className="mt-1 text-xs text-gray-400">{SHEET_FILTER_TEXT.emptyHint(partition.total)}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SummaryRow
        totals={sheet.totals}
        tierLabels={tierLabels}
        outingMinutes={sheet.days.reduce((sum, day) => sum + day.outingMinutes, 0)}
      />

      {showMoney &&
        (sheet.money ? (
          <MoneyCard money={sheet.money} tierLabels={tierLabels} />
        ) : (
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 text-sm text-gray-400">
            此帳號無薪資試算權限，或本表尚未計算薪資
          </div>
        ))}
    </div>
  );
}

function DayRow({
  day,
  hidden,
  noPunch,
  editable,
  dinnerEditable,
  overridePopoverOpen,
  onOpenOverride,
  onCloseOverride,
  onPatch,
}: {
  day: SheetDayView;
  /** 晚餐切換（approved／locked 不能改）。 */
  dinnerEditable: boolean;
  /** 沒事的日子且沒開「顯示全月」：畫面上收起來，列印時仍印出（維持完整一個月）。 */
  hidden: boolean;
  /** 員工本人月表的「無打卡紀錄」（琥珀色標籤；不需要說明）。 */
  noPunch: boolean;
  editable: boolean;
  overridePopoverOpen: boolean;
  onOpenOverride: () => void;
  onCloseOverride: () => void;
  onPatch: (patch: SheetDayPatch) => Promise<void>;
}) {
  const hasOverride = day.overtime.override != null;
  const beyondCap = day.overtime.beyondCap ?? 0;
  return (
    <tr className={`border-b border-gray-100 align-top ${rowTone(day, noPunch) || "hover:bg-gray-50"}${hidden ? " hidden print:table-row" : ""}`}>
      <td className="whitespace-nowrap py-2 pl-3 pr-2 tabular-nums">{day.date}</td>
      <td className="py-2 pr-2">{weekdayLabel(day.date)}</td>
      <td className="py-2 pr-2 tabular-nums">{hhmm(day.firstIn)}</td>
      <td className="py-2 pr-2 tabular-nums">{hhmm(day.lastOut)}</td>
      <td className="py-2 pr-2">
        {day.leaveMinutes > 0 ? (
          <span>
            {/* 請假時數顯示成天＋時（2026-10-11）；leaveSummary 是 API 存好的「特休 8h」字串，顯示時逐段換算。 */}
            <span className="whitespace-nowrap">{formatLeaveDurationMinutes(day.leaveMinutes)}</span>
            {day.leaveSummary && <span className="ml-1 text-gray-500">{reformatLeaveSummary(day.leaveSummary)}</span>}
          </span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <td className="relative py-2 pr-2 text-right tabular-nums">
        {hours(day.overtime.tier1)}
        {hasOverride && (
          <div className="mt-0.5 text-[11px] font-normal text-blue-600" title={day.overtime.overrideReason ?? ""}>
            系統 {hours(day.overtime.computed)}→{hours(day.overtime.effective)}
          </div>
        )}
        {editable && (
          <button
            type="button"
            onClick={overridePopoverOpen ? onCloseOverride : onOpenOverride}
            className="ml-1 align-top text-xs text-gray-400 hover:text-gray-700"
            title="覆寫加班時數"
          >
            ✎
          </button>
        )}
        {overridePopoverOpen && <OverridePopover day={day} onClose={onCloseOverride} onPatch={onPatch} />}
      </td>
      <td className="py-2 pr-2 text-right tabular-nums">{hours(day.overtime.tier2)}</td>
      <td className="py-2 pr-2 text-right tabular-nums">{hours(day.overtime.tier3)}</td>
      <td
        className={`py-2 pr-2 text-right tabular-nums ${beyondCap > 0 ? "font-medium text-orange-600" : "text-gray-300"}`}
        title={beyondCap > 0 ? "超過月加班上限，這些時數不計加班費，改另行給付" : undefined}
      >
        {beyondCap > 0 ? hours(beyondCap) : "—"}
      </td>
      <td className="py-2 pr-2">
        {day.wfh && (
          <span className="mr-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">
            在家
          </span>
        )}
        <DinnerToggle day={day} editable={dinnerEditable} onPatch={onPatch} />
        <InlineTextCell value={day.content} editable={editable} placeholder="內容" onSave={(v) => onPatch({ content: v })} />
      </td>
      <td className="py-2 pr-2">
        <InlineTextCell
          value={day.outingNote}
          editable={editable}
          placeholder="外出地點"
          onSave={(v) => onPatch({ outingNote: v })}
        />
        {day.projectName && <div className="mt-0.5 text-xs text-gray-400">專案：{day.projectName}</div>}
      </td>
      <td className="py-2 pr-2">
        <InlineTextCell value={day.note} editable={editable} placeholder="備註" onSave={(v) => onPatch({ note: v })} />
      </td>
      <td className="py-2 pr-3">
        <AnomalyCell day={day} noPunch={noPunch} editable={editable} onPatch={onPatch} />
      </td>
    </tr>
  );
}

/**
 * 晚餐（2026-10-17）：公司規則「有用公司晚餐才扣」時，有出勤的日子可切換當天「晚餐」。改了伺服器會重算當天加班
 * （頁面重新載入整張表）。唯讀時只在有勾的日子顯示「晚餐」標籤；`source='manual'` 代表月表上手動改過（優先於打卡勾選）。
 */
function DinnerToggle({
  day,
  editable,
  onPatch,
}: {
  day: SheetDayView;
  editable: boolean;
  onPatch: (patch: SheetDayPatch) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dinner = day.dinner;
  if (!dinner?.optIn || day.workedMinutes <= 0) return null;
  const taken = dinner.taken === true;
  const title =
    dinner.source === "manual" ? "月表手動設定（優先於下班打卡的勾選）" : dinner.source === "punch" ? "下班打卡時勾選" : "未填（不扣晚餐）";
  if (!editable) {
    return taken ? (
      <span title={title} className="mr-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
        晚餐
      </span>
    ) : null;
  }
  async function toggle(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await onPatch({ dinnerTaken: next });
    } catch (error) {
      setErr(friendlyError(error, "更新失敗"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="no-print mr-1 inline-flex items-center gap-1 align-middle text-[11px] text-gray-600" title={title}>
      <input
        type="checkbox"
        className="h-3.5 w-3.5"
        checked={taken}
        disabled={busy}
        onChange={(event) => void toggle(event.target.checked)}
        aria-label={`${day.date} 有用公司晚餐`}
      />
      晚餐{dinner.source === "manual" ? "（手動）" : ""}
      {err && <span className="text-red-600">{err}</span>}
    </span>
  );
}

function InlineTextCell({
  value,
  editable,
  placeholder,
  onSave,
}: {
  value: string | null;
  editable: boolean;
  placeholder?: string;
  onSave: (value: string) => Promise<void>;
}) {
  const [buffer, setBuffer] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setBuffer(value ?? ""), [value]);

  if (!editable) {
    return <span className={value ? "" : "text-gray-300"}>{value || "—"}</span>;
  }

  async function commit() {
    if (buffer === (value ?? "")) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave(buffer);
    } catch (error) {
      setErr(friendlyError(error, "更新失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <input
        value={buffer}
        placeholder={placeholder}
        disabled={busy}
        onChange={(event) => setBuffer(event.target.value)}
        onBlur={() => void commit()}
        className="w-28 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-gray-200 focus:border-gray-300 focus:bg-white focus:outline-none disabled:opacity-60"
      />
      {err && <p className="text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

function OverridePopover({
  day,
  onClose,
  onPatch,
}: {
  day: SheetDayView;
  onClose: () => void;
  onPatch: (patch: SheetDayPatch) => Promise<void>;
}) {
  const [minutesText, setMinutesText] = useState(String(day.overtime.override ?? day.overtime.computed));
  const [reason, setReason] = useState(day.overtime.overrideReason ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsedMinutes = Number(minutesText);
  const validMinutes = minutesText.trim() !== "" && Number.isFinite(parsedMinutes) && parsedMinutes >= 0;
  const canSave = validMinutes && reason.trim().length > 0;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      await onPatch({ overtimeMinutesOverride: Math.round(parsedMinutes), overrideReason: reason.trim() });
      onClose();
    } catch (error) {
      setErr(friendlyError(error, "覆寫失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function clearOverride() {
    setBusy(true);
    setErr(null);
    try {
      await onPatch({ overtimeMinutesOverride: null });
      onClose();
    } catch (error) {
      setErr(friendlyError(error, "清除失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute left-0 top-full z-30 mt-1 w-60 rounded-lg border border-gray-200 bg-white p-3 text-left text-xs font-normal normal-case shadow-lg">
      <p className="mb-2 font-medium text-gray-700">覆寫加班時數</p>
      <p className="mb-2 text-gray-400">系統試算：{hours(day.overtime.computed)} 小時</p>
      <label className="mb-1 block text-gray-500">覆寫分鐘數</label>
      <input
        type="number"
        min={0}
        value={minutesText}
        onChange={(event) => setMinutesText(event.target.value)}
        className="mb-2 w-full rounded border border-gray-300 px-2 py-1"
      />
      <label className="mb-1 block text-gray-500">原因（必填）</label>
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        className="mb-2 w-full rounded border border-gray-300 px-2 py-1"
      />
      {err && <p className="mb-2 text-red-600">{err}</p>}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>取消</Button>
        <div className="flex gap-2">
          {day.overtime.override != null && (
            <Button type="button" variant="secondary" size="sm" onClick={() => void clearOverride()} disabled={busy}>清除覆寫</Button>
          )}
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !canSave}>儲存</Button>
        </div>
      </div>
    </div>
  );
}

function AnomalyCell({
  day,
  noPunch,
  editable,
  onPatch,
}: {
  day: SheetDayView;
  noPunch: boolean;
  editable: boolean;
  onPatch: (patch: SheetDayPatch) => Promise<void>;
}) {
  const [ack, setAck] = useState(day.anomalyAck ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setAck(day.anomalyAck ?? ""), [day.anomalyAck]);

  if (day.anomalies.length === 0 && !noPunch) return <span className="text-gray-300">—</span>;

  async function commit() {
    if (ack === (day.anomalyAck ?? "")) return;
    setBusy(true);
    setErr(null);
    try {
      await onPatch({ anomalyAck: ack });
    } catch (error) {
      setErr(friendlyError(error, "更新失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {/* 「無打卡紀錄」只上畫面：列印不印標籤，那天沒有其他異常時照原本印「—」。 */}
        {noPunch && (
          <span title={NO_PUNCH_HINT} className={`no-print rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_STYLE.warn}`}>
            {NO_PUNCH_LABEL}
          </span>
        )}
        {noPunch && day.anomalies.length === 0 && <span className="hidden text-gray-300 print:inline">—</span>}
        {day.anomalies.map((anomaly, i) => (
          <span
            key={`${anomaly.code}-${i}`}
            title={anomaly.message}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_STYLE[anomaly.severity]}`}
          >
            {anomaly.message}
          </span>
        ))}
      </div>
      {/* 說明欄只給真正的異常；「無打卡紀錄」是提示，不需要說明。 */}
      {editable && day.anomalies.length > 0 && (
        <div>
          <input
            value={ack}
            placeholder="填寫說明"
            disabled={busy}
            onChange={(event) => setAck(event.target.value)}
            onBlur={() => void commit()}
            className="w-32 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[11px] focus:border-gray-300 focus:outline-none disabled:opacity-60"
          />
          {err && <p className="text-[11px] text-red-600">{err}</p>}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ totals, tierLabels, outingMinutes }: { totals: SheetTotals; tierLabels: [string, string, string]; outingMinutes: number }) {
  const leaveTypeEntries = Object.entries(totals.leaveByType).filter(([, minutes]) => minutes > 0);
  const beyondCap = totals.overtimeBeyondCapMinutes ?? 0;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-8">
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">出勤天數</p>
        <p className="mt-1 text-xl font-semibold text-slate-900">{totals.attendanceDays} 天</p>
      </div>
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">出勤工時</p>
        <p className="mt-1 text-xl font-semibold text-slate-900">{hours(totals.workedMinutes)} 小時</p>
      </div>
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">外出時數</p>
        <p className="mt-1 text-xl font-semibold text-slate-900">{hours(outingMinutes)} 小時</p>
      </div>
      <div className="rounded-xl bg-red-50 p-4">
        <p className="text-xs text-red-600">遲到</p>
        <p className="mt-1 text-xl font-semibold text-red-700">{longMinutes(totals.lateMinutes)}</p>
      </div>
      <div className="rounded-xl bg-purple-50 p-4">
        <p className="text-xs text-purple-600">請假合計</p>
        <p className="mt-1 text-xl font-semibold text-purple-700">{formatLeaveDurationMinutes(totals.leaveMinutes)}</p>
        {leaveTypeEntries.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-1 text-[11px] text-purple-500">
            {leaveTypeEntries.map(([type, minutes]) => (
              <span key={type} className="rounded-full bg-purple-100 px-1.5 py-0.5">
                {type} {formatLeaveDurationMinutes(minutes)}
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="rounded-xl bg-blue-50 p-4">
        <p className="text-xs text-blue-600">
          加班（{tierLabels[0]}／{tierLabels[1]}／{tierLabels[2]}）與總計
        </p>
        <p className="mt-1 text-xl font-semibold text-blue-700">
          {hours(totals.otTier1)} / {hours(totals.otTier2)} / {hours(totals.otTier3)}
        </p>
        <p className="mt-1 text-xs text-blue-500">總計 {hours(totals.otTotal)} 小時</p>
      </div>
      <div className={`rounded-xl p-4 ${beyondCap > 0 ? "bg-orange-50" : "bg-gray-50"}`}>
        <p className={`text-xs ${beyondCap > 0 ? "text-orange-600" : "text-gray-500"}`}>超額（另行給付）</p>
        <p className={`mt-1 text-xl font-semibold ${beyondCap > 0 ? "text-orange-700" : "text-gray-400"}`}>
          {hours(beyondCap)} 小時
        </p>
        {beyondCap > 0 && <p className="mt-1 text-[11px] text-orange-500">超過月上限，不計加班費</p>}
      </div>
      <div className={`rounded-xl p-4 ${ALERT_STYLE[totals.overtimeMonthlyAlert]}`}>
        <p className="text-xs opacity-80">月累計加班警示</p>
        <p className="mt-1 text-xl font-semibold">{ALERT_LABEL[totals.overtimeMonthlyAlert]}</p>
      </div>
    </div>
  );
}

function MoneyCard({ money: m, tierLabels }: { money: SheetMoney; tierLabels: [string, string, string] }) {
  const sections = [
    {
      title: "應發",
      rows: [
        ["本薪", m.base],
        [`加班費 ${tierLabels[0]}`, m.otPayByTier.tier1],
        [`加班費 ${tierLabels[1]}`, m.otPayByTier.tier2],
        [`加班費 ${tierLabels[2]}`, m.otPayByTier.tier3],
        ["夜間加給", m.nightPay],
        ["全勤獎金", m.attendanceBonus],
        ["定額補貼", m.allowances],
        ["應發合計", m.gross],
      ] as Array<[string, number | undefined]>,
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
      ] as Array<[string, number | undefined]>,
    },
    {
      title: "實發",
      rows: [
        ["實發金額", m.net],
        ["代墊支出（不計薪資所得）", m.expenses],
        ["薪資＋代墊", m.netPlusExpenses],
      ] as Array<[string, number]>,
    },
  ];
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="mb-3 text-sm font-semibold text-gray-700">薪資試算</p>
      <p className="mb-3 text-xs text-gray-500">基準時薪 {money(m.hourlyWage)}</p>
      <div className="grid gap-4 text-sm md:grid-cols-3">
        {sections.map((section) => (
          <section key={section.title} aria-label={section.title}>
            <h3 className="mb-2 border-b border-gray-200 pb-1 text-xs font-semibold text-gray-600">{section.title}</h3>
            <div className="space-y-2">
              {section.rows.map(([label, value]) => {
                const strong = ["應發合計", "應扣合計", "實發金額", "薪資＋代墊"].includes(label);
                return <MoneyRow key={label} label={label} value={moneyIfAvailable(value)} strong={strong} />;
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function MoneyRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`mt-0.5 tabular-nums ${strong ? "font-semibold text-gray-900" : "text-gray-700"}`}>
        {value}
      </p>
    </div>
  );
}
