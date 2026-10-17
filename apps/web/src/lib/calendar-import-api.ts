/**
 * 國定假日年度匯入（apps/api routes/calendar-import.ts、services/holiday-import.ts）client + 型別。
 * 型別手抄自 API（web 與 api 是各自的 build 邊界），以後端實際回應為準。
 */
import { apiFetch } from "./api-client";

export type HolidayKind = "holiday" | "make_up" | "adjusted" | "extra";

export interface DraftHoliday {
  date: string;
  label: string;
  kind: HolidayKind;
  /** official：落在政府週六日；草稿 holidays：落在公司例假／休息日。 */
  weekend: boolean;
  makeUpFor?: string | null;
  /** 核准時是否寫入；未設＝依 kind（調整放假預設不採用）。 */
  adopt?: boolean;
  /** 系統附註（為何預設不採用等）。 */
  note?: string | null;
}

/** 這一天核准時會不會寫進行事曆（與 API isAdopted 相同）。 */
export function isAdopted(h: Pick<DraftHoliday, "kind" | "adopt">): boolean {
  return h.adopt ?? h.kind !== "adjusted";
}

export interface WeekendPolicy {
  regularLeaveWeekday: number;
  restDayWeekday: number;
}

export interface PendingRevision {
  officialKey: string;
  fetchedAt: string;
  source: "dgpa" | "ntpc";
  added: { date: string; label: string; kind: HolidayKind }[];
  removed: { date: string; label: string; kind: HolidayKind }[];
  kindChanged: { date: string; from: HolidayKind; to: HolidayKind }[];
}

export interface CalendarDiffItem {
  date: string;
  weekday: number;
  kind: "only_primary" | "only_backup" | "workday_adjustment";
  primaryLabel: string | null;
  backupLabel: string | null;
}

export interface CalendarDiff {
  available: boolean;
  backupSource: "ntpc";
  reason?: string;
  items: CalendarDiffItem[];
}

export interface DraftPayload {
  year: number;
  source: "dgpa" | "ntpc";
  resource: { url: string; description: string; version: string };
  official: {
    holidays: DraftHoliday[];
    workdayAdjustments: { date: string; label: string }[];
    ignored: { date: string; label: string; reason: string }[];
    warnings: string[];
  };
  holidays: DraftHoliday[];
  edited: boolean;
  editedAt?: string | null;
  fetchErrors: string[];
  policy?: WeekendPolicy;
  tenantWarnings?: string[];
  /** 官方有新版、但草稿已被 HR 編輯 → 沒取代，提示用。 */
  pendingRevision?: PendingRevision | null;
}

export interface ImportDraft {
  id: string;
  year: number;
  source: "dgpa" | "ntpc";
  fetched_at: string;
  payload: DraftPayload;
  diff: CalendarDiff | null;
  status: "draft" | "approved" | "superseded";
  approved_by_emp_id: string | null;
  approved_at: string | null;
  created_at: string;
}

export interface PreviewChange {
  date: string;
  weekday: number;
  current: { dayType: string; label: string | null; source: string | null } | null;
  next: { dayType: string; label: string | null } | null;
  action: "add" | "change" | "remove" | "keep_manual" | "locked";
}

export interface DraftPreview {
  changes: PreviewChange[];
  counts: Record<PreviewChange["action"], number>;
  /** 已結算（發薪鎖）月份，核准時不改。 */
  closedPeriods?: string[];
}

export interface CalendarReadiness {
  date: string;
  ready: boolean;
  years: { year: number; status: "approved" | "legacy" | "pending_draft" | "missing"; approvedAt: string | null; draftId: string | null }[];
  missing: number[];
}

export function fetchHolidayDraft(year: number) {
  return apiFetch<{ draft: ImportDraft; preview: DraftPreview }>("/calendar/import/fetch", {
    method: "POST",
    body: JSON.stringify({ year }),
  });
}

export function listHolidayDrafts(year?: number) {
  return apiFetch<{ drafts: ImportDraft[] }>(`/calendar/import/drafts${year ? `?year=${year}` : ""}`);
}

export function getHolidayDraft(id: string) {
  return apiFetch<{ draft: ImportDraft; preview: DraftPreview }>(`/calendar/import/drafts/${encodeURIComponent(id)}`);
}

export function updateHolidayDraft(
  id: string,
  holidays: { date: string; label: string; kind?: HolidayKind; makeUpFor?: string | null; adopt?: boolean; note?: string | null }[],
) {
  return apiFetch<{ draft: ImportDraft; preview: DraftPreview }>(`/calendar/import/drafts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ holidays }),
  });
}

export function approveHolidayDraft(id: string) {
  return apiFetch<{
    draft: ImportDraft;
    calendar: {
      generated: number;
      imported: number;
      skipped: number;
      pruned?: number;
      lockedUnchanged?: { date: string; current: string; planned: string | null }[];
      lockedPeriods?: string[];
    };
    warnings: string[];
  }>(
    `/calendar/import/drafts/${encodeURIComponent(id)}/approve`,
    { method: "POST" },
  );
}

export function getCalendarReadiness(date?: string) {
  return apiFetch<CalendarReadiness>(`/calendar/readiness${date ? `?date=${date}` : ""}`);
}

/** 改例假／休息日設定後，依新週休重新產生未結算月份的行事曆（已結算月份、HR 手動列不動）。 */
export function regenerateCalendar(years?: number[]) {
  return apiFetch<{
    years: { year: number; holidaySource: "approved_draft" | "builtin" | "none"; removedStaleWeekend: number; lockedPeriods: string[]; calendar: { generated: number; imported: number; skipped: number } }[];
    warnings: string[];
  }>("/calendar/import/regenerate", { method: "POST", body: JSON.stringify(years ? { years } : {}) });
}
