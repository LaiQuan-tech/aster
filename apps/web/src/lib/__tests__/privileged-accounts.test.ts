import { describe, expect, it } from "vitest";
import {
  BOSS_SETTING_BOOTSTRAP_NOTE,
  BOSS_SETTING_HANDOVER_NOTE,
  BOSS_SETTING_LOCKED_NOTE,
  CREDENTIALS_LOCKED_NOTE,
  PLATFORM_ADMIN_ASSIGN_NOTE,
  bossSettingNote,
  canAssignPlatformAdmin,
  canChangeBossSetting,
  credentialsLockedFor,
  isProtectedAccountView,
  needsBossHandoverConfirm,
  privilegeErrorMessage,
  privilegePolicyOf,
  ROLE_CHANGE_LOCKED_NOTE,
  roleChangeLockedFor,
  roleOptionsFor,
  type PrivilegePolicy,
} from "../privileged-accounts";
import { employeeActionsFor } from "../employee-actions";
import { accountErrorMessage } from "../auth-api";

/**
 * 特權帳號邊界的畫面端判斷（2026-10-11 業主拍板）：與後端 services/privileged-accounts.ts 同一個判準，
 * 差別只在這裡決定「要不要讓人按」與「被擋時顯示什麼」，後端才是真正的守門員。
 * ⚠️ 識別碼都是明顯的假值。
 */

const BOSS = "b0000000-0000-4000-8000-000000000001";
const DESIGNEE = "b0000000-0000-4000-8000-000000000002";
const HR = "b0000000-0000-4000-8000-000000000003";
const HR2 = "b0000000-0000-4000-8000-000000000004";
const EMP = "b0000000-0000-4000-8000-000000000005";
const PA = "b0000000-0000-4000-8000-000000000006";

const policy: PrivilegePolicy = { bossEmpId: BOSS, designated: [DESIGNEE] };
const noBossPolicy: PrivilegePolicy = { bossEmpId: null, designated: [] };
const hr = { id: HR, role: "hr_admin" };
const boss = { id: BOSS, role: "hr_admin" };
const pa = { id: PA, role: "platform_admin" };

describe("privilegePolicyOf — 從 branding.features 取老闆與解鎖人", () => {
  it("取出小寫的老闆 id 與解鎖名單；沒設定／格式不對＝沒有老闆、空名單", () => {
    expect(privilegePolicyOf({ approval: { fallbackApproverEmpId: BOSS.toUpperCase() }, payroll: { periodUnlockEmpIds: [DESIGNEE.toUpperCase()] } })).toEqual({
      bossEmpId: BOSS,
      designated: [DESIGNEE],
    });
    expect(privilegePolicyOf(null)).toEqual(noBossPolicy);
    expect(privilegePolicyOf({})).toEqual(noBossPolicy);
    expect(privilegePolicyOf({ approval: { fallbackApproverEmpId: "" }, payroll: { periodUnlockEmpIds: "x" } })).toEqual(noBossPolicy);
  });
});

describe("① 換老闆設定", () => {
  it("有老闆：只有老闆本人與 platform_admin 能換；HR 不行。沒有老闆：HR 可做第一次設定。登入者未載入先不鎖", () => {
    expect(canChangeBossSetting(hr, BOSS)).toBe(false);
    expect(canChangeBossSetting(boss, BOSS)).toBe(true);
    expect(canChangeBossSetting({ id: BOSS.toUpperCase(), role: "hr_admin" }, BOSS)).toBe(true);
    expect(canChangeBossSetting(pa, BOSS)).toBe(true);
    expect(canChangeBossSetting(hr, null)).toBe(true);
    expect(canChangeBossSetting(hr, "")).toBe(true);
    expect(canChangeBossSetting(null, BOSS)).toBe(true);
  });

  it("bossSettingNote：HR 看到『只有老闆或平台管理員…』、沒老闆時看到可先設定、老闆本人看到交棒提醒、平台管理員不需要提醒", () => {
    expect(bossSettingNote(hr, BOSS)).toEqual({ tone: "locked", text: BOSS_SETTING_LOCKED_NOTE });
    expect(bossSettingNote(hr, null)).toEqual({ tone: "bootstrap", text: BOSS_SETTING_BOOTSTRAP_NOTE });
    expect(bossSettingNote(boss, BOSS)).toEqual({ tone: "handover", text: BOSS_SETTING_HANDOVER_NOTE });
    expect(bossSettingNote(pa, BOSS)).toBeNull();
    expect(bossSettingNote(null, BOSS)).toBeNull();
    expect(BOSS_SETTING_LOCKED_NOTE).toContain("老闆");
  });

  it("needsBossHandoverConfirm：只有老闆本人把老闆換成別人／清除時才要先確認；沒變、platform_admin、HR 都不用", () => {
    expect(needsBossHandoverConfirm(boss, BOSS, HR2)).toBe(true);
    expect(needsBossHandoverConfirm(boss, BOSS, "")).toBe(true);
    expect(needsBossHandoverConfirm(boss, BOSS, null)).toBe(true);
    expect(needsBossHandoverConfirm(boss, BOSS, BOSS.toUpperCase())).toBe(false);
    expect(needsBossHandoverConfirm(pa, BOSS, HR2)).toBe(false);
    expect(needsBossHandoverConfirm(hr, BOSS, HR2)).toBe(false);
    expect(needsBossHandoverConfirm(hr, null, HR)).toBe(false); // 第一次設定不是交棒
    expect(needsBossHandoverConfirm(null, BOSS, HR2)).toBe(false);
  });
});

describe("② 指派平台管理員角色", () => {
  it("只有 platform_admin 能指派", () => {
    expect(canAssignPlatformAdmin(pa)).toBe(true);
    expect(canAssignPlatformAdmin(hr)).toBe(false);
    expect(canAssignPlatformAdmin(boss)).toBe(false);
    expect(canAssignPlatformAdmin(null)).toBe(false);
  });

  const base = [
    { value: "employee", label: "一般員工" },
    { value: "manager", label: "主管" },
    { value: "accountant", label: "會計" },
    { value: "hr_admin", label: "HR 管理員" },
  ];

  it("roleOptionsFor：在 HR 管理員後面補『平台管理員』；沒權限的人看到的是停用並帶說明", () => {
    const forHr = roleOptionsFor(base, hr);
    expect(forHr.map((o) => o.value)).toEqual(["employee", "manager", "accountant", "hr_admin", "platform_admin"]);
    const option = forHr.find((o) => o.value === "platform_admin");
    expect(option).toMatchObject({ disabled: true });
    expect(option?.label).toContain("僅平台管理員可指派");

    const forPa = roleOptionsFor(base, pa);
    expect(forPa.find((o) => o.value === "platform_admin")).toEqual({ value: "platform_admin", label: "平台管理員" });
  });

  it("目標本來就是平台管理員時保持可選（下拉才有目前的值，存檔不會把角色改掉）；其他目標仍停用", () => {
    expect(roleOptionsFor(base, hr, "platform_admin").find((o) => o.value === "platform_admin")?.disabled).toBeUndefined();
    expect(roleOptionsFor(base, hr, "hr_admin").find((o) => o.value === "platform_admin")?.disabled).toBe(true);
    expect(roleOptionsFor(base, null).find((o) => o.value === "platform_admin")?.disabled).toBe(true);
  });

  it("不重複：base 已含 platform_admin 時只留一個", () => {
    const withPlatform = [...base, { value: "platform_admin", label: "平台管理員" }];
    expect(roleOptionsFor(withPlatform, pa).filter((o) => o.value === "platform_admin")).toHaveLength(1);
  });
});

describe("③ 重設／寄連結給受保護帳號", () => {
  it("受保護：老闆、解鎖人、hr_admin、platform_admin；一般員工／主管／會計不是", () => {
    expect(isProtectedAccountView({ id: BOSS, role: "employee" }, policy)).toBe(true);
    expect(isProtectedAccountView({ id: DESIGNEE, role: "employee" }, policy)).toBe(true);
    expect(isProtectedAccountView({ id: HR2, role: "hr_admin" }, policy)).toBe(true);
    expect(isProtectedAccountView({ id: PA, role: "platform_admin" }, policy)).toBe(true);
    for (const role of ["employee", "manager", "accountant"]) expect(isProtectedAccountView({ id: EMP, role }, policy)).toBe(false);
    expect(isProtectedAccountView({ id: BOSS, role: "employee" }, noBossPolicy)).toBe(false);
  });

  it("HR 對受保護帳號鎖住、對一般員工與自己不鎖；老闆與 platform_admin 都不鎖；登入者未載入不鎖", () => {
    for (const target of [
      { id: BOSS, role: "employee" },
      { id: DESIGNEE, role: "employee" },
      { id: HR2, role: "hr_admin" },
      { id: PA, role: "platform_admin" },
    ]) {
      expect(credentialsLockedFor(hr, target, policy), target.id).toBe(true);
      expect(credentialsLockedFor(boss, target, policy), target.id).toBe(false);
      expect(credentialsLockedFor(pa, target, policy), target.id).toBe(false);
      expect(credentialsLockedFor(null, target, policy), target.id).toBe(false);
    }
    expect(credentialsLockedFor(hr, { id: EMP, role: "employee" }, policy)).toBe(false);
    expect(credentialsLockedFor(hr, { id: HR, role: "hr_admin" }, policy)).toBe(false); // 對自己
    expect(credentialsLockedFor({ id: HR.toUpperCase(), role: "hr_admin" }, { id: HR, role: "hr_admin" }, policy)).toBe(false);
  });

  it("沒有老闆時：HR 對其他 hr_admin 仍鎖住（沒有老闆可代表）；platform_admin 不鎖", () => {
    expect(credentialsLockedFor(hr, { id: HR2, role: "hr_admin" }, noBossPolicy)).toBe(true);
    expect(credentialsLockedFor(pa, { id: HR2, role: "hr_admin" }, noBossPolicy)).toBe(false);
  });

  it("員工列表的『⋯』選單：鎖住時寄重設密碼信／設定密碼／暫時密碼／寄邀請信 disabled 並帶說明，其他動作不受影響", () => {
    const withAccount = employeeActionsFor({ status: "active", user_id: "u1" }, { isSelf: false, credentialsLocked: true });
    for (const key of ["send-reset", "set-password", "temp-password"] as const) {
      const action = withAccount.find((a) => a.key === key);
      expect(action?.disabled, key).toBe(true);
      expect(action?.title, key).toBe(CREDENTIALS_LOCKED_NOTE);
    }
    for (const key of ["profile", "deactivate", "audit"] as const) {
      expect(withAccount.find((a) => a.key === key)?.disabled, key).toBeFalsy();
    }
    const noAccount = employeeActionsFor({ status: "active", user_id: null }, { isSelf: false, credentialsLocked: true });
    expect(noAccount.find((a) => a.key === "send-invite")).toMatchObject({ disabled: true, title: CREDENTIALS_LOCKED_NOTE });
    // 沒鎖（預設）時維持原樣
    const open = employeeActionsFor({ status: "active", user_id: "u1" }, { isSelf: false });
    expect(open.find((a) => a.key === "send-reset")?.disabled).toBeFalsy();
    expect(open.find((a) => a.key === "set-password")?.title).toBe("由 HR 直接指定一組密碼（同仁下次登入須改密碼）");
  });
});

describe("變更受保護帳號的角色（含降級）——員工管理頁編輯列的角色下拉", () => {
  it("與重設密碼同一個判準：HR 對老闆、解鎖人、其他 hr_admin、platform_admin 鎖住；對一般員工與自己不鎖；老闆與 platform_admin 都不鎖", () => {
    for (const target of [
      { id: BOSS, role: "hr_admin" },
      { id: DESIGNEE, role: "employee" },
      { id: HR2, role: "hr_admin" },
      { id: PA, role: "platform_admin" },
    ]) {
      expect(roleChangeLockedFor(hr, target, policy), target.id).toBe(true);
      expect(roleChangeLockedFor(boss, target, policy), target.id).toBe(false);
      expect(roleChangeLockedFor(pa, target, policy), target.id).toBe(false);
    }
    expect(roleChangeLockedFor(hr, { id: EMP, role: "employee" }, policy)).toBe(false);
    expect(roleChangeLockedFor(hr, { id: HR, role: "hr_admin" }, policy)).toBe(false);
    expect(roleChangeLockedFor(null, { id: HR2, role: "hr_admin" }, policy)).toBe(false);
  });

  it("後端回 not_boss 時，角色情境給『變更角色』的說法", () => {
    const err = Object.assign(new Error("[403] not_boss"), { code: "not_boss", status: 403 });
    expect(privilegeErrorMessage(err, "role")).toBe(ROLE_CHANGE_LOCKED_NOTE);
    expect(ROLE_CHANGE_LOCKED_NOTE).toContain("角色");
  });
});

describe("被擋時的友善訊息", () => {
  const apiError = (status: number, code: string) => Object.assign(new Error(`[${status}] ${code}`), { code, status });

  it("privilegeErrorMessage：not_boss 依情境給換老闆或重設密碼的說法；platform_admin_required 給指派角色的說法；其他回 null", () => {
    expect(privilegeErrorMessage(apiError(403, "not_boss"), "boss")).toBe(BOSS_SETTING_LOCKED_NOTE);
    expect(privilegeErrorMessage(apiError(403, "not_boss"))).toBe(BOSS_SETTING_LOCKED_NOTE);
    expect(privilegeErrorMessage(apiError(403, "not_boss"), "credentials")).toBe(CREDENTIALS_LOCKED_NOTE);
    expect(privilegeErrorMessage(apiError(403, "platform_admin_required"))).toBe(PLATFORM_ADMIN_ASSIGN_NOTE);
    expect(privilegeErrorMessage(new Error("[403] not_boss"), "credentials")).toBe(CREDENTIALS_LOCKED_NOTE); // 只剩 message 也認得
    expect(privilegeErrorMessage(apiError(409, "no_account"))).toBeNull();
    expect(privilegeErrorMessage("oops")).toBeNull();
  });

  it("accountErrorMessage（員工管理頁的錯誤翻譯表）也認得這兩個代碼；批次建立的列錯誤『not_boss: …』同樣翻得出來", () => {
    expect(accountErrorMessage(new Error("[403] not_boss"))).toContain("只有老闆或平台管理員");
    expect(accountErrorMessage(new Error("[403] platform_admin_required"))).toContain("平台管理員");
    // 受保護帳號、未開通：邀請信的收件信箱要明確輸入（400 email_required）
    expect(accountErrorMessage(new Error("[400] email_required"))).toContain("明確輸入收件信箱");
    expect(accountErrorMessage(new Error("not_boss: 只有老闆或平台管理員可以重設老闆、HR 管理員或平台管理員的密碼"))).toContain("只有老闆或平台管理員");
  });
});
