import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { dayWindowUtc, isDateKey } from "../lib/tz.js"
import {
  AUDIT_TABLE_LABELS,
  computeAuditDiff,
  recordLabelOf,
  summarizeAudit,
  tableLabel,
} from "../services/audit-labels.js"

/**
 * C1 稽核查詢（HR only）。讀的是 audit_logs——DB trigger `audit_row()` 寫的列
 * （改了什麼；sql/0033 起也記操作者與 route）＋應用層 writeAuditLog 補的列
 * （為什麼／哪支端點）。兩種來源以 `source` 區分：trigger 列有 db_user、應用層列沒有。
 *
 * 分頁用 keyset `(at desc, id desc)`，cursor 是 base64url 的 {at, id}：
 * 稽核表只增不改，keyset 翻頁不重不漏，也不會像 offset 那樣越翻越慢。
 * `at` 用 PostgREST 回傳的原字串（微秒精度）原樣帶回去比對，不能經過 JS Date
 * （毫秒精度會把同一毫秒內的列吃掉）。
 */
export const auditLogsRouter = Router()

const ACTIONS = ["INSERT", "UPDATE", "DELETE"] as const

const listSchema = z.object({
  table: z.string().trim().max(1000).optional(),
  recordId: z.string().uuid().optional(),
  action: z.enum(ACTIONS).optional(),
  actorEmpId: z.string().uuid().optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
})

const AUDIT_COLS = "id, at, table_name, record_id, action, old_row, new_row, actor_emp_id, db_user, context"

interface Cursor {
  at: string
  id: string
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url")
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>
    if (typeof parsed.at !== "string" || typeof parsed.id !== "string") return null
    if (!/^[0-9T:.+\-Z]+$/.test(parsed.at)) return null
    if (!/^[0-9a-f-]{36}$/i.test(parsed.id)) return null
    return { at: parsed.at, id: parsed.id }
  } catch {
    return null
  }
}

/** 'YYYY-MM-DD'（租戶時區當天）或 ISO datetime → UTC ISO 邊界；不合法回 undefined。 */
async function boundary(
  raw: string | undefined,
  edge: "from" | "to",
  tenantId: string,
): Promise<{ ok: true; iso?: string } | { ok: false }> {
  if (!raw) return { ok: true }
  if (isDateKey(raw)) {
    const tz = await getTenantTimezone(tenantId)
    const w = dayWindowUtc(raw, tz)
    return { ok: true, iso: edge === "from" ? w.startIso : w.endIso }
  }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return { ok: false }
  return { ok: true, iso: d.toISOString() }
}

/** or() 條件裡的字面值不能含逗號／括號／引號，否則會被當成語法；乾脆拿掉。 */
function keywordSafe(q: string): string {
  return q.replace(/[,()"'\\*%]/g, " ").replace(/\s+/g, " ").trim()
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /audit-logs?table=a,b&recordId=&action=&actorEmpId=&from=&to=&q=&limit=&cursor=
 */
auditLogsRouter.get(
  "/audit-logs",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = listSchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const p = parsed.data
    const tables = (p.table ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => /^[a-z_]+$/.test(t))
    const cursor = p.cursor ? decodeCursor(p.cursor) : null
    if (p.cursor && !cursor) {
      res.status(400).json({ error: "invalid_cursor" })
      return
    }

    try {
      const from = await boundary(p.from, "from", tenantId)
      const to = await boundary(p.to, "to", tenantId)
      if (!from.ok || !to.ok) {
        res.status(400).json({ error: "invalid_query", details: "from/to must be YYYY-MM-DD or ISO datetime" })
        return
      }

      let query = supabaseAdmin.from("audit_logs").select(AUDIT_COLS).eq("tenant_id", tenantId)
      if (tables.length) query = query.in("table_name", tables)
      if (p.recordId) query = query.eq("record_id", p.recordId)
      if (p.action) query = query.eq("action", p.action)
      if (p.actorEmpId) query = query.eq("actor_emp_id", p.actorEmpId)
      if (from.iso) query = query.gte("at", from.iso)
      // 'YYYY-MM-DD' 的 to 是「隔天 00:00」的開區間；ISO datetime 則含端點。
      if (to.iso) query = isDateKey(p.to) ? query.lt("at", to.iso) : query.lte("at", to.iso)

      const kw = p.q ? keywordSafe(p.q) : ""
      if (kw) {
        if (UUID_RE.test(kw)) {
          query = query.or(`record_id.eq.${kw},actor_emp_id.eq.${kw}`)
        } else {
          const like = `ilike.*${kw}*`
          query = query.or(
            [
              `context.${like}`,
              `new_row->>name.${like}`,
              `old_row->>name.${like}`,
              `new_row->>title.${like}`,
              `new_row->>code.${like}`,
              `new_row->>emp_no.${like}`,
              `new_row->>disbursement_no.${like}`,
              `new_row->>payee_name.${like}`,
              `new_row->>reason.${like}`,
            ].join(","),
          )
        }
      }
      if (cursor) {
        query = query.or(`at.lt.${cursor.at},and(at.eq.${cursor.at},id.lt.${cursor.id})`)
      }

      const { data, error } = await query
        .order("at", { ascending: false })
        .order("id", { ascending: false })
        .limit(p.limit + 1)
      if (error) {
        next(new Error(`GET /audit-logs: ${error.message}`))
        return
      }

      const rows = (data ?? []) as Array<Record<string, unknown>>
      const hasMore = rows.length > p.limit
      const page = hasMore ? rows.slice(0, p.limit) : rows
      const last = page[page.length - 1]
      const nextCursor = hasMore && last ? encodeCursor({ at: last.at as string, id: last.id as string }) : null

      // 操作者姓名：audit_logs 刻意不掛 FK，無法 embed，另查一次 employees。
      const actorIds = [...new Set(page.map((r) => r.actor_emp_id as string | null).filter((v): v is string => !!v))]
      const actorNames = new Map<string, { name: string; empNo: string | null }>()
      if (actorIds.length) {
        const { data: emps, error: empErr } = await supabaseAdmin
          .from("employees")
          .select("id, name, emp_no")
          .eq("tenant_id", tenantId)
          .in("id", actorIds)
        if (empErr) {
          next(new Error(`GET /audit-logs (actors): ${empErr.message}`))
          return
        }
        for (const e of emps ?? []) {
          actorNames.set(e.id as string, { name: e.name as string, empNo: (e.emp_no as string | null) ?? null })
        }
      }

      const logs = page.map((r) => {
        const action = r.action as string
        const table = r.table_name as string
        const diff = computeAuditDiff(action, r.old_row, r.new_row)
        const recordLabel = recordLabelOf(r.old_row, r.new_row)
        const actorEmpId = (r.actor_emp_id as string | null) ?? null
        const actor = actorEmpId ? actorNames.get(actorEmpId) : undefined
        return {
          id: r.id as string,
          at: r.at as string,
          tableName: table,
          tableLabel: tableLabel(table),
          recordId: (r.record_id as string | null) ?? null,
          recordLabel,
          action,
          actorEmpId,
          actorName: actor?.name ?? null,
          actorEmpNo: actor?.empNo ?? null,
          dbUser: (r.db_user as string | null) ?? null,
          source: r.db_user ? "trigger" : "app",
          context: (r.context as string | null) ?? null,
          summary: summarizeAudit(action, table, diff, recordLabel),
          diff,
        }
      })

      res.status(200).json({ logs, nextCursor })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /audit-logs/tables — 篩選器用的資料表清單（table_name ＋中文名）。
 *
 * PostgREST 沒有 DISTINCT，所以：已知對照表（AUDIT_TABLE_LABELS）全部列出，
 * 再掃該租戶最近 3000 列補上對照表沒有的 table_name（新掛 trigger 但還沒補
 * 對照的表），並回每個表在最近 3000 列內是否出現過（`recent`）讓前端把有資料的
 * 排前面。對照表裡有、但該租戶從沒動過的表也會列出——篩了只是查到空的，
 * 不會錯。
 */
auditLogsRouter.get(
  "/audit-logs/tables",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("audit_logs")
        .select("table_name")
        .eq("tenant_id", tenantId)
        .order("at", { ascending: false })
        .limit(3000)
      if (error) {
        next(new Error(`GET /audit-logs/tables: ${error.message}`))
        return
      }
      const recent = new Set((data ?? []).map((r) => r.table_name as string))
      const known = Object.keys(AUDIT_TABLE_LABELS)
      const extra = [...recent].filter((t) => !AUDIT_TABLE_LABELS[t]).sort()
      const tables = [...known, ...extra].map((t) => ({ table: t, label: tableLabel(t), recent: recent.has(t) }))
      res.status(200).json({ tables })
    } catch (err) {
      next(err)
    }
  },
)
