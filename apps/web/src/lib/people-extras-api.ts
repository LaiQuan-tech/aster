/**
 * WP8「人員／公告／通知」的 client＋型別（W5、W6、M7、M8、M10、M13）。
 *
 * 對應後端：
 *   apps/api/src/routes/birthday-gifts.ts           生日紅包（M7）
 *   apps/api/src/routes/duty-rosters.ts             值日／總機輪播（M8）
 *   apps/api/src/routes/profile-change-requests.ts  員工改資料審核（W6）
 *   apps/api/src/routes/announcements.ts            年度篩選＋簽收分母（M10／W5）
 *   apps/api/src/routes/preferences.ts              通知通道偏好（M13，既有端點）
 *
 * 新功能一律開新的 lib/<feature>-api.ts，不擠 admin-api.ts（見計畫 §3.4 檔案互斥原則）。
 * 型別是手抄的：web 與 api 是各自的 build 邊界。
 */
import { apiFetch } from "./api-client";

/* ------------------------------------------------------------ 生日紅包 M7 -- */

export interface BirthdayGift {
  id: string;
  employee_id: string;
  year: number;
  given_on: string | null;
  amount: number | null;
  photo_path: string | null;
  photo_file_name: string | null;
  note: string | null;
  created_at: string;
  updated_at: string | null;
  employeeName?: string | null;
  /** 短效（900 秒）signed URL；沒照片就是 null。 */
  photoUrl?: string | null;
}

export interface BirthdayPerson {
  employeeId: string;
  name: string | null;
  /** 原始生日 YYYY-MM-DD。 */
  birthday: string;
  /** 今年實際落在哪一天（2/29 在平年＝2/28）。 */
  date: string;
  age: number | null;
  gift: BirthdayGift | null;
}

/** 當月壽星＋各自的登記狀態（month 省略＝本月，租戶時區）。 */
export function getUpcomingBirthdays(month?: string) {
  const qs = month ? `?month=${encodeURIComponent(month)}` : "";
  return apiFetch<{ month: string; year: number; birthdays: BirthdayPerson[] }>(
    `/birthday-gifts/upcoming${qs}`,
  );
}

export function listBirthdayGifts(year?: number) {
  const qs = year ? `?year=${year}` : "";
  return apiFetch<{ year: number; gifts: BirthdayGift[]; totalAmount: number }>(`/birthday-gifts${qs}`);
}

export function createBirthdayGift(body: {
  employeeId: string;
  year: number;
  givenOn?: string | null;
  amount?: number | null;
  note?: string | null;
}) {
  return apiFetch<{ gift: BirthdayGift }>("/birthday-gifts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateBirthdayGift(
  id: string,
  body: { givenOn?: string | null; amount?: number | null; note?: string | null },
) {
  return apiFetch<{ gift: BirthdayGift }>(`/birthday-gifts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function uploadBirthdayPhoto(
  id: string,
  body: { fileName: string; contentType: string; dataBase64: string },
) {
  return apiFetch<{ id: string; fileName: string; sizeBytes: number; photoUrl: string | null }>(
    `/birthday-gifts/${id}/photo`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function deleteBirthdayPhoto(id: string) {
  return apiFetch<{ id: string; removed: boolean }>(`/birthday-gifts/${id}/photo`, {
    method: "DELETE",
  });
}

/* --------------------------------------------------- 值日／總機輪播 M8 -- */

export type DutyType = "duty" | "reception";

export const DUTY_LABEL: Record<DutyType, string> = {
  duty: "值日",
  reception: "總機",
};

export interface DutyRoster {
  id: string;
  duty_type: DutyType;
  work_date: string;
  employee_id: string;
  batch_id: string | null;
  note: string | null;
  employeeName: string | null;
}

export function listDutyRosters(params: { from: string; to: string; dutyType?: DutyType }) {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  if (params.dutyType) qs.set("dutyType", params.dutyType);
  return apiFetch<{ from: string; to: string; rosters: DutyRoster[] }>(`/duty-rosters?${qs}`);
}

export function generateDutyRoster(body: {
  dutyType: DutyType;
  participantEmpIds: string[];
  from: string;
  to: string;
  replaceExisting?: boolean;
  startEmpId?: string;
}) {
  return apiFetch<{
    batchId: string | null;
    created: number;
    skipped: number;
    replaced: number;
    workdays: number;
  }>("/duty-rosters/generate", { method: "POST", body: JSON.stringify(body) });
}

export function updateDutyRoster(id: string, body: { employeeId?: string; note?: string | null }) {
  return apiFetch<{ roster: DutyRoster }>(`/duty-rosters/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteDutyRoster(id: string) {
  return apiFetch<{ id: string }>(`/duty-rosters/${id}`, { method: "DELETE" });
}

export interface DutyToday {
  date: string;
  duty: { employeeId: string; name: string | null } | null;
  reception: { employeeId: string; name: string | null } | null;
}

export function getDutyToday() {
  return apiFetch<DutyToday>("/duty-rosters/today");
}

/* --------------------------------------------- 員工改資料審核 W6 -- */

export type ProfileChangeStatus = "pending" | "approved" | "rejected";

export interface ProfileChangeField {
  column: string;
  label: string;
  from: unknown;
  to: unknown;
}

export interface ProfileChangeRequest {
  id: string;
  employee_id: string;
  requested_by_emp_id: string | null;
  status: ProfileChangeStatus;
  reviewed_by_emp_id: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  created_at: string;
  employeeName: string | null;
  reviewedByName: string | null;
  fields: ProfileChangeField[];
}

/** HR 拿全部；一般員工只拿到自己的（後端依角色過濾，ESS 橫幅用同一支）。 */
export function listProfileChangeRequests(status: ProfileChangeStatus | "all" = "pending") {
  return apiFetch<{ requests: ProfileChangeRequest[] }>(
    `/profile-change-requests?status=${status}`,
  );
}

export function approveProfileChange(id: string, comment?: string) {
  return apiFetch<{ id: string; status: "approved"; applied: string[] }>(
    `/profile-change-requests/${id}/approve`,
    { method: "POST", body: JSON.stringify(comment ? { comment } : {}) },
  );
}

export function rejectProfileChange(id: string, reason: string) {
  return apiFetch<{ id: string; status: "rejected" }>(`/profile-change-requests/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/* ------------------------------------------- 公告年度篩選／簽收分母 M10／W5 -- */

export interface AnnouncementListItem {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  audience: string | null;
  created_by: string | null;
  current_version_id: string | null;
  created_at: string;
  updated_at: string | null;
  requires_signature: boolean;
  version_no: number | null;
  /** 我第一次查閱現行版的時間；null＝尚未查閱。 */
  viewed_at?: string | null;
}

/** `/announcements?year=&month=`（租戶時區歸年）。都不帶＝全部。 */
export function listAnnouncementsBy(params: { year?: number | null; month?: number | null } = {}) {
  const qs = new URLSearchParams();
  if (params.year) qs.set("year", String(params.year));
  if (params.month) qs.set("month", String(params.month).padStart(2, "0"));
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiFetch<{ announcements: AnnouncementListItem[] }>(`/announcements${suffix}`);
}

export function getAnnouncementYears() {
  return apiFetch<{ years: number[] }>("/announcements/years");
}

/**
 * 發佈公告（含「需簽收」旗標）。admin-api 的 createAnnouncement 只收標題與內文，
 * 但 W5 的整套分母都建立在「發佈當下就 seed 待簽列」，旗標必須能從後台勾。
 * `seeded`＝這次建出的待簽列數（＝當時的在職員工數）。
 */
export function publishAnnouncement(body: {
  title: string;
  body: string;
  audience?: string;
  requiresSignature?: boolean;
  isAdverseChange?: boolean;
  effectiveFrom?: string;
  changeNote?: string;
}) {
  return apiFetch<{ id: string; versionId: string; versionNo: number; seeded: number }>(
    "/announcements",
    { method: "POST", body: JSON.stringify(body) },
  );
}

export interface AnnouncementAckRow {
  id: string;
  employee_id: string;
  kind: "consent_to_change" | "accept_on_hire";
  viewed_at: string | null;
  signed_at: string | null;
  signature_sheet_id: string | null;
  note: string | null;
}

/** 與 admin-api 的 getAnnouncementAcks 同一支端點，多回 W5 的在職分母。 */
export function getAnnouncementAckSummary(id: string, versionId?: string) {
  return apiFetch<{
    versionId: string | null;
    signed: AnnouncementAckRow[];
    pending: AnnouncementAckRow[];
    consentRate: { signed: number; total: number } | null;
    /** 在職員工數＝「20 個人 5 個沒簽」的那個 20。 */
    activeEmployeeCount: number;
  }>(`/announcements/${id}/acknowledgements${versionId ? `?versionId=${versionId}` : ""}`);
}

/** 對既有版本補建待簽列（上線一次性；不需簽收的版本回 409）。 */
export function seedAnnouncementAcks(id: string, versionId?: string) {
  return apiFetch<{ versionId: string; seeded: number; activeEmployeeCount: number }>(
    `/announcements/${id}/acknowledgements/seed`,
    { method: "POST", body: JSON.stringify(versionId ? { versionId } : {}) },
  );
}

/* ------------------------------------------------------ 通知通道偏好 M13 -- */

export const NOTIFY_CHANNELS_KEY = "notify.channels.v1";

/** 只有明示 false 才停送；沒設過＝依系統預設投遞。 */
export interface NotifyChannelPrefs {
  email?: boolean;
  line?: boolean;
}

export async function getNotifyChannels(): Promise<NotifyChannelPrefs> {
  const res = await apiFetch<{ preference: { value: NotifyChannelPrefs | null } }>(
    `/preferences/${NOTIFY_CHANNELS_KEY}`,
  );
  const value = res.preference?.value;
  return value && typeof value === "object" ? value : {};
}

export function putNotifyChannels(value: NotifyChannelPrefs) {
  return apiFetch<{ preference: { value: NotifyChannelPrefs } }>(
    `/preferences/${NOTIFY_CHANNELS_KEY}`,
    { method: "PUT", body: JSON.stringify({ value }) },
  );
}
