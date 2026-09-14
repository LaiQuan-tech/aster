"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  addEmployeeCertification,
  addEmployeeEducation,
  addEmployeeJobHistory,
  addEmployeeWorkHistory,
  deactivateEmployee,
  deleteEmployeeCertification,
  deleteEmployeeCertificationAttachment,
  deleteEmployeeEducation,
  deleteEmployeeEducationAttachment,
  deleteEmployeeProfilePhoto,
  deleteEmployeeWorkHistory,
  getDepartments,
  getEmployeeProfile,
  getEmployees,
  inviteEmployee,
  resetEmployeePassword,
  saveEmployeeProfile,
  uploadEmployeeCertificationAttachment,
  uploadEmployeeEducationAttachment,
  uploadEmployeeProfilePhoto,
  updateEmployee,
  type Department,
  type Employee,
  type ProfileAggregate,
  type SaveProfileBody,
} from "@/lib/admin-api";
import {
  accountErrorMessage,
  bulkInviteEmployees,
  sendEmployeeInvite,
  sendEmployeeReset,
  toInviteCsv,
  type AccountLinkResult,
  type BulkInviteResult,
} from "@/lib/auth-api";

const CSV_EXAMPLE = `name,email,empNo,deptName,employmentType,hireDate,role
王小明,ming@example.com,A001,設計部,regular,2026-09-15,employee
"陳, 美玲",mei@example.com,,,intern,,`;

const ROLES: { value: string; label: string }[] = [
  { value: "employee", label: "一般員工" },
  { value: "manager", label: "主管" },
  { value: "hr_admin", label: "HR 管理員" },
];

const EMPLOYMENT_TYPES = [
  { value: "regular", label: "正職" },
  { value: "parttime", label: "兼職" },
  { value: "contract", label: "約聘" },
  { value: "intern", label: "實習" },
];

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
};

function roleLabel(role: string): string {
  return ROLES.find((item) => item.value === role)?.label ?? role;
}

function employmentTypeLabel(value: string | null) {
  return EMPLOYMENT_TYPES.find((item) => item.value === value)?.label ?? value ?? "—";
}

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

export default function EmployeesPage() {
  const [rows, setRows] = useState<Employee[]>([]);
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

  // 帳號信件結果（單筆）：寄出／dryRun 連結／備援暫時密碼，取代原本的 window.alert 明碼。
  const [linkResult, setLinkResult] = useState<{ empName: string; result: AccountLinkResult } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ empName: string; password: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 批次邀請（CSV）。
  const [csvText, setCsvText] = useState("");
  const [csvDryRun, setCsvDryRun] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkInviteResult | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("employee");
  const [editDeptId, setEditDeptId] = useState("");
  const [editEmpNo, setEditEmpNo] = useState("");
  const [editEmploymentType, setEditEmploymentType] = useState("regular");
  const [editHireDate, setEditHireDate] = useState("");
  const [editTerminatedAt, setEditTerminatedAt] = useState("");
  const [editStatus, setEditStatus] = useState("active");

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [empRes, deptRes] = await Promise.all([getEmployees(), getDepartments()]);
      setRows(empRes.employees);
      setDepts(deptRes.departments);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProfile = useCallback(async (employeeId: string) => {
    const data = await getEmployeeProfile(employeeId);
    setProfile(data);
    setProfileValues(profileInitial(data));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
          setFormError(row?.error ?? "邀請失敗");
          return;
        }
        setLinkResult({
          empName: name.trim(),
          result: {
            sent: row.sent === true,
            dryRun: res.dryRun,
            type: row.type ?? "invite",
            email: row.email ?? email.trim(),
            action: row.action,
            link: row.link,
          },
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
      setFormError(err instanceof Error ? err.message : "邀請失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdit(id: string) {
    try {
      await updateEmployee(id, {
        name: editName.trim() || undefined,
        role: editRole,
        deptId: editDeptId || null,
        empNo: editEmpNo.trim() || null,
        employmentType: editEmploymentType,
        hireDate: editHireDate || null,
        terminatedAt: editTerminatedAt || null,
        status: editStatus,
      });
      setEditingId(null);
      await load();
      if (profileEmpId === id) await loadProfile(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
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

  async function onDeactivate(id: string) {
    if (!window.confirm("確定停用此員工？")) return;
    try {
      await deactivateEmployee(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "停用失敗");
    }
  }

  async function onSendInvite(id: string, empName: string) {
    setBusyId(id);
    setError(null);
    try {
      let res: AccountLinkResult;
      try {
        res = await sendEmployeeInvite(id);
      } catch (err) {
        // 員工沒 Email（My Data 未填）→ 讓 HR 直接輸入要寄的信箱再試一次。
        if (!(err instanceof Error && err.message.includes("no_email"))) throw err;
        const typed = window.prompt(`「${empName}」尚未有 Email，請輸入要寄送邀請信的信箱：`, "");
        if (!typed || !typed.trim()) return;
        res = await sendEmployeeInvite(id, { email: typed.trim() });
      }
      setTempPassword(null);
      setLinkResult({ empName, result: res });
      setMessage(
        res.dryRun
          ? `未寄信（API 尚未設定寄信金鑰），請複製下方連結轉交 ${empName}`
          : `已寄出${res.type === "recovery" ? "重設密碼信" : "邀請信"}給 ${empName}（${res.email}）`,
      );
      await load();
    } catch (err) {
      setError(accountErrorMessage(err, "寄送邀請信失敗"));
    } finally {
      setBusyId(null);
    }
  }

  async function onSendReset(id: string, empName: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await sendEmployeeReset(id);
      setTempPassword(null);
      setLinkResult({ empName, result: res });
      setMessage(
        res.dryRun
          ? `未寄信（API 尚未設定寄信金鑰），請複製下方連結轉交 ${empName}`
          : `已寄出重設密碼信給 ${empName}（${res.email}）`,
      );
    } catch (err) {
      setError(accountErrorMessage(err, "寄送重設密碼信失敗"));
    } finally {
      setBusyId(null);
    }
  }

  /** 備援：寄不了信時由系統產生暫時密碼（員工首次登入會被強制改密碼）。 */
  async function onTempPassword(id: string, empName: string) {
    if (!window.confirm(`為「${empName}」產生一組暫時密碼？\n（正常情況請用「寄重設密碼信」；此為寄不了信時的備援）`)) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await resetEmployeePassword(id);
      setLinkResult(null);
      if (res.password) {
        setTempPassword({ empName, password: res.password });
        setMessage(`已為 ${empName} 產生暫時密碼（只顯示這一次，請複製後轉交；員工首次登入會被要求改密碼）`);
      }
    } catch (err) {
      setError(accountErrorMessage(err, "產生暫時密碼失敗"));
    } finally {
      setBusyId(null);
    }
  }

  async function copyText(text: string, what = "連結") {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(`已複製${what}`);
    } catch {
      setError(`無法自動複製，請手動選取${what}`);
    }
  }

  async function onBulkInvite(event: FormEvent) {
    event.preventDefault();
    setBulkError(null);
    if (!csvText.trim()) {
      setBulkError("請先貼上 CSV 內容");
      return;
    }
    setBulkSubmitting(true);
    try {
      const res = await bulkInviteEmployees(csvText, csvDryRun || undefined);
      setBulkResult(res);
      await load();
    } catch (err) {
      setBulkError(accountErrorMessage(err, "批次邀請失敗"));
    } finally {
      setBulkSubmitting(false);
    }
  }

  const profileFields = PROFILE_FIELDS.filter((field) => field.group === profileTab);

  return (
    <>
      <PageHeader title="員工主檔" desc="帳號、組織、到離職、My Data、學歷證照、工作經歷與年資" />
      {message && <p className="rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">{message}</p>}

      {linkResult && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-gray-500">
                {linkResult.result.type === "recovery" ? "重設密碼信" : "邀請信"} — {linkResult.empName}（{linkResult.result.email}）
              </h2>
              {linkResult.result.dryRun && linkResult.result.link ? (
                <>
                  <p className="mt-1 text-sm text-amber-700">
                    API 尚未設定寄信金鑰（RESEND_API_KEY），信件沒有寄出。請複製下方連結用 LINE／口頭轉交給同仁，連結 24 小時內有效、只能用一次。
                  </p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input readOnly className={`${inputCls} font-mono text-xs`} value={linkResult.result.link} onFocus={(event) => event.currentTarget.select()} />
                    <button type="button" onClick={() => void copyText(linkResult.result.link ?? "")} className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">複製連結</button>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-sm text-gray-600">已寄出，請同仁收信後點連結設定密碼（連結 24 小時內有效）。</p>
              )}
            </div>
            <button type="button" onClick={() => setLinkResult(null)} className="text-sm text-gray-400 hover:underline">關閉</button>
          </div>
        </Card>
      )}

      {tempPassword && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium text-gray-500">暫時密碼 — {tempPassword.empName}</h2>
              <p className="mt-1 text-sm text-amber-700">只顯示這一次。請複製後轉交同仁；同仁首次登入會被要求改成自己的密碼。</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input readOnly className={`${inputCls} font-mono`} value={tempPassword.password} onFocus={(event) => event.currentTarget.select()} />
                <button type="button" onClick={() => void copyText(tempPassword.password, "密碼")} className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">複製密碼</button>
              </div>
            </div>
            <button type="button" onClick={() => setTempPassword(null)} className="text-sm text-gray-400 hover:underline">關閉</button>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">新增員工帳號</h2>
        <p className="mb-4 text-xs text-gray-400">填姓名＋Email 即可：初始密碼留空會寄邀請信讓同仁自設密碼；填了則直接配發（同仁首次登入須改密碼）。</p>
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
                {ROLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
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
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">批次邀請（CSV）</h2>
        <p className="mb-3 text-xs text-gray-400">
          從 Excel 複製貼上即可（第一列是表頭；只有 name、email 必填）。工號或姓名對得上「尚未開通帳號」的既有員工會直接綁定，否則新建；同名多人請補工號。
        </p>
        <form onSubmit={onBulkInvite} className="space-y-3">
          <textarea
            className={`${inputCls} min-h-40 font-mono text-xs`}
            placeholder={CSV_EXAMPLE}
            value={csvText}
            onChange={(event) => setCsvText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-4">
            <button type="button" onClick={() => setCsvText(CSV_EXAMPLE)} className="text-xs text-gray-500 hover:underline">帶入範例格式</button>
            <label className="flex items-center gap-2 text-sm text-gray-600 select-none cursor-pointer">
              <input type="checkbox" checked={csvDryRun} onChange={(event) => setCsvDryRun(event.target.checked)} className="h-4 w-4 rounded border-gray-300 accent-[var(--brand)]" />
              只建帳號、不寄信（取得連結手動轉交）
            </label>
          </div>
          {bulkError && <ErrorText>{bulkError}</ErrorText>}
          <PrimaryButton type="submit" disabled={bulkSubmitting}>{bulkSubmitting ? "處理中…" : "批次建立並寄邀請信"}</PrimaryButton>
        </form>
        {bulkResult && (
          <div className="mt-4 space-y-3">
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
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">員工列表</h2>
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>尚無員工</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">員工</th>
                  <th className="py-2 pr-4">單位/身分</th>
                  <th className="py-2 pr-4">到離職</th>
                  <th className="py-2 pr-4">角色/狀態</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((employee) => (
                  <tr key={employee.id} className="border-b border-gray-50 align-top">
                    {editingId === employee.id ? (
                      <td colSpan={5} className="py-3">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-8">
                          <input className={inputCls} value={editName} onChange={(event) => setEditName(event.target.value)} />
                          <input className={inputCls} value={editEmpNo} onChange={(event) => setEditEmpNo(event.target.value)} />
                          <select className={inputCls} value={editDeptId} onChange={(event) => setEditDeptId(event.target.value)}>
                            <option value="">不指定</option>
                            {depts.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
                          </select>
                          <select className={inputCls} value={editEmploymentType} onChange={(event) => setEditEmploymentType(event.target.value)}>
                            {EMPLOYMENT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                          <input type="date" className={inputCls} value={editHireDate} onChange={(event) => setEditHireDate(event.target.value)} />
                          <input type="date" className={inputCls} value={editTerminatedAt} onChange={(event) => setEditTerminatedAt(event.target.value)} />
                          <select className={inputCls} value={editRole} onChange={(event) => setEditRole(event.target.value)}>
                            {ROLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                          <select className={inputCls} value={editStatus} onChange={(event) => setEditStatus(event.target.value)}>
                            <option value="active">在職</option>
                            <option value="inactive">停用</option>
                          </select>
                        </div>
                        <div className="mt-3 flex gap-3">
                          <button onClick={() => void saveEdit(employee.id)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>儲存</button>
                          <button onClick={() => setEditingId(null)} className="text-sm text-gray-500 hover:underline">取消</button>
                        </div>
                      </td>
                    ) : (
                      <>
                        <td className="py-3 pr-4">
                          <p className="font-medium text-gray-800">{employee.name}</p>
                          <p className="text-xs text-gray-500">工號 {employee.emp_no ?? "—"}</p>
                        </td>
                        <td className="py-3 pr-4 text-gray-600">{deptNameMap.get(employee.dept_id ?? "") ?? "—"} / {employmentTypeLabel(employee.employment_type)}</td>
                        <td className="py-3 pr-4 text-gray-600">{employee.hire_date ?? "—"} → {employee.terminated_at ?? "在職"}</td>
                        <td className="py-3 pr-4">
                          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">{roleLabel(employee.role)}</span>
                          {employee.status !== "active" && <span className="ml-2 rounded-full bg-red-100 px-2 py-1 text-xs text-red-600">{employee.status}</span>}
                          {!employee.user_id && <span className="ml-2 rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-700">未開通帳號</span>}
                        </td>
                        <td className="py-3">
                          <div className="flex gap-3">
                            <button
                              onClick={() => {
                                setEditingId(employee.id);
                                setEditName(employee.name);
                                setEditRole(employee.role);
                                setEditDeptId(employee.dept_id ?? "");
                                setEditEmpNo(employee.emp_no ?? "");
                                setEditEmploymentType(employee.employment_type ?? "regular");
                                setEditHireDate(employee.hire_date ?? "");
                                setEditTerminatedAt(employee.terminated_at ?? "");
                                setEditStatus(employee.status);
                              }}
                              className="text-sm text-gray-600 hover:underline"
                            >
                              編輯
                            </button>
                            <button onClick={() => void openProfile(employee.id)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>My Data</button>
                            {employee.user_id ? (
                              <>
                                <button disabled={busyId === employee.id} onClick={() => void onSendReset(employee.id, employee.name)} className="text-sm text-gray-600 hover:underline disabled:opacity-50">寄重設密碼信</button>
                                <button disabled={busyId === employee.id} onClick={() => void onTempPassword(employee.id, employee.name)} className="text-sm text-gray-400 hover:underline disabled:opacity-50" title="寄不了信時的備援：產生暫時密碼">暫時密碼</button>
                              </>
                            ) : (
                              <button disabled={busyId === employee.id} onClick={() => void onSendInvite(employee.id, employee.name)} className="text-sm font-medium hover:underline disabled:opacity-50" style={{ color: "var(--brand)" }}>寄邀請信</button>
                            )}
                            {employee.status === "active" && <button onClick={() => void onDeactivate(employee.id)} className="text-sm text-red-600 hover:underline">停用</button>}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {profileEmpId && (
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
                <div className="flex gap-2">
                  <button type="button" onClick={() => setProfileTab("basic")} className={`rounded-full px-4 py-2 text-sm ${profileTab === "basic" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>基本資料</button>
                  <button type="button" onClick={() => setProfileTab("contact")} className={`rounded-full px-4 py-2 text-sm ${profileTab === "contact" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>通訊資料</button>
                </div>
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
      )}
    </>
  );
}
