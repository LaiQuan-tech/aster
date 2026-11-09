import { describe, expect, it } from "vitest"
import {
  absoluteAppUrl,
  notificationLink,
  notificationLinkOrFallback,
  notificationNeedsAction,
  NOTIFICATIONS_FALLBACK_PATH,
} from "../notification-link.js"

const n = (type: string, payload: Record<string, unknown> | null) => ({ type, payload })

describe("notificationLink — 每種 type × 收件角色", () => {
  it("approval 申請單：簽核人 → ESS 待我簽核 ?id=；HR 覆核關 → 後台 ?status=pending&id=；申請人 → 我的申請 ?id=", () => {
    for (const event of ["submitted", "advanced", "reassigned", "reminded"]) {
      expect(notificationLink(n("approval", { requestId: "r1", event }))).toBe("/ess/approvals?id=r1")
      expect(notificationLink(n("approval", { requestId: "r1", event, stepKind: "hr" }))).toBe("/admin/approvals?status=pending&id=r1")
      expect(notificationLink(n("approval", { requestId: "r1", event, recipientRole: "hr" }))).toBe("/admin/approvals?status=pending&id=r1")
    }
    expect(notificationLink(n("approval", { requestId: "r1", event: "submitted", stepKind: "fallback" }))).toBe("/ess/approvals?id=r1")
    expect(notificationLink(n("approval", { requestId: "r1", event: "submitted", stepKind: "hr_admin" }))).toBe("/admin/approvals?status=pending&id=r1")
    // 會計沒有後台簽核頁權限 → ESS
    expect(notificationLink(n("approval", { requestId: "r1", event: "submitted", stepKind: "accountant" }))).toBe("/ess/approvals?id=r1")
    expect(notificationLink(n("approval", { event: "submitted" }))).toBe("/ess/approvals")
    expect(notificationLink(n("approval", { requestId: "r1", event: "approved" }))).toBe("/ess/requests?id=r1")
    expect(notificationLink(n("approval", { requestId: "r1", event: "rejected" }))).toBe("/ess/requests?id=r1")
    expect(notificationLink(n("approval", { event: "approved" }))).toBe("/ess/requests")
    expect(notificationLink(n("approval", { requestId: "r1" }))).toBeNull()
    expect(notificationLink(n("approval", { requestId: "r1", event: "cancelled" }))).toBeNull()
  })

  it("approval 放款單（沒有 requestId，用 disbursementId）：簽核人 → /ess/approvals?id=；建單 HR → 後台放款單", () => {
    for (const event of ["submitted", "advanced", "approver_changed"]) {
      expect(notificationLink(n("approval", { kind: "disbursement", disbursementId: "d1", event }))).toBe("/ess/approvals?id=d1")
    }
    for (const event of ["approved", "rejected", "withdrawn"]) {
      expect(notificationLink(n("approval", { kind: "disbursement", disbursementId: "d1", event }))).toBe("/admin/disbursements/d1")
    }
    expect(notificationLink(n("approval", { kind: "disbursement", event: "approved" }))).toBe("/admin/disbursements")
  })

  it("disbursement（已放款給專案負責人）→ ESS 專案頁", () => {
    expect(notificationLink(n("disbursement", { disbursementId: "d1", projectId: "p1" }))).toBe("/ess/projects/p1")
    expect(notificationLink(n("disbursement", { disbursementId: "d1" }))).toBe("/ess/projects")
  })

  it("attendance_sheet：主管 → ESS 月表；HR → 後台月表；本人 → ESS 月表；缺 sheetId → null", () => {
    expect(notificationLink(n("attendance_sheet", { sheetId: "s1", action: "submitted", recipientRole: "manager" }))).toBe("/ess/attendance-sheet/s1")
    expect(notificationLink(n("attendance_sheet", { sheetId: "s1", action: "manager_reviewed", recipientRole: "hr" }))).toBe("/admin/attendance-sheets/s1")
    expect(notificationLink(n("attendance_sheet", { sheetId: "s1", action: "manager_reviewed" }))).toBe("/admin/attendance-sheets/s1")
    expect(notificationLink(n("attendance_sheet", { sheetId: "s1", action: "beyond_cap_settlement" }))).toBe("/admin/attendance-sheets/s1")
    for (const action of ["approved", "returned", "reopened", "locked"]) {
      expect(notificationLink(n("attendance_sheet", { sheetId: "s1", action, recipientRole: "employee" }))).toBe("/ess/attendance-sheet/s1")
    }
    expect(notificationLink(n("attendance_sheet", { period: "2026-08" }))).toBeNull()
  })

  it("anomaly：本人 → 自己的打卡頁；合規預警 HR → 後台打卡紀錄，非 HR 主管 → null（沒有可看別人打卡的 ESS 頁）", () => {
    expect(notificationLink(n("anomaly", { anomalyType: "consecutive_late", from: "2026-09-01", to: "2026-09-15" }))).toBe(
      "/ess/punches?from=2026-09-01&to=2026-09-15",
    )
    const compliance = { anomalyType: "seven_day_rule", from: "2026-09-01", to: "2026-09-30", subjectEmployeeId: "e1" }
    expect(notificationLink(n("anomaly", { ...compliance, recipientRole: "hr" }))).toBe("/admin/punch-records?from=2026-09-01&to=2026-09-30")
    expect(notificationLink(n("anomaly", compliance))).toBeNull()
    expect(notificationLink(n("anomaly", { ...compliance, recipientRole: "manager" }))).toBeNull()
  })

  it("其餘類型", () => {
    expect(notificationLink(n("missing_punch", { date: "2026-09-16" }))).toBe("/ess/requests?kind=fix_punch&date=2026-09-16")
    expect(notificationLink(n("late_report", { lateReportId: "x" }))).toBe("/ess/approvals")
    expect(notificationLink(n("bonus_run", { bonusRunId: "b1", event: "submitted" }))).toBe("/ess/approvals")
    expect(notificationLink(n("bonus_run", { bonusRunId: "b1", event: "approved" }))).toBe("/admin/bonus-runs/b1")
    expect(notificationLink(n("bonus_run", { bonusRunId: "a/b?c", event: "approved" }))).toBe("/admin/bonus-runs/a%2Fb%3Fc")
    expect(notificationLink(n("profile_change_request", { changeRequestId: "c1" }))).toBe("/admin/employees")
    expect(notificationLink(n("profile_change_reviewed", { changeRequestId: "c1", status: "approved" }))).toBe("/ess/mydata")
    for (const t of ["calendar_import_draft", "calendar_import_revision", "calendar_import_fetch_failed"]) {
      expect(notificationLink(n(t, { year: 2027 }))).toBe("/admin/calendar")
    }
    expect(notificationLink(n("payroll_period", { event: "reopened", period: "2026-10" }))).toBe("/admin/payroll")
    expect(notificationLink(n("overtime_unapproved_punch", { employeeId: "e1" }))).toBe("/ess/approvals")
    expect(notificationLink(n("announcement", {}))).toBe("/ess/announcements")
    expect(notificationLink(n("vehicle_booking_cancelled", {}))).toBe("/ess/vehicles")
    expect(notificationLink(n("report", { x: 1 }))).toBeNull()
    expect(notificationLink(n("approval", null))).toBeNull()
  })

  it("id 會做 URL 編碼", () => {
    expect(notificationLink(n("approval", { requestId: "a b/c", event: "submitted" }))).toBe("/ess/approvals?id=a%20b%2Fc")
    expect(notificationLink(n("approval", { requestId: "a b/c", event: "approved" }))).toBe("/ess/requests?id=a%20b%2Fc")
  })
})

describe("notificationNeedsAction／fallback／absoluteAppUrl", () => {
  it("待辦類（輪到你簽、月表待審…）→ true；結果通知 → false", () => {
    expect(notificationNeedsAction(n("approval", { event: "submitted" }))).toBe(true)
    expect(notificationNeedsAction(n("approval", { event: "approved" }))).toBe(false)
    expect(notificationNeedsAction(n("attendance_sheet", { action: "submitted" }))).toBe(true)
    expect(notificationNeedsAction(n("attendance_sheet", { action: "approved" }))).toBe(false)
    expect(notificationNeedsAction(n("disbursement", {}))).toBe(false)
    expect(notificationNeedsAction(n("missing_punch", null))).toBe(true)
  })

  it("沒有連結 → 通知中心", () => {
    expect(notificationLinkOrFallback(n("report", {}))).toBe(NOTIFICATIONS_FALLBACK_PATH)
    expect(notificationLinkOrFallback(n("approval", null))).toBe("/ess/notifications")
    expect(notificationLinkOrFallback(n("late_report", {}))).toBe("/ess/approvals")
  })

  it("absoluteAppUrl 去掉 base 結尾斜線", () => {
    expect(absoluteAppUrl("https://hr.example.com/", "/ess/approvals?id=1")).toBe("https://hr.example.com/ess/approvals?id=1")
    expect(absoluteAppUrl("https://hr.example.com", "ess")).toBe("https://hr.example.com/ess")
  })
})
