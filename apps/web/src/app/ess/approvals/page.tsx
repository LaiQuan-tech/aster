"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { EssHeader, invalidateEssHeaderState } from "@/components/EssHeader";
import {
  approveRequest,
  getBranding,
  getMe,
  getPendingApprovals,
  isAdminRole,
  rejectRequest,
  type Branding,
  type PendingApproval,
  type RequestKind,
} from "@/lib/ess-api";

/**
 * /ess/approvals — 主管（或任何被指派為簽核者的人）的「待我簽核」頁。
 *
 * 只列 GET /requests/pending-approvals 回的單（輪到我簽的 pending 單）；核准一鍵、
 * 駁回必填理由。HR 走後台 /admin/approvals 批次處理，這頁給沒有後台權限的
 * 直屬主管／老闆用，手機優先（客戶主管多半在手機上按）。
 */

const KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  ot: "加班",
  fix_punch: "補卡",
  business_trip: "公出/出差",
  petty_cash: "零用金預支",
};

const PAYOUT_LABEL: Record<"pay" | "comp_time", string> = {
  pay: "加班費",
  comp_time: "補休",
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-TW", { month: "2-digit", day: "2-digit" });
}

/** 把 API 的錯誤碼翻成主管看得懂的話；其他照原文。 */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("attachment_required")) return "此假別需要附件，申請人尚未上傳，無法核准（可駁回請其補件）。";
  if (msg.includes("not_current_approver")) return "這張單目前不是輪到你簽核。";
  if (msg.includes("not_pending")) return "這張單已被處理過，請重新整理。";
  if (msg.includes("not_found")) return "找不到這張單，可能已被註銷。";
  return msg || "處理失敗";
}

function ApprovalsView() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [rows, setRows] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 駁回：展開理由框的那張單 + 理由；核准意見（選填）
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [approveComment, setApproveComment] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await getPendingApprovals();
    setRows(res.requests);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const [brandRes, meRes] = await Promise.allSettled([getBranding(), getMe()]);
      if (!active) return;
      if (brandRes.status === "fulfilled") setBranding(brandRes.value.branding);
      if (meRes.status === "fulfilled") setIsAdmin(isAdminRole(meRes.value.role));
      try {
        await load();
      } catch (err) {
        if (active) setError(friendlyError(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function refresh() {
    invalidateEssHeaderState();
    try {
      await load();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function onApprove(row: PendingApproval) {
    setBusyId(row.id);
    setError(null);
    setMessage(null);
    try {
      const comment = (approveComment[row.id] ?? "").trim();
      const res = await approveRequest(row.id, comment || undefined);
      setMessage(
        res.status === "approved"
          ? `已核准 ${row.employee_name ?? "同仁"} 的${KIND_LABEL[row.kind] ?? row.kind}申請，系統已通知申請人。`
          : `已簽核，單子已送往第 ${res.currentStep} 關。`,
      );
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(row: PendingApproval) {
    const reason = rejectReason.trim();
    if (!reason) {
      setError("駁回必須填寫理由，申請人會在通知裡看到。");
      return;
    }
    setBusyId(row.id);
    setError(null);
    setMessage(null);
    try {
      await rejectRequest(row.id, reason);
      setMessage(`已駁回 ${row.employee_name ?? "同仁"} 的${KIND_LABEL[row.kind] ?? row.kind}申請，系統已通知申請人。`);
      setRejectingId(null);
      setRejectReason("");
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  function applicantLine(row: PendingApproval): string {
    const parts = [row.employee_name ?? row.employee_id.slice(0, 8)];
    if (row.employee_emp_no) parts.push(row.employee_emp_no);
    if (row.department_name) parts.push(row.department_name);
    return parts.join(" · ");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader
        appName={branding?.appName}
        primaryColor={branding?.primaryColor}
        active="approvals"
        isAdmin={isAdmin}
      />
      <main className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-800">待我簽核</h2>
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-sm text-gray-500 hover:underline"
              disabled={loading}
            >
              重新整理
            </button>
          </div>
          <p className="mb-4 text-xs text-gray-400">
            這裡只列輪到你簽的單。核准後單子會送往下一關或直接生效；駁回要填理由，申請人會收到通知。
          </p>

          {message && (
            <p className="mb-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700" role="status">
              {message}
            </p>
          )}
          {error && (
            <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          {loading ? (
            <p className="py-6 text-center text-sm text-gray-400">載入中…</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">目前沒有待你簽核的單。</p>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => {
                const busy = busyId === row.id;
                const rejecting = rejectingId === row.id;
                return (
                  <li key={row.id} className="rounded-xl border border-gray-200 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
                        style={{ backgroundColor: "var(--brand)" }}
                      >
                        {KIND_LABEL[row.kind] ?? row.kind}
                      </span>
                      {row.leave_type_name && (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{row.leave_type_name}</span>
                      )}
                      {row.kind === "ot" && row.payout && (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{PAYOUT_LABEL[row.payout]}</span>
                      )}
                      {row.total_steps > 1 && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                          第 {row.current_step} 關／共 {row.total_steps} 關
                        </span>
                      )}
                      <span className="ml-auto text-xs text-gray-400">送出 {fmt(row.created_at)}</span>
                    </div>

                    <p className="mt-2 text-base font-medium text-gray-900">{applicantLine(row)}</p>

                    <dl className="mt-2 grid grid-cols-[4.5rem_1fr] gap-y-1 text-sm text-gray-700">
                      <dt className="text-gray-400">期間</dt>
                      <dd>
                        {row.segments && row.segments.length > 0 ? (
                          <ul className="space-y-0.5">
                            {row.segments.map((seg, i) => (
                              <li key={i}>
                                {seg.date} {seg.startTime}–{seg.endTime}（{seg.hours} 小時）
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <>
                            {fmt(row.start_at)} ～ {fmt(row.end_at)}
                            {row.hours != null && <span className="text-gray-500">（{row.hours} 小時）</span>}
                          </>
                        )}
                      </dd>
                      {row.location && (
                        <>
                          <dt className="text-gray-400">地點</dt>
                          <dd>{row.location}</dd>
                        </>
                      )}
                      {row.advance_requested != null && Number(row.advance_requested) > 0 && (
                        <>
                          <dt className="text-gray-400">預支</dt>
                          <dd>NT$ {Number(row.advance_requested).toLocaleString("zh-TW")}</dd>
                        </>
                      )}
                      <dt className="text-gray-400">事由</dt>
                      <dd className="whitespace-pre-wrap">{row.reason?.trim() ? row.reason : <span className="text-gray-400">（未填）</span>}</dd>
                      {row.remark && (
                        <>
                          <dt className="text-gray-400">備註</dt>
                          <dd className="whitespace-pre-wrap">{row.remark}</dd>
                        </>
                      )}
                      <dt className="text-gray-400">附件</dt>
                      <dd>{row.attachment_count > 0 ? `${row.attachment_count} 個檔案` : <span className="text-gray-400">無</span>}</dd>
                    </dl>

                    {rejecting ? (
                      <div className="mt-3 space-y-2 rounded-lg bg-red-50 p-3">
                        <label className="block text-sm font-medium text-red-700" htmlFor={`reject-${row.id}`}>
                          駁回理由（必填，申請人會看到）
                        </label>
                        <textarea
                          id={`reject-${row.id}`}
                          className="w-full rounded-md border border-red-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                          rows={2}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="例：當日人力不足，請改期"
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => onReject(row)}
                            disabled={busy || !rejectReason.trim()}
                            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                          >
                            {busy ? "處理中…" : "確認駁回"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRejectingId(null);
                              setRejectReason("");
                            }}
                            disabled={busy}
                            className="rounded-md px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <input
                          className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
                          value={approveComment[row.id] ?? ""}
                          onChange={(e) => setApproveComment((prev) => ({ ...prev, [row.id]: e.target.value }))}
                          placeholder="簽核意見（選填）"
                          aria-label="簽核意見"
                        />
                        <button
                          type="button"
                          onClick={() => onApprove(row)}
                          disabled={busy}
                          className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                          style={{ backgroundColor: "var(--brand)" }}
                        >
                          {busy ? "處理中…" : "核准"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingId(row.id);
                            setRejectReason("");
                            setError(null);
                          }}
                          disabled={busy}
                          className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          駁回
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <AuthGate>
      <ApprovalsView />
    </AuthGate>
  );
}
