/**
 * 通知 → 站內頁面路徑（2026-11-09 起 API 寄信／LINE 與 web 通知列表共用同一份）。
 *
 * - web：`apps/web/src/lib/ess-notifications.ts` 轉出口（通知列表「整列可點→導頁」）。
 * - api：`services/notification-delivery.ts` 組 Email／LINE 的「前往處理：<完整網址>」。
 *
 * 純函式、零相依（web 直接 import 原始碼，api 走 @hr/rules 的 dist），全部有單元測試
 * （packages/rules/src/__tests__/notification-link.test.ts）。
 *
 * 收件角色：同一種通知可能寄給不同角色（例：出勤月表送審給主管、主管審完給 HR），
 * 產生點在 payload 帶 `recipientRole`（或由 event／action 推得），決定要去 ESS 還是後台。
 * 未登入時 AuthGate 會把完整路徑（含 query）帶進 `/login?next=`，登入後回到這裡。
 */

export interface NotificationLinkInput {
  type: string
  payload?: Record<string, unknown> | null
}

/** 沒有可用連結時，Email／LINE 退回的頁面（通知中心）。 */
export const NOTIFICATIONS_FALLBACK_PATH = "/ess/notifications"

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

/** 簽核人收到的事件（輪到你簽）。 */
const APPROVER_EVENTS = new Set(["submitted", "advanced", "reassigned", "reminded", "approver_changed"])

/** 申請單簽核連結：HR 覆核關（有後台權限）→ 後台簽核頁；其餘簽核人 → ESS 待我簽核。 */
function requestApproverLink(payload: Record<string, unknown>): string {
  const requestId = str(payload.requestId)
  // accountant（會計）預設導覽沒有「假單與簽核」，後台簽核頁進不去 → 仍走 ESS。
  const stepKind = str(payload.stepKind)
  const hr = str(payload.recipientRole) === "hr" || stepKind === "hr" || stepKind === "hr_admin"
  if (hr) {
    return requestId ? `/admin/approvals?status=pending&id=${enc(requestId)}` : "/admin/approvals?status=pending"
  }
  return requestId ? `/ess/approvals?id=${enc(requestId)}` : "/ess/approvals"
}

/**
 * 通知點下去要去哪一頁；回 null 代表沒有對應頁（站內只展開內文，Email 退回通知中心）。
 *
 *   approval（申請單）submitted／advanced／reassigned／reminded → `/ess/approvals?id=<requestId>`
 *                       （HR 覆核關 stepKind='hr' 或 recipientRole='hr' → `/admin/approvals?status=pending&id=<requestId>`）
 *   approval（申請單）approved／rejected → `/ess/requests?id=<requestId>`（缺 requestId 退回列表）
 *   approval（放款單，payload.kind='disbursement'）待簽 → `/ess/approvals?id=<disbursementId>`；
 *                       核准／駁回／撤回（給建單 HR）→ `/admin/disbursements/<disbursementId>`
 *   disbursement        → `/ess/projects/<projectId>`（已放款通知專案負責人）
 *   missing_punch       → `/ess/requests?kind=fix_punch&date=<date>`
 *   attendance_sheet    → 主管（submitted）`/ess/attendance-sheet/<sheetId>`；HR（manager_reviewed／beyond_cap_settlement）
 *                         `/admin/attendance-sheets/<sheetId>`；本人（approved／returned／reopened／locked）`/ess/attendance-sheet/<sheetId>`
 *   anomaly             → 本人 `/ess/punches?from&to`；合規預警（subjectEmployeeId）recipientRole='hr' → `/admin/punch-records`，其他（含舊資料缺 recipientRole）→ null
 *   late_report         → `/ess/approvals`
 *   bonus_run           → 送審給老闆 `/ess/approvals`；核准／退回給 HR `/admin/bonus-runs/<id>`
 *   announcement        → `/ess/announcements`
 *   vehicle_*           → 公務車頁（見下方）
 *   profile_change_request  → `/admin/employees`（HR 審核資料異動）
 *   profile_change_reviewed → `/ess/mydata`
 *   calendar_import_*   → `/admin/calendar`
 *   payroll_period      → `/admin/payroll?period=YYYY-MM`（月結發薪頁；沒有月份＝`/admin/payroll`）
 *   overtime_unapproved_punch → `/ess/approvals`（主管：請同仁補送加班單後在這裡核准）
 *   其他類型／缺 payload → null
 */
export function notificationLink(n: NotificationLinkInput): string | null {
  const payload = n.payload
  if (!payload || typeof payload !== "object") return null
  const role = str(payload.recipientRole)

  switch (n.type) {
    case "approval": {
      const event = str(payload.event)
      if (str(payload.kind) === "disbursement") {
        const id = str(payload.disbursementId)
        if (event && APPROVER_EVENTS.has(event)) return id ? `/ess/approvals?id=${enc(id)}` : "/ess/approvals"
        if (event === "approved" || event === "rejected" || event === "withdrawn") {
          return id ? `/admin/disbursements/${enc(id)}` : "/admin/disbursements"
        }
        return null
      }
      if (event && APPROVER_EVENTS.has(event)) return requestApproverLink(payload)
      if (event === "approved" || event === "rejected") {
        const requestId = str(payload.requestId)
        return requestId ? `/ess/requests?id=${enc(requestId)}` : "/ess/requests"
      }
      return null
    }
    case "disbursement": {
      const projectId = str(payload.projectId)
      return projectId ? `/ess/projects/${enc(projectId)}` : "/ess/projects"
    }
    case "missing_punch": {
      const params = new URLSearchParams({ kind: "fix_punch" })
      const date = str(payload.date)
      if (date) params.set("date", date)
      return `/ess/requests?${params.toString()}`
    }
    case "attendance_sheet": {
      const sheetId = str(payload.sheetId)
      if (!sheetId) return null
      const action = str(payload.action)
      const hr = role === "hr" || (!role && (action === "manager_reviewed" || action === "beyond_cap_settlement"))
      return hr ? `/admin/attendance-sheets/${enc(sheetId)}` : `/ess/attendance-sheet/${enc(sheetId)}`
    }
    case "anomaly": {
      const params = new URLSearchParams()
      const from = str(payload.from)
      const to = str(payload.to)
      if (from) params.set("from", from)
      if (to) params.set("to", to)
      const qs = params.toString()
      // 合規預警（七休一、例假出勤…）寄給主管與 HR，看的是別人的打卡；不是自己的打卡頁。
      if (str(payload.subjectEmployeeId)) {
        // 舊資料沒帶 recipientRole：不知道收件人是不是 HR，寧可 null（退回通知中心）也不讓非 HR 撞到後台權限頁。
        if (role !== "hr") return null
        return qs ? `/admin/punch-records?${qs}` : "/admin/punch-records"
      }
      return qs ? `/ess/punches?${qs}` : "/ess/punches"
    }
    case "late_report":
      return "/ess/approvals"
    case "bonus_run": {
      // 送審通知給老闆 → 簽核頁的「獎金批次」段；核准／退回通知給送審的 HR → 後台批次頁。
      if (str(payload.event) === "submitted" || str(payload.audience) === "boss") return "/ess/approvals"
      const id = str(payload.bonusRunId)
      return id ? `/admin/bonus-runs/${enc(id)}` : "/admin/bonus-sheet"
    }
    case "announcement":
      return "/ess/announcements"
    // 公務車（2026-11-05）：payload 一律帶 { vehicleId, plateNo, bookingId?, tripId?, kind? }。
    case "vehicle_booking_cancelled":
      return "/ess/vehicles"
    case "vehicle_condition": {
      const tripId = str(payload.tripId)
      return tripId ? `/admin/vehicles/trips/${enc(tripId)}` : "/admin/vehicles/trips"
    }
    case "vehicle_reminder": {
      if (str(payload.kind) === "overdue_return") {
        const tripId = str(payload.tripId)
        if (tripId) return `/admin/vehicles/trips/${enc(tripId)}`
      }
      const vehicleId = str(payload.vehicleId)
      return vehicleId ? `/admin/vehicles/${enc(vehicleId)}` : "/admin/vehicles"
    }
    case "profile_change_request":
      return "/admin/employees"
    case "profile_change_reviewed":
      return "/ess/mydata"
    case "calendar_import_draft":
    case "calendar_import_revision":
    case "calendar_import_fetch_failed":
      return "/admin/calendar"
    case "payroll_period": {
      // 2026-11-09 月結發薪頁吃 ?period=：直接開到通知講的那個月（格式不對就開預設月份）。
      const period = str(payload.period)
      return period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? `/admin/payroll?period=${period}` : "/admin/payroll"
    }
    case "overtime_unapproved_punch":
      return "/ess/approvals"
    default:
      return null
  }
}

/**
 * 這則通知是不是「要收件人去處理」的待辦（Email 結尾用「前往處理：」，其餘用「查看：」）。
 */
export function notificationNeedsAction(n: NotificationLinkInput): boolean {
  const payload = n.payload && typeof n.payload === "object" ? n.payload : {}
  const event = str(payload.event)
  const action = str(payload.action)
  switch (n.type) {
    case "approval":
      return !!event && APPROVER_EVENTS.has(event)
    case "missing_punch":
    case "late_report":
    case "profile_change_request":
    case "calendar_import_draft":
    case "calendar_import_revision":
    case "calendar_import_fetch_failed":
    case "overtime_unapproved_punch":
      return true
    case "attendance_sheet":
      return action === "submitted" || action === "manager_reviewed" || action === "returned" || action === "reopened" || action === "beyond_cap_settlement"
    case "bonus_run":
      return event === "submitted"
    default:
      return false
  }
}

/** 寄信／LINE 用：有連結回連結，沒有就退回通知中心（一定有地方可點）。 */
export function notificationLinkOrFallback(n: NotificationLinkInput): string {
  return notificationLink(n) ?? NOTIFICATIONS_FALLBACK_PATH
}

/** 站內路徑接上網站根網址（去掉 base 結尾斜線；path 一律以 / 開頭）。 */
export function absoluteAppUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  return `${base}${path.startsWith("/") ? path : `/${path}`}`
}
