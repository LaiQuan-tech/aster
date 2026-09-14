/**
 * C1 稽核查詢 API（HR only）。Shapes mirror apps/api/src/routes/audit-logs.ts。
 *
 * 每一列是 audit_logs 的一筆：DB trigger 寫的（source='trigger'，改了什麼＋誰改的）
 * 或應用層 writeAuditLog 補的（source='app'，為什麼／哪支端點）。
 */
import { apiFetch } from "./api-client";

export type AuditAction = "INSERT" | "UPDATE" | "DELETE";

export interface AuditDiffEntry {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface AuditLog {
  id: string;
  at: string;
  tableName: string;
  tableLabel: string;
  recordId: string | null;
  recordLabel: string | null;
  action: AuditAction;
  actorEmpId: string | null;
  actorName: string | null;
  actorEmpNo: string | null;
  dbUser: string | null;
  source: "trigger" | "app";
  context: string | null;
  summary: string;
  diff: AuditDiffEntry[];
}

export interface AuditLogsQuery {
  table?: string[];
  recordId?: string;
  action?: AuditAction | "";
  actorEmpId?: string;
  from?: string; // YYYY-MM-DD（租戶時區當天）或 ISO
  to?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface AuditLogsPage {
  logs: AuditLog[];
  nextCursor: string | null;
}

export interface AuditTable {
  table: string;
  label: string;
  /** 該租戶最近 3000 列稽核裡出現過（有資料的排前面）。 */
  recent: boolean;
}

export function listAuditLogs(query: AuditLogsQuery = {}) {
  const params = new URLSearchParams();
  if (query.table?.length) params.set("table", query.table.join(","));
  if (query.recordId) params.set("recordId", query.recordId);
  if (query.action) params.set("action", query.action);
  if (query.actorEmpId) params.set("actorEmpId", query.actorEmpId);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const qs = params.toString();
  return apiFetch<AuditLogsPage>(`/audit-logs${qs ? `?${qs}` : ""}`);
}

export function listAuditTables() {
  return apiFetch<{ tables: AuditTable[] }>("/audit-logs/tables");
}

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  INSERT: "新增",
  UPDATE: "更新",
  DELETE: "刪除",
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function formatAuditTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** diff 的值 → 可讀字串：null 顯示「—」、布林顯示 是／否、ISO 時間轉台北時間、物件轉 JSON。 */
export function formatAuditValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return ISO_RE.test(v) ? formatAuditTime(v) : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return String(v);
  }
}
