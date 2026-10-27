import { apiFetch } from "./api-client";

/**
 * 後台出勤 › 打卡紀錄：當日總覽／週表（2026-10-27）。API：GET /attendance/punch-overview（apps/api
 * routes/punch-overview.ts）。狀態判斷全在後端（與出勤月表同一份結算計算），這裡只做顯示用的小工具。
 */

export type OverviewStatus =
  | "done"
  | "working"
  | "missing_out"
  | "missing_in"
  | "absent"
  | "not_yet"
  | "leave"
  | "business_trip"
  | "outing"
  | "wfh"
  | "off";

export type TagTone = "ok" | "info" | "warn" | "danger" | "muted";

export interface OverviewTag {
  code: string;
  label: string;
  tone: TagTone;
}

export interface PunchBrief {
  id: string | null;
  at: string;
  source: string | null;
  lat: number | null;
  lng: number | null;
  geoStatus: string | null;
  ip: string | null;
  wfh: boolean;
}

export interface OverviewDay {
  date: string;
  dayType: "workday" | "rest_day" | "regular_leave" | "fixed_holiday";
  shift: { label: string; source: string; start: string | null; end: string | null; crossesMidnight: boolean };
  in: PunchBrief | null;
  out: PunchBrief | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  leaveMinutes: number;
  status: OverviewStatus;
  statusLabel: string;
  statusTone: TagTone;
  tags: OverviewTag[];
  provisional: boolean;
}

export interface OverviewEmployee {
  id: string;
  empNo: string | null;
  name: string;
  deptId: string | null;
  deptName: string | null;
  days: OverviewDay[];
}

export interface OverviewStats {
  expected: number;
  /** 「應到」的人當中已到的（已到 ≤ 應到）。 */
  arrived: number;
  /** 假日出勤（非工作日有打卡）；不算進應到／已到。舊 API 沒有這欄。 */
  holidayWork?: number;
  late: number;
  absent: number;
  onLeave: number;
  working: number;
  missingOut: number;
  notYet: number;
}

export interface PunchOverview {
  from: string;
  to: string;
  today: string;
  timezone: string;
  dates: string[];
  employees: OverviewEmployee[];
  stats: Record<string, OverviewStats>;
  /** 回應裡有沒有 IP（只有 HR 有）。 */
  includeIp?: boolean;
}

export const MAX_RANGE_DAYS = 31;

export interface OverviewFilter {
  deptId?: string;
  employeeId?: string;
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function punchOverviewPath(range: { date?: string; from?: string; to?: string }, filter: OverviewFilter = {}): string {
  return `/attendance/punch-overview${query({ ...range, deptId: filter.deptId, employeeId: filter.employeeId })}`;
}

export function punchWeekExportPath(from: string, to: string, filter: OverviewFilter = {}): string {
  return `/attendance/punch-overview/export.xlsx${query({ from, to, deptId: filter.deptId, employeeId: filter.employeeId })}`;
}

export function getPunchOverview(range: { date?: string; from?: string; to?: string }, filter: OverviewFilter = {}) {
  return apiFetch<PunchOverview>(punchOverviewPath(range, filter));
}

/* ---------------------------------------------------------------- 日期 --- */

function parseKey(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function keyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(key: string, n: number): string {
  const d = parseKey(key);
  d.setUTCDate(d.getUTCDate() + n);
  return keyOf(d);
}

/** 兩個日期（含頭尾）共幾天。 */
export function daySpan(from: string, to: string): number {
  return Math.round((parseKey(to).getTime() - parseKey(from).getTime()) / 86_400_000) + 1;
}

/** 那一週的週一～週日（台灣習慣週一開始）。 */
export function weekOf(key: string): { from: string; to: string } {
  const wd = parseKey(key).getUTCDay(); // 0=日
  const from = addDays(key, wd === 0 ? -6 : 1 - wd);
  return { from, to: addDays(from, 6) };
}

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

/** '2026-09-01' → '9/1（二）'。 */
export function dateHeader(key: string): string {
  const d = parseKey(key);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY[d.getUTCDay()]}）`;
}

/** 檢查週表區間：回傳錯誤訊息，或 null＝可以查。 */
export function rangeError(from: string, to: string): string | null {
  if (!from || !to) return "請選擇起訖日期";
  if (from > to) return "起日不能晚於迄日";
  if (daySpan(from, to) > MAX_RANGE_DAYS) return `區間最多 ${MAX_RANGE_DAYS} 天`;
  return null;
}

/* ---------------------------------------------------------------- 時間 --- */

/** ISO → 'HH:MM'（租戶時區）。 */
export function hm(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h === "24" ? "00" : h}:${m}`;
}

/** 打卡時間；跨日（不在格子那天）加「+1」標記，例如跨夜班隔天早上的下班卡。 */
export function punchTimeLabel(iso: string, dayKey: string, tz: string): string {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const plus = local > dayKey ? daySpan(dayKey, local) - 1 : 0;
  return plus > 0 ? `${hm(iso, tz)} +${plus}` : hm(iso, tz);
}

/** 工時分鐘 → '8.5h'；0 → '—'。 */
export function fmtHours(minutes: number): string {
  if (!minutes) return "—";
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h}h`;
}

/* ---------------------------------------------------------------- 定位 --- */

/** 這張卡是否該標「無定位／定位逾時」小圖示（補登與 LINE 本來就沒有座標，不標）。 */
export function locationIssue(p: PunchBrief | null): "none" | "timeout" | null {
  if (!p) return null;
  if (p.lat != null && p.lng != null) return null;
  if (p.source === "manual" || p.source === "line") return null;
  return p.geoStatus === "timeout" ? "timeout" : "none";
}

const GEO_REASON: Record<string, string> = {
  denied: "未開啟定位權限",
  unavailable: "手機無法取得位置",
  timeout: "定位逾時",
  unsupported: "裝置不支援定位",
};

const SOURCE_LABEL: Record<string, string> = { gps: "定位打卡", web: "網頁打卡", line: "LINE 打卡", manual: "補登" };

/** popover 內容：方式、地點、IP。 */
export function punchDetail(p: PunchBrief): { source: string; location: string; ip: string } {
  const location =
    p.lat != null && p.lng != null
      ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`
      : p.source === "manual"
        ? "—（人工補登）"
        : p.source === "line"
          ? "—（LINE 打卡）"
          : `—（${GEO_REASON[p.geoStatus ?? ""] ?? "未取得定位"}）`;
  return { source: SOURCE_LABEL[p.source ?? ""] ?? p.source ?? "—", location, ip: p.ip || "—" };
}

/* ---------------------------------------------------------------- 樣式 --- */

export const TONE_CLASS: Record<TagTone, string> = {
  ok: "bg-green-50 text-green-700 ring-green-200",
  info: "bg-blue-50 text-blue-700 ring-blue-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  danger: "bg-red-50 text-red-700 ring-red-200",
  muted: "bg-gray-100 text-gray-600 ring-gray-200",
};

/** 週表格子底色：缺卡／未打卡＝淡紅、遲到早退＝淡黃、休假日＝淡灰。 */
export function weekCellClass(day: OverviewDay): string {
  if (day.status === "absent" || day.status === "missing_out" || day.status === "missing_in") return "bg-red-50";
  if (day.lateMinutes > 0 || day.earlyLeaveMinutes > 0) return "bg-amber-50";
  if (day.status === "off") return "bg-gray-50 text-gray-400";
  if (day.status === "leave" || day.status === "business_trip" || day.status === "outing" || day.status === "wfh") return "bg-blue-50/60";
  return "";
}

/** 週表格子的小標籤（最多兩個，避免格子撐高）。 */
export function weekCellBadges(day: OverviewDay): OverviewTag[] {
  const out: OverviewTag[] = [];
  if (day.status !== "done" && day.status !== "off" && day.status !== "not_yet" && (day.in || day.out)) {
    out.push({ code: day.status, label: day.statusLabel, tone: day.statusTone });
  }
  for (const t of day.tags) if (t.code === "late" || t.code === "early_leave") out.push(t);
  return out.slice(0, 2);
}
