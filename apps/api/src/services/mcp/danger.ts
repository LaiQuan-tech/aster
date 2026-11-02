/**
 * 經 MCP 執行前必須「二段確認」的危險操作（高階工具與 call_api 一律套用）。
 *
 * 第一次呼叫只回預覽＋confirm_token（5 分鐘、一次性、綁同一使用者＋同一授權＋完全相同的 method/path/query/body）；
 * 第二次帶 confirm_token 才真的執行。清單之外，所有 DELETE 也一律算危險（刪除類）。
 * 新增會動到錢、權限、規則、期間鎖定或大量寄送的端點時，記得來這裡補一行。
 */

/**
 * 風險等級：
 *   • high（最高風險）：AI 不能自己帶 confirm_token 完成——第一次呼叫建立「待確認操作」（mcp_pending_actions），
 *     回後台確認網址，使用者本人登入按「確認執行」後由 API 以他的身分（重新檢查權限）執行。
 *   • medium：二段確認（confirm_token 5 分鐘、一次性、綁 user＋grant＋參數）。
 */
export type DangerTier = "high" | "medium"

export interface DangerRule {
  method: "POST" | "PUT" | "PATCH" | "DELETE"
  path: string
  label: string
  tier?: DangerTier
  /** 只有 body 符合條件才算危險（例：PATCH 員工只有改角色／狀態才算）。 */
  when?: (body: unknown) => boolean
}

export interface Danger {
  label: string
  tier: DangerTier
}

const hasAnyKey = (keys: string[]) => (body: unknown) =>
  !!body && typeof body === "object" && keys.some((k) => Object.prototype.hasOwnProperty.call(body, k))

/** body 任何一層含銀行相關鍵（bankCode／bank_name／bankAccount／accountHolder／account_holder／任何 bank* 鍵）。 */
function hasBankKey(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(hasBankKey)
  if (!body || typeof body !== "object") return false
  return Object.entries(body as Record<string, unknown>).some(
    ([k, v]) => /bank|account_?holder/i.test(k) || hasBankKey(v),
  )
}

/**
 * DELETE 預設中風險（confirm_token）；以下前綴（錢／權限相關）的 DELETE 才是最高風險（功能複驗 2）。
 * 比對不分大小寫、以路徑前綴判斷。
 */
export const HIGH_RISK_DELETE_PREFIXES = [
  "/payroll-adjustments", // 薪資加減項
  "/salary-adjustments", // 調薪
  "/salary",
  "/payroll",
  "/payslips",
  "/vendors", // 廠商（收款帳號）
  "/companies", // 公司名冊
  "/departments", // 部門（簽核鏈）
  "/bonus-runs", // 獎金批次
  "/festival-bonuses",
  "/overtime-settlements",
  "/leave-types", // 假別
  "/calendar/days", // 行事曆日
  "/employees", // 員工（含個資、照片）
  "/educations",
  "/certifications",
  "/work-history",
  "/approval-flows", // 角色／簽核相關
  "/disbursements", // 放款
  "/billings", // 請款
  "/contracts",
  "/advances",
  "/expense",
  "/nhi-dependents", // 影響薪資扣繳
  "/income-tax-dependents",
] as const

/** 員工資料裡屬於「角色／權限／帳號狀態」的欄位（PATCH /employees/:id 帶到任一個＝最高風險）。 */
const EMPLOYEE_PRIVILEGE_KEYS = ["role", "status", "user_id", "userId", "features", "terminatedAt", "terminated_at", "companyId", "company_id"]

export const DANGEROUS_OPERATIONS: readonly DangerRule[] = [
  // 薪資結算／執行、期間鎖定
  { method: "POST", path: "/payroll/run", tier: "high", label: "執行薪資計算（產生／覆寫薪資單）" },
  { method: "POST", path: "/payslips/:id/finalize", tier: "high", label: "薪資單定案" },
  { method: "POST", path: "/payslips/:id/send", tier: "high", label: "寄送薪資單給員工" },
  { method: "POST", path: "/payslips/send-batch", tier: "high", label: "批次寄送薪資單" },
  { method: "POST", path: "/payroll/tax/compute", label: "計算所得稅扣繳" },
  { method: "POST", path: "/payroll-periods/:period/close", tier: "high", label: "完成本月發薪（鎖定期間）" },
  { method: "POST", path: "/payroll-periods/:period/reopen", tier: "high", label: "重新開放已鎖定的發薪期間" },
  { method: "POST", path: "/attendance/settle", label: "出勤結算" },
  { method: "POST", path: "/attendance-sheets/:id/reopen", label: "重開已核定的出勤月表" },
  { method: "POST", path: "/expense-settlements/:period/settle", label: "報銷月結" },
  { method: "POST", path: "/leave-settlement/settle", label: "特休結算" },
  { method: "POST", path: "/leave-settlement/unsettle", label: "取消特休結算" },
  { method: "POST", path: "/overtime-settlements/:id/pay", label: "加班超額發放" },
  { method: "POST", path: "/festival-bonuses/prepare", label: "產生三節獎金名單" },
  { method: "POST", path: "/festival-bonuses/pay", label: "三節獎金發放" },
  // 放款／預支／作廢
  { method: "POST", path: "/disbursements/:id/pay", tier: "high", label: "放款（標記已付款）" },
  { method: "POST", path: "/disbursements/batch-pay", tier: "high", label: "批次放款" },
  { method: "POST", path: "/disbursements/:id/void", tier: "high", label: "作廢放款單" },
  { method: "POST", path: "/disbursements/:id/change-approver", label: "變更放款單簽核人" },
  { method: "POST", path: "/advances/:id/pay", label: "預支款付款" },
  { method: "POST", path: "/advances/:id/settle", label: "預支款沖銷結清" },
  { method: "POST", path: "/billings/:id/receive", label: "請款入帳" },
  { method: "POST", path: "/billings/:id/unreceive", label: "取消請款入帳" },
  { method: "POST", path: "/billings/:id/unbill", label: "取消請款" },
  { method: "POST", path: "/billings/:id/uninvoice", label: "取消開立發票" },
  { method: "PUT", path: "/projects/:id/share-revision", label: "修訂專案分潤" },
  { method: "PUT", path: "/projects/:id/subcontracts/:sid/payments", label: "修改複委託付款" },
  // 獎金批次
  { method: "POST", path: "/bonus-runs/:id/approve", tier: "high", label: "核准獎金批次" },
  { method: "POST", path: "/bonus-runs/:id/pay", tier: "high", label: "獎金批次發放" },
  { method: "POST", path: "/bonus-runs/:id/reverse", tier: "high", label: "沖回已發放的獎金批次" },
  // 簽核鏈、批次簽核
  { method: "POST", path: "/requests/batch-decision", label: "批次簽核申請單" },
  { method: "POST", path: "/requests/:id/change-approver", label: "變更申請單簽核人" },
  // 角色／權限／帳號
  { method: "PATCH", path: "/employees/:id", tier: "high", label: "變更員工角色／權限／在職狀態／離職日／所屬公司", when: hasAnyKey(EMPLOYEE_PRIVILEGE_KEYS) },
  { method: "POST", path: "/employees", tier: "high", label: "新增員工" },
  { method: "POST", path: "/employees/:id/deactivate", tier: "high", label: "停用員工帳號" },
  { method: "POST", path: "/employees/:id/reset-password", tier: "high", label: "重設員工密碼" },
  { method: "POST", path: "/employees/:id/send-reset", tier: "high", label: "寄送重設密碼信" },
  { method: "POST", path: "/employees/:id/invite", label: "寄送帳號邀請信" },
  { method: "POST", path: "/employees/bulk-invite", label: "批次寄送帳號邀請信" },
  { method: "POST", path: "/employees/assign-company", label: "批次變更員工所屬公司" },
  { method: "POST", path: "/admin/tenants", tier: "high", label: "建立新租戶" },
  // 薪資結構、假別額度
  { method: "PUT", path: "/salary/:employeeId", label: "修改員工薪資結構" },
  { method: "POST", path: "/salary-adjustments/import", label: "批次匯入薪資調整" },
  { method: "PUT", path: "/leave-balances", label: "覆寫假別額度" },
  { method: "POST", path: "/leave-balances/annual-grant", label: "發放年度特休" },
  { method: "POST", path: "/leave-balances/adjustments", label: "手動增減假別時數" },
  { method: "POST", path: "/comp-time/adjust", label: "調整補休時數" },
  // 規則／設定
  { method: "PUT", path: "/rule-config", tier: "high", label: "變更差勤／薪資規則參數" },
  { method: "PUT", path: "/approval-flows/:kind", tier: "high", label: "變更簽核流程" },
  { method: "PUT", path: "/api/tenant/settings", label: "變更公司設定" },
  { method: "PUT", path: "/expense-settings", label: "變更報銷設定" },
  { method: "PUT", path: "/expense-categories", label: "變更報銷類別" },
  { method: "PUT", path: "/project-settings", label: "變更專案設定" },
  { method: "PUT", path: "/companies", label: "變更公司名冊" },
  { method: "POST", path: "/calendar/generate", label: "重新產生年度行事曆" },
  { method: "POST", path: "/calendar/import/regenerate", label: "重新產生國定假日" },
  { method: "POST", path: "/calendar/import/drafts/:id/approve", label: "核准國定假日匯入" },
  // 批次匯入、大量寄送
  { method: "POST", path: "/imports/:kind", label: "Excel 批次匯入" },
  { method: "POST", path: "/punch/manual/import", label: "批次匯入補登打卡" },
  { method: "POST", path: "/announcements", label: "發布公告給全體員工" },
  { method: "POST", path: "/notifications/deliver-pending", label: "寄出所有待送通知" },
  { method: "POST", path: "/requests/:id/remind", label: "寄送簽核催辦通知" },
  { method: "POST", path: "/backups/run", label: "執行備份" },
  // M3（資安驗收 2026-11-02）補列：錢相關的建立／修改
  { method: "POST", path: "/payroll-adjustments", label: "新增薪資加減項" },
  { method: "PATCH", path: "/payroll-adjustments/:id", label: "修改薪資加減項" },
  { method: "PATCH", path: "/festival-bonuses/:id", label: "修改三節獎金" },
  { method: "POST", path: "/bonus-runs", label: "建立獎金批次" },
  { method: "PATCH", path: "/bonus-runs/:id", label: "修改獎金批次" },
  { method: "POST", path: "/bonus-runs/:id/submit", label: "送出獎金批次" },
  { method: "POST", path: "/overtime-settlements", label: "新增加班超額另計" },
  { method: "PATCH", path: "/overtime-settlements/:id", label: "修改加班超額另計" },
  { method: "PATCH", path: "/disbursements/:id", label: "修改放款單" },
  { method: "PUT", path: "/projects/:id/subcontracts", label: "修改複委託" },
  { method: "POST", path: "/projects/:id/subcontracts/:sid/payments/:installmentNo/accept", label: "複委託付款驗收" },
  { method: "POST", path: "/attendance-sheets/:id/approve", label: "核定出勤月表（鎖定）" },
  // 功能驗收追加（2026-11-02）：最高風險（需後台確認）
  // 員工個資／廠商：只有改到銀行欄位才是最高風險，其餘中風險（功能複驗 1）。規則依序比對、第一條符合的生效。
  { method: "PUT", path: "/employees/:empId/profile", tier: "high", label: "修改員工銀行帳號", when: hasBankKey },
  { method: "PUT", path: "/employees/:empId/profile", label: "修改員工個人資料" },
  { method: "POST", path: "/profile-change-requests/:id/approve", tier: "high", label: "核准員工改資料（可能含銀行帳號）" },
  { method: "POST", path: "/vendors", tier: "high", label: "新增廠商（含收款帳號）", when: hasBankKey },
  { method: "POST", path: "/vendors", label: "新增廠商" },
  { method: "PATCH", path: "/vendors/:id", tier: "high", label: "修改廠商收款帳號", when: hasBankKey },
  { method: "PATCH", path: "/vendors/:id", label: "修改廠商" },
  { method: "POST", path: "/salary-adjustments", tier: "high", label: "新增薪資調整" },
  { method: "PATCH", path: "/salary-adjustments/:id", tier: "high", label: "修改薪資調整" },
  {
    method: "PATCH",
    path: "/departments/:id",
    tier: "high",
    label: "變更部門主管（影響簽核鏈）",
    when: hasAnyKey(["managerEmpIds", "managerEmpId", "manager_emp_ids", "manager_emp_id", "parentId", "parent_id"]),
  },
  // 功能驗收追加：中風險（confirm_token）
  { method: "PUT", path: "/calendar/days", label: "修改行事曆日別" },
  { method: "POST", path: "/punch/manual", label: "補登打卡" },
  { method: "POST", path: "/leave-types", label: "新增假別" },
  { method: "PATCH", path: "/leave-types/:id", label: "修改假別" },
  { method: "PUT", path: "/projects/:id/billings", label: "修改專案請款期程" },
  { method: "PUT", path: "/projects/:id/main-contract", label: "修改專案主合約" },
  { method: "POST", path: "/projects/:id/members", label: "新增專案成員（影響分潤）" },
  { method: "PATCH", path: "/projects/:id/members/:memberId", label: "修改專案成員（影響分潤）" },
  { method: "POST", path: "/billings/:id/bill", label: "請款" },
  { method: "POST", path: "/billings/:id/invoice", label: "開立發票" },
  { method: "PATCH", path: "/announcements/:id", label: "修改已發布公告" },
  { method: "POST", path: "/attendance/scan-missing-punch", label: "掃描缺卡並通知" },
  { method: "PUT", path: "/employee-mailboxes/:employeeId", label: "修改員工信箱" },
  { method: "POST", path: "/duty-rosters/generate", label: "產生值日表" },
  { method: "POST", path: "/kpi-reviews/:id/finalize", label: "KPI 考核定案" },
  // 功能複驗 4：中風險補列
  { method: "PATCH", path: "/attendance-sheets/:id/days/:date", label: "修改出勤月表日資料" },
  { method: "POST", path: "/attendance-sheets/generate", label: "產生出勤月表" },
  { method: "POST", path: "/attendance-sheets/:id/recompute", label: "重算出勤月表" },
  { method: "POST", path: "/shifts", label: "新增班別" },
  { method: "PATCH", path: "/shifts/:id", label: "修改班別" },
  { method: "PATCH", path: "/contracts/:id", label: "修改合約" },
  { method: "POST", path: "/projects/:id/contracts", label: "新增合約" },
]

/**
 * 保守規則：這些前綴底下「所有寫入」預設都算危險（中風險），除非在 SAFE_WRITES 白名單或已有更精確的規則。
 * 薪資、獎金、放款、三節、加班另計、薪資結構、規則、簽核流程、預支、報銷月結、特休結算、扣繳。
 */
const SENSITIVE_WRITE_PREFIXES = [
  "/payroll",
  "/payslips",
  "/salary",
  "/bonus",
  "/disbursement",
  "/festival-bonuses",
  "/overtime-settlements",
  "/rule-config",
  "/approval-flow",
  "/advances",
  "/expense-settlements",
  "/leave-settlement",
  "/tax-filing",
  "/non-employee-income",
  "/api/tenant",
  "/admin/",
]

/** 前綴規則的例外：一般簽核（與後台按「核准／駁回」相同的日常動作）。 */
const SAFE_WRITES: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/disbursements/:id/approve" },
  { method: "POST", path: "/disbursements/:id/reject" },
  { method: "POST", path: "/disbursements/:id/submit" },
  { method: "POST", path: "/disbursements/:id/withdraw" },
  { method: "POST", path: "/disbursements/:id/attachments" },
  { method: "POST", path: "/disbursements" },
  { method: "POST", path: "/bonus-runs/preview" }, // 只試算、不落地
]

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/")
  return new RegExp(`^${escaped}/?$`, "i")
}

const COMPILED = DANGEROUS_OPERATIONS.map((rule) => ({ rule, re: patternToRegExp(rule.path) }))
const SAFE_COMPILED = SAFE_WRITES.map((w) => ({ method: w.method, re: patternToRegExp(w.path) }))

/**
 * 這個呼叫是不是危險操作；是 → 回 { label, tier }，否 → null。
 * `path` 必須是 canonicalizePath() 過的；比對一律不分大小寫（Express 路由預設也不分）。
 */
export function dangerOf(method: string, path: string, body?: unknown): Danger | null {
  const m = method.toUpperCase()
  const p = path.toLowerCase()
  const hit = COMPILED.find(({ rule, re }) => rule.method === m && re.test(p) && (!rule.when || rule.when(body)))
  if (hit) return { label: hit.rule.label, tier: hit.rule.tier ?? "medium" }
  if (m === "DELETE") {
    const high = HIGH_RISK_DELETE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))
    return { label: high ? "刪除錢／權限相關資料" : "刪除資料", tier: high ? "high" : "medium" }
  }
  if (m !== "GET" && m !== "HEAD" && SENSITIVE_WRITE_PREFIXES.some((prefix) => p.startsWith(prefix))) {
    if (SAFE_COMPILED.some((w) => w.method === m && w.re.test(p))) return null
    return { label: "薪資／獎金／金流／規則相關的寫入", tier: "medium" }
  }
  return null
}

/** list_endpoints 用：靜態 pattern 是不是危險（不看 body）。 */
export function isDangerousPattern(method: string, pattern: string): boolean {
  return dangerOf(method, pattern, { role: "x" }) !== null
}
