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
}

export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type RequestKind = "leave" | "ot" | "fix_punch" | "business_trip";

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
}

export interface LeaveType {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  paid: boolean;
  created_at: string;
}

export interface LeaveSegment {
  date: string;
  startTime: string;
  endTime: string;
  hours: number;
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
  // Apollo form-parity extras
  agentName?: string;
  payout?: "pay" | "comp_time";
  tripType?: "outing" | "business_trip";
  location?: string;
  remark?: string;
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
  year: number;
  entitled: number | string;
  used: number | string;
  deferred: number | string;
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
}

export function getShifts() {
  return apiFetch<{ shifts: Shift[] }>("/shifts");
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

export function getNotifications(status?: NotificationStatus) {
  const qs = status ? `?status=${status}` : "";
  return apiFetch<{ notifications: NotificationItem[] }>(`/notifications${qs}`);
}

export function markNotificationRead(id: string) {
  return apiFetch<{ id: string; read: true }>(`/notifications/${id}/read`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export interface PersonalNote {
  id: string | null;
  tenant_id: string;
  employee_id: string;
  body: string;
  created_at: string | null;
  updated_at: string | null;
}

export function getPersonalNote() {
  return apiFetch<{ note: PersonalNote }>("/personal-note");
}

export function savePersonalNote(body: string) {
  return apiFetch<{ note: PersonalNote }>("/personal-note", {
    method: "PUT",
    body: JSON.stringify({ body }),
  });
}

export function getRequests(status?: RequestStatus) {
  const qs = status ? `?status=${status}` : "";
  return apiFetch<{ requests: LeaveRequest[] }>(`/requests${qs}`);
}

export function createRequest(body: CreateRequestBody) {
  return apiFetch<{ requestId: string }>("/requests", {
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

/**
 * Leave types. NOTE: GET /leave-types is HR-admin-only on the API, so a plain
 * employee receives 403 — callers should treat a rejection as "no list
 * available" and fall back to a free-text / optional leave type.
 */
/* ------------------------------------------------------- my data / 履歷 --- */

// DB-shape (snake_case) of the 1:1 profile as returned by GET — Apollo 基本+通訊.
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

/* ------------------------------------------------------- 報銷（模組三） */

export interface MyExpenseCategory {
  id: string;
  code: string;
  name: string;
  nature: "reimbursement" | "allowance";
  requires_receipt: boolean;
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
