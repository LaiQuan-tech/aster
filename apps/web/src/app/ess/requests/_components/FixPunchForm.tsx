"use client";

/**
 * 補卡：日期 ＋「上班｜下班」＋ 時間 ＋ 補卡原因（必填）。
 * body：`segments:[{date,startTime:t,endTime:t,hours:0,type:"in"|"out"}]`、`startAt = endAt`。
 */
import { useId, useState, type FormEvent } from "react";
import { Field, Input, Segmented } from "@/components/ess-ui";
import { normalizeHm, type ShiftLike } from "@/lib/leave-hours";
import { PUNCH_TYPE_LABEL, buildCreateBody, describeBody, isBuildError } from "@/lib/request-forms";
import { ProxyPicker, ReasonField, SubmitBar, proxyTarget, type FormCommonProps } from "./form-shared";

type PunchType = "in" | "out";

const TYPE_OPTIONS: { value: PunchType; label: string }[] = [
  { value: "in", label: PUNCH_TYPE_LABEL.in },
  { value: "out", label: PUNCH_TYPE_LABEL.out },
];

export interface FixPunchFormProps extends FormCommonProps {
  /** 預設時間：上班＝班別開始、下班＝班別結束。 */
  defaultShift: ShiftLike;
}

export function FixPunchForm({ defaultShift, initialDate, submitting, submitError, onSubmit, proxy }: FixPunchFormProps) {
  const ids = { date: useId(), time: useId() };
  const [date, setDate] = useState(initialDate);
  const [type, setType] = useState<PunchType>("in");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const timeValue = time || normalizeHm(type === "in" ? defaultShift.start_time : defaultShift.end_time);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    const target = proxyTarget(proxy);
    if ("error" in target) return setLocalError(target.error);
    const body = buildCreateBody("fix_punch", {
      date,
      type,
      time: timeValue,
      reason,
      onBehalfOfEmployeeId: target.onBehalfOfEmployeeId,
    });
    if (isBuildError(body)) return setLocalError(body.error);
    await onSubmit(body, [], `補卡 · ${describeBody(body)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <ProxyPicker proxy={proxy} />

      <Field label="日期" required htmlFor={ids.date}>
        <Input
          id={ids.date}
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setLocalError(null);
          }}
          required
        />
      </Field>

      <Field label="補哪一種卡" required>
        <Segmented<PunchType>
          aria-label="上班或下班"
          options={TYPE_OPTIONS}
          value={type}
          onChange={(next) => {
            setType(next);
            setLocalError(null);
          }}
        />
      </Field>

      <Field label="實際時間" required htmlFor={ids.time} hint="當天實際到班／離開的時間；核准後會補一筆打卡紀錄">
        <Input
          id={ids.time}
          type="time"
          value={timeValue}
          onChange={(e) => {
            setTime(e.target.value);
            setLocalError(null);
          }}
          required
        />
      </Field>

      <ReasonField value={reason} onChange={setReason} required label="補卡原因" placeholder="例如：忘記打卡、手機沒電" />

      <SubmitBar submitting={submitting} error={localError ?? submitError} />
    </form>
  );
}
