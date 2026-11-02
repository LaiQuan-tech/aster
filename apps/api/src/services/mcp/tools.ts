import type { RequestListener } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { viaLabel } from "../../lib/internal-identity.js"
import { writeAuditLog } from "../audit.js"
import { isBlockedPath, searchEndpoints } from "./catalog.js"
import { compactJson, filterByKeyword } from "./compact.js"
import { CONFIRM_TOKEN_TTL_SEC } from "./config.js"
import { sha256Hex, stableStringify } from "./crypto.js"
import { dangerOf } from "./danger.js"
import { dispatchAsUser, type DispatchResult } from "./dispatch.js"
import type { McpIdentity } from "./identity.js"
import { consumeConfirmation, createConfirmation } from "./store.js"

/**
 * MCP 工具（2026-11-02）。所有工具最後都走 runApi()：
 *   路徑檢查（擋 OAuth／金鑰／內部端點）→ 危險操作二段確認 → dispatchAsUser（以本人身分打既有 route）
 *   → 寫入類記 audit_logs（table_name='mcp_calls'，via=mcp＋用戶端名稱）→ 回應精簡。
 * 權限一律由既有 route 判斷（403 原樣回給 AI），這裡不另寫任何權限規則。
 */

export const SERVER_NAME = "aster-hr"
export const SERVER_VERSION = "1.0.0"

export interface ToolContext {
  app: RequestListener
  identity: McpIdentity
}

export interface ApiCall {
  method: string
  path: string
  query?: Record<string, unknown>
  body?: unknown
}

type Paging = { limit?: number; offset?: number }

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
}

/** path 只能是站內相對路徑：/ 開頭、不含 ?#、..、//、反斜線或控制字元。 */
export function validatePath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 300) return "path 必須以 / 開頭（例：/requests）"
  if (/[?#\\\s]/.test(path) || path.includes("..") || path.includes("//")) return "path 不可含 ?、#、..、// 或空白；查詢參數請放 query"
  if (/[\x00-\x1f\x7f]/.test(path)) return "path 含不合法字元"
  if (isBlockedPath(path)) return "這個端點不開放經 MCP 呼叫（OAuth／金鑰管理／內部排程／密碼）"
  return null
}

function argsHashOf(call: ApiCall): string {
  return sha256Hex(
    stableStringify({ method: call.method.toUpperCase(), path: call.path, query: call.query ?? {}, body: call.body ?? null }),
  )
}

function describeCall(call: ApiCall): string {
  const parts = [`${call.method.toUpperCase()} ${call.path}`]
  if (call.query && Object.keys(call.query).length) parts.push(`query=${JSON.stringify(call.query)}`)
  if (call.body !== undefined) {
    const body = JSON.stringify(call.body)
    parts.push(`body=${body.length > 1500 ? `${body.slice(0, 1500)}…` : body}`)
  }
  return parts.join("\n")
}

function formatResult(result: DispatchResult, paging: Paging, prefix?: string): CallToolResult {
  const isError = result.status >= 400
  const head = `HTTP ${result.status}${prefix ? `｜${prefix}` : ""}`
  if (result.binary) {
    return textResult(
      `${head}\n回應是檔案（${result.contentType}，${result.binary.bytes} bytes${result.binary.filename ? `，${result.binary.filename}` : ""}）。檔案請到後台下載，MCP 不傳二進位內容。`,
      isError,
    )
  }
  if (result.json !== undefined) {
    const { text, notes } = compactJson(result.json, paging)
    return textResult(`${head}${notes.length ? `\n※ ${notes.join("\n※ ")}` : ""}\n${text}`, isError)
  }
  return textResult(`${head}\n${result.text ?? ""}`, isError)
}

/**
 * 所有工具的共同出口。`tool` 只是稽核紀錄用的名稱。
 * 危險操作：沒帶 confirm_token → 回預覽與新 token；帶了 → 驗證（一次性、5 分鐘、同參數）才執行。
 */
export async function runApi(
  ctx: ToolContext,
  tool: string,
  call: ApiCall,
  opts: { confirmToken?: string; paging?: Paging; transform?: (json: unknown) => unknown } = {},
): Promise<CallToolResult> {
  const method = call.method.toUpperCase()
  if (!(METHODS as readonly string[]).includes(method)) return textResult(`不支援的 method：${call.method}`, true)
  const pathError = validatePath(call.path)
  if (pathError) return textResult(pathError, true)
  const normalized: ApiCall = { ...call, method }
  const { identity } = ctx

  const danger = dangerOf(method, call.path, call.body)
  if (danger) {
    const argsHash = argsHashOf(normalized)
    if (!opts.confirmToken) {
      const { token, expiresAt } = await createConfirmation({
        grant_id: identity.grant.id,
        user_id: identity.user.userId,
        tenant_id: identity.tenantId,
        args_hash: argsHash,
        summary: `${danger}｜${method} ${call.path}`.slice(0, 500),
      })
      return textResult(
        [
          `⚠️ 危險操作，尚未執行：${danger}`,
          `將以「${identity.employeeName ?? "你"}」本人的身分（後台權限照舊）執行：`,
          describeCall(normalized),
          "",
          `請先向使用者確認。確定要執行時，在 ${CONFIRM_TOKEN_TTL_SEC / 60} 分鐘內（到 ${expiresAt}）以「完全相同的參數」再呼叫一次 ${tool}，並帶 confirm_token="${token}"。`,
          "confirm_token 只能用一次；參數有任何不同都會失效，需要重新預覽。",
        ].join("\n"),
      )
    }
    const verdict = await consumeConfirmation(opts.confirmToken, {
      grantId: identity.grant.id,
      userId: identity.user.userId,
      argsHash,
    })
    if (!verdict.ok) {
      const why = { invalid: "無效或已使用過", expired: "已過期", mismatch: "與預覽時的參數不同（token 已作廢）" }[verdict.reason]
      return textResult(`未執行：confirm_token ${why}。請不帶 confirm_token 重新呼叫以取得新的預覽。`, true)
    }
  }

  const result = await dispatchAsUser(ctx.app, identity.user, identity.clientName, normalized)

  if (method !== "GET") {
    const via = viaLabel(identity.clientName)
    await writeAuditLog({
      tenantId: identity.tenantId,
      tableName: "mcp_calls",
      action: "INSERT",
      actorEmpId: identity.employeeId,
      context: `[mcp:${via}] ${method} ${call.path}`,
      newRow: {
        via: "mcp",
        client: identity.clientName,
        grant_id: identity.grant.id,
        grant_kind: identity.grant.kind,
        tool,
        method,
        path: call.path,
        status: result.status,
        confirmed: !!danger,
      },
    })
  }

  if (opts.transform && result.status < 400 && result.json !== undefined) {
    return formatResult({ ...result, json: opts.transform(result.json) }, opts.paging ?? {}, danger ? `已執行：${danger}` : undefined)
  }
  return formatResult(result, opts.paging ?? {}, danger ? `已執行：${danger}` : undefined)
}

// ── 參數 schema 片段 ───────────────────────────────────────────────────

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "格式 YYYY-MM-DD")
const period = z.string().regex(/^\d{4}-\d{2}$/, "格式 YYYY-MM")
const id = z.string().min(1).max(100)
const paging = {
  limit: z.number().int().min(1).max(200).optional().describe("每頁筆數（預設 50）"),
  offset: z.number().int().min(0).optional().describe("從第幾筆開始（翻頁用）"),
}
const confirmToken = z.string().max(200).optional().describe("危險操作第二次呼叫時帶入預覽回傳的 confirm_token")
const decision = z.enum(["approve", "reject"]).describe("approve＝核准，reject＝駁回")
const seg = (value: string) => encodeURIComponent(value)

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in row) out[k] = row[k]
  return out
}

function rowsOf(json: unknown, key: string): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>
  const inner = (json as Record<string, unknown> | null)?.[key]
  return Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : []
}

const READ = { readOnlyHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const
const DANGER = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const

/** 建一個綁定本次呼叫者身分的 MCP server（stateless：每個 HTTP 請求一個）。 */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "這是亞斯特 HR／薪資／專案分潤系統。你以使用者本人的身分操作，權限與他在後台完全相同；被拒絕（403）代表他本人就沒有這個權限，請直接告知，不要嘗試繞過。",
        "先用高階工具；找不到合適的再用 list_endpoints 查端點、call_api 呼叫。",
        "標示危險的操作（薪資結算、放款、獎金發放、刪除、權限與規則變更…）第一次呼叫只會回預覽與 confirm_token，必須先向使用者確認後才帶 token 再呼叫一次。",
        "回應會分頁／截斷，請用 limit／offset 或篩選條件縮小範圍；避免無必要地大量列出個資。",
      ].join("\n"),
    },
  )

  const reg = <S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    shape: S,
    annotations: Record<string, boolean>,
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<CallToolResult>,
  ) => {
    server.registerTool(name, { title, description, inputSchema: shape, annotations: { title, ...annotations } }, (async (
      args: z.objectOutputType<S, z.ZodTypeAny>,
    ) => {
      try {
        return await handler(args)
      } catch (err) {
        return textResult(`工具執行失敗：${err instanceof Error ? err.message : String(err)}`, true)
      }
    }) as never)
  }

  reg("whoami", "我是誰", "查目前連線的身分：姓名、角色、公司與可用功能（GET /me）。", {}, READ, async () =>
    runApi(ctx, "whoami", { method: "GET", path: "/me" }),
  )

  reg(
    "search_employees",
    "查員工",
    "依姓名／員編／部門等關鍵字查員工名冊（需財務層以上權限）。只回精簡欄位：id、姓名、員編、角色、部門、在職狀態、到職日、所屬公司。",
    {
      keyword: z.string().max(100).optional().describe("關鍵字（姓名、員編…，空白分隔＝都要符合）"),
      status: z.enum(["active", "inactive", "all"]).optional().describe("在職狀態，預設 active"),
      ...paging,
    },
    READ,
    async (a) =>
      runApi(ctx, "search_employees", { method: "GET", path: "/employees" }, {
        paging: a,
        transform: (json) => {
          const status = a.status ?? "active"
          const rows = rowsOf(json, "employees")
            .filter((r) => status === "all" || (status === "active" ? (r.status ?? "active") === "active" : (r.status ?? "active") !== "active"))
            .map((r) => pick(r, ["id", "name", "emp_no", "role", "dept_id", "status", "hire_date", "terminated_at", "company_name", "employment_type"]))
          return { employees: filterByKeyword(rows, a.keyword) }
        },
      }),
  )

  reg(
    "get_employee_profile",
    "員工個人資料",
    "查單一員工的個人資料（學經歷、證照等；欄位範圍依你的權限）。",
    { employeeId: id.describe("員工 id（search_employees 取得）") },
    READ,
    async (a) => runApi(ctx, "get_employee_profile", { method: "GET", path: `/employees/${seg(a.employeeId)}/profile` }),
  )

  reg("list_departments", "部門清單", "列出所有部門與主管。", { ...paging }, READ, async (a) =>
    runApi(ctx, "list_departments", { method: "GET", path: "/departments" }, { paging: a }),
  )

  reg(
    "list_punches",
    "查打卡紀錄",
    "查打卡紀錄（一般員工只看得到自己）。",
    { employeeId: id.optional(), deptId: id.optional(), from: dateKey.optional(), to: dateKey.optional(), ...paging },
    READ,
    async (a) =>
      runApi(ctx, "list_punches", {
        method: "GET",
        path: "/punch",
        query: { employeeId: a.employeeId, deptId: a.deptId, from: a.from, to: a.to },
      }, { paging: a }),
  )

  reg(
    "punch_overview",
    "出勤當日總覽",
    "某天（或一段期間）全公司／部門的打卡總覽：誰到了、誰沒打卡、遲到早退。",
    { date: dateKey.optional().describe("單日，預設今天"), from: dateKey.optional(), to: dateKey.optional(), deptId: id.optional(), employeeId: id.optional(), ...paging },
    READ,
    async (a) =>
      runApi(ctx, "punch_overview", {
        method: "GET",
        path: "/attendance/punch-overview",
        query: { date: a.date, from: a.from, to: a.to, deptId: a.deptId, employeeId: a.employeeId },
      }, { paging: a }),
  )

  reg(
    "attendance_anomalies",
    "出勤異常",
    "查期間內的出勤異常（缺卡、遲到、早退等；HR 權限）。",
    { from: dateKey.optional(), to: dateKey.optional(), ...paging },
    READ,
    async (a) => runApi(ctx, "attendance_anomalies", { method: "GET", path: "/attendance/anomalies", query: { from: a.from, to: a.to } }, { paging: a }),
  )

  reg(
    "list_requests",
    "查申請單",
    "查請假／加班／補打卡／出差／零用金／居家辦公申請單。HR 看全公司，其他人看自己的與輪到自己簽的。",
    {
      status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
      kind: z.enum(["leave", "ot", "fix_punch", "business_trip", "petty_cash", "wfh"]).optional().describe("leave 請假、ot 加班、fix_punch 補打卡、business_trip 出差、petty_cash 零用金、wfh 居家"),
      employeeId: id.optional(),
      from: dateKey.optional(),
      to: dateKey.optional(),
      mine: z.boolean().optional().describe("true＝只看我自己送的"),
      ...paging,
    },
    READ,
    async (a) =>
      runApi(ctx, "list_requests", {
        method: "GET",
        path: "/requests",
        query: { status: a.status, kind: a.kind, employeeId: a.employeeId, from: a.from, to: a.to, scope: a.mine ? "mine" : undefined },
      }, { paging: a }),
  )

  reg(
    "my_pending_approvals",
    "待我簽核",
    "列出目前輪到我簽核的項目：申請單、放款單、獎金批次。",
    { ...paging },
    READ,
    async (a) => {
      const sections: Array<[string, string]> = [
        ["申請單", "/requests/pending-approvals"],
        ["放款單", "/disbursements/pending-approvals"],
        ["獎金批次", "/my/bonus-approvals"],
      ]
      const parts: string[] = []
      let anyError = true
      for (const [label, path] of sections) {
        const r = await runApi(ctx, "my_pending_approvals", { method: "GET", path }, { paging: a })
        if (!r.isError) anyError = false
        const text = (r.content[0] as { text: string }).text
        parts.push(`## ${label}\n${r.isError && text.startsWith("HTTP 403") ? "（你沒有這類簽核權限）" : text}`)
      }
      return textResult(parts.join("\n\n"), anyError)
    },
  )

  reg(
    "decide_request",
    "簽核申請單",
    "核准或駁回一張申請單（請假／加班／補卡等）。規則同後台：只能簽輪到你的關卡、不能簽自己的單。",
    { requestId: id, decision, comment: z.string().max(500).optional().describe("簽核意見（駁回建議填）") },
    WRITE,
    async (a) =>
      runApi(ctx, "decide_request", {
        method: "POST",
        path: `/requests/${seg(a.requestId)}/${a.decision}`,
        body: a.comment ? { comment: a.comment } : {},
      }),
  )

  reg(
    "batch_decide_requests",
    "批次簽核申請單",
    "一次核准或駁回多張申請單（最多 100 張）。屬危險操作：第一次回預覽與 confirm_token，確認後帶 token 再呼叫。",
    { requestIds: z.array(id).min(1).max(100), decision, comment: z.string().max(500).optional(), confirm_token: confirmToken },
    DANGER,
    async (a) =>
      runApi(ctx, "batch_decide_requests", {
        method: "POST",
        path: "/requests/batch-decision",
        body: { ids: a.requestIds, action: a.decision, ...(a.comment ? { comment: a.comment } : {}) },
      }, { confirmToken: a.confirm_token }),
  )

  reg(
    "leave_balances",
    "假別餘額",
    "查假別剩餘時數。帶 employeeId 看單人明細，不帶看全公司總覽（一人一列）。",
    { employeeId: id.optional(), year: z.number().int().min(2000).max(2100).optional(), ...paging },
    READ,
    async (a) =>
      a.employeeId
        ? runApi(ctx, "leave_balances", { method: "GET", path: `/leave-balances/employees/${seg(a.employeeId)}`, query: { year: a.year } }, { paging: a })
        : runApi(ctx, "leave_balances", { method: "GET", path: "/leave-balances/overview", query: { year: a.year } }, { paging: a }),
  )

  reg(
    "list_projects",
    "查專案",
    "查專案清單（可依年度、關鍵字篩選）。",
    { year: z.number().int().min(2000).max(2100).optional(), includeArchived: z.boolean().optional(), keyword: z.string().max(100).optional(), ...paging },
    READ,
    async (a) =>
      runApi(ctx, "list_projects", { method: "GET", path: "/projects", query: { year: a.year, includeArchived: a.includeArchived ? "1" : undefined } }, {
        paging: a,
        transform: a.keyword
          ? (json) => {
              const rows = rowsOf(json, "projects")
              return Array.isArray(json) ? filterByKeyword(rows, a.keyword) : { ...(json as object), projects: filterByKeyword(rows, a.keyword) }
            }
          : undefined,
      }),
  )

  reg(
    "get_project",
    "專案明細",
    "查單一專案；可加查請款、合約、成員、複委託。",
    {
      projectId: id,
      include: z.array(z.enum(["billings", "contracts", "members", "subcontracts", "adjustments"])).optional().describe("要一起查的子資料"),
    },
    READ,
    async (a) => {
      const parts = [await runApi(ctx, "get_project", { method: "GET", path: `/projects/${seg(a.projectId)}` })]
      for (const sub of a.include ?? []) parts.push(await runApi(ctx, "get_project", { method: "GET", path: `/projects/${seg(a.projectId)}/${sub}` }))
      const labels = ["專案", ...(a.include ?? [])]
      return textResult(
        parts.map((p, i) => `## ${labels[i]}\n${(p.content[0] as { text: string }).text}`).join("\n\n"),
        !!parts[0]?.isError,
      )
    },
  )

  reg(
    "list_disbursements",
    "查放款單",
    "查放款單（請款付款）清單。",
    { from: dateKey.optional(), to: dateKey.optional(), status: z.string().max(40).optional(), q: z.string().max(100).optional().describe("關鍵字"), ...paging },
    READ,
    async (a) =>
      runApi(ctx, "list_disbursements", { method: "GET", path: "/disbursements", query: { from: a.from, to: a.to, status: a.status, q: a.q } }, { paging: a }),
  )

  reg("get_disbursement", "放款單明細", "查單一放款單。", { disbursementId: id }, READ, async (a) =>
    runApi(ctx, "get_disbursement", { method: "GET", path: `/disbursements/${seg(a.disbursementId)}` }),
  )

  reg(
    "decide_disbursement",
    "簽核放款單",
    "核准或駁回放款單（簽核，不是付款；付款請用 call_api 的 /disbursements/:id/pay，屬危險操作）。",
    { disbursementId: id, decision, comment: z.string().max(500).optional() },
    WRITE,
    async (a) =>
      runApi(ctx, "decide_disbursement", {
        method: "POST",
        path: `/disbursements/${seg(a.disbursementId)}/${a.decision}`,
        body: a.comment ? { comment: a.comment } : {},
      }),
  )

  reg(
    "list_payslips",
    "查薪資單",
    "查薪資單。HR 可看全公司（可帶 employeeId），其他人只看得到自己的。",
    { period: period.optional().describe("YYYY-MM"), employeeId: id.optional(), mine: z.boolean().optional(), ...paging },
    READ,
    async (a) =>
      runApi(ctx, "list_payslips", {
        method: "GET",
        path: "/payslips",
        query: { period: a.period, employeeId: a.employeeId, scope: a.mine ? "mine" : undefined },
      }, { paging: a }),
  )

  reg("payroll_checklist", "發薪前檢查", "查某月發薪前的檢查清單（月表、薪資單、加減項是否就緒）。", { period }, READ, async (a) =>
    runApi(ctx, "payroll_checklist", { method: "GET", path: `/payroll-periods/${seg(a.period)}/checklist` }),
  )

  reg(
    "get_report",
    "報表",
    "查報表：attendance 出勤、payroll 薪資、leave 請假、headcount 人力、unapproved-overtime 未核准加班（HR 權限）。",
    {
      type: z.enum(["attendance", "payroll", "leave", "headcount", "unapproved-overtime"]),
      from: dateKey.optional(),
      to: dateKey.optional(),
      period: period.optional(),
      deptId: id.optional(),
      ...paging,
    },
    READ,
    async (a) =>
      runApi(ctx, "get_report", {
        method: "GET",
        path: `/reports/${a.type}`,
        query: { from: a.from, to: a.to, period: a.period, deptId: a.deptId },
      }, { paging: a }),
  )

  reg("list_bonus_runs", "獎金批次", "查獎金季發放批次清單。", { year: z.number().int().min(2000).max(2100).optional(), ...paging }, READ, async (a) =>
    runApi(ctx, "list_bonus_runs", { method: "GET", path: "/bonus-runs", query: { year: a.year } }, { paging: a }),
  )

  reg(
    "search_audit_logs",
    "稽核紀錄",
    "查稽核紀錄（HR 權限）。經 MCP 的操作 context 會標 [mcp:用戶端]，table=mcp_calls 可只看 MCP 操作。",
    {
      table: z.string().max(200).optional().describe("資料表名，逗號分隔"),
      recordId: id.optional(),
      actorEmpId: id.optional(),
      action: z.enum(["INSERT", "UPDATE", "DELETE"]).optional(),
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      q: z.string().max(100).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().max(400).optional(),
    },
    READ,
    async (a) =>
      runApi(ctx, "search_audit_logs", {
        method: "GET",
        path: "/audit-logs",
        query: { table: a.table, recordId: a.recordId, actorEmpId: a.actorEmpId, action: a.action, from: a.from, to: a.to, q: a.q, limit: a.limit, cursor: a.cursor },
      }),
  )

  reg("my_notifications", "我的通知", "查寄給我的通知。", { unread: z.boolean().optional(), ...paging }, READ, async (a) =>
    runApi(ctx, "my_notifications", { method: "GET", path: "/notifications", query: { scope: "mine", unread: a.unread ? "1" : undefined } }, { paging: a }),
  )

  reg(
    "list_endpoints",
    "列出可用 API",
    "列出系統所有 API 端點與說明（可依關鍵字、method 篩選），搭配 call_api 使用。標 ⚠️ 的是危險操作（需二段確認）。能不能用仍以你的後台權限為準。",
    {
      keyword: z.string().max(100).optional().describe("關鍵字（路徑或中文說明，例：放款、payroll、請假）"),
      method: z.enum(METHODS).optional(),
      offset: z.number().int().min(0).optional(),
    },
    READ,
    async (a) => {
      const all = searchEndpoints(ctx.app, { keyword: a.keyword, method: a.method })
      const offset = a.offset ?? 0
      const page = all.slice(offset, offset + 80)
      const lines = page.map((e) => `${e.dangerous ? "⚠️ " : ""}${e.method} ${e.path} — ${e.desc}`)
      const more = offset + page.length < all.length ? `\n…還有 ${all.length - offset - page.length} 筆，帶 offset=${offset + page.length} 看下一頁` : ""
      return textResult(`共 ${all.length} 個端點${a.keyword ? `（關鍵字：${a.keyword}）` : ""}\n${lines.join("\n")}${more}`)
    },
  )

  reg(
    "call_api",
    "呼叫任一 API",
    "以你本人的身分呼叫任一既有 API（路徑用 list_endpoints 查，:id 請代入實際值）。權限、業務規則與後台完全相同。危險操作第一次只回預覽與 confirm_token，確認後帶 token 以相同參數再呼叫。檔案下載類端點只回檔案資訊。",
    {
      method: z.enum(METHODS),
      path: z.string().max(300).describe("例：/requests/<id>/approve（不含 query string）"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("查詢參數"),
      body: z.unknown().optional().describe("JSON body（POST/PUT/PATCH）"),
      confirm_token: confirmToken,
      ...paging,
    },
    DANGER,
    async (a) =>
      runApi(ctx, "call_api", { method: a.method, path: a.path, query: a.query, body: a.body }, {
        confirmToken: a.confirm_token,
        paging: { limit: a.limit, offset: a.offset },
      }),
  )

  return server
}
