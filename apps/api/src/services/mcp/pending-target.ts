import { supabaseAdmin } from "../../lib/supabase.js"

/**
 * 最高風險待確認操作的防誤導（資安複驗 N1）：
 *   • checkPendingBody：body 大小（≤ 8KB）、key 總數（≤ 40）、巢狀深度（≤ 4）限制——做不到逐 route 的 schema 對照，
 *     至少不讓 AI 用一大坨欄位把關鍵改動藏在確認頁看不到的地方。
 *   • dangerFieldsOf：body 裡屬於高敏感的欄位（角色、狀態、銀行帳號、金額、主管、離職日…），確認頁頂端醒目列出。
 *   • describeTarget：把路徑中的 id 解析成人看得懂的對象（員工姓名／編號、放款單號＋金額＋受款人、期間、
 *     獎金批次、專案、廠商、部門…），一律限本租戶；解析不到回 null（確認頁顯示「無法辨識對象，請小心」）。
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

const DANGER_FIELD_RE = /role|status|bank|account|amount|salary|manager|terminat|company|password|features|user_?id|pay|price|total|pct|rate|delete|void/i

/** body 裡的高敏感欄位路徑（例：role、bankAccount、items[0].amount），去重、最多 30 個。 */
export function dangerFieldsOf(body: unknown): string[] {
  const out = new Set<string>()
  const walk = (value: unknown, path: string) => {
    if (out.size >= 30) return
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`))
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k
        if (DANGER_FIELD_RE.test(k)) out.add(p)
        walk(v, p)
      }
    }
  }
  walk(body, "")
  return [...out]
}

type Row = Record<string, unknown>

async function one(table: string, cols: string, tenantId: string, id: string): Promise<Row | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { data, error } = await supabaseAdmin.from(table).select(cols).eq("tenant_id", tenantId).eq("id", id).maybeSingle()
  if (error || !data) return null
  return data as unknown as Row
}

async function employeeLabel(tenantId: string, id: string): Promise<string | null> {
  const e = await one("employees", "id, name, emp_no, role, status", tenantId, id)
  if (!e) return null
  return `員工 ${e.name ?? "（未命名）"}${e.emp_no ? `（${e.emp_no}）` : ""}・目前角色 ${e.role ?? "?"}・狀態 ${e.status ?? "?"}`
}

const money = (v: unknown) => (typeof v === "number" || typeof v === "string" ? `${Number(v).toLocaleString("zh-TW")} 元` : "?")

/** 依資源類型解析路徑中的對象；不是針對單筆的路徑（批次／新增）回描述字串；解析失敗回 null。 */
export async function describeTarget(tenantId: string, method: string, path: string, body: unknown): Promise<string | null> {
  const seg = path.toLowerCase().split("/").filter(Boolean)
  const raw = path.split("/").filter(Boolean)
  const id = raw[1] ?? ""
  const b = (body && typeof body === "object" ? body : {}) as Row
  try {
    switch (seg[0]) {
      case "employees": {
        if (!seg[1]) return `新增員工：${String(b.name ?? "（未提供姓名）")}${b.role ? `・角色 ${String(b.role)}` : ""}`
        if (seg.length === 2 && method === "POST") return null
        return await employeeLabel(tenantId, id)
      }
      case "disbursements": {
        if (seg[1] === "batch-pay") {
          const ids = Array.isArray(b.ids) ? b.ids : Array.isArray(b.disbursementIds) ? b.disbursementIds : []
          return `批次放款：${ids.length} 張放款單`
        }
        const d = await one("disbursements", "id, disbursement_no, amount, payee_name, status", tenantId, id)
        return d ? `放款單 ${d.disbursement_no ?? d.id}・金額 ${money(d.amount)}・受款人 ${d.payee_name ?? "?"}・狀態 ${d.status ?? "?"}` : null
      }
      case "payroll-periods":
        return /^\d{4}-\d{2}$/.test(id) ? `發薪期間 ${id}` : null
      case "payroll":
        return seg[1] === "run" ? `薪資計算${b.period ? `：期間 ${String(b.period)}` : ""}${Array.isArray(b.employeeIds) ? `・${b.employeeIds.length} 人` : "・全部適用員工"}` : null
      case "payslips": {
        if (seg[1] === "send-batch") return `批次寄送薪資單${b.period ? `：期間 ${String(b.period)}` : ""}`
        const p = await one("payslips", "id, employee_id, period, gross, status", tenantId, id)
        if (!p) return null
        const who = await employeeLabel(tenantId, String(p.employee_id))
        return `薪資單 ${p.period}・應發 ${money(p.gross)}・${who ?? "員工不明"}`
      }
      case "bonus-runs": {
        const r = await one("bonus_runs", "id, label, status, approved_amount", tenantId, id)
        return r ? `獎金批次「${r.label ?? r.id}」・狀態 ${r.status ?? "?"}${r.approved_amount != null ? `・核准金額 ${money(r.approved_amount)}` : ""}` : null
      }
      case "projects": {
        const pr = await one("projects", "id, name, code", tenantId, id)
        return pr ? `專案「${pr.name ?? pr.id}」${pr.code ? `（${pr.code}）` : ""}` : null
      }
      case "vendors": {
        if (!seg[1]) return `新增廠商：${String(b.name ?? "（未提供名稱）")}`
        const v = await one("vendors", "id, name, bank_name, bank_account", tenantId, id)
        return v ? `廠商「${v.name}」・目前收款 ${v.bank_name ?? "?"} ${v.bank_account ?? ""}` : null
      }
      case "salary-adjustments": {
        if (!seg[1]) {
          const who = typeof b.employeeId === "string" ? await employeeLabel(tenantId, b.employeeId) : null
          return `新增薪資調整：${who ?? "員工不明"}`
        }
        const s = await one("salary_adjustments", "id, employee_id, new_salary, effective_date", tenantId, id)
        if (!s) return null
        return `薪資調整（${s.effective_date}，${money(s.new_salary)}）・${(await employeeLabel(tenantId, String(s.employee_id))) ?? "員工不明"}`
      }
      case "departments": {
        const d = await one("departments", "id, name", tenantId, id)
        return d ? `部門「${d.name}」` : null
      }
      case "profile-change-requests": {
        const r = await one("employee_profile_change_requests", "id, employee_id, status", tenantId, id)
        if (!r) return null
        return `員工改資料申請・${(await employeeLabel(tenantId, String(r.employee_id))) ?? "員工不明"}`
      }
      case "rule-config":
        return "全公司差勤／薪資規則參數"
      case "approval-flows":
        return `簽核流程：${id || "?"}`
      case "admin":
        return seg[1] === "tenants" ? `新增租戶：${String(b.name ?? "?")}` : null
      default:
        return null
    }
  } catch {
    return null
  }
}
