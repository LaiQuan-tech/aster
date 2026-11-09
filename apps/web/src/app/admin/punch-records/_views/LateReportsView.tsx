"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import { fmtDateWithWeekday, fmtHm } from "@/lib/ess-format";
import { getLateReports, type LateDecisionFilter, type LateReport } from "@/lib/late-reports-api";
import { periodOf, sortLateReports } from "@/lib/late-reason";
import { EmployeeCombobox } from "@/components/EmployeeCombobox";
import { LateDecisionControls, LateDecisionStatus, useLateDecider } from "./late-bits";

/**
 * 打卡紀錄 › 「遲到說明」檢視（2026-10-11 業主拍板；2026-11-09 原後台頁 /admin/late-reports 搬來這裡，
 * 舊網址轉址到 /admin/punch-records?view=late，帶的 query 保留：period／decision／employee 會套用）。
 *
 * 當天第一張上班卡遲到（沒排班的工作日晚於 10:00、有排班晚於班別上班時間）員工必填原因；這裡列出來，
 * 依月份、員工、決定狀態篩選。**只有老闆**（設定裡的最後簽核人 fallbackApproverEmpId）看得到
 * 「影響全勤／不影響全勤」按鈕（可改決定、可加備註），其他人唯讀。沒決定視為影響全勤。
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const DECISION_OPTIONS: { value: LateDecisionFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "undecided", label: "尚未決定" },
  { value: "affects", label: "影響全勤" },
  { value: "exempt", label: "不影響全勤" },
];

export function LateReportsView() {
  const [period, setPeriod] = useState(periodOf());
  const [decision, setDecision] = useState<LateDecisionFilter>("all");
  const [employeeId, setEmployeeId] = useState("");
  const [reports, setReports] = useState<LateReport[]>([]);
  const [canDecide, setCanDecide] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queryReady, setQueryReady] = useState(false);
  const decider = useLateDecider((next) => setReports((prev) => prev.map((r) => (r.id === next.id ? next : r))));

  // 舊網址帶來的篩選（掛載後才讀，避免 SSR 不一致）。
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const p = qs.get("period");
    if (p && PERIOD_RE.test(p)) setPeriod(p);
    const d = qs.get("decision");
    if (d && DECISION_OPTIONS.some((o) => o.value === d)) setDecision(d as LateDecisionFilter);
    const e = qs.get("employee") ?? qs.get("employeeId");
    if (e) setEmployeeId(e);
    setQueryReady(true);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getLateReports({ period: period || undefined, decision });
      setReports(res.lateReports);
      setCanDecide(res.canDecide);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [period, decision]);

  useEffect(() => {
    if (queryReady) void load();
  }, [load, queryReady]);

  // 員工下拉：用這次載入的清單組（同一人只出現一次，依姓名排序）。
  const employees = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reports) map.set(r.employeeId, r.employeeName || r.employeeId.slice(0, 8));
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }, [reports]);

  const rows = useMemo(
    () => sortLateReports(employeeId ? reports.filter((r) => r.employeeId === employeeId) : reports),
    [reports, employeeId],
  );
  const undecidedCount = rows.filter((r) => r.decision === null).length;

  return (
    <>
      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className={labelCls} htmlFor="late-period">
              月份
            </label>
            <input id="late-period" type="month" className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="late-decision">
              決定狀態
            </label>
            <select
              id="late-decision"
              className={inputCls}
              value={decision}
              onChange={(e) => setDecision(e.target.value as LateDecisionFilter)}
            >
              {DECISION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="late-employee">
              員工
            </label>
            <EmployeeCombobox
              id="late-employee"
              options={employees.map((e) => ({ id: e.id, label: e.name, searchText: `${(e as { emp_no?: string | null }).emp_no ?? ""} ${e.name}` }))}
              value={employeeId}
              onChange={setEmployeeId}
              emptyLabel="全部"
            />
          </div>
          <div className="flex items-end">
            <p className="text-sm text-gray-500">
              共 {rows.length} 筆{undecidedCount > 0 ? ` · 尚未決定 ${undecidedCount} 筆（視為影響全勤）` : ""}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          {canDecide
            ? "你可以決定（平台管理員（老闆））：每筆可決定「影響全勤」或「不影響全勤」，可以改決定；沒決定視為影響全勤。"
            : "只有平台管理員（老闆）可以決定遲到是否影響全勤；沒決定視為影響全勤。"}
        </p>
      </Card>

      <Card>
        {error && (
          <div className="mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>這個條件下沒有遲到說明</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">日期</th>
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3">上班卡</th>
                  <th className="py-2 pr-3 text-right">遲到</th>
                  <th className="py-2 pr-3">原因</th>
                  <th className="py-2 pr-3">全勤</th>
                  {canDecide && <th className="py-2">決定</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  return (
                    <tr key={r.id} className="border-b border-gray-50 align-top">
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{fmtDateWithWeekday(r.workDate)}</td>
                      <td className="whitespace-nowrap py-2 pr-3">{r.employeeName || "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{fmtHm(r.punchAt)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.lateMinutes} 分</td>
                      <td className="max-w-xs whitespace-pre-wrap break-words py-2 pr-3 text-gray-800">{r.reason}</td>
                      <td className="py-2 pr-3">
                        <LateDecisionStatus report={r} />
                      </td>
                      {canDecide && (
                        <td className="py-2">
                          <LateDecisionControls report={r} decider={decider} />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
