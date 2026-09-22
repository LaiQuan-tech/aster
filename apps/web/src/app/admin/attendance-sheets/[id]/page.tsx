"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, DetailHeading, ErrorText, Empty } from "@/components/admin-ui";
import { AttendanceSheetTable } from "@/components/AttendanceSheetTable";
import {
  getAttendanceSheet,
  patchAttendanceSheetDay,
  approveAttendanceSheet,
  returnAttendanceSheet,
  reopenAttendanceSheet,
  recomputeAttendanceSheet,
  exportAttendanceSheetXlsx,
  friendlyError,
  mergeDayPatch,
  SHEET_STATUS_LABEL,
  type SheetView,
  type SheetDayPatch,
} from "@/lib/attendance-sheets-api";
import { getRuleConfigVersions, type RuleConfigVersion } from "@/lib/admin-api";
import { listSheetSnapshots, type SheetSnapshotSummary } from "@/lib/backup-api";

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AttendanceSheetDetailPage() {
  const params = useParams<{ id: string }>();
  const sheetId = params.id;

  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 本月適用規則版本清單；null = 還在載入或拿不到，此時上方顯示直接跳過，不擋月表其餘內容。
  const [ruleVersions, setRuleVersions] = useState<RuleConfigVersion[] | null>(null);
  // M9 歷次核准快照：每次核准都會凍結一份（退回／重開不刪），這裡讓 HR 開得出舊版。
  const [snapshots, setSnapshots] = useState<SheetSnapshotSummary[] | null>(null);
  const [openSnapshot, setOpenSnapshot] = useState<SheetSnapshotSummary | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);

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

  useEffect(() => {
    // 生效日資訊非關鍵路徑：拿不到就跳過顯示，不影響月表其餘內容。
    getRuleConfigVersions()
      .then(setRuleVersions)
      .catch(() => {
        // 忽略——ruleVersions 維持 null，畫面上該區塊直接不顯示。
      });
  }, []);

  /**
   * 歷次核准快照清單（不帶 full，只要中繼資料；點開才抓整份快照）。
   * 同樣是非關鍵路徑——舊環境沒有 attendance_sheet_snapshots 時後端回空陣列。
   */
  const loadSnapshots = useCallback(async () => {
    try {
      const res = await listSheetSnapshots(sheetId);
      setSnapshots(res.snapshots);
    } catch {
      setSnapshots([]);
    }
  }, [sheetId]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  /** 點「檢視」才去抓整份快照（列表刻意不帶 snapshot，一張月表 30 天的 JSON 不小）。 */
  async function onOpenSnapshot(seq: number) {
    setSnapshotBusy(true);
    setError(null);
    try {
      const res = await listSheetSnapshots(sheetId, true);
      const found = res.snapshots.find((s) => s.seq === seq) ?? null;
      if (!found?.snapshot) {
        setError("這份快照沒有內容可顯示");
        return;
      }
      setOpenSnapshot(found);
    } catch (err) {
      setError(friendlyError(err, "載入快照失敗"));
    } finally {
      setSnapshotBusy(false);
    }
  }

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

  async function onApprove() {
    if (!sheet) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await approveAttendanceSheet(sheet.id);
      await load(); // approve 只回 {id,status,approvedAt}，重新 GET 換回完整 SheetView
      setMessage("已核准");
    } catch (err) {
      setError(friendlyError(err, "核准失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onReturn() {
    if (!sheet) return;
    const reason = window.prompt("請輸入退回原因：");
    if (!reason || !reason.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await returnAttendanceSheet(sheet.id, reason.trim());
      await load(); // return 只回 {id,status,returnReason}，重新 GET 換回完整 SheetView
      setMessage("已退回");
    } catch (err) {
      setError(friendlyError(err, "退回失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onReopen() {
    if (!sheet) return;
    const reason = window.prompt("請輸入重開原因（將退回草稿重新填報）：");
    if (!reason || !reason.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await reopenAttendanceSheet(sheet.id, reason.trim());
      await load(); // reopen 只回 {id,status}，重新 GET 換回完整 SheetView
      setMessage("已重開為草稿");
    } catch (err) {
      setError(friendlyError(err, "重開失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onRecompute() {
    if (!sheet) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await recomputeAttendanceSheet(sheet.id);
      await load(); // recompute 只回 {id,status,computedAt}，重新 GET 換回完整 SheetView
      setMessage("已重新計算");
    } catch (err) {
      setError(friendlyError(err, "重算失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    if (!sheet) return;
    setError(null);
    try {
      await exportAttendanceSheetXlsx(sheet.id, `出勤月表_${sheet.period}_${sheet.employeeName}.xlsx`);
    } catch (err) {
      setError(friendlyError(err, "匯出失敗"));
    }
  }

  if (loading) {
    return (
      <>
        <Card>
          <Empty>載入中…</Empty>
        </Card>
      </>
    );
  }

  if (!sheet) {
    return (
      <>
        <Card>
          <ErrorText>{error ?? "查無資料"}</ErrorText>
        </Card>
      </>
    );
  }

  const canApprove = sheet.status === "manager_reviewed";
  const canReturn = sheet.status === "submitted" || sheet.status === "manager_reviewed" || sheet.status === "approved";
  const canReopen = sheet.status === "approved";
  const canRecompute = sheet.status === "draft" || sheet.status === "returned";

  // C4（審查修正）：版本號一定要用 sheet.ruleConfigVersion——這是計算/凍結當下
  // 寫死的權威值。不要用 pickRuleConfigVersion(ruleVersions, sheet.period) 現場
  // 推導：HR 事後用「指定日期」回填一個更早生效的新版時，推導值會變成新版，
  // 但畫面上的加班費／獎金其實還是舊版算出來的數字，標籤會說謊。effectiveFrom
  // 這個日期本身 sheet 沒有帶，才需要拿權威版本號去 ruleVersions 清單裡查一次。
  const authoritativeVersion = sheet.ruleConfigVersion;
  const matchedRuleVersion =
    authoritativeVersion != null && ruleVersions
      ? (ruleVersions.find((v) => v.version === authoritativeVersion) ?? null)
      : null;
  const ruleVersionLabel = !ruleVersions
    ? null
    : authoritativeVersion == null
      ? null // 找不到權威版本號（舊資料或尚未計算過），不顯示，避免用推導值誤導
      : matchedRuleVersion
        ? matchedRuleVersion.effectiveFrom
          ? `本月適用規則 v${matchedRuleVersion.version}（生效 ${matchedRuleVersion.effectiveFrom}）`
          : `本月適用規則 v${matchedRuleVersion.version}（系統預設）`
        : "本月適用規則：預設規則"; // version 0（DEFAULT_RULE_CONFIG）或該版本已從歷史中查無

  return (
    <>
      <div className="no-print mb-2">
        <DetailHeading
          title={`出勤月表 · ${sheet.employeeName}`}
          desc={`${sheet.period}　工號 ${sheet.employeeNo ?? "—"}　部門 ${sheet.department ?? "—"}　狀態 ${SHEET_STATUS_LABEL[sheet.status]}`}
        />
      </div>

      <Card>
        <div className="no-print mb-4 flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <span>送出 {fmtDateTime(sheet.submittedAt)}</span>
          <span>經理審 {fmtDateTime(sheet.managerReviewedAt)}</span>
          <span>核准 {fmtDateTime(sheet.approvedAt)}</span>
          <span>鎖定 {fmtDateTime(sheet.lockedAt)}</span>
          {ruleVersionLabel && <span>{ruleVersionLabel}</span>}
          {sheet.returnReason && <span className="text-red-600">退回原因：{sheet.returnReason}</span>}
        </div>

        {message && <p className="no-print mb-3 text-sm text-green-600">{message}</p>}
        {error && (
          <div className="no-print mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        <div className="no-print mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void onApprove()}
            disabled={busy || !canApprove}
            className="rounded-md px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            style={{ backgroundColor: "var(--brand)" }}
          >
            核准
          </button>
          <button
            type="button"
            onClick={() => void onReturn()}
            disabled={busy || !canReturn}
            className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            退回
          </button>
          <button
            type="button"
            onClick={() => void onReopen()}
            disabled={busy || !canReopen}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            重開
          </button>
          <button
            type="button"
            onClick={() => void onRecompute()}
            disabled={busy || !canRecompute}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            重算
          </button>
          <button
            type="button"
            onClick={() => void onExport()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            匯出 xlsx
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            列印
          </button>
        </div>

        <AttendanceSheetTable sheet={sheet} editable={sheet.status !== "locked"} showMoney onPatchDay={handlePatchDay} />
      </Card>

      {snapshots && snapshots.length > 0 && (
        <Card>
          <div className="no-print mb-3">
            <h2 className="text-base font-semibold text-gray-800">歷次核准快照</h2>
            <p className="mt-1 text-sm text-gray-500">
              每次核准都會把當下的月表（含薪資試算）凍結成一份；退回／重開不會刪掉既有紀錄。點「檢視」可開出當時那一版。
            </p>
          </div>
          <div className="no-print overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">次序</th>
                  <th className="py-2 pr-4">核准時間</th>
                  <th className="py-2 pr-4">操作者</th>
                  <th className="py-2 pr-4">規則版本</th>
                  <th className="py-2 pr-4 text-right">試算淨額</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">第 {s.seq} 次</td>
                    <td className="py-2 pr-4 text-gray-600">{fmtDateTime(s.takenAt)}</td>
                    <td className="py-2 pr-4 text-gray-600">{s.takenByName ?? "—"}</td>
                    <td className="py-2 pr-4 text-gray-600">{s.ruleConfigVersion != null ? `v${s.ruleConfigVersion}` : "—"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-700">
                      {s.net != null ? Math.round(s.net).toLocaleString("zh-TW") : "—"}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => void onOpenSnapshot(s.seq)}
                        disabled={snapshotBusy}
                        className="text-sm hover:underline disabled:opacity-50"
                        style={{ color: "var(--brand)" }}
                      >
                        {openSnapshot?.seq === s.seq ? "重新載入" : "檢視"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {openSnapshot?.snapshot ? (
            <div className="mt-4 border-t border-gray-100 pt-4">
              <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-gray-600">
                  第 {openSnapshot.seq} 次核准（{fmtDateTime(openSnapshot.takenAt)}）當時的月表 — 唯讀
                </p>
                <button
                  type="button"
                  onClick={() => setOpenSnapshot(null)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700"
                >
                  關閉
                </button>
              </div>
              {/* 快照本體就是當時的 SheetView（後端 SheetSnapshot extends SheetView），直接餵同一個表格元件。 */}
              <AttendanceSheetTable sheet={openSnapshot.snapshot as SheetView} editable={false} showMoney />
            </div>
          ) : null}
        </Card>
      )}
    </>
  );
}
