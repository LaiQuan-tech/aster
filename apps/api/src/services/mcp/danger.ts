/**
 * 經 MCP 執行前必須「二段確認」的危險操作（高階工具與 call_api 一律套用）。
 *
 * 第一次呼叫只回預覽＋confirm_token（5 分鐘、一次性、綁同一使用者＋同一授權＋完全相同的 method/path/query/body）；
 * 第二次帶 confirm_token 才真的執行。清單之外，所有 DELETE 也一律算危險（刪除類）。
 * 新增會動到錢、權限、規則、期間鎖定或大量寄送的端點時，記得來這裡補一行。
 */

export interface DangerRule {
  method: "POST" | "PUT" | "PATCH" | "DELETE"
  path: string
  label: string
  /** 只有 body 符合條件才算危險（例：PATCH 員工只有改角色／狀態才算）。 */
  when?: (body: unknown) => boolean
}

const hasAnyKey = (keys: string[]) => (body: unknown) =>
  !!body && typeof body === "object" && keys.some((k) => Object.prototype.hasOwnProperty.call(body, k))

export const DANGEROUS_OPERATIONS: readonly DangerRule[] = [
  // 薪資結算／執行、期間鎖定
  { method: "POST", path: "/payroll/run", label: "執行薪資計算（產生／覆寫薪資單）" },
  { method: "POST", path: "/payslips/:id/finalize", label: "薪資單定案" },
  { method: "POST", path: "/payslips/:id/send", label: "寄送薪資單給員工" },
  { method: "POST", path: "/payslips/send-batch", label: "批次寄送薪資單" },
  { method: "POST", path: "/payroll/tax/compute", label: "計算所得稅扣繳" },
  { method: "POST", path: "/payroll-periods/:period/close", label: "完成本月發薪（鎖定期間）" },
  { method: "POST", path: "/payroll-periods/:period/reopen", label: "重新開放已鎖定的發薪期間" },
  { method: "POST", path: "/attendance/settle", label: "出勤結算" },
  { method: "POST", path: "/attendance-sheets/:id/reopen", label: "重開已核定的出勤月表" },
  { method: "POST", path: "/expense-settlements/:period/settle", label: "報銷月結" },
  { method: "POST", path: "/leave-settlement/settle", label: "特休結算" },
  { method: "POST", path: "/leave-settlement/unsettle", label: "取消特休結算" },
  { method: "POST", path: "/overtime-settlements/:id/pay", label: "加班超額發放" },
  { method: "POST", path: "/festival-bonuses/prepare", label: "產生三節獎金名單" },
  { method: "POST", path: "/festival-bonuses/pay", label: "三節獎金發放" },
  // 放款／預支／作廢
  { method: "POST", path: "/disbursements/:id/pay", label: "放款（標記已付款）" },
  { method: "POST", path: "/disbursements/batch-pay", label: "批次放款" },
  { method: "POST", path: "/disbursements/:id/void", label: "作廢放款單" },
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
  { method: "POST", path: "/bonus-runs/:id/approve", label: "核准獎金批次" },
  { method: "POST", path: "/bonus-runs/:id/pay", label: "獎金批次發放" },
  { method: "POST", path: "/bonus-runs/:id/reverse", label: "沖回已發放的獎金批次" },
  // 簽核鏈、批次簽核
  { method: "POST", path: "/requests/batch-decision", label: "批次簽核申請單" },
  { method: "POST", path: "/requests/:id/change-approver", label: "變更申請單簽核人" },
  // 角色／權限／帳號
  { method: "PATCH", path: "/employees/:id", label: "變更員工角色或在職狀態", when: hasAnyKey(["role", "status", "user_id", "features"]) },
  { method: "POST", path: "/employees", label: "新增員工" },
  { method: "POST", path: "/employees/:id/deactivate", label: "停用員工帳號" },
  { method: "POST", path: "/employees/:id/reset-password", label: "重設員工密碼" },
  { method: "POST", path: "/employees/:id/send-reset", label: "寄送重設密碼信" },
  { method: "POST", path: "/employees/:id/invite", label: "寄送帳號邀請信" },
  { method: "POST", path: "/employees/bulk-invite", label: "批次寄送帳號邀請信" },
  { method: "POST", path: "/employees/assign-company", label: "批次變更員工所屬公司" },
  { method: "POST", path: "/admin/tenants", label: "建立新租戶" },
  // 薪資結構、假別額度
  { method: "PUT", path: "/salary/:employeeId", label: "修改員工薪資結構" },
  { method: "POST", path: "/salary-adjustments/import", label: "批次匯入薪資調整" },
  { method: "PUT", path: "/leave-balances", label: "覆寫假別額度" },
  { method: "POST", path: "/leave-balances/annual-grant", label: "發放年度特休" },
  { method: "POST", path: "/leave-balances/adjustments", label: "手動增減假別時數" },
  { method: "POST", path: "/comp-time/adjust", label: "調整補休時數" },
  // 規則／設定
  { method: "PUT", path: "/rule-config", label: "變更差勤／薪資規則參數" },
  { method: "PUT", path: "/approval-flows/:kind", label: "變更簽核流程" },
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
]

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/")
  return new RegExp(`^${escaped}/?$`)
}

const COMPILED = DANGEROUS_OPERATIONS.map((rule) => ({ rule, re: patternToRegExp(rule.path) }))

/** 這個呼叫是不是危險操作；是 → 回中文說明，否 → null。 */
export function dangerOf(method: string, path: string, body?: unknown): string | null {
  const m = method.toUpperCase()
  const hit = COMPILED.find(({ rule, re }) => rule.method === m && re.test(path) && (!rule.when || rule.when(body)))
  if (hit) return hit.rule.label
  if (m === "DELETE") return "刪除資料"
  return null
}

/** list_endpoints 用：靜態 pattern 是不是危險（不看 body；DELETE 一律是）。 */
export function isDangerousPattern(method: string, pattern: string): boolean {
  const m = method.toUpperCase()
  if (m === "DELETE") return true
  return DANGEROUS_OPERATIONS.some((rule) => rule.method === m && rule.path === pattern)
}
