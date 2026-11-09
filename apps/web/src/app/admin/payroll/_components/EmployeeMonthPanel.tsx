"use client";

/**
 * 月結發薪頁（/admin/payroll）右側（手機在下方）的員工明細面板：這位員工這個月還有什麼沒就緒，逐項就地處理。
 *   - 待簽申請：碰到這個月的 pending 申請（排除公務車預約）。登入者是目前關卡的簽核人（且不是自己的單）→ 核准／駁回；
 *     否則顯示目前簽核人＋連到簽核頁（核准只能由當關簽核人做，API 同樣擋）。
 *   - 出勤月表：重用出勤統計表的 SheetReviewBar（核准／退回／重開／重算，權限交給 API）。
 *   - 遲到說明：重用打卡紀錄的 late-bits（只有老闆能決定；其他人看狀態）。
 *   - 已核准未核銷的假單：「核銷」（POST /leave-settlement/settle，只送這位的假單）。
 *   - 報銷未月結／預支未沖：連到「費用與給付」。
 *   - 薪資單：狀態、過期旗標、應發／應扣／實發、逐項明細（payslip-bits 的 PayslipDetailGrid）＋「重算此人」「定案」「列印」「寄送」。
 *   - 一次性加減項：請頁面捲到加減項卡並篩出這位；「修改薪資資料」連到員工內頁的薪資分頁。
 * 每個動作成功後呼叫 onChanged（頁面重抓逐人列表與薪資單），面板自己的清單也重抓。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, ErrorText, Pill } from "@/components/admin-ui";
import {
  approveRequest,
  finalizePayslip,
  getRequests,
  rejectRequest,
  runPayroll,
  type LeaveRequest,
} from "@/lib/admin-api";
import { apiErrorMessage } from "@/lib/api-client";
import { KIND_LABEL, currentCandidateIds, isOwnRequestError, OWN_REQUEST_TEXT } from "@/lib/approval-view";
import { sendPayslip } from "@/lib/cash-payouts-api";
import { getLateReports, type LateReport } from "@/lib/late-reports-api";
import { listLeaveSettlements, settleLeaveRequests, summarizeSkipped, friendlySettlementError, type SettlementItem } from "@/lib/leave-settlement-api";
import { payrollGateText } from "@/lib/payroll-gate";
import { BLOCKER_LABEL, rosterLabel, type PeriodEmployeeRow } from "@/lib/payroll-month-api";
import { errorMessageOf } from "@/lib/period-closed";
import { SheetReviewBar } from "@/app/admin/attendance-statements/_components/SheetReviewBar";
import { LateDecisionControls, LateDecisionStatus, useLateDecider } from "@/app/admin/punch-records/_views/late-bits";
import { bd, fmtSentAt, money, n, netOf, PayslipDetailGrid, printPayslip, type PayslipRow } from "./payslip-bits";

function monthBounds(period: string): { from: string; to: string; startMs: number; endMs: number } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  return {
    from: prev, // 跨月的單：起日可能在上個月
    to: `${period}-${String(last).padStart(2, "0")}`,
    // 與 API 同樣用重疊判斷；台灣時區 +8，月界抓寬一點（前後各 14 小時）不會漏，多出來的只是顯示。
    startMs: Date.UTC(y, m - 1, 1) - 14 * 3600_000,
    endMs: Date.UTC(y, m, 1) + 14 * 3600_000,
  };
}

function fmtRange(start: string, end: string): string {
  const f = (iso: string) => new Date(iso).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return `${f(start)}～${f(end)}`;
}

function Section({ title, tone, children }: { title: string; tone?: "ok" | "bad" | "warn"; children: React.ReactNode }) {
  const dot = tone === "ok" ? "bg-green-500" : tone === "bad" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-gray-300";
  return (
    <section className="border-t border-gray-100 pt-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

export function EmployeeMonthPanel({
  row,
  period,
  payslip,
  meId,
  locked,
  empName,
  onChanged,
  onEditAdjustments,
  onClose,
}: {
  row: PeriodEmployeeRow;
  period: string;
  payslip: PayslipRow | null;
  meId: string | null;
  /** 該月已結算：動作會被 API 擋（409 period_closed），按鈕照顯示、錯誤訊息照轉中文。 */
  locked: boolean;
  empName: (id: string) => string;
  onChanged: () => void;
  onEditAdjustments: () => void;
  onClose: () => void;
}) {
  const employeeId = row.employeeId;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [requests, setRequests] = useState<LeaveRequest[] | null>(null);
  const [late, setLate] = useState<{ reports: LateReport[]; canDecide: boolean } | null>(null);
  const [leaves, setLeaves] = useState<SettlementItem[] | null>(null);

  const loadDetails = useCallback(async () => {
    const b = monthBounds(period);
    const tasks: Promise<void>[] = [];
    if (row.pendingRequests.total > 0) {
      tasks.push(
        getRequests({ status: "pending", employeeId, from: b.from, to: b.to })
          .then((res) =>
            setRequests(
              res.requests.filter(
                (r) => r.kind !== "vehicle_booking" && new Date(r.start_at).getTime() < b.endMs && new Date(r.end_at).getTime() > b.startMs,
              ),
            ),
          )
          .catch(() => setRequests([])),
      );
    } else setRequests([]);
    if (row.undecidedLateReports > 0) {
      tasks.push(
        getLateReports({ period, employeeId, decision: "undecided" })
          .then((res) => setLate({ reports: res.lateReports, canDecide: res.canDecide }))
          .catch(() => setLate({ reports: [], canDecide: false })),
      );
    } else setLate({ reports: [], canDecide: false });
    if (row.unsettledLeaves > 0) {
      tasks.push(
        listLeaveSettlements({ period, status: "unsettled" })
          .then((res) => setLeaves(res.items.filter((i) => i.employee.id === employeeId)))
          .catch(() => setLeaves([])),
      );
    } else setLeaves([]);
    await Promise.all(tasks);
  }, [employeeId, period, row.pendingRequests.total, row.undecidedLateReports, row.unsettledLeaves]);

  useEffect(() => {
    void loadDetails();
  }, [loadDetails]);

  useEffect(() => {
    setError(null);
    setNotice(null);
  }, [employeeId, period]);

  const decider = useLateDecider(() => {
    void loadDetails();
    onChanged();
  });

  async function act(label: string, fn: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      onChanged();
      await loadDetails();
    } catch (err) {
      setError(errorMessageOf(err, `${label}失敗`));
    } finally {
      setBusy(false);
    }
  }

  function decide(r: LeaveRequest, action: "approve" | "reject") {
    let comment: string | undefined;
    if (action === "reject") {
      const input = window.prompt("駁回原因（選填）") ;
      if (input === null) return;
      comment = input.trim() || undefined;
    } else if (!window.confirm(`核准 ${KIND_LABEL[r.kind] ?? r.kind}（${fmtRange(r.start_at, r.end_at)}）？`)) return;
    void act(action === "approve" ? "核准" : "駁回", async () => {
      try {
        await (action === "approve" ? approveRequest(r.id) : rejectRequest(r.id, comment));
      } catch (err) {
        if (isOwnRequestError(err)) throw new Error(OWN_REQUEST_TEXT);
        throw err;
      }
      return action === "approve" ? "已核准" : "已駁回";
    });
  }

  async function rerun() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runPayroll(period, employeeId);
      const warnings = (result.warnings ?? []).map((w) => w.message);
      setNotice(`已重算 ${period} 薪資單` + (result.skipped.length > 0 ? "（已定案，略過）" : "") + (warnings.length > 0 ? `；提醒：${warnings.join("；")}` : ""));
      onChanged();
    } catch (err) {
      // 已結算 409 period_closed、月表未說明的異常 409 anomalies_unacknowledged 等閘門訊息。
      setError(payrollGateText(err, empName) ?? errorMessageOf(err, "重算失敗"));
    } finally {
      setBusy(false);
    }
  }

  const b = payslip ? bd(payslip) : null;
  const sheetTone = !row.sheet ? undefined : row.sheet.ready ? "ok" : "bad";
  const payslipTone = row.blockers.includes("payslips") ? "bad" : payslip?.status === "finalized" ? "ok" : payslip ? "warn" : undefined;

  return (
    <div className="space-y-3 text-sm" data-testid="payroll-employee-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-gray-900">{rosterLabel(row)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {row.ready ? <Pill tone="green">已就緒</Pill> : <Pill tone="red">未就緒</Pill>}
            {!row.employedInPeriod && <Pill tone="gray">本月非在職</Pill>}
            {row.blockers.map((k) => (
              <Pill key={k} tone="red">
                {BLOCKER_LABEL[k]}
              </Pill>
            ))}
          </div>
        </div>
        <button type="button" onClick={onClose} className="shrink-0 text-xs text-gray-500 hover:underline">
          關閉
        </button>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <Link href={`/admin/employees/${employeeId}?tab=salary`} className="font-medium hover:underline" style={{ color: "var(--brand)" }}>
          修改薪資資料 →
        </Link>
        <button type="button" onClick={onEditAdjustments} className="font-medium hover:underline" style={{ color: "var(--brand)" }}>
          一次性加減項 →
        </button>
      </div>

      {notice && (
        <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800">
          {notice}
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}

      <Section title={`待簽申請（${row.pendingRequests.total}）`} tone={row.pendingRequests.total > 0 ? "warn" : "ok"}>
        {row.pendingRequests.total === 0 ? (
          <p className="text-xs text-gray-400">沒有碰到本月的待簽申請</p>
        ) : requests === null ? (
          <p className="text-xs text-gray-400">載入中…</p>
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => {
              const candidates = currentCandidateIds(r, new Map(), null);
              const canSign = meId !== null && r.employee_id !== meId && candidates.includes(meId);
              return (
                <li key={r.id} className="rounded-lg border border-gray-100 p-2">
                  <p className="font-medium text-gray-800">
                    {KIND_LABEL[r.kind] ?? r.kind}　<span className="text-xs font-normal text-gray-500">{fmtRange(r.start_at, r.end_at)}</span>
                  </p>
                  {r.reason && <p className="mt-0.5 break-words text-xs text-gray-500">{r.reason}</p>}
                  {canSign ? (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" onClick={() => decide(r, "approve")} disabled={busy}>
                        核准
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => decide(r, "reject")} disabled={busy}>
                        駁回
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">
                      目前簽核人：{(r.current_approver_names ?? []).join("／") || "—"}
                      <Link href="/admin/approvals" className="ml-2 font-medium hover:underline" style={{ color: "var(--brand)" }}>
                        到簽核頁 →
                      </Link>
                    </p>
                  )}
                </li>
              );
            })}
            {requests.length === 0 && <li className="text-xs text-gray-400">清單已更新，沒有待簽申請</li>}
          </ul>
        )}
        {row.pendingRequests.total > 0 && <p className="mt-1 text-xs text-amber-700">提醒（不擋鎖定）：鎖定後在重新開放前無法核准、駁回或撤回。</p>}
      </Section>

      <Section title="出勤月表" tone={sheetTone}>
        {row.sheet ? (
          <SheetReviewBar
            key={`${employeeId}-${period}`}
            sheetId={row.sheet.id}
            onChanged={onChanged}
            onPrintSheet={() => window.open(`/admin/attendance-statements?employee=${employeeId}&period=${period}`, "_blank")}
          />
        ) : (
          <p className="text-xs text-gray-400">本月非在職、沒有月表</p>
        )}
      </Section>

      <Section title={`遲到說明（未決定 ${row.undecidedLateReports}）`} tone={row.undecidedLateReports > 0 ? "warn" : "ok"}>
        {row.undecidedLateReports === 0 ? (
          <p className="text-xs text-gray-400">沒有未決定的遲到說明</p>
        ) : !late ? (
          <p className="text-xs text-gray-400">載入中…</p>
        ) : (
          <ul className="space-y-2">
            {late.reports.map((r) => (
              <li key={r.id} className="rounded-lg border border-gray-100 p-2">
                <p className="text-xs text-gray-700">
                  {r.workDate}　遲到 {r.lateMinutes} 分：<span className="break-words">{r.reason}</span>
                </p>
                <div className="mt-1">
                  <LateDecisionStatus report={r} />
                </div>
                {late.canDecide && (
                  <div className="mt-2">
                    <LateDecisionControls report={r} decider={decider} />
                  </div>
                )}
              </li>
            ))}
            {!late.canDecide && <li className="text-xs text-gray-500">只有老闆能決定遲到說明；未決定視為影響全勤（不擋鎖定）。</li>}
          </ul>
        )}
      </Section>

      <Section title="假單核銷／報銷" tone={row.unsettledLeaves > 0 || row.submittedExpenses.count > 0 ? "bad" : "ok"}>
        {row.unsettledLeaves > 0 && (
          <div className="mb-2">
            <p className="text-xs text-gray-700">已核准、尚未核銷的假單 {row.unsettledLeaves} 張：</p>
            {leaves === null ? (
              <p className="text-xs text-gray-400">載入中…</p>
            ) : (
              <>
                <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                  {leaves.map((l) => (
                    <li key={l.id}>
                      {l.leaveType.name} {l.startDate === l.endDate ? l.startDate : `${l.startDate}～${l.endDate}`}（{l.hours} 小時）
                      {l.requiresAttachment && l.attachmentCount === 0 && <span className="ml-1 text-amber-700">缺附件</span>}
                    </li>
                  ))}
                </ul>
                {leaves.length > 0 ? (
                  <Button
                    size="sm"
                    className="mt-2"
                    disabled={busy}
                    onClick={() =>
                      void act("核銷", async () => {
                        try {
                          const res = await settleLeaveRequests(period, leaves.map((l) => l.id));
                          return `已核銷 ${res.settled} 張` + (res.skipped.length > 0 ? `；${summarizeSkipped(res.skipped)}` : "");
                        } catch (err) {
                          throw new Error(friendlySettlementError(err, "核銷失敗"));
                        }
                      })
                    }
                  >
                    核銷這 {leaves.length} 張
                  </Button>
                ) : (
                  <Link href={`/admin/leave-settlement?period=${period}`} className="text-xs font-medium hover:underline" style={{ color: "var(--brand)" }}>
                    到假單核銷頁處理 →
                  </Link>
                )}
              </>
            )}
          </div>
        )}
        {row.submittedExpenses.count > 0 && (
          <p className="text-xs text-gray-700">
            {row.submittedExpenses.count} 筆報銷（{money(row.submittedExpenses.amount)} 元）尚未月結
            <Link href={`/admin/expenses?period=${period}`} className="ml-2 font-medium hover:underline" style={{ color: "var(--brand)" }}>
              到費用與給付月結 →
            </Link>
          </p>
        )}
        {row.openAdvances > 0 && (
          <p className="mt-1 text-xs text-gray-500">
            參考：{row.openAdvances} 筆預支尚未沖銷（不擋鎖定）
            <Link href="/admin/expenses?section=advances" className="ml-2 font-medium hover:underline" style={{ color: "var(--brand)" }}>
              查看 →
            </Link>
          </p>
        )}
        {row.unsettledLeaves === 0 && row.submittedExpenses.count === 0 && row.openAdvances === 0 && <p className="text-xs text-gray-400">沒有待處理項目</p>}
      </Section>

      <Section title="薪資單" tone={payslipTone}>
        {!payslip ? (
          <p className="text-xs text-gray-500">{row.payslip.required ? "尚未產生薪資單：按「重算此人」或上方「執行薪資（全部）」。" : "這位不需要薪資單（沒有薪資結構或本月非在職）。"}</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Pill tone={payslip.status === "finalized" ? "green" : "amber"}>{payslip.status === "finalized" ? "已定案" : "草稿"}</Pill>
              {payslip.status !== "finalized" && payslip.fixed_allowances_stale && <Pill tone="red">固定津貼有異動，需重算</Pill>}
              {payslip.status !== "finalized" && payslip.pension_settings_stale && <Pill tone="red">勞退設定有異動，需重算</Pill>}
              <span className="text-xs text-gray-500">{payslip.sent_at ? `已寄送 ${fmtSentAt(payslip.sent_at)}` : "未寄送"}</span>
            </div>
            {b && (
              <dl className="mb-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-slate-50 p-2">
                  <dt className="text-[11px] text-slate-500">應發</dt>
                  <dd className="font-semibold text-slate-900">{money(n(payslip.gross))}</dd>
                </div>
                <div className="rounded-lg bg-rose-50 p-2">
                  <dt className="text-[11px] text-rose-600">應扣</dt>
                  <dd className="font-semibold text-rose-700">{money(n(b.totalDeductions))}</dd>
                </div>
                <div className="rounded-lg bg-emerald-50 p-2">
                  <dt className="text-[11px] text-emerald-600">實發</dt>
                  <dd className="font-semibold text-emerald-700">{money(netOf(payslip))}</dd>
                </div>
              </dl>
            )}
            {b && (
              <details className="mb-2 rounded-lg bg-gray-50/60 p-2">
                <summary className="cursor-pointer text-xs font-medium text-gray-600">逐項明細</summary>
                <div className="mt-2">
                  <PayslipDetailGrid b={b} />
                </div>
              </details>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {payslip?.status !== "finalized" && (
            <Button size="sm" variant="secondary" onClick={() => void rerun()} disabled={busy || locked} data-testid="payroll-rerun-one">
              重算此人
            </Button>
          )}
          {payslip && payslip.status !== "finalized" && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act("定案", async () => {
                  try {
                    await finalizePayslip(payslip.id);
                  } catch (err) {
                    // 例：409 adjustments_stale／fixed_allowances_stale——顯示 API 的中文說明。
                    throw new Error(apiErrorMessage(err, "定案失敗"));
                  }
                  return "已定案";
                })
              }
              data-testid="payroll-finalize-one"
            >
              定案
            </Button>
          )}
          {payslip && (
            <Button size="sm" variant="secondary" onClick={() => printPayslip(payslip, empName(employeeId))}>
              列印
            </Button>
          )}
          {payslip?.status === "finalized" && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void act("寄送", async () => {
                  try {
                    await sendPayslip(payslip.id);
                  } catch (err) {
                    const msg = apiErrorMessage(err, "寄送失敗");
                    throw new Error(msg === "寄送失敗" ? msg : `寄送失敗：${msg}`);
                  }
                  return "已寄送";
                })
              }
            >
              {payslip.sent_at ? "重寄" : "寄送"}
            </Button>
          )}
        </div>
      </Section>
    </div>
  );
}
