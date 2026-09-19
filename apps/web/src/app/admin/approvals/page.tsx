"use client";

/**
 * 簽核 `/admin/approvals?status=pending|in_progress|approved|rejected|all`
 *
 * 2026-09 後台簡化 WP2：原「待審核表單」（/admin/approvals）＋「表單紀錄管理」（/admin/form-records，
 * 現 307 → `?status=all`）合併成一頁，用 Segmented 切換狀態，URL 是唯一真相。
 *
 * 取資料：pending／in_progress 都抓 `GET /requests?status=pending` 同一份再依簽核者切桶
 * （`bucketOf`：簽核者是我＝待簽核、是別人＝簽核中）；approved／rejected 各抓自己的；all 不帶 status。
 * 篩選列＝兩頁聯集（表單類型｜單位｜工號/姓名｜起迄日｜關鍵字｜搜尋｜匯出 CSV），單位與關鍵字在 client 端。
 * 各桶列操作（`actionsFor`）：待簽核＝核准／駁回／變更簽核人／註銷；簽核中＝催簽／代理簽核（confirm）／
 * 變更簽核人／註銷；已核准＝註銷 disabled；已駁回／已取消＝註銷；附件每桶都有（展開才抓、依 id 快取）。
 * 批次列（簽核意見＋批次核准／駁回）只在 pending／in_progress；統計方塊只在 all。
 * 決策成功 → toast＋`invalidateEssState()`（側欄待簽徽章）＋重抓；錯誤 InlineError。
 * 純函式（解析／分桶／篩選／統計／CSV／操作表）在 `@/lib/approval-view`，有單元測試。
 * 頁框（標題「簽核」／分頁列／Toast）由 admin/layout 的 AdminShell 提供，本檔只回內容。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BottomSheet,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  InlineError,
  Input,
  Pill,
  Segmented,
  Select,
  Skeleton,
  Textarea,
  labelCls,
  useToast,
  type PillTone,
} from "@/components/admin-ui";
import {
  approveRequest,
  batchDecideRequests,
  changeRequestApprover,
  deleteRequest,
  getApprovalFlows,
  getDepartments,
  getEmployees,
  getRequestAttachments,
  getRequests,
  rejectRequest,
  remindRequest,
  type ApprovalFlow,
  type Department,
  type Employee,
  type LeaveRequest,
  type RequestKind,
} from "@/lib/admin-api";
import { getMeCached, invalidateEssState } from "@/lib/ess-state";
import {
  BUCKET_LABEL,
  KIND_LABEL,
  KIND_OPTIONS,
  actionsFor,
  applyClientFilters,
  bucketOf,
  buildApprovalLookup,
  contentLines,
  csvFileName,
  csvMatrix,
  csvText,
  employeeLabel,
  hasBatchRow,
  parseApprovalView,
  pendingCounts,
  rowsForView,
  statsOf,
  statusParamFor,
  viewOptions,
  type ApprovalBucket,
  type ApprovalView,
  type BucketContext,
} from "@/lib/approval-view";

type RequestAttachment = { id: string; fileName: string; sizeBytes: number; contentType: string; url: string };

const BUCKET_TONE: Record<ApprovalBucket, PillTone> = {
  pending_mine: "amber",
  in_progress: "blue",
  approved: "green",
  rejected: "red",
  cancelled: "gray",
};

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function dateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function downloadCsv(text: string, fileName: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

const ROW_BUTTON = "rounded-md px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";

function ApprovalsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view: ApprovalView = parseApprovalView(searchParams.get("status"));
  const statusParam = statusParamFor(view);
  const batchRow = hasBatchRow(view);
  const toast = useToast();

  // 參考資料：mount 抓一次（登入者 id、員工、單位、簽核流程）
  const [meId, setMeId] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [flows, setFlows] = useState<ApprovalFlow[]>([]);
  const [refsLoaded, setRefsLoaded] = useState(false);

  // 伺服器端篩選（隨 view／篩選重抓）
  const [kind, setKind] = useState<"" | RequestKind>("");
  const [employeeId, setEmployeeId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // client 端篩選
  const [deptId, setDeptId] = useState("");
  const [keyword, setKeyword] = useState("");

  /** 本 view 的伺服器資料；pending／in_progress 是同一份 pending。 */
  const [rows, setRows] = useState<LeaveRequest[]>([]);
  /** Segmented 計數用的 pending 清單（pending／in_progress 與 rows 同一份；all 從 rows 取；其餘另抓）。 */
  const [pendingRows, setPendingRows] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  // 批次列／列操作
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [approverDrafts, setApproverDrafts] = useState<Record<string, string>>({});
  const [proxyTarget, setProxyTarget] = useState<LeaveRequest | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LeaveRequest | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 附件清單：展開哪一張單 + 各單已抓到的附件（用 id 當 key 快取，避免重複打 API）
  const [expandedAttachmentsId, setExpandedAttachmentsId] = useState<string | null>(null);
  const [attachmentsById, setAttachmentsById] = useState<Record<string, RequestAttachment[]>>({});
  const [attachmentsLoadingId, setAttachmentsLoadingId] = useState<string | null>(null);
  const [attachmentsError, setAttachmentsError] = useState<Record<string, string>>({});

  /* ------------------------------------------------------------ 載入 --- */

  useEffect(() => {
    let active = true;
    (async () => {
      const [meRes, empRes, deptRes, flowRes] = await Promise.allSettled([
        getMeCached(),
        getEmployees(),
        getDepartments(),
        getApprovalFlows(),
      ]);
      if (!active) return;
      if (meRes.status === "fulfilled") setMeId(meRes.value.id);
      if (empRes.status === "fulfilled") setEmployees(empRes.value.employees);
      if (deptRes.status === "fulfilled") setDepartments(deptRes.value.departments);
      if (flowRes.status === "fulfilled") setFlows(flowRes.value.flows);
      const failed = [empRes, deptRes, flowRes].find((res) => res.status === "rejected");
      if (failed && failed.status === "rejected") setError(errMsg(failed.reason, "載入人員資料失敗"));
      setRefsLoaded(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const base = {
        kind: kind || undefined,
        employeeId: employeeId || undefined,
        from: from || undefined,
        to: to || undefined,
      };
      const needsSeparatePending = statusParam === "approved" || statusParam === "rejected";
      const [viewRes, pendingRes] = await Promise.all([
        getRequests({ ...base, status: statusParam }),
        needsSeparatePending ? getRequests({ ...base, status: "pending" }) : Promise.resolve(null),
      ]);
      if (seq !== loadSeq.current) return; // 已被更新的查詢取代
      setRows(viewRes.requests);
      setPendingRows(pendingRes ? pendingRes.requests : viewRes.requests.filter((row) => row.status === "pending"));
      setSelectedIds((ids) => ids.filter((id) => viewRes.requests.some((row) => row.id === id && row.status === "pending")));
      setError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(errMsg(err, "載入表單失敗"));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [employeeId, from, kind, statusParam, to]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------------------------------------ 衍生 --- */

  const lookup = useMemo(() => buildApprovalLookup(employees, departments, flows), [departments, employees, flows]);
  const ctx = useMemo<BucketContext>(
    () => ({ meId, flowByKind: lookup.flowByKind, fallbackHrId: lookup.fallbackHrId }),
    [lookup, meId],
  );
  const filters = useMemo(() => ({ deptId, keyword }), [deptId, keyword]);
  const visible = useMemo(
    () => applyClientFilters(rowsForView(rows, view, ctx), filters, lookup),
    [ctx, filters, lookup, rows, view],
  );
  const counts = useMemo(
    () => pendingCounts(applyClientFilters(pendingRows, filters, lookup), ctx),
    [ctx, filters, lookup, pendingRows],
  );
  const stats = useMemo(() => statsOf(visible), [visible]);
  const options = useMemo(() => viewOptions(counts), [counts]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectableRows = useMemo(
    () => (batchRow ? visible.filter((row) => row.status === "pending") : []),
    [batchRow, visible],
  );
  const allSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedSet.has(row.id));
  /** 批次列不顯示時，單筆核准／駁回不夾帶看不到的意見。 */
  const actionComment = batchRow ? comment.trim() || undefined : undefined;

  /* ---------------------------------------------------------- handlers --- */

  function changeView(next: ApprovalView) {
    if (next === view) return;
    setSelectedIds([]);
    setExpandedAttachmentsId(null);
    router.replace(`/admin/approvals?status=${next}`, { scroll: false });
  }

  function toggleOne(id: string) {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]));
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : selectableRows.map((row) => row.id));
  }

  /** 決定做完：側欄徽章重抓＋列表重抓（列表失敗只顯示錯誤，不影響已成功的決定）。 */
  async function afterDecision() {
    invalidateEssState();
    await load();
  }

  async function decide(id: string, action: "approve" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      if (action === "approve") await approveRequest(id, actionComment);
      else await rejectRequest(id, actionComment);
      toast.show(action === "approve" ? "已核准 1 張表單" : "已駁回 1 張表單", "success");
      await afterDecision();
    } catch (err) {
      setError(errMsg(err, "處理失敗"));
    } finally {
      setBusyId(null);
    }
  }

  async function batch(action: "approve" | "reject") {
    if (selectedIds.length === 0) {
      setError("請先勾選要批次處理的表單");
      return;
    }
    setBusyId("batch");
    setError(null);
    try {
      const result = await batchDecideRequests({ ids: selectedIds, action, comment: actionComment });
      toast.show(`批次完成：成功 ${result.ok} 張，失敗 ${result.failed} 張`, result.failed > 0 ? "info" : "success");
      await afterDecision();
    } catch (err) {
      setError(errMsg(err, "批次處理失敗"));
    } finally {
      setBusyId(null);
    }
  }

  async function remind(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await remindRequest(id);
      toast.show("已送出催簽提醒", "success");
    } catch (err) {
      setError(errMsg(err, "催簽失敗"));
    } finally {
      setBusyId(null);
    }
  }

  /** 代理簽核：HR 以 batch-decision 覆寫單筆（ConfirmDialog 確認後）。 */
  async function proxyApprove() {
    const target = proxyTarget;
    if (!target) return;
    setBusyId(target.id);
    setError(null);
    try {
      const result = await batchDecideRequests({
        ids: [target.id],
        action: "approve",
        comment: actionComment ?? "HR 代理簽核",
      });
      if (result.failed > 0) {
        const failed = result.results.find((item) => !item.ok);
        throw new Error(failed && !failed.ok ? failed.error : "代理簽核失敗");
      }
      setProxyTarget(null);
      toast.show("已完成 HR 代理簽核", "success");
      await afterDecision();
    } catch (err) {
      setProxyTarget(null);
      setError(errMsg(err, "代理簽核失敗"));
    } finally {
      setBusyId(null);
    }
  }

  async function changeApprover(row: LeaveRequest) {
    const approverEmpId = approverDrafts[row.id] ?? row.current_approver_emp_id ?? "";
    if (!approverEmpId) {
      setError("請先選擇新的簽核人");
      return;
    }
    if (approverEmpId === row.current_approver_emp_id) {
      toast.show("目前簽核人未變更", "info");
      return;
    }
    setBusyId(row.id);
    setError(null);
    try {
      await changeRequestApprover(row.id, approverEmpId, actionComment);
      toast.show("已變更目前簽核人並送出通知", "success");
      setApproverDrafts((drafts) => {
        const next = { ...drafts };
        delete next[row.id];
        return next;
      });
      await afterDecision();
    } catch (err) {
      setError(errMsg(err, "變更簽核人失敗"));
    } finally {
      setBusyId(null);
    }
  }

  function openDelete(row: LeaveRequest) {
    setDeleteTarget(row);
    setDeleteReason("");
    setDeleteError(null);
  }

  function closeDelete() {
    if (busyId === deleteTarget?.id) return;
    setDeleteTarget(null);
  }

  /** 註銷：伺服器端軟刪除（紀錄、附件、簽核軌跡都保留），理由必填會存進 delete_reason 供追溯。 */
  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    const reason = deleteReason.trim();
    if (!reason) {
      setDeleteError("註銷理由為必填");
      return;
    }
    setBusyId(target.id);
    setDeleteError(null);
    setError(null);
    try {
      await deleteRequest(target.id, reason);
      setDeleteTarget(null);
      toast.show("表單紀錄已註銷（紀錄保留）", "success");
      await afterDecision();
    } catch (err) {
      setDeleteError(errMsg(err, "註銷失敗"));
    } finally {
      setBusyId(null);
    }
  }

  /** 展開/收合附件清單；展開時才現拉 signed URL，並用 attachmentsById 快取。 */
  async function toggleAttachments(requestId: string) {
    if (expandedAttachmentsId === requestId) {
      setExpandedAttachmentsId(null);
      return;
    }
    setExpandedAttachmentsId(requestId);
    if (attachmentsById[requestId]) return;
    setAttachmentsLoadingId(requestId);
    try {
      const res = await getRequestAttachments(requestId);
      setAttachmentsById((prev) => ({ ...prev, [requestId]: res.attachments }));
      setAttachmentsError((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    } catch (err) {
      setAttachmentsError((prev) => ({ ...prev, [requestId]: errMsg(err, "載入附件失敗") }));
    } finally {
      setAttachmentsLoadingId((cur) => (cur === requestId ? null : cur));
    }
  }

  function exportCsv() {
    if (visible.length === 0) {
      setError("目前沒有可匯出的表單");
      return;
    }
    downloadCsv(csvText(csvMatrix(visible, lookup, ctx)), csvFileName());
    toast.show(`已匯出 ${visible.length} 筆`, "success");
  }

  /* ------------------------------------------------------------ render --- */

  const showSkeleton = loading || !refsLoaded;

  return (
    <>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Segmented
          options={options}
          value={view}
          onChange={changeView}
          size="sm"
          className="w-full md:w-auto"
          aria-label="簽核狀態"
        />
        <p className="text-xs text-gray-500">
          {view === "pending" && "輪到你簽的表單；勾選後可批次核准／駁回。"}
          {view === "in_progress" && "簽核者是其他人的表單；可催簽、代理簽核或變更簽核人。"}
          {view === "approved" && "已核准的表單不可註銷（假別餘額與單據已生效）。"}
          {view === "rejected" && "已駁回的表單保留作為紀錄；需要時可註銷。"}
          {view === "all" && "全部表單（含已取消）；匯出 CSV 會帶目前篩選結果。"}
        </p>
      </div>

      {view === "all" && (
        <Card>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-xs text-slate-500">表單總數</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{stats.total}</p>
            </div>
            <div className="rounded-xl bg-amber-50 p-4">
              <p className="text-xs text-amber-700">簽核中</p>
              <p className="mt-1 text-2xl font-semibold text-amber-800">{stats.pending}</p>
            </div>
            <div className="rounded-xl bg-green-50 p-4">
              <p className="text-xs text-green-700">已核准</p>
              <p className="mt-1 text-2xl font-semibold text-green-800">{stats.approved}</p>
            </div>
            <div className="rounded-xl bg-red-50 p-4">
              <p className="text-xs text-red-700">已駁回</p>
              <p className="mt-1 text-2xl font-semibold text-red-800">{stats.rejected}</p>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-8">
          <div>
            <label className={labelCls} htmlFor="approvals-kind">
              表單類型
            </label>
            <Select id="approvals-kind" value={kind} onChange={(event) => setKind(event.target.value as "" | RequestKind)}>
              <option value="">全部</option>
              {KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className={labelCls} htmlFor="approvals-dept">
              單位
            </label>
            <Select id="approvals-dept" value={deptId} onChange={(event) => setDeptId(event.target.value)}>
              <option value="">全部單位</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="lg:col-span-2">
            <label className={labelCls} htmlFor="approvals-employee">
              工號 / 姓名
            </label>
            <Select id="approvals-employee" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">全部人員</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employeeLabel(employee)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className={labelCls} htmlFor="approvals-from">
              申請起日
            </label>
            <Input id="approvals-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="approvals-to">
              申請迄日
            </label>
            <Input id="approvals-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="flex items-end gap-2 md:col-span-2 lg:col-span-2">
            <Button variant="primary" onClick={() => void load()} disabled={loading} className="flex-1 md:min-h-10 lg:flex-none">
              搜尋
            </Button>
            <Button variant="secondary" onClick={exportCsv} disabled={showSkeleton} className="flex-1 md:min-h-10 lg:flex-none">
              匯出 CSV
            </Button>
          </div>
          <div className="md:col-span-2 lg:col-span-8">
            <label className={labelCls} htmlFor="approvals-keyword">
              關鍵字
            </label>
            <Input
              id="approvals-keyword"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜尋姓名、工號、單位、原因、地點、代理人或目前簽核人"
            />
          </div>
        </div>
      </Card>

      <Card>
        {batchRow && (
          <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_auto]">
            <div>
              <label className={labelCls} htmlFor="approvals-comment">
                簽核意見
              </label>
              <Input
                id="approvals-comment"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="可輸入批次或單筆簽核意見（代理簽核／變更簽核人也會帶上）"
              />
            </div>
            <div className="flex items-end">
              <Button
                variant="danger"
                onClick={() => void batch("reject")}
                disabled={busyId === "batch" || selectedIds.length === 0}
                loading={busyId === "batch"}
                className="w-full md:min-h-10"
              >
                批次駁回{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}
              </Button>
            </div>
            <div className="flex items-end">
              <Button
                variant="primary"
                onClick={() => void batch("approve")}
                disabled={busyId === "batch" || selectedIds.length === 0}
                loading={busyId === "batch"}
                className="w-full md:min-h-10"
              >
                批次核准{selectedIds.length > 0 ? `（${selectedIds.length}）` : ""}
              </Button>
            </div>
          </div>
        )}

        {error && <InlineError className="mb-3">{error}</InlineError>}

        {showSkeleton ? (
          <Skeleton lines={5} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={view === "pending" ? "目前沒有待你簽核的表單" : "目前沒有符合條件的表單"}
            hint={keyword || deptId ? "試試清除關鍵字或單位篩選" : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  {batchRow && (
                    <th className="w-10 py-2 pr-4">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全選" />
                    </th>
                  )}
                  <th className="py-2 pr-4">申請日期</th>
                  <th className="py-2 pr-4">單位</th>
                  <th className="py-2 pr-4">工號 / 姓名</th>
                  <th className="py-2 pr-4">表單類型</th>
                  <th className="py-2 pr-4">內容</th>
                  <th className="py-2 pr-4">目前簽核人</th>
                  <th className="py-2 pr-4">狀態</th>
                  <th className="py-2 pr-4">附件</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const bucket = bucketOf(row, ctx);
                  const actions = actionsFor(bucket);
                  const busy = busyId === row.id || busyId === "batch";
                  const canSelect = batchRow && row.status === "pending";
                  return (
                    <tr key={row.id} className="border-b border-gray-50 align-top">
                      {batchRow && (
                        <td className="py-3 pr-4">
                          <input
                            type="checkbox"
                            checked={selectedSet.has(row.id)}
                            disabled={!canSelect}
                            onChange={() => toggleOne(row.id)}
                            aria-label={`選取 ${row.id}`}
                          />
                        </td>
                      )}
                      <td className="whitespace-nowrap py-3 pr-4 text-gray-600">{dateOnly(row.created_at)}</td>
                      <td className="py-3 pr-4 text-gray-600">{lookup.employeeDept(row.employee_id) ?? "—"}</td>
                      <td className="py-3 pr-4 font-medium text-gray-800">
                        {lookup.employeeName(row.employee_id) ?? row.employee_id.slice(0, 8)}
                      </td>
                      <td className="py-3 pr-4">
                        <Pill tone="gray">{KIND_LABEL[row.kind]}</Pill>
                      </td>
                      <td className="max-w-sm py-3 pr-4 text-gray-600">
                        {contentLines(row).map((line, index) => (
                          <p key={`${row.id}-${index}`} className={index === 0 ? "" : "text-xs text-gray-400"}>
                            {line}
                          </p>
                        ))}
                      </td>
                      <td className="py-3 pr-4 text-gray-600">{lookup.approverLabel(row)}</td>
                      <td className="py-3 pr-4">
                        <Pill tone={BUCKET_TONE[bucket]}>{BUCKET_LABEL[bucket]}</Pill>
                      </td>
                      <td className="py-3 pr-4">
                        <button
                          type="button"
                          onClick={() => void toggleAttachments(row.id)}
                          className="text-xs font-medium underline underline-offset-2"
                          style={{ color: "var(--brand)" }}
                        >
                          {expandedAttachmentsId === row.id ? "收合附件" : "查看附件"}
                        </button>
                        {expandedAttachmentsId === row.id && (
                          <div className="mt-1 max-w-[12rem]">
                            {attachmentsLoadingId === row.id ? (
                              <p className="text-xs text-gray-400">載入中…</p>
                            ) : attachmentsError[row.id] ? (
                              <p className="text-xs text-red-600">{attachmentsError[row.id]}</p>
                            ) : (attachmentsById[row.id] ?? []).length === 0 ? (
                              <p className="text-xs text-gray-400">無附件</p>
                            ) : (
                              <ul className="space-y-0.5">
                                {(attachmentsById[row.id] ?? []).map((att) => (
                                  <li key={att.id} className="truncate">
                                    <a
                                      href={att.url ?? "#"}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-xs underline"
                                      style={{ color: "var(--brand)" }}
                                      title={att.fileName}
                                    >
                                      {att.fileName}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-2">
                          {actions.map((action) => {
                            switch (action.key) {
                              case "approve":
                                return (
                                  <button
                                    key={action.key}
                                    type="button"
                                    onClick={() => void decide(row.id, "approve")}
                                    disabled={busy || action.disabled}
                                    className={`${ROW_BUTTON} bg-green-600 text-white`}
                                  >
                                    核准
                                  </button>
                                );
                              case "reject":
                                return (
                                  <button
                                    key={action.key}
                                    type="button"
                                    onClick={() => void decide(row.id, "reject")}
                                    disabled={busy || action.disabled}
                                    className={`${ROW_BUTTON} bg-red-600 text-white`}
                                  >
                                    駁回
                                  </button>
                                );
                              case "remind":
                                return (
                                  <button
                                    key={action.key}
                                    type="button"
                                    onClick={() => void remind(row.id)}
                                    disabled={busy || action.disabled}
                                    className={`${ROW_BUTTON} border border-amber-300 text-amber-700`}
                                  >
                                    催簽
                                  </button>
                                );
                              case "proxy_approve":
                                return (
                                  <button
                                    key={action.key}
                                    type="button"
                                    onClick={() => setProxyTarget(row)}
                                    disabled={busy || action.disabled}
                                    className={`${ROW_BUTTON} border border-green-300 text-green-700`}
                                  >
                                    代理簽核
                                  </button>
                                );
                              case "change_approver":
                                return (
                                  <span key={action.key} className="inline-flex flex-wrap items-center gap-2">
                                    <select
                                      className="rounded-md border border-gray-300 px-2 py-1.5 text-xs"
                                      aria-label="新的簽核人"
                                      value={approverDrafts[row.id] ?? row.current_approver_emp_id ?? ""}
                                      disabled={busy}
                                      onChange={(event) =>
                                        setApproverDrafts((drafts) => ({ ...drafts, [row.id]: event.target.value }))
                                      }
                                    >
                                      <option value="">選擇簽核人</option>
                                      {lookup.approverCandidates.map((employee) => (
                                        <option key={employee.id} value={employee.id}>
                                          {employeeLabel(employee)}
                                        </option>
                                      ))}
                                    </select>
                                    <button
                                      type="button"
                                      onClick={() => void changeApprover(row)}
                                      disabled={busy || action.disabled}
                                      className={`${ROW_BUTTON} border border-blue-300 text-blue-700`}
                                    >
                                      變更簽核人
                                    </button>
                                  </span>
                                );
                              case "delete":
                                return (
                                  <button
                                    key={action.key}
                                    type="button"
                                    onClick={() => openDelete(row)}
                                    disabled={busy || action.disabled}
                                    title={action.disabled ? "已核准的表單不可註銷" : undefined}
                                    className={`${ROW_BUTTON} border border-red-300 text-red-700`}
                                  >
                                    註銷
                                  </button>
                                );
                              case "attachments":
                                return null; // 附件欄已有「查看附件」
                            }
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={proxyTarget !== null}
        title="HR 代理簽核"
        message={
          proxyTarget
            ? `確定要以 HR 身分代理核准 ${lookup.employeeName(proxyTarget.employee_id) ?? proxyTarget.employee_id.slice(0, 8)} 的${KIND_LABEL[proxyTarget.kind]}申請？\n目前簽核人：${lookup.approverLabel(proxyTarget)}${actionComment ? `\n簽核意見：${actionComment}` : "\n簽核意見：HR 代理簽核"}`
            : undefined
        }
        confirmLabel="代理核准"
        busy={proxyTarget !== null && busyId === proxyTarget.id}
        onConfirm={() => void proxyApprove()}
        onCancel={() => setProxyTarget(null)}
      />

      <BottomSheet open={deleteTarget !== null} onClose={closeDelete} title="註銷表單紀錄">
        {deleteTarget && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {lookup.employeeName(deleteTarget.employee_id) ?? deleteTarget.employee_id.slice(0, 8)} 的
              {KIND_LABEL[deleteTarget.kind]}申請（{dateOnly(deleteTarget.created_at)}）。
              紀錄不會被刪除，僅標記為已註銷並保留附件與簽核軌跡供追溯。
            </p>
            <Field label="註銷理由" required htmlFor="approvals-delete-reason" error={deleteError ?? undefined}>
              <Textarea
                id="approvals-delete-reason"
                value={deleteReason}
                onChange={(event) => setDeleteReason(event.target.value)}
                placeholder="例如：員工重複送單、日期填錯已另填新單"
                maxLength={250}
                aria-invalid={deleteError ? "true" : undefined}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" size="lg" onClick={closeDelete} disabled={busyId === deleteTarget.id}>
                取消
              </Button>
              <Button variant="danger" size="lg" onClick={() => void confirmDelete()} loading={busyId === deleteTarget.id}>
                確定註銷
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense
      fallback={
        <>
          <Card>
            <Skeleton lines={3} />
          </Card>
          <Card>
            <Skeleton lines={5} />
          </Card>
        </>
      }
    >
      <ApprovalsView />
    </Suspense>
  );
}
