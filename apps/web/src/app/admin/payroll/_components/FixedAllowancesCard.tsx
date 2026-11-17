"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { Button, ErrorText } from "@/components/admin-ui";
import { dangerLinkCls, formBoxCls, LinkButton, ListRow, SectionRow } from "../../employees/_components/payroll-ui";
import { fixedAllowanceSummaryText } from "@/lib/payroll-panel-text";
import { apiErrorMessage } from "@/lib/api-client";
import {
  buildFixedAllowanceBody,
  createFixedAllowance,
  deleteFixedAllowance,
  EMPTY_FIXED_ALLOWANCE_FORM,
  formFromAllowance,
  getFixedAllowances,
  insuredHintText,
  midMonthHint,
  overtimeBaseHint,
  staleNoticeText,
  TAX_TYPE_LABEL,
  updateFixedAllowance,
  type AllowanceTaxType,
  type FixedAllowance,
  type FixedAllowanceForm,
  type FixedAllowanceNotices,
  type FixedAllowanceSummary,
  type FixedAllowanceWarning,
} from "@/lib/fixed-allowances-api";

const inputCls =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

/**
 * 員工固定津貼（2026-11-08）：掛在「員工薪資保險資料」選定員工之下。新增／修改／刪除（軟刪除）。
 * 每月執行薪資時自動帶入當月有效的津貼；已產生的薪資單不受之後的修改影響（草稿要重新執行薪資作業）。
 * `baseSalary`／`laborGrade` 是上方表單目前的值，用來提示「固定津貼＋底薪」合計（系統不自動改投保級距）。
 * `onSummary`：把 API 回的 summary（含勞退月提繳工資自動值、國籍提示）交給上層薪資表單顯示。
 * `reloadKey`：上層存了薪資資料（本薪／提繳工資）後加 1，重新讀一次 summary。
 */
export function FixedAllowancesCard({
  employeeId,
  baseSalary,
  laborGrade,
  onSummary,
  reloadKey = 0,
}: {
  employeeId: string;
  baseSalary: string;
  laborGrade: string;
  onSummary?: (summary: FixedAllowanceSummary | null) => void;
  reloadKey?: number;
}) {
  const [items, setItems] = useState<FixedAllowance[]>([]);
  const [summary, setSummary] = useState<FixedAllowanceSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FixedAllowanceForm>(EMPTY_FIXED_ALLOWANCE_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [warnings, setWarnings] = useState<FixedAllowanceWarning[]>([]);
  const [stalePeriods, setStalePeriods] = useState<string[]>([]);
  const panelId = useId();

  const applyNotices = useCallback((n: FixedAllowanceNotices) => {
    setWarnings(n.warnings ?? []);
    setStalePeriods(n.stalePeriods ?? []);
  }, []);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await getFixedAllowances(employeeId);
      setItems(res.fixedAllowances);
      setSummary(res.summary);
      onSummary?.(res.summary);
      applyNotices(res);
    } catch (err) {
      setItems([]);
      setSummary(null);
      onSummary?.(null);
      setLoadError(apiErrorMessage(err, "載入固定津貼失敗"));
    }
    // onSummary 由上層每次 render 重建，不放進依賴（避免無限重讀）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, applyNotices]);

  useEffect(() => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FIXED_ALLOWANCE_FORM);
    setFormError(null);
    void reload();
  }, [reload, reloadKey]);

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
      // 提醒（同名重疊、草稿過期）由 reload 的 GET 一併帶回。
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
  const midHint = midMonthHint(form);
  const staleText = staleNoticeText(stalePeriods);
  const fmt = (n: number) => n.toLocaleString("zh-TW");

  const tip =
    "每月執行薪資時自動帶入當月有效的津貼（月中生效／終止當月整月帶入）；應稅併入應發，伙食費每月合計在免稅額內免稅（規則參數，預設 3,000）。";

  return (
    <div data-testid="fixed-allowances-card">
      <SectionRow
        title="固定津貼"
        tip={tip}
        summary={fixedAllowanceSummaryText(items.length, summary?.activeTotal)}
        actions={
          <LinkButton onClick={() => (showForm ? setShowForm(false) : startNew())} aria-expanded={showForm} aria-controls={panelId}>
            {showForm ? "收合" : "＋新增"}
          </LinkButton>
        }
      >
        <div id={panelId} hidden={!showForm}>
          <form onSubmit={onSubmit} className={`${formBoxCls} grid grid-cols-1 gap-3 sm:grid-cols-3`}>
            <div>
              <label className={labelCls}>津貼名稱</label>
              <input className={inputCls} value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="例：職務加給" />
            </div>
            <div>
              <label className={labelCls}>月金額（元）</label>
              <MoneyInput className={inputCls} value={form.amount} onValueChange={(v) => patch({ amount: v })} />
            </div>
            <div>
              <label className={labelCls}>課稅方式</label>
              <select className={inputCls} value={form.taxType} onChange={(e) => patch({ taxType: e.target.value as AllowanceTaxType })}>
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
            <div>
              <label className={labelCls}>備註（選填）</label>
              <input className={inputCls} value={form.note} onChange={(e) => patch({ note: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={form.insurable} onChange={(e) => patch({ insurable: e.target.checked })} />
              計入投保薪資（經常性給與）
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-600 sm:col-span-2">
              <input type="checkbox" checked={form.overtimeBase} onChange={(e) => patch({ overtimeBase: e.target.checked })} data-testid="fixed-allowance-overtime-base" />
              {overtimeBaseHint(summary?.hourlyWageDivisor)}
            </label>
            {midHint && (
              <p className="text-xs text-amber-700 sm:col-span-3" data-testid="fixed-allowance-mid-month-hint">
                {midHint}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
              <Button size="sm" type="submit" loading={submitting}>
                {editingId ? "儲存修改" : "新增固定津貼"}
              </Button>
              {formError && <ErrorText>{formError}</ErrorText>}
            </div>
          </form>
        </div>

        {loadError && <ErrorText>{loadError}</ErrorText>}
        {staleText && (
          <p className="mt-1 text-xs text-rose-700" role="alert" data-testid="fixed-allowances-stale">
            {staleText}
          </p>
        )}
        {warnings.map((w) => (
          <p key={`${w.name}-${w.months.join()}`} className="mt-1 text-xs text-amber-700" data-testid="fixed-allowances-overlap">
            {w.message}
          </p>
        ))}
        {items.length > 0 && (
          <ul className="mt-1 divide-y divide-gray-100">
            {items.map((a) => (
              <ListRow
                key={a.id}
                main={
                  <>
                    {a.name} <span className="tabular-nums">{fmt(a.amount)}</span> 元
                  </>
                }
                meta={[
                  a.taxType === "meal_exempt" ? "伙食費" : "應稅",
                  a.insurable ? "計入投保" : "不計投保",
                  a.overtimeBase === false ? "不計加班基數" : "計入加班基數",
                  `${a.effectiveFrom} ～ ${a.effectiveTo ?? "無迄日"}`,
                  a.note,
                ]
                  .filter(Boolean)
                  .join("｜")}
                actions={
                  <>
                    <LinkButton onClick={() => startEdit(a)}>修改</LinkButton>
                    <button type="button" onClick={() => void onDelete(a)} className={dangerLinkCls}>
                      刪除
                    </button>
                  </>
                }
              />
            ))}
          </ul>
        )}
        {hint && (
          <p className="mt-1 text-xs text-amber-700" data-testid="fixed-allowances-insured-hint">
            {hint}
          </p>
        )}
      </SectionRow>
    </div>
  );
}
