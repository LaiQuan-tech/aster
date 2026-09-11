import { describe, it, expect } from "vitest"
import { getTableColumns } from "drizzle-orm"
import {
  tenants,
  departments,
  employees,
  projects,
  projectMembers,
  projectShareAdjustments,
  projectDocuments,
  leaveRequests,
  announcements,
} from "../index"

describe("tenants table", () => {
  const cols = getTableColumns(tenants)

  it("has the expected columns", () => {
    expect(Object.keys(cols).sort()).toEqual(
      ["id", "name", "status", "branding", "features", "createdAt"].sort(),
    )
  })
})

describe("departments table", () => {
  const cols = getTableColumns(departments)

  it("has the expected columns", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "parentId",
        "name",
        "managerEmpId",
      ]),
    )
  })

  it("tenantId is not null", () => {
    expect(cols.tenantId.notNull).toBe(true)
  })
})

describe("projects table", () => {
  const cols = getTableColumns(projects)

  it("has the expected columns", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "name",
        "code",
        "description",
        "status",
        "deptId",
        "leadEmpId",
        "shareMode",
        "bonusPool",
      ]),
    )
  })

  it("tenantId is not null and shareMode defaults to pool_pct", () => {
    expect(cols.tenantId.notNull).toBe(true)
    expect(cols.shareMode.default).toBe("pool_pct")
  })
})

describe("projectMembers table", () => {
  const cols = getTableColumns(projectMembers)

  it("has the expected columns", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "projectId",
        "employeeId",
        "roleInProject",
        "sharePct",
        "shareAmount",
      ]),
    )
  })

  it("tenantId is not null", () => {
    expect(cols.tenantId.notNull).toBe(true)
  })
})

describe("projectShareAdjustments table", () => {
  const cols = getTableColumns(projectShareAdjustments)

  it("has the expected columns", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "projectId",
        "employeeId",
        "field",
        "oldValue",
        "newValue",
        "changedByEmpId",
      ]),
    )
  })
})

describe("projectDocuments table", () => {
  const cols = getTableColumns(projectDocuments)

  it("has the expected columns", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "projectId",
        "fileName",
        "storagePath",
        "sizeBytes",
        "contentType",
      ]),
    )
  })

  it("tenantId is not null", () => {
    expect(cols.tenantId.notNull).toBe(true)
  })
})

describe("employees table", () => {
  const cols = getTableColumns(employees)

  it("has the expected columns", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "userId",
        "empNo",
        "name",
        "deptId",
        "employmentType",
        "hireDate",
        "role",
        "status",
      ]),
    )
  })

  it("tenantId is not null", () => {
    expect(cols.tenantId.notNull).toBe(true)
  })
})

describe("leaveRequests table — 軟刪除欄位", () => {
  const cols = getTableColumns(leaveRequests)

  // 表單一旦建立即不實體刪除（見 schema/leave-requests.ts 的說明）：
  // 被駁回的申請是勞資爭議中雇主唯一的反證，硬刪等於證據滅失。
  it("有 deletedAt / deletedByEmpId / deleteReason 三個軟刪除欄位", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["deletedAt", "deletedByEmpId", "deleteReason"]),
    )
  })

  it("三個欄位皆可為 null（null = 未註銷）", () => {
    expect(cols.deletedAt.notNull).toBe(false)
    expect(cols.deletedByEmpId.notNull).toBe(false)
    expect(cols.deleteReason.notNull).toBe(false)
  })

  it("status 仍為請求層級狀態機，與註銷狀態互不干擾", () => {
    expect(cols.status.notNull).toBe(true)
    expect(cols.status.default).toBe("pending")
  })
})

describe("announcements table — 軟刪除欄位", () => {
  const cols = getTableColumns(announcements)

  // 公告與規章是勞資爭議證據，客戶要求保留 5~7 年追溯期（模組二第 2 條）。
  it("有 deletedAt / deletedByEmpId / deleteReason 三個軟刪除欄位", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["deletedAt", "deletedByEmpId", "deleteReason"]),
    )
  })

  it("三個欄位皆可為 null（null = 未註銷）", () => {
    expect(cols.deletedAt.notNull).toBe(false)
    expect(cols.deletedByEmpId.notNull).toBe(false)
    expect(cols.deleteReason.notNull).toBe(false)
  })
})
