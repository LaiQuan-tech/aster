"use client";

/**
 * 稽核紀錄（C1）：誰在什麼時候改了什麼。
 * 資料來自 audit_logs——DB trigger 自動寫、不可改不可刪；sql/0033 起也記操作者與端點。
 * 篩選：資料表（多選）／動作／操作者／日期範圍／關鍵字；列可展開看欄位前後值；keyset 翻頁。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import { AuditActionBadge, AuditDiffTable, actorLabel } from "@/components/AuditDrawer";
import { getEmployees, type Employee } from "@/lib/admin-api";
import {
  formatAuditTime,
  listAuditLogs,
  listAuditTables,
  type AuditAction,
  type AuditLog,
  type AuditLogsQuery,
  type AuditTable,
} from "@/lib/audit-api";

const PAGE_SIZE = 50;

/** 篩選器預設只展開常用的幾張表；其餘收在「更多」。 */
const PRIMARY_TABLES = new Set([
  "employees",
  "salary_structures",
  "payslips",
  "leave_requests",
  "approval_steps",
  "punch_records",
  "attendance_sheets",
  "projects",
  "contracts",
  "disbursements",
  "project_billings",
  "rule_configs",
  "announcements",
]);

export default function AuditLogsPage() {
  const [tables, setTables] = useState<AuditTable[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [showAllTables, setShowAllTables] = useState(false);

  // 表單值（尚未送出）
  const [selTables, setSelTables] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<AuditAction | "">("");
  const [actorEmpId, setActorEmpId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");

  // 已送出的查詢條件（翻頁沿用）
  const [applied, setApplied] = useState<AuditLogsQuery>({});
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    Promise.all([listAuditTables(), getEmployees()])
      .then(([t, e]) => {
        if (!active) return;
        setTables(t.tables);
        setEmployees(e.employees);
      })
      .catch((err) => {
        if (active) setMetaError(err instanceof Error ? err.message : "載入篩選選項失敗");
      });
    return () => {
      active = false;
    };
  }, []);

  const runQuery = useCallback(async (query: AuditLogsQuery, next: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await listAuditLogs({ ...query, limit: PAGE_SIZE, cursor: next });
      setLogs((prev) => (next ? [...prev, ...page.logs] : page.logs));
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "查詢失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  // 進頁先載最近 50 筆
  useEffect(() => {
    void runQuery({}, null);
  }, [runQuery]);

  function onSearch(event: FormEvent) {
    event.preventDefault();
    const query: AuditLogsQuery = {
      table: [...selTables],
      action,
      actorEmpId: actorEmpId || undefined,
      from: from || undefined,
      to: to || undefined,
      q: q || undefined,
    };
    setApplied(query);
    setOpenIds(new Set());
    void runQuery(query, null);
  }

  function onReset() {
    setSelTables(new Set());
    setAction("");
    setActorEmpId("");
    setFrom("");
    setTo("");
    setQ("");
    setApplied({});
    setOpenIds(new Set());
    void runQuery({}, null);
  }

  function toggleTable(t: string) {
    setSelTables((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function toggleOpen(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visibleTables = useMemo(() => {
    // 有資料的排前面，其次常用表，其餘依對照表順序
    const sorted = [...tables].sort((a, b) => Number(b.recent) - Number(a.recent));
    if (showAllTables) return sorted;
    return sorted.filter((t) => t.recent || PRIMARY_TABLES.has(t.table) || selTables.has(t.table));
  }, [tables, showAllTables, selTables]);

  const employeeOptions = useMemo(
    () => [...employees].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    [employees],
  );

  return (
    <div className="space-y-6">
      <PageHeader title="稽核紀錄" desc="誰在什麼時候改了什麼。由資料庫層自動記錄，任何人（含系統管理員）都無法修改或刪除。" />

      <Card>
        <form onSubmit={onSearch} className="space-y-4">
          <ErrorText>{metaError}</ErrorText>
          <div>
            <span className={labelCls}>資料表（可多選；不選＝全部）</span>
            <div className="flex flex-wrap gap-2">
              {visibleTables.map((t) => {
                const on = selTables.has(t.table);
                return (
                  <button
                    key={t.table}
                    type="button"
                    onClick={() => toggleTable(t.table)}
                    aria-pressed={on}
                    title={t.table}
                    className={`rounded-full border px-3 py-1 text-xs transition ${
                      on ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                    } ${!on && !t.recent ? "text-gray-400" : ""}`}
                    style={on ? { backgroundColor: "var(--brand)" } : undefined}
                  >
                    {t.label}
                  </button>
                );
              })}
              {tables.length > visibleTables.length && (
                <button type="button" onClick={() => setShowAllTables(true)} className="px-2 py-1 text-xs text-gray-500 hover:underline">
                  更多資料表…
                </button>
              )}
              {showAllTables && (
                <button type="button" onClick={() => setShowAllTables(false)} className="px-2 py-1 text-xs text-gray-500 hover:underline">
                  收合
                </button>
              )}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-5">
            <div>
              <label htmlFor="audit-action" className={labelCls}>
                動作
              </label>
              <select id="audit-action" value={action} onChange={(e) => setAction(e.target.value as AuditAction | "")} className={inputCls}>
                <option value="">全部</option>
                <option value="INSERT">新增</option>
                <option value="UPDATE">更新</option>
                <option value="DELETE">刪除</option>
              </select>
            </div>
            <div>
              <label htmlFor="audit-actor" className={labelCls}>
                操作者
              </label>
              <select id="audit-actor" value={actorEmpId} onChange={(e) => setActorEmpId(e.target.value)} className={inputCls}>
                <option value="">全部</option>
                {employeeOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {e.emp_no ? `（${e.emp_no}）` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="audit-from" className={labelCls}>
                起（含）
              </label>
              <input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="audit-to" className={labelCls}>
                迄（含）
              </label>
              <input id="audit-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label htmlFor="audit-q" className={labelCls}>
                關鍵字
              </label>
              <input
                id="audit-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="姓名／標題／單號／端點…"
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton type="submit" disabled={loading}>
              查詢
            </PrimaryButton>
            <button type="button" onClick={onReset} className="text-sm text-gray-500 hover:underline">
              清除條件
            </button>
          </div>
        </form>
      </Card>

      <Card>
        <ErrorText>{error}</ErrorText>
        {!loading && !error && logs.length === 0 && <Empty>沒有符合條件的稽核紀錄。</Empty>}
        {logs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4 font-medium">時間</th>
                  <th className="py-2 pr-4 font-medium">資料表</th>
                  <th className="py-2 pr-4 font-medium">動作</th>
                  <th className="py-2 pr-4 font-medium">操作者</th>
                  <th className="py-2 pr-4 font-medium">摘要</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const open = openIds.has(log.id);
                  return (
                    <AuditRow key={log.id} log={log} open={open} onToggle={() => toggleOpen(log.id)} />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex items-center gap-4">
          {loading && <span className="text-sm text-gray-400">載入中…</span>}
          {!loading && cursor && (
            <button type="button" onClick={() => void runQuery(applied, cursor)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
              載入更多
            </button>
          )}
          {!loading && logs.length > 0 && (
            <span className="text-xs text-gray-400">
              已顯示 {logs.length} 筆{cursor ? "" : "（已到底）"}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}

function AuditRow({ log, open, onToggle }: { log: AuditLog; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="border-b border-gray-50 align-top">
        <td className="whitespace-nowrap py-3 pr-4 text-gray-600">{formatAuditTime(log.at)}</td>
        <td className="py-3 pr-4">
          <span className="text-gray-900">{log.tableLabel}</span>
          {log.tableLabel !== log.tableName && <span className="ml-1 text-xs text-gray-400">{log.tableName}</span>}
        </td>
        <td className="py-3 pr-4">
          <AuditActionBadge action={log.action} />
        </td>
        <td className="py-3 pr-4 text-gray-700">{actorLabel(log)}</td>
        <td className="py-3 pr-4">
          <p className="text-gray-900">{log.summary}</p>
          {log.context && <p className="mt-0.5 text-xs text-gray-400">{log.context}</p>}
        </td>
        <td className="whitespace-nowrap py-3">
          <button type="button" onClick={onToggle} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
            {open ? "收合" : "詳細"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-gray-100 bg-gray-50">
          <td colSpan={6} className="px-3 py-3">
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              <span>
                來源：{log.source === "trigger" ? "資料庫觸發器（自動）" : "應用層補記"}
                {log.dbUser ? `・${log.dbUser}` : ""}
              </span>
              {log.recordId && <span>資料 ID：{log.recordId}</span>}
              <span>紀錄 ID：{log.id}</span>
            </div>
            <AuditDiffTable log={log} />
          </td>
        </tr>
      )}
    </>
  );
}
