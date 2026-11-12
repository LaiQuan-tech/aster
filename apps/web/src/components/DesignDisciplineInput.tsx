"use client";

import { useState } from "react";
import { humanizeOptionListError, invalidateOptionList, quickAddOptionItem, useOptionList } from "@/lib/option-lists-api";
import {
  DESIGN_DISCIPLINE_LIST_KEY,
  canOfferAddDiscipline,
  designDisciplineSuggestions,
} from "@/lib/design-discipline-options";

/**
 * 設計內容的科別建議清單（`<datalist>`）。一張表單放一份，各列的 input 用 `list={id}` 指向它。
 * 選項來自「設定 → 選項清單 → 設計內容科別選項」（租戶自訂，預設 電機／空調／消防／汙水／規費）。
 */
export function DesignDisciplineDatalist({ id }: { id: string }) {
  const { items } = useOptionList(DESIGN_DISCIPLINE_LIST_KEY);
  return (
    <datalist id={id}>
      {designDisciplineSuggestions(items).map((label) => (
        <option key={label} value={label} />
      ))}
    </datalist>
  );
}

/**
 * 科別輸入框旁的「加入常用選項」：輸入的值不在清單裡時出現，點了加入租戶清單（能編輯專案的人即可加；
 * 刪除／排序在設定頁）。`projectId` 給專案頁用（後端以該案的編輯權限判斷）；建案表單不帶。
 */
export function AddDisciplineOptionButton({ value, projectId }: { value: string; projectId?: string | null }) {
  const { items } = useOptionList(DESIGN_DISCIPLINE_LIST_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canOfferAddDiscipline(value, items)) return error ? <span className="shrink-0 text-[11px] text-red-600">{error}</span> : null;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await quickAddOptionItem(DESIGN_DISCIPLINE_LIST_KEY, value.trim(), projectId);
      invalidateOptionList(DESIGN_DISCIPLINE_LIST_KEY);
    } catch (err) {
      setError(humanizeOptionListError(err, "加入失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-1 print:hidden">
      <button
        type="button"
        className="whitespace-nowrap text-[11px] font-medium underline disabled:opacity-50"
        style={{ color: "var(--brand)" }}
        disabled={busy}
        title={`把「${value.trim()}」加入科別下拉的常用選項`}
        onClick={() => void add()}
      >
        {busy ? "加入中…" : "＋加入常用選項"}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </span>
  );
}
