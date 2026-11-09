"use client";

import { forwardRef, useState, type FocusEvent, type InputHTMLAttributes } from "react";
import { inputCls } from "@/components/ess-ui";
import { groupMoneyDigits, sanitizeMoneyInput } from "@/lib/money";

export interface MoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "type"> {
  /** 目前值：沿用呼叫端原本的型別（數字或純數字字串）；null／undefined／"" ＝空白。 */
  value: string | number | null | undefined;
  /** 回傳「不含逗號」的純數字字串（與原本 `<input type="number">` 的 e.target.value 同格式）；空白回 ""。 */
  onValueChange: (raw: string) => void;
  /** 允許負數（例如追加減帳、扣項）。預設不允許。 */
  allowNegative?: boolean;
  /** 允許小數。預設不允許（新台幣金額多為整數）。 */
  allowDecimal?: boolean;
  /** 套用 ess-ui／admin-ui `<Input>` 的共用外框樣式（取代原本的 `<Input>` 時用；className 會接在後面）。 */
  fieldStyle?: boolean;
}

/** 純函式版本，方便單元測試：聚焦時顯示原值（好輸入），未聚焦時加千分位。 */
export function moneyInputDisplay(value: MoneyInputProps["value"], focused: boolean): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
  return focused ? raw : groupMoneyDigits(raw);
}

/**
 * 共用金額輸入框（2026-11-09 業主：輸入框也要千分位）。
 * - 未聚焦：顯示「1,428,571」。
 * - 聚焦：顯示純數字，直接打字；貼上「1,234,567」或全形數字也能解析。
 * - 非數字字元直接濾掉；onValueChange 回傳的值與原本 type="number" 的字串一致，呼叫端資料型別、存檔內容不變。
 * 樣式完全沿用呼叫端傳入的 className（右對齊與否照原樣）。
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onValueChange, allowNegative = false, allowDecimal = false, fieldStyle = false, onFocus, onBlur, inputMode, className, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...rest}
      ref={ref}
      type="text"
      className={fieldStyle ? [inputCls, className].filter(Boolean).join(" ") : className}
      inputMode={inputMode ?? (allowDecimal ? "decimal" : "numeric")}
      autoComplete={rest.autoComplete ?? "off"}
      value={moneyInputDisplay(value, focused)}
      onFocus={(e: FocusEvent<HTMLInputElement>) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e: FocusEvent<HTMLInputElement>) => {
        setFocused(false);
        onBlur?.(e);
      }}
      onChange={(e) => onValueChange(sanitizeMoneyInput(e.target.value, { allowNegative, allowDecimal }))}
    />
  );
});
