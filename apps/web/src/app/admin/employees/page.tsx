"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button, Card, Empty, ErrorText, PrimaryButton, Segmented, inputCls, labelCls, useToast } from "@/components/admin-ui";
import { ActionMenu } from "@/components/ActionMenu";
import { BatchImportButton } from "@/components/BatchImport";
import { CollapsibleCard } from "@/components/CollapsibleCard";
import {
  assignEmployeesCompany,
  addEmployeeCertification,
  addEmployeeEducation,
  addEmployeeJobHistory,
  addEmployeeWorkHistory,
  deleteEmployeeCertification,
  deleteEmployeeCertificationAttachment,
  deleteEmployeeEducation,
  deleteEmployeeEducationAttachment,
  deleteEmployeeProfilePhoto,
  deleteEmployeeWorkHistory,
  getDepartments,
  getShifts,
  type Shift,
  getEmployeeProfile,
  getEmployeesWithProfile,
  inviteEmployee,
  saveEmployeeProfile,
  uploadEmployeeCertificationAttachment,
  uploadEmployeeEducationAttachment,
  uploadEmployeeProfilePhoto,
  type Department,
  type EmployeeWithProfile,
  type ProfileAggregate,
  type SaveProfileBody,
} from "@/lib/admin-api";
import {
  bulkInviteEmployees,
  toInviteCsv,
  type BulkInviteResult,
} from "@/lib/auth-api";
import { employeeActionsFor } from "@/lib/employee-actions";
import { employeeDetailHref } from "@/lib/employee-edit";
import { describeEmployeeError } from "@/lib/employee-errors";
import {
  bankDisplay,
} from "@/lib/employee-personal";
import {
  approveProfileChange,
  listProfileChangeRequests,
  rejectProfileChange,
  type ProfileChangeRequest,
} from "@/lib/people-extras-api";
import { isBulkInviteResult } from "@/lib/import-view";
import { listCompanies, type Company } from "@/lib/projects-ext-api";
import { companyOptions } from "@/lib/company-options";
import {
  UNASSIGNED_FILTER,
  companyLabel,
  filterByCompany,
  toggleAllVisible,
  toggleSelected,
} from "@/lib/employee-company";
import { EMPLOYMENT_TYPES as EMPLOYMENT_TYPE_VALUES, EMPLOYMENT_TYPE_LABELS } from "@/lib/ess-tabs";
import { getBrandingCached, getMeCached, peekMeCached } from "@/lib/ess-state";
import {
  CREDENTIALS_LOCKED_NOTE,
  PLATFORM_ADMIN_ASSIGN_NOTE,
  canAssignPlatformAdmin,
  credentialsLockedFor,
  privilegePolicyOf,
  roleOptionsFor,
  type PrivilegePolicy,
  type PrivilegeViewer,
} from "@/lib/privileged-accounts";
import { isHrRole } from "@/lib/roles";
import { useSession } from "@/lib/use-session";
import { useEmployeeAccountActions } from "./_components/useEmployeeAccountActions";

const ROLES: { value: string; label: string }[] = [
  { value: "employee", label: "一般員工" },
  { value: "manager", label: "主管" },
  // W4：會計可進後台，但只看得到專案與財務／報銷／預支／出勤月表／人員基本資料，
  // 薪資作業、薪資單、獎金批次與分潤趴數一律看不到（守門在 API 的 requireFinance）。
  { value: "accountant", label: "會計" },
  { value: "hr_admin", label: "HR 管理員" },
];

/**
 * 身分類別下拉與列表顯示共用 lib/ess-tabs.ts 的 EMPLOYMENT_TYPES／EMPLOYMENT_TYPE_LABELS
 * （值域四種不變；`parttime` 的標籤是「工讀／兼職（時薪）」——2026-09-23 正式站驗收發現
 * 這裡的下拉還寫死「兼職」，客戶找不到「工讀」）。
 */
const EMPLOYMENT_TYPES: { value: string; label: string }[] = EMPLOYMENT_TYPE_VALUES.map((value) => ({
  value,
  label: EMPLOYMENT_TYPE_LABELS[value],
}));

const PROFILE_FIELDS: { key: keyof SaveProfileBody; label: string; type?: "date"; group: "basic" | "contact" }[] = [
  { key: "lastName", label: "姓", group: "basic" },
  { key: "firstName", label: "名", group: "basic" },
  { key: "englishName", label: "英文姓名", group: "basic" },
  { key: "nationality", label: "國籍", group: "basic" },
  { key: "gender", label: "性別", group: "basic" },
  { key: "idType", label: "證件類型1", group: "basic" },
  { key: "idNumber", label: "證件號碼1", group: "basic" },
  { key: "idExpiry", label: "證件到期1", type: "date", group: "basic" },
  { key: "idType2", label: "證件類型2", group: "basic" },
  { key: "idNumber2", label: "證件號碼2", group: "basic" },
  { key: "idExpiry2", label: "證件到期2", type: "date", group: "basic" },
  { key: "idType3", label: "證件類型3", group: "basic" },
  { key: "idNumber3", label: "證件號碼3", group: "basic" },
  { key: "idExpiry3", label: "證件到期3", type: "date", group: "basic" },
  { key: "entryDate", label: "入境時間", type: "date", group: "basic" },
  { key: "birthday", label: "生日", type: "date", group: "basic" },
  { key: "maritalStatus", label: "婚姻狀態", group: "basic" },
  { key: "phone", label: "手機", group: "contact" },
  { key: "phoneMobile2", label: "手機2", group: "contact" },
  { key: "phoneLandline", label: "市話", group: "contact" },
  { key: "registeredAddress", label: "戶籍地址", group: "contact" },
  { key: "address", label: "聯絡地址", group: "contact" },
  { key: "companyEmail", label: "公司信箱", group: "contact" },
  { key: "personalEmail", label: "私人信箱", group: "contact" },
  { key: "lineUserId", label: "LINE User ID", group: "contact" },
  { key: "emergencyContact", label: "緊急聯絡人", group: "contact" },
  { key: "emergencyRelationship", label: "關係", group: "contact" },
  { key: "emergencyPhone", label: "緊急聯絡電話", group: "contact" },
];

/**
 * 資料異動待審（W6）。租戶在「模組設定 → 表單參數」打開
 * `myDataRequiresApproval` 後，員工在 ESS 改自己的資料不會直接落庫，而是排在
 * 這裡等 HR 核准。**沒有待審就整張不顯示**——這是一張只有在有事時才該出現的卡。
 */
function ProfileChangeQueue({ onApplied }: { onApplied: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<ProfileChangeRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    listProfileChangeRequests("pending")
      .then((r) => setRows(r.requests))
      .catch(() => setRows([])); // 表還沒建（migration 0050 未套）就當作沒有待審
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function decide(row: ProfileChangeRequest, approve: boolean) {
    let reason = "";
    if (!approve) {
      const input = window.prompt(`退回 ${row.employeeName ?? "員工"} 的資料異動。請輸入理由（必填）：`);
      if (input === null) return;
      if (!input.trim()) {
        toast.show("退回理由為必填", "error");
        return;
      }
      reason = input.trim();
    }
    setBusyId(row.id);
    try {
      if (approve) {
        await approveProfileChange(row.id);
        toast.show("已核准並套用", "success");
        onApplied();
      } else {
        await rejectProfileChange(row.id, reason);
        toast.show("已退回", "success");
      }
      reload();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "處理失敗", "error");
    } finally {
      setBusyId(null);
    }
  }

  if (rows.length === 0) return null;

  return (
    <Card>
      <h2 className="mb-1 text-sm font-medium text-gray-500">資料異動待審（{rows.length}）</h2>
      <p className="mb-3 text-xs text-gray-400">員工在「我的資料」送出的修改，核准後才會寫進人事資料。</p>
      <ul className="divide-y divide-gray-100">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-800">{row.employeeName ?? row.employee_id.slice(0, 8)}</p>
              <ul className="mt-1 space-y-0.5 text-sm text-gray-600">
                {row.fields.map((field) => (
                  <li key={field.column}>
                    {field.label}：
                    <span className="text-gray-400">{String(field.from ?? "（空）")}</span>
                    <span className="mx-1">→</span>
                    <span className="text-gray-900">{String(field.to ?? "（清空）")}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-gray-400">{new Date(row.created_at).toLocaleString("zh-TW")}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => void decide(row, true)} loading={busyId === row.id}>
                核准
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void decide(row, false)}
                disabled={busyId === row.id}
              >
                退回
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const SNAKE: Record<keyof SaveProfileBody, string> = {
  firstName: "first_name",
  lastName: "last_name",
  englishName: "english_name",
  nationality: "nationality",
  idType: "id_type",
  idNumber: "id_number",
  idExpiry: "id_expiry",
  idType2: "id_type2",
  idNumber2: "id_number2",
  idExpiry2: "id_expiry2",
  idType3: "id_type3",
  idNumber3: "id_number3",
  idExpiry3: "id_expiry3",
  entryDate: "entry_date",
  birthday: "birthday",
  gender: "gender",
  maritalStatus: "marital_status",
  phone: "phone",
  phoneMobile2: "phone_mobile2",
  phoneLandline: "phone_landline",
  registeredAddress: "registered_address",
  address: "address",
  companyEmail: "company_email",
  personalEmail: "personal_email",
  lineUserId: "line_user_id",
  emergencyContact: "emergency_contact",
  emergencyRelationship: "emergency_relationship",
  emergencyPhone: "emergency_phone",
  note: "note",
  bankCode: "bank_code",
  bankName: "bank_name",
  bankAccount: "bank_account",
  accountHolder: "account_holder",
};

function roleLabel(role: string): string {
  // platform_admin 不在下拉的固定清單裡（只有 platform_admin 能指派，選項由 roleOptionsFor 依登入者補上），列表仍要顯示中文。
  if (role === "platform_admin") return "平台管理員";
  return ROLES.find((item) => item.value === role)?.label ?? role;
}

function employmentTypeLabel(value: string | null) {
  return EMPLOYMENT_TYPES.find((item) => item.value === value)?.label ?? value ?? "—";
}

/** 列表「匯款帳號」欄：第一行「代碼 銀行名稱」、第二行帳號、戶名與員工姓名不同才顯示第三行；全空＝「—」。 */
function BankCell({ employee }: { employee: EmployeeWithProfile }) {
  const { bank, account, holder } = bankDisplay(employee);
  if (!bank && !account && !holder) return <>—</>;
  return (
    <div className="space-y-0.5">
      {bank && <p>{bank}</p>}
      {account && <p className="tabular-nums">{account}</p>}
      {holder && <p className="text-xs text-gray-400">戶名 {holder}</p>}
    </div>
  );
}

/** 錯誤訊息對照搬到 lib/employee-errors.ts（員工內頁共用）。 */
const describeError = describeEmployeeError;

function profileInitial(profile: ProfileAggregate | null) {
  const values: Record<string, string> = {};
  for (const field of PROFILE_FIELDS) {
    const raw = profile?.profile
      ? (profile.profile as unknown as Record<string, string | null>)[SNAKE[field.key]]
      : null;
    values[field.key] = raw ?? "";
  }
  return values;
}

/**
 * 員工列表表頭釘選共用 class。底線改用 th 自己的 inset 陰影（不是 tr 的 border-b）：
 * Tailwind v4 preflight 把 table 設成 border-collapse:collapse，collapse 後 tr 的邊框
 * 畫在表格「原位」，th 變 sticky 浮動捲動後底線就留在原地不會跟著走；兩者都留在窄螢幕
 * 未捲動時會疊成 2px。z-10 蓋過 tbody 內容，bg-white 對齊 Card 本身的白底。
 */
const STICKY_TH = "sticky top-0 z-10 bg-white shadow-[inset_0_-1px_0_var(--color-gray-200)]";

/**
 * 操作欄（編輯／⋯）釘在表格右側。加了生日／身分證／戶籍地／匯款帳號後表格比外框寬，橫向捲動時
 * 不釘住的話，要先捲到最右邊才找得到「編輯」。表頭那格同時釘上方與右側，z-20 蓋過其他表頭（z-10）；
 * 內容格 z-[5] 低於表頭（直向捲動時從表頭下面穿過去）。左緣 1px 淡線標出「這欄是浮著的」。
 */
const PIN_RIGHT_TH =
  "sticky top-0 right-0 z-20 bg-white shadow-[inset_0_-1px_0_var(--color-gray-200),inset_1px_0_0_var(--color-gray-100)]";
const PIN_RIGHT_TD = "sticky right-0 z-[5] bg-white shadow-[inset_1px_0_0_var(--color-gray-100)]";

export default function EmployeesPage() {
  const toast = useToast();
  // 登入者的 auth user id：拿來算 isSelf 給 employeeActionsFor（目前沒有「不能停用自己」的規則，只是傳真值）。
  const { session } = useSession();
  const selfUserId = session?.user.id ?? null;
  // 登入者能不能「管理」員工名冊：建立帳號／改員工資料／重設密碼／停用／批次建立／異動紀錄在 API 都是 requireHrAdmin，
  // My Data 維護是「本人或 HR」，資料異動核准也只有 HR——會計（可進後台、只能唯讀看名冊，GET /employees 放行 requireFinance）
  // 按了只會 403，所以這些入口只給 HR／平台管理員（isHrRole，不是 isAdminRole：後者含會計）。
  // 取不到角色就當不能：API 才是真正的守門，這裡只是不顯示按了必 403 的入口。/me 已由 AuthGate／AdminGate 先抓進快取，
  // 同步 peek 讓 HR 第一個畫面就有按鈕，不會閃一下才長出來。
  const [canManage, setCanManage] = useState(() => isHrRole(peekMeCached()?.role));
  useEffect(() => {
    let active = true;
    getMeCached()
      .then((me) => {
        if (active) setCanManage(isHrRole(me.role));
      })
      .catch(() => {
        if (active) setCanManage(false);
      });
    return () => {
      active = false;
    };
  }, []);
  // 特權帳號邊界（2026-10-11，lib/privileged-accounts.ts）：登入者是誰、老闆與老闆指定的人是誰，決定
  // 角色下拉能不能選「平台管理員」、哪幾列的重設密碼／寄信被停用。後端同樣擋（403），這裡只是不讓人按了才被拒；
  // 還沒載入完＝不鎖（以後端為準）。
  const [viewer, setViewer] = useState<PrivilegeViewer | null>(() => {
    const cached = peekMeCached();
    return cached ? { id: cached.id, role: cached.role } : null;
  });
  const [privilegePolicy, setPrivilegePolicy] = useState<PrivilegePolicy>({ bossEmpId: null, designated: [] });
  useEffect(() => {
    let active = true;
    Promise.all([getMeCached(), getBrandingCached()])
      .then(([me, brand]) => {
        if (!active) return;
        setViewer({ id: me.id, role: me.role });
        setPrivilegePolicy(privilegePolicyOf(brand.features));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const canAssignPlatform = canAssignPlatformAdmin(viewer);
  const createRoleOptions = useMemo(() => roleOptionsFor(ROLES, viewer), [viewer]);
  const credentialsLockedOf = (employee: { id: string; role: string }) =>
    credentialsLockedFor(viewer, { id: employee.id, role: employee.role }, privilegePolicy);
  const [rows, setRows] = useState<EmployeeWithProfile[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("employee");
  const [deptId, setDeptId] = useState("");
  const [empNo, setEmpNo] = useState("");
  const [employmentType, setEmploymentType] = useState("regular");
  const [hireDate, setHireDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 批次建立帳號改走 BatchImportButton（Excel 範本面板）；這裡只留「只建帳號、不寄信」的選項。
  const [bulkNoEmail, setBulkNoEmail] = useState(false);

  const [shifts, setShifts] = useState<Shift[]>([]);
  // 員工所屬公司（2026-10-25）：編輯下拉、列表篩選、多選批次指派。
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyFilter, setCompanyFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchCompanyId, setBatchCompanyId] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [profileEmpId, setProfileEmpId] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileAggregate | null>(null);
  const [profileValues, setProfileValues] = useState<Record<string, string>>({});
  const [profileTab, setProfileTab] = useState<"basic" | "contact">("basic");
  const [showEduForm, setShowEduForm] = useState(false);
  const [showCertForm, setShowCertForm] = useState(false);
  const [showWorkForm, setShowWorkForm] = useState(false);
  const [showJobForm, setShowJobForm] = useState(false);
  const [eduDraft, setEduDraft] = useState({
    school: "",
    degree: "",
    majorCategory: "",
    major: "",
    studyType: "日間部",
    studyStatus: "畢業",
    region: "",
    startDate: "",
    endDate: "",
    isHighest: false,
  });
  const [eduProofFile, setEduProofFile] = useState<File | null>(null);
  const [certDraft, setCertDraft] = useState({ name: "", issuer: "", issuedDate: "", expiryDate: "" });
  const [certAttachmentFile, setCertAttachmentFile] = useState<File | null>(null);
  const [workDraft, setWorkDraft] = useState({ company: "", title: "", startDate: "", endDate: "", description: "" });
  const [jobDraft, setJobDraft] = useState({
    effectiveDate: "",
    action: "資料調整",
    deptId: "",
    grade: "",
    title: "",
  });

  const deptNameMap = useMemo(() => new Map(depts.map((dept) => [dept.id, dept.name])), [depts]);
  const selectedEmployee = rows.find((employee) => employee.id === profileEmpId) ?? null;

  // 只有這一頁與薪資作業頁（證號搜尋）帶 include=profile 拿全員個資欄位（其餘頁面的 getEmployees() 不帶，見 admin-api）。
  const fetchRows = useCallback(async () => {
    const [empRes, deptRes] = await Promise.all([getEmployeesWithProfile(), getDepartments()]);
    setRows(empRes.employees);
    setDepts(deptRes.departments);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await fetchRows();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [fetchRows]);

  const loadProfile = useCallback(async (employeeId: string) => {
    const data = await getEmployeeProfile(employeeId);
    setProfile(data);
    setProfileValues(profileInitial(data));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 預設班別下拉的選項（/admin/shifts 的班別）；抓不到就只剩「依公司規則」。
  useEffect(() => {
    getShifts()
      .then((res) => setShifts(res.shifts))
      .catch(() => setShifts([]));
  }, []);
  const shiftNameMap = useMemo(() => new Map(shifts.map((shift) => [shift.id, shift])), [shifts]);

  // 所屬公司下拉／篩選的選項（名冊 → 公司主體）；抓不到就只剩「未指派」。
  useEffect(() => {
    listCompanies()
      .then((res) => setCompanies(res.companies))
      .catch(() => setCompanies([]));
  }, []);
  const visibleRows = useMemo(() => filterByCompany(rows, companyFilter), [rows, companyFilter]);
  const visibleIds = useMemo(() => visibleRows.map((row) => row.id), [visibleRows]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  /** 多選批次指派所屬公司（「」＝改回未指派）。成功後清掉勾選、靜默重載。 */
  async function applyBatchCompany() {
    if (batchBusy || selectedIds.size === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    try {
      const res = await assignEmployeesCompany([...selectedIds], batchCompanyId || null);
      const target = batchCompanyId ? (companies.find((c) => c.id === batchCompanyId)?.name ?? "所選公司") : "未指派";
      setMessage(`已把 ${res.updated} 位員工指派到「${target}」`);
      setSelectedIds(new Set());
      await fetchRows();
    } catch (err) {
      setBatchError(describeError(err, "批次指派失敗"));
    } finally {
      setBatchBusy(false);
    }
  }

  const actions = useEmployeeAccountActions({
    onChanged: fetchRows,
    onOpenProfile: (target) => void openProfile(target.id),
  });

  // 員工內頁的「My Data」連回來時帶 ?profile=<id>：載入後直接展開那位員工的 My Data 維護區並捲過去。
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("profile");
    if (!target || !canManage) return;
    void openProfile(target).then(() => {
      document.getElementById("employee-profile-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    // 只在第一次進頁面時處理；canManage 從快取同步取得，之後變動不重開。
  }, []);

  async function openProfile(employeeId: string) {
    setProfileEmpId(employeeId);
    setProfile(null);
    setError(null);
    try {
      await loadProfile(employeeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入 My Data 失敗");
    }
  }

  async function onInvite(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (!email.trim() || !name.trim()) {
      setFormError("請填寫 Email 與姓名");
      return;
    }
    if (password && password.length < 8) {
      setFormError("初始密碼至少 8 碼；留空則改寄邀請信讓員工自設密碼");
      return;
    }
    setSubmitting(true);
    try {
      if (password) {
        await inviteEmployee({
          email: email.trim(),
          name: name.trim(),
          password,
          role,
          deptId: deptId || undefined,
          empNo: empNo.trim() || undefined,
          employmentType,
          hireDate: hireDate || undefined,
        });
        setMessage(`已建立 ${name.trim()} 的帳號（配發初始密碼，首次登入會被要求改密碼）`);
      } else {
        // 不填密碼：走批次邀請的單行 CSV，建 auth user＋寄邀請信（或 dryRun 回連結）。
        const res = await bulkInviteEmployees(
          toInviteCsv({
            name: name.trim(),
            email: email.trim(),
            empNo: empNo.trim() || undefined,
            deptName: deptId ? deptNameMap.get(deptId) : undefined,
            employmentType,
            hireDate: hireDate || undefined,
            role,
          }),
        );
        const row = res.rows[0];
        if (!row || row.action === "skipped") {
          setFormError(row?.error ? describeError(new Error(row.error), "邀請失敗") : "邀請失敗");
          return;
        }
        actions.showLinkResult(name.trim(), {
            sent: row.sent === true,
            dryRun: res.dryRun,
            type: row.type ?? "invite",
            email: row.email ?? email.trim(),
            action: row.action,
            link: row.link,
        });
        setMessage(res.dryRun ? `已建立 ${name.trim()} 的帳號（未寄信，請複製下方連結轉交）` : `已建立 ${name.trim()} 的帳號並寄出邀請信`);
      }
      setEmail("");
      setName("");
      setPassword("");
      setRole("employee");
      setDeptId("");
      setEmpNo("");
      setEmploymentType("regular");
      setHireDate("");
      await load();
    } catch (err) {
      setFormError(describeError(err, "邀請失敗"));
    } finally {
      setSubmitting(false);
    }
  }

  async function saveProfileFields(event: FormEvent) {
    event.preventDefault();
    if (!profileEmpId) return;
    const body: SaveProfileBody = {};
    for (const field of PROFILE_FIELDS) {
      const value = (profileValues[field.key] ?? "").trim();
      (body as Record<string, string | null>)[field.key] = value || null;
    }
    await saveEmployeeProfile(profileEmpId, body);
    setMessage("My Data 已儲存");
    await loadProfile(profileEmpId);
  }

  async function submitEducation(event: FormEvent) {
    event.preventDefault();
    if (!profileEmpId) return;
    if (!eduDraft.school.trim()) return;
    const created = await addEmployeeEducation(profileEmpId, {
      school: eduDraft.school.trim(),
      isHighest: eduDraft.isHighest,
      majorCategory: eduDraft.majorCategory.trim() || undefined,
      major: eduDraft.major.trim() || undefined,
      degree: eduDraft.degree.trim() || undefined,
      studyType: eduDraft.studyType.trim() || undefined,
      studyStatus: eduDraft.studyStatus.trim() || undefined,
      region: eduDraft.region.trim() || undefined,
      startDate: eduDraft.startDate || undefined,
      endDate: eduDraft.endDate || undefined,
    });
    if (eduProofFile) await uploadEmployeeEducationAttachment(created.id, eduProofFile);
    setEduDraft({ school: "", degree: "", majorCategory: "", major: "", studyType: "日間部", studyStatus: "畢業", region: "", startDate: "", endDate: "", isHighest: false });
    setEduProofFile(null);
    setShowEduForm(false);
    await loadProfile(profileEmpId);
  }

  async function submitCertification(event: FormEvent) {
    event.preventDefault();
    if (!profileEmpId) return;
    if (!certDraft.name.trim()) return;
    const created = await addEmployeeCertification(profileEmpId, {
      name: certDraft.name.trim(),
      issuer: certDraft.issuer.trim() || undefined,
      issuedDate: certDraft.issuedDate || undefined,
      expiryDate: certDraft.expiryDate || undefined,
    });
    if (certAttachmentFile) await uploadEmployeeCertificationAttachment(created.id, certAttachmentFile);
    setCertDraft({ name: "", issuer: "", issuedDate: "", expiryDate: "" });
    setCertAttachmentFile(null);
    setShowCertForm(false);
    await loadProfile(profileEmpId);
  }

  async function onProfilePhotoFile(file: File | null) {
    if (!profileEmpId || !file) return;
    await uploadEmployeeProfilePhoto(profileEmpId, file);
    await loadProfile(profileEmpId);
  }

  async function removeProfilePhoto() {
    if (!profileEmpId) return;
    await deleteEmployeeProfilePhoto(profileEmpId);
    await loadProfile(profileEmpId);
  }

  async function submitWorkHistory(event: FormEvent) {
    event.preventDefault();
    if (!profileEmpId) return;
    if (!workDraft.company.trim()) return;
    await addEmployeeWorkHistory(profileEmpId, {
      company: workDraft.company.trim(),
      title: workDraft.title.trim() || undefined,
      startDate: workDraft.startDate || undefined,
      endDate: workDraft.endDate || undefined,
      description: workDraft.description.trim() || undefined,
    });
    setWorkDraft({ company: "", title: "", startDate: "", endDate: "", description: "" });
    setShowWorkForm(false);
    await loadProfile(profileEmpId);
  }

  async function submitJobHistory(event: FormEvent) {
    event.preventDefault();
    if (!profileEmpId) return;
    if (!jobDraft.effectiveDate || !jobDraft.action.trim()) return;
    const selectedDeptId = jobDraft.deptId || profile?.basic.dept_id || "";
    const dept = depts.find((item) => item.id === selectedDeptId);
    await addEmployeeJobHistory(profileEmpId, {
      effectiveDate: jobDraft.effectiveDate,
      action: jobDraft.action.trim(),
      deptId: dept?.id ?? null,
      deptName: dept?.name ?? null,
      grade: jobDraft.grade.trim() || null,
      title: jobDraft.title.trim() || null,
    });
    setJobDraft({ effectiveDate: "", action: "資料調整", deptId: "", grade: "", title: "" });
    setShowJobForm(false);
    await loadProfile(profileEmpId);
  }

  async function copyText(text: string, what = "連結") {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`已複製${what}`);
    } catch {
      setError(`無法自動複製，請手動選取${what}`);
    }
  }

  async function copyEmail(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.show("已複製 Email", "success");
    } catch {
      toast.show("無法自動複製，請手動選取 Email", "error");
    }
  }

  /** 批次建立帳號的結果表（顯示在匯入面板內）：行／姓名／Email／結果／連結＋複製。 */
  function renderBulkInviteResult(bulkResult: BulkInviteResult) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-700">
          新建 <span className="font-medium">{bulkResult.created}</span>、綁定既有員工 <span className="font-medium">{bulkResult.bound}</span>、
          寄出 <span className="font-medium">{bulkResult.sent}</span>、略過 <span className="font-medium">{bulkResult.skipped}</span>
          {bulkResult.dryRun && <span className="ml-2 text-amber-700">（未寄信：請逐列複製連結轉交）</span>}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500">
                <th className="py-2 pr-4">行</th>
                <th className="py-2 pr-4">姓名</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">結果</th>
                <th className="py-2">連結 / 訊息</th>
              </tr>
            </thead>
            <tbody>
              {bulkResult.rows.map((row) => (
                <tr key={row.line} className="border-b border-gray-50 align-top">
                  <td className="py-2 pr-4 text-gray-500">{row.line}</td>
                  <td className="py-2 pr-4">{row.name ?? "—"}</td>
                  <td className="py-2 pr-4 text-gray-600">{row.email ?? "—"}</td>
                  <td className="py-2 pr-4">
                    {row.action === "skipped" ? (
                      <span className="rounded-full bg-red-100 px-2 py-1 text-xs text-red-600">略過</span>
                    ) : (
                      <span className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-700">
                        {row.action === "created" ? "新建" : "綁定"}{row.sent ? "・已寄信" : row.link ? "・待轉交" : ""}
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    {row.error && <p className="text-xs text-red-600">{row.error}</p>}
                    {row.warning && <p className="text-xs text-amber-700">{row.warning}</p>}
                    {row.link && (
                      <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
                        <input readOnly className="w-full min-w-64 rounded-md border border-gray-200 px-2 py-1 font-mono text-xs" value={row.link} onFocus={(event) => event.currentTarget.select()} />
                        <button type="button" onClick={() => void copyText(row.link ?? "")} className="shrink-0 text-xs text-gray-600 hover:underline">複製</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const profileFields = PROFILE_FIELDS.filter((field) => field.group === profileTab);

  return (
    <>
      {message && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">{message}</p>}

      {/* 資料異動待審是 HR 的核准佇列（核准／退回只有 HR 能打）；會計只會看到自己的待審單，按了必 403，所以不顯示。 */}
      {canManage && <ProfileChangeQueue onApplied={() => void load()} />}

      {/* 帳號動作的結果卡（邀請信／重設密碼信連結、暫時密碼）與設定密碼面板、異動紀錄抽屜：與員工內頁共用。 */}
      {actions.panels}

      {canManage && (
        <CollapsibleCard
          title="新增員工帳號"
          hint="填姓名＋Email 即可：初始密碼留空會寄邀請信讓同仁自設密碼；填了則直接配發（同仁首次登入須改密碼）。"
        >
          <form onSubmit={onInvite} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <label className={labelCls}>Email</label>
                <input type="email" className={inputCls} value={email} onChange={(event) => setEmail(event.target.value)} />
              </div>
              <div>
                <label className={labelCls}>姓名</label>
                <input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div>
                <label className={labelCls}>工號</label>
                <input className={inputCls} value={empNo} onChange={(event) => setEmpNo(event.target.value)} />
              </div>
              <div>
                <label className={labelCls}>到職日</label>
                <input type="date" className={inputCls} value={hireDate} onChange={(event) => setHireDate(event.target.value)} />
              </div>
              <div>
                <label className={labelCls}>初始密碼（選填）</label>
                <input type="text" className={inputCls} placeholder="留空＝寄邀請信" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
              <div>
                <label className={labelCls}>角色</label>
                <select className={inputCls} value={role} onChange={(event) => setRole(event.target.value)}>
                  {createRoleOptions.map((item) => <option key={item.value} value={item.value} disabled={item.disabled}>{item.label}</option>)}
                </select>
                {!canAssignPlatform && <p className="mt-1 text-xs text-gray-400" data-testid="platform-admin-note">{PLATFORM_ADMIN_ASSIGN_NOTE}</p>}
              </div>
              <div>
                <label className={labelCls}>單位</label>
                <select className={inputCls} value={deptId} onChange={(event) => setDeptId(event.target.value)}>
                  <option value="">不指定</option>
                  {depts.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>身分類別</label>
                <select className={inputCls} value={employmentType} onChange={(event) => setEmploymentType(event.target.value)}>
                  {EMPLOYMENT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
            </div>
            {formError && <ErrorText>{formError}</ErrorText>}
            <PrimaryButton type="submit" disabled={submitting}>{submitting ? "處理中…" : password ? "建立帳號（配發密碼）" : "建立帳號並寄邀請信"}</PrimaryButton>
          </form>
        </CollapsibleCard>
      )}

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-gray-500">員工列表</h2>
          {/* 批次建立帳號改成「下載 Excel 範本 → 填完上傳」的面板（原本是一張貼 CSV 的卡片）；
              「只建帳號、不寄信」放在面板的確認步驟，對應 API 的 options.dryRunInvite。 */}
          {canManage && (
            <BatchImportButton
              kind="employees"
              label="批次建立帳號"
              description="只有姓名與 Email 必填。工號或姓名對得上「尚未開通帳號」的既有員工會直接綁定，否則新建；同名多人請補工號。"
              options={{ dryRunInvite: bulkNoEmail || undefined }}
              onDone={load}
              extra={
                <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={bulkNoEmail}
                    onChange={(event) => setBulkNoEmail(event.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 accent-[var(--brand)]"
                  />
                  只建帳號、不寄信（取得連結手動轉交）
                </label>
              }
              renderResult={(res) => (isBulkInviteResult(res.result) ? renderBulkInviteResult(res.result) : null)}
            />
          )}
        </div>
        {/* 所屬公司：篩選＋多選批次指派（2026-10-25）。集團總覽依它把在職人數、人事成本歸到公司；未指派不分攤。 */}
        {rows.length > 0 && (
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div>
              <label className={labelCls} htmlFor="emp-company-filter">所屬公司</label>
              <select
                id="emp-company-filter"
                className={inputCls}
                value={companyFilter}
                onChange={(event) => setCompanyFilter(event.target.value)}
              >
                <option value="">全部公司</option>
                <option value={UNASSIGNED_FILTER}>未指派</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                    {company.isActive === false ? "（已停用）" : ""}
                  </option>
                ))}
              </select>
            </div>
            {canManage && selectedIds.size > 0 && (
              <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 px-3 py-2" data-testid="batch-company-bar">
                <span className="self-center text-sm text-gray-700">已選 {selectedIds.size} 人，指派到</span>
                <select
                  aria-label="批次指派的公司"
                  className={inputCls}
                  value={batchCompanyId}
                  onChange={(event) => setBatchCompanyId(event.target.value)}
                >
                  <option value="">未指派</option>
                  {companyOptions(companies).map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <Button onClick={() => void applyBatchCompany()} disabled={batchBusy}>
                  {batchBusy ? "指派中…" : "套用"}
                </Button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  disabled={batchBusy}
                  className="self-center text-xs text-gray-500 underline hover:text-gray-800 disabled:opacity-50"
                >
                  取消勾選
                </button>
              </div>
            )}
          </div>
        )}
        {batchError && <div className="mb-3"><ErrorText>{batchError}</ErrorText></div>}
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>尚無員工</Empty>
        ) : visibleRows.length === 0 ? (
          <Empty>這家公司目前沒有員工</Empty>
        ) : (
          // 外框：直向超過視窗高度、橫向超過寬度都在框內捲（表頭釘上方、操作欄釘右側）。
          <div className="max-h-[calc(100dvh-12rem)] overflow-auto">
            <table className="w-full min-w-[92rem] text-left text-sm">
              <thead>
                <tr className="text-xs text-gray-500">
                  {canManage && (
                    <th className={`${STICKY_TH} w-8 py-2 pr-2`}>
                      <input
                        type="checkbox"
                        aria-label="全選畫面上的員工"
                        checked={allVisibleSelected}
                        onChange={() => setSelectedIds((cur) => toggleAllVisible(cur, visibleIds))}
                        className="h-4 w-4 rounded border-gray-300 accent-[var(--brand)]"
                      />
                    </th>
                  )}
                  <th className={`${STICKY_TH} min-w-[7rem] py-2 pr-4`}>員工</th>
                  <th className={`${STICKY_TH} hidden min-w-[12rem] py-2 pr-4 sm:table-cell`}>Email</th>
                  <th className={`${STICKY_TH} min-w-[8rem] py-2 pr-4`}>單位/身分</th>
                  <th className={`${STICKY_TH} min-w-[7rem] py-2 pr-4`}>所屬公司</th>
                  <th className={`${STICKY_TH} whitespace-nowrap py-2 pr-4`}>到離職</th>
                  <th className={`${STICKY_TH} whitespace-nowrap py-2 pr-4`}>生日</th>
                  <th className={`${STICKY_TH} whitespace-nowrap py-2 pr-4`}>身分證</th>
                  <th className={`${STICKY_TH} min-w-[13rem] py-2 pr-4`}>戶籍地</th>
                  <th className={`${STICKY_TH} whitespace-nowrap py-2 pr-4`}>匯款帳號</th>
                  <th className={`${STICKY_TH} min-w-[8rem] py-2 pr-4`}>角色/狀態</th>
                  {canManage && <th className={`${PIN_RIGHT_TH} py-2 pl-3 text-right`}>操作</th>}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((employee) => (
                  <tr key={employee.id} className="border-b border-gray-50 align-top">
                      <>
                        {canManage && (
                          <td className="py-3 pr-2">
                            <input
                              type="checkbox"
                              aria-label={`勾選 ${employee.name}`}
                              checked={selectedIds.has(employee.id)}
                              onChange={() => setSelectedIds((cur) => toggleSelected(cur, employee.id))}
                              className="h-4 w-4 rounded border-gray-300 accent-[var(--brand)]"
                            />
                          </td>
                        )}
                        <td className="py-3 pr-4">
                          <p className="font-medium text-gray-800">{employee.name}</p>
                          <p className="text-xs text-gray-500">工號 {employee.emp_no ?? "—"}</p>
                          {(employee.default_shift_id || employee.features?.wfhPunch || employee.features?.noNightPremium) && (
                            <p className="text-xs text-gray-500">
                              {employee.default_shift_id
                                ? `班別 ${shiftNameMap.get(employee.default_shift_id)?.name ?? "（已刪除）"}`
                                : ""}
                              {employee.default_shift_id && employee.features?.wfhPunch ? "・" : ""}
                              {employee.features?.wfhPunch ? "可在家打卡" : ""}
                              {(employee.default_shift_id || employee.features?.wfhPunch) && employee.features?.noNightPremium ? "・" : ""}
                              {employee.features?.noNightPremium ? "不計夜間加給" : ""}
                            </p>
                          )}
                          {credentialsLockedOf(employee) && (
                            <p className="text-xs text-amber-700" title={CREDENTIALS_LOCKED_NOTE} data-testid="credentials-locked-hint">
                              密碼僅老闆／平台管理員可重設
                            </p>
                          )}
                          {/* 窄螢幕沒有 Email 欄，補在名字下方 */}
                          <p className="text-xs text-gray-500 break-all sm:hidden">{employee.email ?? "—"}</p>
                        </td>
                        <td className="hidden py-3 pr-4 sm:table-cell">
                          <div className="flex items-start gap-1.5">
                            <span className="text-sm text-gray-600 break-all">{employee.email ?? "—"}</span>
                            {employee.email && (
                              <button
                                type="button"
                                onClick={() => void copyEmail(employee.email ?? "")}
                                className="shrink-0 text-xs text-gray-400 hover:text-gray-700 hover:underline"
                                aria-label={`複製 ${employee.name} 的 Email`}
                              >
                                複製
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-gray-600">{deptNameMap.get(employee.dept_id ?? "") ?? "—"} / {employmentTypeLabel(employee.employment_type)}</td>
                        <td className={`py-3 pr-4 ${employee.company_id ? "text-gray-600" : "text-amber-700"}`}>{companyLabel(employee, companies)}</td>
                        <td className="whitespace-nowrap py-3 pr-4 text-gray-600">{employee.hire_date ?? "—"} → {employee.terminated_at ?? "在職"}</td>
                        <td className="whitespace-nowrap py-3 pr-4 text-gray-600">{employee.birthday || "—"}</td>
                        <td className="whitespace-nowrap py-3 pr-4 text-gray-600">{employee.idNumber || "—"}</td>
                        <td className="py-3 pr-4 text-gray-600">
                          <div className="min-w-[13rem] max-w-[20rem] whitespace-normal break-words">{employee.registeredAddress || "—"}</div>
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4 text-gray-600">
                          <BankCell employee={employee} />
                        </td>
                        <td className="py-3 pr-4">
                          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">{roleLabel(employee.role)}</span>
                          {employee.status !== "active" && <span className="ml-2 rounded-full bg-red-100 px-2 py-1 text-xs text-red-600">{employee.status}</span>}
                          {!employee.user_id && <span className="ml-2 rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-700">未開通帳號</span>}
                        </td>
                        {canManage && (
                          <td className={`${PIN_RIGHT_TD} whitespace-nowrap py-2 pl-3 text-right`}>
                            {/* 只留「編輯」＋「⋯」；其餘動作收進選單，顯示／disabled 規則在 lib/employee-actions.ts */}
                            <div className="flex items-center justify-end gap-1">
                              {/* 2026-10-26：編輯改到員工內頁（原本是列下方展開的行內表單）。 */}
                              <Link
                                href={employeeDetailHref(employee.id)}
                                className="rounded-md px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-800"
                              >
                                編輯
                              </Link>
                              <ActionMenu
                                label={`${employee.name} 的更多操作`}
                                items={employeeActionsFor(employee, {
                                  isSelf: selfUserId !== null && employee.user_id === selfUserId,
                                  busy: actions.busyId === employee.id,
                                  credentialsLocked: credentialsLockedOf(employee),
                                }).map((spec) => ({
                                  key: spec.key,
                                  label: spec.label,
                                  tone: spec.tone,
                                  disabled: spec.disabled,
                                  title: spec.title,
                                  onSelect: () => actions.run(spec.key, { id: employee.id, name: employee.name }),
                                }))}
                              />
                            </div>
                          </td>
                        )}
                      </>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {profileEmpId && (
        <div id="employee-profile-panel" className="scroll-mt-4">
        <Card>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium text-gray-500">My Data 維護</h2>
              <p className="mt-1 font-semibold text-gray-900">{selectedEmployee?.name ?? profileEmpId}</p>
            </div>
            <button onClick={() => setProfileEmpId(null)} className="text-sm text-gray-500 hover:underline">關閉</button>
          </div>
          {!profile ? (
            <Empty>載入 My Data…</Empty>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="text-xs text-slate-500">內部年資</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-900">{profile.seniority.internalYears ?? "—"}</p>
                </div>
                <div className="rounded-xl bg-blue-50 p-4">
                  <p className="text-xs text-blue-600">職等年資</p>
                  <p className="mt-1 text-2xl font-semibold text-blue-700">{profile.seniority.gradeYears ?? "—"}</p>
                </div>
                <div className="rounded-xl bg-green-50 p-4">
                  <p className="text-xs text-green-600">單位年資</p>
                  <p className="mt-1 text-2xl font-semibold text-green-700">{profile.seniority.unitYears ?? "—"}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 rounded-xl bg-slate-50 p-4">
                <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl bg-white text-lg font-semibold text-slate-500 ring-1 ring-slate-200">
                  {profile.profile?.photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={profile.profile.photo_url} alt="員工照片" className="h-full w-full object-cover" />
                  ) : (
                    (selectedEmployee?.name ?? profile.basic.name).slice(0, 1)
                  )}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-700">員工照片</p>
                  <p className="mt-1 text-xs text-slate-500">{profile.profile?.photo_file_name ?? "尚未上傳"}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700">
                    上傳照片
                    <input type="file" accept="image/*" className="hidden" onChange={(event) => void onProfilePhotoFile(event.target.files?.[0] ?? null)} />
                  </label>
                  {profile.profile?.photo_url && (
                    <button type="button" onClick={() => void removeProfilePhoto()} className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600">
                      刪除照片
                    </button>
                  )}
                </div>
              </div>

              <form onSubmit={saveProfileFields} className="space-y-4">
                <Segmented
                  size="sm"
                  options={[
                    { value: "basic", label: "基本資料" },
                    { value: "contact", label: "通訊資料" },
                  ]}
                  value={profileTab}
                  onChange={setProfileTab}
                  className="w-full md:w-auto"
                  aria-label="My Data 分頁"
                />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {profileFields.map((field) => (
                    <div key={field.key}>
                      <label className={labelCls}>{field.label}</label>
                      <input
                        type={field.type ?? "text"}
                        className={inputCls}
                        value={profileValues[field.key] ?? ""}
                        onChange={(event) => setProfileValues((values) => ({ ...values, [field.key]: event.target.value }))}
                      />
                    </div>
                  ))}
                </div>
                <PrimaryButton type="submit">儲存 My Data</PrimaryButton>
              </form>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700">學歷</h3>
                    <button type="button" onClick={() => setShowEduForm((open) => !open)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                      {showEduForm ? "收合" : "＋ 新增"}
                    </button>
                  </div>
                  {showEduForm && (
                    <form onSubmit={submitEducation} className="mb-3 space-y-3 rounded-xl bg-slate-50 p-3">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <input className={inputCls} value={eduDraft.school} onChange={(event) => setEduDraft((draft) => ({ ...draft, school: event.target.value }))} placeholder="學校" />
                        <input className={inputCls} value={eduDraft.degree} onChange={(event) => setEduDraft((draft) => ({ ...draft, degree: event.target.value }))} placeholder="學歷類別" />
                        <input className={inputCls} value={eduDraft.majorCategory} onChange={(event) => setEduDraft((draft) => ({ ...draft, majorCategory: event.target.value }))} placeholder="科系類別" />
                        <input className={inputCls} value={eduDraft.major} onChange={(event) => setEduDraft((draft) => ({ ...draft, major: event.target.value }))} placeholder="科系名稱" />
                        <select className={inputCls} value={eduDraft.studyType} onChange={(event) => setEduDraft((draft) => ({ ...draft, studyType: event.target.value }))}>
                          <option>日間部</option>
                          <option>夜間部</option>
                          <option>其他(進修部或在職專班)</option>
                        </select>
                        <select className={inputCls} value={eduDraft.studyStatus} onChange={(event) => setEduDraft((draft) => ({ ...draft, studyStatus: event.target.value }))}>
                          <option>畢業</option>
                          <option>就學中</option>
                          <option>肄業</option>
                        </select>
                        <input type="date" className={inputCls} value={eduDraft.startDate} onChange={(event) => setEduDraft((draft) => ({ ...draft, startDate: event.target.value }))} />
                        <input type="date" className={inputCls} value={eduDraft.endDate} onChange={(event) => setEduDraft((draft) => ({ ...draft, endDate: event.target.value }))} />
                        <input className={inputCls} value={eduDraft.region} onChange={(event) => setEduDraft((draft) => ({ ...draft, region: event.target.value }))} placeholder="學校所在地區" />
                        <input type="file" className={inputCls} onChange={(event) => setEduProofFile(event.target.files?.[0] ?? null)} />
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          <input type="checkbox" checked={eduDraft.isHighest} onChange={(event) => setEduDraft((draft) => ({ ...draft, isHighest: event.target.checked }))} />
                          最高學歷
                        </label>
                      </div>
                      <button type="submit" className="rounded-md border px-3 py-2 text-sm font-medium" style={{ color: "var(--brand)" }}>新增學歷</button>
                    </form>
                  )}
                  <ul className="divide-y divide-gray-100 text-sm">
                    {profile.educations.map((item) => (
                      <li key={item.id} className="flex justify-between gap-3 py-2">
                        <span>
                          {item.school}｜{item.degree ?? "—"}｜{item.major_category ?? "—"}｜{item.major ?? "—"}｜{item.study_type ?? "—"}｜{item.study_status ?? "—"}｜{item.start_date ?? "—"} → {item.end_date ?? "—"}｜{item.region ?? "—"}{item.is_highest ? "｜最高學歷" : ""}
                          {item.proof_url && <a href={item.proof_url} target="_blank" rel="noreferrer" className="ml-2 font-medium" style={{ color: "var(--brand)" }}>證明文件</a>}
                        </span>
                        <span className="flex gap-2">
                          {item.proof_url && <button onClick={() => deleteEmployeeEducationAttachment(item.id).then(() => loadProfile(profileEmpId))} className="text-gray-500">刪附件</button>}
                          <button onClick={() => deleteEmployeeEducation(item.id).then(() => loadProfile(profileEmpId))} className="text-red-600">刪除</button>
                        </span>
                      </li>
                    ))}
                    {profile.educations.length === 0 && <li className="py-2 text-gray-400">無</li>}
                  </ul>
                </section>
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700">證照</h3>
                    <button type="button" onClick={() => setShowCertForm((open) => !open)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                      {showCertForm ? "收合" : "＋ 新增"}
                    </button>
                  </div>
                  {showCertForm && (
                    <form onSubmit={submitCertification} className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
                      <input className={inputCls} value={certDraft.name} onChange={(event) => setCertDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="證照名稱" />
                      <input className={inputCls} value={certDraft.issuer} onChange={(event) => setCertDraft((draft) => ({ ...draft, issuer: event.target.value }))} placeholder="發證單位" />
                      <input type="date" className={inputCls} value={certDraft.issuedDate} onChange={(event) => setCertDraft((draft) => ({ ...draft, issuedDate: event.target.value }))} />
                      <input type="date" className={inputCls} value={certDraft.expiryDate} onChange={(event) => setCertDraft((draft) => ({ ...draft, expiryDate: event.target.value }))} />
                      <input type="file" className={inputCls} onChange={(event) => setCertAttachmentFile(event.target.files?.[0] ?? null)} />
                      <button type="submit" className="rounded-md border px-3 py-2 text-sm font-medium" style={{ color: "var(--brand)" }}>新增證照</button>
                    </form>
                  )}
                  <ul className="divide-y divide-gray-100 text-sm">
                    {profile.certifications.map((item) => (
                      <li key={item.id} className="flex justify-between gap-3 py-2">
                        <span>
                          {item.name}｜{item.issuer ?? "—"}｜{item.issued_date ?? "—"} → {item.expiry_date ?? "—"}
                          {item.attachment_url && <a href={item.attachment_url} target="_blank" rel="noreferrer" className="ml-2 font-medium" style={{ color: "var(--brand)" }}>附件</a>}
                        </span>
                        <span className="flex gap-2">
                          {item.attachment_url && <button onClick={() => deleteEmployeeCertificationAttachment(item.id).then(() => loadProfile(profileEmpId))} className="text-gray-500">刪附件</button>}
                          <button onClick={() => deleteEmployeeCertification(item.id).then(() => loadProfile(profileEmpId))} className="text-red-600">刪除</button>
                        </span>
                      </li>
                    ))}
                    {profile.certifications.length === 0 && <li className="py-2 text-gray-400">無</li>}
                  </ul>
                </section>
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700">工作經歷</h3>
                    <button type="button" onClick={() => setShowWorkForm((open) => !open)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                      {showWorkForm ? "收合" : "＋ 新增"}
                    </button>
                  </div>
                  {showWorkForm && (
                    <form onSubmit={submitWorkHistory} className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
                      <input className={inputCls} value={workDraft.company} onChange={(event) => setWorkDraft((draft) => ({ ...draft, company: event.target.value }))} placeholder="公司" />
                      <input className={inputCls} value={workDraft.title} onChange={(event) => setWorkDraft((draft) => ({ ...draft, title: event.target.value }))} placeholder="職稱" />
                      <input type="date" className={inputCls} value={workDraft.startDate} onChange={(event) => setWorkDraft((draft) => ({ ...draft, startDate: event.target.value }))} />
                      <input type="date" className={inputCls} value={workDraft.endDate} onChange={(event) => setWorkDraft((draft) => ({ ...draft, endDate: event.target.value }))} />
                      <textarea className={`${inputCls} sm:col-span-2`} rows={2} value={workDraft.description} onChange={(event) => setWorkDraft((draft) => ({ ...draft, description: event.target.value }))} placeholder="說明" />
                      <button type="submit" className="rounded-md border px-3 py-2 text-sm font-medium" style={{ color: "var(--brand)" }}>新增經歷</button>
                    </form>
                  )}
                  <ul className="divide-y divide-gray-100 text-sm">
                    {profile.workHistory.map((item) => (
                      <li key={item.id} className="flex justify-between gap-3 py-2">
                        <span>{item.company}｜{item.title ?? "—"}｜{item.start_date ?? "—"} → {item.end_date ?? "—"}</span>
                        <button onClick={() => deleteEmployeeWorkHistory(item.id).then(() => loadProfile(profileEmpId))} className="text-red-600">刪除</button>
                      </li>
                    ))}
                    {profile.workHistory.length === 0 && <li className="py-2 text-gray-400">無</li>}
                  </ul>
                </section>
                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-700">職務經歷</h3>
                    <button type="button" onClick={() => setShowJobForm((open) => !open)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                      {showJobForm ? "收合" : "＋ 新增"}
                    </button>
                  </div>
                  {showJobForm && (
                    <form onSubmit={submitJobHistory} className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
                      <input type="date" className={inputCls} value={jobDraft.effectiveDate} onChange={(event) => setJobDraft((draft) => ({ ...draft, effectiveDate: event.target.value }))} />
                      <select className={inputCls} value={jobDraft.action} onChange={(event) => setJobDraft((draft) => ({ ...draft, action: event.target.value }))}>
                        <option>新進</option>
                        <option>晉升</option>
                        <option>調部門</option>
                        <option>資料調整</option>
                      </select>
                      <select className={inputCls} value={jobDraft.deptId} onChange={(event) => setJobDraft((draft) => ({ ...draft, deptId: event.target.value }))}>
                        <option value="">沿用目前直屬單位</option>
                        {depts.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
                      </select>
                      <input className={inputCls} value={jobDraft.grade} onChange={(event) => setJobDraft((draft) => ({ ...draft, grade: event.target.value }))} placeholder="職等" />
                      <input className={inputCls} value={jobDraft.title} onChange={(event) => setJobDraft((draft) => ({ ...draft, title: event.target.value }))} placeholder="職稱" />
                      <button type="submit" className="rounded-md border px-3 py-2 text-sm font-medium" style={{ color: "var(--brand)" }}>新增職務經歷</button>
                    </form>
                  )}
                  <ul className="divide-y divide-gray-100 text-sm">
                    {profile.jobHistory.map((item) => (
                      <li key={item.id} className="py-2">
                        {item.effective_date}｜{item.action}｜{item.dept_name ?? (item.dept_id ? deptNameMap.get(item.dept_id) : "—")}｜{item.grade ?? "—"}｜{item.title ?? "—"}
                      </li>
                    ))}
                    {profile.jobHistory.length === 0 && <li className="py-2 text-gray-400">無</li>}
                  </ul>
                </section>
              </div>
            </div>
          )}
        </Card>
        </div>
      )}
    </>
  );
}
