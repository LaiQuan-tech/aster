"use client";

/**
 * 在家工作／加做申報（M2）：起迄日期（全天）＋ 時數（選填）＋ 事由（選填）。
 *
 * 時數留空＝由出勤引擎以當日班表淨工時計（核准後該日無打卡也不算曠職）；
 * 填了則代表實際加做的時數。body 只帶 `startAt / endAt / hours? / reason?`
 * （後端 `apps/api/src/routes/requests.ts` kind='wfh'）。
 */
import { useId, useState, type FormEvent } from "react";
import { Field, Input } from "@/components/ess-ui";
import { buildCreateBody, describeBody, isBuildError } from "@/lib/request-forms";
import { ProxyPicker, ReasonField, SubmitBar, SummaryLine, proxyTarget, type FormCommonProps } from "./form-shared";

export function WfhForm({ initialDate, submitting, submitError, onSubmit, proxy }: FormCommonProps) {
  const ids = { sDate: useId(), eDate: useId(), hours: useId() };
  const [startDate, setStartDate] = useState(initialDate);
  const [endDate, setEndDate] = useState(initialDate);
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const clear = () => setLocalError(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    const target = proxyTarget(proxy);
    if ("error" in target) return setLocalError(target.error);
    const body = buildCreateBody("wfh", {
      startDate,
      endDate,
      hours,
      reason,
      onBehalfOfEmployeeId: target.onBehalfOfEmployeeId,
    });
    if (isBuildError(body)) return setLocalError(body.error);
    await onSubmit(body, [], `在家工作 · ${describeBody(body)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <ProxyPicker proxy={proxy} />

      <div className="grid grid-cols-2 gap-3">
        <Field label="開始日期" required htmlFor={ids.sDate}>
          <Input
            id={ids.sDate}
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              if (endDate < e.target.value) setEndDate(e.target.value);
              clear();
            }}
            required
          />
        </Field>
        <Field label="結束日期" required htmlFor={ids.eDate}>
          <Input
            id={ids.eDate}
            type="date"
            min={startDate}
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              clear();
            }}
            required
          />
        </Field>
      </div>

      <Field label="時數" htmlFor={ids.hours} hint="留空＝依當日班表的淨工時計；有實際加做時數再填">
        <Input
          id={ids.hours}
          type="number"
          inputMode="decimal"
          min={0}
          step={0.5}
          value={hours}
          placeholder="選填"
          onChange={(e) => {
            setHours(e.target.value);
            clear();
          }}
        />
      </Field>

      <div className="rounded-xl bg-gray-50 px-3 py-2.5">
        <SummaryLine tone="gray">核准後這幾天視為在家工作：當天沒有打卡也不會算成曠職。</SummaryLine>
      </div>

      <ReasonField value={reason} onChange={setReason} placeholder="選填，例如：颱風假在家處理結案文件" />

      <SubmitBar submitting={submitting} error={localError ?? submitError} />
    </form>
  );
}
