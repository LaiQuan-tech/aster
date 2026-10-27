import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import {
  bossNotificationRecipients,
  isBossOrPlatformAdmin,
  isConfiguredBoss,
  isPlatformAdminRole,
  loadPlatformAdminEmpIds,
} from "../lib/boss.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * lib/boss.ts：2026-10-27 業主「以後平台管理員就是老闆」的共用判準與通知收件人。
 * ⚠️ 識別碼、名稱都是明顯的假值。
 */

const BOSS = "cccccccc-0000-4000-8000-0000000000b0"
const PA1 = "cccccccc-0000-4000-8000-0000000000a1"
const PA2 = "cccccccc-0000-4000-8000-0000000000a2"
const HR = "cccccccc-0000-4000-8000-0000000000c1"

describe("isBossOrPlatformAdmin（純函式）", () => {
  it("老闆本人（不分大小寫、不看角色）可以；platform_admin 可以（沒設定老闆也可以）", () => {
    expect(isBossOrPlatformAdmin(BOSS, { id: BOSS, role: "employee" })).toBe(true)
    expect(isBossOrPlatformAdmin(BOSS.toUpperCase(), { id: BOSS, role: "hr_admin" })).toBe(true)
    expect(isBossOrPlatformAdmin(BOSS, { id: PA1, role: "platform_admin" })).toBe(true)
    expect(isBossOrPlatformAdmin(null, { id: PA1, role: "platform_admin" })).toBe(true)
  })

  it("hr_admin（不是老闆）、一般員工、沒有員工 id 都不行；大小寫變體的角色字串不帶權限", () => {
    expect(isBossOrPlatformAdmin(BOSS, { id: HR, role: "hr_admin" })).toBe(false)
    expect(isBossOrPlatformAdmin(null, { id: HR, role: "hr_admin" })).toBe(false)
    expect(isBossOrPlatformAdmin(BOSS, { id: HR, role: "accountant" })).toBe(false)
    expect(isBossOrPlatformAdmin(BOSS, { id: null, role: "platform_admin" })).toBe(false)
    expect(isBossOrPlatformAdmin(BOSS, null)).toBe(false)
    expect(isPlatformAdminRole("Platform_Admin")).toBe(false)
    expect(isConfiguredBoss(null, BOSS)).toBe(false)
  })
})

describe("bossNotificationRecipients", () => {
  beforeEach(() => {
    fake.reset()
    fake.db.employees = [
      { id: PA1, tenant_id: TENANT_ID, role: "platform_admin", status: "active", name: "平台甲" },
      { id: PA2, tenant_id: TENANT_ID, role: "platform_admin", status: "active", name: "平台乙" },
      { id: "cccccccc-0000-4000-8000-0000000000a3", tenant_id: TENANT_ID, role: "platform_admin", status: "terminated", name: "已離職" },
      { id: "cccccccc-0000-4000-8000-0000000000a4", tenant_id: OTHER_TENANT_ID, role: "platform_admin", status: "active", name: "別租戶" },
      { id: HR, tenant_id: TENANT_ID, role: "hr_admin", status: "active", name: "人資" },
      { id: BOSS, tenant_id: TENANT_ID, role: "employee", status: "active", name: "老闆" },
    ]
  })

  it("老闆＋本租戶在職 platform_admin，去重；不含 hr_admin、離職者、別租戶", async () => {
    expect((await loadPlatformAdminEmpIds(TENANT_ID)).sort()).toEqual([PA1, PA2].sort())
    expect((await bossNotificationRecipients(TENANT_ID, BOSS.toUpperCase())).sort()).toEqual([BOSS, PA1, PA2].sort())
    // 老闆本人就是 platform_admin → 不重複
    expect((await bossNotificationRecipients(TENANT_ID, PA1)).sort()).toEqual([PA1, PA2].sort())
    // 沒有老闆 → 只有 platform_admin
    expect((await bossNotificationRecipients(TENANT_ID, null)).sort()).toEqual([PA1, PA2].sort())
  })

  it("exclude（呼叫端原本的排除）照樣排除，不分大小寫", async () => {
    expect((await bossNotificationRecipients(TENANT_ID, BOSS, [PA1.toUpperCase(), null])).sort()).toEqual([BOSS, PA2].sort())
  })
})
