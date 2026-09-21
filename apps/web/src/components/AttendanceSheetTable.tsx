"use client";

import { useEffect, useState } from "react";
import { fmtHm } from "@/lib/ess-format";
import {
  friendlyError,
  type SheetAnomaly,
  type SheetDayPatch,
  type SheetDayView,
  type SheetMoney,
  type SheetTotals,
  type SheetView,
} from "@/lib/attendance-sheets-api";

/**
 * 出勤月表共用表格：ESS 自助填報頁與 Admin 審核頁共用同一份版面，靠 `editable`／
 * `showMoney` 兩個 flag 決定是否可編輯、是否顯示薪資試算卡。欄位順序對齊
 * docs/test/fixtures/attendance-115-06/README.md 描述的 Excel 版面（日期｜星期｜
 * 起｜迄｜請假｜加班≤2h｜3-8h｜9-12h｜內容｜外出／專案｜備註），異常欄是新增的。
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

function minguoPeriod(period: string): { year: number; month: number } {
  const [y, m] = period.split("-").map(Number);
  return { year: (y || 1911) - 1911, month: m || 1 };
}

const SEVERITY_STYLE: Record<SheetAnomaly["severity"], string> = {
  error: "border border-red-200 bg-red-100 text-red-700",
  warn: "border border-amber-200 bg-amber-100 text-amber-700",
  info: "border border-gray-200 bg-gray-100 text-gray-600",
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

function rowTone(day: SheetDayView): string {
  if (day.anomalies.some((a) => a.severity === "error")) return "bg-red-50/70";
  if (day.anomalies.some((a) => a.severity === "warn")) return "bg-amber-50/70";
  if (day.dayType !== "workday") return "bg-gray-50";
  return "";
}

export function AttendanceSheetTable({
  sheet,
  editable,
  showMoney,
  onPatchDay,
}: {
  sheet: SheetView;
  editable: boolean;
  showMoney: boolean;
  onPatchDay?: (date: string, patch: SheetDayPatch) => void | Promise<void>;
}) {
  const { year, month } = minguoPeriod(sheet.period);
  const [overrideOpenFor, setOverrideOpenFor] = useState<string | null>(null);

  async function patch(date: string, value: SheetDayPatch) {
    if (!onPatchDay) return;
    await onPatchDay(date, value);
  }

  return (
    <div className="print-sheet space-y-4">
      <div className="print-sheet-header">
        亞斯特設計顧問有限公司／{year}年{month}月 出勤統計表－{sheet.employeeName}
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-100">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50/60 text-xs text-gray-500">
              <th className="py-2 pl-3 pr-2">日期</th>
              <th className="py-2 pr-2">星期</th>
              <th className="py-2 pr-2">起</th>
              <th className="py-2 pr-2">迄</th>
              <th className="py-2 pr-2">請假(h)／假別</th>
              <th className="py-2 pr-2 text-right">加班 ≤2h</th>
              <th className="py-2 pr-2 text-right">3-8h</th>
              <th className="py-2 pr-2 text-right">9-12h</th>
              <th className="py-2 pr-2">內容</th>
              <th className="py-2 pr-2">外出／專案</th>
              <th className="py-2 pr-2">備註</th>
              <th className="py-2 pr-3">異常</th>
            </tr>
          </thead>
          <tbody>
            {sheet.days.map((day) => (
              <DayRow
                key={day.date}
                day={day}
                editable={editable}
                overridePopoverOpen={overrideOpenFor === day.date}
                onOpenOverride={() => setOverrideOpenFor(day.date)}
                onCloseOverride={() => setOverrideOpenFor((cur) => (cur === day.date ? null : cur))}
                onPatch={(value) => patch(day.date, value)}
              />
            ))}
            {sheet.days.length === 0 && (
              <tr>
                <td colSpan={12} className="py-6 text-center text-gray-400">
                  本期尚無資料
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SummaryRow totals={sheet.totals} />

      {showMoney &&
        (sheet.money ? (
          <MoneyCard money={sheet.money} />
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
  editable,
  overridePopoverOpen,
  onOpenOverride,
  onCloseOverride,
  onPatch,
}: {
  day: SheetDayView;
  editable: boolean;
  overridePopoverOpen: boolean;
  onOpenOverride: () => void;
  onCloseOverride: () => void;
  onPatch: (patch: SheetDayPatch) => Promise<void>;
}) {
  const hasOverride = day.overtime.override != null;
  return (
    <tr className={`border-b border-gray-50 align-top ${rowTone(day)}`}>
      <td className="py-2 pl-3 pr-2 tabular-nums">{day.date}</td>
      <td className="py-2 pr-2">{weekdayLabel(day.date)}</td>
      <td className="py-2 pr-2 tabular-nums">{hhmm(day.firstIn)}</td>
      <td className="py-2 pr-2 tabular-nums">{hhmm(day.lastOut)}</td>
      <td className="py-2 pr-2">
        {day.leaveMinutes > 0 ? (
          <span>
            {hours(day.leaveMinutes)}h
            {day.leaveSummary && <span className="ml-1 text-gray-500">{day.leaveSummary}</span>}
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
      <td className="py-2 pr-2">
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
        <AnomalyCell day={day} editable={editable} onPatch={onPatch} />
      </td>
    </tr>
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
        <button type="button" onClick={onClose} className="text-gray-500 hover:underline">
          取消
        </button>
        <div className="flex gap-2">
          {day.overtime.override != null && (
            <button
              type="button"
              onClick={() => void clearOverride()}
              disabled={busy}
              className="text-amber-600 hover:underline disabled:opacity-50"
            >
              清除覆寫
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !canSave}
            className="rounded px-2 py-1 font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: "var(--brand)" }}
          >
            儲存
          </button>
        </div>
      </div>
    </div>
  );
}

function AnomalyCell({
  day,
  editable,
  onPatch,
}: {
  day: SheetDayView;
  editable: boolean;
  onPatch: (patch: SheetDayPatch) => Promise<void>;
}) {
  const [ack, setAck] = useState(day.anomalyAck ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setAck(day.anomalyAck ?? ""), [day.anomalyAck]);

  if (day.anomalies.length === 0) return <span className="text-gray-300">—</span>;

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
      {editable && (
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

function SummaryRow({ totals }: { totals: SheetTotals }) {
  const leaveTypeEntries = Object.entries(totals.leaveByType).filter(([, minutes]) => minutes > 0);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <div className="rounded-xl bg-slate-50 p-4">
        <p className="text-xs text-slate-500">出勤天數</p>
        <p className="mt-1 text-xl font-semibold text-slate-900">{totals.attendanceDays} 天</p>
      </div>
      <div className="rounded-xl bg-red-50 p-4">
        <p className="text-xs text-red-600">遲到</p>
        <p className="mt-1 text-xl font-semibold text-red-700">{longMinutes(totals.lateMinutes)}</p>
      </div>
      <div className="rounded-xl bg-purple-50 p-4">
        <p className="text-xs text-purple-600">請假合計</p>
        <p className="mt-1 text-xl font-semibold text-purple-700">{hours(totals.leaveMinutes)} 小時</p>
        {leaveTypeEntries.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-1 text-[11px] text-purple-500">
            {leaveTypeEntries.map(([type, minutes]) => (
              <span key={type} className="rounded-full bg-purple-100 px-1.5 py-0.5">
                {type} {hours(minutes)}h
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="rounded-xl bg-blue-50 p-4">
        <p className="text-xs text-blue-600">加班（≤2h／3-8h／9-12h）與總計</p>
        <p className="mt-1 text-xl font-semibold text-blue-700">
          {hours(totals.otTier1)} / {hours(totals.otTier2)} / {hours(totals.otTier3)}
        </p>
        <p className="mt-1 text-xs text-blue-500">總計 {hours(totals.otTotal)} 小時</p>
      </div>
      <div className={`rounded-xl p-4 ${ALERT_STYLE[totals.overtimeMonthlyAlert]}`}>
        <p className="text-xs opacity-80">月累計加班警示</p>
        <p className="mt-1 text-xl font-semibold">{ALERT_LABEL[totals.overtimeMonthlyAlert]}</p>
      </div>
    </div>
  );
}

function MoneyCard({ money: m }: { money: SheetMoney }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <p className="mb-3 text-sm font-semibold text-gray-700">薪資試算</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
        <MoneyRow label="時薪" value={money(m.hourlyWage)} />
        <MoneyRow label="加班費 ≤2h" value={money(m.otPayByTier.tier1)} />
        <MoneyRow label="加班費 3-8h" value={money(m.otPayByTier.tier2)} />
        <MoneyRow label="加班費 9-12h" value={money(m.otPayByTier.tier3)} />
        <MoneyRow label="加班費合計" value={money(m.otPay)} strong />
        <MoneyRow label="請假扣款" value={`-${money(m.leaveDeduction)}`} negative />
        <MoneyRow label="遲到早退扣款" value={`-${money(m.lateEarlyDeduction)}`} negative />
        <MoneyRow label="勞保自付" value={`-${money(m.laborInsurance)}`} negative />
        <MoneyRow label="健保自付" value={`-${money(m.healthInsurance)}`} negative />
        <MoneyRow label="勞退自提" value={`-${money(m.pensionVoluntary)}`} negative />
        <MoneyRow label="預支扣回" value={`-${money(m.advance)}`} negative />
        <MoneyRow label="代墊支出" value={money(m.expenses)} />
        <MoneyRow label="實領" value={money(m.net)} strong />
        <MoneyRow label="薪資＋支出" value={money(m.netPlusExpenses)} strong />
      </div>
    </div>
  );
}

function MoneyRow({
  label,
  value,
  strong,
  negative,
}: {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`mt-0.5 tabular-nums ${strong ? "font-semibold text-gray-900" : negative ? "text-rose-600" : "text-gray-700"}`}>
        {value}
      </p>
    </div>
  );
}
