"use client";

/**
 * 加班：日期 ＋ 起訖時間 ＋ 給付（加班費｜補休）＋ 事由（選填）。2026-10-12 業主決定拿掉「休息扣除」欄位，
 * 時數＝起訖差（結束不晚於開始視為跨日）。body：`hours`、`payout`、reason 後綴「給付方式：X」。
 */
import { useId, useState, type FormEvent } from "react";
import { Field, Input, Segmented } from "@/components/ess-ui";
import { fmtHours } from "@/lib/ess-format";
import { PAYOUT_LABEL, buildCreateBody, describeBody, isBuildError, overtimeHours } from "@/lib/request-forms";
import { ReasonField, SubmitBar, SummaryLine, type FormCommonProps } from "./form-shared";

type Payout = "pay" | "comp_time";

const PAYOUT_OPTIONS: { value: Payout; label: string }[] = [
  { value: "pay", label: PAYOUT_LABEL.pay },
  { value: "comp_time", label: PAYOUT_LABEL.comp_time },
];

export function OvertimeForm({ initialDate, submitting, submitError, onSubmit }: FormCommonProps) {
  const ids = { date: useId(), start: useId(), end: useId() };
  const [date, setDate] = useState(initialDate);
  const [startTime, setStartTime] = useState("18:00");
  const [endTime, setEndTime] = useState("20:00");
  const [payout, setPayout] = useState<Payout>("pay");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const hours = overtimeHours(startTime, endTime, 0);
  const clear = () => setLocalError(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    const body = buildCreateBody("ot", {
      date,
      startTime,
      endTime,
      breakMinutes: 0,
      payout,
      reason,
    });
    if (isBuildError(body)) return setLocalError(body.error);
    await onSubmit(body, [], `加班 · ${describeBody(body)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <Field label="日期" required htmlFor={ids.date}>
        <Input
          id={ids.date}
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            clear();
          }}
          required
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="開始時間" required htmlFor={ids.start}>
          <Input
            id={ids.start}
            type="time"
            value={startTime}
            onChange={(e) => {
              setStartTime(e.target.value);
              clear();
            }}
            required
          />
        </Field>
        <Field label="結束時間" required htmlFor={ids.end} hint="結束早於開始視為跨日">
          <Input
            id={ids.end}
            type="time"
            value={endTime}
            onChange={(e) => {
              setEndTime(e.target.value);
              clear();
            }}
            required
          />
        </Field>
      </div>

      <Field label="給付方式" required>
        <Segmented<Payout>
          aria-label="給付方式"
          options={PAYOUT_OPTIONS}
          value={payout}
          onChange={(next) => {
            setPayout(next);
            clear();
          }}
        />
      </Field>

      <div className="rounded-xl bg-gray-50 px-3 py-2.5">
        {hours == null ? (
          <SummaryLine tone="red">請輸入起訖時間</SummaryLine>
        ) : hours <= 0 ? (
          <SummaryLine tone="red">加班時數需大於 0，請確認起訖時間</SummaryLine>
        ) : (
          <SummaryLine tone="brand">
            加班 {fmtHours(hours)} · {PAYOUT_LABEL[payout]}
          </SummaryLine>
        )}
      </div>

      <ReasonField value={reason} onChange={setReason} placeholder="選填，例如：趕結案、支援活動" />

      <SubmitBar submitting={submitting} error={localError ?? submitError} />
    </form>
  );
}
