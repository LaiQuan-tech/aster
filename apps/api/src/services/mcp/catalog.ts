import { isDangerousPattern } from "./danger.js"

/**
 * list_endpoints／call_api 的 API 目錄：執行期直接走訪 Express app 的 router stack（app.router.stack），
 * 所以新加的 route 自動出現，不用手動維護清單。說明文字依路徑前綴給中文分類，常用端點另有逐條說明。
 */

export interface EndpointInfo {
  method: string
  path: string
  desc: string
  dangerous: boolean
}

/** MCP 不准打的路徑（OAuth／金鑰自助／內部排程／密碼／示範資料）。 */
const BLOCKED_PREFIXES = [
  "/mcp",
  "/oauth",
  "/.well-known",
  "/internal",
  "/me/mcp",
  "/me/password",
  "/me/password-done",
  "/auth",
  "/demo",
  "/health",
]

export function isBlockedPath(path: string): boolean {
  const p = path.toLowerCase().replace(/\/+$/, "") || "/"
  return BLOCKED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))
}

const SECTION_LABELS: Array<[string, string]> = [
  ["/employees", "員工"],
  ["/educations", "員工學歷"],
  ["/certifications", "員工證照"],
  ["/work-history", "員工經歷"],
  ["/departments", "部門"],
  ["/org-chart", "組織圖"],
  ["/shifts", "班別"],
  ["/late-reports", "遲到說明"],
  ["/punch", "打卡"],
  ["/attendance-sheets", "出勤月表"],
  ["/attendance-days", "每日出勤"],
  ["/attendance", "出勤"],
  ["/leave-types", "假別"],
  ["/leave-balances", "假別餘額"],
  ["/leave-register", "年度請假表"],
  ["/leave-settlement", "特休結算"],
  ["/comp-time", "補休"],
  ["/approval-flows", "簽核流程"],
  ["/requests", "申請單（請假／加班／補卡／出差／零用金／居家／公務車預約）"],
  ["/announcement", "公告"],
  ["/me", "我的帳號"],
  ["/my/", "我的資料"],
  ["/rule-config", "差勤／薪資規則"],
  ["/salary-adjustments", "薪資調整"],
  ["/fixed-allowances", "員工固定津貼"],
  ["/salary", "薪資結構"],
  ["/calendar", "行事曆"],
  ["/payroll-periods", "發薪期間（鎖定）"],
  ["/payroll-adjustments", "薪資加減項"],
  ["/payroll", "薪資計算"],
  ["/payslips", "薪資單"],
  ["/tax-filing", "扣繳申報"],
  ["/nhi-dependents", "健保眷屬"],
  ["/income-tax-dependents", "扶養親屬"],
  ["/non-employee-income", "非員工所得"],
  ["/reports", "報表"],
  ["/notifications", "通知"],
  ["/ai", "AI 摘要／問答"],
  ["/kpi", "KPI 考核"],
  ["/job-requisitions", "招募職缺"],
  ["/candidates", "應徵者"],
  ["/interviews", "面試"],
  ["/offers", "錄取"],
  ["/internal-jobs", "內部職缺"],
  ["/dashboard", "儀表板"],
  ["/expense", "報銷"],
  ["/advances", "預支"],
  ["/backups", "備份"],
  ["/personal-note", "個人筆記"],
  ["/preferences", "個人偏好"],
  ["/projects", "專案"],
  ["/project-settings", "專案設定"],
  ["/contracts", "合約"],
  ["/billings", "請款／發票／入帳"],
  ["/clients", "客戶"],
  ["/companies", "公司名冊"],
  ["/option-lists", "選項清單"],
  ["/company-pages", "公司頁面"],
  ["/employee-mailboxes", "員工信箱"],
  ["/vendors", "廠商"],
  ["/knowledge", "知識庫"],
  ["/disbursements", "放款單"],
  ["/audit-logs", "稽核紀錄"],
  ["/bonus-runs", "獎金季發放批次"],
  ["/bonus-sheet", "獎金分潤總表"],
  ["/imports", "Excel 批次匯入"],
  ["/overtime-settlements", "加班超額另計"],
  ["/festival-bonuses", "三節獎金"],
  ["/duty-rosters", "值日／總機"],
  ["/profile-change-requests", "員工改資料審核"],
  ["/group-overview", "集團總覽"],
  // 2026-11-05 公務車（長的放前）
  ["/vehicle-bookings", "公務車預約"],
  ["/vehicle-trips", "用車紀錄（取車／還車／費用）"],
  ["/vehicle-settings", "公務車設定"],
  ["/vehicles", "公務車"],
  ["/api/tenant", "公司設定"],
  ["/admin/tenants", "租戶管理"],
]

const SPECIFIC: Record<string, string> = {
  "GET /me": "我是誰：姓名、角色、公司、可見功能",
  "GET /employees": "員工名冊（財務層以上）",
  "GET /requests": "申請單清單；query: status, kind, employeeId, from, to, scope=mine",
  "GET /requests/pending-approvals": "輪到我簽的申請單",
  "POST /requests": "送出申請（本人）；請假：hours＞0 且不超過起訖，跨日須帶 segments[{date,startTime,endTime,hours}]、hours＝各段加總",
  "POST /requests/:id/approve": "核准申請單（body: comment?）",
  "POST /requests/:id/reject": "駁回申請單（body: comment?）",
  "POST /requests/batch-decision": "批次簽核（body: ids[], action, comment?）",
  "PUT /projects/:id/subcontracts":
    "副委託整批（body: subcontracts[], deleteReason?）：未列出的既有列會被軟刪（需 deleteReason）；既有列沒帶的欄位保留原值、帶 null 清空；amount 必填。換廠商須同時送新廠商的 vendorId 與它在名冊上的名稱；非登錄廠商送 vendorId: null + vendorName：只有與名冊廠商「名稱」完全相同（只差空白／全形／標點／大小寫／臺台）才硬擋 → 409 must_bind_vendor（回 matchedVendorName／index），請改送該廠商的 vendorId；與簡稱或帳戶戶名相同、或名稱包含／相近（去公司後綴、分公司、地名、括號段）→ 409 vendor_name_similar（回 matchedVendorName／index），同一家請改送該廠商 vendorId，確為不同公司則在該列帶 confirmDistinctReason 說明（寫嚴格稽核）。既有列原本綁名冊廠商、vendorId 有變（改綁或解除綁定成 null），不論有無未付期款，該列都須帶 rebindReason（否則 400 rebind_reason_required），會寫嚴格稽核。任一列帶 rebindReason 或 confirmDistinctReason 為最高風險。新建／改名列名稱含不可見字元或西里爾／希臘字母 → 400 invalid_subcontract_vendor_name。沒帶 kind 時，事務所列不可送發票欄位、其他列不可送代扣日期（回 400 field_not_applicable）。",
  "POST /projects":
    "建立專案（含 initialSubcontracts?）：非登錄副委託（vendorId 空）只有與名冊廠商「名稱」完全相同才硬擋 → 409 must_bind_vendor（回 matchedVendorName、index），請改送該廠商的 vendorId；與簡稱或帳戶戶名相同、或名稱包含／相近 → 409 vendor_name_similar，確為不同公司請在該列帶 confirmDistinctReason 說明（嚴格稽核、最高風險）。",
  "POST /disbursements":
    "建立放款單：payeeKind vendor（帶 vendorId，帳戶照名冊帶；名冊沒帳戶卻手填 → 400 vendor_bank_missing）或 other（只有戶名與名冊廠商「名稱」完全相同才硬擋 → 400 payee_is_registered_vendor，請改選該廠商；與簡稱或帳戶戶名相同、或名稱包含／相近 → 409 payee_name_similar（回 matchedVendorName），同一家請改選該廠商，確為不同公司請帶 confirmDistinctReason 說明——最高風險、寫嚴格稽核、核准頁與放款紀錄頁紅框標示）。戶名含不可見字元或西里爾／希臘字母 → 400 invalid_payee_name。登錄廠商零分攤（非期款支出）且廠商仍有未付期款 → 409 vendor_has_unpaid_installments，確定非期款須帶 confirmNonInstallment: true（最高風險、寫稽核）。",
  "PATCH /disbursements/:id":
    "修改放款單（只限草稿／已核准的備註類欄位）：已分攤的單不可改成零分攤（400 cannot_clear_allocations）；登錄廠商零分攤單改金額／用途／分攤，廠商有未付期款時須帶 confirmNonInstallment: true；「其他」收款改戶名後與名冊廠商相近須帶 confirmDistinctReason（最高風險）；其餘錯誤碼同 POST /disbursements。",
  "POST /vendors":
    "新增廠商：只有名稱與名冊既有廠商名稱完全相同才硬擋 → 409 vendor_name_duplicate（回 matchedVendorName）；簡稱、帳戶戶名相同或名稱包含／相近 → 409 vendor_name_similar，確為不同公司請帶 confirmDistinctReason 說明（最高風險、寫嚴格稽核）；名稱／簡稱／帳戶戶名含不可見字元或西里爾／希臘字母 → 400 invalid_vendor_name。",
  "PATCH /vendors/:id":
    "修改廠商：只有改後名稱與名冊既有廠商名稱完全相同才硬擋 → 409 vendor_name_duplicate；簡稱、帳戶戶名相同或名稱包含／相近 → 409 vendor_name_similar，確為不同公司請帶 confirmDistinctReason 說明（最高風險）；名稱不合法 → 400 invalid_vendor_name；有未匯款放款單時不可改帳戶（409 vendor_has_open_disbursements）、只有未付期款改帳戶須帶 changeReason（第一次補帳戶免）。",
  "DELETE /vendors/:id": "刪除廠商（HR）：仍有未付期款或未匯款放款單 → 409 vendor_in_use。",
  "GET /punch": "打卡紀錄；query: employeeId, deptId, from, to, type, source",
  "GET /attendance/punch-overview": "打卡當日總覽／週表；query: date 或 from/to, deptId, employeeId",
  "GET /attendance/anomalies": "出勤異常；query: from, to",
  "GET /leave-balances/overview": "假別剩餘總覽（一人一列）",
  "GET /projects": "專案清單；query: year, includeArchived, sort, dir, kind, view, limit",
  "GET /projects/:id": "專案明細",
  "GET /disbursements": "放款單清單；query: from, to, status, q 等",
  "GET /disbursements/pending-approvals": "輪到我簽的放款單",
  "POST /disbursements/:id/approve": "核准放款單",
  "POST /disbursements/:id/reject": "駁回放款單",
  "GET /payslips": "薪資單；query: period(YYYY-MM), employeeId, scope=mine",
  "GET /payroll-periods/:period/checklist": "發薪前檢查清單",
  "GET /my/bonus-approvals": "輪到我簽的獎金批次",
  "GET /dashboard/boss-summary": "老闆摘要（財務層以上）",
  "GET /audit-logs": "稽核紀錄（HR）",
  "GET /vehicles/availability": "公務車已被預約的時段；query: from, to, vehicleId",
  "POST /vehicle-bookings/:id/checkout": "取車（body: startOdometer）",
}

function sectionOf(path: string): string {
  const hit = SECTION_LABELS.find(([prefix]) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}`))
  return hit?.[1] ?? "其他"
}

function verbOf(method: string, path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? ""
  if (method === "GET") return last.startsWith(":") ? "查詢單筆" : last.endsWith(".xlsx") || last === "export" ? "匯出檔案" : "查詢"
  if (method === "DELETE") return "刪除"
  if (method === "PUT" || method === "PATCH") return "修改"
  return last.startsWith(":") ? "新增" : `動作：${last}`
}

type Layer = {
  route?: { path: string | string[]; methods: Record<string, boolean> }
  handle?: { stack?: Layer[] }
}

let cache: { app: object; list: EndpointInfo[] } | null = null

export function listEndpoints(app: object): EndpointInfo[] {
  if (cache && cache.app === app) return cache.list
  const out: EndpointInfo[] = []
  const seen = new Set<string>()
  const walk = (stack: Layer[] | undefined) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]
        for (const path of paths) {
          if (typeof path !== "string" || isBlockedPath(path)) continue
          for (const [m, on] of Object.entries(layer.route.methods)) {
            if (!on || m === "_all") continue
            const method = m.toUpperCase()
            const key = `${method} ${path}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({
              method,
              path,
              desc: SPECIFIC[key] ?? `${sectionOf(path)}：${verbOf(method, path)}`,
              dangerous: isDangerousPattern(method, path),
            })
          }
        }
      } else if (layer.handle?.stack) walk(layer.handle.stack)
    }
  }
  walk((app as { router?: { stack?: Layer[] } }).router?.stack)
  cache = { app, list: out }
  return out
}

export function searchEndpoints(app: object, opts: { keyword?: string; method?: string }): EndpointInfo[] {
  const kw = opts.keyword?.trim().toLowerCase()
  const m = opts.method?.trim().toUpperCase()
  return listEndpoints(app).filter((e) => {
    if (m && e.method !== m) return false
    if (!kw) return true
    return kw
      .split(/\s+/)
      .every((word) => e.path.toLowerCase().includes(word) || e.desc.toLowerCase().includes(word))
  })
}

/**
 * 路徑標準化（資安驗收 H1／M1）：送出前用 WHATWG URL 解析，結果必須與原字串完全相同，
 * 且不得含 %（任何百分比編碼，含 %2e／%2f）、dot-segment（/./、/../、結尾 /. 或 /..）、反斜線、空白或控制字元。
 * 不通過 → 回錯誤訊息（呼叫端回 400）；通過 → 回 { canon }。封鎖／危險比對一律用 canon（再轉小寫）。
 */
export function canonicalizePath(path: unknown): { canon: string } | { error: string } {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 300) return { error: "path 必須以 / 開頭（例：/requests）" }
  if (/[\x00-\x20\x7f\\%?#]/.test(path)) return { error: "path 不可含 %、?、#、反斜線、空白或控制字元；查詢參數請放 query" }
  if (path.startsWith("//") || /\/\.\.?(\/|$)/.test(path)) return { error: "path 不可含 //、/./、/../ 這類路徑片段" }
  let canon: string
  try {
    canon = new URL(path, "http://x").pathname
  } catch {
    return { error: "path 格式不正確" }
  }
  if (canon !== path) return { error: "path 不是標準形式（解析後與原字串不同）" }
  return { canon }
}
