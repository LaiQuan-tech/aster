"use client";

/**
 * 公出／出差表單「自行墊付」下的「現在就填報銷明細（選填）」（2026-10-16）。
 *
 * 預設收合（手機上表單不變長）：只有一顆「＋ 現在就填報銷明細（選填）」；展開才出現明細卡（類別、金額、
 * 發生日期〔預設＝公出日期〕、備註〔沒填就帶公出地點＋事由〕、憑證）。收合時若已填了東西，按鈕下方顯示
 * 「已填 N 筆・NT$ X，會一併送出」，不會默默丟掉。
 * 規則同報銷頁（類別必選、金額正整數、日期必填；憑證選填，照片自動壓縮、PDF 3 MB 內）；
 * 要求出差核准的類別在公出還沒核准前不能用（API 回 trip_not_approved），選單裡顯示但停用。
 * 驗證與送出編排在 lib/trip-expense.ts（有單元測試）；本元件只管畫面狀態。
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button, Field, Icon, Input, Select } from "@/components/ess-ui";
import type { MyExpenseCategory } from "@/lib/ess-api";
import { fmtMoney } from "@/lib/ess-format";
import { isBlankDraft, isCategoryUsableForTrip, newExpenseDraft, type ExpenseDraft } from "@/lib/trip-expense";
import { pickedFileError } from "@/lib/upload-prep";

export interface TripExpenseDraftsProps {
  /** 報銷類別；null＝還在載入或載入失敗（不顯示明細區，改提示送出後再填）。 */
  categories: MyExpenseCategory[] | null;
  drafts: ExpenseDraft[];
  onChange: (next: ExpenseDraft[]) => void;
  /** 公出日期（出差＝起日）：新明細的發生日期預設值；改了公出日期，沒改過日期的明細跟著改。 */
  tripDate: string;
  /** 備註沒填時帶入的事由（顯示成 placeholder）。 */
  defaultNote: string;
  /** 驗證錯誤指向第幾筆（展開並標紅框）。 */
  errorIndex: number | null;
  disabled?: boolean;
}

export function TripExpenseDrafts({ categories, drafts, onChange, tripDate, defaultNote, errorIndex, disabled }: TripExpenseDraftsProps) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const prevTripDate = useRef(tripDate);

  // 公出日期改了：還停在舊預設日期的明細跟著改（員工自己改過的不動）。
  useEffect(() => {
    const prev = prevTripDate.current;
    prevTripDate.current = tripDate;
    if (prev === tripDate || drafts.length === 0) return;
    if (drafts.some((d) => d.incurredOn === prev)) {
      onChange(drafts.map((d) => (d.incurredOn === prev ? { ...d, incurredOn: tripDate } : d)));
    }
  }, [tripDate, drafts, onChange]);

  // 驗證錯誤 → 自動展開
  useEffect(() => {
    if (errorIndex != null) setOpen(true);
  }, [errorIndex]);

  if (categories === null) {
    return <p className="mt-1 text-xs text-gray-400">送出後可在「我的申請」按「填報銷單」填報單據，隨月結一併給付。</p>;
  }

  const filled = drafts.filter((d) => !isBlankDraft(d));
  const filledTotal = filled.reduce((a, d) => a + (Number(d.amount.replace(/,/g, "")) || 0), 0);
  const active = categories.filter((c) => c.active);

  function update(key: string, patch: Partial<ExpenseDraft>) {
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && drafts.length === 0) onChange([newExpenseDraft(tripDate)]);
  }

  return (
    <div className="mt-1 space-y-2">
      <p className="text-xs text-gray-400">不預支。回來後憑單據報銷，隨月結一併給付。</p>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`${baseId}-panel`}
        disabled={disabled}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-dashed border-gray-300 px-3 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
      >
        <span>{open ? "報銷明細（選填）" : "＋ 現在就填報銷明細（選填）"}</span>
        <Icon name="chevron" className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>
      {!open && filled.length > 0 && (
        <p className="text-xs text-green-700">
          已填 {filled.length} 筆・{fmtMoney(filledTotal)}，會跟這張申請一起送出
        </p>
      )}

      {open && (
        <div id={`${baseId}-panel`} className="space-y-3">
          <p className="text-xs text-gray-500">當天回來就能補單；也可以先不填，送出後在「我的申請」按「填報銷單」。</p>
          {drafts.map((d, i) => {
            const id = `${baseId}-${d.key}`;
            const receiptError = d.receipt ? (pickedFileError(d.receipt) ?? undefined) : undefined;
            return (
              <div
                key={d.key}
                className={`space-y-3 rounded-xl border p-3 ${errorIndex === i ? "border-red-300 bg-red-50/40" : "border-gray-200 bg-gray-50"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">第 {i + 1} 筆</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
                    aria-label={`刪除第 ${i + 1} 筆報銷明細`}
                  >
                    刪除
                  </Button>
                </div>
                <Field label="類別" required htmlFor={`${id}-cat`}>
                  <Select
                    id={`${id}-cat`}
                    value={d.categoryId}
                    disabled={disabled}
                    onChange={(e) => update(d.key, { categoryId: e.target.value })}
                  >
                    <option value="">請選擇</option>
                    {active.map((c) => {
                      const usable = isCategoryUsableForTrip(c);
                      return (
                        <option key={c.id} value={c.id} disabled={!usable}>
                          {c.name}
                          {usable ? "" : "（須出差核准後再報）"}
                        </option>
                      );
                    })}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="金額（元）" required htmlFor={`${id}-amt`}>
                    <Input
                      id={`${id}-amt`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={d.amount}
                      disabled={disabled}
                      onChange={(e) => update(d.key, { amount: e.target.value })}
                    />
                  </Field>
                  <Field label="發生日期" required htmlFor={`${id}-date`}>
                    <Input
                      id={`${id}-date`}
                      type="date"
                      value={d.incurredOn}
                      disabled={disabled}
                      onChange={(e) => update(d.key, { incurredOn: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="備註（選填）" htmlFor={`${id}-note`} hint={d.note.trim() ? undefined : "沒填就帶入公出地點與事由"}>
                  <Input
                    id={`${id}-note`}
                    value={d.note}
                    maxLength={250}
                    placeholder={defaultNote || "例如：高鐵來回"}
                    disabled={disabled}
                    onChange={(e) => update(d.key, { note: e.target.value })}
                  />
                </Field>
                <Field label="憑證（發票／收據）" htmlFor={`${id}-receipt`} hint="照片會自動壓縮；PDF 單檔 3 MB 以內" error={receiptError}>
                  <input
                    id={`${id}-receipt`}
                    type="file"
                    accept="image/*,application/pdf"
                    disabled={disabled}
                    onChange={(e) => update(d.key, { receipt: e.target.files?.[0] ?? null })}
                    className="w-full text-sm"
                  />
                </Field>
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-3">
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange([...drafts, newExpenseDraft(tripDate)])}>
              ＋ 再加一筆
            </Button>
            {filled.length > 0 && (
              <span className="text-xs text-gray-500">
                {filled.length} 筆・合計 {fmtMoney(filledTotal)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
