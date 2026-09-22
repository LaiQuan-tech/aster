import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * 出差／零用金核准 → 自動開出 advances 一列（status='requested'）。
 *
 * 回歸測試：decideOneRequest 的 SELECT 有選 advance_requested，但組給
 * applyApprovalEffects 的物件漏了這個欄位，ledger.openAdvance 讀到 0 就直接
 * return——正式租戶 2026-09-22 實測三張帶預支金額的核准單都沒有預支列
 * （commit 37e0204 修）。單筆 POST /requests/:id/approve 與
 * POST /requests/batch-decision 都走 decideOneRequest，兩條路徑各驗一次；
 * 順便釘住「沒填預支金額就不開列」的 amount ≤ 0 守門。
 */

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
  hrEmpId: string
}

let A: Tenant

// Tenant A cast:
//   emp1 — files business_trip / petty_cash requests (role 'employee').
//   mgr  — the approver (role 'manager').
let emp1Id: string
let emp1Token: string
let mgrId: string
let mgrToken: string

/** GET /advances 一列（routes/advances.ts ADV_COLS 的子集；amount 是 numeric → 字串）。 */
interface AdvanceRow {
  id: string
  kind: string
  request_id: string
  employee_id: string
  amount: string | number
  status: string
}

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
  const name = `ADVOPEN ${label} ${stamp}`
  const adminEmail = `advopen-${stamp}-${label}-admin@example.com`
  const adminPassword = `Pw-${stamp}-${label}-Aa1!`

  const { tenantId, userId } = await provisionTenant({ name, adminEmail, adminPassword })
  createdTenantIds.push(tenantId)
  createdUserIds.push(userId)

  const adminToken = await signIn(adminEmail, adminPassword)

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

/** emp1 送一張單；chain 已在 beforeAll 設成 [mgr] 單關，回 requestId。 */
async function fileAsEmp1(body: Record<string, unknown>): Promise<string> {
  const filed = await request(app)
    .post("/requests")
    .set("Authorization", `Bearer ${emp1Token}`)
    .send(body)
  expect(filed.status).toBe(201)
  const steps = filed.body.steps as Array<{ approverEmpId: string }>
  expect(steps.map((s) => s.approverEmpId)).toEqual([mgrId])
  return filed.body.requestId as string
}

/** HR 視角讀該員工的預支列（GET /advances 回 { advances: [...] }）。 */
async function advancesFor(employeeId: string): Promise<AdvanceRow[]> {
  const res = await request(app)
    .get(`/advances?employeeId=${employeeId}`)
    .set("Authorization", `Bearer ${A.adminToken}`)
  expect(res.status).toBe(200)
  return res.body.advances as AdvanceRow[]
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing — cannot run advances-open-on-approval test")
  }

  A = await buildTenant("A")

  const e1 = await createEmployee(
    A.adminToken,
    `advopen-${stamp}-a-emp1@example.com`,
    `Pw-${stamp}-emp1-Bb2!`,
    "Alice One",
    "employee",
  )
  emp1Id = e1.employeeId
  emp1Token = e1.token

  const m = await createEmployee(
    A.adminToken,
    `advopen-${stamp}-a-mgr@example.com`,
    `Pw-${stamp}-mgr-Cc3!`,
    "Mona Manager",
    "manager",
  )
  mgrId = m.employeeId
  mgrToken = m.token

  // HR routes business_trip / petty_cash approvals to mgr (single step). The trip below is filed with
  // tripScope=domestic_intercity, which (W2) looks up the business_trip_intercity flow instead — set it too.
  for (const kind of ["business_trip", "business_trip_intercity", "petty_cash"]) {
    const flow = await request(app)
      .put(`/approval-flows/${kind}`)
      .set("Authorization", `Bearer ${A.adminToken}`)
      .send({ approverEmpIds: [mgrId] })
    if (flow.status !== 200) throw new Error(`beforeAll: PUT approval-flows/${kind} (${flow.status})`)
  }
}, 90_000)

afterAll(async () => {
  // notifications → advances → approval_steps → leave_requests → approval_flows →
  // employees → tenants → auth users.
  // advances.request_id FK → leave_requests、employee_id FK → employees（皆 no action），
  // 所以要先於那兩張表清掉；送單／簽核會寫 notifications（FK → employees），同理。
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("advances").delete().eq("tenant_id", tid)
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
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
  }
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(uid)
  }
}, 90_000)

describe("F4 零用金核准 → 自動開出 advances（單筆 POST /requests/:id/approve）", () => {
  it("emp1 files petty_cash advanceRequested=1500; mgr approves → GET /advances has status='requested' amount=1500", async () => {
    const reqId = await fileAsEmp1({
      kind: "petty_cash",
      startAt: "2027-02-03T01:00:00.000Z",
      endAt: "2027-02-03T09:00:00.000Z",
      advanceRequested: 1500,
      reason: "office supplies",
    })

    const approve = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "ok" })
    expect(approve.status).toBe(200)
    expect(approve.body.status).toBe("approved")

    const adv = (await advancesFor(emp1Id)).find((a) => a.request_id === reqId)
    expect(adv).toBeTruthy()
    expect(adv!.status).toBe("requested")
    expect(Number(adv!.amount)).toBe(1500)
    expect(adv!.kind).toBe("petty_cash")
    expect(adv!.employee_id).toBe(emp1Id)

    // 非 HR 只看得到本人的列，且 ?status= 過濾要能命中這一列。
    const mine = await request(app)
      .get("/advances?status=requested")
      .set("Authorization", `Bearer ${emp1Token}`)
    expect(mine.status).toBe(200)
    expect((mine.body.advances as AdvanceRow[]).some((a) => a.request_id === reqId)).toBe(true)
  }, 20_000)
})

describe("F4 出差核准 → 自動開出 advances（單筆 POST /requests/:id/approve）", () => {
  it("emp1 files business_trip advanceRequested=3000; mgr approves → kind='trip' status='requested' amount=3000", async () => {
    const reqId = await fileAsEmp1({
      kind: "business_trip",
      startAt: "2027-02-10T01:00:00.000Z",
      endAt: "2027-02-11T09:00:00.000Z",
      tripType: "business_trip",
      location: "台中",
      tripScope: "domestic_intercity",
      estimatedCost: 3000,
      advanceRequested: 3000,
      reason: "client visit",
    })

    const approve = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "go" })
    expect(approve.status).toBe(200)
    expect(approve.body.status).toBe("approved")

    const adv = (await advancesFor(emp1Id)).find((a) => a.request_id === reqId)
    expect(adv).toBeTruthy()
    expect(adv!.status).toBe("requested")
    expect(Number(adv!.amount)).toBe(3000)
    // ledger.openAdvance 對 business_trip 開的列 kind 是 'trip'，不是申請單的 kind。
    expect(adv!.kind).toBe("trip")
    expect(adv!.employee_id).toBe(emp1Id)
  }, 20_000)
})

describe("F4 batch-decision 走同一個 decideOneRequest → 也會開出 advances", () => {
  it("mgr batch-approves a petty_cash advanceRequested=800 → advances row amount=800", async () => {
    const reqId = await fileAsEmp1({
      kind: "petty_cash",
      startAt: "2027-02-17T01:00:00.000Z",
      endAt: "2027-02-17T09:00:00.000Z",
      advanceRequested: 800,
      reason: "courier fees",
    })

    const batch = await request(app)
      .post("/requests/batch-decision")
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ ids: [reqId], action: "approve", comment: "batch ok" })
    expect(batch.status).toBe(200)
    expect(batch.body.ok).toBe(1)
    expect(batch.body.failed).toBe(0)
    expect(batch.body.results[0]).toMatchObject({ ok: true, id: reqId, status: "approved" })

    const adv = (await advancesFor(emp1Id)).find((a) => a.request_id === reqId)
    expect(adv).toBeTruthy()
    expect(adv!.status).toBe("requested")
    expect(Number(adv!.amount)).toBe(800)
    expect(adv!.kind).toBe("petty_cash")
  }, 20_000)
})

describe("F4 沒填預支金額就不開 advances", () => {
  it("business_trip without advanceRequested; mgr approves → no advances row for that request", async () => {
    const reqId = await fileAsEmp1({
      kind: "business_trip",
      startAt: "2027-02-24T01:00:00.000Z",
      endAt: "2027-02-24T09:00:00.000Z",
      reason: "no advance needed",
    })

    const approve = await request(app)
      .post(`/requests/${reqId}/approve`)
      .set("Authorization", `Bearer ${mgrToken}`)
      .send({ comment: "go" })
    expect(approve.status).toBe(200)
    expect(approve.body.status).toBe("approved")

    expect((await advancesFor(emp1Id)).some((a) => a.request_id === reqId)).toBe(false)
  }, 20_000)
})
