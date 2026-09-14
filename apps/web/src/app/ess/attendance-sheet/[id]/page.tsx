"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { EssHeader } from "@/components/EssHeader";
import { AttendanceSheetTable } from "@/components/AttendanceSheetTable";
import { getBranding, getMe, isAdminRole, type Branding } from "@/lib/ess-api";
import {
  getAttendanceSheet,
  reviewAttendanceSheet,
  friendlyError,
  SHEET_STATUS_LABEL,
  type SheetView,
} from "@/lib/attendance-sheets-api";

/**
 * 主管在 ESS 端快速審核部屬的出勤月表（唯讀表 + 核可／退回）。走通用的
 * POST /attendance-sheets/:id/review（decision:'approve'|'return'），不是 HR
 * 後台那組 approve/return/reopen/recompute（那是 /admin/attendance-sheets/[id]
 * 給 HR 用的二階審核與月結操作）。
 */
function ReviewInner() {
  const params = useParams<{ id: string }>();
  const sheetId = params.id;

  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAttendanceSheet(sheetId);
      setSheet(res.sheet);
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [sheetId]);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: "approve" | "return") {
    if (!sheet) return;
    if (decision === "return" && !comment.trim()) {
      setError("退回需先填寫意見");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await reviewAttendanceSheet(sheet.id, decision, comment.trim() || undefined);
      await load(); // review 只回 {id,status}，重新 GET 換回完整 SheetView
      setMessage(decision === "approve" ? "已核可，送交人事覆核" : "已退回給員工");
    } catch (err) {
      setError(friendlyError(err, "處理失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader appName={branding?.appName} primaryColor={branding?.primaryColor} active="sheet" isAdmin={isAdmin} />
      <main className="mx-auto max-w-6xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="no-print mb-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-800">審核出勤月表</h2>
              {sheet && (
                <p className="mt-1 truncate text-sm text-gray-500">
                  {sheet.employeeNo ? `${sheet.employeeNo} · ` : ""}
                  {sheet.employeeName}　{sheet.period}　狀態：{SHEET_STATUS_LABEL[sheet.status]}
                </p>
              )}
            </div>
            <Link href="/ess/attendance-sheet" className="shrink-0 text-sm text-gray-500 hover:underline">
              ← 回出勤月表
            </Link>
          </div>

          {error && <p className="no-print mb-3 text-sm text-red-600">{error}</p>}
          {message && <p className="no-print mb-3 text-sm text-green-600">{message}</p>}

          {loading ? (
            <p className="text-sm text-gray-400">載入中…</p>
          ) : sheet ? (
            <>
              <AttendanceSheetTable sheet={sheet} editable={false} showMoney={false} />
              {sheet.status === "submitted" ? (
                <div className="no-print mt-4 space-y-2 rounded-xl border border-gray-100 bg-gray-50 p-4">
                  <label className="block text-xs font-medium text-gray-500">意見（退回時必填）</label>
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
                    placeholder="給員工的審核意見"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void decide("approve")}
                      disabled={busy}
                      className="rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      style={{ backgroundColor: "var(--brand)" }}
                    >
                      核可
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide("return")}
                      disabled={busy}
                      className="rounded-xl border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
                    >
                      退回（意見）
                    </button>
                  </div>
                </div>
              ) : (
                <p className="no-print mt-3 text-xs text-gray-400">此表目前狀態非「已送出」，無法在此審核。</p>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-400">查無資料</p>
          )}
        </section>
      </main>
    </div>
  );
}

export default function AttendanceSheetReviewPage() {
  return (
    <AuthGate>
      <ReviewInner />
    </AuthGate>
  );
}
