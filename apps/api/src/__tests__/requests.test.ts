import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

interface Tenant {
  name: string
  tenantId: string
  adminEmail: string
  adminPassword: string
  adminToken: string
  // The hr_admin's own employee row id in this tenant (provisionTenant creates it).
  hrEmpId: string
}

let A: Tenant
let B: Tenant

// Tenant A cast:
//   emp1 — the protagonist who files requests (role 'employee').
//   mgr  — first-line approver (role 'manager').
//   emp2 — an unrelated third employee; must never see emp1's requests.
let emp1Id: string
let emp1Token: string
let mgrId: string
let mgrToken: string
let emp2Token: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) {
    throw new Error(`signIn(${email}) failed: ${error?.message}`)
  }
  return data.session.access_token
}

async function buildTenant(label: string): Promise<Tenant> {
  const name = `REQTEST ${label} ${stamp}`
  const adminEmail = `req-${stamp}-${label}-admin@example.com`
  const adminPassword = `Pw-${stamp}-${label}-Aa1!`

  const { tenantId, userId } = await provisionTenant({ name, adminEmail, adminPassword })
  createdTenantIds.push(tenantId)
  createdUserIds.push(userId)

  const adminToken = await signIn(adminEmail, adminPassword)

  // Resolve the admin's own employee row id (provisionTenant seeds it as hr_admin).
  const { data: hrEmp, error: hrErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .single()
  if (hrErr || !hrEmp) {
    throw new Error(`buildTenant(${label}): resolve hr employee failed: ${hrErr?.message}`)
  }

  return { name, tenantId, adminEmail, adminPassword, adminToken, hrEmpId: hrEmp.id as string }
}

// Create an employee with a real auth user (so they have a token) under a tenant.
async function createEmployee(
  adminToken: string,
  email: string,
  password: string,
  name: string,
  role: string,
): Promise<{ employeeId: string; token: string }> {
  const res = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, name, password, role })
  if (res.status !== 201) {
    throw new Error(`createEmployee(${email}) failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  createdUserIds.push(res.body.userId)
  const token = await signIn(email, password)
  return { employeeId: res.body.employeeId, token }
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run requests test")
  }

  A = await buildTenant("A")
  B = await buildTenant("B")

  const e1 = await createEmployee(
    A.adminToken,
    `req-${stamp}-a-emp1@example.com`,
    `Pw-${stamp}-emp1-Bb2!`,
    "Alice One",
    "employee",
  )
  emp1Id = e1.employeeId
  emp1Token = e1.token

  const m = await createEmployee(
    A.adminToken,
    `req-${stamp}-a-mgr@example.com`,
    `Pw-${stamp}-mgr-Cc3!`,
    "Mona Manager",
    "manager",
  )
  mgrId = m.employeeId
  mgrToken = m.token

  const e2 = await createEmployee(
    A.adminToken,
    `req-${stamp}-a-emp2@example.com`,
    `Pw-${stamp}-emp2-Dd4!`,
    "Bob Two",
    "employee",
  )
  emp2Token = e2.token
}, 60_000)

afterAll(async () => {
  // comp_time_ledger / leave_balances → approval_steps → leave_requests →
  // approval_flows → leave_types → employees → tenants → auth users (FK order).
  // The ledger rows are written by approval side-effects (a final approval of a
  // leave/OT request) and reference leave_requests/leave_types/employees, so
  // they must be cleared before those parents.
  // 送單／簽核會寫 notifications（FK → employees），要先於 employees 清掉。
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("comp_time_ledger").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("leave_balances").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("request_attachments").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("approval_steps").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("leave_requests").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("approval_flows").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("leave_types").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("punch_records").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(uid)
  }
}, 60_000)

// Shared across tests within a tenant's lifecycle.
let annualTypeId: string

describe("F4 leave_types — HR manages the catalogue", () => {
  it("HR POST /leave-types creates 'annual'; GET lists it", async () => {
    const res = await request(app)
      .post("/leave-types")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ code: "annual", name: "特休", paid: true })

    expect(res.status).toBe(201)
    expect(typeof res.body.id).toBe("string")
    annualTypeId = res.body.id

    const list = await request(app)
      .get("/leave-types")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(list.status).toBe(200)
    const types = list.body.leaveTypes as Array<{ id: string; code: string; tenant_id: string }>
    expect(types.some((t) => t.id === annualTypeId && t.code === "annual")).toBe(true)
    expect(types.every((t) => t.tenant_id === A.tenantId)).toBe(true)
  })

  it("a normal employee cannot create leave types → 403", async () => {
    const res = await request(app)
      .post("/leave-types")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ code: "sick", name: "病假", paid: false })
    expect(res.status).toBe(403)
  })

  it("HR creates a 特殊假別 (special=true); ?special=true lists it, ?special=false excludes it", async () => {
    const created = await request(app)
      .post("/leave-types")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ code: "menstrual", name: "生理假", paid: false, special: true })
    expect(created.status).toBe(201)
    const specialId = created.body.id as string

    const special = await request(app)
      .get("/leave-types?special=true")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(special.status).toBe(200)
    const specials = special.body.leaveTypes as Array<{ id: string; special: boolean }>
    expect(specials.some((t) => t.id === specialId)).toBe(true)
    expect(specials.every((t) => t.special === true)).toBe(true)

    const ordinary = await request(app)
      .get("/leave-types?special=false")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(ordinary.status).toBe(200)
    const ordinaries = ordinary.body.leaveTypes as Array<{ id: string; special: boolean }>
    expect(ordinaries.some((t) => t.id === specialId)).toBe(false)
    // The earlier 'annual' type (special defaults false) is ordinary.
    expect(ordinaries.some((t) => t.id === annualTypeId)).toBe(true)
  })
})

describe("F4 approval_flows — HR configures approver chains", () => {
  it("HR PUT /approval-flows/leave sets a single-step chain [mgr]", async () => {
    const res = await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })
    expect(res.status).toBe(200)
    expect(res.body.approverEmpIds).toEqual([mgrId])

    // GET /approval-flows lists it back.
    const list = await request(app)
      .get("/approval-flows")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(list.status).toBe(200)
    const flows = list.body.flows as Array<{ applies_to: string; approver_emp_ids: string[] }>
    const leave = flows.find((f) => f.applies_to === "leave")
    expect(leave?.approver_emp_ids).toEqual([mgrId])
  })

  it("a normal employee cannot configure flows → 403", async () => {
    const res = await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ approverEmpIds: [] })
    expect(res.status).toBe(403)
  })
})

describe("F4 single-step approval — file, authorise, approve", () => {
  let reqId: string

  it("emp1 POST /requests (leave) → 201 pending with one step (approver=mgr)", async () => {
    const res = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2026-07-01T01:00:00.000Z",
        endAt: "2026-07-01T09:00:00.000Z",
        hours: 8,
        reason: "family",
      })
    expect(res.status).toBe(201)
    expect(typeof res.body.requestId).toBe("string")
    reqId = res.body.requestId
    const steps = res.body.steps as Array<{ stepOrder: number; approverEmpId: string }>
    expect(steps.length).toBe(1)
    expect(steps[0].stepOrder).toBe(1)
    expect(steps[0].approverEmpId).toBe(mgrId)

    // Row state: pending, current_step 1, belongs to emp1 in tenant A.
    const { data } = await supabaseAdmin
      .from("leave_requests")
      .select("tenant_id, employee_id, status, current_step")
      .eq("id", reqId)
      .single()
    expect(data?.tenant_id).toBe(A.tenantId)
    expect(data?.employee_id).toBe(emp1Id)
    expect(data?.status).toBe("pending")
    expect(data?.current_step).toBe(1)
  })

  it("emp1 (not the current approver) cannot approve → 403", async () => {
    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it("mgr approves the single step → request approved", async () => {
    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "ok" })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("approved")

    const { data } = await supabaseAdmin
      .from("leave_requests")
      .select("status")
      .eq("id", reqId)
      .single()
    expect(data?.status).toBe("approved")

    const { data: step } = await supabaseAdmin
      .from("approval_steps")
      .select("decision, comment, acted_at")
      .eq("request_id", reqId)
      .eq("step_order", 1)
      .single()
    expect(step?.decision).toBe("approved")
    expect(step?.comment).toBe("ok")
    expect(step?.acted_at).toBeTruthy()
  })

  it("approving an already-approved request → 409", async () => {
    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(res.status).toBe(409)
  })
})

describe("F4 multi-step approval — advances through the chain", () => {
  let reqId: string

  it("HR sets a two-step chain [mgr, hrEmp]", async () => {
    const res = await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId, A.hrEmpId] })
    expect(res.status).toBe(200)
    expect(res.body.approverEmpIds).toEqual([mgrId, A.hrEmpId])
  })

  it("emp1 files a new leave request → two steps created", async () => {
    const res = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2026-08-01T01:00:00.000Z",
        endAt: "2026-08-02T09:00:00.000Z",
      })
    expect(res.status).toBe(201)
    reqId = res.body.requestId
    const steps = res.body.steps as Array<{ stepOrder: number; approverEmpId: string }>
    expect(steps.map((s) => s.approverEmpId)).toEqual([mgrId, A.hrEmpId])
  })

  it("step 1 (mgr) approves → still pending, current_step advances to 2", async () => {
    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("pending")
    expect(res.body.currentStep).toBe(2)

    // The HR-step approver cannot be jumped: mgr can no longer act now.
    const again = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(again.status).toBe(403)
  })

  it("step 2 (hrEmp) approves → request approved", async () => {
    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("approved")
  })
})

describe("F4 rejection — any step rejecting ends the request", () => {
  it("mgr rejects a fresh single-step request → rejected", async () => {
    // Reset to single-step for clarity.
    await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2026-09-01T01:00:00.000Z",
        endAt: "2026-09-01T09:00:00.000Z",
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId

    const res = await request(app)
      .post(`/requests/${reqId}/reject`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "no" })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("rejected")

    const { data } = await supabaseAdmin
      .from("leave_requests")
      .select("status")
      .eq("id", reqId)
      .single()
    expect(data?.status).toBe("rejected")

    const { data: step } = await supabaseAdmin
      .from("approval_steps")
      .select("decision, comment")
      .eq("request_id", reqId)
      .eq("step_order", 1)
      .single()
    expect(step?.decision).toBe("rejected")
    expect(step?.comment).toBe("no")
  })
})

describe("F4 default flow — no configured chain falls back to an HR admin", () => {
  it("emp1 files an OT request (ot flow empty) → single step approver is an hr_admin", async () => {
    // Ensure the ot flow is empty/unset.
    await request(app)
      .put("/approval-flows/ot")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "ot",
        startAt: "2026-10-01T10:00:00.000Z",
        endAt: "2026-10-01T12:00:00.000Z",
        hours: 2,
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId
    const steps = filed.body.steps as Array<{ approverEmpId: string }>
    expect(steps.length).toBe(1)
    // The fallback approver is the tenant's hr_admin (the provisioned admin).
    expect(steps[0].approverEmpId).toBe(A.hrEmpId)

    // That hr_admin can approve it through.
    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("approved")
  })
})

describe("F4 cancel — the filer can cancel a pending request", () => {
  let reqId: string

  it("emp1 cancels their own pending request → cancelled", async () => {
    await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2026-11-01T01:00:00.000Z",
        endAt: "2026-11-01T09:00:00.000Z",
      })
    expect(filed.status).toBe(201)
    reqId = filed.body.requestId

    const res = await request(app)
      .post(`/requests/${reqId}/cancel`)
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("cancelled")
  })

  it("approving an already-cancelled request → 409", async () => {
    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(res.status).toBe(409)
  })
})

describe("F4 GET /requests — role-based visibility", () => {
  it("mgr sees requests where it is their turn to approve", async () => {
    // File a fresh single-step (mgr) request so there is a pending one for mgr.
    await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2026-12-01T01:00:00.000Z",
        endAt: "2026-12-01T09:00:00.000Z",
      })
    const pendingForMgr = filed.body.requestId as string

    const res = await request(app)
      .get("/requests")
      .set("Authorization", `Bearer ${mgrToken}`)
    expect(res.status).toBe(200)
    const items = res.body.requests as Array<{ id: string }>
    expect(items.some((r) => r.id === pendingForMgr)).toBe(true)
  })

  it("HR sees every request in the tenant", async () => {
    const res = await request(app)
      .get("/requests")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const items = res.body.requests as Array<{ tenant_id: string }>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((r) => r.tenant_id === A.tenantId)).toBe(true)
  })

  it("an unrelated employee (emp2) sees none of emp1's requests", async () => {
    const res = await request(app)
      .get("/requests")
      .set("Authorization", `Bearer ${emp2Token}`)
    expect(res.status).toBe(200)
    const items = res.body.requests as Array<{ employee_id: string }>
    expect(items.some((r) => r.employee_id === emp1Id)).toBe(false)
  })

  it("?status=pending filters to pending requests only", async () => {
    const res = await request(app)
      .get("/requests?status=pending")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const items = res.body.requests as Array<{ status: string }>
    expect(items.every((r) => r.status === "pending")).toBe(true)
  })
})

describe("F4 公出/出差 — business_trip rides the same approval pipeline", () => {
  it("emp1 files a business_trip; mgr approves it through to approved", async () => {
    // Single-step chain [mgr].
    await request(app)
      .put("/approval-flows/business_trip")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "business_trip",
        startAt: "2027-01-05T01:00:00.000Z",
        endAt: "2027-01-05T09:00:00.000Z",
        reason: "client visit",
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId as string
    const steps = filed.body.steps as Array<{ approverEmpId: string }>
    expect(steps.map((s) => s.approverEmpId)).toEqual([mgrId])

    const res = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "go" })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("approved")

    const { data } = await supabaseAdmin
      .from("leave_requests")
      .select("kind, status")
      .eq("id", reqId)
      .single()
    expect(data?.kind).toBe("business_trip")
    expect(data?.status).toBe("approved")
  })

  it("an unknown kind is still rejected → 400", async () => {
    const res = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "vacation_on_mars",
        startAt: "2027-02-01T01:00:00.000Z",
        endAt: "2027-02-01T09:00:00.000Z",
      })
    expect(res.status).toBe(400)
  })
})

describe("F4 表單延伸欄位 — payout / trip extras", () => {
  it("business_trip stores tripType/location/remark/agentName and returns them on GET", async () => {
    await request(app)
      .put("/approval-flows/business_trip")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "business_trip",
        startAt: "2027-03-01T01:00:00.000Z",
        endAt: "2027-03-02T09:00:00.000Z",
        tripType: "business_trip",
        location: "台中客戶端",
        remark: "含路程",
        agentName: "B0001/王代理",
        reason: "客戶商討",
      })
    expect(filed.status).toBe(201)

    const list = await request(app).get("/requests").set("Authorization", `Bearer ${emp1Token}`)
    const row = (list.body.requests as Array<Record<string, unknown>>).find(
      (r) => r.id === filed.body.requestId,
    )
    expect(row?.trip_type).toBe("business_trip")
    expect(row?.location).toBe("台中客戶端")
    expect(row?.remark).toBe("含路程")
    expect(row?.agent_name).toBe("B0001/王代理")
  })

  it("OT payout='pay' → NO comp-time credit on approval", async () => {
    await request(app)
      .put("/approval-flows/ot")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "ot",
        startAt: "2027-04-01T10:00:00.000Z",
        endAt: "2027-04-01T12:00:00.000Z",
        hours: 2,
        payout: "pay",
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId as string

    const ok = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(ok.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("comp_time_ledger")
      .select("id")
      .eq("source_request_id", reqId)
    expect(data?.length ?? 0).toBe(0)
  })

  it("OT payout='comp_time' → comp-time credited on approval", async () => {
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "ot",
        startAt: "2027-04-02T10:00:00.000Z",
        endAt: "2027-04-02T12:00:00.000Z",
        hours: 2,
        payout: "comp_time",
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId as string

    const ok = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(ok.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("comp_time_ledger")
      .select("hours_earned")
      .eq("source_request_id", reqId)
      .single()
    expect(Number(data?.hours_earned)).toBe(2)
  })
})

describe("F3 打卡補登 — POST /punch/manual (HR only)", () => {
  it("HR back-fills a punch for an employee → 201, source='manual'", async () => {
    const res = await request(app)
      .post("/punch/manual")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ employeeId: emp1Id, punchAt: "2027-05-01T01:00:00.000Z", type: "in" })
    expect(res.status).toBe(201)
    const { data } = await supabaseAdmin
      .from("punch_records")
      .select("employee_id, source, type")
      .eq("id", res.body.id)
      .single()
    expect(data?.employee_id).toBe(emp1Id)
    expect(data?.source).toBe("manual")
    expect(data?.type).toBe("in")
  })

  it("a normal employee cannot back-fill → 403; unknown employee → 404", async () => {
    const denied = await request(app)
      .post("/punch/manual")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ employeeId: emp1Id, punchAt: "2027-05-01T02:00:00.000Z", type: "out" })
    expect(denied.status).toBe(403)

    const missing = await request(app)
      .post("/punch/manual")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        employeeId: "00000000-0000-0000-0000-000000000000",
        punchAt: "2027-05-01T02:00:00.000Z",
        type: "out",
      })
    expect(missing.status).toBe(404)
  })
})

describe("F4 代申請 + 多段日期 (gap A/C)", () => {
  it("HR files a leave ON BEHALF of emp1 with segments → owned by emp1", async () => {
    await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        onBehalfOfEmployeeId: emp1Id,
        startAt: "2027-06-01T01:00:00.000Z",
        endAt: "2027-06-02T09:00:00.000Z",
        hours: 16,
        segments: [
          { date: "2027-06-01", startTime: "09:00", endTime: "18:00", hours: 8 },
          { date: "2027-06-02", startTime: "09:00", endTime: "18:00", hours: 8 },
        ],
      })
    expect(filed.status).toBe(201)

    const { data } = await supabaseAdmin
      .from("leave_requests")
      .select("employee_id, segments")
      .eq("id", filed.body.requestId)
      .single()
    expect(data?.employee_id).toBe(emp1Id)
    expect(Array.isArray(data?.segments)).toBe(true)
    expect((data?.segments as unknown[]).length).toBe(2)
  })

  it("a normal employee cannot file on behalf of others → 403", async () => {
    const res = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        onBehalfOfEmployeeId: mgrId,
        startAt: "2027-06-03T01:00:00.000Z",
        endAt: "2027-06-03T09:00:00.000Z",
      })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("proxy_filing_requires_hr")
  })

  it("HR proxy-filing for a non-existent employee → 404", async () => {
    const res = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        onBehalfOfEmployeeId: "00000000-0000-0000-0000-000000000000",
        startAt: "2027-06-04T01:00:00.000Z",
        endAt: "2027-06-04T09:00:00.000Z",
      })
    expect(res.status).toBe(404)
  })
})

describe("F4 附件上傳 (gap D)", () => {
  let reqId: string
  const b64 = Buffer.from("hello attachment").toString("base64")

  it("filer uploads an attachment; list returns a signed URL", async () => {
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2027-07-01T01:00:00.000Z",
        endAt: "2027-07-01T09:00:00.000Z",
      })
    expect(filed.status).toBe(201)
    reqId = filed.body.requestId

    const up = await request(app)
      .post(`/requests/${reqId}/attachments`)
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ fileName: "診斷證明.txt", contentType: "text/plain", dataBase64: b64 })
    expect(up.status).toBe(201)
    expect(up.body.sizeBytes).toBe(16)

    const list = await request(app)
      .get(`/requests/${reqId}/attachments`)
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(list.status).toBe(200)
    expect(list.body.attachments.length).toBe(1)
    expect(list.body.attachments[0].fileName).toBe("診斷證明.txt")
    expect(String(list.body.attachments[0].url)).toContain("http")
  })

  it("an unrelated employee cannot see the attachments → 403", async () => {
    const res = await request(app)
      .get(`/requests/${reqId}/attachments`)
      .set("Authorization", `Bearer ${emp2Token}`)
    expect(res.status).toBe(403)
  })

  it("4th file → 409 max_files_reached", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await request(app)
        .post(`/requests/${reqId}/attachments`)
        .set("Authorization", `Bearer ${emp1Token}`)
        .send({ fileName: `f${i}.txt`, contentType: "text/plain", dataBase64: b64 })
      expect(r.status).toBe(201)
    }
    const fourth = await request(app)
      .post(`/requests/${reqId}/attachments`)
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ fileName: "f3.txt", contentType: "text/plain", dataBase64: b64 })
    expect(fourth.status).toBe(409)
  })
})

describe("F4 cross-tenant isolation", () => {
  it("A's HR can never see any of B's requests", async () => {
    // Seed a request in tenant B directly (rows only — no token needed).
    const { data: bReq, error: bErr } = await supabaseAdmin
      .from("leave_requests")
      .insert({
        tenant_id: B.tenantId,
        employee_id: B.hrEmpId,
        kind: "ot",
        start_at: "2026-07-01T10:00:00.000Z",
        end_at: "2026-07-01T12:00:00.000Z",
        status: "pending",
        current_step: 1,
      })
      .select("id")
      .single()
    if (bErr || !bReq) throw new Error(`seed B request failed: ${bErr?.message}`)

    const res = await request(app)
      .get("/requests")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const items = res.body.requests as Array<{ id: string; tenant_id: string }>
    expect(items.every((r) => r.tenant_id === A.tenantId)).toBe(true)
    expect(items.some((r) => r.id === bReq.id)).toBe(false)
  })
})
describe("F4 DELETE /requests/:id — 軟刪除，紀錄不滅失", () => {
  // 被駁回的申請是勞資爭議中雇主唯一的反證，硬刪等於證據滅失。
  // 端點改為軟刪除：寫 deleted_at/deleted_by_emp_id/delete_reason，
  // 附件與簽核軌跡保留，列表與動作端點以 deleted_at IS NULL 過濾。
  let rejectedId: string

  it("先造一筆被駁回的請假單", async () => {
    await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2026-12-01T01:00:00.000Z",
        endAt: "2026-12-01T09:00:00.000Z",
      })
    expect(filed.status).toBe(201)
    rejectedId = filed.body.requestId

    const rejected = await request(app)
      .post(`/requests/${rejectedId}/reject`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})
    expect(rejected.status).toBe(200)
  })

  it("未附理由 → 400 reason_required", async () => {
    const res = await request(app)
      .delete(`/requests/${rejectedId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("reason_required")
  })

  it("非 HR → 403", async () => {
    const res = await request(app)
      .delete(`/requests/${rejectedId}`)
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ reason: "測試" })
    expect(res.status).toBe(403)
  })

  it("HR 附理由註銷 → 200，且 DB 內該列仍在（軟刪除）", async () => {
    const res = await request(app)
      .delete(`/requests/${rejectedId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ reason: "重複申請，與前一筆相同" })
    expect(res.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("leave_requests")
      .select("id, status, deleted_at, deleted_by_emp_id, delete_reason")
      .eq("id", rejectedId)
      .maybeSingle()
    expect(data).not.toBeNull()
    expect(data?.deleted_at).not.toBeNull()
    expect(data?.delete_reason).toBe("重複申請，與前一筆相同")
    expect(data?.deleted_by_emp_id).toBe(A.hrEmpId)
    // 原狀態不被覆寫——「被駁回」這件事本身是證據。
    expect(data?.status).toBe("rejected")
  })

  it("簽核軌跡一併保留（不再連坐刪除）", async () => {
    const { data: steps } = await supabaseAdmin
      .from("approval_steps")
      .select("id")
      .eq("tenant_id", A.tenantId)
      .eq("request_id", rejectedId)
    expect((steps ?? []).length).toBeGreaterThan(0)
  })

  it("註銷後不出現在 GET /requests", async () => {
    const res = await request(app)
      .get("/requests")
      .set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const items = res.body.requests as Array<{ id: string }>
    expect(items.some((r) => r.id === rejectedId)).toBe(false)
  })

  it("重複註銷 → 409 already_deleted", async () => {
    const res = await request(app)
      .delete(`/requests/${rejectedId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ reason: "再一次" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("already_deleted")
  })

  it("已核准的單仍不可註銷 → 409（其 ledger 效果已發生）", async () => {
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2026-12-05T01:00:00.000Z",
        endAt: "2026-12-05T09:00:00.000Z",
      })
    expect(filed.status).toBe(201)
    const approvedId = filed.body.requestId
    await request(app)
      .post(`/requests/${approvedId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({})

    const res = await request(app)
      .delete(`/requests/${approvedId}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ reason: "測試" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("approved_request_cannot_be_deleted")
  })
})

/* ── WP2（ESS 簡化）：scope=mine、列表補齊欄位、segments.type、approverName、通知 ── */

describe("WP2 GET /requests?scope=mine — 任何角色只看自己申請的單", () => {
  let hrOwnReqId: string
  let emp1PendingId: string

  it("HR 自己送一張加班單（flow [mgr]）；POST 回傳 steps[0].approverName", async () => {
    await request(app)
      .put("/approval-flows/ot")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({
        kind: "ot",
        startAt: "2027-09-01T10:00:00.000Z",
        endAt: "2027-09-01T11:00:00.000Z",
        hours: 1,
        payout: "pay",
      })
    expect(filed.status).toBe(201)
    hrOwnReqId = filed.body.requestId
    const steps = filed.body.steps as Array<{ stepOrder: number; approverEmpId: string; approverName: string | null }>
    expect(steps.length).toBe(1)
    expect(steps[0].approverEmpId).toBe(mgrId)
    expect(steps[0].approverName).toBe("Mona Manager")
  })

  it("HR 不帶 scope 看全租戶；帶 scope=mine 只剩 employee_id = 自己", async () => {
    const all = await request(app).get("/requests").set("Authorization", `Bearer ${A.adminToken}`)
    expect(all.status).toBe(200)
    const allRows = all.body.requests as Array<{ id: string; employee_id: string }>
    expect(allRows.some((r) => r.employee_id === emp1Id)).toBe(true)

    const mine = await request(app).get("/requests?scope=mine").set("Authorization", `Bearer ${A.adminToken}`)
    expect(mine.status).toBe(200)
    const mineRows = mine.body.requests as Array<{ id: string; employee_id: string }>
    expect(mineRows.length).toBeGreaterThan(0)
    expect(mineRows.every((r) => r.employee_id === A.hrEmpId)).toBe(true)
    expect(mineRows.some((r) => r.id === hrOwnReqId)).toBe(true)
    expect(mineRows.length).toBeLessThan(allRows.length)
  })

  it("主管帶 scope=mine 看不到「輪到我簽」的單，不帶 scope 才看得到；status 篩選仍生效", async () => {
    await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2027-09-02T01:00:00.000Z",
        endAt: "2027-09-02T09:00:00.000Z",
        hours: 8,
        reason: "WP2 pending",
      })
    expect(filed.status).toBe(201)
    emp1PendingId = filed.body.requestId

    const mgrMine = await request(app).get("/requests?scope=mine").set("Authorization", `Bearer ${mgrToken}`)
    expect(mgrMine.status).toBe(200)
    const mgrMineRows = mgrMine.body.requests as Array<{ id: string; employee_id: string }>
    expect(mgrMineRows.some((r) => r.id === emp1PendingId)).toBe(false)
    expect(mgrMineRows.every((r) => r.employee_id === mgrId)).toBe(true)

    const mgrAll = await request(app).get("/requests").set("Authorization", `Bearer ${mgrToken}`)
    expect((mgrAll.body.requests as Array<{ id: string }>).some((r) => r.id === emp1PendingId)).toBe(true)

    const pendingOnly = await request(app)
      .get("/requests?scope=mine&status=pending")
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(pendingOnly.status).toBe(200)
    const pendingRows = pendingOnly.body.requests as Array<{ id: string; status: string; employee_id: string }>
    expect(pendingRows.some((r) => r.id === emp1PendingId)).toBe(true)
    expect(pendingRows.every((r) => r.status === "pending" && r.employee_id === emp1Id)).toBe(true)
  })

  it("scope=mine 帶不合法值 → 400", async () => {
    const res = await request(app).get("/requests?scope=all").set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(400)
  })

  it("列表每列補齊：employee_name／leave_type_name／current_approver_name／total_steps／attachment_count／requires_attachment", async () => {
    const res = await request(app).get("/requests?scope=mine").set("Authorization", `Bearer ${emp1Token}`)
    expect(res.status).toBe(200)
    const row = (res.body.requests as Array<Record<string, unknown>>).find((r) => r.id === emp1PendingId)
    expect(row).toBeTruthy()
    expect(row?.employee_name).toBe("Alice One")
    expect(row?.leave_type_name).toBe("特休")
    expect(row?.requires_attachment).toBe(false)
    expect(row?.attachment_count).toBe(0)
    expect(row?.total_steps).toBe(1)
    expect(row?.current_step).toBe(1)
    expect(row?.current_approver_emp_id).toBe(mgrId)
    expect(row?.current_approver_name).toBe("Mona Manager")
    expect(row?.decision_comment).toBeNull()
    expect(row?.decided_at).toBeNull()
    // 舊欄位仍在（後台 form-records 依賴）
    expect(row?.reason).toBe("WP2 pending")
    expect(row?.kind).toBe("leave")
    expect(typeof row?.created_at).toBe("string")
  })

  it("附件上傳一筆後 attachment_count = 1", async () => {
    const up = await request(app)
      .post(`/requests/${emp1PendingId}/attachments`)
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({ fileName: "wp2.txt", contentType: "text/plain", dataBase64: Buffer.from("wp2").toString("base64") })
    expect(up.status).toBe(201)

    const res = await request(app).get("/requests?scope=mine").set("Authorization", `Bearer ${emp1Token}`)
    const row = (res.body.requests as Array<Record<string, unknown>>).find((r) => r.id === emp1PendingId)
    expect(row?.attachment_count).toBe(1)
  })

  it("駁回後 decision_comment／decided_at 帶駁回理由；早前核准的單帶簽核意見與時間", async () => {
    const rejected = await request(app)
      .post(`/requests/${emp1PendingId}/reject`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "資料不齊" })
    expect(rejected.status).toBe(200)

    const res = await request(app)
      .get("/requests?scope=mine&status=rejected")
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(res.status).toBe(200)
    const row = (res.body.requests as Array<Record<string, unknown>>).find((r) => r.id === emp1PendingId)
    expect(row?.status).toBe("rejected")
    expect(row?.decision_comment).toBe("資料不齊")
    expect(typeof row?.decided_at).toBe("string")
    expect(row?.current_approver_name).toBe("Mona Manager")

    // 第一個 describe 裡 mgr 以 comment "ok" 核准的那張單
    const approved = await request(app)
      .get("/requests?scope=mine&status=approved")
      .set("Authorization", `Bearer ${emp1Token}`)
    const okRow = (approved.body.requests as Array<Record<string, unknown>>).find((r) => r.decision_comment === "ok")
    expect(okRow).toBeTruthy()
    expect(typeof okRow?.decided_at).toBe("string")
    expect(approved.body.requests.every((r: Record<string, unknown>) => r.status === "approved")).toBe(true)
  })

  it("HR 全租戶列表（後台既有呼叫）同樣帶補齊欄位且舊欄位不變", async () => {
    const res = await request(app).get("/requests").set("Authorization", `Bearer ${A.adminToken}`)
    expect(res.status).toBe(200)
    const row = (res.body.requests as Array<Record<string, unknown>>).find((r) => r.id === emp1PendingId)
    expect(row?.employee_name).toBe("Alice One")
    expect(row?.current_approver_emp_id).toBe(mgrId)
    expect(row?.decision_comment).toBe("資料不齊")
    expect(row?.tenant_id).toBe(A.tenantId)
  })
})

describe("WP2 POST /requests — segments[].type 放行（補卡指定上／下班）", () => {
  it("fix_punch 帶 segments[{type:'out'}] → 201；GET 讀回仍有 type", async () => {
    await request(app)
      .put("/approval-flows/fix_punch")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })

    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "fix_punch",
        startAt: "2027-08-01T10:05:00.000Z",
        endAt: "2027-08-01T10:05:00.000Z",
        reason: "忘了打下班卡",
        segments: [{ date: "2027-08-01", startTime: "18:05", endTime: "18:05", hours: 0, type: "out" }],
      })
    expect(filed.status).toBe(201)
    const reqId = filed.body.requestId as string
    expect((filed.body.steps as Array<{ approverName: string | null }>)[0].approverName).toBe("Mona Manager")

    const list = await request(app)
      .get("/requests?scope=mine&kind=fix_punch")
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(list.status).toBe(200)
    const row = (list.body.requests as Array<Record<string, unknown>>).find((r) => r.id === reqId)
    const segments = row?.segments as Array<Record<string, unknown>>
    expect(Array.isArray(segments)).toBe(true)
    expect(segments[0].type).toBe("out")
    expect(segments[0].date).toBe("2027-08-01")
    expect(segments[0].startTime).toBe("18:05")
    expect(row?.leave_type_name).toBeNull()

    const { data } = await supabaseAdmin.from("leave_requests").select("segments").eq("id", reqId).single()
    expect((data?.segments as Array<Record<string, unknown>>)[0].type).toBe("out")
  })

  it("segments[].type 不在允許清單 → 400", async () => {
    const res = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "fix_punch",
        startAt: "2027-08-02T10:05:00.000Z",
        endAt: "2027-08-02T10:05:00.000Z",
        segments: [{ date: "2027-08-02", startTime: "18:05", endTime: "18:05", hours: 0, type: "lunch" }],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
  })

  it("不帶 type 的舊格式仍可送（向後相容）", async () => {
    const res = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "fix_punch",
        startAt: "2027-08-03T01:00:00.000Z",
        endAt: "2027-08-03T10:00:00.000Z",
        segments: [{ date: "2027-08-03", startTime: "09:00", endTime: "18:00", hours: 8 }],
      })
    expect(res.status).toBe(201)
  })
})

describe("WP2 notifications — scope=mine／unread=1／unread-count／read-all", () => {
  let submittedReqId: string
  let mgrUnreadBefore: number
  let emp1UnreadBefore: number

  it("送單後 mgr 有未讀通知：?unread=1 看得到，unread-count 與其筆數一致", async () => {
    await request(app)
      .put("/approval-flows/leave")
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })
    const filed = await request(app)
      .post("/requests")
      .set("Authorization", `Bearer ${emp1Token}`)
      .send({
        kind: "leave",
        leaveTypeId: annualTypeId,
        startAt: "2027-09-10T01:00:00.000Z",
        endAt: "2027-09-10T09:00:00.000Z",
        hours: 8,
      })
    expect(filed.status).toBe(201)
    expect(filed.body.notified).toBe(1)
    submittedReqId = filed.body.requestId

    const unread = await request(app).get("/notifications?unread=1").set("Authorization", `Bearer ${mgrToken}`)
    expect(unread.status).toBe(200)
    const rows = unread.body.notifications as Array<{ employee_id: string; payload: Record<string, unknown> }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((n) => n.employee_id === mgrId)).toBe(true)
    expect(rows.every((n) => n.payload?.read !== true)).toBe(true)
    expect(rows.some((n) => n.payload?.requestId === submittedReqId && n.payload?.event === "submitted")).toBe(true)

    const count = await request(app).get("/notifications/unread-count").set("Authorization", `Bearer ${mgrToken}`)
    expect(count.status).toBe(200)
    expect(count.body.count).toBe(rows.length)
    mgrUnreadBefore = count.body.count

    const emp1Count = await request(app).get("/notifications/unread-count").set("Authorization", `Bearer ${emp1Token}`)
    expect(emp1Count.status).toBe(200)
    // emp1 早前收過核准／駁回通知
    expect(emp1Count.body.count).toBeGreaterThan(0)
    emp1UnreadBefore = emp1Count.body.count
  })

  it("unread=1 排除已讀：單筆 /read 後該筆不再出現，unread-count 減 1", async () => {
    const unread = await request(app).get("/notifications?unread=1").set("Authorization", `Bearer ${mgrToken}`)
    const target = (unread.body.notifications as Array<{ id: string }>)[0]
    const read = await request(app).post(`/notifications/${target.id}/read`).set("Authorization", `Bearer ${mgrToken}`).send({})
    expect(read.status).toBe(200)

    const after = await request(app).get("/notifications?unread=1").set("Authorization", `Bearer ${mgrToken}`)
    expect((after.body.notifications as Array<{ id: string }>).some((n) => n.id === target.id)).toBe(false)
    const count = await request(app).get("/notifications/unread-count").set("Authorization", `Bearer ${mgrToken}`)
    expect(count.body.count).toBe(mgrUnreadBefore - 1)
    mgrUnreadBefore = count.body.count

    // 不帶 unread 仍列出該筆（已讀不等於刪除）
    const all = await request(app).get("/notifications").set("Authorization", `Bearer ${mgrToken}`)
    const row = (all.body.notifications as Array<{ id: string; payload: Record<string, unknown> }>).find((n) => n.id === target.id)
    expect(row?.payload.read).toBe(true)
  })

  it("HR 不帶 scope 看全租戶（含 mgr 的）；帶 scope=mine 只看自己", async () => {
    const all = await request(app).get("/notifications").set("Authorization", `Bearer ${A.adminToken}`)
    expect(all.status).toBe(200)
    const allRows = all.body.notifications as Array<{ employee_id: string }>
    expect(allRows.some((n) => n.employee_id === mgrId)).toBe(true)

    const mine = await request(app).get("/notifications?scope=mine").set("Authorization", `Bearer ${A.adminToken}`)
    expect(mine.status).toBe(200)
    const mineRows = mine.body.notifications as Array<{ employee_id: string }>
    // HR 曾是 fallback／第 2 關簽核者，自己一定有通知
    expect(mineRows.length).toBeGreaterThan(0)
    expect(mineRows.every((n) => n.employee_id === A.hrEmpId)).toBe(true)
    expect(mineRows.length).toBeLessThan(allRows.length)

    // unread-count 對 HR 也只算自己的，不是全租戶
    const count = await request(app).get("/notifications/unread-count").set("Authorization", `Bearer ${A.adminToken}`)
    expect(count.body.count).toBeLessThanOrEqual(mineRows.length)
  })

  it("read-all：updated = 自己的未讀數；之後 unread-count = 0、?unread=1 空；別人的未讀不動；再跑一次 updated = 0", async () => {
    const res = await request(app).post("/notifications/read-all").set("Authorization", `Bearer ${mgrToken}`).send({})
    expect(res.status).toBe(200)
    expect(res.body.updated).toBe(mgrUnreadBefore)
    expect(res.body.updated).toBeGreaterThan(0)

    const count = await request(app).get("/notifications/unread-count").set("Authorization", `Bearer ${mgrToken}`)
    expect(count.body.count).toBe(0)
    const unread = await request(app).get("/notifications?unread=1").set("Authorization", `Bearer ${mgrToken}`)
    expect(unread.body.notifications).toEqual([])

    const all = await request(app).get("/notifications").set("Authorization", `Bearer ${mgrToken}`)
    const rows = all.body.notifications as Array<{ payload: Record<string, unknown> }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((n) => n.payload?.read === true)).toBe(true)

    const emp1Count = await request(app).get("/notifications/unread-count").set("Authorization", `Bearer ${emp1Token}`)
    expect(emp1Count.body.count).toBe(emp1UnreadBefore)

    const again = await request(app).post("/notifications/read-all").set("Authorization", `Bearer ${mgrToken}`).send({})
    expect(again.status).toBe(200)
    expect(again.body.updated).toBe(0)
  })

  it("unread 帶不合法值 → 400；未登入 → 401", async () => {
    const bad = await request(app).get("/notifications?unread=yes").set("Authorization", `Bearer ${mgrToken}`)
    expect(bad.status).toBe(400)
    const anon = await request(app).get("/notifications/unread-count")
    expect(anon.status).toBe(401)
  })
})
