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
  expenseCategories,
  expenseClaims,
  expenseSettlements,
  tripAdvances,
  leaveRequests as leaveRequestsTable,
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

describe("expenseCategories table — nature 是本模組的關鍵欄位", () => {
  const cols = getTableColumns(expenseCategories)

  // 實報實銷非所得、不計投保薪資；定額補貼屬薪資所得、應計入投保薪資。
  // 設錯＝漏報薪資所得 ＋ 高薪低報。
  it("nature 必填且預設為 reimbursement（較保守的那一邊需明示改成 allowance）", () => {
    expect(cols.nature.notNull).toBe(true)
    expect(cols.nature.default).toBe("reimbursement")
  })

  it("requiresReceipt 預設為 true —— 省的是事前審核，不是憑證", () => {
    expect(cols.requiresReceipt.default).toBe(true)
  })

  it("crossCheckAttendance 預設 false，需逐類別明示開啟", () => {
    expect(cols.crossCheckAttendance.default).toBe(false)
  })
})

describe("expenseClaims table — 發生日與歸屬期分開", () => {
  const cols = getTableColumns(expenseClaims)

  // 上月的收據這月才交：歸屬期是本月，發生日仍是上月。
  // 發生日是「報銷 × 出勤交叉檢核」的比對鍵，混為一欄兩邊都會錯。
  it("incurredOn 與 period 是兩個欄位，且皆必填", () => {
    expect(cols.incurredOn.notNull).toBe(true)
    expect(cols.period.notNull).toBe(true)
  })

  // 類別的預設性質日後可能調整，已送出的單必須凍結當時的稅務認定。
  it("nature 在單上再存一份（不只靠 category 帶）", () => {
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["nature"]))
    expect(cols.nature.notNull).toBe(true)
  })

  it("status 預設 submitted —— 無簽核鏈，月結時一次轉 settled", () => {
    expect(cols.status.default).toBe("submitted")
  })
})

describe("expenseSettlements table — 月結批次", () => {
  const cols = getTableColumns(expenseSettlements)

  // 兩個合計分開存：在薪資引擎走不同路徑，混算即稅務錯誤。
  it("reimbursementTotal 與 allowanceTotal 分開存", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["reimbursementTotal", "allowanceTotal", "claimCount"]),
    )
  })

  it("status 預設 open，核銷後轉 settled 即鎖定該期", () => {
    expect(cols.status.default).toBe("open")
  })
})

describe("tripAdvances table — 出差預支（模組三第 2 條）", () => {
  const cols = getTableColumns(tripAdvances)

  // 客戶確認「放款」是核准後先撥一筆錢給同仁帶著去，回程再核銷沖抵。
  it("涵蓋整個生命週期：撥款、沖抵、差額處理", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "tripRequestId", "employeeId", "amount", "status",
        "payoutChannel", "paidAt", "paidByEmpId",
        "actualTotal", "balance", "balanceHandling", "recoveryPeriod",
        "settledAt", "settledByEmpId",
      ]),
    )
  })

  it("status 預設 requested —— 核准即開單，但尚未撥款", () => {
    expect(cols.status.notNull).toBe(true)
    expect(cols.status.default).toBe("requested")
  })

  // balance 於核銷當下凍結：綁定的報銷單日後若有異動，
  // 核銷時的結論不該跟著變。
  it("actualTotal / balance 可為 null（尚未核銷）", () => {
    expect(cols.actualTotal.notNull).toBe(false)
    expect(cols.balance.notNull).toBe(false)
  })

  it("amount 必填 —— 沒有金額的預支列沒有意義", () => {
    expect(cols.amount.notNull).toBe(true)
  })
})

describe("兩軌政策的接點（模組三第 1、2 條）", () => {
  const catCols = getTableColumns(expenseCategories)
  const claimCols = getTableColumns(expenseClaims)
  const reqCols = getTableColumns(leaveRequestsTable)

  // 沒有這一對欄位，出差費用可以拆成「日常」報銷繞過事前審核，
  // 第 2 條即形同虛設。
  it("類別可標記須綁已核准出差單，且預設為 false（日常軌）", () => {
    expect(catCols.requiresTripApproval.notNull).toBe(true)
    expect(catCols.requiresTripApproval.default).toBe(false)
  })

  it("報銷單可綁出差單", () => {
    expect(Object.keys(claimCols)).toEqual(expect.arrayContaining(["tripRequestId"]))
    expect(claimCols.tripRequestId.notNull).toBe(false)
  })

  it("出差申請單有範圍、預估、預支與回程報告四欄", () => {
    expect(Object.keys(reqCols)).toEqual(
      expect.arrayContaining(["tripScope", "estimatedCost", "advanceRequested", "tripReport"]),
    )
  })
})
