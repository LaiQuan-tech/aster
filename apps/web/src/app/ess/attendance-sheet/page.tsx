"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MonthPicker } from "@/components/MonthPicker";
import { AttendanceSheetTable, SheetMonthAnomalies } from "@/components/AttendanceSheetTable";
import { Button, Card, InlineError, Pill, type PillTone } from "@/components/ess-ui";
import { useEssState } from "@/lib/ess-state";
import { getRequests, type LeaveRequest } from "@/lib/ess-api";
import { todayKey } from "@/lib/ess-format";
import { findNoPunchDates, isRequestsForbidden, noPunchSummary } from "@/lib/sheet-no-punch";
import {
  getMyAttendanceSheet,
  listAttendanceSheets,
  patchAttendanceSheetDay,
  submitAttendanceSheet,
  friendlyError,
  mergeDayPatch,
  unacknowledgedErrors,
  currentSheetPeriod,
  SHEET_STATUS_LABEL,
  SHEET_TIME_ZONE,
  type SheetView,
  type SheetListItem,
  type SheetDayPatch,
} from "@/lib/attendance-sheets-api";

/**
 * 本人已核准的申請單（「無打卡紀錄」判斷用：請假、在家工作、補卡、出差／公出）：讀取中＝先不標；
 * 讀不到（403 以外的錯誤）＝這次整張不標。
 */
type ApprovedState = { status: "loading" } | { status: "failed" } | { status: "ready"; requests: LeaveRequest[] };

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const STATUS_TONE: Record<SheetView["status"], PillTone> = {
  draft: "gray",
  submitted: "amber",
  manager_reviewed: "blue",
  approved: "green",
  locked: "gray",
  returned: "red",
};

export default function AttendanceSheetPage() {
  const { me } = useEssState();
  // 預設月份用台北時間、在元件裡算（模組層只算一次又是 UTC：每月 1 日台北 00:00–07:59 會跑到上個月）。
  const [period, setPeriod] = useState(() => currentSheetPeriod());
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // null = 尚未載入；[] = 載入完成但沒有（或非主管、403 → 隱藏區塊）
  const [pending, setPending] = useState<SheetListItem[] | null>(null);
  const [approved, setApproved] = useState<ApprovedState>({ status: "loading" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMyAttendanceSheet(period);
      setSheet(res.sheet);
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "載入出勤月表失敗"));
      setSheet(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    // scope=mine：HR／會計在員工端也只列本人＋所管部門的月表（不再列全公司、誤核到別人的）。
    listAttendanceSheets({ period, status: "submitted", scope: "mine" })
      .then((res) => {
        if (active) setPending(res.sheets);
      })
      .catch(() => {
        // 讀取失敗一律視為隱藏區塊，不當成錯誤顯示。
        if (active) setPending([]);
      });
    return () => {
      active = false;
    };
  }, [period]);

  // 「無打卡紀錄」要排除已核准的請假／在家工作／補卡／出差公出：月表日資料是快照，快照之後才核准的單子
  // 在月表上看不到，所以讀一次本人所有已核准的單（不分月份、不分種類，由 lib/sheet-no-punch.ts 挑種類比對日期）。
  useEffect(() => {
    let active = true;
    getRequests({ scope: "mine", status: "approved" })
      .then((res) => {
        if (!active) return;
        setApproved(Array.isArray(res?.requests) ? { status: "ready", requests: res.requests } : { status: "failed" });
      })
      .catch((err) => {
        if (!active) return;
        // 403＝員工端「申請」分頁沒開，這個人送不了申請單 → 當作沒有核准單；其他錯誤 → 這次整張不標（避免誤標）。
        setApproved(isRequestsForbidden(err) ? { status: "ready", requests: [] } : { status: "failed" });
      });
    return () => {
      active = false;
    };
  }, []);

  // 身分類別（GET /me）：只有固定上班日的人（正職、約聘）才標。/me 還沒回來、失敗，或登入身分不是這張月表的本人
  // → undefined → 整張不標（工讀／兼職一週只來幾天，平日沒打卡很正常；不知道就寧可不標）。
  const employmentType = me && sheet && me.id === sheet.employeeId ? me.employmentType : undefined;

  // 整天沒打卡又沒請假／在家／補卡／出差公出的上班日（只在本人月表標；後台、主管審核頁、匯出、列印都不標）。
  const noPunchDates = useMemo(
    () =>
      sheet && approved.status === "ready"
        ? findNoPunchDates(sheet, { today: todayKey(SHEET_TIME_ZONE), requests: approved.requests, employmentType })
        : [],
    [sheet, approved, employmentType],
  );
  const noPunchDateSet = useMemo(() => new Set(noPunchDates), [noPunchDates]);

  async function handlePatchDay(date: string, patch: SheetDayPatch) {
    if (!sheet) return;
    try {
      const res = await patchAttendanceSheetDay(sheet.id, date, patch);
      setSheet((prev) =>
        prev ? { ...prev, days: prev.days.map((d) => (d.date === date ? mergeDayPatch(d, res.day) : d)) } : prev,
      );
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "更新失敗"));
      throw err;
    }
  }

  const editable = sheet ? sheet.status === "draft" || sheet.status === "returned" : false;
  const blockers = sheet ? unacknowledgedErrors(sheet) : [];
  const noPunchText = noPunchSummary(noPunchDates, editable);

  async function onSubmit() {
    if (!sheet) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      await submitAttendanceSheet(sheet.id);
      await load(); // submit 只回 {id,status,managerEmpId}，重新 GET 換回完整 SheetView
      setMessage("已送出，等待主管審核");
    } catch (err) {
      setError(friendlyError(err, "送出失敗"));
    } finally {
      setSubmitting(false);
    }
  }

  // scope=mine 的名單一律含本人：自己送出的月表不能自己審（API 會 403），從「待我審核」排除。
  // 同時比對登入身分與本人月表：月表載入失敗或清單先回來時也不會列出自己。
  const reviewable = (pending ?? []).filter((row) => row.employeeId !== me?.id && row.employeeId !== sheet?.employeeId);

  return (
    <div className="space-y-4">
      <Card>
        <div className="no-print mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-gray-500">
            每月出勤自動彙整，補填內容／備註／異常說明後送出，經主管與人事覆核後鎖定。
          </p>
          <MonthPicker value={period} onChange={setPeriod} disabled={loading} />
        </div>

        {sheet && (
          <div className="no-print mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-gray-50 px-4 py-3 text-sm">
            <Pill tone={STATUS_TONE[sheet.status]}>{SHEET_STATUS_LABEL[sheet.status]}</Pill>
            {sheet.status === "returned" && sheet.returnReason && (
              <span className="text-red-600">退回原因：{sheet.returnReason}</span>
            )}
            <span className="text-gray-400">送出 {fmtDateTime(sheet.submittedAt)}</span>
            <span className="text-gray-400">經理審 {fmtDateTime(sheet.managerReviewedAt)}</span>
            <span className="text-gray-400">核准 {fmtDateTime(sheet.approvedAt)}</span>
            <span className="text-gray-400">鎖定 {fmtDateTime(sheet.lockedAt)}</span>
          </div>
        )}

        {error && <InlineError className="no-print mb-3">{error}</InlineError>}
        {message && <p className="no-print mb-3 text-sm text-green-600">{message}</p>}

        {loading ? (
          <p className="text-sm text-gray-400">載入中…</p>
        ) : sheet ? (
          <>
            <AttendanceSheetTable
              sheet={sheet}
              editable={editable}
              showMoney={false}
              onPatchDay={handlePatchDay}
              preferenceScope="ess"
              noPunchDates={noPunchDateSet}
            />
            {/* 異常區（月份級異常、無打卡摘要、送出前檢查、送出鈕）整塊不印：印出來的出勤統計表跟 10/12 改版前一樣。 */}
            <div className="no-print mt-4 space-y-2">
              <SheetMonthAnomalies anomalies={sheet.monthAnomalies} audience="ess" />
              {noPunchText && (
                <p className="no-print rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  {noPunchText}
                </p>
              )}
              {editable && blockers.length > 0 && (
                <div className="no-print rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  <p className="mb-1 font-medium">送出前請先在表格中說明以下錯誤等級異常：</p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {blockers.map((b, i) => (
                      <li key={`${b.date}-${i}`}>
                        {b.date}：{b.anomaly.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {editable && (
                <Button
                  className="no-print"
                  onClick={() => void onSubmit()}
                  disabled={blockers.length > 0}
                  loading={submitting}
                >
                  {submitting ? "送出中…" : "送出"}
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">查無資料</p>
        )}
      </Card>

      {reviewable.length > 0 && (
        <Card title="待我審核" className="no-print">
          <div className="space-y-2">
            {reviewable.map((row) => (
              <Link
                key={row.id}
                href={`/ess/attendance-sheet/${row.id}`}
                className="flex flex-col gap-1 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm hover:bg-gray-100 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-medium text-gray-700">
                  {row.employeeNo ? `${row.employeeNo} · ${row.employeeName}` : row.employeeName}
                  {row.department && <span className="ml-2 text-gray-400">{row.department}</span>}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  {row.anomalyCount.error > 0 && (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">error×{row.anomalyCount.error}</span>
                  )}
                  {row.anomalyCount.warn > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">warn×{row.anomalyCount.warn}</span>
                  )}
                  <span>送出 {fmtDateTime(row.submittedAt)}</span>
                  <span style={{ color: "var(--brand)" }}>審核 →</span>
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
