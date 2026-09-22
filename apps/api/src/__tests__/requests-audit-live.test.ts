import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * W10：申請單簽核的**應用層**稽核（throwaway 租戶的 live 合約測試）。
 *
 * DB trigger（sql/0019 audit_all）本來就會記 leave_requests 整列前後值，但記不到
 * 「為什麼」——簽核意見、駁回理由、第幾關、是不是 HR 代簽、撤回／註銷的理由。
 * 這支測試釘住的就是那一層：approve／reject／cancel／delete／change-approver
 * 各留一列 `audit_logs`，且 `new_row.comment` 有值。
 *
 * 與 trigger 寫的列區分：應用層列的 `new_row.decision` 一定有值（approved／
 * rejected／cancelled／deleted／change_approver），trigger 列沒有這個鍵。
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
let mgrId: string
let mgrToken: string
let empId: string
let empToken: string
let leaveTypeId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}

async function makeEmployee(label: string, role: string): Promise<{ id: string; token: string }> {
  const email = `reqaudit-${stamp}-${label}@example.com`
  const password = `Pw-${stamp}-${label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({ email, name: `${label}-${stamp}`, password, role })
  if (res.status !== 201) throw new Error(`makeEmployee(${label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, token: await signIn(email, password) }
}

interface AuditRow {
  action: string
  context: string | null
  actor_emp_id: string | null
  old_row: Record<string, unknown> | null
  new_row: Record<string, unknown> | null
}

/** 這張單的**應用層**稽核列（new_row.decision 有值的那些），依時間排序。 */
async function decisionAuditRows(requestId: string): Promise<AuditRow[]> {
  const { data, error } = await supabaseAdmin
    .from("audit_logs")
    .select("action, context, actor_emp_id, old_row, new_row, at")
    .eq("tenant_id", tenantId)
    .eq("table_name", "leave_requests")
    .eq("record_id", requestId)
    .order("at", { ascending: true })
  if (error) throw new Error(`audit_logs: ${error.message}`)
  return ((data ?? []) as unknown as Array<AuditRow & { at: string }>).filter(
    (r) => !!(r.new_row as Record<string, unknown> | null)?.decision,
  )
}

let day = 1
async function fileLeave(reason: string): Promise<string> {
  const d = String(day++).padStart(2, "0")
  const res = await as(empToken, request(app).post("/requests")).send({
    kind: "leave",
    leaveTypeId,
    startAt: `2027-08-${d}T01:00:00.000Z`,
    endAt: `2027-08-${d}T09:00:00.000Z`,
    hours: 8,
    reason,
  })
  expect(res.status).toBe(201)
  return res.body.requestId as string
}

describe.skipIf(!ready)("W10 申請單簽核稽核 — live", () => {
  beforeAll(async () => {
    const adminEmail = `reqaudit-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `REQAUDIT ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin
      .from("employees")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("user_id", p.userId)
      .single()
    hrEmpId = hr!.id as string

    const mgr = await makeEmployee("mgr", "manager")
    mgrId = mgr.id
    mgrToken = mgr.token
    const emp = await makeEmployee("emp", "employee")
    empId = emp.id
    empToken = emp.token

    const lt = await as(adminToken, request(app).post("/leave-types")).send({ code: "annual", name: "特休", paid: true })
    expect(lt.status).toBe(201)
    leaveTypeId = lt.body.id

    const flow = await as(adminToken, request(app).put("/approval-flows/leave")).send({
      approverEmpIds: [mgrId],
      mode: "list",
    })
    expect(flow.status).toBe(200)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      try {
        await purgeTestTenant(tid)
      } catch (err) {
        console.warn(`[requests-audit-live] purge ${tid} 失敗：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => undefined)
  }, 60_000)

  it("approve：留下一列 UPDATE，new_row 有 comment／decision／acted_by，old_row 是 pending", async () => {
    const reqId = await fileLeave("稽核-核准")
    const res = await as(mgrToken, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "同意，記得交接" })
    expect(res.status).toBe(200)

    const rows = await decisionAuditRows(reqId)
    expect(rows.length).toBe(1)
    expect(rows[0].action).toBe("UPDATE")
    expect(rows[0].actor_emp_id).toBe(mgrId)
    expect(rows[0].new_row?.status).toBe("approved")
    expect(rows[0].new_row?.decision).toBe("approved")
    expect(rows[0].new_row?.comment).toBe("同意，記得交接")
    expect(rows[0].new_row?.acted_by).toBe(mgrId)
    expect(rows[0].old_row?.status).toBe("pending")
    expect(rows[0].context).toContain("核准")
  })

  it("reject：留下一列，new_row.comment＝駁回理由", async () => {
    const reqId = await fileLeave("稽核-駁回")
    const res = await as(mgrToken, request(app).post(`/requests/${reqId}/reject`)).send({ comment: "當週人力不足" })
    expect(res.status).toBe(200)

    const rows = await decisionAuditRows(reqId)
    expect(rows.length).toBe(1)
    expect(rows[0].new_row?.status).toBe("rejected")
    expect(rows[0].new_row?.decision).toBe("rejected")
    expect(rows[0].new_row?.comment).toBe("當週人力不足")
    expect(rows[0].context).toContain("駁回")
  })

  it("HR 代簽核准：new_row.hrOverride=true，actor 是 HR 不是名義簽核人", async () => {
    const reqId = await fileLeave("稽核-代簽")
    const res = await as(adminToken, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "HR 代為核准" })
    expect(res.status).toBe(200)

    const rows = await decisionAuditRows(reqId)
    expect(rows.length).toBe(1)
    expect(rows[0].actor_emp_id).toBe(hrEmpId)
    expect(rows[0].new_row?.hrOverride).toBe(true)
    expect(rows[0].new_row?.acted_by).toBe(hrEmpId)
    expect(rows[0].context).toContain("HR 代簽")
  })

  it("cancel：申請人撤回並附理由 → new_row.comment 記理由；不附理由也成立", async () => {
    const withReason = await fileLeave("稽核-撤回")
    const res = await as(empToken, request(app).post(`/requests/${withReason}/cancel`)).send({ reason: "改請別天" })
    expect(res.status).toBe(200)
    const rows = await decisionAuditRows(withReason)
    expect(rows.length).toBe(1)
    expect(rows[0].actor_emp_id).toBe(empId)
    expect(rows[0].new_row?.status).toBe("cancelled")
    expect(rows[0].new_row?.decision).toBe("cancelled")
    expect(rows[0].new_row?.comment).toBe("改請別天")

    const noReason = await fileLeave("稽核-撤回2")
    const res2 = await as(empToken, request(app).post(`/requests/${noReason}/cancel`)).send({})
    expect(res2.status).toBe(200)
    const rows2 = await decisionAuditRows(noReason)
    expect(rows2.length).toBe(1)
    expect(rows2[0].new_row?.comment).toBeNull()
  })

  it("change-approver：HR 改簽核人 → new_row.decision='change_approver'，前後簽核人都記下來", async () => {
    const reqId = await fileLeave("稽核-換簽核人")
    const res = await as(adminToken, request(app).post(`/requests/${reqId}/change-approver`)).send({
      approverEmpId: hrEmpId,
      comment: "主管出差改由 HR 簽",
    })
    expect(res.status).toBe(200)

    const rows = await decisionAuditRows(reqId)
    expect(rows.length).toBe(1)
    expect(rows[0].new_row?.decision).toBe("change_approver")
    expect(rows[0].old_row?.approver_emp_id).toBe(mgrId)
    expect(rows[0].new_row?.approver_emp_id).toBe(hrEmpId)
    expect(rows[0].new_row?.comment).toBe("主管出差改由 HR 簽")
  })

  it("DELETE（軟刪除）：new_row.decision='deleted'，comment＝必填的註銷理由", async () => {
    const reqId = await fileLeave("稽核-註銷")
    const rejected = await as(mgrToken, request(app).post(`/requests/${reqId}/reject`)).send({ comment: "先駁回" })
    expect(rejected.status).toBe(200)

    const res = await as(adminToken, request(app).delete(`/requests/${reqId}`)).send({ reason: "重複送單" })
    expect(res.status).toBe(200)

    const rows = await decisionAuditRows(reqId)
    // 駁回一列 ＋ 註銷一列
    expect(rows.length).toBe(2)
    const del = rows[rows.length - 1]
    expect(del.new_row?.decision).toBe("deleted")
    expect(del.new_row?.comment).toBe("重複送單")
    expect(del.actor_emp_id).toBe(hrEmpId)
    expect(del.context).toContain("註銷")
  })

  it("多關簽核：推進那一關也留一列（context 寫明推進到第幾關）", async () => {
    const flow = await as(adminToken, request(app).put("/approval-flows/leave")).send({
      approverEmpIds: [mgrId, hrEmpId],
      mode: "list",
    })
    expect(flow.status).toBe(200)

    const reqId = await fileLeave("稽核-兩關")
    const step1 = await as(mgrToken, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "第一關同意" })
    expect(step1.status).toBe(200)
    expect(step1.body.status).toBe("pending")
    const step2 = await as(adminToken, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "第二關同意" })
    expect(step2.status).toBe(200)
    expect(step2.body.status).toBe("approved")

    const rows = await decisionAuditRows(reqId)
    expect(rows.length).toBe(2)
    expect(rows[0].new_row?.status).toBe("pending")
    expect(rows[0].new_row?.current_step).toBe(2)
    expect(rows[0].new_row?.comment).toBe("第一關同意")
    expect(rows[0].context).toContain("推進")
    expect(rows[1].new_row?.status).toBe("approved")
    expect(rows[1].new_row?.comment).toBe("第二關同意")
  })
})
