"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EssTabGate } from "@/components/EssTabGate";
import { EssHeader } from "@/components/EssHeader";
import { MonthPicker } from "@/components/MonthPicker";
import { AttendanceSheetTable } from "@/components/AttendanceSheetTable";
import { getBranding, getMe, isAdminRole, type Branding } from "@/lib/ess-api";
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

const STATUS_BADGE: Record<SheetView["status"], string> = {
  draft: "bg-gray-100 text-gray-600",
  submitted: "bg-amber-100 text-amber-700",
  manager_reviewed: "bg-blue-100 text-blue-700",
  approved: "bg-green-100 text-green-700",
  locked: "bg-gray-200 text-gray-600",
  returned: "bg-red-100 text-red-700",
};

function AttendanceSheetInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
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
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
  }, []);

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
    <div className="min-h-dvh bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="sheet" isAdmin={isAdmin} />
      <main className="mx-auto max-w-6xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="no-print mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">出勤月表</h2>
              <p className="mt-1 text-sm text-gray-500">
                每月出勤自動彙整，補填內容／備註／異常說明後送出，經主管與人事覆核後鎖定。
              </p>
            </div>
            <MonthPicker value={period} onChange={setPeriod} disabled={loading} />
          </div>

          {sheet && (
            <div className="no-print mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-gray-50 px-4 py-3 text-sm">
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[sheet.status]}`}>
                {SHEET_STATUS_LABEL[sheet.status]}
              </span>
              {sheet.status === "returned" && sheet.returnReason && (
                <span className="text-red-600">退回原因：{sheet.returnReason}</span>
              )}
              <span className="text-gray-400">送出 {fmtDateTime(sheet.submittedAt)}</span>
              <span className="text-gray-400">經理審 {fmtDateTime(sheet.managerReviewedAt)}</span>
              <span className="text-gray-400">核准 {fmtDateTime(sheet.approvedAt)}</span>
              <span className="text-gray-400">鎖定 {fmtDateTime(sheet.lockedAt)}</span>
            </div>
          )}

          {error && <p className="no-print mb-3 text-sm text-red-600">{error}</p>}
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
                  <button
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={submitting || blockers.length > 0}
                    className="rounded-xl px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ backgroundColor: "var(--brand)" }}
                  >
                    {submitting ? "送出中…" : "送出"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-400">查無資料</p>
          )}
        </section>

        {pending && pending.length > 0 && (
          <section className="no-print rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
            <h2 className="mb-3 text-lg font-semibold text-gray-800">待我審核</h2>
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
          </section>
        )}
      </main>
    </div>
  );
}

export default function AttendanceSheetPage() {
  return (
    <EssTabGate tab="sheet">
      <AttendanceSheetInner />
    </EssTabGate>
  );
}
