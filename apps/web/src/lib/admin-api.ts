/**
 * Typed HR-admin (back-office) API calls. Shapes mirror the @hr/api responses
 * exactly (see apps/api/src/routes/{me,departments,employees,shifts,schedules,
 * requests,announcements,leave-types,approval-flows}.ts).
 *
 * All calls go through apiFetch, which attaches the current Supabase access
 * token as a Bearer header. Every endpoint here is HR-admin-only on the API
 * (except GET /me, GET /announcements and GET /leave-types, which any tenant
 * member may read) and is tenant-scoped server-side.
 */
import { apiFetch } from "./api-client";

/* ------------------------------------------------------------------ me ----- */

export type Role = "platform_admin" | "hr_admin" | "employee" | string;

export interface Me {
  id: string;
  name: string;
  role: Role;
  deptId: string | null;
  empNo: string | null;
  status: string;
  email: string | null;
}

export function getMe() {
  return apiFetch<Me>("/me");
}

/* --------------------------------------------------------- departments ----- */

export interface Department {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  code: string;
  name: string;
  manager_emp_id: string | null;
  manager_name: string | null;
  manager_emp_no: string | null;
  manager_label: string | null;
  created_at: string;
}

export function getDepartments() {
  return apiFetch<{ departments: Department[] }>("/departments");
}

export function createDepartment(body: {
  name: string;
  parentId?: string | null;
  managerEmpId?: string | null;
}) {
  return apiFetch<{ id: string }>("/departments", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateDepartment(
  id: string,
  body: { name?: string; parentId?: string | null; managerEmpId?: string | null },
) {
  return apiFetch<{ id: string }>(`/departments/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteDepartment(id: string) {
  return apiFetch<{ id: string }>(`/departments/${id}`, { method: "DELETE" });
}

/* ----------------------------------------------------------- employees ----- */

export interface Employee {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  role: string;
  dept_id: string | null;
  emp_no: string | null;
  employment_type: string | null;
  hire_date: string | null;
  terminated_at: string | null;
  status: string;
  created_at: string;
}

export function getEmployees() {
  return apiFetch<{ employees: Employee[] }>("/employees");
}

/** Invite an employee: creates their Supabase Auth user + employees row. */
export function inviteEmployee(body: {
  email: string;
  name: string;
  password: string;
  role?: string;
  deptId?: string | null;
  empNo?: string;
  employmentType?: string;
  hireDate?: string;
}) {
  return apiFetch<{ employeeId: string; userId: string }>("/employees", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateEmployee(
  id: string,
  body: {
    name?: string;
    role?: string;
    status?: string;
    deptId?: string | null;
    empNo?: string | null;
    employmentType?: string;
    hireDate?: string | null;
    terminatedAt?: string | null;
  },
) {
  return apiFetch<{ id: string }>(`/employees/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deactivateEmployee(id: string) {
  return apiFetch<{ id: string; status: string }>(`/employees/${id}/deactivate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/**
 * 配發/重設員工登入密碼。不帶 password → 後端產生隨機密碼並在回應回傳一次
 * （供 HR 轉交）；自填 password → 回應不含密碼。尚未綁定帳號的員工回 409。
 */
export function resetEmployeePassword(id: string, password?: string) {
  return apiFetch<{ id: string; password?: string }>(`/employees/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify(password ? { password } : {}),
  });
}

/* ---------------------------------------------------- employee profile ----- */

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

export interface JobHistoryEntry {
  id: string;
  effective_date: string;
  action: string;
  dept_id: string | null;
  dept_name: string | null;
  grade: string | null;
  title: string | null;
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

export function getEmployeeProfile(employeeId: string) {
  return apiFetch<ProfileAggregate>(`/employees/${employeeId}/profile`);
}

export function saveEmployeeProfile(employeeId: string, body: SaveProfileBody) {
  return apiFetch<{ id: string }>(`/employees/${employeeId}/profile`, {
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

export async function uploadEmployeeProfilePhoto(employeeId: string, file: File) {
  return apiFetch<{ id: string; photoUrl: string | null }>(`/employees/${employeeId}/profile/photo`, {
    method: "POST",
    body: uploadBody(file, await fileToBase64(file)),
  });
}

export function deleteEmployeeProfilePhoto(employeeId: string) {
  return apiFetch<{ id: string }>(`/employees/${employeeId}/profile/photo`, { method: "DELETE" });
}

export function addEmployeeEducation(
  employeeId: string,
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
  return apiFetch<{ id: string }>(`/employees/${employeeId}/educations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadEmployeeEducationAttachment(id: string, file: File) {
  return apiFetch<{ id: string; proofUrl: string | null }>(`/educations/${id}/attachment`, {
    method: "POST",
    body: uploadBody(file, await fileToBase64(file)),
  });
}

export function deleteEmployeeEducationAttachment(id: string) {
  return apiFetch<{ id: string }>(`/educations/${id}/attachment`, { method: "DELETE" });
}

export function addEmployeeCertification(
  employeeId: string,
  body: { name: string; issuer?: string; issuedDate?: string; expiryDate?: string },
) {
  return apiFetch<{ id: string }>(`/employees/${employeeId}/certifications`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadEmployeeCertificationAttachment(id: string, file: File) {
  return apiFetch<{ id: string; attachmentUrl: string | null }>(`/certifications/${id}/attachment`, {
    method: "POST",
    body: uploadBody(file, await fileToBase64(file)),
  });
}

export function deleteEmployeeCertificationAttachment(id: string) {
  return apiFetch<{ id: string }>(`/certifications/${id}/attachment`, { method: "DELETE" });
}

export function addEmployeeWorkHistory(
  employeeId: string,
  body: { company: string; title?: string; startDate?: string; endDate?: string; description?: string },
) {
  return apiFetch<{ id: string }>(`/employees/${employeeId}/work-history`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function addEmployeeJobHistory(
  employeeId: string,
  body: {
    effectiveDate: string;
    action: string;
    deptId?: string | null;
    deptName?: string | null;
    grade?: string | null;
    title?: string | null;
  },
) {
  return apiFetch<{ id: string }>(`/employees/${employeeId}/job-history`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteEmployeeEducation(id: string) {
  return apiFetch<{ id: string }>(`/educations/${id}`, { method: "DELETE" });
}

export function deleteEmployeeCertification(id: string) {
  return apiFetch<{ id: string }>(`/certifications/${id}`, { method: "DELETE" });
}

export function deleteEmployeeWorkHistory(id: string) {
  return apiFetch<{ id: string }>(`/work-history/${id}`, { method: "DELETE" });
}

/* -------------------------------------------------------------- shifts ----- */

export interface Shift {
  id: string;
  tenant_id: string;
  name: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  is_night_shift: boolean;
  created_at: string;
}

export function getShifts() {
  return apiFetch<{ shifts: Shift[] }>("/shifts");
}

export function createShift(body: {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes?: number;
  isNightShift?: boolean;
}) {
  return apiFetch<{ id: string }>("/shifts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateShift(
  id: string,
  body: {
    name?: string;
    startTime?: string;
    endTime?: string;
    breakMinutes?: number;
    isNightShift?: boolean;
  },
) {
  return apiFetch<{ id: string }>(`/shifts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteShift(id: string) {
  return apiFetch<{ id: string }>(`/shifts/${id}`, { method: "DELETE" });
}

/* ----------------------------------------------------------- schedules ----- */

export interface Schedule {
  id: string;
  tenant_id: string;
  employee_id: string;
  work_date: string;
  shift_id: string | null;
  status: string;
  created_at: string;
}

export function getSchedules(params: { employeeId?: string; from?: string; to?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.employeeId) qs.set("employeeId", params.employeeId);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch<{ schedules: Schedule[] }>(`/schedules${suffix}`);
}

export function assignSchedule(body: {
  employeeId: string;
  workDate: string;
  shiftId?: string | null;
  status?: string;
}) {
  return apiFetch<{ ids: string[]; count: number }>("/schedules", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function assignSchedulesBatch(
  assignments: Array<{
    employeeId: string;
    workDate: string;
    shiftId?: string | null;
    status?: string;
  }>,
) {
  return apiFetch<{ ids: string[]; count: number }>("/schedules", {
    method: "POST",
    body: JSON.stringify({ assignments }),
  });
}

export function importSchedules(csv: string) {
  return apiFetch<{ imported: string[]; count: number; errors: Array<{ line: number; error: string }> }>(
    "/schedules/import",
    {
      method: "POST",
      body: JSON.stringify({ csv }),
    },
  );
}

export function reviewSchedule(id: string, decision: "acknowledge" | "dispute") {
  return apiFetch<{ id: string; status: string }>(`/schedules/${id}/${decision}`, {
    method: "POST",
  });
}

/* ------------------------------------------------------------ requests ----- */

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
  agent_name: string | null;
  payout: "pay" | "comp_time" | null;
  trip_type: "outing" | "business_trip" | null;
  location: string | null;
  remark: string | null;
  segments: unknown;
  status: RequestStatus;
  current_step: number;
  current_approver_emp_id: string | null;
  created_at: string;
}

export interface RequestQuery {
  status?: RequestStatus;
  kind?: RequestKind;
  employeeId?: string;
  from?: string;
  to?: string;
}

export function getRequests(params?: RequestStatus | RequestQuery) {
  const query: RequestQuery = typeof params === "string" ? { status: params } : (params ?? {});
  const qs = new URLSearchParams();
  if (query.status) qs.set("status", query.status);
  if (query.kind) qs.set("kind", query.kind);
  if (query.employeeId) qs.set("employeeId", query.employeeId);
  if (query.from) qs.set("from", query.from);
  if (query.to) qs.set("to", query.to);
  return apiFetch<{ requests: LeaveRequest[] }>(
    `/requests${qs.toString() ? `?${qs.toString()}` : ""}`,
  );
}

export function approveRequest(id: string, comment?: string) {
  return apiFetch<{ status: RequestStatus; currentStep: number }>(`/requests/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(comment ? { comment } : {}),
  });
}

export function rejectRequest(id: string, comment?: string) {
  return apiFetch<{ status: RequestStatus; currentStep: number }>(`/requests/${id}/reject`, {
    method: "POST",
    body: JSON.stringify(comment ? { comment } : {}),
  });
}

export function batchDecideRequests(body: {
  ids: string[];
  action: "approve" | "reject";
  comment?: string;
}) {
  return apiFetch<{
    ok: number;
    failed: number;
    results: Array<
      | { ok: true; id: string; status: RequestStatus; currentStep: number }
      | { ok: false; id: string; error: string }
    >;
  }>("/requests/batch-decision", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function remindRequest(id: string) {
  return apiFetch<{ notified: number; employeeId: string }>(`/requests/${id}/remind`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function changeRequestApprover(id: string, approverEmpId: string, comment?: string) {
  return apiFetch<{
    id: string;
    currentStep: number;
    previousApproverEmpId: string;
    approverEmpId: string;
  }>(`/requests/${id}/change-approver`, {
    method: "POST",
    body: JSON.stringify({ approverEmpId, ...(comment ? { comment } : {}) }),
  });
}

/** 註銷表單紀錄（伺服器端為軟刪除，紀錄保留）。reason 為必填。 */
export function deleteRequest(id: string, reason: string) {
  return apiFetch<{ id: string }>(`/requests/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  });
}

/* ------------------------------------------------------- announcements ----- */

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

export function getAnnouncements() {
  return apiFetch<{ announcements: Announcement[] }>("/announcements");
}

export function createAnnouncement(body: { title: string; body: string; audience?: string }) {
  return apiFetch<{ id: string }>("/announcements", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAnnouncement(
  id: string,
  body: { title?: string; body?: string; audience?: string },
) {
  return apiFetch<{ id: string }>(`/announcements/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** 註銷公告（伺服器端為軟刪除，紀錄保留）。reason 為必填。 */
export function deleteAnnouncement(id: string, reason: string) {
  return apiFetch<{ id: string }>(`/announcements/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  });
}

/* --------------------------------------------------------- notifications -- */

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

export function deliverPendingNotifications(limit = 50) {
  return apiFetch<{
    scanned: number;
    delivered: number;
    failed: number;
    skipped: number;
    results: Array<{
      id: string;
      channels: Array<"email" | "line">;
      sent: Array<"email" | "line">;
      failed: Array<{ channel: "email" | "line"; error: string }>;
      skipped?: string;
    }>;
  }>("/notifications/deliver-pending", {
    method: "POST",
    body: JSON.stringify({ limit }),
  });
}

/* --------------------------------------------------------- leave-types ----- */

export interface LeaveType {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  paid: boolean;
  special: boolean;
  created_at: string;
}

export function getLeaveTypes() {
  return apiFetch<{ leaveTypes: LeaveType[] }>("/leave-types");
}

export function createLeaveType(body: {
  code: string;
  name: string;
  paid?: boolean;
  special?: boolean;
}) {
  return apiFetch<{ id: string }>("/leave-types", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateLeaveType(
  id: string,
  body: { code?: string; name?: string; paid?: boolean; special?: boolean },
) {
  return apiFetch<{ id: string }>(`/leave-types/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteLeaveType(id: string) {
  return apiFetch<{ id: string }>(`/leave-types/${id}`, { method: "DELETE" });
}

/* ------------------------------------------------------------- org-chart --- */

export interface OrgNode {
  id: string;
  code: string;
  name: string;
  managerEmpId: string | null;
  managerName: string | null;
  managerEmpNo: string | null;
  managerLabel: string | null;
  children: OrgNode[];
}

export function getOrgChart() {
  return apiFetch<{ tree: OrgNode[] }>("/org-chart");
}

/* ------------------------------------------------------------ onboarding --- */

export interface Onboarding {
  id: string;
  tenant_id: string;
  name: string;
  dept_id: string | null;
  manager_emp_id: string | null;
  employment_type: string;
  identity_type: string | null;
  region: string | null;
  report_date: string | null;
  status: "pending" | "completed";
  employee_id: string | null;
  created_at: string;
}

export function getOnboardings(filters?: {
  status?: "pending" | "completed";
  from?: string;
  to?: string;
  keyword?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  if (filters?.keyword) params.set("keyword", filters.keyword);
  const qs = params.toString();
  return apiFetch<{ onboardings: Onboarding[] }>(`/onboardings${qs ? `?${qs}` : ""}`);
}

export function importOnboardings(csv: string) {
  return apiFetch<{ count: number; errors: { line: number; error: string }[] }>(
    "/onboardings/import",
    { method: "POST", body: JSON.stringify({ csv }) },
  );
}

export function createOnboarding(body: {
  name: string;
  deptId?: string | null;
  managerEmpId?: string | null;
  employmentType?: string;
  identityType?: string | null;
  region?: string | null;
  reportDate?: string | null;
}) {
  return apiFetch<{ id: string }>("/onboardings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function completeOnboarding(id: string) {
  return apiFetch<{ id: string; status: string; employeeId: string }>(
    `/onboardings/${id}/complete`,
    { method: "POST" },
  );
}

export function deleteOnboarding(id: string) {
  return apiFetch<{ id: string }>(`/onboardings/${id}`, { method: "DELETE" });
}

/* ----------------------------------------------------- recruitment (ATS) --- */

export interface JobRequisition {
  id: string;
  tenant_id: string;
  title: string;
  dept_id: string | null;
  headcount: number;
  employment_type: string;
  description: string | null;
  status: "draft" | "pending_approval" | "open" | "closed";
  is_internal: boolean;
  created_at: string;
}

export interface Candidate {
  id: string;
  tenant_id: string;
  requisition_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  resume_url: string | null;
  status: "new" | "screening" | "interviewing" | "offered" | "hired" | "rejected";
  note: string | null;
  created_at: string;
}

export function getJobRequisitions(params: {
  status?: JobRequisition["status"];
  isInternal?: boolean;
} = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.isInternal !== undefined) qs.set("isInternal", String(params.isInternal));
  return apiFetch<{ "job-requisitions": JobRequisition[] }>(
    `/job-requisitions${qs.toString() ? `?${qs.toString()}` : ""}`,
  );
}

export function createJobRequisition(body: {
  title: string;
  deptId?: string | null;
  headcount?: number;
  employmentType?: string;
  isInternal?: boolean;
  status?: "draft" | "pending_approval" | "open" | "closed";
  description?: string;
}) {
  return apiFetch<{ id: string }>("/job-requisitions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateJobRequisition(
  id: string,
  body: {
    title?: string;
    deptId?: string | null;
    headcount?: number;
    employmentType?: string | null;
    description?: string | null;
    status?: "draft" | "pending_approval" | "open" | "closed";
    isInternal?: boolean;
  },
) {
  return apiFetch<{ id: string }>(`/job-requisitions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteJobRequisition(id: string) {
  return apiFetch<{ id: string }>(`/job-requisitions/${id}`, { method: "DELETE" });
}

export function getCandidates(params?: string | { requisitionId?: string; status?: Candidate["status"] }) {
  const filters = typeof params === "string" ? { requisitionId: params } : (params ?? {});
  const qs = new URLSearchParams();
  if (filters.requisitionId) qs.set("requisitionId", filters.requisitionId);
  if (filters.status) qs.set("status", filters.status);
  return apiFetch<{ candidates: Candidate[] }>(`/candidates${qs.toString() ? `?${qs.toString()}` : ""}`);
}

export function createCandidate(body: {
  name: string;
  email?: string;
  phone?: string;
  requisitionId?: string | null;
  source?: string;
  resumeUrl?: string;
  status?: Candidate["status"];
  note?: string;
}) {
  return apiFetch<{ id: string }>("/candidates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateCandidate(
  id: string,
  body: {
    name?: string;
    requisitionId?: string | null;
    email?: string | null;
    phone?: string | null;
    source?: string | null;
    resumeUrl?: string | null;
    status?: Candidate["status"];
    note?: string | null;
  },
) {
  return apiFetch<{ id: string }>(`/candidates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------- punch records (HR) --- */

export interface PunchRecord {
  id: string;
  employee_id: string;
  punch_at: string;
  type: "in" | "out" | "break_in" | "break_out" | "outing_in" | "outing_out";
  source: string | null;
  lat: number | null;
  lng: number | null;
  device_id: string | null;
}

export function getPunchRecordsAdmin(filters?: {
  employeeId?: string;
  deptId?: string;
  type?: PunchRecord["type"];
  source?: "gps" | "web" | "line" | "manual";
  from?: string;
  to?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.employeeId) params.set("employeeId", filters.employeeId);
  if (filters?.deptId) params.set("deptId", filters.deptId);
  if (filters?.type) params.set("type", filters.type);
  if (filters?.source) params.set("source", filters.source);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  const qs = params.toString();
  return apiFetch<{ records: PunchRecord[] }>(`/punch${qs ? `?${qs}` : ""}`);
}

export function createManualPunch(body: {
  employeeId: string;
  punchAt: string;
  type: PunchRecord["type"];
}) {
  return apiFetch<{ id: string }>("/punch/manual", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function importManualPunches(csv: string) {
  return apiFetch<{ imported: string[]; count: number; errors: Array<{ line: number; error: string }> }>(
    "/punch/manual/import",
    {
      method: "POST",
      body: JSON.stringify({ csv }),
    },
  );
}

/* ------------------------------------------------- payroll tax / 法規 --- */

export interface NonEmployeeIncome {
  id: string;
  payee_name: string;
  id_number: string | null;
  income_type: string | null;
  amount: string;
  tax_withheld: string;
  supplementary_premium: string;
  pay_date: string | null;
  note: string | null;
  created_at: string;
}

export function importSalaryAdjustments(csv: string) {
  return apiFetch<{ count: number; errors: { line: number; error: string }[] }>(
    "/salary-adjustments/import",
    { method: "POST", body: JSON.stringify({ csv }) },
  );
}

export interface SalaryAdjustment {
  id: string;
  employee_id: string;
  effective_date: string;
  new_salary: string;
  reason: string | null;
  created_at: string;
}

export function getSalaryAdjustments(employeeId?: string) {
  const qs = employeeId ? `?employeeId=${employeeId}` : "";
  return apiFetch<{ "salary-adjustments": SalaryAdjustment[] }>(`/salary-adjustments${qs}`);
}

export function getNonEmployeeIncome() {
  return apiFetch<{ "non-employee-income": NonEmployeeIncome[] }>("/non-employee-income");
}

export function createNonEmployeeIncome(body: {
  payeeName: string;
  idNumber?: string;
  incomeType?: string;
  amount: number;
  withholdRate?: number;
  payDate?: string;
  note?: string;
}) {
  return apiFetch<{ id: string; taxWithheld: number; supplementaryPremium: number }>(
    "/non-employee-income",
    { method: "POST", body: JSON.stringify(body) },
  );
}

export type TaxComputeBody =
  | { kind: "bonus_premium"; monthlyInsuredSalary: number; cumulativeBonusBefore?: number; thisBonus: number; rate?: number }
  | { kind: "nhi_premium"; insuredSalary: number; dependents?: number; rate: number; employeeShareRatio: number }
  | { kind: "withholding"; monthlyPayment: number; rate?: number; threshold?: number };

export function computeTax(body: TaxComputeBody) {
  return apiFetch<{ premium?: number; withholding?: number }>("/payroll/tax/compute", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------ approval-flows ----- */

export interface ApprovalFlow {
  id: string;
  tenant_id: string;
  applies_to: RequestKind;
  approver_emp_ids: string[];
  created_at: string;
}

export function getApprovalFlows() {
  return apiFetch<{ flows: ApprovalFlow[] }>("/approval-flows");
}

export function setApprovalFlow(kind: RequestKind, approverEmpIds: string[]) {
  return apiFetch<{ id: string; appliesTo: RequestKind; approverEmpIds: string[] }>(
    `/approval-flows/${kind}`,
    { method: "PUT", body: JSON.stringify({ approverEmpIds }) },
  );
}

/* ------------------------------------------------------------ branding ----- */

export interface Branding {
  primaryColor?: string;
  appName?: string;
  logoUrl?: string;
}

export interface TenantPermission {
  module: string;
  unit: string;
  desc?: string;
  account?: string;
  enabled?: boolean;
}

export interface InternalLink {
  name: string;
  url: string;
  enabled?: boolean;
  sort?: number;
}

export interface TenantFeatures {
  permissions?: TenantPermission[];
  internalLinks?: InternalLink[];
  dashboardWidgets?: string[];
  site?: {
    employeePortalPath?: string;
    adminPortalPath?: string;
  };
  [key: string]: unknown;
}

export function getBranding() {
  return apiFetch<{ branding: Branding | null; features: TenantFeatures | null }>(
    "/api/tenant/branding",
  );
}

export function saveTenantSettings(body: {
  branding?: Branding;
  features?: TenantFeatures;
}) {
  return apiFetch<{ branding: Branding | null; features: TenantFeatures | null }>(
    "/api/tenant/settings",
    { method: "PUT", body: JSON.stringify(body) },
  );
}

/* --------------------------------------------------- payroll (薪資作業) --- */

export interface SalaryStructure {
  id: string;
  employee_id: string;
  method: "monthly" | "by_attendance_days";
  base_salary: string | null;
  daily_wage: string | null;
  hourly_wage: string;
  allowances: Record<string, unknown>;
  labor_insured_salary?: string | null;
  health_insured_salary?: string | null;
}

export function getSalaryStructure(employeeId: string) {
  return apiFetch<{ salary: SalaryStructure }>(`/salary/${employeeId}`);
}

export function putSalaryStructure(
  employeeId: string,
  body: {
    method?: "monthly" | "by_attendance_days";
    baseSalary?: number | null;
    dailyWage?: number | null;
    hourlyWage?: number;
    laborInsuredSalary?: number | null;
    healthInsuredSalary?: number | null;
  },
) {
  return apiFetch<{ id: string }>(`/salary/${employeeId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export interface Payslip {
  id: string;
  employee_id: string;
  period: string;
  base: string;
  overtime_pay: string;
  night_pay: string;
  attendance_bonus: string;
  gross: string;
  status: string;
}

export function runPayroll(period: string, employeeId?: string) {
  return apiFetch<{ generated: number; skipped: string[] }>(`/payroll/run`, {
    method: "POST",
    body: JSON.stringify({ period, employeeId }),
  });
}

export function getPayslips(period?: string) {
  const qs = period ? `?period=${period}` : "";
  return apiFetch<{ payslips: Payslip[] }>(`/payslips${qs}`);
}

export function finalizePayslip(id: string) {
  return apiFetch<{ id: string; status: string }>(`/payslips/${id}/finalize`, {
    method: "POST",
  });
}

export interface NhiDependent {
  id: string;
  employee_id: string;
  name: string;
  relationship: string | null;
  id_number: string | null;
  insured: boolean;
}

export function getNhiDependents(employeeId: string) {
  return apiFetch<{ "nhi-dependents": NhiDependent[] }>(
    `/nhi-dependents?employeeId=${employeeId}`,
  );
}

export function addNhiDependent(body: {
  employeeId: string;
  name: string;
  relationship?: string;
  idNumber?: string;
  insured?: boolean;
}) {
  return apiFetch<{ id: string }>("/nhi-dependents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteNhiDependent(id: string) {
  return apiFetch<{ id: string }>(`/nhi-dependents/${id}`, { method: "DELETE" });
}

export interface TaxDependent {
  id: string;
  employee_id: string;
  name: string;
  relationship: string | null;
  id_number: string | null;
  birth_year: number | null;
  support_status: "claimed";
}

export function getTaxDependents(employeeId: string) {
  return apiFetch<{ "income-tax-dependents": TaxDependent[] }>(
    `/income-tax-dependents?employeeId=${employeeId}`,
  );
}

export function addTaxDependent(body: {
  employeeId: string;
  name: string;
  relationship?: string;
  idNumber?: string;
  birthYear?: number;
}) {
  return apiFetch<{ id: string }>("/income-tax-dependents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteTaxDependent(id: string) {
  return apiFetch<{ id: string }>(`/income-tax-dependents/${id}`, { method: "DELETE" });
}

/* ------------------------------------------------ recruitment: 面試/錄用 --- */

export interface Interview {
  id: string;
  candidate_id: string;
  interviewer_emp_id: string | null;
  scheduled_at: string | null;
  stage: string | null;
  result: "pending" | "pass" | "fail";
  notes: string | null;
}

export function getInterviews(params?: string | {
  candidateId?: string;
  interviewerEmpId?: string;
  result?: Interview["result"];
}) {
  const filters = typeof params === "string" ? { candidateId: params } : (params ?? {});
  const qs = new URLSearchParams();
  if (filters.candidateId) qs.set("candidateId", filters.candidateId);
  if (filters.interviewerEmpId) qs.set("interviewerEmpId", filters.interviewerEmpId);
  if (filters.result) qs.set("result", filters.result);
  return apiFetch<{ interviews: Interview[] }>(`/interviews${qs.toString() ? `?${qs.toString()}` : ""}`);
}

export function createInterview(body: {
  candidateId: string;
  scheduledAt?: string;
  stage?: string;
  interviewerEmpId?: string | null;
}) {
  return apiFetch<{ id: string }>("/interviews", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateInterview(
  id: string,
  body: {
    interviewerEmpId?: string | null;
    result?: "pending" | "pass" | "fail";
    notes?: string | null;
    scheduledAt?: string | null;
    stage?: string | null;
  },
) {
  return apiFetch<{ id: string }>(`/interviews/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export interface Offer {
  id: string;
  candidate_id: string;
  salary: string | null;
  start_date: string | null;
  status: "draft" | "approved" | "sent" | "accepted" | "declined";
  note: string | null;
}

export function getOffers(params: { candidateId?: string; status?: Offer["status"] } = {}) {
  const qs = new URLSearchParams();
  if (params.candidateId) qs.set("candidateId", params.candidateId);
  if (params.status) qs.set("status", params.status);
  return apiFetch<{ offers: Offer[] }>(`/offers${qs.toString() ? `?${qs.toString()}` : ""}`);
}

export function createOffer(body: {
  candidateId: string;
  salary?: number;
  startDate?: string;
  status?: Offer["status"];
  note?: string;
}) {
  return apiFetch<{ id: string }>("/offers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateOffer(id: string, body: {
  salary?: number | null;
  startDate?: string | null;
  status?: Offer["status"];
  note?: string | null;
}) {
  return apiFetch<{ id: string }>(`/offers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/* ----------------------------------------------------------- dashboard --- */

export interface HeadcountMonth {
  month: string;
  opening: number;
  hires: number;
  exits: number;
  closing: number;
}

export function getHeadcount(params: {
  from: string;
  to: string;
  deptId?: string;
  employmentType?: string;
  jobGroup?: string;
}) {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  if (params.deptId) qs.set("deptId", params.deptId);
  if (params.employmentType) qs.set("employmentType", params.employmentType);
  if (params.jobGroup) qs.set("jobGroup", params.jobGroup);
  return apiFetch<{
    series: HeadcountMonth[];
    totals: { opening: number; hires: number; exits: number; closing: number };
  }>(`/dashboard/headcount?${qs.toString()}`);
}

export interface UserPreference<T = unknown> {
  id: string | null;
  tenant_id: string;
  employee_id: string;
  key: string;
  value: T | null;
  created_at: string | null;
  updated_at: string | null;
}

export function getPreference<T = unknown>(key: string) {
  return apiFetch<{ preference: UserPreference<T> }>(`/preferences/${encodeURIComponent(key)}`);
}

export function savePreference<T = unknown>(key: string, value: T) {
  return apiFetch<{ preference: UserPreference<T> }>(`/preferences/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export function getPayslip(id: string) {
  return apiFetch<{ payslip: Payslip & { breakdown: unknown } }>(`/payslips/${id}`);
}

export function exportTaxFilingUrl(type: "withholding" | "supplementary") {
  return `/tax-filing/export?type=${type}`;
}

/* --------------------------------------------------------- Apollo admin --- */

export interface AttendanceDay {
  id: string;
  employee_id: string;
  work_date: string;
  worked_minutes: number;
  late_minutes: number;
  overtime_minutes: number;
  night_minutes: number;
  day_type: string | null;
  anomaly: unknown;
}

export function settleAttendance(body: {
  employeeId?: string;
  from: string;
  to: string;
}) {
  return apiFetch<{ settled: number }>("/attendance/settle", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getAttendanceDays(params: {
  employeeId?: string;
  from?: string;
  to?: string;
} = {}) {
  const qs = new URLSearchParams();
  if (params.employeeId) qs.set("employeeId", params.employeeId);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  return apiFetch<{ attendanceDays: AttendanceDay[] }>(
    `/attendance-days${qs.toString() ? `?${qs.toString()}` : ""}`,
  );
}

export interface LeaveBalance {
  id: string;
  employee_id: string;
  leave_type_id: string;
  year: number;
  entitled: number | string;
  used: number | string;
  deferred: number | string;
}

export function getLeaveBalancesAdmin(params: { employeeId?: string; year?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.employeeId) qs.set("employeeId", params.employeeId);
  if (params.year) qs.set("year", String(params.year));
  return apiFetch<{ balances: LeaveBalance[] }>(
    `/leave-balances${qs.toString() ? `?${qs.toString()}` : ""}`,
  );
}

export function setLeaveBalance(body: {
  employeeId: string;
  leaveTypeId: string;
  year: number;
  entitled: number;
  deferred?: number;
}) {
  return apiFetch<{ id: string }>("/leave-balances", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export interface RuleConfigResponse {
  config: unknown;
  version: number;
  scope?: string;
  isDefault: boolean;
}

export function getRuleConfig() {
  return apiFetch<RuleConfigResponse>("/rule-config");
}

export function saveRuleConfig(config: unknown) {
  return apiFetch<{ id: string; version: number }>("/rule-config", {
    method: "PUT",
    body: JSON.stringify(config),
  });
}

export interface HeadcountReport {
  total: number;
  byStatus: Record<string, number>;
  byRole: Record<string, number>;
  byDept: { deptId: string | null; count: number }[];
}

export interface AttendanceReportRow {
  employeeId: string;
  employeeName: string;
  workedMinutes: number;
  lateDays: number;
  lateMinutes: number;
  overtimeMinutes: number;
  nightMinutes: number;
  presentDays: number;
}

export interface AttendanceReport {
  rows: AttendanceReportRow[];
}

export interface PayrollReportRow {
  employeeId: string;
  employeeName: string;
  base: number;
  overtimePay: number;
  nightPay: number;
  attendanceBonus: number;
  gross: number;
}

export interface PayrollReport {
  rows: PayrollReportRow[];
  total: { gross: number };
}

export interface LeaveReportSummaryRow {
  kind: string;
  status: string;
  count: number;
  hours: number;
}

export interface LeaveReportDetailRow {
  employeeId: string;
  employeeName: string;
  kind: string;
  status: string;
  hours: number;
  startAt: string;
  endAt: string;
}

export interface LeaveReport {
  rows: LeaveReportSummaryRow[];
  details: LeaveReportDetailRow[];
}

export function getHeadcountReport() {
  return apiFetch<HeadcountReport>("/reports/headcount");
}

export function getAttendanceReport(params: { from: string; to: string; deptId?: string }) {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  if (params.deptId) qs.set("deptId", params.deptId);
  return apiFetch<AttendanceReport>(`/reports/attendance?${qs.toString()}`);
}

export function getPayrollReport(period: string) {
  return apiFetch<PayrollReport>(`/reports/payroll?period=${encodeURIComponent(period)}`);
}

export function getLeaveReport(params: { from: string; to: string }) {
  const qs = new URLSearchParams({ from: params.from, to: params.to });
  return apiFetch<LeaveReport>(`/reports/leave?${qs.toString()}`);
}

export interface AiReportSummaryResponse {
  summary: string;
  model: string;
  context: unknown;
}

export interface AiAskResponse {
  answer: string;
  model: string;
  scope: "tenant" | "self";
}

export function generateAiReportSummary(body: {
  from: string;
  to: string;
  period: string;
  deptId?: string;
}) {
  return apiFetch<AiReportSummaryResponse>("/ai/report-summary", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function askAiQuestion(body: { question: string; from: string; to: string; period: string }) {
  return apiFetch<AiAskResponse>("/ai/ask", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface DemoSeedResult {
  ok: true;
  period: string;
  employees: number;
  departments: number;
  attendanceDays: number;
  payslips: number;
  notifications: number;
}

export function seedDemoData() {
  return apiFetch<DemoSeedResult>("/demo/seed", { method: "POST" });
}

/* ------------------------------------------------------- 報銷（模組三） */

export interface ExpenseCategory {
  id: string;
  code: string;
  name: string;
  /** 'reimbursement' 實報實銷（非所得）／'allowance' 定額補貼（屬薪資所得）。 */
  nature: "reimbursement" | "allowance";
  requires_receipt: boolean;
  cross_check_attendance: boolean;
  monthly_cap: string | null;
  active: boolean;
}

export interface ExpenseClaim {
  id: string;
  employee_id: string;
  category_id: string;
  nature: "reimbursement" | "allowance";
  amount: string;
  incurred_on: string;
  period: string;
  note: string | null;
  status: string;
  status_reason: string | null;
  settlement_id: string | null;
}

export interface ExpenseReview {
  period: string;
  claimCount: number;
  reimbursementTotal: number;
  allowanceTotal: number;
  issues: {
    missingReceipt: Array<{ claimId: string; employeeId: string; amount: number }>;
    overCap: Array<{ employeeId: string; categoryId: string; total: number; cap: number }>;
    attendanceMismatch: Array<{
      claimId: string;
      employeeId: string;
      incurredOn: string;
      amount: number;
      overtimeMinutes: number | null;
      hint: string;
    }>;
  };
}

export interface ExpenseSettlement {
  id: string;
  period: string;
  status: string;
  reimbursement_total: string;
  allowance_total: string;
  claim_count: number;
  note: string | null;
  settled_at: string | null;
}

export function getExpenseCategories() {
  return apiFetch<{ categories: ExpenseCategory[] }>("/expense-categories");
}

export function upsertExpenseCategory(body: {
  code: string;
  name: string;
  nature?: "reimbursement" | "allowance";
  requiresReceipt?: boolean;
  crossCheckAttendance?: boolean;
  monthlyCap?: number;
  active?: boolean;
}) {
  return apiFetch<{ category: { id: string; code: string; nature: string } }>(
    "/expense-categories",
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function getExpenseClaims(params: { period?: string; employeeId?: string; status?: string } = {}) {
  const q = new URLSearchParams();
  if (params.period) q.set("period", params.period);
  if (params.employeeId) q.set("employeeId", params.employeeId);
  if (params.status) q.set("status", params.status);
  const qs = q.toString();
  return apiFetch<{ claims: ExpenseClaim[] }>(`/expenses${qs ? `?${qs}` : ""}`);
}

/** 月結前的審視清單：缺憑證、超月限額、報銷 × 出勤不符。 */
export function getExpenseReview(period: string) {
  return apiFetch<ExpenseReview>(`/expense-settlements/${period}/review`);
}

export function settleExpenses(period: string, note?: string) {
  return apiFetch<{
    period: string;
    settlementId: string;
    claimCount: number;
    reimbursementTotal: number;
    allowanceTotal: number;
  }>(`/expense-settlements/${period}/settle`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? null }),
  });
}

export interface ExpenseAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
  contentType: string | null;
  contentHash: string | null;
  url: string | null;
}

/** 某筆報銷的憑證（含短效期 signed URL）。 */
export function getExpenseAttachments(claimId: string) {
  return apiFetch<{ attachments: ExpenseAttachment[] }>(`/expenses/${claimId}/attachments`);
}

export function getExpenseSettlements(period?: string) {
  return apiFetch<{ settlements: ExpenseSettlement[] }>(
    `/expense-settlements${period ? `?period=${period}` : ""}`,
  );
}

/* --------------------------------------------- 公告版本與簽收（模組二） */

export interface AnnouncementVersion {
  id: string;
  announcement_id: string;
  version_no: number;
  title: string;
  body: string;
  audience: string;
  change_type: "initial" | "amendment" | "annual_rollover";
  change_note: string | null;
  effective_from: string | null;
  effective_to: string | null;
  requires_signature: boolean;
  is_adverse_change: boolean;
  content_hash: string | null;
  created_at: string;
}

export interface AnnouncementAck {
  id: string;
  employee_id: string;
  kind: "consent_to_change" | "accept_on_hire";
  viewed_at: string | null;
  signed_at: string | null;
  signature_sheet_id: string | null;
  note: string | null;
}

export function getAnnouncementVersions(id: string) {
  return apiFetch<{ versions: AnnouncementVersion[] }>(`/announcements/${id}/versions`);
}

export function getAnnouncementAcks(id: string, versionId?: string) {
  return apiFetch<{
    versionId: string | null;
    signed: AnnouncementAck[];
    pending: AnnouncementAck[];
    /** 只計 consent_to_change：新人到職接受不進分母也不進分子。 */
    consentRate: { signed: number; total: number } | null;
  }>(`/announcements/${id}/acknowledgements${versionId ? `?versionId=${versionId}` : ""}`);
}

/** HR 登錄紙本簽署。signedAt 是實際簽署日，掃描檔上看不出來，必須人工輸入。 */
export function recordPaperSignature(
  versionId: string,
  body: { employeeId: string; kind?: "consent_to_change" | "accept_on_hire"; signedAt?: string; note?: string },
) {
  return apiFetch<{ acknowledgement: AnnouncementAck }>(
    `/announcement-versions/${versionId}/acknowledge`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export interface SignatureSheet {
  id: string;
  sheetNo: number;
  fileName: string;
  sizeBytes: number;
  contentHash: string | null;
  note: string | null;
  uploadedAt: string;
  url: string | null;
}

export function getSignatureSheets(versionId: string) {
  return apiFetch<{ sheets: SignatureSheet[] }>(`/announcement-versions/${versionId}/sheets`);
}

/** 補簽後上傳新的掃描檔（加一份，不覆蓋舊的）。 */
export async function uploadSignatureSheet(versionId: string, file: File, note?: string) {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("讀取檔案失敗"));
    r.readAsDataURL(file);
  });
  return apiFetch<{ id: string; sheetNo: number }>(
    `/announcement-versions/${versionId}/sheets`,
    {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        dataBase64,
        note: note ?? undefined,
      }),
    },
  );
}
