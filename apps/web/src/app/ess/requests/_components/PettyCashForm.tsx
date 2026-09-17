"use client";

/**
 * 零用金預支：金額（必填）＋ 用途（必填）。body：`advanceRequested`、`startAt = endAt = now`。
 * 低於 `advanceThreshold`（伺服器設定）只提示不擋：仍可送出，由簽核者判斷。
 */
import { useId, useState, type FormEvent } from "react";
import { Field, Input } from "@/components/ess-ui";
import { fmtMoney } from "@/lib/ess-format";
import { buildCreateBody, describeBody, isBuildError } from "@/lib/request-forms";
import { ProxyPicker, ReasonField, SubmitBar, proxyTarget, type FormCommonProps } from "./form-shared";

export interface PettyCashFormProps extends FormCommonProps {
  advanceThreshold: number | null;
}

export function PettyCashForm({ advanceThreshold, submitting, submitError, onSubmit, proxy }: PettyCashFormProps) {
  const amountId = useId();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const amountNumber = Number(amount.replace(/,/g, ""));
  const belowThreshold =
    advanceThreshold != null && amount.trim() !== "" && Number.isFinite(amountNumber) && amountNumber < advanceThreshold;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    const target = proxyTarget(proxy);
    if ("error" in target) return setLocalError(target.error);
    const body = buildCreateBody("petty_cash", { amount, reason, onBehalfOfEmployeeId: target.onBehalfOfEmployeeId });
    if (isBuildError(body)) return setLocalError(body.error);
    await onSubmit(body, [], `零用金預支 · ${describeBody(body)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <ProxyPicker proxy={proxy} />

      <Field
        label="預支金額（元）"
        required
        htmlFor={amountId}
        hint={
          belowThreshold
            ? `此金額低於建議門檻 ${fmtMoney(advanceThreshold)}，仍可送出，但會在簽核時標示——請在用途說明原因`
            : "核准後由公司先撥款給你；之後請憑單據報銷沖抵，多退少補。未核銷的預支會列為未結款項"
        }
      >
        <Input
          id={amountId}
          type="number"
          inputMode="numeric"
          min={0}
          value={amount}
          placeholder="例如：3000"
          onChange={(e) => {
            setAmount(e.target.value);
            setLocalError(null);
          }}
          aria-invalid={localError === "請填寫預支金額" ? true : undefined}
          required
        />
      </Field>

      <ReasonField value={reason} onChange={setReason} required label="用途" placeholder="例如：採買活動物資" />

      <SubmitBar submitting={submitting} error={localError ?? submitError} />
    </form>
  );
}
