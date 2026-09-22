/**
 * 稽核查詢的「翻譯層」：資料表／欄位的中文名、diff 計算、一句人話摘要。
 * 純函式，無 I/O，給 routes/audit-logs.ts 用。
 *
 * 對照表是人工維護的：新掛 audit trigger 的表記得來這裡補一行，沒補也不會壞
 * （fallback 顯示原始 table_name／欄位名）。
 */

export type AuditAction = "INSERT" | "UPDATE" | "DELETE"

export interface AuditDiffEntry {
  field: string
  label: string
  before: unknown
  after: unknown
}

/** table_name → 中文名。順序＝後台篩選器的顯示順序（常用的排前面）。 */
export const AUDIT_TABLE_LABELS: Record<string, string> = {
  employees: "員工",
  employee_profiles: "員工個人資料",
  departments: "部門",
  tenants: "公司設定",
  salary_structures: "薪資結構",
  salary_adjustments: "薪資調整",
  payslips: "薪資單",
  period_closes: "月結",
  rule_configs: "差勤／薪資規則",
  leave_requests: "申請單（假單／加班／補打卡／出差／預支）",
  approval_steps: "簽核關卡",
  approval_flows: "簽核流程",
  leave_types: "假別",
  leave_balances: "假別時數",
  comp_time_ledger: "補休帳",
  punch_records: "打卡紀錄",
  attendance_days: "出勤日",
  attendance_sheets: "出勤月表",
  attendance_sheet_days: "出勤月表明細",
  shifts: "班別",
  schedules: "排班",
  tenant_calendar_days: "行事曆／假日",
  projects: "專案",
  project_settings: "專案設定",
  project_members: "專案成員",
  project_share_adjustments: "專案分潤調整",
  project_billings: "專案請款",
  project_documents: "專案文件",
  project_subcontracts: "外包合約",
  project_subcontract_payments: "外包付款",
  contracts: "合約",
  clients: "客戶",
  companies: "我方公司主體",
  vendors: "廠商",
  disbursements: "匯款單",
  disbursement_allocations: "匯款分攤",
  disbursement_attachments: "匯款附件",
  expense_claims: "費用申請",
  expense_settlements: "費用月結",
  expense_categories: "費用類別",
  expense_settings: "費用設定",
  advances: "員工預支",
  non_employee_income: "非員工所得",
  announcements: "公告",
  announcement_versions: "公告版本",
  announcement_signature_sheets: "公告簽名表",
  announcement_acknowledgements: "公告簽收",
  onboardings: "報到流程",
  kpi_reviews: "績效考核",
  kpi_templates: "考核模板",
  job_requisitions: "招募需求",
  employee_mailboxes: "員工專屬信箱",
  knowledge_chunks: "文件庫",
  notifications: "通知",
  request_attachments: "申請單附件",
}

/** 欄位名 → 中文。跨表共用同名欄位就給通用的字（如 method → 方式）。 */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  name: "名稱／姓名",
  title: "標題",
  body: "內容",
  code: "代碼",
  status: "狀態",
  role: "角色",
  dept_id: "部門",
  emp_no: "員工編號",
  employment_type: "僱用類型",
  hire_date: "到職日",
  terminated_at: "離職日",
  user_id: "登入帳號",
  must_change_password: "首次登入須改密碼",
  employee_id: "員工",
  manager_emp_id: "主管",
  manager_emp_ids: "主管（依簽核順序）",
  parent_id: "上層",
  email: "Email",
  phone: "電話",
  address: "地址",
  birth_date: "生日",
  national_id: "身分證字號",
  method: "方式",
  base_salary: "底薪",
  daily_wage: "日薪",
  hourly_wage: "時薪",
  allowances: "津貼",
  labor_insured_salary: "勞保投保薪資",
  health_insured_salary: "健保投保薪資",
  pension_voluntary_rate: "勞退自提比例",
  agreed_hours_per_week: "約定每週時數",
  agreed_days_per_week: "約定每週天數",
  changed_by_emp_id: "調整人",
  effective_from: "生效日",
  period: "期別",
  gross: "應發",
  net: "實發",
  deductions: "扣款",
  items: "明細",
  finalized_at: "定稿時間",
  config: "規則內容",
  version: "版本",
  active: "啟用",
  scope: "適用範圍",
  kind: "類型",
  type: "類型",
  leave_type_id: "假別",
  start_at: "開始時間",
  end_at: "結束時間",
  hours: "時數",
  reason: "事由",
  agent_name: "代理人",
  payout: "折現",
  remark: "備註",
  note: "備註",
  notes: "備註",
  description: "說明",
  current_step: "目前關卡",
  step_order: "關卡順序",
  decision: "決定",
  comment: "意見",
  approver_emp_id: "簽核者",
  acted_by_emp_id: "實際簽核者",
  acted_at: "簽核時間",
  approver_emp_ids: "簽核名單",
  candidate_emp_ids: "候選簽核人",
  step_kind: "關卡來源",
  applies_to: "適用",
  mode: "模式",
  punch_at: "打卡時間",
  source: "來源",
  lat: "緯度",
  lng: "經度",
  device_id: "裝置",
  work_date: "日期",
  late_minutes: "遲到分鐘",
  early_leave_minutes: "早退分鐘",
  overtime_minutes: "加班分鐘",
  absent: "缺勤",
  paid: "給薪",
  granted: "給假時數",
  used: "已用時數",
  balance: "餘額",
  amount: "金額",
  total: "總額",
  currency: "幣別",
  counterparty: "對方",
  signed_on: "簽約日",
  copies: "份數",
  our_role: "我方角色",
  doc_type: "文件類型",
  stamp_duty_required: "應貼印花",
  stamp_duty_rate: "印花稅率",
  stamp_duty_amount: "印花稅額",
  stamp_duty_paid_on: "貼花日",
  stamp_duty_note: "印花稅備註",
  project_id: "專案",
  client_id: "客戶",
  company_id: "公司主體",
  vendor_id: "廠商",
  contract_id: "合約",
  payee_kind: "收款方類型",
  payee_name: "收款方",
  disbursement_no: "匯款單號",
  paid_on: "匯款日",
  due_on: "到期日",
  invoice_no: "發票號碼",
  invoice_kind: "發票／收據",
  bank_code: "銀行代碼",
  bank_account: "銀行帳號",
  opened_on: "開案日",
  closed_on: "結案日",
  deleted_at: "刪除時間",
  deleted_reason: "刪除理由",
  share_pct: "分潤比例",
  share_amount: "分潤金額",
  lead_emp_id: "專案負責人",
  audience: "對象",
  published_at: "發布時間",
  current_version_id: "目前版本",
  is_default: "預設",
  features: "功能設定",
  branding: "品牌設定",
  timezone: "時區",
  tax_id: "統一編號",
  unit_price: "單價",
  quantity: "數量",
  category_id: "類別",
  settled_at: "結算時間",
  sheet_locked: "月表已鎖",
  created_at: "建立時間",
  updated_at: "更新時間",
}

export function tableLabel(table: string): string {
  return AUDIT_TABLE_LABELS[table] ?? table
}

export function fieldLabel(field: string): string {
  return AUDIT_FIELD_LABELS[field] ?? field
}

type Row = Record<string, unknown> | null | undefined

/** 永遠不列進 diff 的欄位（自動維護、無稽核價值）。 */
const SKIP_ALWAYS = new Set(["updated_at"])
/** INSERT／DELETE 列欄位時再多略過的（列 id／租戶／建立時間只是雜訊，時間另有 at）。 */
const SKIP_IN_LISTING = new Set(["id", "tenant_id", "created_at"])
const LISTING_MAX = 20

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === ""
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (isEmpty(a) && isEmpty(b)) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function asRow(v: unknown): Row {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * old_row / new_row → 變動欄位清單。
 * UPDATE：兩邊值不同的欄位（排除 updated_at）。
 * INSERT：new_row 非空欄位前 20 個；DELETE：old_row 非空欄位前 20 個。
 * 應用層 writeAuditLog 的列（new_row 是語意 payload、old_row 多半 null）也適用：
 * UPDATE 且無 old_row 時就把 new_row 全列出來，before 皆 null。
 */
export function computeAuditDiff(action: string, oldRow: unknown, newRow: unknown): AuditDiffEntry[] {
  const o = asRow(oldRow)
  const n = asRow(newRow)
  if (action === "UPDATE") {
    const keys = new Set<string>([...Object.keys(o ?? {}), ...Object.keys(n ?? {})])
    const out: AuditDiffEntry[] = []
    for (const k of [...keys].sort()) {
      if (SKIP_ALWAYS.has(k)) continue
      const before = o?.[k]
      const after = n?.[k]
      if (same(before, after)) continue
      out.push({ field: k, label: fieldLabel(k), before: before ?? null, after: after ?? null })
    }
    return out
  }
  const src = action === "INSERT" ? n : o
  return Object.entries(src ?? {})
    .filter(([k, v]) => !SKIP_ALWAYS.has(k) && !SKIP_IN_LISTING.has(k) && !isEmpty(v))
    .slice(0, LISTING_MAX)
    .map(([k, v]) =>
      action === "INSERT"
        ? { field: k, label: fieldLabel(k), before: null, after: v }
        : { field: k, label: fieldLabel(k), before: v, after: null },
    )
}

/** 給列表用的「這筆是誰」：姓名／標題／單號／代碼擇一。 */
export function recordLabelOf(oldRow: unknown, newRow: unknown): string | null {
  const row = asRow(newRow) ?? asRow(oldRow)
  if (!row) return null
  for (const k of ["name", "title", "disbursement_no", "code", "emp_no", "period", "payee_name"]) {
    const v = row[k]
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40)
  }
  return null
}

const ACTION_VERB: Record<string, string> = { INSERT: "新增", UPDATE: "更新", DELETE: "刪除" }

/** 一句人話：「更新員工「王小明」：姓名、部門」／「新增匯款單「D-2026-001」」。 */
export function summarizeAudit(
  action: string,
  table: string,
  diff: AuditDiffEntry[],
  recordLabel: string | null,
): string {
  const verb = ACTION_VERB[action] ?? action
  const who = recordLabel ? `「${recordLabel}」` : ""
  const head = `${verb}${tableLabel(table)}${who}`
  if (action !== "UPDATE" || diff.length === 0) return head
  const names = diff.map((d) => d.label)
  const shown = names.slice(0, 4).join("、")
  return names.length > 4 ? `${head}：${shown} 等 ${names.length} 個欄位` : `${head}：${shown}`
}
