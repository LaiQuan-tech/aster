"use client";

import { SHEET_STATUS_LABEL } from "@/lib/attendance-sheets-api";
import { otAlertClass, type RosterRow } from "@/lib/attendance-statements-page";

/**
 * 出勤統計表合併頁左側的員工清單（2026-11-09；取代原「出勤月表」列表頁的每員工一列）：
 * 工號姓名、月表狀態、異常數（需處理紅／提醒黃）、加班累計與 36／40／46 小時警示、送出／核准時間；點選＝右側顯示該員工。
 */

function fmtShort(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function EmployeeRoster({
  rows,
  selectedId,
  onSelect,
  deptName,
}: {
  rows: readonly RosterRow[];
  selectedId: string;
  onSelect: (employeeId: string) => void;
  deptName: (deptId: string | null) => string | null;
}) {
  if (rows.length === 0) return <p className="px-3 py-6 text-center text-sm text-gray-500">沒有符合條件的員工</p>;
  return (
    <ul className="divide-y divide-gray-100" aria-label="員工清單">
      {rows.map((row) => {
        const s = row.sheet;
        const selected = row.employeeId === selectedId;
        const dept = deptName(row.deptId ?? s?.deptId ?? null) ?? s?.department ?? null;
        return (
          <li key={row.employeeId}>
            <button
              type="button"
              onClick={() => onSelect(row.employeeId)}
              aria-current={selected ? "true" : undefined}
              className={`block w-full px-3 py-2 text-left ${selected ? "bg-gray-100" : "hover:bg-gray-50"}`}
              style={selected ? { boxShadow: "inset 3px 0 0 var(--brand)" } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-gray-900">
                  {row.empNo ? `${row.empNo} · ${row.name}` : row.name}
                  {!row.active && <span className="ml-1 text-xs font-normal text-gray-400">已離職</span>}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${s ? "bg-gray-100 text-gray-700" : "bg-white text-gray-400 ring-1 ring-gray-200"}`}
                >
                  {s ? SHEET_STATUS_LABEL[s.status] : "無月表"}
                </span>
              </div>
              {s && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {dept && <span className="text-gray-400">{dept}</span>}
                  <span className={`tabular-nums ${otAlertClass(s.overtimeMonthlyAlert)}`}>
                    加班 {(s.otTotalMinutes / 60).toFixed(1)}h{s.overtimeMonthlyAlert !== "none" && ` (${s.overtimeMonthlyAlert})`}
                  </span>
                  {s.anomalyCount.error > 0 && (
                    <span className="rounded-full bg-red-100 px-1.5 text-red-700">需處理 {s.anomalyCount.error}</span>
                  )}
                  {s.anomalyCount.warn > 0 && (
                    <span className="rounded-full bg-amber-100 px-1.5 text-amber-700">提醒 {s.anomalyCount.warn}</span>
                  )}
                  {(s.submittedAt || s.approvedAt) && (
                    <span className="w-full text-gray-400">
                      送出 {fmtShort(s.submittedAt)}・核准 {fmtShort(s.approvedAt)}
                    </span>
                  )}
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
