"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, ErrorText, Pill, inputCls, labelCls, useToast } from "@/components/admin-ui";
import { fmtDateWithWeekday, fmtDateTime, fmtHm } from "@/lib/ess-format";
import {
  decideLateReport,
  getLateReports,
  lateDecisionErrorMessage,
  type LateDecisionFilter,
  type LateReport,
} from "@/lib/late-reports-api";
import { lateDecisionLabel, lateDecisionTone, periodOf, sortLateReports } from "@/lib/late-reason";

/**
 * 後台「出勤 → 遲到說明」（2026-10-11 業主拍板）。
 *
 * 當天第一張上班卡遲到（沒排班的工作日晚於 10:00、有排班晚於班別上班時間）員工必填原因；這裡列出來，
 * 依月份、員工、決定狀態篩選。**只有老闆**（設定裡的最後簽核人 fallbackApproverEmpId）看得到
 * 「影響全勤／不影響全勤」按鈕（可改決定、可加備註），其他人唯讀。沒決定視為影響全勤。
 */

const DECISION_OPTIONS: { value: LateDecisionFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "undecided", label: "尚未決定" },
  { value: "affects", label: "影響全勤" },
  { value: "exempt", label: "不影響全勤" },
];

export default function LateReportsPage() {
  const toast = useToast();
  const [period, setPeriod] = useState(periodOf());
  const [decision, setDecision] = useState<LateDecisionFilter>("all");
  const [employeeId, setEmployeeId] = useState("");
  const [reports, setReports] = useState<LateReport[]>([]);
  const [canDecide, setCanDecide] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

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
    void load();
  }, [load]);

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

  async function decide(report: LateReport, next: "affects" | "exempt") {
    setBusyId(report.id);
    try {
      const res = await decideLateReport(report.id, next, notes[report.id]);
      setReports((prev) => prev.map((r) => (r.id === report.id ? res.lateReport : r)));
      setNotes((prev) => ({ ...prev, [report.id]: "" }));
      toast.show(`${report.employeeName}：${next === "exempt" ? "不影響全勤" : "影響全勤"}`, "success");
    } catch (err) {
      toast.show(lateDecisionErrorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  }

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
            <select id="late-employee" className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">全部</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <p className="text-sm text-gray-500">
              共 {rows.length} 筆{undecidedCount > 0 ? ` · 尚未決定 ${undecidedCount} 筆（視為影響全勤）` : ""}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          {canDecide
            ? "你是老闆：每筆可決定「影響全勤」或「不影響全勤」，可以改決定；沒決定視為影響全勤。"
            : "只有老闆可以決定遲到是否影響全勤；沒決定視為影響全勤。"}
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
                  const busy = busyId === r.id;
                  return (
                    <tr key={r.id} className="border-b border-gray-50 align-top">
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{fmtDateWithWeekday(r.workDate)}</td>
                      <td className="whitespace-nowrap py-2 pr-3">{r.employeeName || "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{fmtHm(r.punchAt)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{r.lateMinutes} 分</td>
                      <td className="max-w-xs whitespace-pre-wrap break-words py-2 pr-3 text-gray-800">{r.reason}</td>
                      <td className="py-2 pr-3">
                        <Pill tone={lateDecisionTone(r.decision)}>{lateDecisionLabel(r.decision)}</Pill>
                        {r.decidedAt && (
                          <p className="mt-1 text-xs text-gray-400">
                            {r.decidedByName ?? "老闆"} · {fmtDateTime(r.decidedAt)}
                          </p>
                        )}
                        {r.decisionNote && <p className="mt-1 text-xs text-gray-500">備註：{r.decisionNote}</p>}
                      </td>
                      {canDecide && (
                        <td className="py-2">
                          <div className="flex min-w-[14rem] flex-col gap-2">
                            <input
                              className={inputCls}
                              placeholder="備註（選填）"
                              maxLength={500}
                              value={notes[r.id] ?? ""}
                              onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant={r.decision === "affects" ? "primary" : "secondary"}
                                disabled={busy}
                                onClick={() => void decide(r, "affects")}
                              >
                                影響全勤
                              </Button>
                              <Button
                                size="sm"
                                variant={r.decision === "exempt" ? "primary" : "secondary"}
                                disabled={busy}
                                onClick={() => void decide(r, "exempt")}
                              >
                                不影響全勤
                              </Button>
                            </div>
                          </div>
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
