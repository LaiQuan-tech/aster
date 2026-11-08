"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Button, ErrorText } from "@/components/admin-ui";
import { apiErrorMessage } from "@/lib/api-client";
import {
  buildFixedAllowanceBody,
  createFixedAllowance,
  deleteFixedAllowance,
  EMPTY_FIXED_ALLOWANCE_FORM,
  formFromAllowance,
  getFixedAllowances,
  insuredHintText,
  TAX_TYPE_LABEL,
  updateFixedAllowance,
  type AllowanceTaxType,
  type FixedAllowance,
  type FixedAllowanceForm,
  type FixedAllowanceSummary,
} from "@/lib/fixed-allowances-api";

const inputCls =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

/**
 * 員工固定津貼（2026-11-08）：掛在「員工薪資保險資料」選定員工之下。新增／修改／刪除（軟刪除）。
 * 每月執行薪資時自動帶入當月有效的津貼；已產生的薪資單不受之後的修改影響（草稿要重新執行薪資作業）。
 * `baseSalary`／`laborGrade` 是上方表單目前的值，用來提示「固定津貼＋底薪」合計（系統不自動改投保級距）。
 */
export function FixedAllowancesCard({
  employeeId,
  baseSalary,
  laborGrade,
}: {
  employeeId: string;
  baseSalary: string;
  laborGrade: string;
}) {
  const [items, setItems] = useState<FixedAllowance[]>([]);
  const [summary, setSummary] = useState<FixedAllowanceSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FixedAllowanceForm>(EMPTY_FIXED_ALLOWANCE_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const panelId = useId();

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await getFixedAllowances(employeeId);
      setItems(res.fixedAllowances);
      setSummary(res.summary);
    } catch (err) {
      setItems([]);
      setSummary(null);
      setLoadError(apiErrorMessage(err, "載入固定津貼失敗"));
    }
  }, [employeeId]);

  useEffect(() => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FIXED_ALLOWANCE_FORM);
    setFormError(null);
    void reload();
  }, [reload]);

  function patch(partial: Partial<FixedAllowanceForm>) {
    setForm((prev) => ({ ...prev, ...partial }));
    setFormError(null);
  }

  function startNew() {
    setEditingId(null);
    setForm({ ...EMPTY_FIXED_ALLOWANCE_FORM, effectiveFrom: new Date().toISOString().slice(0, 8) + "01" });
    setFormError(null);
    setShowForm(true);
  }

  function startEdit(a: FixedAllowance) {
    setEditingId(a.id);
    setForm(formFromAllowance(a));
    setFormError(null);
    setShowForm(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const built = buildFixedAllowanceBody(form);
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setSubmitting(true);
    try {
      if (editingId) await updateFixedAllowance(editingId, built.body);
      else await createFixedAllowance(employeeId, built.body);
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FIXED_ALLOWANCE_FORM);
      await reload();
    } catch (err) {
      setFormError(apiErrorMessage(err, editingId ? "修改固定津貼失敗" : "新增固定津貼失敗"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onDelete(a: FixedAllowance) {
    if (!window.confirm(`刪除固定津貼「${a.name}」？之後執行的薪資作業不再帶入（已產生的薪資單不受影響）。`)) return;
    try {
      await deleteFixedAllowance(a.id);
      await reload();
    } catch (err) {
      setLoadError(apiErrorMessage(err, "刪除固定津貼失敗"));
    }
  }

  const hint = summary ? insuredHintText(baseSalary, laborGrade, summary.activeInsurableTotal) : null;
  const fmt = (n: number) => n.toLocaleString("zh-TW");

  return (
    <div className="mt-6" data-testid="fixed-allowances-card">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div>
          <h3 className="text-sm font-medium text-gray-600">固定津貼</h3>
          <p className="text-xs text-gray-400">
            每月執行薪資時自動帶入當月有效的津貼（月中生效／終止當月照全額）；應稅併入應發，伙食費每月合計 2,400 元內免稅。
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => (showForm ? setShowForm(false) : startNew())}
          aria-expanded={showForm}
          aria-controls={panelId}
        >
          {showForm ? "收合" : "＋ 新增固定津貼"}
        </Button>
      </div>

      <div id={panelId} hidden={!showForm}>
        <form onSubmit={onSubmit} className="mb-3 grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>津貼名稱</label>
            <input className={inputCls} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例：職務加給" />
          </div>
          <div>
            <label className={labelCls}>月金額（元）</label>
            <input
              type="number"
              min={0}
              step={1}
              className={inputCls}
              value={form.amount}
              onChange={(e) => patch({ amount: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls}>課稅方式</label>
            <select
              className={inputCls}
              value={form.taxType}
              onChange={(e) => patch({ taxType: e.target.value as AllowanceTaxType })}
            >
              <option value="taxable">{TAX_TYPE_LABEL.taxable}</option>
              <option value="meal_exempt">{TAX_TYPE_LABEL.meal_exempt}</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>生效起日</label>
            <input type="date" className={inputCls} value={form.effectiveFrom} onChange={(e) => patch({ effectiveFrom: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>生效迄日（選填）</label>
            <input type="date" className={inputCls} value={form.effectiveTo} onChange={(e) => patch({ effectiveTo: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-gray-600">
            <input type="checkbox" checked={form.insurable} onChange={(e) => patch({ insurable: e.target.checked })} />
            計入投保薪資（經常性給與）
          </label>
          <div className="sm:col-span-3">
            <label className={labelCls}>備註（選填）</label>
            <input className={inputCls} value={form.note} onChange={(e) => patch({ note: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
              style={{ color: "var(--brand)" }}
            >
              {submitting ? "儲存中…" : editingId ? "儲存修改" : "新增固定津貼"}
            </button>
            {formError && <ErrorText>{formError}</ErrorText>}
          </div>
        </form>
      </div>

      {loadError && <ErrorText>{loadError}</ErrorText>}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500">
            <th className="py-1.5 pr-3">名稱</th>
            <th className="py-1.5 pr-3 text-right">月金額</th>
            <th className="py-1.5 pr-3">課稅</th>
            <th className="py-1.5 pr-3">計入投保</th>
            <th className="py-1.5 pr-3">生效期間</th>
            <th className="py-1.5">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id} className="border-b border-gray-50">
              <td className="py-1.5 pr-3 text-gray-800">
                {a.name}
                {a.note && <span className="ml-1 text-xs text-gray-400">（{a.note}）</span>}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(a.amount)}</td>
              <td className="py-1.5 pr-3 text-xs text-gray-600">{a.taxType === "meal_exempt" ? "伙食費" : "應稅"}</td>
              <td className="py-1.5 pr-3 text-xs text-gray-600">{a.insurable ? "是" : "否"}</td>
              <td className="py-1.5 pr-3 text-xs text-gray-600">
                {a.effectiveFrom} ～ {a.effectiveTo ?? "（無迄日）"}
              </td>
              <td className="py-1.5 whitespace-nowrap">
                <button type="button" onClick={() => startEdit(a)} className="mr-3 text-gray-600 hover:underline">
                  修改
                </button>
                <button type="button" onClick={() => void onDelete(a)} className="text-red-600 hover:underline">
                  刪除
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className="py-1.5 text-gray-400">
                無
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {summary && summary.activeTotal > 0 && (
        <p className="mt-2 text-xs text-gray-500">
          {summary.period} 有效的固定津貼合計 {fmt(summary.activeTotal)} 元（計入投保 {fmt(summary.activeInsurableTotal)} 元）。
        </p>
      )}
      {hint && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="fixed-allowances-insured-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
