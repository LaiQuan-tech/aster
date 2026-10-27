import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 老闆＝平台管理員權限（業主 2026-10-27）：專案的 finance（申請單、請款期程、副委託、合約寫入）讀寫要一致。
 * resolveProjectAccess 早就給老闆 finance（頁面看得到、可編輯申請單），但寫入端走的 canManageProject／
 * loadProjectScope 原本不含老闆 → 一般員工角色的老闆按儲存一堆 403。純測試（fake-supabase，不連 DB、假資料）。
 */

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { canManageProject, financeProjectIds, loadProjectScope, resolveProjectAccess } from "../services/project-scope.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

const PROJECT = "dddddddd-0000-4000-8000-0000000000a1"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000000a1"
const BOSS = "bbbbbbbb-0000-4000-8000-0000000000a1"
const STAFF = "bbbbbbbb-0000-4000-8000-0000000000a2"
const LEAD = "bbbbbbbb-0000-4000-8000-0000000000a3"

const project = { id: PROJECT, dept_id: DEPT, lead_emp_id: LEAD }
const boss = { id: BOSS, role: "employee", deptId: null }
const staff = { id: STAFF, role: "employee", deptId: null }

function setBoss(id: string | null) {
  fake.db.tenants = [{ id: TENANT_ID, features: id ? { approval: { fallbackApproverEmpId: id } } : {} }]
}

beforeEach(() => {
  fake.reset()
  setBoss(BOSS.toUpperCase()) // 設定值大小寫不拘
  fake.db.employees = [
    { id: BOSS, tenant_id: TENANT_ID, user_id: "boss-user", role: "employee", dept_id: null },
    { id: STAFF, tenant_id: TENANT_ID, user_id: "staff-user", role: "employee", dept_id: null },
    { id: LEAD, tenant_id: TENANT_ID, user_id: "lead-user", role: "employee", dept_id: null },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: null, manager_emp_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [{ ...project, tenant_id: TENANT_ID }]
  fake.db.project_members = []
})

describe("canManageProject／loadProjectScope — 老闆本人有 finance（與 resolveProjectAccess 一致）", () => {
  it("老闆（角色只是一般員工、非成員）→ 讀（resolveProjectAccess）與寫（canManageProject／loadProjectScope）都 true", async () => {
    expect((await resolveProjectAccess(TENANT_ID, boss, project)).finance).toBe(true)
    expect(await canManageProject(TENANT_ID, boss, project)).toBe(true)
    const scope = await loadProjectScope(TENANT_ID, "boss-user", PROJECT)
    expect(scope).toMatchObject({ ok: true, finance: true })
  })

  it("一般員工（非成員、非主管）→ 讀寫都 false（不放寬其他角色）", async () => {
    expect((await resolveProjectAccess(TENANT_ID, staff, project)).finance).toBe(false)
    expect(await canManageProject(TENANT_ID, staff, project)).toBe(false)
    expect(await loadProjectScope(TENANT_ID, "staff-user", PROJECT)).toMatchObject({ ok: true, finance: false })
  })

  it("沒設定老闆的租戶 → 原本的老闆人選只是一般員工，沒有 finance", async () => {
    setBoss(null)
    expect(await canManageProject(TENANT_ID, boss, project)).toBe(false)
  })

  it("lead 仍有 finance（原規則不變）", async () => {
    expect(await canManageProject(TENANT_ID, { id: LEAD, role: "employee", deptId: null }, project)).toBe(true)
  })
})

describe("financeProjectIds — 老闆跟 HR／會計一樣是全部", () => {
  it("老闆 → null（全部）；一般員工 → 只有自己負責的（這裡是空集合）", async () => {
    expect(await financeProjectIds(TENANT_ID, boss)).toBeNull()
    expect(await financeProjectIds(TENANT_ID, staff)).toEqual(new Set())
  })
})
