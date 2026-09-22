"use client";

import { useCallback, useEffect, useState } from "react";
import {
  approveRequest,
  getPendingApprovals,
  getRequestAttachments,
  rejectRequest,
  type PendingApproval,
  type RequestKind,
} from "@/lib/ess-api";
import { invalidateEssState } from "@/lib/ess-state";
import { fmtDateTime, fmtHours, fmtMoney, relativeTime } from "@/lib/ess-format";
import { summarizeSegments } from "@/lib/ess-notifications";
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  Field,
  Icon,
  InlineError,
  Input,
  Pill,
  SectionTitle,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ess-ui";

type RequestAttachment = { id: string; fileName: string; sizeBytes: number; contentType: string; url: string };

/**
 * /ess/approvals — 主管（或任何被指派為簽核者的人）的「待我簽核」頁。
 *
 * 只列 GET /requests/pending-approvals 回的單（輪到我簽的 pending 單）。一屏一張卡：
 * 核准一步（意見選填、預設收起）、駁回開底部面板填理由（必填）。做完決定 Toast 回饋
 * ＋ `invalidateEssState()` 讓底列徽章立刻減 1。頁框（頂部列／底列／gate）由
 * ess/layout.tsx 提供，這裡只負責內容。
 */

const KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  ot: "加班",
  fix_punch: "補卡",
  business_trip: "公出/出差",
  petty_cash: "零用金預支",
  wfh: "在家工作",
};

const PAYOUT_LABEL: Record<"pay" | "comp_time", string> = {
  pay: "加班費",
  comp_time: "補休",
};

/** 把 API 的錯誤碼翻成主管看得懂的話；其他照原文。 */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("attachment_required")) return "此假別需要附件，申請人尚未上傳，無法核准（可駁回請其補件）。";
  if (msg.includes("not_current_approver")) return "這張單目前不是輪到你簽核。";
  if (msg.includes("not_pending")) return "這張單已被處理過，請重新整理。";
  if (msg.includes("not_found")) return "找不到這張單，可能已被註銷。";
  return msg || "處理失敗";
}

function kindLabel(kind: RequestKind): string {
  return KIND_LABEL[kind] ?? kind;
}

function applicantName(row: PendingApproval): string {
  return row.employee_name ?? row.employee_id.slice(0, 8);
}

/** 期間文字：有分段用 summarizeSegments（≤3 段逐行、>3 段壓縮），否則起訖＋時數。 */
function periodText(row: PendingApproval): string {
  const segs = summarizeSegments(row.segments);
  if (segs) return segs;
  const hours = row.hours != null ? ` · ${fmtHours(row.hours)}` : "";
  return `${fmtDateTime(row.start_at)} ～ ${fmtDateTime(row.end_at)}${hours}`;
}

export default function ApprovalsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 核准意見（選填）：預設收起，「加註意見」才展開單行輸入
  const [commentOpenId, setCommentOpenId] = useState<string | null>(null);
  const [approveComment, setApproveComment] = useState<Record<string, string>>({});
  // 駁回：底部面板開在哪張單 + 理由（必填）
  const [rejecting, setRejecting] = useState<PendingApproval | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  // 附件清單：展開哪一張單 + 各單已抓到的附件（用 id 當 key 快取，避免重複打 API）
  const [expandedAttachmentsId, setExpandedAttachmentsId] = useState<string | null>(null);
  const [attachmentsById, setAttachmentsById] = useState<Record<string, RequestAttachment[]>>({});
  const [attachmentsLoadingId, setAttachmentsLoadingId] = useState<string | null>(null);
  const [attachmentsError, setAttachmentsError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await getPendingApprovals();
    setRows(res.requests);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await load();
        if (active) setError(null);
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

  /** 決定做完：徽章重抓＋列表重抓（列表失敗只顯示錯誤，不影響已成功的決定）。 */
  async function afterDecision() {
    invalidateEssState();
    try {
      await load();
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  async function retry() {
    setLoading(true);
    setError(null);
    try {
      await load();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  async function onApprove(row: PendingApproval) {
    setBusyId(row.id);
    setError(null);
    try {
      const comment = (approveComment[row.id] ?? "").trim();
      const res = await approveRequest(row.id, comment || undefined);
      toast.show(
        res.status === "approved" ? `已核准，已通知 ${applicantName(row)}` : `已送往第 ${res.currentStep} 關`,
        "success",
      );
      setCommentOpenId((cur) => (cur === row.id ? null : cur));
      await afterDecision();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  function openReject(row: PendingApproval) {
    setRejecting(row);
    setRejectReason("");
    setRejectError(null);
    setError(null);
  }

  function closeReject() {
    if (busyId) return;
    setRejecting(null);
    setRejectReason("");
    setRejectError(null);
  }

  async function onConfirmReject() {
    const row = rejecting;
    if (!row) return;
    const reason = rejectReason.trim();
    if (!reason) {
      setRejectError("駁回必須填寫理由，申請人會在通知裡看到。");
      return;
    }
    setBusyId(row.id);
    setRejectError(null);
    try {
      await rejectRequest(row.id, reason);
      toast.show(`已駁回，已通知 ${applicantName(row)}`, "success");
      setRejecting(null);
      setRejectReason("");
      await afterDecision();
    } catch (err) {
      setRejectError(friendlyError(err));
    } finally {
      setBusyId(null);
    }
  }

  /** 展開/收合附件清單；展開時才現拉 signed URL，並用 attachmentsById 快取。 */
  async function toggleAttachments(row: PendingApproval) {
    if (expandedAttachmentsId === row.id) {
      setExpandedAttachmentsId(null);
      return;
    }
    setExpandedAttachmentsId(row.id);
    if (attachmentsById[row.id]) return;
    setAttachmentsLoadingId(row.id);
    try {
      const res = await getRequestAttachments(row.id);
      setAttachmentsById((prev) => ({ ...prev, [row.id]: res.attachments }));
      setAttachmentsError((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } catch (err) {
      setAttachmentsError((prev) => ({
        ...prev,
        [row.id]: err instanceof Error ? err.message : "載入附件失敗",
      }));
    } finally {
      setAttachmentsLoadingId((cur) => (cur === row.id ? null : cur));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <SectionTitle>待我簽核</SectionTitle>
        {!loading && rows.length > 0 && <span className="text-xs text-gray-400">{rows.length} 張</span>}
      </div>

      {error && (
        <Card>
          <InlineError>{error}</InlineError>
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => void retry()} disabled={loading}>
            重新整理
          </Button>
        </Card>
      )}

      {loading ? (
        <Card>
          <Skeleton lines={5} />
        </Card>
      ) : rows.length === 0 ? (
        !error && (
          <Card>
            <EmptyState title="目前沒有待你簽核的單" hint="有同仁送單給你時會收到通知。" />
          </Card>
        )
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const busy = busyId === row.id;
            const commentOpen = commentOpenId === row.id;
            const attachmentCount = row.attachment_count;
            const attachmentsOpen = expandedAttachmentsId === row.id;
            const reason = row.reason?.trim();
            const advance = row.advance_requested != null ? Number(row.advance_requested) : 0;
            return (
              <li key={row.id}>
                <Card>
                  {/* 頭：申請人·部門｜種類＋假別｜相對時間 */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold text-gray-900">
                        {applicantName(row)}
                        {row.department_name && (
                          <span className="font-normal text-gray-500"> · {row.department_name}</span>
                        )}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Pill tone="brand">{kindLabel(row.kind)}</Pill>
                        {row.leave_type_name && <Pill tone="blue">{row.leave_type_name}</Pill>}
                        {row.kind === "ot" && row.payout && <Pill tone="gray">{PAYOUT_LABEL[row.payout]}</Pill>}
                        {row.total_steps > 1 && (
                          <Pill tone="amber">
                            第 {row.current_step}／{row.total_steps} 關
                          </Pill>
                        )}
                      </div>
                    </div>
                    <time dateTime={row.created_at} className="shrink-0 pt-0.5 text-xs text-gray-400">
                      {relativeTime(row.created_at)}
                    </time>
                  </div>

                  {/* 身：期間、事由、地點／預支（有才顯示）、附件 */}
                  <dl className="mt-3 grid grid-cols-[3.25rem_1fr] gap-x-2 gap-y-1.5 text-sm text-gray-700">
                    <dt className="text-gray-400">期間</dt>
                    <dd className="whitespace-pre-line">{periodText(row)}</dd>
                    <dt className="text-gray-400">事由</dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {reason ? reason : <span className="text-gray-400">（未填）</span>}
                    </dd>
                    {row.location && (
                      <>
                        <dt className="text-gray-400">地點</dt>
                        <dd className="break-words">{row.location}</dd>
                      </>
                    )}
                    {advance > 0 && (
                      <>
                        <dt className="text-gray-400">預支</dt>
                        <dd>{fmtMoney(advance)}</dd>
                      </>
                    )}
                    {row.remark && (
                      <>
                        <dt className="text-gray-400">備註</dt>
                        <dd className="whitespace-pre-wrap break-words">{row.remark}</dd>
                      </>
                    )}
                    {attachmentCount > 0 && (
                      <>
                        <dt className="text-gray-400">附件</dt>
                        <dd>
                          <button
                            type="button"
                            onClick={() => void toggleAttachments(row)}
                            aria-expanded={attachmentsOpen}
                            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                            style={{ color: "var(--brand)" }}
                          >
                            <Icon name="paperclip" className="h-4 w-4" />
                            附件 {attachmentCount} · {attachmentsOpen ? "收合" : "查看"}
                          </button>
                          {attachmentsOpen && (
                            <div className="mt-1">
                              {attachmentsLoadingId === row.id ? (
                                <p className="text-xs text-gray-400">載入中…</p>
                              ) : attachmentsError[row.id] ? (
                                <InlineError className="text-xs">{attachmentsError[row.id]}</InlineError>
                              ) : (
                                <ul className="space-y-1">
                                  {(attachmentsById[row.id] ?? []).map((att) => (
                                    <li key={att.id}>
                                      <a
                                        href={att.url ?? "#"}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="break-all underline underline-offset-2"
                                        style={{ color: "var(--brand)" }}
                                      >
                                        {att.fileName}
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </dd>
                      </>
                    )}
                  </dl>

                  {/* 動作：核准一步＋駁回（開面板）；「加註意見」展開單行輸入 */}
                  {commentOpen && (
                    <div className="mt-3">
                      <Input
                        value={approveComment[row.id] ?? ""}
                        onChange={(e) => setApproveComment((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        placeholder="簽核意見（選填，申請人看得到）"
                        aria-label="簽核意見"
                        maxLength={250}
                        autoFocus
                      />
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Button variant="primary" className="flex-1" loading={busy} onClick={() => void onApprove(row)}>
                      核准
                    </Button>
                    <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => openReject(row)}>
                      駁回
                    </Button>
                  </div>
                  {!commentOpen && (
                    <button
                      type="button"
                      onClick={() => setCommentOpenId(row.id)}
                      disabled={busy}
                      className="mt-2 text-sm text-gray-500 underline underline-offset-2 disabled:opacity-50"
                    >
                      加註意見
                    </button>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <BottomSheet open={rejecting !== null} onClose={closeReject} title="駁回這張單">
        {rejecting && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {applicantName(rejecting)} 的{kindLabel(rejecting.kind)}
              {rejecting.leave_type_name ? `（${rejecting.leave_type_name}）` : ""}申請
            </p>
            <Field
              label="駁回理由"
              required
              htmlFor="reject-reason"
              hint="申請人會在通知裡看到這段話。"
              error={rejectError ?? undefined}
            >
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => {
                  setRejectReason(e.target.value);
                  if (rejectError) setRejectError(null);
                }}
                placeholder="例：當日人力不足，請改期"
                maxLength={250}
                aria-invalid={rejectError ? "true" : undefined}
              />
            </Field>
            <Button
              variant="danger"
              block
              size="lg"
              loading={busyId === rejecting.id}
              disabled={!rejectReason.trim()}
              onClick={() => void onConfirmReject()}
            >
              確認駁回
            </Button>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}
