"use client";

/**
 * 員工內頁 /admin/employees/[id]（2026-10-26 業主：列表按「編輯」改到員工內頁編輯）。
 *
 * 原本「編輯」是在列表那一列下方展開行內表單，十幾個欄位擠成好幾排，還容易誤以為在改上一列的人。
 * 這頁把同一組欄位分成有標題的區塊卡（桌機兩欄、手機一欄），儲存／取消固定在頁面底部。
 *
 * 資料與寫回沿用原行內表單，沒有新 API：
 *   - 讀：GET /employees?include=profile（列表同一支，取這位員工那一列；API 沒有單筆 GET）＋單位、班別、公司清單
 *   - 寫：員工欄位 PATCH /employees/:id、個資欄位 PUT /employees/:id/profile，都只送有變更的欄位
 *     （lib/employee-edit.ts employeePatch、lib/employee-personal.ts personalChanges）。兩個請求不是同一個交易：
 *     PATCH 成功、PUT 失敗時員工欄位已生效，重載後保留個資欄位的輸入並顯示錯誤，修正後再按儲存即可重送。
 * 權限：HR／平台管理員可編輯（PATCH／PUT 在 API 都是 requireHrAdmin）；會計看得到這頁但整頁唯讀、沒有儲存與帳號動作。
 * 「可看集團財務」只有老闆／平台管理員看得到、改得動（API 對其他人回 403 group_financials_grant_forbidden）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Button, Card, Empty, ErrorText, Pill, inputCls, useToast } from "@/components/admin-ui";
import {
  getDepartments,
  getEmployeesWithProfile,
  getShifts,
  saveEmployeeProfile,
  updateEmployee,
  type Department,
  type EmployeeWithProfile,
  type Shift,
} from "@/lib/admin-api";
import { companyOptions } from "@/lib/company-options";
import { employeeActionsFor } from "@/lib/employee-actions";
import {
  EMPLOYEE_ROLES,
  canGrantGroupFinancialsOf,
  employeeFormFrom,
  employeePatch,
  employeeRoleLabel,
  employeeStatusLabel,
  hasUnsavedChanges,
  validateEmployeeForm,
  type EditableEmployee,
  type EmployeeForm,
} from "@/lib/employee-edit";
import { describeEmployeeError } from "@/lib/employee-errors";
import { personalChanges, personalFormFrom, type PersonalForm, type PersonalKey } from "@/lib/employee-personal";
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS } from "@/lib/ess-tabs";
import { getBrandingCached, getMeCached, peekMeCached } from "@/lib/ess-state";
import {
  CREDENTIALS_LOCKED_NOTE,
  PLATFORM_ADMIN_ASSIGN_NOTE,
  ROLE_CHANGE_LOCKED_NOTE,
  canAssignPlatformAdmin,
  credentialsLockedFor,
  privilegePolicyOf,
  roleChangeLockedFor,
  roleOptionsFor,
  type PrivilegePolicy,
  type PrivilegeViewer,
} from "@/lib/privileged-accounts";
import { listCompanies, type Company } from "@/lib/projects-ext-api";
import { isHrRole } from "@/lib/roles";
import { useSession } from "@/lib/use-session";
import { useEmployeeAccountActions } from "../_components/useEmployeeAccountActions";
import { EmployeeStatementsPanel, type StatementTab } from "../_components/EmployeeStatementsPanel";

const UNSAVED_PROMPT = "這位員工的資料還沒儲存，確定要離開嗎？";

/** 內頁分頁（2026-10-27）：員工資料｜出勤統計表｜薪資明細表（薪資明細表只有 HR／平台管理員看得到）。 */
type DetailTab = "profile" | StatementTab;

function tabFromLocation(): DetailTab {
  if (typeof window === "undefined") return "profile";
  const t = new URLSearchParams(window.location.search).get("tab");
  return t === "attendance" || t === "payslip" ? t : "profile";
}

type DetailEmployee = EmployeeWithProfile & EditableEmployee;

/**
 * 區塊卡：標題＋說明＋內容（欄位兩欄格線）。disabled＝唯讀（會計）或儲存中，用 fieldset 一次停用整區的控制項；
 * `top` 放在 fieldset 外（例如 Email 的「複製」：唯讀時也要能按）。
 */
function Section({
  title,
  hint,
  disabled,
  top,
  children,
}: {
  title: string;
  hint?: string;
  disabled?: boolean;
  top?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      {top ? <div className="mt-4">{top}</div> : null}
      <fieldset disabled={disabled} className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        {children}
      </fieldset>
    </Card>
  );
}

/** 單一欄位：標籤＋控制項＋說明；wide＝佔滿整列。 */
function Row({
  label,
  htmlFor,
  hint,
  wide,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-gray-700">
        {label}
      </label>
      {children}
      {hint ? <div className="mt-1 text-xs text-gray-500">{hint}</div> : null}
    </div>
  );
}

/** 個人功能的勾選列（整行可點）。 */
function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 px-3 py-3 sm:col-span-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 accent-[var(--brand)]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-800">{label}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
    </label>
  );
}

export default function EmployeeDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
  const router = useRouter();
  const toast = useToast();
  const { session } = useSession();
  const selfUserId = session?.user.id ?? null;

  // 能不能編輯：HR／平台管理員（isHrRole）。會計可進來看（GET /employees 放行 requireFinance），但整頁唯讀。
  const [canManage, setCanManage] = useState(() => isHrRole(peekMeCached()?.role));
  const [viewer, setViewer] = useState<PrivilegeViewer | null>(() => {
    const cached = peekMeCached();
    return cached ? { id: cached.id, role: cached.role } : null;
  });
  // 「可看集團財務」開關：以 /me.canGrantGroupFinancials 為準（與 API 同一條規則）；舊 API 沒這欄位才在前端推。
  const [meCanGrant, setMeCanGrant] = useState<boolean | undefined>(() => peekMeCached()?.canGrantGroupFinancials);
  const [policy, setPolicy] = useState<PrivilegePolicy>({ bossEmpId: null, designated: [] });
  useEffect(() => {
    let active = true;
    getMeCached()
      .then((me) => {
        if (!active) return;
        setCanManage(isHrRole(me.role));
        setViewer({ id: me.id, role: me.role });
        setMeCanGrant(me.canGrantGroupFinancials);
      })
      .catch(() => {
        if (active) setCanManage(false);
      });
    getBrandingCached()
      .then((brand) => {
        if (active) setPolicy(privilegePolicyOf(brand.features));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const [tab, setTabState] = useState<DetailTab>("profile");
  // 看過的統計表分頁保持掛載（切回員工資料再切回來不重抓）。
  const [statementsOpened, setStatementsOpened] = useState(false);
  useEffect(() => {
    const initial = tabFromLocation();
    setTabState(initial);
    if (initial !== "profile") setStatementsOpened(true);
  }, []);
  const setTab = useCallback((next: DetailTab) => {
    setTabState(next);
    if (next !== "profile") setStatementsOpened(true);
    // 分頁寫進網址（重新整理、分享連結停在同一頁），不新增瀏覽紀錄。
    const url = new URL(window.location.href);
    if (next === "profile") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  const [employee, setEmployee] = useState<DetailEmployee | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [depts, setDepts] = useState<Department[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);

  const [form, setForm] = useState<EmployeeForm | null>(null);
  const [personal, setPersonal] = useState<PersonalForm>(() => personalFormFrom({}));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * 重抓這位員工；resetPersonal=false 時保留個資欄位的輸入（PUT 失敗後讓 HR 修正重送）。
   * API 目前沒有單筆 GET /employees/:id（只有 PATCH），所以沿用列表那支 GET /employees?include=profile 再挑出這一位：
   * 個資欄位（生日／身分證／戶籍地／匯款帳號）只有這支會帶，權限守門也同一套（requireFinance＋HR 才多欄位）。
   * 員工數百人內回應量可接受；之後若加了單筆端點，換掉這裡即可（回傳形狀相同）。
   */
  const fetchEmployee = useCallback(
    async (resetPersonal = true) => {
      const res = await getEmployeesWithProfile();
      const row = (res.employees.find((item) => item.id === id) ?? null) as DetailEmployee | null;
      setEmployee(row);
      setNotFound(row === null);
      if (row) {
        setForm(employeeFormFrom(row));
        if (resetPersonal) setPersonal(personalFormFrom(row));
      }
    },
    [id],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchEmployee()
      .then(() => {
        if (active) setLoadError(null);
      })
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : "載入失敗");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    getDepartments()
      .then((res) => active && setDepts(res.departments))
      .catch(() => undefined);
    // 預設班別下拉（抓不到就只剩「依公司規則」）、所屬公司下拉（抓不到就只剩「未指派」）。
    getShifts()
      .then((res) => active && setShifts(res.shifts))
      .catch(() => undefined);
    listCompanies()
      .then((res) => active && setCompanies(res.companies))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [fetchEmployee]);

  const dirty = useMemo(
    () => (employee && form ? hasUnsavedChanges(employee, form, personal) : false),
    [employee, form, personal],
  );

  // 未儲存就離開：關分頁／重新整理走 beforeunload；站內連結（側欄、返回鍵）在 capture 階段攔下來先問。
  useEffect(() => {
    if (!dirty || !canManage) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClickCapture = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm(UNSAVED_PROMPT)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty, canManage]);

  // 瀏覽器上一頁（popstate）：有未存修改時先問。做法是在歷史紀錄多推一筆同網址的「哨兵」，
  // 按上一頁會先退到哨兵下面那筆（仍是這頁），我們在 popstate 問：取消＝把哨兵推回去留在原地；確定＝再退一步真的離開。
  // 存檔後（dirty 變回 false）哨兵若還在，按上一頁時直接再退一步，不讓使用者多按一次。
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty && canManage;
  const guardPushedRef = useRef(false);
  useEffect(() => {
    if (!dirty || !canManage || guardPushedRef.current) return;
    window.history.pushState({ ...(window.history.state ?? {}), __employeeUnsavedGuard: true }, "", window.location.href);
    guardPushedRef.current = true;
  }, [dirty, canManage]);
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      if (!guardPushedRef.current) return;
      if ((event.state as { __employeeUnsavedGuard?: boolean } | null)?.__employeeUnsavedGuard) return;
      // 剛從哨兵退下來
      if (dirtyRef.current && !window.confirm(UNSAVED_PROMPT)) {
        window.history.pushState({ ...(window.history.state ?? {}), __employeeUnsavedGuard: true }, "", window.location.href);
        return;
      }
      guardPushedRef.current = false;
      dirtyRef.current = false;
      window.history.back();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const actions = useEmployeeAccountActions({
    onChanged: () => fetchEmployee(),
    // My Data（照片、學歷、證照、經歷）仍在列表頁維護：帶 ?profile= 回去會直接展開這位員工的 My Data。
    // 程式跳頁不經連結，click 攔截攔不到：有未存修改時這裡自己先問。
    onOpenProfile: (target) => {
      if (dirty && canManage && !window.confirm(UNSAVED_PROMPT)) return;
      router.push(`/admin/employees?profile=${encodeURIComponent(target.id)}`);
    },
  });

  const set = <K extends keyof EmployeeForm>(key: K, value: EmployeeForm[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));
  const setPersonalField = (key: PersonalKey, value: string) => setPersonal((current) => ({ ...current, [key]: value }));

  async function copyEmail(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.show("已複製 Email", "success");
    } catch {
      toast.show("無法自動複製，請手動選取 Email", "error");
    }
  }

  function cancel() {
    if (!employee || saving) return;
    if (dirty && !window.confirm("放棄這次的修改？")) return;
    setForm(employeeFormFrom(employee));
    setPersonal(personalFormFrom(employee));
    setSaveError(null);
  }

  async function save() {
    if (!employee || !form || saving || !canManage) return;
    const invalid = validateEmployeeForm(form);
    if (invalid) {
      setSaveError(invalid);
      return;
    }
    const patch = employeePatch(employee, form);
    const personalPatch = personalChanges(employee, personal);
    if (Object.keys(patch).length === 0 && Object.keys(personalPatch).length === 0) {
      toast.show("沒有需要儲存的變更", "info");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (Object.keys(patch).length > 0) await updateEmployee(employee.id, patch);
    } catch (err) {
      setSaveError(describeEmployeeError(err, "更新失敗"));
      setSaving(false);
      return;
    }
    let personalError: string | null = null;
    if (Object.keys(personalPatch).length > 0) {
      try {
        await saveEmployeeProfile(employee.id, personalPatch);
      } catch (err) {
        personalError = err instanceof Error ? err.message : "更新失敗";
      }
    }
    try {
      await fetchEmployee(personalError === null);
    } catch (err) {
      setSaveError(err instanceof Error ? `已儲存，但重新載入失敗：${err.message}` : "已儲存，但重新載入失敗");
    }
    if (personalError) {
      setSaveError(`員工資料已儲存，但生日／身分證／戶籍地／匯款帳號沒有存成：${personalError}`);
    } else {
      toast.show("已儲存", "success");
    }
    setSaving(false);
  }

  if (loading && !employee) return <Empty>載入中…</Empty>;
  if (loadError && !employee) {
    return (
      <Card>
        <ErrorText>{loadError}</ErrorText>
        <Link href="/admin/employees" className="mt-3 inline-block text-sm text-gray-600 hover:underline">
          ← 返回員工列表
        </Link>
      </Card>
    );
  }
  if (notFound || !employee || !form) {
    return (
      <Card>
        <Empty>找不到這位員工（可能已被刪除，或不在這個公司）。</Empty>
        <Link href="/admin/employees" className="mt-3 inline-block text-sm text-gray-600 hover:underline">
          ← 返回員工列表
        </Link>
      </Card>
    );
  }

  const readOnly = !canManage;
  const locked = readOnly || saving;
  const target = { id: employee.id, role: employee.role };
  const roleLocked = roleChangeLockedFor(viewer, target, policy);
  const credentialsLocked = credentialsLockedFor(viewer, target, policy);
  const canAssignPlatform = canAssignPlatformAdmin(viewer);
  const canGrantFinancials = canGrantGroupFinancialsOf(meCanGrant, viewer, policy);
  const deptName = depts.find((dept) => dept.id === employee.dept_id)?.name ?? null;
  const accountActions = employeeActionsFor(employee, {
    isSelf: selfUserId !== null && employee.user_id === selfUserId,
    busy: actions.busyId === employee.id,
    credentialsLocked,
  });

  return (
    <>
      {/* 頂部：姓名、工號、部門、角色、狀態 */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Link href="/admin/employees" className="text-sm text-gray-500 hover:text-gray-800 hover:underline">
              ← 返回員工列表
            </Link>
            <h2 className="mt-1 text-xl font-bold text-gray-900">{employee.name}</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              工號 {employee.emp_no || "—"}・{deptName ?? "未指定單位"}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Pill tone="gray">{employeeRoleLabel(employee.role)}</Pill>
              <Pill tone={employee.status === "active" ? "green" : "red"}>{employeeStatusLabel(employee.status)}</Pill>
              {!employee.user_id && <Pill tone="amber">未開通帳號</Pill>}
              {readOnly && <Pill tone="blue">唯讀</Pill>}
            </div>
          </div>
        </div>
      </Card>

      {/* 分頁：員工資料｜出勤統計表｜薪資明細表（會計看不到薪資明細表） */}
      <div role="tablist" aria-label="員工內頁分頁" className="flex gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white p-1 print:hidden">
        {(
          [
            ["profile", "員工資料"],
            ["attendance", "出勤統計表"],
            ...(canManage ? ([["payslip", "薪資明細表"]] as const) : []),
          ] as ReadonlyArray<readonly [DetailTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium ${
              tab === key ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {statementsOpened && (
        <div hidden={tab === "profile"}>
          <EmployeeStatementsPanel employeeId={employee.id} kind={tab === "payslip" && canManage ? "payslip" : "attendance"} />
        </div>
      )}

      {tab === "profile" && (
      <>
      {actions.panels}

      <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
          <Section
            title="基本資料"
            disabled={locked}
            top={
              <Row label="Email" hint="登入帳號的信箱，這裡不能改。">
                <div className="flex items-center gap-2">
                  <input readOnly aria-label="Email" className={`${inputCls} bg-gray-50`} value={employee.email ?? "—"} />
                  {employee.email && (
                    <Button variant="secondary" className="shrink-0" onClick={() => void copyEmail(employee.email ?? "")}>
                      複製
                    </Button>
                  )}
                </div>
              </Row>
            }
          >
            <Row label="姓名" htmlFor="emp-name">
              <input id="emp-name" className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Row>
            <Row label="工號" htmlFor="emp-no">
              <input id="emp-no" className={inputCls} value={form.empNo} onChange={(e) => set("empNo", e.target.value)} />
            </Row>
            <Row label="單位" htmlFor="emp-dept">
              <select id="emp-dept" className={inputCls} value={form.deptId} onChange={(e) => set("deptId", e.target.value)}>
                <option value="">不指定</option>
                {depts.map((dept) => (
                  <option key={dept.id} value={dept.id}>
                    {dept.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="身分類別" htmlFor="emp-type">
              <select id="emp-type" className={inputCls} value={form.employmentType} onChange={(e) => set("employmentType", e.target.value)}>
                {EMPLOYMENT_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {EMPLOYMENT_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="所屬公司" htmlFor="emp-company" hint="集團總覽依它歸屬在職人數與人事成本；未指派不分攤。">
              <select id="emp-company" className={inputCls} value={form.companyId} onChange={(e) => set("companyId", e.target.value)}>
                <option value="">未指派</option>
                {companyOptions(companies, employee.company_id ?? "").map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              label="角色"
              htmlFor="emp-role"
              hint={
                roleLocked ? (
                  <span className="text-amber-700" data-testid="role-change-locked-note">
                    {ROLE_CHANGE_LOCKED_NOTE}
                  </span>
                ) : !canAssignPlatform ? (
                  PLATFORM_ADMIN_ASSIGN_NOTE
                ) : undefined
              }
            >
              <select
                id="emp-role"
                className={inputCls}
                value={form.role}
                onChange={(e) => set("role", e.target.value)}
                disabled={roleLocked}
              >
                {roleOptionsFor(EMPLOYEE_ROLES, viewer, employee.role).map((item) => (
                  <option key={item.value} value={item.value} disabled={item.disabled}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="狀態" htmlFor="emp-status">
              <select id="emp-status" className={inputCls} value={form.status} onChange={(e) => set("status", e.target.value)}>
                <option value="active">在職</option>
                <option value="inactive">停用</option>
              </select>
            </Row>
          </Section>

          <div className="space-y-4 md:space-y-6">
            <Section title="任職" disabled={locked}>
              <Row label="到職日" htmlFor="emp-hire">
                <input id="emp-hire" type="date" className={inputCls} value={form.hireDate} onChange={(e) => set("hireDate", e.target.value)} />
              </Row>
              <Row label="離職日" htmlFor="emp-term" hint="留空＝在職。">
                <input
                  id="emp-term"
                  type="date"
                  className={inputCls}
                  value={form.terminatedAt}
                  onChange={(e) => set("terminatedAt", e.target.value)}
                />
              </Row>
              <Row
                label="預設班別"
                htmlFor="emp-shift"
                wide
                hint="這位員工平日的上下班時間（遲到、應下班、缺卡都照它）；「依公司規則」＝照公司的彈性上班規則。"
              >
                <select id="emp-shift" className={inputCls} value={form.defaultShiftId} onChange={(e) => set("defaultShiftId", e.target.value)}>
                  <option value="">依公司規則</option>
                  {shifts.map((shift) => (
                    <option key={shift.id} value={shift.id}>
                      {shift.name}（{shift.start_time.slice(0, 5)}–{shift.end_time.slice(0, 5)}）
                    </option>
                  ))}
                  {form.defaultShiftId && !shifts.some((shift) => shift.id === form.defaultShiftId) && (
                    <option value={form.defaultShiftId}>（已刪除的班別）</option>
                  )}
                </select>
              </Row>
            </Section>

            <Section title="個人資料" disabled={locked}>
              <Row label="生日" htmlFor="emp-birthday">
                <input
                  id="emp-birthday"
                  type="date"
                  className={inputCls}
                  value={personal.birthday}
                  onChange={(e) => setPersonalField("birthday", e.target.value)}
                />
              </Row>
              <Row label="身分證字號" htmlFor="emp-idno" hint="自動轉大寫；不驗格式（外籍居留證格式不同）。">
                <input
                  id="emp-idno"
                  className={inputCls}
                  value={personal.idNumber}
                  onChange={(e) => setPersonalField("idNumber", e.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Row>
              <Row label="戶籍地址" htmlFor="emp-reg-addr" wide>
                <input
                  id="emp-reg-addr"
                  className={inputCls}
                  value={personal.registeredAddress}
                  onChange={(e) => setPersonalField("registeredAddress", e.target.value)}
                  autoComplete="off"
                />
              </Row>
            </Section>
          </div>

          <Section title="薪轉帳戶" disabled={locked}>
            <Row label="銀行代碼" htmlFor="emp-bank-code">
              <input
                id="emp-bank-code"
                className={inputCls}
                value={personal.bankCode}
                onChange={(e) => setPersonalField("bankCode", e.target.value)}
                autoComplete="off"
              />
            </Row>
            <Row label="銀行名稱" htmlFor="emp-bank-name">
              <input
                id="emp-bank-name"
                className={inputCls}
                value={personal.bankName}
                onChange={(e) => setPersonalField("bankName", e.target.value)}
                autoComplete="off"
              />
            </Row>
            <Row label="帳號" htmlFor="emp-bank-account">
              <input
                id="emp-bank-account"
                className={`${inputCls} tabular-nums`}
                value={personal.bankAccount}
                onChange={(e) => setPersonalField("bankAccount", e.target.value)}
                autoComplete="off"
              />
            </Row>
            <Row label="戶名" htmlFor="emp-bank-holder">
              <input
                id="emp-bank-holder"
                className={inputCls}
                value={personal.accountHolder}
                onChange={(e) => setPersonalField("accountHolder", e.target.value)}
                autoComplete="off"
              />
            </Row>
          </Section>

          <Section title="個人功能" hint="只影響這位員工，不改公司規則。" disabled={locked}>
            <Toggle
              id="emp-wfh"
              label="允許在家上班打卡"
              hint="員工端打卡卡片會出現「在家上班」勾選框。"
              checked={form.wfhPunch}
              onChange={(checked) => set("wfhPunch", checked)}
            />
            <Toggle
              id="emp-no-night"
              label="不計夜間加給"
              hint="結算夜間分鐘寫 0，薪資與出勤月表試算不發夜間加給。"
              checked={form.noNightPremium}
              onChange={(checked) => set("noNightPremium", checked)}
            />
            {canGrantFinancials && (
              <Toggle
                id="emp-group-financials"
                label="可看集團財務"
                hint={
                  form.role === "hr_admin"
                    ? "集團總覽、專案毛利、首頁本年收入／毛利率。只有老闆或平台管理員能設定。"
                    : "只對 HR 管理員有效（這位目前不是 HR 管理員，勾了也看不到）。只有老闆或平台管理員能設定。"
                }
                checked={form.seeGroupFinancials}
                onChange={(checked) => set("seeGroupFinancials", checked)}
              />
            )}
          </Section>
      </div>

      {canManage && (
        <Card>
          <h2 className="text-base font-semibold text-gray-900">帳號</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {employee.user_id ? "已開通登入帳號。" : "尚未開通登入帳號，可寄邀請信讓同仁自設密碼。"}
            {credentialsLocked && <span className="ml-1 text-amber-700">{CREDENTIALS_LOCKED_NOTE}</span>}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {accountActions.map((spec) => (
              <Button
                key={spec.key}
                variant={spec.tone === "danger" ? "danger" : spec.tone === "muted" ? "ghost" : "secondary"}
                size="sm"
                disabled={spec.disabled || saving}
                title={spec.title}
                onClick={() => actions.run(spec.key, { id: employee.id, name: employee.name })}
              >
                {spec.key === "profile" ? "My Data（照片、學歷、證照、經歷）" : spec.label}
              </Button>
            ))}
          </div>
        </Card>
      )}

      {/* 儲存列：固定在頁面底部（長頁面捲到哪都按得到）；主要動作「儲存」在最右邊。 */}
      {canManage && (
        <div className="sticky bottom-0 z-30 rounded-xl border border-gray-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          {saveError && (
            <div className="mb-2">
              <ErrorText>{saveError}</ErrorText>
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            <span className="mr-auto text-xs text-gray-500" aria-live="polite">
              {dirty ? "有尚未儲存的修改" : "所有修改都已儲存"}
            </span>
            <Button variant="secondary" onClick={cancel} disabled={saving || !dirty}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty && !saveError}>
              儲存
            </Button>
          </div>
        </div>
      )}
      </>
      )}
    </>
  );
}
