import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import {
  CREDENTIALS_MESSAGE,
  PLATFORM_ADMIN_ASSIGN_MESSAGE,
  PrivilegeError,
  assertCanAssignRole,
  assertCanManageCredentials,
  bossChanged,
  canAssignRole,
  canChangeBoss,
  canManageCredentialsOf,
  isBossOrPlatformAdmin,
  isPlatformAdminPromotion,
  isPrivilegeError,
  isProtectedAccount,
  loadActor,
  normalizeRole,
} from "../services/privileged-accounts.js"
import { unlockPolicyOf, type PeriodUnlockPolicy } from "../services/period-lock.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 特權帳號的權限邊界（services/privileged-accounts.ts，2026-10-11 業主拍板）：
 * 換老闆、指派 platform_admin、重設受保護帳號的密碼——只有老闆或 platform_admin。純函式＋兩個會讀庫的 assert。
 * ⚠️ 識別碼都是明顯的假值（repo 是公開的）。
 */

const BOSS = "b0000000-0000-4000-8000-000000000001"
const DESIGNEE = "b0000000-0000-4000-8000-000000000002"
const HR = "b0000000-0000-4000-8000-000000000003"
const HR2 = "b0000000-0000-4000-8000-000000000004"
const EMP = "b0000000-0000-4000-8000-000000000005"
const PA = "b0000000-0000-4000-8000-000000000006"

const withBoss: PeriodUnlockPolicy = { bossEmpId: BOSS, designatedEmpIds: [DESIGNEE] }
const noBoss: PeriodUnlockPolicy = { bossEmpId: null, designatedEmpIds: [] }

describe("角色字串", () => {
  it("normalizeRole：去頭尾空白、轉小寫；null／undefined 變空字串", () => {
    expect(normalizeRole(" Platform_Admin ")).toBe("platform_admin")
    expect(normalizeRole(null)).toBe("")
    expect(normalizeRole(undefined)).toBe("")
  })
})

describe("isBossOrPlatformAdmin／canChangeBoss／bossChanged — 換老闆", () => {
  it("老闆本人、platform_admin 是；HR、老闆指定的人、一般員工不是（沒設老闆時也一樣只剩 platform_admin）", () => {
    expect(isBossOrPlatformAdmin(withBoss, { id: BOSS, role: "hr_admin" })).toBe(true)
    expect(isBossOrPlatformAdmin(withBoss, { id: BOSS.toUpperCase(), role: "employee" })).toBe(true) // 比對不分大小寫
    expect(isBossOrPlatformAdmin(withBoss, { id: PA, role: "platform_admin" })).toBe(true)
    expect(isBossOrPlatformAdmin(withBoss, { id: HR, role: "hr_admin" })).toBe(false)
    expect(isBossOrPlatformAdmin(withBoss, { id: DESIGNEE, role: "employee" })).toBe(false)
    expect(isBossOrPlatformAdmin(noBoss, { id: HR, role: "hr_admin" })).toBe(false)
    expect(isBossOrPlatformAdmin(noBoss, { id: PA, role: "platform_admin" })).toBe(true)
  })

  it("canChangeBoss：有老闆 → 只有老闆或 platform_admin；沒有老闆（初始狀態）→ 任何 HR 可做第一次設定", () => {
    expect(canChangeBoss(withBoss, { id: HR, role: "hr_admin" })).toBe(false)
    expect(canChangeBoss(withBoss, { id: BOSS, role: "hr_admin" })).toBe(true) // 交棒
    expect(canChangeBoss(withBoss, { id: PA, role: "platform_admin" })).toBe(true)
    expect(canChangeBoss(noBoss, { id: HR, role: "hr_admin" })).toBe(true)
  })

  it("bossChanged：看有效值（小寫、null）——同一個人不算更換；設定→清除、清除→設定都算", () => {
    const upper = unlockPolicyOf({ approval: { fallbackApproverEmpId: BOSS.toUpperCase() } })
    expect(bossChanged(withBoss, upper)).toBe(false)
    expect(bossChanged(withBoss, noBoss)).toBe(true)
    expect(bossChanged(noBoss, withBoss)).toBe(true)
    expect(bossChanged(noBoss, unlockPolicyOf({}))).toBe(false)
    expect(bossChanged(withBoss, unlockPolicyOf({ approval: { fallbackApproverEmpId: HR } }))).toBe(true)
  })
})

describe("canAssignRole／isPlatformAdminPromotion — 指派 platform_admin", () => {
  it("platform_admin 只有 platform_admin 能指派；其他角色誰都不受這條限制", () => {
    expect(canAssignRole({ id: HR, role: "hr_admin" }, "platform_admin")).toBe(false)
    expect(canAssignRole({ id: HR, role: "hr_admin" }, " Platform_Admin ")).toBe(false) // 換大小寫／空白也擋
    expect(canAssignRole({ id: PA, role: "platform_admin" }, "platform_admin")).toBe(true)
    expect(canAssignRole({ id: HR, role: "hr_admin" }, "hr_admin")).toBe(true)
    expect(canAssignRole({ id: HR, role: "hr_admin" }, "accountant")).toBe(true)
    expect(canAssignRole({ id: HR, role: "hr_admin" }, "employee")).toBe(true)
  })

  it("isPlatformAdminPromotion：只擋「變成」——目標本來就是 platform_admin、帶原值存檔不算", () => {
    expect(isPlatformAdminPromotion("platform_admin", "hr_admin")).toBe(true)
    expect(isPlatformAdminPromotion("platform_admin", "employee")).toBe(true)
    expect(isPlatformAdminPromotion("platform_admin", null)).toBe(true) // 新建的列
    expect(isPlatformAdminPromotion("platform_admin", "platform_admin")).toBe(false)
    expect(isPlatformAdminPromotion("hr_admin", "platform_admin")).toBe(false) // 降級不在這條範圍
    expect(isPlatformAdminPromotion("employee", "employee")).toBe(false)
  })

  it("assertCanAssignRole：HR 指派 platform_admin → PrivilegeError(platform_admin_required)；其他角色與 platform_admin 本人放行", () => {
    expect(() => assertCanAssignRole({ id: HR, role: "hr_admin" }, "platform_admin")).toThrow(PrivilegeError)
    try {
      assertCanAssignRole({ id: HR, role: "hr_admin" }, "platform_admin")
    } catch (err) {
      expect(isPrivilegeError(err)).toBe(true)
      expect((err as PrivilegeError).toBody()).toEqual({ error: "platform_admin_required", message: PLATFORM_ADMIN_ASSIGN_MESSAGE })
      expect((err as PrivilegeError).httpStatus).toBe(403)
    }
    expect(() => assertCanAssignRole(null, "platform_admin")).toThrow(PrivilegeError) // 查不到呼叫者＝沒權限
    expect(() => assertCanAssignRole({ id: PA, role: "platform_admin" }, "platform_admin")).not.toThrow()
    expect(() => assertCanAssignRole({ id: HR, role: "hr_admin" }, "hr_admin")).not.toThrow()
    expect(() => assertCanAssignRole(null, "employee")).not.toThrow()
  })
})

describe("isProtectedAccount／canManageCredentialsOf — 重設密碼、發連結、綁帳號", () => {
  it("受保護：老闆、老闆指定的解鎖人、hr_admin、platform_admin；一般員工／主管／會計不是", () => {
    expect(isProtectedAccount({ id: BOSS, role: "employee" }, withBoss)).toBe(true)
    expect(isProtectedAccount({ id: BOSS.toUpperCase(), role: "employee" }, withBoss)).toBe(true)
    expect(isProtectedAccount({ id: DESIGNEE, role: "employee" }, withBoss)).toBe(true)
    expect(isProtectedAccount({ id: HR2, role: "hr_admin" }, withBoss)).toBe(true)
    expect(isProtectedAccount({ id: PA, role: "platform_admin" }, withBoss)).toBe(true)
    expect(isProtectedAccount({ id: EMP, role: "employee" }, withBoss)).toBe(false)
    expect(isProtectedAccount({ id: EMP, role: "manager" }, withBoss)).toBe(false)
    expect(isProtectedAccount({ id: EMP, role: "accountant" }, withBoss)).toBe(false)
    // 沒設老闆時，原本的「老闆」不存在，一般員工就是一般員工。
    expect(isProtectedAccount({ id: BOSS, role: "employee" }, noBoss)).toBe(false)
  })

  it("HR 對一般員工照舊；對受保護帳號（老闆／解鎖人／其他 hr_admin／platform_admin）不行", () => {
    const hr = { id: HR, role: "hr_admin" }
    expect(canManageCredentialsOf(hr, { id: EMP, role: "employee" }, withBoss)).toBe(true)
    expect(canManageCredentialsOf(hr, { id: BOSS, role: "employee" }, withBoss)).toBe(false)
    expect(canManageCredentialsOf(hr, { id: BOSS, role: "hr_admin" }, withBoss)).toBe(false)
    expect(canManageCredentialsOf(hr, { id: DESIGNEE, role: "employee" }, withBoss)).toBe(false)
    expect(canManageCredentialsOf(hr, { id: HR2, role: "hr_admin" }, withBoss)).toBe(false)
    expect(canManageCredentialsOf(hr, { id: PA, role: "platform_admin" }, withBoss)).toBe(false)
  })

  it("老闆與 platform_admin 對任何人都行；對自己一律行（不是接管）", () => {
    const boss = { id: BOSS, role: "hr_admin" }
    const pa = { id: PA, role: "platform_admin" }
    for (const target of [
      { id: EMP, role: "employee" },
      { id: HR, role: "hr_admin" },
      { id: DESIGNEE, role: "employee" },
      { id: PA, role: "platform_admin" },
    ]) {
      expect(canManageCredentialsOf(boss, target, withBoss)).toBe(true)
      expect(canManageCredentialsOf(pa, target, withBoss)).toBe(true)
    }
    expect(canManageCredentialsOf({ id: HR, role: "hr_admin" }, { id: HR, role: "hr_admin" }, withBoss)).toBe(true)
    expect(canManageCredentialsOf({ id: HR.toUpperCase(), role: "hr_admin" }, { id: HR, role: "hr_admin" }, withBoss)).toBe(true)
  })

  it("沒有老闆時：HR 動不了其他 hr_admin／platform_admin（沒有老闆可以代表）；platform_admin 仍可", () => {
    expect(canManageCredentialsOf({ id: HR, role: "hr_admin" }, { id: HR2, role: "hr_admin" }, noBoss)).toBe(false)
    expect(canManageCredentialsOf({ id: PA, role: "platform_admin" }, { id: HR2, role: "hr_admin" }, noBoss)).toBe(true)
  })
})

describe("assertCanManageCredentials／loadActor — 會讀租戶的解鎖政策", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.tenants = [
      { id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS }, payroll: { periodUnlockEmpIds: [DESIGNEE] } } },
    ]
    fake.db.employees = [
      { id: BOSS, tenant_id: TENANT_ID, role: "employee" },
      { id: HR, tenant_id: TENANT_ID, role: "hr_admin" },
    ]
  })

  it("HR 動老闆 → PrivilegeError(not_boss)，訊息是業主看得懂的中文", async () => {
    const err = await assertCanManageCredentials(TENANT_ID, { id: HR, role: "hr_admin" }, { id: BOSS, role: "employee" }).catch((e) => e)
    expect(isPrivilegeError(err)).toBe(true)
    expect(err.toBody()).toEqual({ error: "not_boss", message: CREDENTIALS_MESSAGE })
  })

  it("HR 動一般員工、老闆動 HR、查不到呼叫者動一般員工 → 放行；查不到呼叫者動受保護帳號 → 擋", async () => {
    await expect(assertCanManageCredentials(TENANT_ID, { id: HR, role: "hr_admin" }, { id: EMP, role: "employee" })).resolves.toBeUndefined()
    await expect(assertCanManageCredentials(TENANT_ID, { id: BOSS, role: "employee" }, { id: HR, role: "hr_admin" })).resolves.toBeUndefined()
    await expect(assertCanManageCredentials(TENANT_ID, null, { id: EMP, role: "employee" })).resolves.toBeUndefined()
    await expect(assertCanManageCredentials(TENANT_ID, null, { id: HR, role: "hr_admin" })).rejects.toBeInstanceOf(PrivilegeError)
  })

  it("loadActor：用員工 id 查角色；沒帶 id、別的租戶、查無都回 null", async () => {
    expect(await loadActor(TENANT_ID, HR)).toEqual({ id: HR, role: "hr_admin" })
    expect(await loadActor(TENANT_ID, null)).toBeNull()
    expect(await loadActor(TENANT_ID, undefined)).toBeNull()
    expect(await loadActor(TENANT_ID, "ffffffff-ffff-4fff-8fff-ffffffffffff")).toBeNull()
    expect(await loadActor("99999999-9999-4999-8999-999999999999", HR)).toBeNull()
  })
})
