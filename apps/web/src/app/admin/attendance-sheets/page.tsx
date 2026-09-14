"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import { getDepartments, type Department } from "@/lib/admin-api";
import {
  listAttendanceSheets,
  generateAttendanceSheets,
  exportAttendanceSheetsXlsx,
  friendlyError,
  SHEET_STATUS_LABEL,
  type SheetListItem,
  type SheetStatus,
} from "@/lib/attendance-sheets-api";
import {
  closePeriod,
  listPeriodCloses,
  reopenPeriod,
  NOT_READY_STATUS_LABEL,
  type NotReadySheet,
  type PeriodClose,
} from "@/lib/backup-api";

const currentPeriod = new Date().toISOString().slice(0, 7);

const STATUS_OPTIONS: (SheetStatus | "")[] = [
  "",
  "draft",
  "submitted",
  "manager_reviewed",
  "approved",
  "locked",
  "returned",
];

const STATUS_TILES: SheetStatus[] = ["draft", "submitted", "manager_reviewed", "approved", "locked", "returned"];

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function otAlertClass(alert: SheetListItem["overtimeMonthlyAlert"]): string {
  if (alert === "46") return "text-red-700 font-semibold";
  if (alert === "40") return "text-orange-600 font-semibold";
  if (alert === "36") return "text-amber-600 font-semibold";
  return "text-gray-700";
}

export default function AttendanceSheetsPage() {
  const [period, setPeriod] = useState(currentPeriod);
  const [status, setStatus] = useState<SheetStatus | "">("");
  const [deptId, setDeptId] = useState("");
  const [onlyAnomaly, setOnlyAnomaly] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [sheets, setSheets] = useState<SheetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // C3 整公司月結 Final：這個月的 period_closes 紀錄（沒有＝尚未月結）＋按下去被擋時的未核准清單。
  const [periodClose, setPeriodClose] = useState<PeriodClose | null>(null);
  const [notReady, setNotReady] = useState<NotReadySheet[] | null>(null);
  const [closing, setClosing] = useState(false);

  const loadPeriodClose = useCallback(async () => {
    try {
      const res = await listPeriodCloses(period);
      setPeriodClose(res.closes[0] ?? null);
    } catch {
      setPeriodClose(null);
    }
  }, [period]);

  useEffect(() => {
    setNotReady(null);
    void loadPeriodClose();
  }, [loadPeriodClose]);

  async function onClosePeriod(force: boolean) {
    const question = force
      ? `確定只鎖定 ${period} 已核准的月表、略過未核准的，強制完成整公司月結？`
      : `確定要對 ${period} 做整公司月結（Final）？所有已核准的出勤月表會被鎖定，之後不可再修改。`;
    if (!window.confirm(question)) return;
    setClosing(true);
    setError(null);
    setMessage(null);
    try {
      const outcome = await closePeriod(period, force);
      if (!outcome.ok) {
        setNotReady(outcome.sheets);
        setError(`${period} 尚有 ${outcome.sheets.length} 位員工的月表未核准，無法月結（清單見下方）。`);
        return;
      }
      setNotReady(null);
      const r = outcome.result;
      setMessage(
        `${period} 已完成整公司月結 Final：共 ${r.sheetCount} 張月表、${r.lockedCount} 張已鎖定（本次新鎖 ${r.lockedNow} 張）${
          r.skipped.length > 0 ? `，略過 ${r.skipped.length} 張未核准` : ""
        }。`,
      );
      await Promise.all([loadPeriodClose(), load()]);
    } catch (err) {
      setError(friendlyError(err, "月結失敗"));
    } finally {
      setClosing(false);
    }
  }

  async function onReopenPeriod() {
    const reason = window.prompt(`重開 ${period} 的整公司月結？請輸入理由（月表本身不會解鎖，要改哪張再個別重開）：`);
    if (!reason || !reason.trim()) return;
    setClosing(true);
    setError(null);
    setMessage(null);
    try {
      await reopenPeriod(period, reason.trim());
      setMessage(`${period} 月結已標記為重開。`);
      await loadPeriodClose();
    } catch (err) {
      setError(friendlyError(err, "重開失敗"));
    } finally {
      setClosing(false);
    }
  }

  // 當月還沒有月表時（例如月初、或 demo 資料在別的月份），自動往前找最近一個有月表的月份，
  // 免得老闆打開看到一片空白。只在「沒套任何篩選」且是第一次載入時做，最多往回找 12 個月。
  const autoJumped = useRef(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAttendanceSheets({
        period,
        status: status || undefined,
        deptId: deptId || undefined,
        anomaly: onlyAnomaly || undefined,
      });
      if (res.sheets.length === 0 && !autoJumped.current && !status && !deptId && !onlyAnomaly) {
        autoJumped.current = true;
        for (let back = 1; back <= 12; back += 1) {
          const [y, m] = period.split("-").map(Number);
          const d = new Date(Date.UTC(y, m - 1 - back, 1));
          const candidate = d.toISOString().slice(0, 7);
          const prev = await listAttendanceSheets({ period: candidate });
          if (prev.sheets.length > 0) {
            setPeriod(candidate);
            setMessage(`${period} 尚無月表，已切到最近有資料的 ${candidate}`);
            return;
          }
        }
      }
      setSheets(res.sheets);
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [deptId, onlyAnomaly, period, status]);

  useEffect(() => {
    getDepartments()
      .then((res) => setDepartments(res.departments))
      .catch(() => null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const byStatus: Partial<Record<SheetStatus, number>> = {};
    let pendingApproval = 0;
    let hasError = 0;
    for (const row of sheets) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.status === "manager_reviewed") pendingApproval += 1;
      if (row.anomalyCount.error > 0) hasError += 1;
    }
    return { byStatus, pendingApproval, hasError };
  }, [sheets]);

  async function onGenerate() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await generateAttendanceSheets(period);
      setMessage(`已產生 ${res.generated} 張、重建 ${res.rebuilt} 張、略過 ${res.skipped.length} 張（非在職期間）`);
      await load();
    } catch (err) {
      setError(friendlyError(err, "產生失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function onExportAll() {
    setError(null);
    try {
      await exportAttendanceSheetsXlsx(period, `出勤月表_${period}.xlsx`);
    } catch (err) {
      setError(friendlyError(err, "匯出失敗"));
    }
  }

  return (
    <>
      <PageHeader title="出勤月表 · 月結簽核" desc="依月份彙整全員出勤月表，追蹤送出／審核進度、產生本月與匯出" />

      <Card>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">月份</label>
            <MonthPicker value={period} onChange={setPeriod} disabled={loading} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">狀態</label>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as SheetStatus | "")}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt || "all"} value={opt}>
                  {opt ? SHEET_STATUS_LABEL[opt] : "全部"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">部門</label>
            <select
              value={deptId}
              onChange={(event) => setDeptId(event.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
            >
              <option value="">全部部門</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-gray-600">
            <input type="checkbox" checked={onlyAnomaly} onChange={(event) => setOnlyAnomaly(event.target.checked)} />
            只看異常
          </label>
          <PrimaryButton type="button" onClick={() => void load()}>
            搜尋
          </PrimaryButton>
          <button
            type="button"
            onClick={() => void onGenerate()}
            disabled={busy}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            產生本月
          </button>
          <button
            type="button"
            onClick={() => void onExportAll()}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            匯出全員 xlsx
          </button>
          {periodClose?.status === "closed" ? (
            <button
              type="button"
              onClick={() => void onReopenPeriod()}
              disabled={closing}
              className="rounded-md border border-amber-300 px-4 py-2 text-sm font-medium text-amber-700 disabled:opacity-50"
            >
              重開月結
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onClosePeriod(false)}
              disabled={closing || loading}
              title="該月所有在職員工的月表都已核准後，一鍵鎖定並記錄整公司月結 Final"
              className="rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ backgroundColor: "#166534" }}
            >
              {closing ? "月結中…" : "本月 Final 月結"}
            </button>
          )}
        </div>

        {periodClose && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="period-close-badge">
            {periodClose.status === "closed" ? (
              <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700">已月結 Final</span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">月結已重開</span>
            )}
            <span className="text-gray-600">
              {fmtDateTime(periodClose.closedAt)}
              {periodClose.closedByName ? ` · ${periodClose.closedByName}` : ""} · {periodClose.lockedCount}/{periodClose.sheetCount} 張已鎖定
              {periodClose.note ? ` · ${periodClose.note}` : ""}
            </span>
          </div>
        )}

        {message && <p className="mb-3 text-sm text-green-600">{message}</p>}
        {error && (
          <div className="mb-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}
        {notReady && notReady.length > 0 && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
            <p className="font-medium text-amber-800">尚未核准，月結被擋下：</p>
            <ul className="mt-2 grid gap-1 md:grid-cols-2">
              {notReady.map((n) => (
                <li key={n.employeeId} className="flex items-center justify-between gap-2 text-amber-900">
                  <span>{n.employeeName}</span>
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs">{NOT_READY_STATUS_LABEL[n.status]}</span>
                    {n.sheetId && (
                      <Link href={`/admin/attendance-sheets/${n.sheetId}`} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>
                        檢視
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => void onClosePeriod(true)}
              disabled={closing}
              className="mt-3 rounded-md border border-amber-400 px-3 py-1.5 text-xs font-medium text-amber-800 disabled:opacity-50"
            >
              只鎖已核准的（強制月結，略過上列）
            </button>
          </div>
        )}

        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">總張數</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{sheets.length}</p>
          </div>
          {STATUS_TILES.map((s) => (
            <div key={s} className="rounded-xl bg-gray-50 p-4">
              <p className="text-xs text-gray-500">{SHEET_STATUS_LABEL[s]}</p>
              <p className="mt-1 text-xl font-semibold text-gray-800">{stats.byStatus[s] ?? 0}</p>
            </div>
          ))}
          <div className="rounded-xl bg-blue-50 p-4">
            <p className="text-xs text-blue-600">待核准</p>
            <p className="mt-1 text-xl font-semibold text-blue-700">{stats.pendingApproval}</p>
          </div>
          <div className="rounded-xl bg-red-50 p-4">
            <p className="text-xs text-red-600">有 error 異常</p>
            <p className="mt-1 text-xl font-semibold text-red-700">{stats.hasError}</p>
          </div>
        </div>

        {loading ? (
          <Empty>載入中…</Empty>
        ) : sheets.length === 0 ? (
          <Empty>{period} 查無出勤月表，可先點「產生本月」</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3">部門</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2 pr-3 text-right">加班累計</th>
                  <th className="py-2 pr-3">異常 error/warn</th>
                  <th className="py-2 pr-3">送出／核准時間</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50">
                    <td className="py-2 pr-3 font-medium text-gray-800">
                      {row.employeeNo ? `${row.employeeNo} · ${row.employeeName}` : row.employeeName}
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{row.department ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                        {SHEET_STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td className={`py-2 pr-3 text-right tabular-nums ${otAlertClass(row.overtimeMonthlyAlert)}`}>
                      {(row.otTotalMinutes / 60).toFixed(1)}h
                      {row.overtimeMonthlyAlert !== "none" && ` (${row.overtimeMonthlyAlert})`}
                    </td>
                    <td className="py-2 pr-3">
                      {row.anomalyCount.error > 0 && (
                        <span className="mr-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                          error×{row.anomalyCount.error}
                        </span>
                      )}
                      {row.anomalyCount.warn > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                          warn×{row.anomalyCount.warn}
                        </span>
                      )}
                      {row.anomalyCount.error === 0 && row.anomalyCount.warn === 0 && <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      送出 {fmtDateTime(row.submittedAt)}
                      <br />
                      核准 {fmtDateTime(row.approvedAt)}
                    </td>
                    <td className="py-2">
                      <Link
                        href={`/admin/attendance-sheets/${row.id}`}
                        className="text-sm hover:underline"
                        style={{ color: "var(--brand)" }}
                      >
                        檢視
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
