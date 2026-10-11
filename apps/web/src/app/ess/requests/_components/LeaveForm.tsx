"use client";

/**
 * 請假（單位精細到小時，2026-10-11）：假別 → 單日｜多日 → 事由 → （需憑證假別才出現附件且必填）→ 送出。
 *   單日：全天｜上午｜下午｜指定時數（開始時間＋請幾小時；開始時間從上班時間起每 1 小時一格、
 *         不能落在午休，時數 1 小時為單位、最多到下班前可請的時數；結束時間由系統算、跳過午休）。
 *         上午／下午以午休為界（2026-10-11 業主決定）：日班上午 09:00–12:00、下午 13:00–18:00；
 *         選了上午／下午會多一行說明（`describeHalfDays`），不涵蓋午休的班別維持各半。
 *   多日：開始日期＋開始時間、結束日期＋結束時間（時間 1 小時一格，預設＝上班／下班＝整天）。
 *         第一天從開始時間請到下班、中間整天、最後一天從上班請到結束時間；休息日／國定假日自動不計。
 * 時數由 `computeLeaveSegments` 即時算：單日摘要「09:00–12:00，共 3 時」；多日逐日列出
 * 「10/13（二）14:00–18:00 4 時」「10/14（三）全天」…再加「共 1 天 7 時」「已略過 N 天」「剩餘 6 天」
 * 「申請時數超過剩餘額度」。畫面只用 1 小時步進，後端不強制最小單位。
 * 請假時數的顯示一律天＋時（2026-10-11 業主決定，1 天 ＝ `hoursPerDay` 小時，API 隨餘額回，缺席用 8）；
 * 「指定時數」的下拉與「最多 N 小時」是輸入選項，維持小時。時數的計算與送出的 body 仍全是小時。
 * 班表功能已移除（2026-10-11）：每天都用預設班別（`defaultShift`，日班）算時數與時間選項。
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Field, Input, Segmented, Select } from "@/components/ess-ui";
import type { LeaveBalance, LeaveType } from "@/lib/ess-api";
import { fmtDateShort, todayKey } from "@/lib/ess-format";
import { describeHalfDays, resolveLeavePick, skipReasonLabel, type LeavePeriod, type ShiftLike } from "@/lib/leave-hours";
import { formatLeaveDuration } from "@/lib/leave-duration";
import { buildCreateBody, describeBody, describeLeaveDay, isBuildError, remainingHours } from "@/lib/request-forms";
import { AttachmentField, ReasonField, SubmitBar, SummaryLine, validateFiles, type FormCommonProps } from "./form-shared";
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
  { value: "hours", label: "指定時數" },
];

export interface LeaveFormProps extends FormCommonProps {
  /** null＝還在載入。空陣列＝租戶沒有假別（顯示單一「一般請假」）。 */
  leaveTypes: LeaveType[] | null;
  balances: LeaveBalance[];
  /** 每天都用這個班別（請假頁傳租戶最早建立的班別＝日班；班表功能已移除）。 */
  defaultShift: ShiftLike;
  /** 1 天 ＝ 幾小時（規則 payroll.dailyRegularHours，隨 GET /leave-balances 回）：只用在把時數顯示成天＋時；缺席＝8。 */
  hoursPerDay?: number;
}

/** 班表功能已移除：沒有逐日班別，`resolveLeavePick` 一律退回 defaultShift。 */
const NO_SCHEDULED_SHIFTS: Record<string, ShiftLike | undefined> = {};

export function LeaveForm({
  leaveTypes,
  balances,
  defaultShift,
  hoursPerDay,
  initialDate,
  submitting,
  submitError,
  onSubmit,
}: LeaveFormProps) {
  const ids = { type: useId(), start: useId(), end: useId(), hStart: useId(), hCount: useId(), rStart: useId(), rEnd: useId() };
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [mode, setMode] = useState<DateMode>("single");
  const [startDate, setStartDate] = useState(initialDate || todayKey());
  const [endDate, setEndDate] = useState(initialDate || todayKey());
  const [period, setPeriod] = useState<LeavePeriod>("full");
  // 單日「指定時數」：開始時間（空字串＝上班時間）＋請幾小時（0＝預設 1 小時）。
  const [hoursStart, setHoursStart] = useState("");
  const [hoursCount, setHoursCount] = useState(0);
  // 多日：首日開始時間（空字串＝上班時間）／末日結束時間（空字串＝下班時間）。
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [reason, setReason] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  // 只有一個假別時直接選好，少一步。
  useEffect(() => {
    if (!leaveTypeId && leaveTypes && leaveTypes.length === 1) setLeaveTypeId(leaveTypes[0].id);
  }, [leaveTypes, leaveTypeId]);

  const effectiveEnd = mode === "range" ? endDate : startDate;
  // 行事曆（假日）按需載入；班別每天都是 defaultShift（班表功能已移除）。
  const dayTypeByDate = useLeaveCalendar(startDate, effectiveEnd);
  const shiftOn = (_date: string): ShiftLike => defaultShift;

  // 時間選項（1 小時一格、以各自那天的班別為準）、預設值與時數都由純函式算（見 resolveLeavePick）：
  // 選的值不在選項裡就退回預設——開始＝上班時間、結束＝下班時間（＝整天）、時數 1 小時。
  const pick = useMemo(
    () =>
      resolveLeavePick(
        { mode, startDate, endDate, period, hoursStart, hoursCount, rangeStart, rangeEnd },
        { shiftByDate: NO_SCHEDULED_SHIFTS, defaultShift, dayTypeByDate },
      ),
    [mode, startDate, endDate, period, hoursStart, hoursCount, rangeStart, rangeEnd, dayTypeByDate, defaultShift],
  );
  const { startOptions, endOptions, hoursStartValue, maxHours, hoursCountValue, rangeStartValue, rangeEndValue, result } = pick;
  // 班別有休息才提「午休」（沒有休息的班別，時間選項就是連續的）。
  const hasBreak = Number(shiftOn(startDate).break_minutes ?? 0) > 0;

  const selectedType = leaveTypes?.find((lt) => lt.id === leaveTypeId) ?? null;
  const requiresAttachment = selectedType?.requiresAttachment === true;
  // 餘額桶依到職週年切期間，所以要用「申請起日」去找桶，跨週年期的單才算得對。
  const remaining = leaveTypeId ? remainingHours(balances, leaveTypeId, startDate) : null;
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
    const body = buildCreateBody("leave", {
      leaveTypeId,
      segments: result.segments,
      hours: result.totalHours,
      reason,
    });
    if (isBuildError(body)) return setLocalError(body.error);
    const summary = `${selectedType?.name ?? "請假"} · ${describeBody(body, { shift: defaultShift, hoursPerDay })}`;
    await onSubmit(body, files, summary);
  }

  /** 時間選項的顯示字：上班時間／下班時間（＝整天的預設）加註。 */
  const startLabel = (t: string, i: number) => (i === 0 ? `${t}（上班）` : t);
  const endLabel = (t: string, i: number) => (i === endOptions.length - 1 ? `${t}（下班）` : t);

  const single = result.segments[0];

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
            <Field label="開始時間" required htmlFor={ids.rStart}>
              <Select
                id={ids.rStart}
                value={rangeStartValue}
                onChange={(e) => {
                  setRangeStart(e.target.value);
                  setLocalError(null);
                }}
              >
                {startOptions.map((t, i) => (
                  <option key={t} value={t}>
                    {startLabel(t, i)}
                  </option>
                ))}
              </Select>
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
            <Field label="結束時間" required htmlFor={ids.rEnd}>
              <Select
                id={ids.rEnd}
                value={rangeEndValue}
                onChange={(e) => {
                  setRangeEnd(e.target.value);
                  setLocalError(null);
                }}
              >
                {endOptions.map((t, i) => (
                  <option key={t} value={t}>
                    {endLabel(t, i)}
                  </option>
                ))}
              </Select>
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
          {(period === "am" || period === "pm") && <p className="text-xs text-gray-400">{describeHalfDays(shiftOn(startDate))}</p>}
          {period === "hours" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="開始時間" required htmlFor={ids.hStart} hint={hasBreak ? "午休時段不能選" : undefined}>
                <Select
                  id={ids.hStart}
                  value={hoursStartValue}
                  onChange={(e) => {
                    setHoursStart(e.target.value);
                    setLocalError(null);
                  }}
                >
                  {startOptions.map((t, i) => (
                    <option key={t} value={t}>
                      {startLabel(t, i)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="時數" required htmlFor={ids.hCount} hint={`最多 ${Math.max(maxHours, 1)} 小時${hasBreak ? "，午休不算" : ""}`}>
                <Select
                  id={ids.hCount}
                  value={String(hoursCountValue)}
                  onChange={(e) => {
                    setHoursCount(Number(e.target.value));
                    setLocalError(null);
                  }}
                >
                  {Array.from({ length: Math.max(maxHours, 1) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} 小時
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-gray-400">
          預設整天（上班到下班）。第一天從開始時間請到下班、中間整天、最後一天從上班請到結束時間；休息日與國定假日自動不計。
        </p>
      )}

      {/* 即時摘要 */}
      <div className="space-y-1 rounded-xl bg-gray-50 px-3 py-2.5">
        {result.error ? (
          <SummaryLine tone="red">{result.error}</SummaryLine>
        ) : mode === "single" ? (
          <SummaryLine tone="brand">{`${single.startTime}–${single.endTime}，共 ${formatLeaveDuration(result.totalHours, hoursPerDay)}`}</SummaryLine>
        ) : (
          <>
            {result.segments.map((seg) => (
              <SummaryLine key={seg.date}>{describeLeaveDay(seg, shiftOn(seg.date), hoursPerDay)}</SummaryLine>
            ))}
            {/* 只寫請假總時數：上面逐日已列出每一天，再寫「共 3 天」會跟「1 天 7 時」兩個「天」並排。 */}
            <SummaryLine tone="brand">共 {formatLeaveDuration(result.totalHours, hoursPerDay)}</SummaryLine>
          </>
        )}
        {result.skipped.length > 0 && (
          <SummaryLine>
            已略過 {result.skipped.length} 天（{skippedReasons}）：{result.skipped.map((s) => fmtDateShort(s.date)).join("、")}
          </SummaryLine>
        )}
        {result.warning && <SummaryLine tone="amber">{result.warning}</SummaryLine>}
        {leaveTypeId && (
          <SummaryLine>
            {remaining == null ? "此假別尚未設定額度" : `剩餘 ${formatLeaveDuration(Math.max(0, remaining), hoursPerDay)}`}
          </SummaryLine>
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
