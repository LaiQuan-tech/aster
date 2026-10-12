"use client";

/**
 * 請假（單位精細到小時，2026-10-11）：假別 → 單日｜多日 → 事由 → （需憑證假別才出現附件且必填）→ 送出。
 *   單日：全天｜上午｜下午｜指定時數（開始時間＋請幾小時；開始時間從上班時間起每 1 小時一格、
 *         不能落在午休，時數 1 小時為單位、最多到下班前可請的時數；結束時間由系統算、跳過午休）。
 *         上午／下午以午休為界（2026-10-11 業主決定）：日班上午 09:00–12:00、下午 13:00–18:00；
 *         選了上午／下午會多一行說明（`describeHalfDays`），不涵蓋午休的班別維持各半。
 *   多日（2026-10-12 業主：自己挑日期、一天一天新增，日期可以不連續，例 10/12、10/14 下午、10/20）：
 *         日期清單，每一列＝日期＋時段（全天｜上午｜下午｜指定時數，和單日同一套）；每列可刪除，
 *         「＋新增日期」預設帶上一列的下一個上班日。同一天不能選兩次；休息日／國定假日提醒、仍可送出。
 *         整份清單是一張假單（segments 依日期排序），主管簽一張；算法與檢查見 lib/leave-day-list。
 * 時數即時算：單日摘要「09:00–12:00，共 3 時」；多日逐日列出「10/12（一）全天」
 * 「10/14（三）下午 13:00–18:00 5 時」…再加「合計 2 天 5 時」「剩餘 6 天」「申請時數超過剩餘額度」。
 * 畫面只用 1 小時步進，後端不強制最小單位。
 * 請假時數的顯示一律天＋時（2026-10-11 業主決定，1 天 ＝ `hoursPerDay` 小時，API 隨餘額回，缺席用 8）；
 * 「指定時數」的下拉與「最多 N 小時」是輸入選項，維持小時。時數的計算與送出的 body 仍全是小時。
 * 班表功能已移除（2026-10-11）：每天都用預設班別（`defaultShift`，日班）算時數與時間選項。
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Field, Input, Segmented, Select } from "@/components/ess-ui";
import type { LeaveBalance, LeaveType } from "@/lib/ess-api";
import { addDays, fmtDateWithWeekday, todayKey } from "@/lib/ess-format";
import { describeLeaveDayRow, nextLeaveDate, resolveLeaveDayList, type LeaveDayRow } from "@/lib/leave-day-list";
import { MAX_LEAVE_SEGMENTS, describeHalfDays, resolveLeavePick, type LeavePeriod, type ShiftLike } from "@/lib/leave-hours";
import { formatLeaveDuration } from "@/lib/leave-duration";
import { buildCreateBody, describeBody, isBuildError, remainingHours } from "@/lib/request-forms";
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
  const ids = { type: useId(), start: useId(), hStart: useId(), hCount: useId(), day: useId() };
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [mode, setMode] = useState<DateMode>("single");
  const [startDate, setStartDate] = useState(initialDate || todayKey());
  const [period, setPeriod] = useState<LeavePeriod>("full");
  // 單日「指定時數」：開始時間（空字串＝上班時間）＋請幾小時（0＝預設 1 小時）。
  const [hoursStart, setHoursStart] = useState("");
  const [hoursCount, setHoursCount] = useState(0);
  // 多日：自選日期清單（每列＝日期＋時段），第一次切到「多日」才建立；與單日的選擇各自保留。
  const [days, setDays] = useState<LeaveDayRow[]>([]);
  const rowSeq = useRef(0);
  const [reason, setReason] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  // 只有一個假別時直接選好，少一步。
  useEffect(() => {
    if (!leaveTypeId && leaveTypes && leaveTypes.length === 1) setLeaveTypeId(leaveTypes[0].id);
  }, [leaveTypes, leaveTypeId]);

  // 行事曆（假日）按需載入：涵蓋單日的日期、多日清單上的所有日期，再往後 31 天（「＋新增日期」找下一個上班日用）。
  // 班別每天都是 defaultShift（班表功能已移除）。
  const dayDates = mode === "range" ? days.map((d) => d.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  const calStart = dayDates.length > 0 && dayDates[0] < startDate ? dayDates[0] : startDate;
  const calLast = dayDates.length > 0 && dayDates[dayDates.length - 1] > startDate ? dayDates[dayDates.length - 1] : startDate;
  const dayTypeByDate = useLeaveCalendar(calStart, addDays(calLast, 31));
  const shiftOn = (_date: string): ShiftLike => defaultShift;

  // 單日：時間選項（1 小時一格、以那天的班別為準）、預設值與時數都由純函式算（見 resolveLeavePick）：
  // 選的值不在選項裡就退回預設——開始＝上班時間、時數 1 小時。
  const pick = useMemo(
    () =>
      resolveLeavePick(
        { mode: "single", startDate, endDate: startDate, period, hoursStart, hoursCount, rangeStart: "", rangeEnd: "" },
        { shiftByDate: NO_SCHEDULED_SHIFTS, defaultShift, dayTypeByDate },
      ),
    [startDate, period, hoursStart, hoursCount, dayTypeByDate, defaultShift],
  );
  const { startOptions, hoursStartValue, maxHours, hoursCountValue, result } = pick;
  // 多日：每列同一套單日算法，加上同日重複、休息日提醒、依日期排序與合計（見 resolveLeaveDayList）。
  const list = useMemo(
    () => resolveLeaveDayList(days, { shiftByDate: NO_SCHEDULED_SHIFTS, defaultShift, dayTypeByDate }),
    [days, dayTypeByDate, defaultShift],
  );
  const isRange = mode === "range";
  const formError = isRange ? list.error : result.error;
  const totalHours = isRange ? list.totalHours : result.totalHours;
  // 班別有休息才提「午休」（沒有休息的班別，時間選項就是連續的）。
  const hasBreak = Number(shiftOn(startDate).break_minutes ?? 0) > 0;

  const selectedType = leaveTypes?.find((lt) => lt.id === leaveTypeId) ?? null;
  const requiresAttachment = selectedType?.requiresAttachment === true;
  // 餘額桶依到職週年切期間，所以要用「申請起日」去找桶（後端扣假也看起日＝最早的那天），跨週年期的單才算得對。
  const bucketDate = isRange ? (list.segments[0]?.date ?? dayDates[0] ?? startDate) : startDate;
  const remaining = leaveTypeId ? remainingHours(balances, leaveTypeId, bucketDate) : null;
  const overBalance = remaining != null && !formError && totalHours > remaining;

  function newRow(date: string): LeaveDayRow {
    rowSeq.current += 1;
    return { id: `day-${rowSeq.current}`, date, period: "full", hoursStart: "", hoursCount: 0 };
  }

  function changeMode(next: DateMode) {
    setMode(next);
    setLocalError(null);
    // 第一次切到多日：先放兩天——單日選的那天＋它的下一個上班日（不要可以刪、可以改）。
    if (next === "range" && days.length === 0) {
      const first = newRow(startDate);
      setDays([first, newRow(nextLeaveDate([first], dayTypeByDate, startDate))]);
    }
  }

  function changeStart(value: string) {
    setStartDate(value);
    setLocalError(null);
  }

  function updateDay(id: string, patch: Partial<Omit<LeaveDayRow, "id">>) {
    setDays((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    setLocalError(null);
  }

  function removeDay(id: string) {
    setDays((prev) => (prev.length <= 1 ? prev : prev.filter((d) => d.id !== id)));
    setLocalError(null);
  }

  function addDay() {
    if (days.length >= MAX_LEAVE_SEGMENTS) return;
    setDays([...days, newRow(nextLeaveDate(days, dayTypeByDate, startDate))]);
    setLocalError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    if (leaveTypes && leaveTypes.length > 0 && !leaveTypeId) return setLocalError("請選擇假別");
    if (formError) return setLocalError(formError);
    if (requiresAttachment && files.length === 0) return setLocalError("此假別需要附上憑證");
    const fileError = validateFiles(files);
    if (fileError) return setLocalError(fileError);
    const body = buildCreateBody("leave", {
      leaveTypeId,
      segments: isRange ? list.segments : result.segments,
      hours: totalHours,
      reason,
    });
    if (isBuildError(body)) return setLocalError(body.error);
    const summary = `${selectedType?.name ?? "請假"} · ${describeBody(body, { shift: defaultShift, hoursPerDay })}`;
    await onSubmit(body, files, summary);
  }

  /** 開始時間選項的顯示字：上班時間加註。 */
  const startLabel = (t: string, i: number) => (i === 0 ? `${t}（上班）` : t);

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
          <div className="space-y-3">
            <ul className="space-y-3" aria-label="請假日期">
              {list.rows.map((view, index) => {
                const row = days[index];
                if (!row) return null;
                const dateId = `${ids.day}-${view.id}-date`;
                const label = `日期 ${index + 1}`;
                return (
                  <li key={view.id} className="space-y-3 rounded-xl border border-gray-200 p-3">
                    <div className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <Field label={label} required htmlFor={dateId}>
                          <Input
                            id={dateId}
                            type="date"
                            value={row.date}
                            onChange={(e) => updateDay(view.id, { date: e.target.value })}
                            aria-invalid={view.error ? true : undefined}
                            required
                          />
                        </Field>
                      </div>
                      <Button
                        variant="ghost"
                        onClick={() => removeDay(view.id)}
                        disabled={days.length <= 1}
                        aria-label={`刪除${view.date ? fmtDateWithWeekday(view.date) : label}`}
                      >
                        刪除
                      </Button>
                    </div>
                    <Segmented<LeavePeriod>
                      aria-label={`${label}的時段`}
                      compact
                      options={PERIOD_OPTIONS}
                      value={row.period}
                      onChange={(p) => updateDay(view.id, { period: p })}
                    />
                    {(row.period === "am" || row.period === "pm") && (
                      <p className="text-xs text-gray-400">{describeHalfDays(shiftOn(view.date))}</p>
                    )}
                    {row.period === "hours" && (
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="開始時間" required htmlFor={`${dateId}-start`} hint={hasBreak ? "午休時段不能選" : undefined}>
                          <Select
                            id={`${dateId}-start`}
                            value={view.hoursStartValue}
                            onChange={(e) => updateDay(view.id, { hoursStart: e.target.value })}
                          >
                            {view.startOptions.map((t, i) => (
                              <option key={t} value={t}>
                                {startLabel(t, i)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field
                          label="時數"
                          required
                          htmlFor={`${dateId}-hours`}
                          hint={`最多 ${Math.max(view.maxHours, 1)} 小時${hasBreak ? "，午休不算" : ""}`}
                        >
                          <Select
                            id={`${dateId}-hours`}
                            value={String(view.hoursCountValue)}
                            onChange={(e) => updateDay(view.id, { hoursCount: Number(e.target.value) })}
                          >
                            {Array.from({ length: Math.max(view.maxHours, 1) }, (_, i) => i + 1).map((n) => (
                              <option key={n} value={n}>
                                {n} 小時
                              </option>
                            ))}
                          </Select>
                        </Field>
                      </div>
                    )}
                    {view.error ? (
                      <p role="alert" className="text-sm text-red-600">
                        {view.error}
                      </p>
                    ) : view.warning ? (
                      <p className="text-sm text-amber-700">{view.warning}</p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <Button variant="secondary" block onClick={addDay} disabled={days.length >= MAX_LEAVE_SEGMENTS}>
              ＋新增日期
            </Button>
            <p className="text-xs text-gray-400">
              {days.length >= MAX_LEAVE_SEGMENTS
                ? `一次最多 ${MAX_LEAVE_SEGMENTS} 天，其餘請另外申請`
                : "一天一列，日期可以不連續；每天可選全天、上午、下午或指定時數。"}
            </p>
          </div>
        )}
      </div>

      {mode === "single" ? (
        <div className="space-y-3">
          {/* compact：4 顆均分，390px 內寬每顆只剩 57px，「指定時數」會斷成兩行；改不換行＋縮 padding（高度不變） */}
          <Segmented<LeavePeriod>
            aria-label="時段"
            compact
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
      ) : null}

      {/* 即時摘要 */}
      <div className="space-y-1 rounded-xl bg-gray-50 px-3 py-2.5">
        {formError ? (
          <SummaryLine tone="red">{formError}</SummaryLine>
        ) : !isRange ? (
          <SummaryLine tone="brand">{`${single.startTime}–${single.endTime}，共 ${formatLeaveDuration(result.totalHours, hoursPerDay)}`}</SummaryLine>
        ) : (
          <>
            {/* 依日期排序逐日列出各天的時段與時數（整天只寫「全天」），最後是合計（天＋時）。 */}
            {list.segments.map((seg) => (
              <SummaryLine key={seg.date}>{describeLeaveDayRow(seg, shiftOn(seg.date), hoursPerDay)}</SummaryLine>
            ))}
            <SummaryLine tone="brand">合計 {formatLeaveDuration(list.totalHours, hoursPerDay)}</SummaryLine>
          </>
        )}
        {isRange
          ? list.warnings.map((w) => (
              <SummaryLine key={w} tone="amber">
                {w}
              </SummaryLine>
            ))
          : result.warning && <SummaryLine tone="amber">{result.warning}</SummaryLine>}
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
          // 附件限制的說法與 AttachmentField 預設說明（form-shared.tsx）一致：照片上傳前自動壓縮，PDF 等不壓縮的單檔 3 MB。
          // 這個 hint 會取代預設說明（不是疊加），畫面上只出現這一句。
          hint="此假別需附憑證（例如診所收據）；最多 3 個，照片會自動壓縮，PDF 單檔 3 MB"
          error={localError === "此假別需要附上憑證" ? localError : undefined}
        />
      )}

      <SubmitBar submitting={submitting} error={localError === "此假別需要附上憑證" ? submitError : (localError ?? submitError)} />
    </form>
  );
}
