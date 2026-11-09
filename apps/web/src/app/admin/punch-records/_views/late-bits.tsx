"use client";

import { useState } from "react";
import { Button, Pill, inputCls, useToast } from "@/components/admin-ui";
import { fmtDateTime } from "@/lib/ess-format";
import { invalidateEssState } from "@/lib/ess-state";
import { decideLateReport, lateDecisionErrorMessage, OWN_LATE_REPORT_NOTE, type LateReport } from "@/lib/late-reports-api";
import { LATE_REPORTS_CHANGED_EVENT, lateDecisionLabel, lateDecisionTone } from "@/lib/late-reason";

/**
 * 遲到說明的共用畫面零件（2026-11-09：原 /admin/late-reports 頁搬成打卡紀錄的「遲到說明」檢視，
 * 「當日總覽」也多「遲到原因／全勤」兩欄；兩處共用這一份決定邏輯與按鈕，不複製兩份）。
 * 權限：只有 GET /late-reports 回 canDecide（老闆）才給按鈕；自己的遲到說明顯示灰字不給按鈕（同原頁）。
 */

/** 決定狀態徽章＋決定者與時間＋備註。 */
export function LateDecisionStatus({ report }: { report: LateReport }) {
  return (
    <>
      <Pill tone={lateDecisionTone(report.decision)}>{lateDecisionLabel(report.decision)}</Pill>
      {report.decidedAt && (
        <p className="mt-1 text-xs text-gray-400">
          {report.decidedByName ?? "老闆"} · {fmtDateTime(report.decidedAt)}
        </p>
      )}
      {report.decisionNote && <p className="mt-1 text-xs text-gray-500">備註：{report.decisionNote}</p>}
    </>
  );
}

/**
 * 決定動作（備註暫存、送出中、成功後 toast／刷新員工端紅點／廣播給分頁徽章）。
 * onUpdated：把 API 回的新那筆換進呼叫端的清單。
 */
export function useLateDecider(onUpdated: (report: LateReport) => void) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function decide(report: LateReport, next: "affects" | "exempt") {
    setBusyId(report.id);
    try {
      const res = await decideLateReport(report.id, next, notes[report.id]);
      onUpdated(res.lateReport);
      setNotes((prev) => ({ ...prev, [report.id]: "" }));
      invalidateEssState(); // 員工端「簽核」紅點含老闆待決定的遲到說明（lib/ess-badges.ts），立刻重抓、不等 30 秒 TTL
      window.dispatchEvent(new Event(LATE_REPORTS_CHANGED_EVENT));
      toast.show(`${report.employeeName}：${next === "exempt" ? "不影響全勤" : "影響全勤"}`, "success");
    } catch (err) {
      toast.show(lateDecisionErrorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  }

  return {
    busyId,
    noteOf: (id: string) => notes[id] ?? "",
    setNote: (id: string, value: string) => setNotes((prev) => ({ ...prev, [id]: value })),
    decide,
  };
}

export type LateDecider = ReturnType<typeof useLateDecider>;

/** 備註欄＋「影響全勤」「不影響全勤」；自己的遲到說明只顯示灰字。呼叫端只在 canDecide 時渲染。 */
export function LateDecisionControls({ report, decider }: { report: LateReport; decider: LateDecider }) {
  if (report.own) return <p className="text-xs text-gray-500">{OWN_LATE_REPORT_NOTE}</p>;
  const busy = decider.busyId === report.id;
  return (
    <div className="flex min-w-[14rem] flex-col gap-2">
      <input
        className={inputCls}
        placeholder="備註（選填）"
        aria-label={`${report.employeeName} 的決定備註`}
        maxLength={500}
        value={decider.noteOf(report.id)}
        onChange={(e) => decider.setNote(report.id, e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={report.decision === "affects" ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => void decider.decide(report, "affects")}
        >
          影響全勤
        </Button>
        <Button
          size="sm"
          variant={report.decision === "exempt" ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => void decider.decide(report, "exempt")}
        >
          不影響全勤
        </Button>
      </div>
    </div>
  );
}
