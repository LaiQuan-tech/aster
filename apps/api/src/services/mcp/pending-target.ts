/**
 * 最高風險待確認操作的防誤導（資安複驗 N1）：
 *   • checkPendingBody：body 大小（≤ 8KB）、key 總數（≤ 40）、巢狀深度（≤ 4）限制——做不到逐 route 的 schema 對照，
 *     至少不讓 AI 用一大坨欄位把關鍵改動藏在確認頁看不到的地方。
 *   • dangerFieldsOf：body 裡屬於高敏感的欄位（角色、狀態、銀行帳號、金額、主管、離職日…），確認頁頂端醒目列出。
 *   • describeTarget：先以「使用者本人身分」打該資源的 GET 端點（權限、遮罩照既有 route），讀不到就不建立待確認；
 *     讀得到才從回應組人看得懂的對象摘要（只存在 DB 給確認頁看，不回給 AI；銀行帳號最多末 4 碼）。
 *     沒有對應 GET 的資源回 null（確認頁顯示「無法辨識對象，請小心」）。
 */

export const PENDING_BODY_MAX_BYTES = 8 * 1024
export const PENDING_BODY_MAX_KEYS = 40
export const PENDING_BODY_MAX_DEPTH = 4

export function checkPendingBody(body: unknown): string | null {
  if (body === undefined || body === null) return null
  const json = JSON.stringify(body)
  if (Buffer.byteLength(json, "utf8") > PENDING_BODY_MAX_BYTES) return `內容超過 ${PENDING_BODY_MAX_BYTES / 1024}KB，最高風險操作請拆小或改到後台操作`
  let keys = 0
  let tooDeep = false
  const walk = (value: unknown, depth: number) => {
    if (depth > PENDING_BODY_MAX_DEPTH) {
      tooDeep = true
      return
    }
    if (Array.isArray(value)) for (const v of value) walk(v, depth + 1)
    else if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) {
        keys += 1
        walk(v, depth + 1)
      }
    }
  }
  walk(body, 1)
  if (tooDeep) return `內容巢狀超過 ${PENDING_BODY_MAX_DEPTH} 層，最高風險操作請改到後台操作`
  if (keys > PENDING_BODY_MAX_KEYS) return `內容欄位超過 ${PENDING_BODY_MAX_KEYS} 個，最高風險操作請拆小或改到後台操作`
  return null
}

/** 權限與金流鍵：一律列出、不受數量上限。 */
const PRIORITY_FIELD_RE = /role|status|bank|account|manager|terminat|amount|salary|user_?id|features|company|payee|pct|password/i
/** 其他值得提醒的鍵：最多列 30 個，超過的只顯示總數。 */
const OTHER_FIELD_RE = /pay|price|total|rate|delete|void|period|paid/i
const OTHER_FIELD_LIMIT = 30

/** body 裡的敏感欄位路徑：權限／金流鍵全部列出；其他提醒鍵最多 30 個，`more`＝沒列出的數量。 */
export function dangerFieldsOf(body: unknown): { fields: string[]; more: number } {
  const priority = new Set<string>()
  const other: string[] = []
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`))
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k
        if (PRIORITY_FIELD_RE.test(k)) priority.add(p)
        else if (OTHER_FIELD_RE.test(k)) other.push(p)
        walk(v, p)
      }
    }
  }
  walk(body, "")
  return { fields: [...priority, ...other.slice(0, OTHER_FIELD_LIMIT)], more: Math.max(0, other.length - OTHER_FIELD_LIMIT) }
}

type Row = Record<string, unknown>

/** 以使用者身分打既有 GET 端點（services/mcp/dispatch.ts）；摘要只從它的回應組，自然受權限與遮罩約束。 */
export type UserGet = (path: string, query?: Record<string, unknown>) => Promise<{ status: number; json: unknown }>

export type TargetResult =
  | { ok: true; summary: string | null }
  /** 使用者讀不到對象（403／404…）：不建立待確認，原樣回錯誤。 */
  | { ok: false; status: number; json: unknown }

/** 銀行帳號最多露末 4 碼。 */
export function maskAccount(value: unknown): string {
  const digits = String(value ?? "").replace(/\s/g, "")
  if (!digits) return "?"
  return digits.length <= 4 ? "****" : `****${digits.slice(-4)}`
}

const str = (v: unknown) => (v === null || v === undefined || v === "" ? "?" : String(v))
const money = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) ? `${Number(v).toLocaleString("zh-TW")} 元` : "?")
const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v)

function listOf(json: unknown, key: string): Row[] {
  const v = (json as Row | null)?.[key]
  return Array.isArray(v) ? (v as Row[]) : []
}

function employeeText(e: Row): string {
  return `員工 ${str(e.name)}${e.emp_no || e.empNo ? `（${str(e.emp_no ?? e.empNo)}）` : ""}・目前角色 ${str(e.role)}・狀態 ${str(e.status ?? "active")}`
}

/**
 * 依資源類型找對應的 GET 端點、以使用者身分讀，再組摘要。
 *   • GET 非 2xx → { ok: false }（呼叫端不建立待確認，回原錯誤）。
 *   • 沒有對應 GET 的資源 → { ok: true, summary: null }（確認頁顯示「無法辨識對象，請小心」）。
 *   • 只描述「使用者自己送出的內容」的（新增／批次）不讀任何資料。
 * 摘要絕不含完整銀行帳號（maskAccount）。
 */
export async function describeTarget(get: UserGet, method: string, path: string, body: unknown): Promise<TargetResult> {
  const seg = path.toLowerCase().split("/").filter(Boolean)
  const raw = path.split("/").filter(Boolean)
  const id = raw[1] ?? ""
  const b = (body && typeof body === "object" ? body : {}) as Row
  const read = async (p: string, q?: Record<string, unknown>) => {
    const r = await get(p, q)
    return r.status >= 200 && r.status < 300 ? { ok: true as const, json: r.json } : { ok: false as const, status: r.status, json: r.json }
  }
  const fromList = async (listPath: string, key: string, rowId: string, make: (row: Row) => string): Promise<TargetResult> => {
    const r = await read(listPath)
    if (!r.ok) return r
    const row = listOf(r.json, key).find((x) => x.id === rowId)
    return row ? { ok: true, summary: make(row) } : { ok: false, status: 404, json: { error: "not_found" } }
  }

  switch (seg[0]) {
    case "employees": {
      if (!seg[1]) return { ok: true, summary: `新增員工（AI 送出的姓名）：${str(b.name)}${b.role ? `・角色 ${str(b.role)}` : ""}` }
      if (!isUuid(id)) return { ok: true, summary: null }
      return fromList("/employees", "employees", id, employeeText)
    }
    case "disbursements": {
      if (seg[1] === "batch-pay") {
        const ids = Array.isArray(b.ids) ? b.ids : Array.isArray(b.disbursementIds) ? b.disbursementIds : []
        return { ok: true, summary: `批次放款：${ids.length} 張放款單（AI 送出的清單）` }
      }
      if (!isUuid(id)) return { ok: true, summary: null }
      const r = await read(`/disbursements/${id}`)
      if (!r.ok) return r
      const d = ((r.json as Row)?.disbursement ?? r.json) as Row
      return {
        ok: true,
        summary: `放款單 ${str(d.disbursementNo ?? d.disbursement_no ?? d.id)}・金額 ${money(d.amount)}・受款人 ${str(d.payeeName ?? d.payee_name)}・狀態 ${str(d.status)}`,
      }
    }
    case "payroll-periods": {
      if (!/^\d{4}-\d{2}$/.test(id)) return { ok: true, summary: null }
      const r = await read(`/payroll-periods/${id}/checklist`)
      if (!r.ok) return r
      return { ok: true, summary: `發薪期間 ${id}` }
    }
    case "payroll":
      return { ok: true, summary: seg[1] === "run" ? `薪資計算（AI 送出的期間）：${str(b.period)}` : null }
    case "payslips": {
      if (seg[1] === "send-batch") return { ok: true, summary: `批次寄送薪資單（AI 送出的期間）：${str(b.period)}` }
      if (!isUuid(id)) return { ok: true, summary: null }
      const r = await read(`/payslips/${id}`)
      if (!r.ok) return r
      const ps = ((r.json as Row)?.payslip ?? r.json) as Row
      return { ok: true, summary: `薪資單 ${str(ps.period)}・${str(ps.employeeName ?? ps.employee_name ?? ps.employee_id ?? ps.employeeId)}・狀態 ${str(ps.status)}` }
    }
    case "bonus-runs": {
      if (!isUuid(id)) return { ok: true, summary: null }
      const r = await read(`/bonus-runs/${id}`)
      if (!r.ok) return r
      const run = (((r.json as Row)?.run ?? r.json) as Row) ?? {}
      return { ok: true, summary: `獎金批次「${str(run.label ?? run.id)}」・狀態 ${str(run.status)}` }
    }
    case "projects": {
      if (!isUuid(id)) return { ok: true, summary: null }
      const r = await read(`/projects/${id}`)
      if (!r.ok) return r
      const pr = (((r.json as Row)?.project ?? r.json) as Row) ?? {}
      return { ok: true, summary: `專案「${str(pr.name ?? pr.id)}」${pr.code ? `（${str(pr.code)}）` : ""}` }
    }
    case "vendors": {
      if (!seg[1]) return { ok: true, summary: `新增廠商（AI 送出的名稱）：${str(b.name)}` }
      if (!isUuid(id)) return { ok: true, summary: null }
      return fromList("/vendors", "vendors", id, (v) => {
        const account = v.bankAccount ?? v.bank_account
        return `廠商「${str(v.name)}」${account ? `・目前收款帳號 ${maskAccount(account)}` : ""}`
      })
    }
    case "salary-adjustments": {
      if (!seg[1]) {
        const empId = typeof b.employeeId === "string" ? b.employeeId : typeof b.employee_id === "string" ? b.employee_id : ""
        if (!isUuid(empId)) return { ok: true, summary: null }
        return fromList("/employees", "employees", empId, (e) => `新增調薪紀錄・${employeeText(e)}`)
      }
      if (!isUuid(id)) return { ok: true, summary: null }
      return fromList("/salary-adjustments", "salary-adjustments", id, (a) => `調薪紀錄（生效日 ${str(a.effectiveDate ?? a.effective_date)}）`)
    }
    case "departments": {
      if (!isUuid(id)) return { ok: true, summary: null }
      return fromList("/departments", "departments", id, (d) => `部門「${str(d.name)}」`)
    }
    case "profile-change-requests": {
      if (!isUuid(id)) return { ok: true, summary: null }
      return fromList("/profile-change-requests", "requests", id, (r) => `員工改資料申請・${str(r.employeeName ?? r.employee_name ?? r.employeeId ?? r.employee_id)}`)
    }
    case "rule-config":
      return { ok: true, summary: "全公司差勤／薪資規則參數" }
    default:
      return { ok: true, summary: null }
  }
}
