import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * A2 假單簽核鏈 — live 合約測試（仿 disbursements-live.test.ts）。
 *
 * 流程：部門（manager_emp_id=主管）＋主管＋員工 → 員工送假單 → 第 1 關＝主管、主管
 * 收到 submitted 通知 → 主管核准 → 申請人收到 approved、acted_by_emp_id=主管
 * → 再送一張 → 主管駁回 → rejected
 * → 無部門員工送單 → fallback（老闆）→ 清掉 fallback → 第一位 hr_admin
 * → mode=list 兩關名單 → 名單優先、第 1 關核准後推進並通知第 2 關（advanced）
 * → mode=manager 有名單也走主管 → HR 代簽 200 且 acted_by_emp_id=HR
 * → GET /requests/pending-approvals 只回輪到我簽的單並附申請人／假別／附件數。
 *
 * 正式庫尚未套 migration 0042（approval_flows.mode / approval_steps.acted_by_emp_id）
 * 時整組 describe.skipIf 跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const a = await supabaseAdmin.from("approval_flows").select("mode").limit(1)
  const b = await supabaseAdmin.from("approval_steps").select("acted_by_emp_id").limit(1)
  return !a.error && !b.error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let hrEmpId: string
let mgrId: string
let mgrToken: string
let bossId: string
let empId: string // 有部門（主管＝mgr）
let empToken: string
let loneId: string // 無部門
let loneToken: string
let deptId: string
let leaveTypeId: string

const START = "2026-10-05T01:00:00.000Z"
const END = "2026-10-05T09:00:00.000Z"

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
async function createEmployee(opts: { label: string; role: string; deptId?: string | null }) {
  const email = `chain-${stamp}-${opts.label}@example.com`
  const password = `Pw-${stamp}-${opts.label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${opts.label}-${stamp}`,
    password,
    role: opts.role,
    deptId: opts.deptId ?? null,
    empNo: `C-${opts.label}`,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${opts.label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, token: await signIn(email, password) }
}
async function fileLeave(token: string, reason: string) {
  const res = await as(token, request(app).post("/requests")).send({
    kind: "leave",
    leaveTypeId,
    startAt: START,
    endAt: END,
    hours: 8,
    reason,
  })
  return res
}
async function notificationsFor(employeeId: string, event: string, requestId: string) {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .select("id, employee_id, type, title, body, payload")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("type", "approval")
    .eq("payload->>event", event)
    .eq("payload->>requestId", requestId)
  if (error) throw new Error(`notifications: ${error.message}`)
  return data ?? []
}
async function stepsOf(requestId: string) {
  const { data, error } = await supabaseAdmin
    .from("approval_steps")
    .select("step_order, approver_emp_id, decision, acted_by_emp_id, comment")
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
    .order("step_order", { ascending: true })
  if (error) throw new Error(`steps: ${error.message}`)
  return data ?? []
}

describe.skipIf(!ready)("A2 簽核鏈 — live", () => {
  beforeAll(async () => {
    const adminEmail = `chain-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `CHAINTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("user_id", p.userId).single()
    hrEmpId = hr!.id as string

    const mgr = await createEmployee({ label: "mgr", role: "manager" })
    mgrId = mgr.id
    mgrToken = mgr.token
    const boss = await createEmployee({ label: "boss", role: "manager" })
    bossId = boss.id

    const dept = await as(adminToken, request(app).post("/departments")).send({ name: `設計部 ${stamp}`, managerEmpId: mgrId })
    expect(dept.status).toBe(201)
    deptId = dept.body.id

    const emp = await createEmployee({ label: "emp", role: "employee", deptId })
    empId = emp.id
    empToken = emp.token
    const lone = await createEmployee({ label: "lone", role: "employee" })
    loneId = lone.id
    loneToken = lone.token

    const lt = await as(adminToken, request(app).post("/leave-types")).send({ code: "annual", name: "特休", paid: true })
    expect(lt.status).toBe(201)
    leaveTypeId = lt.body.id
  }, 90_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_balances").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("request_attachments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("approval_steps").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_requests").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("approval_flows").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_types").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      // audit_logs 放在 employees 之後、tenants 之前：刪員工會再觸發 audit trigger 寫新列（employees 掛 audit_all），
      // 先刪 audit_logs 會留孤兒；tenants 刪掉後 is_disposable_tenant 回 false，append-only trigger 就不放行了。
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("departments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("直屬主管簽核 ＋ 每關通知", () => {
    let reqId: string

    it("員工送假單 → approval_steps[0].approver_emp_id＝部門主管；主管 notifications 多一列 submitted", async () => {
      const res = await fileLeave(empToken, "家中有事")
      expect(res.status).toBe(201)
      reqId = res.body.requestId
      expect(res.body.approvalSource).toBe("manager")
      expect(res.body.steps).toEqual([{ stepOrder: 1, approverEmpId: mgrId }])
      expect(res.body.notified).toBe(1)

      const steps = await stepsOf(reqId)
      expect(steps[0].approver_emp_id).toBe(mgrId)
      expect(steps[0].acted_by_emp_id).toBeNull()

      const n = await notificationsFor(mgrId, "submitted", reqId)
      expect(n).toHaveLength(1)
      expect(n[0].title).toContain(`emp-${stamp}`)
      expect(n[0].body).toContain("特休")
      expect(n[0].body).toContain("家中有事")
      expect(n[0].payload).toMatchObject({ event: "submitted", requestKind: "leave", currentStep: 1, employeeId: empId })
    })

    it("主管在 GET /requests/pending-approvals 看到這張單（含申請人／假別／附件數）；員工自己看是空的", async () => {
      const mine = await as(mgrToken, request(app).get("/requests/pending-approvals"))
      expect(mine.status).toBe(200)
      const row = (mine.body.requests as Array<Record<string, unknown>>).find((r) => r.id === reqId)!
      expect(row).toBeTruthy()
      expect(row.employee_name).toBe(`emp-${stamp}`)
      expect(row.employee_emp_no).toBe("C-emp")
      expect(row.department_name).toBe(`設計部 ${stamp}`)
      expect(row.leave_type_name).toBe("特休")
      expect(row.attachment_count).toBe(0)
      expect(row.total_steps).toBe(1)
      expect(row.current_approver_emp_id).toBe(mgrId)

      const own = await as(empToken, request(app).get("/requests/pending-approvals"))
      expect(own.status).toBe(200)
      expect(own.body.requests).toEqual([])
    })

    it("主管核准 → 申請人 notifications 多一列 approved；acted_by_emp_id＝主管", async () => {
      const res = await as(mgrToken, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "准" })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe("approved")
      expect(res.body.notified).toBe(1)

      const steps = await stepsOf(reqId)
      expect(steps[0]).toMatchObject({ decision: "approved", approver_emp_id: mgrId, acted_by_emp_id: mgrId })

      const n = await notificationsFor(empId, "approved", reqId)
      expect(n).toHaveLength(1)
      expect(n[0].title).toContain("已核准")
      expect(n[0].body).toContain("簽核意見：准")

      // 主管的待簽清單已空
      const mine = await as(mgrToken, request(app).get("/requests/pending-approvals"))
      expect((mine.body.requests as Array<{ id: string }>).some((r) => r.id === reqId)).toBe(false)
    })

    it("再送一張 → 主管駁回 → 申請人 notifications 多一列 rejected（含理由）", async () => {
      const filed = await fileLeave(empToken, "第二張")
      expect(filed.status).toBe(201)
      const id = filed.body.requestId as string
      const res = await as(mgrToken, request(app).post(`/requests/${id}/reject`)).send({ comment: "人力不足" })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe("rejected")
      const n = await notificationsFor(empId, "rejected", id)
      expect(n).toHaveLength(1)
      expect(n[0].body).toContain("駁回理由：人力不足")
      const steps = await stepsOf(id)
      expect(steps[0]).toMatchObject({ decision: "rejected", acted_by_emp_id: mgrId, comment: "人力不足" })
    })
  })

  describe("找不到主管的退路", () => {
    it("無部門員工 → fallback 簽核者（tenant features.approval.fallbackApproverEmpId）", async () => {
      const set = await as(adminToken, request(app).put("/api/tenant/settings")).send({
        features: { approval: { fallbackApproverEmpId: bossId } },
      })
      expect(set.status).toBe(200)
      expect(set.body.features.approval.fallbackApproverEmpId).toBe(bossId)

      const res = await fileLeave(loneToken, "無部門")
      expect(res.status).toBe(201)
      expect(res.body.approvalSource).toBe("fallback")
      expect(res.body.steps[0].approverEmpId).toBe(bossId)
      expect(await notificationsFor(bossId, "submitted", res.body.requestId)).toHaveLength(1)
    })

    it("fallback 也沒設 → 第一位 hr_admin", async () => {
      const clear = await as(adminToken, request(app).put("/api/tenant/settings")).send({
        features: { approval: { fallbackApproverEmpId: null } },
      })
      expect(clear.status).toBe(200)

      const res = await fileLeave(loneToken, "無部門無老闆")
      expect(res.status).toBe(201)
      expect(res.body.approvalSource).toBe("hr_admin")
      expect(res.body.steps[0].approverEmpId).toBe(hrEmpId)
    })

    it("features 不合法（fallbackApproverEmpId 非 uuid）→ 400", async () => {
      const bad = await as(adminToken, request(app).put("/api/tenant/settings")).send({
        features: { approval: { fallbackApproverEmpId: "boss" } },
      })
      expect(bad.status).toBe(400)
    })
  })

  describe("固定名單 vs 直屬主管模式", () => {
    let listReqId: string

    it("mode=list 且有名單 → 名單優先（兩關）；GET /approval-flows 回 mode", async () => {
      const put = await as(adminToken, request(app).put("/approval-flows/leave")).send({
        approverEmpIds: [mgrId, hrEmpId],
        mode: "list",
      })
      expect(put.status).toBe(200)
      expect(put.body.mode).toBe("list")
      const list = await as(adminToken, request(app).get("/approval-flows"))
      const flow = (list.body.flows as Array<{ applies_to: string; mode: string; approver_emp_ids: string[] }>).find((f) => f.applies_to === "leave")!
      expect(flow.mode).toBe("list")
      expect(flow.approver_emp_ids).toEqual([mgrId, hrEmpId])

      const res = await fileLeave(loneToken, "名單模式")
      expect(res.status).toBe(201)
      listReqId = res.body.requestId
      expect(res.body.approvalSource).toBe("list")
      expect(res.body.steps.map((s: { approverEmpId: string }) => s.approverEmpId)).toEqual([mgrId, hrEmpId])
    })

    it("第 1 關核准 → 仍 pending、推進第 2 關；第 2 關簽核者收到 advanced；第 2 關核准 → approved", async () => {
      const first = await as(mgrToken, request(app).post(`/requests/${listReqId}/approve`)).send({})
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({ status: "pending", currentStep: 2 })
      const adv = await notificationsFor(hrEmpId, "advanced", listReqId)
      expect(adv).toHaveLength(1)
      expect(adv[0].body).toContain("第 2 關，共 2 關")
      // 申請人此時還沒收到 approved
      expect(await notificationsFor(loneId, "approved", listReqId)).toHaveLength(0)

      const second = await as(adminToken, request(app).post(`/requests/${listReqId}/approve`)).send({})
      expect(second.status).toBe(200)
      expect(second.body.status).toBe("approved")
      expect(await notificationsFor(loneId, "approved", listReqId)).toHaveLength(1)
      const steps = await stepsOf(listReqId)
      expect(steps.map((s) => s.acted_by_emp_id)).toEqual([mgrId, hrEmpId])
    })

    it("mode=manager 即使名單還在 → 走直屬主管；省略 mode 的 PUT 保留既有 mode", async () => {
      const put = await as(adminToken, request(app).put("/approval-flows/leave")).send({
        approverEmpIds: [mgrId, hrEmpId],
        mode: "manager",
      })
      expect(put.status).toBe(200)
      expect(put.body.mode).toBe("manager")

      const keep = await as(adminToken, request(app).put("/approval-flows/leave")).send({ approverEmpIds: [hrEmpId] })
      expect(keep.status).toBe(200)
      expect(keep.body.mode).toBe("manager")

      const res = await fileLeave(empToken, "主管模式")
      expect(res.status).toBe(201)
      expect(res.body.approvalSource).toBe("manager")
      expect(res.body.steps).toEqual([{ stepOrder: 1, approverEmpId: mgrId }])
    })

    it("petty_cash 也可設定簽核流程；不合法 kind → 400", async () => {
      const ok = await as(adminToken, request(app).put("/approval-flows/petty_cash")).send({ approverEmpIds: [hrEmpId], mode: "list" })
      expect(ok.status).toBe(200)
      const bad = await as(adminToken, request(app).put("/approval-flows/bonus")).send({ approverEmpIds: [] })
      expect(bad.status).toBe(400)
    })
  })

  describe("HR 代簽", () => {
    it("HR 不是該關簽核者仍可核准（200），acted_by_emp_id＝HR 而非主管；非 HR 外人仍 403", async () => {
      const filed = await fileLeave(empToken, "HR 代簽")
      expect(filed.status).toBe(201)
      const id = filed.body.requestId as string
      expect(filed.body.steps[0].approverEmpId).toBe(mgrId)

      const outsider = await as(loneToken, request(app).post(`/requests/${id}/approve`)).send({})
      expect(outsider.status).toBe(403)
      expect(outsider.body.error).toBe("not_current_approver")

      const res = await as(adminToken, request(app).post(`/requests/${id}/approve`)).send({ comment: "主管出差，HR 代簽" })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe("approved")
      const steps = await stepsOf(id)
      expect(steps[0]).toMatchObject({ approver_emp_id: mgrId, acted_by_emp_id: hrEmpId, decision: "approved" })
      const n = await notificationsFor(empId, "approved", id)
      expect(n).toHaveLength(1)
      expect(n[0].payload).toMatchObject({ actedByEmpId: hrEmpId })
    })

    it("已核准的單再核准 → 409 not_pending；不存在 → 404", async () => {
      const filed = await fileLeave(empToken, "重複")
      const id = filed.body.requestId as string
      expect((await as(mgrToken, request(app).post(`/requests/${id}/approve`)).send({})).status).toBe(200)
      const again = await as(mgrToken, request(app).post(`/requests/${id}/approve`)).send({})
      expect(again.status).toBe(409)
      expect(again.body.error).toBe("not_pending")
      const missing = await as(mgrToken, request(app).post(`/requests/00000000-0000-4000-8000-000000000000/approve`)).send({})
      expect(missing.status).toBe(404)
    })
  })
})
