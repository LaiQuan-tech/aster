import { describe, it, expect } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/pg-core"
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
  advances,
  expenseSettings,
  projectSettings,
  contracts,
  projectBillings,
  leaveRequests as leaveRequestsTable,
  leaveBalances,
  disbursements,
  projectSubcontractPayments,
  payslips,
  overtimeSettlements,
  festivalBonuses,
  birthdayGifts,
  dutyRosters,
  employeeProfileChangeRequests,
  disbursementApprovalSteps,
} from "../index"

/** 某表某 unique index 的欄位名（找不到回 null）。 */
function uniqueIndexColumns(table: Parameters<typeof getTableConfig>[0], name: string): string[] | null {
  const idx = getTableConfig(table).indexes.find((i) => i.config.name === name)
  if (!idx || !idx.config.unique) return null
  return idx.config.columns.map((c) => (c as { name: string }).name)
}

describe("tenants table", () => {
  const cols = getTableColumns(tenants)

  it("has the expected columns", () => {
    expect(Object.keys(cols).sort()).toEqual(
      ["id", "name", "status", "branding", "features", "timezone", "createdAt"].sort(),
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
        // 模組四第 1 條：歸屬年度與編號分開。
        "fiscalYear",
      ]),
    )
  })

  it("tenantId is not null and shareMode defaults to pool_pct", () => {
    expect(cols.tenantId.notNull).toBe(true)
    expect(cols.shareMode.default).toBe("pool_pct")
  })

  // 編號唯一性是 DB 的事，不是應用層的事：兩人同時建案時各自查都說沒重複。
  it("(tenant_id, code) 有 unique index，撞號由 DB 擋下", () => {
    const idx = getTableConfig(projects).indexes.find(
      (i) => i.config.name === "projects_tenant_code_uq",
    )
    expect(idx).toBeDefined()
    expect(idx!.config.unique).toBe(true)
    expect(idx!.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      "tenant_id",
      "code",
    ])
  })

  // 舊資料沒有編號；Postgres 的 unique index 視 NULL 互不相等，所以可空欄位
  // 不會讓多筆舊資料互撞。新建一律由 API 產號。
  it("code 與 fiscalYear 皆可空（相容既有資料）", () => {
    expect(cols.code.notNull).toBe(false)
    expect(cols.fiscalYear.notNull).toBe(false)
  })

  // 模組四第 2 條：案情（status）與可見性（archivedAt）是兩軸。
  // 混成一欄的話，封存一個已解約的案子就得覆寫 terminated，
  // 「這案子是解約收場」就沒了。
  it("案情與封存是分開的兩欄", () => {
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["status", "archivedAt"]))
    expect(cols.status.notNull).toBe(true)
    expect(cols.status.default).toBe("active")
    expect(cols.archivedAt.notNull).toBe(false)
  })

  // 解約通知書上的日期可能早於輸入日，而解約日決定請款範圍與獎金結算基準。
  it("狀態的法律生效日與輸入時點是分開的兩欄", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "statusReason",
        "statusEffectiveOn",
        "statusChangedAt",
        "statusChangedByEmpId",
      ]),
    )
    expect(cols.statusEffectiveOn.columnType).toBe("PgDateString")
    expect(cols.statusChangedAt.columnType).toBe("PgTimestamp")
  })

  // 有人特地把案子拉回來（多半在追尾款），排程當晚又收起來，功能等於壞的。
  it("記得人工解除封存的時點，自動封存才知道要放過", () => {
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["unarchivedAt"]))
    expect(cols.unarchivedAt.notNull).toBe(false)
  })
})

describe("projectSettings table", () => {
  const cols = getTableColumns(projectSettings)

  it("有自動封存的兩個參數", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["tenantId", "autoArchiveEnabled", "autoArchiveMonths"]),
    )
  })

  it("預設開啟、6 個月", () => {
    expect(cols.autoArchiveEnabled.default).toBe(true)
    expect(cols.autoArchiveMonths.default).toBe(6)
  })

  it("一租戶一列", () => {
    const idx = getTableConfig(projectSettings).indexes.find(
      (i) => i.config.name === "project_settings_tenant_uq",
    )
    expect(idx).toBeDefined()
    expect(idx!.config.unique).toBe(true)
  })

  // 模組四第 3 條：清單回溯 7 年，不是客戶原文的 5 年。
  it("印花稅預設：千分之一、回溯 7 年", () => {
    expect(cols.stampDutyRate.default).toBe("0.001")
    expect(cols.stampDutyLookbackYears.default).toBe(7)
  })
})

describe("contracts table", () => {
  const cols = getTableColumns(contracts)

  it("有文件類型與我方角色——兩者一起決定課不課印花稅", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["docType", "ourRole", "amount", "signedOn", "copies"]),
    )
    expect(cols.ourRole.default).toBe("contractor")
    expect(cols.copies.default).toBe(1)
  })

  // 清單要回溯 5~7 年：2021 年簽的約要用 2021 年的費率，不是今天的。
  it("費率與稅額凍結在列上", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["stampDutyRate", "stampDutyAmount", "stampDutyPaidOn"]),
    )
  })

  it("版本鏈：改版新增一列指回舊列，不就地覆寫", () => {
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["version", "supersedesId"]))
    expect(cols.version.default).toBe(1)
  })

  // 已貼花的合約被刪掉，等於把「這筆稅貼過了」的證據一起刪掉，
  // 而印花稅核課期間最長 7 年。
  it("軟刪除欄位齊全（金額憑證不實體刪除）", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["deletedAt", "deletedByEmpId", "deleteReason"]),
    )
  })
})

describe("projectBillings table", () => {
  const cols = getTableColumns(projectBillings)

  // 業主說「這期就開我 180 萬」不管百分比。存成同一欄就再也算不回來。
  it("系統試算與人工覆寫分開存", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["calculatedAmount", "overrideAmount", "overrideReason"]),
    )
  })

  // 尾差不能悄悄併進金額裡，否則使用者會以為系統算錯。
  it("尾差單獨一欄，供 UI 明示", () => {
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["residueApplied"]))
  })

  // 已請款的期別不再隨追加減重算——帳已經出去了。
  it("已請款事件是凍結的觸發點", () => {
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["billedOn", "billedAmount"]))
  })

  /**
   * ⚠️ 必須是 partial index。把 deletedAt 當索引欄位是錯的：Postgres 視
   * NULL 互不相等，兩筆 deleted_at IS NULL 的列反而不會相撞。
   */
  it("期別編號在未刪除的列之間唯一（partial unique index）", () => {
    const idx = getTableConfig(projectBillings).indexes.find(
      (i) => i.config.name === "project_billings_no_uq",
    )
    expect(idx).toBeDefined()
    expect(idx!.config.unique).toBe(true)
    expect(idx!.config.where).toBeDefined()
    expect(idx!.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      "tenant_id",
      "project_id",
      "installment_no",
    ])
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

describe("advances table — 員工預支（模組三第 2、3 條）", () => {
  const cols = getTableColumns(advances)

  // 出差預支與零用金預支合併成一張表：未核銷預支是離職扣回的依據，
  // 分兩張表則離職結算要查兩處，一定有人漏查，而漏查的那筆就是收不回來的錢。
  it("涵蓋整個生命週期：撥款、沖抵、差額處理", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "kind", "requestId", "employeeId", "amount", "status",
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

  it("kind 預設 trip，零用金需明示 petty_cash", () => {
    expect(cols.kind.notNull).toBe(true)
    expect(cols.kind.default).toBe("trip")
  })
})

describe("expenseSettings table — 門檻做成參數，不寫死", () => {
  const cols = getTableColumns(expenseSettings)

  // 使用者裁示：低於門檻標示但不擋，由簽核者判斷。
  it("預支門檻預設 5000、逾期天數預設 30", () => {
    expect(cols.advanceThreshold.default).toBe("5000")
    expect(cols.advanceOverdueDays.default).toBe(30)
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

  // 兩欄職責不同：tripRequestId 是「屬於哪趟出差」（閘門＋歸屬），
  // advanceId 是「用哪筆預支的錢付的」（沖抵）。零用金沒有出差單可反推。
  it("報銷單可綁出差單，也可綁預支", () => {
    expect(Object.keys(claimCols)).toEqual(
      expect.arrayContaining(["tripRequestId", "advanceId"]),
    )
    expect(claimCols.tripRequestId.notNull).toBe(false)
    expect(claimCols.advanceId.notNull).toBe(false)
  })

  it("出差申請單有範圍、預估、預支與回程報告四欄", () => {
    expect(Object.keys(reqCols)).toEqual(
      expect.arrayContaining(["tripScope", "estimatedCost", "advanceRequested", "tripReport"]),
    )
  })
})

/* ───────────────────────── 2026-09-23 需求補齊（migration 0050）───────────────────────── */

describe("leaveBalances table — 特休桶改期間制（W1）", () => {
  const cols = getTableColumns(leaveBalances)

  // 曆年制 → 到職日週年制：期間由 period_start／period_end 表示；year 保留給舊讀點。
  it("有 periodStart／periodEnd／source／note 四欄；期間 NOT NULL、source 預設 manual", () => {
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["periodStart", "periodEnd", "source", "note", "year"]))
    expect(cols.periodStart.notNull).toBe(true)
    expect(cols.periodEnd.notNull).toBe(true)
    expect(cols.periodStart.columnType).toBe("PgDateString")
    expect(cols.source.default).toBe("manual")
    expect(cols.note.notNull).toBe(false)
  })

  // 舊唯一鍵以 year 為準，同一人同假別一年只能一桶；週年期跨年，改以 period_start 為準。
  it("唯一鍵改為 (tenant_id, employee_id, leave_type_id, period_start)，舊的 year 唯一鍵已移除", () => {
    expect(uniqueIndexColumns(leaveBalances, "leave_balances_tenant_emp_type_period_uq")).toEqual([
      "tenant_id",
      "employee_id",
      "leave_type_id",
      "period_start",
    ])
    expect(uniqueIndexColumns(leaveBalances, "leave_balances_tenant_emp_type_year_uq")).toBeNull()
  })
})

describe("leaveRequests／disbursements／payslips／project_subcontract_payments — 加欄（M1／M4／M3／M5）", () => {
  it("leave_requests：beyondCap 預設 false、beyondCapDetail 可空", () => {
    const cols = getTableColumns(leaveRequestsTable)
    expect(cols.beyondCap.notNull).toBe(true)
    expect(cols.beyondCap.default).toBe(false)
    expect(cols.beyondCapDetail.notNull).toBe(false)
  })

  // 放款簽核鏈：送簽輪次從 0 起算（從未送簽），待簽關卡可空。
  it("disbursements：簽核五欄；approvalRound 預設 0、currentStep 可空", () => {
    const cols = getTableColumns(disbursements)
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["currentStep", "approvalRound", "submittedAt", "submittedByEmpId", "approvedAt"]),
    )
    expect(cols.approvalRound.notNull).toBe(true)
    expect(cols.approvalRound.default).toBe(0)
    expect(cols.currentStep.notNull).toBe(false)
  })

  it("payslips：sentAt／sentTo 可空（null＝未寄送）", () => {
    const cols = getTableColumns(payslips)
    expect(cols.sentAt.notNull).toBe(false)
    expect(cols.sentTo.notNull).toBe(false)
  })

  it("project_subcontract_payments：驗收三欄可空（null＝未驗收）", () => {
    const cols = getTableColumns(projectSubcontractPayments)
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(["acceptedOn", "acceptedByEmpId", "acceptanceNote"]))
    expect(cols.acceptedOn.notNull).toBe(false)
    expect(cols.acceptedOn.columnType).toBe("PgDateString")
  })

  it("project_settings：defaultSharePctByRole 預設 {}", () => {
    const cols = getTableColumns(projectSettings)
    expect(cols.defaultSharePctByRole.notNull).toBe(true)
    expect(cols.defaultSharePctByRole.default).toEqual({})
  })
})

describe("overtimeSettlements table — 加班超額另計（M1）", () => {
  const cols = getTableColumns(overtimeSettlements)

  it("欄位齊全；source 預設 beyond_cap、channel 預設 cash、status 預設 draft、minutes 預設 0", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "tenantId", "employeeId", "period", "source", "minutes", "amount", "channel", "status",
        "paidOn", "sheetId", "note", "createdByEmpId", "paidByEmpId", "createdAt", "updatedAt",
      ]),
    )
    expect(cols.source.default).toBe("beyond_cap")
    expect(cols.channel.default).toBe("cash")
    expect(cols.status.default).toBe("draft")
    expect(cols.minutes.default).toBe(0)
    expect(cols.amount.notNull).toBe(false)
  })

  // 每人每月只有一列「自動產生」的超額列；HR 手動補的列不受限——所以必須是 partial unique。
  it("(tenant_id, employee_id, period) partial unique（where source = 'beyond_cap'）＋ (tenant_id, period) index", () => {
    const uq = getTableConfig(overtimeSettlements).indexes.find((i) => i.config.name === "overtime_settlements_beyond_cap_uq")
    expect(uq).toBeDefined()
    expect(uq!.config.unique).toBe(true)
    expect(uq!.config.where).toBeDefined()
    expect(uq!.config.columns.map((c) => (c as { name: string }).name)).toEqual(["tenant_id", "employee_id", "period"])
    const idx = getTableConfig(overtimeSettlements).indexes.find((i) => i.config.name === "overtime_settlements_tenant_period_idx")
    expect(idx).toBeDefined()
    expect(idx!.config.unique).toBe(false)
  })
})

describe("festivalBonuses table — 三節獎金（M6）", () => {
  const cols = getTableColumns(festivalBonuses)

  it("欄位齊全；status 預設 draft；一人一節一年一列", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "tenantId", "employeeId", "festival", "year", "referenceDate", "suggestedAmount",
        "prorateMonths", "finalAmount", "status", "paidOn", "note", "createdByEmpId", "paidByEmpId",
      ]),
    )
    expect(cols.status.default).toBe("draft")
    expect(cols.festival.notNull).toBe(true)
    expect(cols.year.notNull).toBe(true)
    expect(uniqueIndexColumns(festivalBonuses, "festival_bonuses_tenant_emp_festival_year_uq")).toEqual([
      "tenant_id", "employee_id", "festival", "year",
    ])
  })
})

describe("birthdayGifts table — 生日紅包（M7）", () => {
  const cols = getTableColumns(birthdayGifts)

  it("欄位齊全（含照片路徑）；一人一年一列", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["tenantId", "employeeId", "year", "givenOn", "amount", "photoPath", "photoFileName", "note", "createdByEmpId"]),
    )
    expect(cols.photoPath.notNull).toBe(false)
    expect(uniqueIndexColumns(birthdayGifts, "birthday_gifts_tenant_emp_year_uq")).toEqual(["tenant_id", "employee_id", "year"])
  })
})

describe("dutyRosters table — 值日／總機輪播（M8）", () => {
  const cols = getTableColumns(dutyRosters)

  // 一天一職務一人；重新產生會刪該區間再插入（batch_id 標同批），所以本表不掛 no_hard_delete。
  it("欄位齊全；(tenant_id, duty_type, work_date) unique ＋ (tenant_id, work_date) index；沒有 updated_at", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["tenantId", "dutyType", "workDate", "employeeId", "batchId", "note", "createdByEmpId", "createdAt"]),
    )
    expect(Object.keys(cols)).not.toContain("updatedAt")
    expect(cols.dutyType.notNull).toBe(true)
    expect(cols.workDate.columnType).toBe("PgDateString")
    expect(uniqueIndexColumns(dutyRosters, "duty_rosters_tenant_type_date_uq")).toEqual(["tenant_id", "duty_type", "work_date"])
    const idx = getTableConfig(dutyRosters).indexes.find((i) => i.config.name === "duty_rosters_tenant_date_idx")
    expect(idx).toBeDefined()
  })
})

describe("employeeProfileChangeRequests table — 員工改資料審核（W6）", () => {
  const cols = getTableColumns(employeeProfileChangeRequests)

  it("changes jsonb 預設 {}、status 預設 pending、審核三欄可空；(tenant_id, status) index", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining(["tenantId", "employeeId", "requestedByEmpId", "changes", "status", "reviewedByEmpId", "reviewedAt", "reviewComment"]),
    )
    expect(cols.changes.notNull).toBe(true)
    expect(cols.changes.default).toEqual({})
    expect(cols.status.default).toBe("pending")
    expect(cols.reviewedAt.notNull).toBe(false)
    const idx = getTableConfig(employeeProfileChangeRequests).indexes.find(
      (i) => i.config.name === "employee_profile_change_requests_tenant_status_idx",
    )
    expect(idx).toBeDefined()
  })
})

describe("disbursementApprovalSteps table — 放款簽核關卡（M4）", () => {
  const cols = getTableColumns(disbursementApprovalSteps)

  // 與假單 approval_steps 分表：那張的 request_id NOT NULL FK 到 leave_requests。
  it("欄位比照 approval_steps（approverEmpId NOT NULL、candidateEmpIds／stepKind、decision 預設 pending）＋ round 預設 1", () => {
    expect(Object.keys(cols)).toEqual(
      expect.arrayContaining([
        "tenantId", "disbursementId", "round", "stepOrder", "approverEmpId", "candidateEmpIds",
        "stepKind", "decision", "comment", "actedAt", "actedByEmpId", "createdAt",
      ]),
    )
    expect(cols.approverEmpId.notNull).toBe(true)
    expect(cols.disbursementId.notNull).toBe(true)
    expect(cols.round.default).toBe(1)
    expect(cols.decision.default).toBe("pending")
    expect(cols.candidateEmpIds.notNull).toBe(false)
  })

  // 一張放款單可送簽多輪（駁回 → 改 → 再送），舊輪關卡保留作軌跡。
  it("(disbursement_id, round, step_order) unique ＋ (tenant_id, disbursement_id) index", () => {
    expect(uniqueIndexColumns(disbursementApprovalSteps, "disbursement_approval_steps_disb_round_step_uq")).toEqual([
      "disbursement_id", "round", "step_order",
    ])
    const idx = getTableConfig(disbursementApprovalSteps).indexes.find(
      (i) => i.config.name === "disbursement_approval_steps_tenant_disb_idx",
    )
    expect(idx).toBeDefined()
  })
})
