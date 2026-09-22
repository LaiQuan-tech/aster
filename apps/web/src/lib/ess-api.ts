/**
 * Typed ESS API calls. Shapes mirror the @hr/api responses exactly
 * (see apps/api/src/routes/{tenant,punch,announcements,requests,leave-types}.ts).
 */
import { apiFetch } from "./api-client";

export interface Branding {
  primaryColor?: string;
  appName?: string;
  logoUrl?: string;
}

export interface Me {
  id: string;
  name: string;
  role: string;
  deptId: string | null;
  empNo: string | null;
  status: string;
  email: string | null;
  /** 身分類別（employees.employment_type）；舊版 API 沒有這個欄位，讀取要 optional。 */
  employmentType?: string | null;
  /**
   * 可見的 ESS 分頁 key 清單（tenants.features.essTabs[employment_type]）；
   * null／undefined＝全部可見。過濾邏輯在 lib/ess-tabs.ts。
   */
  essTabs?: string[] | null;
  /** 是否為任一部門主管（後端可選欄位；沒有時前端改用「待我簽核」筆數判斷）。 */
  isManager?: boolean;
  mustChangePassword?: boolean;
}

/** The caller's own employee profile; used to detect HR admins in the ESS. */
export function getMe() {
  return apiFetch<Me>("/me");
}

// 角色判定收斂到 lib/roles.ts；此處 re-export 維持既有 import 相容。
export { isAdminRole } from "./roles";

export interface BrandingResponse {
  branding: Branding | null;
  features: Record<string, unknown> | null;
}

export interface PunchRecord {
  id: string;
  tenant_id: string;
  employee_id: string;
  punch_at: string;
  type: "in" | "out";
  source: string | null;
  lat: number | null;
  lng: number | null;
  device_id: string | null;
}

export interface PunchTodayResponse {
  records: PunchRecord[];
  status: "working" | "off";
}

export interface PunchResult {
  id: string;
  type: "in" | "out";
  punchAt: string;
  /** 以下為 2026-09 新版 POST /punch 才回的欄位（舊 API 沒有，讀取要 optional）。 */
  source?: string | null;
  lat?: number | null;
  lng?: number | null;
  deviceId?: string | null;
  /** 完整的 punch_records 列，讓首頁可以樂觀更新今日紀錄再對齊 GET /punch/today。 */
  record?: PunchRecord;
}

/**
 * POST /punch 冷卻期內重複打卡 → `409 punch_too_soon`（伺服器端防呆，預設 60 秒）。
 * apiFetch 會把 status 與 error code 收進 Error（`[409] punch_too_soon`），這裡判斷用。
 */
export function isPunchTooSoon(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: number }).status;
  return status === 409 && err.message.includes("punch_too_soon");
}

export interface Announcement {
  id: string;
  tenant_id: string;
  title: string;
  body: string;
  audience: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
  /** 現行版指標（用來記錄查閱）。 */
  current_version_id: string | null;
  /** 現行版是否需簽收；只有需簽收的規章才記錄查閱。 */
  requires_signature: boolean;
  version_no: number | null;
  /** 我第一次查閱現行版的時間；null＝尚未查閱。舊 API 沒有這個欄位（undefined＝未知）。 */
  viewed_at?: string | null;
}

/**
 * 記錄自己查閱了某一版公告（只寫 viewed_at，伺服器只保留**第一次**）。
 *
 * 這是**被動的查閱紀錄，不是「勾選同意」**——客戶明確排斥後者。
 * 它證明「已發給且可取得」，滿足勞基法施行細則 §37 的揭示／發給義務。
 * 失敗不影響畫面，故呼叫端一律 catch 掉。
 */
export function recordAnnouncementView(versionId: string) {
  return apiFetch<{ acknowledgement: unknown }>(
    `/announcement-versions/${versionId}/acknowledge`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type RequestKind =
  | "leave"
  | "ot"
  | "fix_punch"
  | "business_trip"
  /** 零用金預支（模組三第 3 條），走與出差預支相同的簽核管線。 */
  | "petty_cash"
  /** 在家工作（M2，2026-09-23）：只用 startAt／endAt／hours／reason；核准日無打卡以班表淨工時計。 */
  | "wfh";

/** 加班單超過月上限的標記明細（M1；services/overtime-cap.ts beyondCapCheck）。 */
export interface BeyondCapDetail {
  approvedBeforeMinutes: number;
  requestedMinutes: number;
  capMinutes: number;
  beyondCapMinutes?: number;
}

export interface LeaveRequest {
  id: string;
  tenant_id: string;
  employee_id: string;
  kind: RequestKind;
  leave_type_id: string | null;
  start_at: string;
  end_at: string;
  hours: number | null;
  reason: string | null;
  status: RequestStatus;
  current_step: number;
  created_at: string;
  /* ── 以下皆為 optional：舊 API／舊列缺席時前端要優雅退化 ─────────────── */
  /** 逐日切段（請假多日、補卡 `type`）。 */
  segments?: LeaveSegment[] | null;
  /** 加班給付方式。 */
  payout?: "pay" | "comp_time" | null;
  /** 公出／出差。 */
  trip_type?: "outing" | "business_trip" | null;
  location?: string | null;
  remark?: string | null;
  trip_scope?: "local" | "domestic_intercity" | "overseas" | string | null;
  estimated_cost?: string | number | null;
  advance_requested?: string | number | null;
  agent_name?: string | null;
  /** GET /requests?scope=mine 的 enrich 欄位（2026-09 新版 API 才有）。 */
  employee_name?: string | null;
  leave_type_name?: string | null;
  requires_attachment?: boolean | null;
  attachment_count?: number | null;
  total_steps?: number | null;
  /** 目前關卡第一位候選簽核人（相容欄位）。 */
  current_approver_emp_id?: string | null;
  /** 相容欄位：多人用「／」串、HR 關前綴「HR 覆核：」；有 `current_approver_names` 時優先用它組字。 */
  current_approver_name?: string | null;
  /* ── 多級簽核（2026-09-22）：同一關可有多位候選（任一人簽即過），舊 API 沒回時退回上面兩欄 ── */
  /** 目前關卡全部候選簽核人。 */
  current_candidate_emp_ids?: string[];
  /** 與 `current_candidate_emp_ids` 同序的姓名。 */
  current_approver_names?: string[];
  /** 目前關卡種類：manager｜hr｜list｜fallback｜hr_admin；`hr` 時畫面加註「（HR 覆核）」。 */
  current_step_kind?: string;
  /** 最後一次簽核決定的意見（駁回理由）與時間。 */
  decision_comment?: string | null;
  decided_at?: string | null;
  /* ── 月加班上限（M1，2026-09-23）：kind=ot 送單時累計超過上限即標記「超過月上限，另行給付」 ── */
  beyond_cap?: boolean;
  beyond_cap_detail?: BeyondCapDetail | null;
}

export interface LeaveType {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  paid: boolean;
  /** 核准前是否須附憑證（例如病假須附診所收據）。舊版 API 沒有這個欄位，讀取要 optional。 */
  requiresAttachment?: boolean;
  created_at: string;
}

export interface LeaveSegment {
  date: string;
  startTime: string;
  endTime: string;
  hours: number;
  /** 補卡（fix_punch）用：補的是上班還是下班；其他種類不帶。 */
  type?: "in" | "out";
}

export interface CreateRequestBody {
  kind: RequestKind;
  leaveTypeId?: string;
  startAt: string;
  endAt: string;
  hours?: number;
  reason?: string;
  onBehalfOfEmployeeId?: string;
  segments?: LeaveSegment[];
  // 表單延伸欄位
  agentName?: string;
  payout?: "pay" | "comp_time";
  tripType?: "outing" | "business_trip";
  location?: string;
  remark?: string;
  // ── 出差申請（模組三第 2 條）────────────────────────────────────────
  /** 出差範圍。用下拉而非讓系統從 location 猜文字。 */
  tripScope?: "local" | "domestic_intercity" | "overseas";
  /** 預估此趟總花費，供簽核者判斷。 */
  estimatedCost?: number;
  /** 申請預支金額。核准後由系統開出一筆預支，HR 撥款後才拿得到錢。 */
  advanceRequested?: number;
}

/* ------------------------------------------------ punches / balances / 班表 */

export interface PunchHistoryRecord {
  id: string;
  punch_at: string;
  type: "in" | "out";
  source: string | null;
}

export function getPunchRecords(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return apiFetch<{ records: PunchHistoryRecord[] }>(`/punch${qs ? `?${qs}` : ""}`);
}

export interface LeaveBalance {
  id: string;
  leave_type_id: string;
  /** ＝period_start 的年；週年制（W1）後保留給舊讀點。 */
  year: number;
  entitled: number | string;
  used: number | string;
  deferred: number | string;
  /* ── 特休週年制（W1，2026-09-23）：餘額桶期間與來源；舊 API 沒回時缺席，畫面退回顯示 year ── */
  period_start?: string;
  period_end?: string;
  source?: "manual" | "auto" | "migrated" | string;
  note?: string | null;
}

export function getLeaveBalances() {
  return apiFetch<{ balances: LeaveBalance[] }>("/leave-balances");
}

export interface ScheduleRow {
  id: string;
  work_date: string;
  shift_id: string | null;
  status: string;
}

export function getMySchedules(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return apiFetch<{ schedules: ScheduleRow[] }>(`/schedules${qs ? `?${qs}` : ""}`);
}

export interface Shift {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  /** 休息分鐘數（請假時數計算用）；舊 API 沒有時視為 0。 */
  break_minutes?: number | null;
  is_night_shift?: boolean | null;
  created_at?: string;
}

export function getShifts() {
  return apiFetch<{ shifts: Shift[] }>("/shifts");
}

/* ------------------------------------------------- 行事曆（假日表）--- */

/** GET /calendar?year= 的一列：rest_day（例假／休息日）、fixed_holiday（國定假日）、workday（補班）。 */
export interface CalendarDay {
  date: string;
  day_type: "rest_day" | "fixed_holiday" | "workday" | string;
  label: string | null;
}

/** 登入即可讀（非 HR 也可），請假多日切段時用來跳過假日。 */
export function getCalendar(year: number) {
  return apiFetch<{ year: number; days: CalendarDay[] }>(`/calendar?year=${year}`);
}

export function acknowledgeSchedule(id: string) {
  return apiFetch<{ id: string; status: string }>(`/schedules/${id}/acknowledge`, {
    method: "POST",
  });
}

export function disputeSchedule(id: string) {
  return apiFetch<{ id: string; status: string }>(`/schedules/${id}/dispute`, {
    method: "POST",
  });
}

export function getBranding() {
  return apiFetch<BrandingResponse>("/api/tenant/branding");
}

export function getPunchToday() {
  return apiFetch<PunchTodayResponse>("/punch/today");
}

export function postPunch(body: {
  type?: "in" | "out";
  source?: "gps" | "web";
  lat?: number;
  lng?: number;
}) {
  return apiFetch<PunchResult>("/punch", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getAnnouncements() {
  return apiFetch<{ announcements: Announcement[] }>("/announcements");
}

export interface AiAskResponse {
  answer: string;
  model: string;
  scope: "tenant" | "self";
}

export function askAiQuestion(body: { question: string; from: string; to: string; period: string }) {
  return apiFetch<AiAskResponse>("/ai/ask", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type NotificationStatus = "pending" | "sent" | "failed";

export interface NotificationItem {
  id: string;
  tenant_id: string;
  employee_id: string;
  type: string;
  title: string;
  body: string | null;
  channel: string;
  status: NotificationStatus;
  payload: Record<string, unknown> | null;
  created_at: string;
  sent_at: string | null;
}

export interface NotificationQuery {
  status?: NotificationStatus;
  /** "mine"：HR 帳號在 ESS 也只看自己的通知（2026-09 新版 API；舊 API 忽略此參數）。 */
  scope?: "mine";
  /** 只要未讀。 */
  unread?: boolean;
}

/**
 * GET /notifications。相容舊呼叫法（只傳 status 字串）；新呼叫法傳物件
 * `{ status?, scope?: "mine", unread? }`。
 */
export function getNotifications(opts?: NotificationStatus | NotificationQuery) {
  const query: NotificationQuery = typeof opts === "string" ? { status: opts } : (opts ?? {});
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.scope) params.set("scope", query.scope);
  if (query.unread) params.set("unread", "1");
  const qs = params.toString();
  return apiFetch<{ notifications: NotificationItem[] }>(`/notifications${qs ? `?${qs}` : ""}`);
}

export function markNotificationRead(id: string) {
  return apiFetch<{ id: string; read: true }>(`/notifications/${id}/read`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/**
 * GET /notifications/unread-count → `{ count }`（2026-09 新端點）。
 * 舊 API 回 404：呼叫端要 catch 並當作 0（徽章不顯示），不要擋頁面。
 */
export function getUnreadNotificationCount() {
  return apiFetch<{ count: number }>("/notifications/unread-count");
}

/** POST /notifications/read-all → `{ updated }`（2026-09 新端點；只標自己的）。 */
export function markAllNotificationsRead() {
  return apiFetch<{ updated: number }>("/notifications/read-all", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface RequestQuery {
  status?: RequestStatus;
  kind?: RequestKind;
  /** "mine"：HR 帳號在 ESS 也只看自己的單（2026-09 新版 API；舊 API 忽略此參數）。 */
  scope?: "mine";
}

/**
 * GET /requests。相容舊呼叫法（只傳 status 字串）；新呼叫法傳物件
 * `{ status?, kind?, scope?: "mine" }`。
 */
export function getRequests(opts?: RequestStatus | RequestQuery) {
  const query: RequestQuery = typeof opts === "string" ? { status: opts } : (opts ?? {});
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.kind) params.set("kind", query.kind);
  if (query.scope) params.set("scope", query.scope);
  const qs = params.toString();
  return apiFetch<{ requests: LeaveRequest[] }>(`/requests${qs ? `?${qs}` : ""}`);
}

/** POST /requests 的回應；除了 requestId 之外都是 2026-09 新版 API 才有的 optional 欄位。 */
export interface CreateRequestResult {
  requestId: string;
  /** 簽核流程來源（例如 "leave_type" / "department" / "none"），純顯示用。 */
  approvalSource?: string;
  /** 是否已通知第一關簽核者。 */
  notified?: boolean;
  /**
   * 簽核關卡（依 stepOrder 排序）；送出成功畫面用 steps[0] 的候選姓名（`candidateNames`，
   * 舊 API 沒回時退回 `approverName`）。多級簽核起每關可有多位候選（任一人簽即過）。
   */
  steps?: Array<{
    stepOrder: number;
    /** 第一位候選（相容欄位）。 */
    approverEmpId: string;
    approverName?: string | null;
    candidateEmpIds?: string[];
    candidateNames?: string[];
    /** manager｜hr｜list｜fallback｜hr_admin */
    kind?: string;
  }>;
}

export function createRequest(body: CreateRequestBody) {
  return apiFetch<CreateRequestResult>("/requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function cancelRequest(id: string) {
  return apiFetch<{ status: RequestStatus }>(`/requests/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/* ------------------------------------------------- 待我簽核（主管 ESS）--- */

/**
 * GET /requests/pending-approvals 的列：leave_requests 欄位＋伺服器附上的申請人／
 * 假別／附件數／關卡進度（非 HR 拿不到 GET /employees，名稱只能由這裡來）。
 */
export interface PendingApproval extends LeaveRequest {
  /** 第一位候選（相容欄位）；`current_candidate_emp_ids`／`current_approver_names`／`current_step_kind` 自 LeaveRequest 繼承。 */
  current_approver_emp_id: string | null;
  employee_name: string | null;
  employee_emp_no: string | null;
  department_name: string | null;
  leave_type_name: string | null;
  attachment_count: number;
  total_steps: number;
  segments?: LeaveSegment[] | null;
  payout?: "pay" | "comp_time" | null;
  location?: string | null;
  remark?: string | null;
  advance_requested?: string | number | null;
}

/** 「輪到我簽」的單；任何角色都可呼叫，沒有就是空陣列。 */
export function getPendingApprovals() {
  return apiFetch<{ requests: PendingApproval[] }>("/requests/pending-approvals");
}

export function approveRequest(id: string, comment?: string) {
  return apiFetch<{ status: RequestStatus; currentStep: number }>(`/requests/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(comment ? { comment } : {}),
  });
}

/** 駁回；理由由 UI 強制必填（API 端 comment 仍為 optional，與舊呼叫端相容）。 */
export function rejectRequest(id: string, comment: string) {
  return apiFetch<{ status: RequestStatus; currentStep: number }>(`/requests/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
}

/**
 * Leave types. NOTE: GET /leave-types is HR-admin-only on the API, so a plain
 * employee receives 403 — callers should treat a rejection as "no list
 * available" and fall back to a free-text / optional leave type.
 */
/* ------------------------------------------------------- my data / 履歷 --- */

// DB-shape (snake_case) of the 1:1 profile as returned by GET — 基本+通訊.
export interface EmployeeProfile {
  first_name: string | null;
  last_name: string | null;
  english_name: string | null;
  nationality: string | null;
  id_type: string | null;
  id_number: string | null;
  id_expiry: string | null;
  id_type2: string | null;
  id_number2: string | null;
  id_expiry2: string | null;
  id_type3: string | null;
  id_number3: string | null;
  id_expiry3: string | null;
  entry_date: string | null;
  birthday: string | null;
  gender: string | null;
  marital_status: string | null;
  photo_file_name: string | null;
  photo_storage_path: string | null;
  photo_size_bytes: number | null;
  photo_content_type: string | null;
  photo_url: string | null;
  phone: string | null;
  phone_mobile2: string | null;
  phone_landline: string | null;
  registered_address: string | null;
  address: string | null;
  company_email: string | null;
  personal_email: string | null;
  line_user_id: string | null;
  emergency_contact: string | null;
  emergency_relationship: string | null;
  emergency_phone: string | null;
  note: string | null;
}

// PUT body (camelCase, partial: absent = untouched, null = clear).
export interface SaveProfileBody {
  firstName?: string | null;
  lastName?: string | null;
  englishName?: string | null;
  nationality?: string | null;
  idType?: string | null;
  idNumber?: string | null;
  idExpiry?: string | null;
  idType2?: string | null;
  idNumber2?: string | null;
  idExpiry2?: string | null;
  idType3?: string | null;
  idNumber3?: string | null;
  idExpiry3?: string | null;
  entryDate?: string | null;
  birthday?: string | null;
  gender?: string | null;
  maritalStatus?: string | null;
  phone?: string | null;
  phoneMobile2?: string | null;
  phoneLandline?: string | null;
  registeredAddress?: string | null;
  address?: string | null;
  companyEmail?: string | null;
  personalEmail?: string | null;
  lineUserId?: string | null;
  emergencyContact?: string | null;
  emergencyRelationship?: string | null;
  emergencyPhone?: string | null;
  note?: string | null;
}

export interface Education {
  id: string;
  school: string;
  is_highest: boolean;
  major_category: string | null;
  major: string | null;
  degree: string | null;
  study_type: string | null;
  study_status: string | null;
  region: string | null;
  start_date: string | null;
  end_date: string | null;
  proof_file_name: string | null;
  proof_storage_path: string | null;
  proof_size_bytes: number | null;
  proof_content_type: string | null;
  proof_url: string | null;
}

export interface JobHistoryEntry {
  id: string;
  effective_date: string;
  action: string;
  dept_id: string | null;
  dept_name: string | null;
  grade: string | null;
  title: string | null;
}

export interface Certification {
  id: string;
  name: string;
  issuer: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  attachment_file_name: string | null;
  attachment_storage_path: string | null;
  attachment_size_bytes: number | null;
  attachment_content_type: string | null;
  attachment_url: string | null;
}

export interface WorkHistory {
  id: string;
  company: string;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
}

export interface ProfileAggregate {
  basic: {
    id: string;
    name: string;
    emp_no: string | null;
    dept_id: string | null;
    employment_type: string;
    hire_date: string | null;
    role: string;
    status: string;
  };
  profile: EmployeeProfile | null;
  educations: Education[];
  certifications: Certification[];
  workHistory: WorkHistory[];
  jobHistory: JobHistoryEntry[];
  seniorityDays: number | null;
  seniority: {
    internalYears: number | null;
    gradeYears: number | null;
    unitYears: number | null;
  };
}

export function getProfile(empId: string) {
  return apiFetch<ProfileAggregate>(`/employees/${empId}/profile`);
}

export function saveProfile(empId: string, body: SaveProfileBody) {
  return apiFetch<{ id: string }>(`/employees/${empId}/profile`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("讀取檔案失敗"));
    reader.readAsDataURL(file);
  });
}

function uploadBody(file: File, dataBase64: string) {
  return JSON.stringify({
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    dataBase64,
  });
}

export async function uploadProfilePhoto(empId: string, file: File) {
  return apiFetch<{ id: string; photoUrl: string | null }>(`/employees/${empId}/profile/photo`, {
    method: "POST",
    body: uploadBody(file, await fileToBase64(file)),
  });
}

export function deleteProfilePhoto(empId: string) {
  return apiFetch<{ id: string }>(`/employees/${empId}/profile/photo`, { method: "DELETE" });
}

export function addEducation(
  empId: string,
  body: {
    school: string;
    isHighest?: boolean;
    majorCategory?: string;
    major?: string;
    degree?: string;
    studyType?: string;
    studyStatus?: string;
    region?: string;
    startDate?: string;
    endDate?: string;
  },
) {
  return apiFetch<{ id: string }>(`/employees/${empId}/educations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadEducationAttachment(id: string, file: File) {
  return apiFetch<{ id: string; proofUrl: string | null }>(`/educations/${id}/attachment`, {
    method: "POST",
    body: uploadBody(file, await fileToBase64(file)),
  });
}

export function deleteEducationAttachment(id: string) {
  return apiFetch<{ id: string }>(`/educations/${id}/attachment`, { method: "DELETE" });
}

export function addCertification(
  empId: string,
  body: { name: string; issuer?: string; issuedDate?: string; expiryDate?: string },
) {
  return apiFetch<{ id: string }>(`/employees/${empId}/certifications`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadCertificationAttachment(id: string, file: File) {
  return apiFetch<{ id: string; attachmentUrl: string | null }>(`/certifications/${id}/attachment`, {
    method: "POST",
    body: uploadBody(file, await fileToBase64(file)),
  });
}

export function deleteCertificationAttachment(id: string) {
  return apiFetch<{ id: string }>(`/certifications/${id}/attachment`, { method: "DELETE" });
}

export function addWorkHistory(
  empId: string,
  body: { company: string; title?: string; startDate?: string; endDate?: string; description?: string },
) {
  return apiFetch<{ id: string }>(`/employees/${empId}/work-history`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteEducation(id: string) {
  return apiFetch<{ id: string }>(`/educations/${id}`, { method: "DELETE" });
}

export function deleteCertification(id: string) {
  return apiFetch<{ id: string }>(`/certifications/${id}`, { method: "DELETE" });
}

export function deleteWorkHistory(id: string) {
  return apiFetch<{ id: string }>(`/work-history/${id}`, { method: "DELETE" });
}

export function getLeaveTypes() {
  return apiFetch<{ leaveTypes: LeaveType[] }>("/leave-types");
}

export interface MyPayslip {
  id: string;
  period: string;
  base: string;
  overtime_pay: string;
  night_pay: string;
  attendance_bonus: string;
  gross: string;
  status: string;
}

export function getMyPayslips() {
  return apiFetch<{ payslips: MyPayslip[] }>("/payslips");
}

export interface InternalJob {
  id: string;
  title: string;
  dept_id: string | null;
  headcount: number;
  employment_type: string;
  description: string | null;
  created_at: string;
}

export function getInternalJobs() {
  return apiFetch<{ internalJobs: InternalJob[] }>("/internal-jobs");
}

/** Upload one attachment (≤3MB) to a request as base64 JSON. */
export async function uploadAttachment(requestId: string, file: File): Promise<void> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("讀取檔案失敗"));
    r.readAsDataURL(file);
  });
  await apiFetch<{ id: string }>(`/requests/${requestId}/attachments`, {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream", dataBase64 }),
  });
}

/** 列出某張單的附件（signed URL 清單），供簽核者/HR 檢視與下載。 */
export function getRequestAttachments(requestId: string) {
  return apiFetch<{ attachments: Array<{ id: string; fileName: string; sizeBytes: number; contentType: string; url: string }> }>(
    `/requests/${requestId}/attachments`
  );
}

/* ------------------------------------------------------- 報銷（模組三） */

export interface MyExpenseCategory {
  id: string;
  code: string;
  name: string;
  nature: "reimbursement" | "allowance";
  requires_receipt: boolean;
  /** true = 本類別的報銷必須綁一張已核准的出差單（模組三第 2 條）。 */
  requires_trip_approval: boolean;
  monthly_cap: string | null;
  active: boolean;
}

export interface MyExpenseClaim {
  id: string;
  category_id: string;
  nature: "reimbursement" | "allowance";
  amount: string;
  incurred_on: string;
  period: string;
  note: string | null;
  status: string;
}

export function getMyExpenseCategories() {
  return apiFetch<{ categories: MyExpenseCategory[] }>("/expense-categories");
}

export function getMyExpenses(period?: string) {
  return apiFetch<{ claims: MyExpenseClaim[] }>(
    `/expenses${period ? `?period=${period}` : ""}`,
  );
}

export function fileExpense(body: {
  categoryId: string;
  amount: number;
  incurredOn: string;
  period?: string;
  note?: string;
  /** 出差軌類別必填：綁定的已核准出差單。 */
  tripRequestId?: string;
  /** 這筆費用用哪筆預支的錢付的；出差軌若已有預支，省略時由系統自動綁。 */
  advanceId?: string;
}) {
  return apiFetch<{ id: string; period: string; nature: string }>("/expenses", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** 撤回自己尚未核銷的單（不刪除，狀態改 cancelled 並留理由）。 */
export function cancelExpense(id: string, reason: string) {
  return apiFetch<{ id: string }>(`/expenses/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled", statusReason: reason }),
  });
}

export async function uploadExpenseReceipt(claimId: string, file: File): Promise<void> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("讀取檔案失敗"));
    r.readAsDataURL(file);
  });
  await apiFetch<{ id: string }>(`/expenses/${claimId}/attachments`, {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      dataBase64,
    }),
  });
}

/* --------------------------------------------------- 出差預支（模組三第 2 條） */

export interface MyTrip {
  id: string;
  start_at: string;
  end_at: string;
  location: string | null;
  trip_scope: string | null;
  advance_requested: string | null;
  trip_report: string | null;
  status: string;
}

export interface MyAdvance {
  id: string;
  kind: "trip" | "petty_cash";
  request_id: string;
  amount: string;
  status: string;
  payout_channel: string | null;
  paid_at: string | null;
  actual_total: string | null;
  balance: string | null;
  balance_handling: string | null;
  recovery_period: string | null;
  settled_at: string | null;
}

/** 我已核准的出差單 —— 出差軌報銷填報時要綁其中一張。 */
export function getMyApprovedTrips() {
  return apiFetch<{ requests: MyTrip[] }>(
    "/requests?kind=business_trip&status=approved&scope=mine",
  );
}

/** 我的預支（出差＋零用金）：看得到「核准了但還沒撥款」與「撥了還沒核銷」。 */
export function getMyAdvances() {
  return apiFetch<{ advances: MyAdvance[] }>("/advances");
}

/**
 * 回程出差報告。營所稅查核準則 §74 要求出差旅費須有出差報告單；
 * 這一欄就是那份報告。
 */
export function submitTripReport(requestId: string, tripReport: string) {
  return apiFetch<{ id: string }>(`/requests/${requestId}/trip-report`, {
    method: "PATCH",
    body: JSON.stringify({ tripReport }),
  });
}

/** 報銷模組設定。ESS 端用 advanceThreshold 顯示「低於建議門檻」提示。 */
export function getExpenseSettingsForMe() {
  return apiFetch<{
    settings: { advanceThreshold: number; advanceOverdueDays: number };
  }>("/expense-settings");
}
