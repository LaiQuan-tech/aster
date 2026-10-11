"use client";

/**
 * 零用金：「費用方式」二選一（2026-10-11，與出差／公出同一個選擇）＋ 金額（必填）＋ 用途（必填）。
 *
 *   ○ 先預支（核准後撥款，用完憑單據核銷）→ 金額＝預支金額：body `advanceRequested`，核准後公司先撥款，
 *     之後在「報銷」頁新增單據並選這筆預支，多退少補。預設（零用金本來就是預支）。
 *   ○ 自行墊付，之後憑單據報銷 → 不預支：金額改叫「預估金額」（簽核者要核的金額），body 不帶
 *     `advanceRequested`、帶 `estimatedCost`；核准後自己先付，之後憑單據走月報銷。
 * `startAt = endAt = now`。預支金額低於 `advanceThreshold`（伺服器設定）只提示不擋：仍可送出，由簽核者判斷
 * （自行墊付沒有預支，不提示）。零用金一律送主管與老闆簽核。
 */
import { useId, useState, type FormEvent } from "react";
import { Field, Input } from "@/components/ess-ui";
import { fmtMoney } from "@/lib/ess-format";
import {
  BOSS_APPROVAL_HINT,
  PETTY_EXPENSE_METHOD_LABEL,
  buildCreateBody,
  describeBody,
  isBuildError,
  type ExpenseMethod,
} from "@/lib/request-forms";
import { ExpenseMethodField, ReasonField, SubmitBar, type FormCommonProps } from "./form-shared";

export interface PettyCashFormProps extends FormCommonProps {
  advanceThreshold: number | null;
}

export function PettyCashForm({ advanceThreshold, submitting, submitError, onSubmit }: PettyCashFormProps) {
  const amountId = useId();
  const [method, setMethod] = useState<ExpenseMethod>("advance");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const isAdvance = method === "advance";
  const amountNumber = Number(amount.replace(/,/g, ""));
  const belowThreshold =
    isAdvance && advanceThreshold != null && amount.trim() !== "" && Number.isFinite(amountNumber) && amountNumber < advanceThreshold;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    const body = buildCreateBody("petty_cash", { amount, reason, method });
    if (isBuildError(body)) return setLocalError(body.error);
    // 摘要同清單文案：先預支「零用金預支 · NT$ 3,000」、自行墊付「零用金 · 自行墊付 · 預估 NT$ 3,000」。
    await onSubmit(body, [], `${isAdvance ? "零用金預支" : "零用金"} · ${describeBody(body)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <ExpenseMethodField
        value={method}
        labels={PETTY_EXPENSE_METHOD_LABEL}
        onChange={(next) => {
          setMethod(next);
          setLocalError(null);
        }}
      />

      <Field
        label={isAdvance ? "預支金額（元）" : "預估金額（元）"}
        required
        htmlFor={amountId}
        hint={
          isAdvance
            ? belowThreshold
              ? `此金額低於建議門檻 ${fmtMoney(advanceThreshold)}，仍可送出，但會在簽核時標示——請在用途說明原因`
              : "核准後由公司先撥款給你；之後請到「報銷」頁新增單據並選這筆預支，多退少補。未核銷的預支會列為未結款項"
            : "不預支，由你先付款。這裡的金額供簽核者判斷；核准後請到「報銷」頁憑單據報銷，隨月結給付"
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
          aria-invalid={localError === "請填寫預支金額" || localError === "請填寫預估金額" ? true : undefined}
          required
        />
      </Field>

      <ReasonField value={reason} onChange={setReason} required label="用途" placeholder="例如：採買活動物資" />

      <p className="text-xs text-gray-400">{BOSS_APPROVAL_HINT}</p>

      <SubmitBar submitting={submitting} error={localError ?? submitError} />
    </form>
  );
}
