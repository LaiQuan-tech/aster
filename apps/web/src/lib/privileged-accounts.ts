/**
 * 特權帳號的權限邊界（2026-10-11 業主拍板：堵住 HR 繞過發薪解鎖）——畫面端的判斷。
 *
 * 後端真正擋人（apps/api/src/services/privileged-accounts.ts，403 `not_boss`／`platform_admin_required`）；
 * 這裡只決定「畫面要不要讓人按」與「被擋時顯示什麼」，兩邊用同一個判準：
 *   ① 換老闆設定（假別與簽核流程頁）：目前有老闆 → 只有老闆本人（可交棒）或 platform_admin；還沒有老闆 → HR 可做第一次設定。
 *   ② 指派「平台管理員」角色（員工管理頁的角色下拉）：只有 platform_admin。
 *   ③ 重設／寄連結給受保護帳號（老闆、老闆指定的解鎖人、hr_admin、platform_admin）的密碼：只有老闆或 platform_admin；
 *      對自己例外；一般員工照舊。
 *
 * 純函式：不 import React、DOM、api-client。單元測試在 __tests__/privileged-accounts.test.ts。
 */
import { approvalBossEmpIdOf, canEditUnlockList, periodUnlockEmpIdsOf } from "./payroll-periods-api";

export interface PrivilegeViewer {
  id: string;
  role: string;
}

export interface PrivilegePolicy {
  /** 老闆（features.approval.fallbackApproverEmpId）；沒設定＝null。 */
  bossEmpId: string | null;
  /** 老闆指定可以重新開放已結算月份的人（小寫員工 id）。 */
  designated: string[];
}

export interface PrivilegeTarget {
  id: string;
  role: string;
}

/** 設定頁唯讀時、以及後端回 403 not_boss（換老闆）時都顯示這句。 */
export const BOSS_SETTING_LOCKED_NOTE = "只有老闆或平台管理員可以更換老闆設定";
/** 還沒有老闆時的提示（HR 可以先做第一次設定）。 */
export const BOSS_SETTING_BOOTSTRAP_NOTE =
  "目前還沒有設定老闆，可以先指定一位；設定之後要換人，只有老闆本人或平台管理員能改。";
/** 老闆本人看到的提示（交棒後自己就不能再改回來）。 */
export const BOSS_SETTING_HANDOVER_NOTE = "你是目前的老闆，可以交棒給別人；交棒之後就不能再自己改回來。";
/** 員工列表：重設密碼、寄重設／邀請信這幾個動作被停用時的說明。 */
export const CREDENTIALS_LOCKED_NOTE = "只有老闆或平台管理員可以重設老闆、HR 管理員、平台管理員（以及老闆指定的人）的密碼";
/** 角色下拉：沒有權限指派平台管理員時的說明。 */
export const PLATFORM_ADMIN_ASSIGN_NOTE = "「平台管理員」角色只有平台管理員可以指派";
/** 角色下拉：目標是受保護帳號、登入者不能變更它的角色時的說明。 */
export const ROLE_CHANGE_LOCKED_NOTE = "只有老闆或平台管理員可以變更老闆、HR 管理員、平台管理員（以及老闆指定的人）的角色";

const PLATFORM_ADMIN = "platform_admin";
const HR_ADMIN = "hr_admin";

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/** 從 tenants.features（GET /api/tenant/branding）取權限判斷要用的老闆與解鎖人名單。沒設定／格式不對＝沒有老闆、空名單。 */
export function privilegePolicyOf(features: Record<string, unknown> | null | undefined): PrivilegePolicy {
  const boss = approvalBossEmpIdOf(features);
  return { bossEmpId: boss ? lower(boss) : null, designated: periodUnlockEmpIdsOf(features) };
}

/**
 * ① 能不能更換老闆設定：還沒有老闆 → 任何 HR；有老闆 → 老闆本人或 platform_admin。
 * 登入者資料還沒載入（null）→ 先不鎖（後端才是守門員，被擋會回 403 並顯示說明），免得 /me 取不到時整個欄位永遠鎖死。
 */
export function canChangeBossSetting(viewer: PrivilegeViewer | null | undefined, bossEmpId: string | null | undefined): boolean {
  if (!viewer) return true;
  if (!bossEmpId) return true;
  return canEditUnlockList(viewer, bossEmpId);
}

/** 老闆設定區要顯示哪一句說明；沒有要顯示的回 null。 */
export function bossSettingNote(
  viewer: PrivilegeViewer | null | undefined,
  bossEmpId: string | null | undefined,
): { tone: "locked" | "bootstrap" | "handover"; text: string } | null {
  if (!viewer) return null;
  if (!bossEmpId) return { tone: "bootstrap", text: BOSS_SETTING_BOOTSTRAP_NOTE };
  if (!canEditUnlockList(viewer, bossEmpId)) return { tone: "locked", text: BOSS_SETTING_LOCKED_NOTE };
  // 老闆本人（不是 platform_admin）才需要「交棒後不能改回來」的提醒。
  if (lower(viewer.role) !== PLATFORM_ADMIN) return { tone: "handover", text: BOSS_SETTING_HANDOVER_NOTE };
  return null;
}

/** 老闆本人（不是 platform_admin）要把老闆換成「別人」或清除時，要先確認「交棒後不能自己改回來」。 */
export function needsBossHandoverConfirm(
  viewer: PrivilegeViewer | null | undefined,
  currentBossEmpId: string | null | undefined,
  nextBossEmpId: string | null | undefined,
): boolean {
  if (!viewer || !currentBossEmpId) return false;
  if (lower(viewer.role) === PLATFORM_ADMIN) return false;
  if (lower(viewer.id) !== lower(currentBossEmpId)) return false;
  return lower(nextBossEmpId ?? "") !== lower(currentBossEmpId);
}

/** ② 能不能指派「平台管理員」角色：只有 platform_admin。 */
export function canAssignPlatformAdmin(viewer: PrivilegeViewer | null | undefined): boolean {
  return !!viewer && lower(viewer.role) === PLATFORM_ADMIN;
}

export interface RoleOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * 角色下拉的選項：在 HR 管理員後面補上「平台管理員」。沒有權限指派的人看到它是停用的（帶說明），
 * 但**目標本來就是平台管理員**（`currentRole`）時保持可選——否則下拉選不到目前的值，存檔會把角色改掉
 * （後端也允許帶原值存檔，只擋「變成」）。
 */
export function roleOptionsFor(
  base: readonly RoleOption[],
  viewer: PrivilegeViewer | null | undefined,
  currentRole?: string | null,
): RoleOption[] {
  const withoutPlatform = base.filter((option) => option.value !== PLATFORM_ADMIN);
  const hrIndex = withoutPlatform.findIndex((option) => option.value === HR_ADMIN);
  const at = hrIndex >= 0 ? hrIndex + 1 : withoutPlatform.length;
  const alreadyPlatform = !!currentRole && lower(currentRole) === PLATFORM_ADMIN;
  const allowed = canAssignPlatformAdmin(viewer) || alreadyPlatform;
  const platformOption: RoleOption = allowed
    ? { value: PLATFORM_ADMIN, label: "平台管理員" }
    : { value: PLATFORM_ADMIN, label: "平台管理員（僅平台管理員可指派）", disabled: true };
  return [...withoutPlatform.slice(0, at), platformOption, ...withoutPlatform.slice(at)];
}

/** 受保護帳號：老闆、老闆指定的解鎖人、hr_admin、platform_admin。 */
export function isProtectedAccountView(target: PrivilegeTarget, policy: PrivilegePolicy): boolean {
  const role = lower(target.role);
  if (role === HR_ADMIN || role === PLATFORM_ADMIN) return true;
  const id = lower(target.id);
  return policy.bossEmpId === id || policy.designated.includes(id);
}

/**
 * ③ 這位登入者對 `target` 的重設密碼／寄連結是不是被鎖住：目標是受保護帳號、登入者不是老闆也不是 platform_admin、
 * 而且不是對自己。登入者資料還沒載入（null）→ 不鎖（後端才是守門員，被擋會回 403 並顯示說明）。
 */
export function credentialsLockedFor(
  viewer: PrivilegeViewer | null | undefined,
  target: PrivilegeTarget,
  policy: PrivilegePolicy,
): boolean {
  if (!viewer) return false;
  if (!isProtectedAccountView(target, policy)) return false;
  if (lower(viewer.id) === lower(target.id)) return false;
  if (lower(viewer.role) === PLATFORM_ADMIN) return false;
  if (policy.bossEmpId && lower(viewer.id) === policy.bossEmpId) return false;
  return true;
}

/**
 * 這位登入者對 `target` 的**角色**變更是不是被鎖住：與重設密碼同一個判準（受保護帳號、登入者不是老闆也不是 platform_admin、
 * 而且不是對自己）。後端同樣擋——降級也算：否則 HR 可以先把另一位 HR 降成一般員工、重設密碼、再升回去。
 * 只有「角色真的有變」才會被後端擋；員工管理頁儲存時帶著原值不受影響，所以這裡鎖的是下拉本身。
 */
export function roleChangeLockedFor(
  viewer: PrivilegeViewer | null | undefined,
  target: PrivilegeTarget,
  policy: PrivilegePolicy,
): boolean {
  return credentialsLockedFor(viewer, target, policy);
}

function codeOf(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  const match = /^\[\d{3}\]\s*([a-z][a-z0-9_]*)/i.exec(err.message.trim());
  return match?.[1] ?? null;
}

/**
 * 後端的特權邊界錯誤 → 給人看的中文；不是這類錯誤回 null（呼叫端走自己原本的翻譯）。
 * `not_boss` 在不同端點意思不同，所以由呼叫端用 `context` 說清楚是哪件事。
 */
export function privilegeErrorMessage(err: unknown, context: "boss" | "credentials" | "role" = "boss"): string | null {
  const code = codeOf(err) ?? (err instanceof Error ? err.message : "");
  if (code.includes("platform_admin_required")) return PLATFORM_ADMIN_ASSIGN_NOTE;
  if (code.includes("not_boss")) {
    return context === "credentials" ? CREDENTIALS_LOCKED_NOTE : context === "role" ? ROLE_CHANGE_LOCKED_NOTE : BOSS_SETTING_LOCKED_NOTE;
  }
  return null;
}
