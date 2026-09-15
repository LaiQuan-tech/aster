import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * C1 稽核「誰改的」— live 合約測試（仿 approval-chain-live.test.ts）。
 *
 * 驗的是整條鏈：requireHrAdmin 查到呼叫者 → setActor → supabaseAdmin 的 fetch
 * 夾 x-actor-emp-id／x-actor-route → PostgREST 放進 GUC request.headers →
 * DB trigger audit_row()（sql/0033 [A]）寫進 audit_logs.actor_emp_id／context。
 *
 * 另外驗查詢端 GET /audit-logs（diff、actorName、keyset cursor 不重不漏）與
 * /audit-logs/tables。正式庫尚未套 sql/0033（trigger 讀不到 header）時第一組
 * 案例會失敗——那正是要抓的。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""
const ready = !!SUPABASE_URL && !!SUPABASE_ANON_KEY

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let hrEmpId: string
let hrName: string
let hr2EmpId: string
let hr2Token: string
let targetId: string // 被改姓名的員工
let empToken: string // 一般員工（非 HR）

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
async function createEmployee(opts: { label: string; role: string }) {
  const email = `audit-${stamp}-${opts.label}@example.com`
  const password = `Pw-${stamp}-${opts.label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${opts.label}-${stamp}`,
    password,
    role: opts.role,
    empNo: `AU-${opts.label}`,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${opts.label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, email, password }
}

interface AuditRow {
  id: string
  at: string
  action: string
  actor_emp_id: string | null
  db_user: string | null
  context: string | null
  old_row: Record<string, unknown> | null
  new_row: Record<string, unknown> | null
}

/** 該 record 最新一列 **trigger 寫的** audit_logs（db_user 非空；應用層列沒有 db_user）。 */
async function latestTriggerLog(table: string, recordId: string): Promise<AuditRow> {
  const { data, error } = await supabaseAdmin
    .from("audit_logs")
    .select("id, at, action, actor_emp_id, db_user, context, old_row, new_row")
    .eq("tenant_id", tenantId)
    .eq("table_name", table)
    .eq("record_id", recordId)
    .not("db_user", "is", null)
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .single()
  if (error || !data) throw new Error(`latestTriggerLog: ${error?.message}`)
  return data as unknown as AuditRow
}

describe.skipIf(!ready)("C1 稽核記操作者 — live", () => {
  beforeAll(async () => {
    const adminEmail = `audit-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `AUDITTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin
      .from("employees")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("user_id", p.userId)
      .single()
    hrEmpId = hr!.id as string
    hrName = hr!.name as string

    const hr2 = await createEmployee({ label: "hr2", role: "hr_admin" })
    hr2EmpId = hr2.id
    hr2Token = await signIn(hr2.email, hr2.password)
    const target = await createEmployee({ label: "target", role: "employee" })
    targetId = target.id
    empToken = await signIn(target.email, target.password)
  }, 90_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      await supabaseAdmin.from("expense_claims").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("expense_categories").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("trigger 記操作者（request header → GUC → audit_row）", () => {
    it("HR 透過 API PATCH /employees/:id 改姓名 → 最新 trigger 列 actor_emp_id＝HR、context＝'PATCH /employees/:id'", async () => {
      const res = await as(adminToken, request(app).patch(`/employees/${targetId}`)).send({ name: `改名-${stamp}` })
      expect(res.status).toBe(200)

      const log = await latestTriggerLog("employees", targetId)
      expect(log.action).toBe("UPDATE")
      expect(log.actor_emp_id).toBe(hrEmpId)
      expect(log.context).toBe("PATCH /employees/:id")
      expect(log.old_row?.name).toBe(`target-${stamp}`)
      expect(log.new_row?.name).toBe(`改名-${stamp}`)
    })

    it("測試裡直接用 supabaseAdmin update（無請求情境）→ actor_emp_id／context 皆 null（不誤記）", async () => {
      const { error } = await supabaseAdmin
        .from("employees")
        .update({ name: `直改-${stamp}` })
        .eq("tenant_id", tenantId)
        .eq("id", targetId)
      expect(error).toBeNull()

      const log = await latestTriggerLog("employees", targetId)
      expect(log.new_row?.name).toBe(`直改-${stamp}`)
      expect(log.actor_emp_id).toBeNull()
      expect(log.context).toBeNull()
    })

    it("並發：兩個不同 HR token 同時 PATCH → 各自記到自己的 actor（AsyncLocalStorage 不串線）", async () => {
      const a = await createEmployee({ label: "ca", role: "employee" })
      const b = await createEmployee({ label: "cb", role: "employee" })
      const [ra, rb] = await Promise.all([
        as(adminToken, request(app).patch(`/employees/${a.id}`)).send({ name: `A-by-hr1-${stamp}` }),
        as(hr2Token, request(app).patch(`/employees/${b.id}`)).send({ name: `B-by-hr2-${stamp}` }),
      ])
      expect(ra.status).toBe(200)
      expect(rb.status).toBe(200)

      const [la, lb] = await Promise.all([latestTriggerLog("employees", a.id), latestTriggerLog("employees", b.id)])
      expect(la.new_row?.name).toBe(`A-by-hr1-${stamp}`)
      expect(la.actor_emp_id).toBe(hrEmpId)
      expect(lb.new_row?.name).toBe(`B-by-hr2-${stamp}`)
      expect(lb.actor_emp_id).toBe(hr2EmpId)
      expect(la.context).toBe("PATCH /employees/:id")
      expect(lb.context).toBe("PATCH /employees/:id")
    })

    it("POST /employees 建立時：trigger 的 INSERT 列記 actor；應用層另補一列（含 email、無 db_user）", async () => {
      const c = await createEmployee({ label: "created", role: "employee" })
      const trig = await latestTriggerLog("employees", c.id)
      expect(trig.action).toBe("INSERT")
      expect(trig.actor_emp_id).toBe(hrEmpId)
      expect(trig.context).toBe("POST /employees")

      const { data: appRows } = await supabaseAdmin
        .from("audit_logs")
        .select("actor_emp_id, context, new_row, db_user")
        .eq("tenant_id", tenantId)
        .eq("table_name", "employees")
        .eq("record_id", c.id)
        .is("db_user", null)
      expect(appRows).toHaveLength(1)
      expect(appRows![0].actor_emp_id).toBe(hrEmpId)
      expect(appRows![0].context).toBe("POST /employees — 建立員工帳號")
      expect((appRows![0].new_row as Record<string, unknown>).email).toBe(c.email)
    })

    it("員工自助路由的私有 resolveSelf 複本也補了 setActor（POST /expenses 建單，非 middleware/scope.ts 那條路）→ trigger 列 actor_emp_id＝該員工本人", async () => {
      const catRes = await as(adminToken, request(app).put("/expense-categories")).send({
        code: `AUDIT-${stamp}`,
        name: `稽核測試類別-${stamp}`,
        nature: "reimbursement",
      })
      expect(catRes.status).toBe(200)
      const categoryId = catRes.body.category.id as string

      const claimRes = await as(empToken, request(app).post("/expenses")).send({
        categoryId,
        amount: 123,
        incurredOn: "2026-02-10",
      })
      expect(claimRes.status).toBe(201)

      const log = await latestTriggerLog("expense_claims", claimRes.body.id as string)
      expect(log.action).toBe("INSERT")
      expect(log.actor_emp_id).toBe(targetId)
      expect(log.context).toBe("POST /expenses")
    })
  })

  describe("GET /audit-logs 查詢端", () => {
    it("非 HR → 403；HR 篩 table=employees&recordId= → 回該列，diff 含 name before/after、actorName＝HR 姓名", async () => {
      const denied = await as(empToken, request(app).get(`/audit-logs?table=employees&recordId=${targetId}`))
      expect(denied.status).toBe(403)

      const res = await as(adminToken, request(app).get(`/audit-logs?table=employees&recordId=${targetId}`))
      expect(res.status).toBe(200)
      const logs = res.body.logs as Array<Record<string, unknown>>
      expect(logs.length).toBeGreaterThanOrEqual(3) // INSERT（trigger）＋ INSERT（應用層）＋ 2 次 UPDATE
      for (const l of logs) expect(l.recordId).toBe(targetId)

      const byHr = logs.find((l) => l.context === "PATCH /employees/:id")!
      expect(byHr).toBeTruthy()
      expect(byHr.action).toBe("UPDATE")
      expect(byHr.tableLabel).toBe("員工")
      expect(byHr.source).toBe("trigger")
      expect(byHr.actorEmpId).toBe(hrEmpId)
      expect(byHr.actorName).toBe(hrName)
      expect(byHr.diff).toEqual([{ field: "name", label: "名稱／姓名", before: `target-${stamp}`, after: `改名-${stamp}` }])
      expect(byHr.summary).toBe(`更新員工「改名-${stamp}」：名稱／姓名`)

      const direct = logs.find((l) => l.context === null && l.action === "UPDATE")!
      expect(direct.actorEmpId).toBeNull()
      expect(direct.actorName).toBeNull()
      expect(direct.diff).toEqual([{ field: "name", label: "名稱／姓名", before: `改名-${stamp}`, after: `直改-${stamp}` }])

      // 依 actorEmpId／action 篩
      const mine = await as(adminToken, request(app).get(`/audit-logs?table=employees&actorEmpId=${hrEmpId}&action=UPDATE`))
      expect(mine.status).toBe(200)
      for (const l of mine.body.logs as Array<Record<string, unknown>>) {
        expect(l.actorEmpId).toBe(hrEmpId)
        expect(l.action).toBe("UPDATE")
      }
      // 不合法參數 → 400
      expect((await as(adminToken, request(app).get(`/audit-logs?action=UPSERT`))).status).toBe(400)
      expect((await as(adminToken, request(app).get(`/audit-logs?cursor=not-a-cursor`))).status).toBe(400)
    })

    it("cursor 翻頁不重不漏：60 筆（每 20 筆共用同一個 at，逼出 id tiebreaker）limit=25 翻三頁", async () => {
      const table = "audit_paging_test"
      const base = Date.parse("2026-01-01T00:00:00.000Z")
      const rows = Array.from({ length: 60 }, (_, i) => ({
        tenant_id: tenantId,
        table_name: table,
        record_id: crypto.randomUUID(),
        action: "UPDATE",
        old_row: { n: i - 1 },
        new_row: { n: i },
        at: new Date(base + Math.floor(i / 20) * 1000).toISOString(),
      }))
      const { error } = await supabaseAdmin.from("audit_logs").insert(rows)
      expect(error).toBeNull()

      const seen: string[] = []
      const ats: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const url = `/audit-logs?table=${table}&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
        const res = await as(adminToken, request(app).get(url))
        expect(res.status).toBe(200)
        const logs = res.body.logs as Array<{ id: string; at: string }>
        pages += 1
        expect(logs.length).toBe(pages < 3 ? 25 : 10)
        for (const l of logs) {
          seen.push(l.id)
          ats.push(l.at)
        }
        cursor = res.body.nextCursor as string | null
      } while (cursor)

      expect(pages).toBe(3)
      expect(seen).toHaveLength(60)
      expect(new Set(seen).size).toBe(60)
      // 全域遞減（at desc）
      for (let i = 1; i < ats.length; i++) expect(Date.parse(ats[i]) <= Date.parse(ats[i - 1])).toBe(true)
      // 與 DB 的集合一致
      const { data: all } = await supabaseAdmin.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("table_name", table)
      expect(new Set((all ?? []).map((r) => r.id as string))).toEqual(new Set(seen))
    })

    it("from/to（YYYY-MM-DD，租戶時區）與關鍵字 q 篩得到；GET /audit-logs/tables 含 employees 員工", async () => {
      const inRange = await as(adminToken, request(app).get(`/audit-logs?table=audit_paging_test&from=2026-01-01&to=2026-01-01&limit=200`))
      expect(inRange.status).toBe(200)
      expect(inRange.body.logs).toHaveLength(60)
      const outOfRange = await as(adminToken, request(app).get(`/audit-logs?table=audit_paging_test&from=2026-01-02&limit=200`))
      expect(outOfRange.body.logs).toHaveLength(0)

      const kw = await as(adminToken, request(app).get(`/audit-logs?table=employees&q=${encodeURIComponent(`直改-${stamp}`)}`))
      expect(kw.status).toBe(200)
      expect((kw.body.logs as Array<{ recordId: string }>).some((l) => l.recordId === targetId)).toBe(true)

      const tables = await as(adminToken, request(app).get("/audit-logs/tables"))
      expect(tables.status).toBe(200)
      const list = tables.body.tables as Array<{ table: string; label: string; recent: boolean }>
      expect(list.find((t) => t.table === "employees")).toMatchObject({ label: "員工", recent: true })
      // 對照表沒有的 table_name 也會被掃出來（fallback label＝原名）
      expect(list.find((t) => t.table === "audit_paging_test")).toMatchObject({ label: "audit_paging_test", recent: true })
    })
  })
})
