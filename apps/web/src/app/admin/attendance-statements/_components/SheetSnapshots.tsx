"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorText } from "@/components/admin-ui";
import { AttendanceSheetTable } from "@/components/AttendanceSheetTable";
import { friendlyError, type SheetView } from "@/lib/attendance-sheets-api";
import { listSheetSnapshots, type SheetSnapshotSummary } from "@/lib/backup-api";

/**
 * M9 歷次核准快照（原 /admin/attendance-sheets/[id] 詳細頁下半部，2026-11-09 搬來出勤統計表合併頁）：
 * 每次核准都凍結一份（退回／重開不刪）；列表不帶 full，點「檢視」才抓整份。非關鍵路徑——讀不到（非 HR、
 * 舊環境沒有快照表）就整塊不顯示。
 */

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function SheetSnapshots({ sheetId, reloadKey }: { sheetId: string; reloadKey: string }) {
  const [snapshots, setSnapshots] = useState<SheetSnapshotSummary[] | null>(null);
  const [openSnapshot, setOpenSnapshot] = useState<SheetSnapshotSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listSheetSnapshots(sheetId);
      setSnapshots(res.snapshots);
    } catch {
      setSnapshots([]);
    }
  }, [sheetId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  async function onOpen(seq: number) {
    setBusy(true);
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
      setBusy(false);
    }
  }

  if (!snapshots || snapshots.length === 0) return null;

  return (
    <section aria-label="歷次核准快照" className="rounded-xl border border-gray-100 p-3">
      <h3 className="text-sm font-semibold text-gray-800">歷次核准快照</h3>
      <p className="mt-1 text-xs text-gray-500">
        每次核准都會把當下的月表（含薪資試算）凍結成一份；退回／重開不會刪掉既有紀錄。點「檢視」可開出當時那一版。
      </p>
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="mt-2 overflow-x-auto">
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
                    onClick={() => void onOpen(s.seq)}
                    disabled={busy}
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
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
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
          <div className="overflow-x-auto">
            {/* 快照本體就是當時的 SheetView（後端 SheetSnapshot extends SheetView）。 */}
            <AttendanceSheetTable sheet={openSnapshot.snapshot as SheetView} editable={false} showMoney preferenceScope="admin" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
