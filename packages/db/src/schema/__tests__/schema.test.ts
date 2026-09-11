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
  auditLogs,
  announcementVersions,
  announcementSignatureSheets,
  announcementAcknowledgements,
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

describe("auditLogs table — 稽核軌跡", () => {
  const cols = getTableColumns(auditLogs)

  it("有整列快照與雙來源欄位", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "tenantId", "tableName", "recordId", "action",
        "oldRow", "newRow", "actorEmpId", "dbUser", "context", "at",
      ]),
    )
  })

  // 稽核紀錄必須在被稽核的對象消失後存活：員工離職刪帳號、租戶終止，
  // 其歷史異動不該跟著消失——那正是稽核要防的情況。
  it("tenantId 與 actorEmpId 刻意無 FK，且可為 null", () => {
    expect(cols.tenantId.notNull).toBe(false)
    expect(cols.actorEmpId.notNull).toBe(false)
  })

  it("tableName 與 action 為必填（沒有這兩欄的稽核列沒有意義）", () => {
    expect(cols.tableName.notNull).toBe(true)
    expect(cols.action.notNull).toBe(true)
  })
})

describe("announcementVersions table — 內容版本鏈", () => {
  const cols = getTableColumns(announcementVersions)

  it("有版號、兩種進版觸發、生效期間與不利益變更旗標", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "announcementId", "versionNo", "title", "body", "audience",
        "changeType", "changeNote", "effectiveFrom", "effectiveTo",
        "requiresSignature", "isAdverseChange", "contentHash",
      ]),
    )
  })

  // 客戶原文「當條款跨年度或有增修時」＝兩種觸發，預設值為首版。
  it("changeType 預設 initial，版號必填", () => {
    expect(cols.changeType.default).toBe("initial")
    expect(cols.versionNo.notNull).toBe(true)
  })

  it("effectiveTo 可為 null（null = 仍生效）", () => {
    expect(cols.effectiveTo.notNull).toBe(false)
  })

  it("requiresSignature 與 isAdverseChange 預設皆為 false", () => {
    expect(cols.requiresSignature.default).toBe(false)
    expect(cols.isAdverseChange.default).toBe(false)
  })
})

describe("announcementSignatureSheets table — 掃描檔快照", () => {
  const cols = getTableColumns(announcementSignatureSheets)

  // 補簽產生新的 sheetNo，不覆蓋舊檔、也不動 announcementVersions。
  it("以 versionId + sheetNo 標定，帶 storagePath 與 contentHash", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "versionId", "sheetNo", "fileName", "storagePath", "contentHash", "note",
      ]),
    )
    expect(cols.sheetNo.notNull).toBe(true)
  })
})

describe("announcementAcknowledgements table — 逐人簽收", () => {
  const cols = getTableColumns(announcementAcknowledgements)

  // viewedAt 滿足施行細則 §37 的「已發給」；signedAt 是紙本實際簽署日，
  // 不可從掃描檔推斷（傳閱單頂上是公告日期，不是補簽日期）。
  it("三個時間戳分開：viewedAt / signedAt / createdAt", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["viewedAt", "signedAt", "createdAt"]),
    )
    expect(cols.viewedAt.notNull).toBe(false)
    expect(cols.signedAt.notNull).toBe(false)
  })

  // 在職員工「同意變更」與新人「到職接受」法律性質不同，同意率不可混算。
  it("kind 區分兩種簽名性質，預設 consent_to_change", () => {
    expect(cols.kind.notNull).toBe(true)
    expect(cols.kind.default).toBe("consent_to_change")
  })

  it("signatureSheetId 可為 null（先建待簽項、之後補掃描檔）", () => {
    expect(cols.signatureSheetId.notNull).toBe(false)
  })
})
