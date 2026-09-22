"use client";

/**
 * 「我的申請」清單（`GET /requests?scope=mine`）：每列三行（種類＋假別名｜狀態 Pill、期間摘要、
 * 等誰簽／駁回理由／核准時間）＋附件數＋「缺憑證」＋「上傳憑證」＋ pending「撤回」（ConfirmDialog）。
 * 頂部 chips 全部｜待簽核｜已核准｜已駁回（前端過濾）；預設 30 筆＋「顯示更多」；`?id=` 高亮並捲到。
 * API 新欄位（leave_type_name／current_approver_name／attachment_count…）缺席時各行優雅退化。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Button, Card, ConfirmDialog, EmptyState, Icon, InlineError, Pill, Segmented, Skeleton, useToast } from "@/components/ess-ui";
import { cancelRequest, uploadAttachment, type LeaveRequest } from "@/lib/ess-api";
import { invalidateEssState } from "@/lib/ess-state";
import type { ShiftLike } from "@/lib/leave-hours";
import {
  BEYOND_CAP_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  approvalLine,
  describeRequest,
  needsAttachment,
  requestTitle,
} from "@/lib/request-forms";
import { MAX_FILE_BYTES, describeError } from "./form-shared";

type Filter = "all" | "pending" | "approved" | "rejected";

const FILTER_OPTIONS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待簽核" },
  { value: "approved", label: "已核准" },
  { value: "rejected", label: "已駁回" },
];

const PAGE_SIZE = 30;

export interface MyRequestsProps {
  requests: LeaveRequest[];
  loading: boolean;
  error: string | null;
  /** `?id=`：高亮並捲到該列。 */
  highlightId: string | null;
  /** 判斷「全天／上午／下午」文案用的班別。 */
  defaultShift: ShiftLike;
  onReload: () => Promise<void>;
}

export function MyRequests({ requests, loading, error, highlightId, defaultShift, onReload }: MyRequestsProps) {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [cancelTarget, setCancelTarget] = useState<LeaveRequest | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const scrolledRef = useRef<string | null>(null);

  const filtered = useMemo(
    () => (filter === "all" ? requests : requests.filter((r) => r.status === filter)),
    [requests, filter],
  );

  // ?id= 高亮：確保在可見範圍內（超過 limit 就展開到它），並捲到該列（只做一次）。
  useEffect(() => {
    if (!highlightId || loading) return;
    const idx = filtered.findIndex((r) => r.id === highlightId);
    if (idx < 0) return;
    if (idx >= limit) {
      setLimit(idx + 1);
      return;
    }
    if (scrolledRef.current === highlightId) return;
    scrolledRef.current = highlightId;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`req-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlightId, filtered, limit, loading]);

  const visible = filtered.slice(0, limit);
  const hidden = Math.max(0, filtered.length - visible.length);

  function pickFile(requestId: string) {
    uploadTargetRef.current = requestId;
    fileInputRef.current?.click();
  }

  async function onFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const requestId = uploadTargetRef.current;
    uploadTargetRef.current = null;
    if (!file || !requestId) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.show("附件單檔限 3 MB", "error");
      return;
    }
    setActionError(null);
    setUploadingId(requestId);
    try {
      await uploadAttachment(requestId, file);
      toast.show("已上傳憑證", "success");
      await onReload();
    } catch (err) {
      setActionError(describeError(err, "上傳憑證失敗"));
    } finally {
      setUploadingId(null);
    }
  }

  async function confirmCancel() {
    if (!cancelTarget) return;
    setActionError(null);
    setCancelling(true);
    try {
      await cancelRequest(cancelTarget.id);
      toast.show("已撤回", "success");
      setCancelTarget(null);
      invalidateEssState();
      await onReload();
    } catch (err) {
      setActionError(describeError(err, "撤回失敗"));
      setCancelTarget(null);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Card title="我的申請">
      <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="sr-only" onChange={onFilePicked} />

      <Segmented<Filter>
        aria-label="篩選狀態"
        size="sm"
        options={FILTER_OPTIONS}
        value={filter}
        onChange={(next) => {
          setFilter(next);
          setLimit(PAGE_SIZE);
        }}
        className="mb-3"
      />

      <InlineError className="mb-3">{error ?? actionError}</InlineError>

      {loading && requests.length === 0 ? (
        <Skeleton lines={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={filter === "all" ? "還沒有申請紀錄" : `沒有${FILTER_OPTIONS.find((o) => o.value === filter)?.label ?? ""}的申請`}
          hint={filter === "all" ? "送出的請假、補卡、加班等申請會列在這裡" : undefined}
        />
      ) : (
        <ul className="divide-y divide-gray-100">
          {visible.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              highlighted={r.id === highlightId}
              defaultShift={defaultShift}
              uploading={uploadingId === r.id}
              onUpload={() => pickFile(r.id)}
              onCancel={() => setCancelTarget(r)}
            />
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <div className="mt-3">
          <Button variant="secondary" block onClick={() => setLimit((l) => l + PAGE_SIZE)}>
            顯示更多（還有 {hidden} 筆）
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={cancelTarget !== null}
        title="撤回這張申請？"
        message={cancelTarget ? `${requestTitle(cancelTarget)}\n${describeRequest(cancelTarget, { shift: defaultShift })}\n\n撤回後簽核者不會再看到這張單；需要的話可以再填一張新的。` : undefined}
        confirmLabel="撤回"
        danger
        busy={cancelling}
        onConfirm={confirmCancel}
        onCancel={() => (cancelling ? undefined : setCancelTarget(null))}
      />
    </Card>
  );
}

function RequestRow({
  request: r,
  highlighted,
  defaultShift,
  uploading,
  onUpload,
  onCancel,
}: {
  request: LeaveRequest;
  highlighted: boolean;
  defaultShift: ShiftLike;
  uploading: boolean;
  onUpload: () => void;
  onCancel: () => void;
}) {
  const line = approvalLine(r);
  const missing = needsAttachment(r);
  const attachments = typeof r.attachment_count === "number" ? r.attachment_count : null;
  const showFooter = (attachments != null && attachments > 0) || missing || r.status === "pending";

  return (
    <li
      id={`req-${r.id}`}
      className={`py-3 first:pt-0 last:pb-0 ${highlighted ? "-mx-2 rounded-xl px-2 ring-2 ring-[var(--brand)] ring-offset-2" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-medium text-gray-800">{requestTitle(r)}</p>
        <Pill tone={STATUS_TONE[r.status] ?? "gray"}>{STATUS_LABEL[r.status] ?? r.status}</Pill>
      </div>
      <p className="mt-0.5 text-sm text-gray-600">{describeRequest(r, { shift: defaultShift })}</p>
      {/* M1：送單時就標記的月加班上限旗標（只標不擋；超額部分由公司另行給付） */}
      {r.beyond_cap === true && (
        <p className="mt-1">
          <Pill tone="amber">{BEYOND_CAP_LABEL}</Pill>
        </p>
      )}
      {line && <p className={`mt-0.5 text-sm ${r.status === "rejected" ? "text-red-600" : "text-gray-500"}`}>{line}</p>}
      {showFooter && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {attachments != null && attachments > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-gray-500">
              <Icon name="paperclip" className="h-3.5 w-3.5" />
              附件 {attachments}
            </span>
          )}
          {missing && <Pill tone="red">缺憑證</Pill>}
          {missing && (
            <Button size="sm" variant="secondary" onClick={onUpload} loading={uploading}>
              上傳憑證
            </Button>
          )}
          {r.status === "pending" && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto hover:bg-red-50"
              style={{ color: "var(--color-red-600, #dc2626)" }}
              onClick={onCancel}
            >
              撤回
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
