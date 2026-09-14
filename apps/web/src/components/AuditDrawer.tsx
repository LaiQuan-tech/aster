"use client";

/**
 * 異動紀錄抽屜：某一筆資料（table + recordId）的稽核時間線，從右側滑出。
 * 掛在員工列表每列的「異動紀錄」、匯款單頁首等處；資料來自 GET /audit-logs。
 */
import { useCallback, useEffect, useState } from "react";
import {
  AUDIT_ACTION_LABELS,
  formatAuditTime,
  formatAuditValue,
  listAuditLogs,
  type AuditLog,
} from "@/lib/audit-api";

const ACTION_BADGE: Record<AuditLog["action"], string> = {
  INSERT: "bg-emerald-50 text-emerald-700",
  UPDATE: "bg-blue-50 text-blue-700",
  DELETE: "bg-red-50 text-red-700",
};

export function AuditActionBadge({ action }: { action: AuditLog["action"] }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${ACTION_BADGE[action] ?? "bg-gray-100 text-gray-600"}`}>
      {AUDIT_ACTION_LABELS[action] ?? action}
    </span>
  );
}

/** diff 表（欄位／修改前／修改後）。列表頁展開列與抽屜共用。 */
export function AuditDiffTable({ log }: { log: AuditLog }) {
  if (log.diff.length === 0) {
    return <p className="text-xs text-gray-400">沒有可比對的欄位變動（可能只更新了時間戳）。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-gray-500">
            <th className="py-1.5 pr-3 font-medium">欄位</th>
            {log.action !== "INSERT" && <th className="py-1.5 pr-3 font-medium">修改前</th>}
            {log.action !== "DELETE" && <th className="py-1.5 font-medium">修改後</th>}
          </tr>
        </thead>
        <tbody>
          {log.diff.map((d) => (
            <tr key={d.field} className="border-b border-gray-50 align-top">
              <td className="py-1.5 pr-3 text-gray-700">
                {d.label}
                {d.label !== d.field && <span className="ml-1 text-gray-400">({d.field})</span>}
              </td>
              {log.action !== "INSERT" && (
                <td className="py-1.5 pr-3 break-all text-gray-500 line-through decoration-gray-300">{formatAuditValue(d.before)}</td>
              )}
              {log.action !== "DELETE" && <td className="py-1.5 break-all text-gray-900">{formatAuditValue(d.after)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function actorLabel(log: AuditLog): string {
  if (log.actorName) return log.actorEmpNo ? `${log.actorName}（${log.actorEmpNo}）` : log.actorName;
  if (log.actorEmpId) return `已離職／未知（${log.actorEmpId.slice(0, 8)}…）`;
  return log.source === "app" ? "系統" : "系統／排程";
}

export default function AuditDrawer({
  table,
  recordId,
  title,
  onClose,
}: {
  table: string;
  recordId: string;
  title: string;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (next: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listAuditLogs({ table: [table], recordId, limit: 50, cursor: next });
        setLogs((prev) => (next ? [...prev, ...page.logs] : page.logs));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "載入異動紀錄失敗");
      } finally {
        setLoading(false);
      }
    },
    [table, recordId],
  );

  useEffect(() => {
    setLogs([]);
    setCursor(null);
    setOpenIds(new Set());
    void load(null);
  }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggle(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="no-print fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="關閉" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <aside className="relative flex h-full w-full max-w-lg flex-col bg-white shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-gray-900">{title}</h2>
            <p className="mt-0.5 text-xs text-gray-500">由資料庫層自動記錄，無法修改或刪除。最新的在最上面。</p>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:underline">
            關閉
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          {!loading && !error && logs.length === 0 && <p className="text-sm text-gray-400">這筆資料還沒有任何異動紀錄。</p>}

          <ol className="relative space-y-4 border-l border-gray-200 pl-4">
            {logs.map((log) => {
              const open = openIds.has(log.id);
              return (
                <li key={log.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-gray-300" />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                    <span>{formatAuditTime(log.at)}</span>
                    <AuditActionBadge action={log.action} />
                    {log.source === "app" && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500">應用層補記</span>}
                  </div>
                  <p className="mt-1 text-sm text-gray-900">{log.summary}</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    操作者：<span className="text-gray-700">{actorLabel(log)}</span>
                    {log.context && <span className="ml-2 text-gray-400">{log.context}</span>}
                  </p>
                  {log.diff.length > 0 && (
                    <button type="button" onClick={() => toggle(log.id)} className="mt-1 text-xs font-medium" style={{ color: "var(--brand)" }}>
                      {open ? "收合" : `看變動（${log.diff.length} 個欄位）`}
                    </button>
                  )}
                  {open && (
                    <div className="mt-2 rounded-lg bg-gray-50 p-3">
                      <AuditDiffTable log={log} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {loading && <p className="mt-3 text-sm text-gray-400">載入中…</p>}
          {!loading && cursor && (
            <button type="button" onClick={() => void load(cursor)} className="mt-4 text-sm font-medium" style={{ color: "var(--brand)" }}>
              載入更多
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
