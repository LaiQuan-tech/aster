/**
 * 員工內頁（/admin/employees/[id]）編輯表單的純函式（不碰 DOM／API，vitest 直接測）。
 *
 * 2026-10-26 業主：列表按「編輯」原本在列下方展開行內表單，十幾個欄位擠成好幾排、還容易誤以為在改上一列的人，
 * 改成進員工內頁編輯。欄位與寫回方式沿用原行內表單：
 *   - 員工欄位（姓名、工號、單位、身分類別、所屬公司、角色、狀態、到離職、預設班別、個人功能開關）→ PATCH /employees/:id
 *   - 個資欄位（生日、身分證、戶籍地、匯款帳號四欄）→ PUT /employees/:id/profile（lib/employee-personal.ts）
 * 兩者都**只送有變更的欄位**：
 *   - 沒動到的角色不送，受保護帳號（老闆／HR 管理員…）的其他欄位照樣存得了，不會被「角色變更」的 403 擋下；
 *   - 預設班別／功能開關（0068）、所屬公司（0072）沒動就不送，DB 還沒套 migration 時不會被 409 擋住其他欄位；
 *   - 「可看集團財務」只有老闆／平台管理員能改，HR 帶這個鍵一律 403，所以沒動就絕不送。
 */
import type { Employee } from "./admin-api";
import { personalChanges, type PersonalForm } from "./employee-personal";
import type { PrivilegePolicy, PrivilegeViewer } from "./privileged-accounts";

/** 個人功能開關（employees.features）。seeGroupFinancials＝可看集團財務（2026-10-26，只對 HR 管理員有效）。 */
export interface EmployeeFeatureFlags {
  wfhPunch?: boolean;
  noNightPremium?: boolean;
  seeGroupFinancials?: boolean;
}

/** 內頁需要的員工欄位（Employee 的子集；features 多認 seeGroupFinancials，舊 API 沒有就當 false）。 */
export type EditableEmployee = Pick<
  Employee,
  "name" | "role" | "dept_id" | "emp_no" | "employment_type" | "hire_date" | "terminated_at" | "status"
> & {
  default_shift_id?: string | null;
  company_id?: string | null;
  features?: EmployeeFeatureFlags | null;
};

/** 受控表單狀態：文字／下拉一律字串（沒資料＝空字串），開關是 boolean。 */
export interface EmployeeForm {
  name: string;
  empNo: string;
  deptId: string;
  employmentType: string;
  companyId: string;
  role: string;
  status: string;
  hireDate: string;
  terminatedAt: string;
  /** ""＝依公司規則（沒有個人班別）。 */
  defaultShiftId: string;
  wfhPunch: boolean;
  noNightPremium: boolean;
  seeGroupFinancials: boolean;
}

/** PATCH /employees/:id 的 body（同 admin-api updateEmployee 的參數，features 多一個鍵）。 */
export interface EmployeePatch {
  name?: string;
  role?: string;
  status?: string;
  deptId?: string | null;
  empNo?: string | null;
  employmentType?: string;
  hireDate?: string | null;
  terminatedAt?: string | null;
  defaultShiftId?: string | null;
  features?: EmployeeFeatureFlags;
  companyId?: string | null;
}

export function employeeFormFrom(employee: EditableEmployee): EmployeeForm {
  return {
    name: employee.name ?? "",
    empNo: employee.emp_no ?? "",
    deptId: employee.dept_id ?? "",
    employmentType: employee.employment_type ?? "regular",
    companyId: employee.company_id ?? "",
    role: employee.role,
    status: employee.status,
    hireDate: employee.hire_date ?? "",
    terminatedAt: employee.terminated_at ?? "",
    defaultShiftId: employee.default_shift_id ?? "",
    wfhPunch: employee.features?.wfhPunch === true,
    noNightPremium: employee.features?.noNightPremium === true,
    seeGroupFinancials: employee.features?.seeGroupFinancials === true,
  };
}

/** 空字串（去頭尾空白後）→ null。 */
const orNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * 只含「有變更」欄位的 PATCH body；沒有任何變更回 `{}`（呼叫端據此決定要不要打 API）。
 * 比對前兩邊都正規化（去頭尾空白、空字串＝null），所以只是點進來沒改就儲存不會多送。
 * 姓名清成空白不送（沿用原行內表單：`name.trim() || undefined`；畫面另有必填檢查 validateEmployeeForm）。
 */
export function employeePatch(employee: EditableEmployee, form: EmployeeForm): EmployeePatch {
  const base = employeeFormFrom(employee);
  const patch: EmployeePatch = {};

  const name = form.name.trim();
  if (name && name !== base.name.trim()) patch.name = name;
  if (orNull(form.empNo) !== orNull(base.empNo)) patch.empNo = orNull(form.empNo);
  if (orNull(form.deptId) !== orNull(base.deptId)) patch.deptId = orNull(form.deptId);
  if (form.employmentType !== base.employmentType) patch.employmentType = form.employmentType;
  if (form.role !== base.role) patch.role = form.role;
  if (form.status !== base.status) patch.status = form.status;
  if (orNull(form.hireDate) !== orNull(base.hireDate)) patch.hireDate = orNull(form.hireDate);
  if (orNull(form.terminatedAt) !== orNull(base.terminatedAt)) patch.terminatedAt = orNull(form.terminatedAt);
  if (orNull(form.defaultShiftId) !== orNull(base.defaultShiftId)) patch.defaultShiftId = orNull(form.defaultShiftId);
  if (orNull(form.companyId) !== orNull(base.companyId)) patch.companyId = orNull(form.companyId);

  const features: EmployeeFeatureFlags = {};
  if (form.wfhPunch !== base.wfhPunch) features.wfhPunch = form.wfhPunch;
  if (form.noNightPremium !== base.noNightPremium) features.noNightPremium = form.noNightPremium;
  if (form.seeGroupFinancials !== base.seeGroupFinancials) features.seeGroupFinancials = form.seeGroupFinancials;
  if (Object.keys(features).length > 0) patch.features = features;

  return patch;
}

/** 表單和現值有沒有任何差異（員工欄位或個資欄位）——「未儲存就離開」的提示用。 */
export function hasUnsavedChanges(
  employee: EditableEmployee & Parameters<typeof personalChanges>[0],
  form: EmployeeForm,
  personal: PersonalForm,
): boolean {
  if (form.name.trim() === "" && employee.name.trim() !== "") return true; // 清空姓名也算動過（存不了，但離開要提醒）
  return Object.keys(employeePatch(employee, form)).length > 0 || Object.keys(personalChanges(employee, personal)).length > 0;
}

/** 儲存前的檢查；回 null＝可以送。 */
export function validateEmployeeForm(form: EmployeeForm): string | null {
  if (!form.name.trim()) return "姓名不可空白";
  if (form.hireDate && form.terminatedAt && form.terminatedAt < form.hireDate) return "離職日不能早於到職日";
  return null;
}

/**
 * 登入者能不能授權／取消別人的「可看集團財務」：只有老闆（tenants.features 的 fallbackApproverEmpId）或平台管理員。
 * 與 API services/financial-visibility.ts canGrantGroupFinancials 同一條規則；登入者還沒載入＝不能（開關不顯示）。
 */
export function canGrantGroupFinancialsView(viewer: PrivilegeViewer | null | undefined, policy: PrivilegePolicy): boolean {
  if (!viewer) return false;
  if (viewer.role.trim().toLowerCase() === "platform_admin") return true;
  return !!policy.bossEmpId && policy.bossEmpId === viewer.id.trim().toLowerCase();
}

/**
 * 內頁實際用的判斷：/me.canGrantGroupFinancials（API 算的，與 PATCH 的 403 同一條規則）優先；
 * 舊版 API 沒有這個欄位（undefined）才退回前端推算 canGrantGroupFinancialsView。
 */
export function canGrantGroupFinancialsOf(
  meCanGrant: boolean | undefined,
  viewer: PrivilegeViewer | null | undefined,
  policy: PrivilegePolicy,
): boolean {
  if (typeof meCanGrant === "boolean") return meCanGrant;
  return canGrantGroupFinancialsView(viewer, policy);
}

/* ----------------------------------------------------------- 顯示用常數 ----- */

/** 角色下拉的固定選項（platform_admin 由 privileged-accounts roleOptionsFor 依登入者補上）。 */
export const EMPLOYEE_ROLES: { value: string; label: string }[] = [
  { value: "employee", label: "一般員工" },
  { value: "manager", label: "主管" },
  // W4：會計可進後台，但只看得到專案與財務／報銷／預支／出勤月表／人員基本資料，
  // 薪資作業、薪資單、獎金批次與分潤趴數一律看不到（守門在 API 的 requireFinance）。
  { value: "accountant", label: "會計" },
  { value: "hr_admin", label: "HR 管理員" },
];

export function employeeRoleLabel(role: string): string {
  if (role === "platform_admin") return "平台管理員";
  return EMPLOYEE_ROLES.find((item) => item.value === role)?.label ?? role;
}

export function employeeStatusLabel(status: string): string {
  if (status === "active") return "在職";
  if (status === "inactive") return "停用";
  return status;
}

/** 內頁網址（列表的「編輯」與整列點擊共用）。 */
export function employeeDetailHref(id: string): string {
  return `/admin/employees/${encodeURIComponent(id)}`;
}
