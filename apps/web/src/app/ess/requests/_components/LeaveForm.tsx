"use client";

/**
 * 請假：假別 → 單日｜多日 → 全天｜上午｜下午｜自訂（多日鎖全天）→ 事由 →
 * （需憑證假別才出現附件且必填）→ 送出。時數由 `computeLeaveSegments` 即時算，
 * 顯示「共 N 天 · X 小時」「已略過 N 天」「剩餘 X 小時」「申請時數超過剩餘額度」。
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Field, Input, Segmented, Select } from "@/components/ess-ui";
import type { LeaveBalance, LeaveType, Shift } from "@/lib/ess-api";
import { fmtDateShort, fmtHours, todayKey } from "@/lib/ess-format";
import {
  computeLeaveSegments,
  normalizeHm,
  shiftWorkHours,
  skipReasonLabel,
  type LeavePeriod,
  type ShiftLike,
} from "@/lib/leave-hours";
import { buildCreateBody, describeBody, isBuildError, remainingHours } from "@/lib/request-forms";
import {
  AttachmentField,
  ProxyPicker,
  ReasonField,
  SubmitBar,
  SummaryLine,
  proxyTarget,
  validateFiles,
  type FormCommonProps,
} from "./form-shared";
import { useLeaveCalendar } from "./use-leave-calendar";

type DateMode = "single" | "range";

const MODE_OPTIONS: { value: DateMode; label: string }[] = [
  { value: "single", label: "單日" },
  { value: "range", label: "多日" },
];

const PERIOD_OPTIONS: { value: LeavePeriod; label: string }[] = [
  { value: "full", label: "全天" },
  { value: "am", label: "上午" },
  { value: "pm", label: "下午" },
  { value: "custom", label: "自訂" },
];

export interface LeaveFormProps extends FormCommonProps {
  /** null＝還在載入。空陣列＝租戶沒有假別（顯示單一「一般請假」）。 */
  leaveTypes: LeaveType[] | null;
  balances: LeaveBalance[];
  shifts: Shift[];
  defaultShift: ShiftLike;
  /** 本人 employee id（篩選班表用）。 */
  employeeId: string | null | undefined;
}

export function LeaveForm({
  leaveTypes,
  balances,
  shifts,
  defaultShift,
  employeeId,
  initialDate,
  submitting,
  submitError,
  onSubmit,
  proxy,
}: LeaveFormProps) {
  const ids = { type: useId(), start: useId(), end: useId(), cStart: useId(), cEnd: useId() };
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [mode, setMode] = useState<DateMode>("single");
  const [startDate, setStartDate] = useState(initialDate || todayKey());
  const [endDate, setEndDate] = useState(initialDate || todayKey());
  const [period, setPeriod] = useState<LeavePeriod>("full");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [reason, setReason] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  // 只有一個假別時直接選好，少一步。
  useEffect(() => {
    if (!leaveTypeId && leaveTypes && leaveTypes.length === 1) setLeaveTypeId(leaveTypes[0].id);
  }, [leaveTypes, leaveTypeId]);

  const effectiveEnd = mode === "range" ? endDate : startDate;
  const calendar = useLeaveCalendar(startDate, effectiveEnd, shifts, proxy.value || employeeId);

  // 自訂時段的預設值＝當天班別的起訖（使用者沒改過才跟著班別走）。
  const startShift = calendar.shiftByDate[startDate] ?? defaultShift;
  const customStartValue = customStart || normalizeHm(startShift.start_time);
  const customEndValue = customEnd || normalizeHm(startShift.end_time);

  const result = useMemo(
    () =>
      computeLeaveSegments({
        startDate,
        endDate: effectiveEnd,
        period: mode === "range" ? "full" : period,
        customStart: customStartValue,
        customEnd: customEndValue,
        shiftByDate: calendar.shiftByDate,
        defaultShift,
        dayTypeByDate: calendar.dayTypeByDate,
      }),
    [startDate, effectiveEnd, mode, period, customStartValue, customEndValue, calendar, defaultShift],
  );

  const selectedType = leaveTypes?.find((lt) => lt.id === leaveTypeId) ?? null;
  const requiresAttachment = selectedType?.requiresAttachment === true;
  const isProxy = proxy.enabled && proxy.expanded;
  // 餘額桶依到職週年切期間，所以要用「申請起日」去找桶，跨週年期的單才算得對。
  const remaining = leaveTypeId && !isProxy ? remainingHours(balances, leaveTypeId, startDate) : null;
  const overBalance = remaining != null && !result.error && result.totalHours > remaining;
  const skippedReasons = Array.from(new Set(result.skipped.map((s) => skipReasonLabel(s.reason)))).join("／");

  function changeMode(next: DateMode) {
    setMode(next);
    setLocalError(null);
    if (next === "range" && endDate < startDate) setEndDate(startDate);
  }

  function changeStart(value: string) {
    setStartDate(value);
    setLocalError(null);
    if (mode === "range" && endDate < value) setEndDate(value);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (leaveTypes && leaveTypes.length > 0 && !leaveTypeId) return setLocalError("請選擇假別");
    if (result.error) return setLocalError(result.error);
    if (requiresAttachment && files.length === 0) return setLocalError("此假別需要附上憑證");
    const fileError = validateFiles(files);
    if (fileError) return setLocalError(fileError);
    const target = proxyTarget(proxy);
    if ("error" in target) return setLocalError(target.error);
    const body = buildCreateBody("leave", {
      leaveTypeId,
      segments: result.segments,
      hours: result.totalHours,
      reason,
      onBehalfOfEmployeeId: target.onBehalfOfEmployeeId,
    });
    if (isBuildError(body)) return setLocalError(body.error);
    const summary = `${selectedType?.name ?? "請假"} · ${describeBody(body, { shift: defaultShift })}`;
    await onSubmit(body, files, summary);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <ProxyPicker proxy={proxy} />

      <Field label="假別" required htmlFor={ids.type}>
        {leaveTypes === null ? (
          <Select id={ids.type} disabled>
            <option>載入中…</option>
          </Select>
        ) : leaveTypes.length === 0 ? (
          <Select id={ids.type} value="" onChange={() => undefined}>
            <option value="">一般請假</option>
          </Select>
        ) : (
          <Select
            id={ids.type}
            value={leaveTypeId}
            onChange={(e) => {
              setLeaveTypeId(e.target.value);
              setLocalError(null);
            }}
            aria-invalid={localError === "請選擇假別" ? true : undefined}
          >
            <option value="">請選擇假別</option>
            {leaveTypes.map((lt) => (
              <option key={lt.id} value={lt.id}>
                {lt.name}
                {lt.requiresAttachment ? "（需憑證）" : ""}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="space-y-3">
        <Segmented<DateMode> aria-label="單日或多日" options={MODE_OPTIONS} value={mode} onChange={changeMode} />
        {mode === "single" ? (
          <Field label="日期" required htmlFor={ids.start}>
            <Input id={ids.start} type="date" value={startDate} onChange={(e) => changeStart(e.target.value)} required />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="開始日期" required htmlFor={ids.start}>
              <Input id={ids.start} type="date" value={startDate} onChange={(e) => changeStart(e.target.value)} required />
            </Field>
            <Field label="結束日期" required htmlFor={ids.end}>
              <Input
                id={ids.end}
                type="date"
                min={startDate}
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setLocalError(null);
                }}
                required
              />
            </Field>
          </div>
        )}
      </div>

      {mode === "single" ? (
        <div className="space-y-3">
          <Segmented<LeavePeriod>
            aria-label="時段"
            options={PERIOD_OPTIONS}
            value={period}
            onChange={(p) => {
              setPeriod(p);
              setLocalError(null);
            }}
          />
          {period === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="開始時間" required htmlFor={ids.cStart}>
                <Input
                  id={ids.cStart}
                  type="time"
                  value={customStartValue}
                  onChange={(e) => {
                    setCustomStart(e.target.value);
                    setLocalError(null);
                  }}
                />
              </Field>
              <Field label="結束時間" required htmlFor={ids.cEnd}>
                <Input
                  id={ids.cEnd}
                  type="time"
                  value={customEndValue}
                  onChange={(e) => {
                    setCustomEnd(e.target.value);
                    setLocalError(null);
                  }}
                />
              </Field>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-400">多日請假以每天全天計（每天 {fmtHours(shiftWorkHours(defaultShift))}），週末與假日自動略過。</p>
      )}

      {/* 即時摘要 */}
      <div className="space-y-1 rounded-xl bg-gray-50 px-3 py-2.5">
        {result.error ? (
          <SummaryLine tone="red">{result.error}</SummaryLine>
        ) : (
          <SummaryLine tone="brand">
            共 {result.segments.length} 天 · {fmtHours(result.totalHours)}
          </SummaryLine>
        )}
        {result.skipped.length > 0 && (
          <SummaryLine>
            已略過 {result.skipped.length} 天（{skippedReasons}）：{result.skipped.map((s) => fmtDateShort(s.date)).join("、")}
          </SummaryLine>
        )}
        {result.warning && <SummaryLine tone="amber">{result.warning}</SummaryLine>}
        {leaveTypeId && !isProxy && (
          <SummaryLine>{remaining == null ? "此假別尚未設定額度" : `剩餘 ${fmtHours(Math.max(0, remaining))}`}</SummaryLine>
        )}
        {overBalance && <SummaryLine tone="red">申請時數超過剩餘額度</SummaryLine>}
      </div>

      <ReasonField value={reason} onChange={setReason} placeholder="選填，最多 250 字" />

      {requiresAttachment && (
        <AttachmentField
          files={files}
          onChange={(next) => {
            setFiles(next);
            setLocalError(null);
          }}
          required
          label="憑證"
          hint="此假別需附憑證（例如診所收據）；最多 3 個，單檔 3 MB"
          error={localError === "此假別需要附上憑證" ? localError : undefined}
        />
      )}

      <SubmitBar submitting={submitting} error={localError === "此假別需要附上憑證" ? submitError : (localError ?? submitError)} />
    </form>
  );
}
