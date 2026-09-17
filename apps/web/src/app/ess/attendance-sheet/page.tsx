"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MonthPicker } from "@/components/MonthPicker";
import { AttendanceSheetTable } from "@/components/AttendanceSheetTable";
import { Button, Card, InlineError, Pill, type PillTone } from "@/components/ess-ui";
import {
  getMyAttendanceSheet,
  listAttendanceSheets,
  patchAttendanceSheetDay,
  submitAttendanceSheet,
  friendlyError,
  mergeDayPatch,
  unacknowledgedErrors,
  SHEET_STATUS_LABEL,
  type SheetView,
  type SheetListItem,
  type SheetDayPatch,
} from "@/lib/attendance-sheets-api";

const currentPeriod = new Date().toISOString().slice(0, 7);

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
  const [period, setPeriod] = useState(currentPeriod);
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // null = 尚未載入；[] = 載入完成但沒有（或非主管、403 → 隱藏區塊）
  const [pending, setPending] = useState<SheetListItem[] | null>(null);

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
    listAttendanceSheets({ period, status: "submitted" })
      .then((res) => {
        if (active) setPending(res.sheets);
      })
      .catch(() => {
        // 非主管會 403，或該角色端點本來就回空——一律視為隱藏區塊，不當成錯誤顯示。
        if (active) setPending([]);
      });
    return () => {
      active = false;
    };
  }, [period]);

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
            <AttendanceSheetTable sheet={sheet} editable={editable} showMoney={false} onPatchDay={handlePatchDay} />
            <div className="no-print mt-4 space-y-2">
              {editable && blockers.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
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
                <Button onClick={() => void onSubmit()} disabled={blockers.length > 0} loading={submitting}>
                  {submitting ? "送出中…" : "送出"}
                </Button>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-gray-400">查無資料</p>
        )}
      </Card>

      {pending && pending.length > 0 && (
        <Card title="待我審核" className="no-print">
          <div className="space-y-2">
            {pending.map((row) => (
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
