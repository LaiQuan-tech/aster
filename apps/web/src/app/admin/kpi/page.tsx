"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton, Segmented, inputCls, labelCls } from "@/components/admin-ui";
import { KpiScoreForm } from "@/components/KpiScoreForm";
import { getEmployees, type Employee } from "@/lib/admin-api";
import {
  listKpiTemplates,
  createKpiTemplate,
  updateKpiTemplate,
  deleteKpiTemplate,
  listKpiReviews,
  assignKpiReview,
  scoreKpiReview,
  submitKpiReview,
  finalizeKpiReview,
  defaultKpiPeriod,
  REVIEW_STATUS_LABEL,
  type KpiTemplate,
  type KpiTemplateItem,
  type KpiReview,
  type KpiReviewStatus,
} from "@/lib/kpi-api";

/**
 * 績效考核後台（HR）。兩個分頁：
 *   範本 —— 考核項目與權重（權重合計慣例 100，總分即 0–100）
 *   考核 —— 依期間指派（受評者 × 考核者 × 範本）、看進度、HR 可代評、定案
 * 考核者（主管）在 ESS「我的考核」評分送出；受評者定案後在同頁看結果。
 * 流程：draft（評分中）→ submitted（考核者送出）→ finalized（HR 定案，不可再改）。
 */

const STATUS_CLS: Record<KpiReviewStatus, string> = {
  draft: "bg-amber-50 text-amber-700",
  submitted: "bg-blue-50 text-blue-700",
  finalized: "bg-green-50 text-green-700",
};

const emptyItem = (): KpiTemplateItem => ({ key: "", label: "", weight: 0, maxScore: 10 });

export default function KpiAdminPage() {
  const [tab, setTab] = useState<"reviews" | "templates">("reviews");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [templates, setTemplates] = useState<KpiTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    try {
      const r = await listKpiTemplates();
      setTemplates(r.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入範本失敗");
    }
  }, []);

  useEffect(() => {
    getEmployees()
      .then((r) => setEmployees(r.employees.filter((e) => e.status === "active" || !e.status)))
      .catch((err) => setError(err instanceof Error ? err.message : "載入員工失敗"));
    void loadTemplates();
  }, [loadTemplates]);

  const empName = useCallback(
    (id: string) => {
      const e = employees.find((x) => x.id === id);
      return e ? (e.emp_no ? `${e.emp_no} · ${e.name}` : e.name) : id.slice(0, 8);
    },
    [employees],
  );

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
      <Segmented
        options={[
          { value: "reviews", label: "考核" },
          { value: "templates", label: "範本" },
        ]}
        value={tab}
        onChange={setTab}
        className="w-full md:w-auto"
        aria-label="績效考核檢視"
      />
      {tab === "templates" ? (
        <TemplatesTab templates={templates} reload={loadTemplates} onError={setError} />
      ) : (
        <ReviewsTab employees={employees} templates={templates} empName={empName} onError={setError} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ 範本 -- */

function TemplatesTab({ templates, reload, onError }: { templates: KpiTemplate[]; reload: () => Promise<void>; onError: (m: string | null) => void }) {
  const [editing, setEditing] = useState<KpiTemplate | null | "new">(null);
  const [name, setName] = useState("");
  const [items, setItems] = useState<KpiTemplateItem[]>([emptyItem()]);
  const [busy, setBusy] = useState(false);

  function startEdit(t: KpiTemplate | "new") {
    setEditing(t);
    setName(t === "new" ? "" : t.name);
    setItems(t === "new" ? [emptyItem()] : t.items.map((i) => ({ ...i })));
  }
  const weightSum = items.reduce((s, i) => s + (Number(i.weight) || 0), 0);
  const valid = name.trim() && items.length > 0 && items.every((i) => i.key.trim() && i.label.trim() && i.maxScore > 0 && i.weight >= 0) && new Set(items.map((i) => i.key.trim())).size === items.length;

  async function save() {
    if (!valid || editing === null) return;
    setBusy(true);
    onError(null);
    try {
      const body = { name: name.trim(), items: items.map((i) => ({ key: i.key.trim(), label: i.label.trim(), weight: Number(i.weight), maxScore: Number(i.maxScore) })) };
      if (editing === "new") await createKpiTemplate(body);
      else await updateKpiTemplate(editing.id, body);
      setEditing(null);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(t: KpiTemplate) {
    try {
      await updateKpiTemplate(t.id, { active: !t.active });
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : "更新失敗");
    }
  }
  async function remove(t: KpiTemplate) {
    if (!confirm(`刪除範本「${t.name}」？已指派的考核仍會保留分數，但看不到項目定義。`)) return;
    try {
      await deleteKpiTemplate(t.id);
      await reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  return (
    <>
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">考核範本</h2>
          <PrimaryButton type="button" onClick={() => startEdit("new")}>新增範本</PrimaryButton>
        </div>
        {templates.length === 0 ? (
          <Empty>尚無範本。先建一份（例：工作品質 60、工作態度 40）。</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-2 pr-3">名稱</th>
                <th className="py-2 pr-3">項目</th>
                <th className="py-2 pr-3 text-right">權重合計</th>
                <th className="py-2 pr-3">狀態</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium text-gray-900">{t.name}</td>
                  <td className="py-2 pr-3 text-gray-600">{t.items.map((i) => `${i.label} ${i.weight}`).join("、") || "—"}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{t.items.reduce((s, i) => s + i.weight, 0)}</td>
                  <td className="py-2 pr-3">
                    <button type="button" onClick={() => toggleActive(t)} className={`rounded-full px-2 py-0.5 text-xs ${t.active ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-500"}`} title="點一下切換">
                      {t.active ? "啟用" : "停用"}
                    </button>
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button type="button" onClick={() => startEdit(t)} className="mr-3 text-xs text-gray-600 hover:underline">編輯</button>
                    <button type="button" onClick={() => remove(t)} className="text-xs text-gray-400 hover:text-red-600">刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing !== null && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-700">{editing === "new" ? "新增範本" : `編輯：${editing.name}`}</h2>
          <div className="mb-3">
            <label className={labelCls}>名稱</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：年度考核 2026" />
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-1.5 pr-2">代碼</th>
                <th className="py-1.5 pr-2">項目名稱</th>
                <th className="py-1.5 pr-2 text-right">權重</th>
                <th className="py-1.5 pr-2 text-right">滿分</th>
                <th className="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td className="py-1 pr-2"><input className={inputCls} value={it.key} onChange={(e) => setItems((a) => a.map((x, i) => (i === idx ? { ...x, key: e.target.value } : x)))} placeholder="quality" /></td>
                  <td className="py-1 pr-2"><input className={inputCls} value={it.label} onChange={(e) => setItems((a) => a.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))} placeholder="工作品質" /></td>
                  <td className="py-1 pr-2"><input type="number" min={0} className={`${inputCls} text-right`} value={it.weight} onChange={(e) => setItems((a) => a.map((x, i) => (i === idx ? { ...x, weight: Number(e.target.value) } : x)))} /></td>
                  <td className="py-1 pr-2"><input type="number" min={1} className={`${inputCls} text-right`} value={it.maxScore} onChange={(e) => setItems((a) => a.map((x, i) => (i === idx ? { ...x, maxScore: Number(e.target.value) } : x)))} /></td>
                  <td className="py-1 text-right"><button type="button" onClick={() => setItems((a) => a.filter((_, i) => i !== idx))} className="text-xs text-gray-400 hover:text-red-600">移除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setItems((a) => [...a, emptyItem()])} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700">＋ 項目</button>
            <span className={`text-sm ${weightSum === 100 ? "text-gray-500" : "text-amber-700"}`}>權重合計 {weightSum}{weightSum !== 100 && "（慣例 100，總分才是 0–100）"}</span>
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy || !valid}>{busy ? "儲存中…" : "儲存"}</PrimaryButton>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-gray-500 hover:underline">取消</button>
          </div>
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ 考核 -- */

function ReviewsTab({ employees, templates, empName, onError }: { employees: Employee[]; templates: KpiTemplate[]; empName: (id: string) => string; onError: (m: string | null) => void }) {
  const [period, setPeriod] = useState(defaultKpiPeriod());
  const [reviews, setReviews] = useState<KpiReview[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 指派
  const [aTemplate, setATemplate] = useState("");
  const [aReviewer, setAReviewer] = useState("");
  const [aEmployees, setAEmployees] = useState<string[]>([]);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await listKpiReviews({ period: period.trim() || undefined });
      setReviews(r.reviews);
    } catch (err) {
      onError(err instanceof Error ? err.message : "載入考核失敗");
    }
  }, [period, onError]);
  useEffect(() => {
    void load();
  }, [load]);

  const activeTemplates = templates.filter((t) => t.active);
  useEffect(() => {
    if (!aTemplate && activeTemplates[0]) setATemplate(activeTemplates[0].id);
  }, [activeTemplates, aTemplate]);

  const stats = useMemo(() => {
    const s = { draft: 0, submitted: 0, finalized: 0 };
    for (const r of reviews) s[r.status] += 1;
    return s;
  }, [reviews]);

  async function assign() {
    if (!aTemplate || !aReviewer || aEmployees.length === 0 || !period.trim()) return;
    setBusy(true);
    setAssignMsg(null);
    let ok = 0;
    const skipped: string[] = [];
    for (const employeeId of aEmployees) {
      try {
        await assignKpiReview({ employeeId, reviewerEmpId: aReviewer, templateId: aTemplate, period: period.trim() });
        ok += 1;
      } catch (err) {
        skipped.push(`${empName(employeeId)}：${err instanceof Error ? err.message : "失敗"}`);
      }
    }
    setAssignMsg(`已指派 ${ok} 筆${skipped.length ? `；略過 ${skipped.length} 筆（${skipped.join("；")}）` : ""}`);
    setAEmployees([]);
    setBusy(false);
    await load();
  }

  async function finalize(r: KpiReview) {
    if (!confirm(`定案 ${empName(r.employee_id)} 的 ${r.period} 考核？定案後分數不可再改。`)) return;
    setBusy(true);
    try {
      await finalizeKpiReview(r.id);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "定案失敗");
    } finally {
      setBusy(false);
    }
  }

  const templateOf = (r: KpiReview) => templates.find((t) => t.id === r.template_id);
  const sorted = [...reviews].sort((a, b) => empName(a.employee_id).localeCompare(empName(b.employee_id)));

  return (
    <>
      <Card>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>考核期間</label>
            <input className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-Q3 / 2026-H2 / 2026" />
          </div>
          <PrimaryButton type="button" onClick={() => void load()}>查詢</PrimaryButton>
          <span className="text-sm text-gray-500">
            評分中 {stats.draft}・已送出 {stats.submitted}・已定案 {stats.finalized}
          </span>
        </div>
        {sorted.length === 0 ? (
          <Empty>{period || "此期間"} 沒有考核。用下方「指派」開始。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-3">受評者</th>
                  <th className="py-2 pr-3">考核者</th>
                  <th className="py-2 pr-3">範本</th>
                  <th className="py-2 pr-3 text-right">總分</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const open = openId === r.id;
                  return (
                    <ReviewRowGroup key={r.id} r={r} open={open} template={templateOf(r)} empName={empName} busy={busy}
                      onToggle={() => setOpenId(open ? null : r.id)}
                      onFinalize={() => void finalize(r)}
                      onSave={async (scores) => { await scoreKpiReview(r.id, scores); await load(); }}
                      onSubmit={async () => { await submitKpiReview(r.id); await load(); }}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">指派考核（{period || "—"}）</h2>
        {activeTemplates.length === 0 ? (
          <Empty>沒有啟用中的範本，先到「範本」分頁建一份。</Empty>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className={labelCls}>範本</label>
                <select className={inputCls} value={aTemplate} onChange={(e) => setATemplate(e.target.value)}>
                  {activeTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>考核者（評分的人）</label>
                <select className={inputCls} value={aReviewer} onChange={(e) => setAReviewer(e.target.value)}>
                  <option value="">選擇</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{empName(e.id)}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>受評者（可多選）</label>
                <select multiple className={`${inputCls} h-32`} value={aEmployees} onChange={(e) => setAEmployees(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                  {employees.filter((e) => e.id !== aReviewer).map((e) => <option key={e.id} value={e.id}>{empName(e.id)}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <PrimaryButton type="button" onClick={() => void assign()} disabled={busy || !aReviewer || aEmployees.length === 0 || !period.trim()}>
                指派 {aEmployees.length > 0 ? `${aEmployees.length} 人` : ""}
              </PrimaryButton>
              {assignMsg && <span className="text-sm text-gray-600">{assignMsg}</span>}
            </div>
            <p className="mt-2 text-xs text-gray-400">同一受評者、同一範本、同一期間只能有一筆；重複指派會被略過。考核者到 ESS「我的考核」評分送出，HR 在這裡定案。</p>
          </>
        )}
      </Card>
    </>
  );
}

function ReviewRowGroup({ r, open, template, empName, busy, onToggle, onFinalize, onSave, onSubmit }: {
  r: KpiReview; open: boolean; template: KpiTemplate | undefined; empName: (id: string) => string; busy: boolean;
  onToggle: () => void; onFinalize: () => void; onSave: (s: import("@/lib/kpi-api").KpiScore[]) => Promise<void>; onSubmit: () => Promise<void>;
}) {
  return (
    <>
      <tr className="border-b last:border-0">
        <td className="py-2 pr-3 font-medium text-gray-900">
          <button type="button" onClick={onToggle} className="text-left hover:underline">{open ? "▾" : "▸"} {empName(r.employee_id)}</button>
        </td>
        <td className="py-2 pr-3 text-gray-600">{empName(r.reviewer_emp_id)}</td>
        <td className="py-2 pr-3 text-gray-600">{template?.name ?? "（範本已刪）"}</td>
        <td className="py-2 pr-3 text-right font-medium">{r.total_score != null ? Number(r.total_score) : "—"}</td>
        <td className="py-2 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[r.status]}`}>{REVIEW_STATUS_LABEL[r.status]}</span></td>
        <td className="py-2 text-right whitespace-nowrap">
          {r.status === "submitted" && (
            <button type="button" onClick={onFinalize} disabled={busy} className="text-sm font-medium disabled:opacity-50" style={{ color: "var(--brand)" }}>定案</button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-gray-50/60">
          <td colSpan={6} className="px-4 py-3">
            <p className="mb-2 text-xs text-gray-500">
              {r.status === "finalized" ? "已定案，僅供檢視。" : "HR 可在此代考核者評分（通常由考核者在 ESS 完成）。"}
            </p>
            <KpiScoreForm key={r.updated_at} review={r} template={template} readOnly={r.status === "finalized"} onSave={onSave} onSubmit={onSubmit} />
          </td>
        </tr>
      )}
    </>
  );
}
