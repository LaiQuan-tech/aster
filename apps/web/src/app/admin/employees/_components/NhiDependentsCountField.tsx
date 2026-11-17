"use client";

/**
 * 員工資料頁「健保眷屬投保資料」上方的「眷屬人數（直接輸入）」欄（2026-11-17）。
 * 填了以此為準，留空＝依下方明細投保中的筆數；健保費計費上限 3 口。規則見 lib/nhi-dependents-count.ts。
 * reloadKey：明細增刪後由父元件換值，重新讀「明細筆數／計算採用」。
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { ErrorText } from "@/components/admin-ui";
import { apiErrorMessage } from "@/lib/api-client";
import {
  getNhiDependentsCount,
  nhiCountSummary,
  NHI_COUNT_MAX,
  NHI_COUNT_MIN,
  parseNhiCountInput,
  saveNhiDependentsCount,
  type NhiDependentsCount,
} from "@/lib/nhi-dependents-count";

const inputCls =
  "w-24 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";

export function NhiDependentsCountField({ employeeId, reloadKey }: { employeeId: string; reloadKey?: unknown }) {
  const inputId = useId();
  const [data, setData] = useState<NhiDependentsCount | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    getNhiDependentsCount(employeeId)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setValue(d.override == null ? "" : String(d.override));
      })
      .catch((err) => alive && setError(apiErrorMessage(err, "讀取眷屬人數失敗")));
    return () => {
      alive = false;
    };
  }, [employeeId, reloadKey]);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    const parsed = parseNhiCountInput(value);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const d = await saveNhiDependentsCount(employeeId, parsed.value);
      setData(d);
      setValue(d.override == null ? "" : String(d.override));
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "儲存眷屬人數失敗"));
    } finally {
      setSaving(false);
    }
  }

  const disabled = saving || (data != null && !data.available);

  return (
    <form onSubmit={onSave} className="mb-3 rounded-xl bg-slate-50 p-3">
      <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-gray-500">
        眷屬人數（直接輸入，填了以此為準；留空＝依明細）
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          className={inputCls}
          type="number"
          inputMode="numeric"
          min={NHI_COUNT_MIN}
          max={NHI_COUNT_MAX}
          step={1}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
            setSaved(false);
          }}
          placeholder="留空"
          disabled={data != null && !data.available}
        />
        <button
          type="submit"
          disabled={disabled}
          className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
          style={{ color: "var(--brand)" }}
        >
          {saving ? "儲存中…" : "儲存"}
        </button>
        {saved && <span className="text-xs text-green-700">已儲存</span>}
      </div>
      {data && <p className="mt-1 text-xs text-gray-500">{nhiCountSummary(data)}</p>}
      {data && !data.available && (
        <p className="mt-1 text-xs text-amber-700">資料庫尚未支援直接輸入人數，目前依明細計算。</p>
      )}
      {error && <ErrorText className="mt-1">{error}</ErrorText>}
    </form>
  );
}
