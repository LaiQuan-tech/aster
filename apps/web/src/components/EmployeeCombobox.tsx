"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { inputCls as defaultInputCls } from "@/components/admin-ui";
import {
  CLOSED,
  comboReduce,
  filterEmployeeOptions,
  type ComboAction,
  type ComboState,
  type EmployeeOption,
} from "@/lib/employee-combobox";

export type { EmployeeOption } from "@/lib/employee-combobox";

/**
 * 可搜尋的員工選單（自繪 combobox；取代原生 <select>）。邏輯在 lib/employee-combobox.ts（純函式、有單元測試）。
 *
 *   • 輸入即篩選（label＋searchText：工號、姓名、身分證、員工 ID…）；點選或 ↑↓＋Enter 選取；Esc／點外面關閉
 *   • 已選者顯示在輸入框；`clearable` 時右側有「×」清除（回到 emptyValue）
 *   • `emptyLabel` 有給 → 清單第一列是空選項（例「全部員工」「請選擇」），value 為 ""
 *   • `required` → 沒選時輸入框 setCustomValidity，表單送出會被瀏覽器擋（與原生 select required 一致）
 *   • 選項可帶 group（顯示組標題，例部門／已離職）、note（右側小字）、disabled
 *   • a11y：input role=combobox＋aria-expanded／aria-controls／aria-activedescendant；ul role=listbox；li role=option
 */
export function EmployeeCombobox({
  options,
  value,
  onChange,
  placeholder = "輸入工號、姓名搜尋",
  emptyLabel,
  clearable = true,
  disabled,
  required,
  id,
  name,
  ariaLabel,
  className,
  inputClassName,
  testId,
}: {
  options: readonly EmployeeOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  /** 空選項的文字（例「全部員工」「請選擇」）；不給＝沒有空選項。 */
  emptyLabel?: string;
  clearable?: boolean;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  /** 有給就帶一個 hidden input（表單用 FormData 讀值的頁面）。 */
  name?: string;
  ariaLabel?: string;
  className?: string;
  inputClassName?: string;
  testId?: string;
}) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-list`;
  const optionId = (i: number) => `${autoId}-opt-${i}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [state, setState] = useState<ComboState>(CLOSED);

  const allOptions = useMemo<EmployeeOption[]>(
    () => (emptyLabel !== undefined ? [{ id: "", label: emptyLabel }, ...options] : [...options]),
    [emptyLabel, options],
  );
  const list = useMemo(() => filterEmployeeOptions(allOptions, state.query), [allOptions, state.query]);
  const selected = allOptions.find((o) => o.id === value) ?? null;

  function dispatch(action: ComboAction) {
    const r = comboReduce(state, action, allOptions, value);
    setState(r.state);
    if (r.select !== undefined && r.select !== value) onChange(r.select);
  }

  // 點外面關閉
  useEffect(() => {
    if (!state.open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setState(CLOSED);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [state.open]);

  // 反白的選項捲進可視範圍
  useEffect(() => {
    if (!state.open || state.active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(state.active))}`);
    el?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.active]);

  // required：沒選（value 空）就讓瀏覽器擋表單送出
  useEffect(() => {
    inputRef.current?.setCustomValidity(required && !value ? "請選擇員工" : "");
  }, [required, value]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (["ArrowDown", "ArrowUp", "Enter", "Escape", "Home", "End"].includes(e.key)) {
      if (e.key !== "Enter" || state.open) e.preventDefault();
      if ((e.key === "Home" || e.key === "End") && !state.open) return;
      dispatch({ type: "key", key: e.key });
    } else if (e.key === "Tab") {
      dispatch({ type: "key", key: "Tab" });
    }
  }

  const shownText = state.open ? state.query : (selected && selected.id !== "" ? selected.label : "");
  const showEmptyPlaceholder = !state.open && selected?.id === "" && emptyLabel ? emptyLabel : placeholder;
  let lastGroup: string | undefined;

  return (
    <div ref={rootRef} className={["relative w-full min-w-0", className].filter(Boolean).join(" ")} data-testid={testId}>
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={state.open}
          aria-controls={listId}
          aria-activedescendant={state.open && state.active >= 0 ? optionId(state.active) : undefined}
          aria-label={ariaLabel}
          aria-required={required || undefined}
          className={[inputClassName ?? defaultInputCls, "pr-14"].join(" ")}
          value={shownText}
          placeholder={showEmptyPlaceholder}
          disabled={disabled}
          required={required}
          onFocus={() => dispatch({ type: "focus" })}
          onClick={() => {
            if (!state.open) dispatch({ type: "focus" });
          }}
          onChange={(e) => dispatch({ type: "type", query: e.target.value })}
          onKeyDown={onKeyDown}
        />
        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1">
          {clearable && value !== "" && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="清除選擇"
              className="pointer-events-auto rounded px-1 text-gray-400 hover:text-gray-700"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setState(CLOSED);
                onChange("");
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
          <span aria-hidden="true" className="text-xs text-gray-400">
            ▾
          </span>
        </div>
      </div>
      {name && <input type="hidden" name={name} value={value} />}
      {state.open && !disabled && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel ?? "員工"}
          className="absolute z-50 mt-1 max-h-72 w-full min-w-[12rem] overflow-y-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg"
        >
          {list.length === 0 && (
            <li role="presentation" className="px-3 py-2 text-gray-400">
              找不到員工
            </li>
          )}
          {list.map((o, i) => {
            const header = o.group !== undefined && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <li key={`${o.id}-${i}`} role="presentation">
                {header && <div className="px-3 pb-0.5 pt-2 text-xs font-semibold text-gray-400">{header}</div>}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={o.id === value}
                  aria-disabled={o.disabled || undefined}
                  className={[
                    "flex cursor-pointer items-baseline justify-between gap-2 px-3 py-1.5",
                    i === state.active ? "bg-sky-50" : "",
                    o.id === value ? "font-medium text-gray-900" : "text-gray-700",
                    o.disabled ? "cursor-not-allowed opacity-50" : "",
                  ].join(" ")}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => dispatch({ type: "hover", index: i })}
                  onClick={() => {
                    if (o.disabled) return;
                    setState(CLOSED);
                    if (o.id !== value) onChange(o.id);
                  }}
                >
                  <span className="min-w-0 break-words">{o.label}</span>
                  {o.note && <span className="shrink-0 text-xs text-gray-400">{o.note}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
