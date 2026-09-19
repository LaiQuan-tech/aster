"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import {
  getHeadcount,
  getDepartments,
  getPreference,
  savePreference,
  type HeadcountMonth,
  type Department,
} from "@/lib/admin-api";

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";
const STORAGE_KEY = "hr.admin.dashboard.widgets.v1";
const PREFERENCE_KEY = "admin.dashboard.widgets.v1";

type WidgetId = "summary" | "trend" | "movement" | "filters";
type DashboardWidget = { id: WidgetId; visible: boolean };

const WIDGET_META: Record<WidgetId, { title: string; desc: string }> = {
  summary: { title: "關鍵指標", desc: "期初、新進、離職與期末在職" },
  trend: { title: "在職趨勢", desc: "依月份顯示期末在職長條圖" },
  movement: { title: "月度異動明細", desc: "每月期初/新進/離職/期末表格" },
  filters: { title: "目前篩選條件", desc: "快速檢視 Dashboard 查詢條件" },
};

const DEFAULT_WIDGETS: DashboardWidget[] = [
  { id: "summary", visible: true },
  { id: "trend", visible: true },
  { id: "movement", visible: true },
  { id: "filters", visible: true },
];

function ym(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function normalizeWidgets(value: unknown): DashboardWidget[] {
  try {
    const parsed = value as DashboardWidget[];
    if (!Array.isArray(parsed)) return DEFAULT_WIDGETS;
    const validIds = new Set<WidgetId>(["summary", "trend", "movement", "filters"]);
    const normalized = parsed.filter(
      (item): item is DashboardWidget =>
        !!item && validIds.has(item.id) && typeof item.visible === "boolean",
    );
    const missing = DEFAULT_WIDGETS.filter((item) => !normalized.some((stored) => stored.id === item.id));
    return normalized.length ? [...normalized, ...missing] : DEFAULT_WIDGETS;
  } catch {
    return DEFAULT_WIDGETS;
  }
}

function loadStoredWidgets(): DashboardWidget[] {
  if (typeof window === "undefined") return DEFAULT_WIDGETS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeWidgets(JSON.parse(raw)) : DEFAULT_WIDGETS;
  } catch {
    return DEFAULT_WIDGETS;
  }
}

export default function DashboardPage() {
  const now = new Date();
  const [from, setFrom] = useState(ym(new Date(now.getFullYear(), now.getMonth() - 5, 1)));
  const [to, setTo] = useState(ym(now));
  const [deptId, setDeptId] = useState("");
  const [empType, setEmpType] = useState("");
  const [jobGroup, setJobGroup] = useState("");
  const [depts, setDepts] = useState<Department[]>([]);
  const [series, setSeries] = useState<HeadcountMonth[]>([]);
  const [totals, setTotals] = useState<{ opening: number; hires: number; exits: number; closing: number } | null>(null);
  const [widgets, setWidgets] = useState(DEFAULT_WIDGETS);
  const [customizing, setCustomizing] = useState(false);
  const [preferenceStatus, setPreferenceStatus] = useState<"loading" | "saved" | "saving" | "local">("loading");
  const [error, setError] = useState<string | null>(null);
  const preferenceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    const localWidgets = loadStoredWidgets();
    setWidgets(localWidgets);
    getPreference<DashboardWidget[]>(PREFERENCE_KEY)
      .then((res) => {
        if (!active) return;
        if (res.preference.value) {
          const cloudWidgets = normalizeWidgets(res.preference.value);
          setWidgets(cloudWidgets);
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cloudWidgets));
          } catch {
            /* private mode */
          }
        }
        setPreferenceStatus("saved");
      })
      .catch(() => {
        if (active) setPreferenceStatus("local");
      });
    return () => {
      active = false;
      if (preferenceSaveTimer.current) clearTimeout(preferenceSaveTimer.current);
    };
  }, []);

  function persistWidgets(next: DashboardWidget[]) {
    setWidgets(next);
    setPreferenceStatus("saving");
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    if (preferenceSaveTimer.current) clearTimeout(preferenceSaveTimer.current);
    preferenceSaveTimer.current = setTimeout(async () => {
      try {
        await savePreference(PREFERENCE_KEY, next);
        setPreferenceStatus("saved");
      } catch {
        setPreferenceStatus("local");
      }
    }, 600);
  }

  const load = useCallback(async () => {
    try {
      const res = await getHeadcount({
        from,
        to,
        deptId: deptId || undefined,
        employmentType: empType || undefined,
        jobGroup: jobGroup || undefined,
      });
      setSeries(res.series);
      setTotals(res.totals);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [from, to, deptId, empType, jobGroup]);

  useEffect(() => {
    getDepartments().then((r) => setDepts(r.departments)).catch(() => null);
    void load();
  }, [load]);

  const max = Math.max(1, ...series.map((month) => Math.max(month.closing, month.opening)));
  const deptName = depts.find((dept) => dept.id === deptId)?.name ?? "全部";
  const visibleWidgets = widgets.filter((widget) => widget.visible);
  const activeFilterCount = [deptId, empType, jobGroup].filter(Boolean).length;
  const closingDelta = useMemo(() => {
    if (series.length < 2) return 0;
    return series[series.length - 1].closing - series[0].opening;
  }, [series]);

  function toggleWidget(id: WidgetId) {
    persistWidgets(widgets.map((item) => (item.id === id ? { ...item, visible: !item.visible } : item)));
  }

  function moveWidget(id: WidgetId, direction: -1 | 1) {
    const index = widgets.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= widgets.length) return;
    const next = [...widgets];
    [next[index], next[target]] = [next[target], next[index]];
    persistWidgets(next);
  }

  function resetWidgets() {
    persistWidgets(DEFAULT_WIDGETS);
  }

  function renderWidget(id: WidgetId) {
    if (id === "summary") {
      return (
        <Card key={id}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">關鍵指標</h2>
              <p className="mt-1 text-sm text-gray-500">Apollo Dashboard 常用 headcount 指標。</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${closingDelta >= 0 ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
              期末變化 {closingDelta >= 0 ? "+" : ""}{closingDelta}
            </span>
          </div>
          {totals ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "期初在職", value: totals.opening, cls: "text-gray-800" },
                { label: "新進", value: totals.hires, cls: "text-green-600" },
                { label: "離職", value: totals.exits, cls: "text-red-600" },
                { label: "期末在職", value: totals.closing, cls: "text-gray-800" },
              ].map((item) => (
                <div key={item.label} className="rounded-lg bg-gray-50 p-4 text-center">
                  <p className="text-xs text-gray-500">{item.label}</p>
                  <p className={`text-2xl font-bold ${item.cls}`}>{item.value}</p>
                </div>
              ))}
            </div>
          ) : (
            <Empty>尚無統計資料</Empty>
          )}
        </Card>
      );
    }

    if (id === "trend") {
      return (
        <Card key={id}>
          <h2 className="mb-1 text-base font-semibold text-gray-900">在職趨勢</h2>
          <p className="mb-4 text-sm text-gray-500">期末在職依月份呈現，保留新進/離職提示。</p>
          {series.length === 0 ? (
            <Empty>無資料</Empty>
          ) : (
            <div className="space-y-2">
              {series.map((month) => (
                <div key={month.month} className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-gray-600">{month.month}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded bg-gray-100">
                    <div
                      className="h-full rounded"
                      style={{ width: `${(month.closing / max) * 100}%`, backgroundColor: "var(--brand)" }}
                    />
                  </div>
                  <span className="w-40 shrink-0 text-xs text-gray-500">
                    期末 {month.closing}｜新進 +{month.hires}｜離職 −{month.exits}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      );
    }

    if (id === "movement") {
      return (
        <Card key={id}>
          <h2 className="mb-1 text-base font-semibold text-gray-900">月度異動明細</h2>
          <p className="mb-4 text-sm text-gray-500">可直接對照 Apollo 的期初、新進、離職、期末欄位。</p>
          {series.length === 0 ? (
            <Empty>無資料</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="py-2 pr-4">月份</th>
                    <th className="py-2 pr-4">期初</th>
                    <th className="py-2 pr-4">新進</th>
                    <th className="py-2 pr-4">離職</th>
                    <th className="py-2">期末</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((month) => (
                    <tr key={month.month} className="border-b border-gray-50">
                      <td className="py-2 pr-4 font-medium text-gray-800">{month.month}</td>
                      <td className="py-2 pr-4">{month.opening}</td>
                      <td className="py-2 pr-4 text-green-700">+{month.hires}</td>
                      <td className="py-2 pr-4 text-red-700">−{month.exits}</td>
                      <td className="py-2 font-medium">{month.closing}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      );
    }

    return (
      <Card key={id}>
        <h2 className="mb-1 text-base font-semibold text-gray-900">目前篩選條件</h2>
        <p className="mb-4 text-sm text-gray-500">個人化儀表板會保留 widget 排版；查詢條件仍由上方控制。</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["月份區間", `${from} → ${to}`],
            ["單位", deptName],
            ["身分類別", empType || "全部"],
            ["職務群組", jobGroup || "全部"],
            ["啟用篩選", `${activeFilterCount} 個`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-1 font-medium text-slate-900">{value}</p>
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">查詢條件</h2>
            <p className="mt-1 text-sm text-gray-500">期初、新進、離職、期末可依單位、身分類別與職務群組分析。</p>
          </div>
          <button
            type="button"
            onClick={() => setCustomizing((value) => !value)}
            className="rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700"
          >
            {customizing ? "完成自訂" : "自訂儀表板"}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <div>
            <label className={labelCls}>起始月份</label>
            <input type="month" className={inputCls} value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>結束月份</label>
            <input type="month" className={inputCls} value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>單位</label>
            <select className={inputCls} value={deptId} onChange={(event) => setDeptId(event.target.value)}>
              <option value="">全部</option>
              {depts.map((dept) => (
                <option key={dept.id} value={dept.id}>{dept.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>身分類別</label>
            <select className={inputCls} value={empType} onChange={(event) => setEmpType(event.target.value)}>
              <option value="">全部</option>
              <option value="regular">正職</option>
              <option value="parttime">兼職</option>
              <option value="contract">約聘</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>職務群組</label>
            <select className={inputCls} value={jobGroup} onChange={(event) => setJobGroup(event.target.value)}>
              <option value="">全部</option>
              <option value="employee">一般員工</option>
              <option value="manager">主管</option>
              <option value="hr_admin">HR 管理員</option>
            </select>
          </div>
          <div className="flex items-end">
            <PrimaryButton type="button" onClick={() => void load()}>查詢</PrimaryButton>
          </div>
        </div>
        {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
      </Card>

      {customizing && (
        <Card>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">自訂儀表板</h2>
              <p className="mt-1 text-sm text-gray-500">
                選擇 widget、調整順序；設定會跟著帳號同步。
                <span className="ml-2 text-xs text-gray-400">
                  {preferenceStatus === "loading"
                    ? "載入偏好中…"
                    : preferenceStatus === "saving"
                      ? "同步中…"
                      : preferenceStatus === "saved"
                        ? "已同步"
                        : "暫存本機"}
                </span>
              </p>
            </div>
            <button type="button" onClick={resetWidgets} className="text-sm text-gray-500 hover:underline">恢復預設</button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {widgets.map((widget, index) => (
              <div key={widget.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
                <label className="flex min-w-0 items-center gap-3">
                  <input type="checkbox" checked={widget.visible} onChange={() => toggleWidget(widget.id)} />
                  <span>
                    <span className="block font-medium text-gray-900">{WIDGET_META[widget.id].title}</span>
                    <span className="block text-sm text-gray-500">{WIDGET_META[widget.id].desc}</span>
                  </span>
                </label>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => moveWidget(widget.id, -1)}
                    disabled={index === 0}
                    className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 disabled:opacity-40"
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    onClick={() => moveWidget(widget.id, 1)}
                    disabled={index === widgets.length - 1}
                    className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 disabled:opacity-40"
                  >
                    下移
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {visibleWidgets.length === 0 ? (
        <Card><Empty>所有 widget 已隱藏，請打開「自訂儀表板」重新啟用。</Empty></Card>
      ) : (
        visibleWidgets.map((widget) => renderWidget(widget.id))
      )}
    </>
  );
}
