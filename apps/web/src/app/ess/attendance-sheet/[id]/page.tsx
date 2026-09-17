"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AttendanceSheetTable } from "@/components/AttendanceSheetTable";
import { Button, Card, InlineError, SectionTitle, Textarea } from "@/components/ess-ui";
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
export default function AttendanceSheetReviewPage() {
  const params = useParams<{ id: string }>();
  const sheetId = params.id;

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
    <div className="space-y-4">
      <Card>
        <div className="no-print mb-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <SectionTitle>審核出勤月表</SectionTitle>
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

        {error && <InlineError className="no-print mb-3">{error}</InlineError>}
        {message && <p className="no-print mb-3 text-sm text-green-600">{message}</p>}

        {loading ? (
          <p className="text-sm text-gray-400">載入中…</p>
        ) : sheet ? (
          <>
            <AttendanceSheetTable sheet={sheet} editable={false} showMoney={false} />
            {sheet.status === "submitted" ? (
              <div className="no-print mt-4 space-y-2 rounded-xl border border-gray-100 bg-gray-50 p-4">
                <label className="block text-xs font-medium text-gray-500">意見（退回時必填）</label>
                <Textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  rows={2}
                  className="min-h-0"
                  placeholder="給員工的審核意見"
                />
                <div className="flex gap-2">
                  <Button onClick={() => void decide("approve")} disabled={busy}>
                    核可
                  </Button>
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
      </Card>
    </div>
  );
}
