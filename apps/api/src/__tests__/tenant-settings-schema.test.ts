import { describe, it, expect } from "vitest"
import { tenantSettingsSchema } from "../routes/tenant"

/**
 * 迴歸：features 裡每一個前端會存的鍵都必須在 zod 宣告，否則會被靜默 strip、
 * 前端顯示「已儲存」但 DB 沒有。2026-09-20 抓到 formParameters／attendanceModule 兩個。
 */
describe("tenant settings zod：前端會存的鍵不能被 strip", () => {
  it("formParameters 原樣保留", () => {
    const body = { features: { formParameters: { myDataRequiresApproval: false, editableFields: ["basic", "contact"], attachmentLimitKb: 500 } } }
    const r = tenantSettingsSchema.safeParse(body)
    expect(r.success).toBe(true)
    expect(r.success && r.data.features?.formParameters).toEqual(body.features.formParameters)
  })
  it("attendanceModule 原樣保留", () => {
    const body = { features: { attendanceModule: { activeYear: "2026", yearStatus: "published", workCalendar: "台灣行事曆", attendanceCutoffDay: 25, allowEmployeeDispute: true, enableAutoSettlement: false } } }
    const r = tenantSettingsSchema.safeParse(body)
    expect(r.success).toBe(true)
    expect(r.success && r.data.features?.attendanceModule).toEqual(body.features.attendanceModule)
  })
  it("值域：截止日 1–31、yearStatus 三值、年份四碼", () => {
    expect(tenantSettingsSchema.safeParse({ features: { attendanceModule: { attendanceCutoffDay: 32 } } }).success).toBe(false)
    expect(tenantSettingsSchema.safeParse({ features: { attendanceModule: { yearStatus: "open" } } }).success).toBe(false)
    expect(tenantSettingsSchema.safeParse({ features: { attendanceModule: { activeYear: "26" } } }).success).toBe(false)
  })
  it("roles.accountant（會計可用範圍）原樣保留；值域：sections 是字串陣列、tabs 是 分區 → 字串陣列", () => {
    const body = {
      features: {
        roles: {
          accountant: {
            sections: ["home", "finance", "payroll"],
            tabs: { finance: ["projects", "disbursements", "directory"], payroll: ["expenses", "advances"] },
          },
        },
      },
    }
    const r = tenantSettingsSchema.safeParse(body)
    expect(r.success).toBe(true)
    expect(r.success && r.data.features?.roles).toEqual(body.features.roles)
    // 只帶 sections 也可以（tabs 缺＝各區全部）
    expect(tenantSettingsSchema.safeParse({ features: { roles: { accountant: { sections: ["finance"] } } } }).success).toBe(true)
    expect(tenantSettingsSchema.safeParse({ features: { roles: { accountant: { sections: "finance" } } } }).success).toBe(false)
    expect(tenantSettingsSchema.safeParse({ features: { roles: { accountant: { tabs: { finance: "projects" } } } } }).success).toBe(false)
    expect(tenantSettingsSchema.safeParse({ features: { roles: { accountant: { sections: [""] } } } }).success).toBe(false)
  })
  it("★ 未宣告的鍵仍會被 strip（這是預期行為；新鍵要來這裡登記）", () => {
    const r = tenantSettingsSchema.safeParse({ features: { somethingNew: { a: 1 } } })
    expect(r.success).toBe(true)
    expect(r.success && "somethingNew" in (r.data.features ?? {})).toBe(false)
  })
})
