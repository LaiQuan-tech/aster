"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, InlineError, Pill, SectionTitle, useToast } from "@/components/ess-ui";
import { fmtDateWithWeekday, fmtHm } from "@/lib/ess-format";
import { useEssState } from "@/lib/ess-state";
import { decideLateReport, getLateReports, lateDecisionErrorMessage, type LateReport } from "@/lib/late-reports-api";
import { lateDecisionLabel, lateDecisionTone, lateReportHeadline, periodOf, sortLateReports } from "@/lib/late-reason";

/**
 * 簽核頁的「遲到說明」段（2026-10-11）：
 *   • 主管：看自己部門的人本月的遲到說明（唯讀）。
 *   • 老闆（features.approval.fallbackApproverEmpId）：看全公司，本月的＋以前還沒決定的，
 *     每張卡直接按「影響全勤」／「不影響全勤」（可改決定）。
 * 自己的遲到說明不列在這裡；一筆都沒有就整段不顯示。沒決定視為影響全勤。
 */
export function LateReportsSection() {
  const toast = useToast();
  const { me } = useEssState();
  const [reports, setReports] = useState<LateReport[]>([]);
  const [canDecide, setCanDecide] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const month = await getLateReports({ period: periodOf() });
    let list = month.lateReports;
    if (month.canDecide) {
      // 老闆：以前的月份還沒決定的也要看得到（沒決定＝影響全勤）。
      const undecided = await getLateReports({ decision: "undecided" });
      const seen = new Set(list.map((r) => r.id));
      list = [...list, ...undecided.lateReports.filter((r) => !seen.has(r.id))];
    }
    setCanDecide(month.canDecide);
    setReports(list);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await load();
        if (active) setError(null);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "載入遲到說明失敗");
      } finally {
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  const visible = useMemo(() => sortLateReports(reports.filter((r) => r.employeeId !== me?.id)), [reports, me?.id]);

  async function decide(report: LateReport, decision: "affects" | "exempt") {
    setBusyId(report.id);
    try {
      const res = await decideLateReport(report.id, decision);
      setReports((prev) => prev.map((r) => (r.id === report.id ? res.lateReport : r)));
      toast.show(`${report.employeeName}：${decision === "exempt" ? "不影響全勤" : "影響全勤"}`, "success");
    } catch (err) {
      toast.show(lateDecisionErrorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded) return null;
  if (!error && visible.length === 0) return null;

  return (
    <section className="space-y-3 pt-2" aria-label="遲到說明">
      <div className="flex items-center justify-between gap-3 px-1">
        <SectionTitle>遲到說明</SectionTitle>
        <span className="text-xs text-gray-400">{canDecide ? "由你決定是否影響全勤" : "唯讀 · 由老闆決定是否影響全勤"}</span>
      </div>
      {error && (
        <Card>
          <InlineError>{error}</InlineError>
        </Card>
      )}
      <ul className="space-y-3">
        {visible.map((report) => {
          const busy = busyId === report.id;
          return (
            <li key={report.id}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-gray-900">{report.employeeName || "同仁"}</p>
                    <p className="mt-0.5 text-sm tabular-nums text-gray-500">
                      {lateReportHeadline({
                        dateLabel: fmtDateWithWeekday(report.workDate),
                        punchHm: fmtHm(report.punchAt),
                        lateMinutes: report.lateMinutes,
                      })}
                    </p>
                  </div>
                  <Pill tone={lateDecisionTone(report.decision)} className="shrink-0">
                    {lateDecisionLabel(report.decision)}
                  </Pill>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-gray-50 px-3 py-2 text-sm text-gray-800">
                  {report.reason}
                </p>
                {report.decisionNote && <p className="mt-1 text-xs text-gray-500">老闆備註：{report.decisionNote}</p>}
                {canDecide && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button
                      variant={report.decision === "affects" ? "primary" : "secondary"}
                      disabled={busy || report.decision === "affects"}
                      loading={busy}
                      onClick={() => void decide(report, "affects")}
                    >
                      影響全勤
                    </Button>
                    <Button
                      variant={report.decision === "exempt" ? "primary" : "secondary"}
                      disabled={busy || report.decision === "exempt"}
                      loading={busy}
                      onClick={() => void decide(report, "exempt")}
                    >
                      不影響全勤
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
