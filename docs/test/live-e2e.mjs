/**
 * live-e2e.mjs — End-to-end smoke/regression test against the DEPLOYED HR API.
 *
 *   API:   https://hr-production-994f.up.railway.app   (override with API_BASE)
 *   Auth:  real Supabase users created via service_role, signed in for JWTs
 *
 * It provisions a throwaway tenant `E2E-<ts>` with three users (hr_admin /
 * manager / employee), drives every feature route through a realistic flow,
 * asserts HTTP status + key fields, then deletes everything it created
 * (rows in FK order, then the auth users). Read-only against pre-existing data.
 *
 * Run:  node docs/test/live-e2e.mjs
 *
 * Exit code is 0 only when FAIL == 0.
 */

import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Env loading (repo-root .env — this file lives at hr-saas/docs/test/)
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url))
const ENV_PATH = resolve(__dirname, "../../.env")
const env = Object.fromEntries(
  readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=")
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const API_BASE = process.env.API_BASE ?? "https://hr-production-994f.up.railway.app"
const ORIGIN = process.env.WEB_ORIGIN ?? "https://hr-theta-peach.vercel.app"
const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error("Missing SUPABASE_URL / SERVICE_ROLE / ANON in .env")
  process.exit(2)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------
let PASS = 0
let FAIL = 0
const failures = []
let currentSection = "(setup)"

function section(name) {
  currentSection = name
  console.log(`\n=== ${name} ===`)
}

function ok(cond, label, extra) {
  if (cond) {
    PASS++
    console.log(`  PASS  ${label}`)
  } else {
    FAIL++
    const detail = extra ? `  ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : ""
    console.log(`  FAIL  ${label}${detail}`)
    failures.push({ section: currentSection, label, detail: extra })
  }
}

function eqStatus(res, want, label) {
  ok(res.status === want, `${label} → ${want}`, res.status === want ? undefined : `got ${res.status} body=${JSON.stringify(res.body)}`)
}

// ---------------------------------------------------------------------------
// HTTP helper — always sends Origin + (optional) Bearer token
// ---------------------------------------------------------------------------
async function api(method, path, { token, body, raw } = {}) {
  const headers = { Origin: ORIGIN }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text // CSV / non-JSON
  }
  return { status: res.status, body: parsed, text, headers: res.headers, raw: raw ? res : undefined }
}

// ---------------------------------------------------------------------------
// Bookkeeping for teardown (FK order matters)
// ---------------------------------------------------------------------------
const created = {
  tenantIds: [],
  userIds: [],
  // we delete by tenant_id sweeps, so we only need the tenant + user ids,
  // but we keep explicit row ids too for targeted safety.
}

async function signIn(email, password) {
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return { token: data.session.access_token, appMeta: data.user?.app_metadata }
}

/**
 * Provision a tenant + N users with employee rows. Returns handles.
 * roleSpecs: [{ key, role }]  (key is a label like "hr"/"mgr"/"emp")
 */
async function provisionTenant(label, roleSpecs) {
  const ts = Date.now()
  const name = `${label}-${ts}`
  const { data: tenant, error: tErr } = await admin
    .from("tenants")
    .insert({
      name,
      // 必須是 'test'：sql/0018 的硬刪防護只放行 status IN ('test','demo') 的租戶，
      // 預設值 'active' 會讓下面 TEARDOWN 的 delete 全數被 trigger 擋掉、資料留在正式庫。
      status: "test",
      branding: { logoUrl: null, primaryColor: "#1F4E79", appName: name },
      features: { payroll: true, kpi: true, ai_assistant: true },
    })
    .select("id")
    .single()
  if (tErr || !tenant) throw new Error(`tenant insert failed: ${tErr?.message}`)
  const tenantId = tenant.id
  created.tenantIds.push(tenantId)

  const users = {}
  for (const spec of roleSpecs) {
    const email = `e2e-${ts}-${label}-${spec.key}@example.com`.toLowerCase()
    const password = `Pw-${ts}-${spec.key}-Aa1!`
    const { data: u, error: uErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { tenant_id: tenantId },
    })
    if (uErr || !u?.user) throw new Error(`user ${spec.key} failed: ${uErr?.message}`)
    created.userIds.push(u.user.id)

    const { data: emp, error: eErr } = await admin
      .from("employees")
      .insert({
        tenant_id: tenantId,
        user_id: u.user.id,
        name: `${spec.key.toUpperCase()} ${label}`,
        role: spec.role,
        employment_type: "regular",
        status: "active",
      })
      .select("id")
      .single()
    if (eErr || !emp) throw new Error(`employee ${spec.key} failed: ${eErr?.message}`)

    const { token, appMeta } = await signIn(email, password)
    users[spec.key] = {
      email,
      password,
      userId: u.user.id,
      empId: emp.id,
      role: spec.role,
      token,
      appMeta,
    }
  }
  return { tenantId, name, users }
}

// ---------------------------------------------------------------------------
// Teardown — sweep every tenant we created, FK-leaf tables first.
// ---------------------------------------------------------------------------
async function teardown() {
  section("TEARDOWN (cleanup)")
  // FK-leaf first. Key cross-table FKs:
  //   approval_steps.request_id     → leave_requests.id
  //   comp_time_ledger.source_request_id → leave_requests.id
  //   leave_requests.employee_id    → employees.id
  //   leave_requests.leave_type_id  → leave_types.id
  //   employees.dept_id             → departments.id
  // ⇒ approval_steps + comp_time_ledger BEFORE leave_requests BEFORE
  //   (leave_types, employees); employees BEFORE departments.
  const sweepOrder = [
    "approval_steps",
    "comp_time_ledger",
    "leave_requests",
    "leave_balances",
    "payslips",
    "attendance_days",
    "salary_structures",
    "kpi_reviews",
    "kpi_templates",
    "notifications",
    "announcements",
    "approval_flows",
    "schedules",
    "punch_records",
    "leave_types",
    "shifts",
    "rule_configs",
    "employees",
    "departments",
  ]
  let cleanErrors = 0
  for (const tid of created.tenantIds) {
    for (const table of sweepOrder) {
      const { error } = await admin.from(table).delete().eq("tenant_id", tid)
      if (error) {
        cleanErrors++
        console.log(`  WARN  delete ${table} (tenant ${tid}): ${error.message}`)
      }
    }
    const { error: tErr } = await admin.from("tenants").delete().eq("id", tid)
    if (tErr) {
      cleanErrors++
      console.log(`  WARN  delete tenant ${tid}: ${tErr.message}`)
    }
  }
  for (const uid of created.userIds) {
    const { error } = await admin.auth.admin.deleteUser(uid)
    if (error) {
      cleanErrors++
      console.log(`  WARN  delete auth user ${uid}: ${error.message}`)
    }
  }

  // Verify nothing of ours remains.
  let leftover = 0
  for (const tid of created.tenantIds) {
    const { count } = await admin.from("employees").select("*", { count: "exact", head: true }).eq("tenant_id", tid)
    leftover += count ?? 0
    const { data: tRow } = await admin.from("tenants").select("id").eq("id", tid).maybeSingle()
    if (tRow) leftover++
  }
  for (const uid of created.userIds) {
    const { data } = await admin.auth.admin.getUserById(uid)
    if (data?.user) leftover++
  }
  console.log(`  cleanup errors: ${cleanErrors}, leftover rows/users of ours: ${leftover}`)
  ok(leftover === 0, "Supabase fully cleaned (no leftover tenants/employees/users)", leftover === 0 ? undefined : `leftover=${leftover}`)
  return leftover === 0
}

// helpers for dates
const pad = (n) => String(n).padStart(2, "0")
const todayUTC = () => {
  const d = new Date()
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
const monthUTC = () => {
  const d = new Date()
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log(`HR live e2e — API_BASE=${API_BASE}  ORIGIN=${ORIGIN}`)

  // --- provision primary tenant A ------------------------------------------
  section("PROVISION tenant A + users")
  const A = await provisionTenant("E2E", [
    { key: "hr", role: "hr_admin" },
    { key: "mgr", role: "manager" },
    { key: "emp", role: "employee" },
  ])
  const hr = A.users.hr
  const mgr = A.users.mgr
  const emp = A.users.emp
  ok(!!hr.token && !!mgr.token && !!emp.token, "3 users provisioned + signed in")
  ok(hr.appMeta?.tenant_id === A.tenantId, "JWT carries tenant_id in app_metadata", hr.appMeta?.tenant_id)

  // ---------------------------------------------------------------- 1) /me
  section("1) GET /me + auth gating")
  {
    const r = await api("GET", "/me", { token: hr.token })
    eqStatus(r, 200, "GET /me (hr)")
    ok(r.body?.role === "hr_admin", "me.role == hr_admin", r.body?.role)
    ok(r.body?.id === hr.empId, "me.id == hr employee id", r.body?.id)
    ok(r.body?.email === hr.email, "me.email matches", r.body?.email)

    const re = await api("GET", "/me", { token: emp.token })
    eqStatus(re, 200, "GET /me (employee)")
    ok(re.body?.role === "employee", "employee me.role == employee", re.body?.role)

    const rn = await api("GET", "/me")
    eqStatus(rn, 401, "GET /me no token")

    const rbad = await api("GET", "/me", { token: "not-a-real-jwt" })
    eqStatus(rbad, 401, "GET /me bad token")
  }

  // ------------------------------------------------- 2) tenant branding
  section("2) GET /api/tenant/branding")
  {
    const r = await api("GET", "/api/tenant/branding", { token: hr.token })
    eqStatus(r, 200, "GET branding")
    ok(r.body?.branding?.appName === A.name, "branding.appName == tenant name", r.body?.branding?.appName)
    ok(r.body?.features?.payroll === true, "features.payroll true")
  }

  // ------------------------------------------------- 3) departments CRUD
  section("3) departments CRUD + RBAC")
  let deptId
  {
    const create = await api("POST", "/departments", { token: hr.token, body: { name: "工程部" } })
    eqStatus(create, 201, "POST /departments (hr)")
    deptId = create.body?.id
    ok(!!deptId, "department id returned", deptId)

    const list = await api("GET", "/departments", { token: hr.token })
    eqStatus(list, 200, "GET /departments")
    ok(Array.isArray(list.body?.departments) && list.body.departments.some((d) => d.id === deptId), "created dept present in list")

    const patch = await api("PATCH", `/departments/${deptId}`, { token: hr.token, body: { name: "研發部" } })
    eqStatus(patch, 200, "PATCH /departments/:id")

    const empWrite = await api("POST", "/departments", { token: emp.token, body: { name: "X" } })
    eqStatus(empWrite, 403, "POST /departments as employee → forbidden")
    ok(empWrite.body?.error === "forbidden", "403 body error=forbidden", empWrite.body)
  }

  // ------------------------------------------------- 4) employees lifecycle
  section("4) employees POST/GET/PATCH/deactivate + RBAC")
  let invitedEmpId, invitedUserId
  {
    const ts = Date.now()
    const inviteEmail = `e2e-${ts}-invitee@example.com`
    const invite = await api("POST", "/employees", {
      token: hr.token,
      body: { email: inviteEmail, name: "新進員工", password: "Passw0rd!123", deptId },
    })
    eqStatus(invite, 201, "POST /employees (invite)")
    invitedEmpId = invite.body?.employeeId
    invitedUserId = invite.body?.userId
    ok(!!invitedEmpId && !!invitedUserId, "employeeId + userId returned")
    if (invitedUserId) created.userIds.push(invitedUserId) // ensure auth-user cleanup

    const list = await api("GET", "/employees", { token: hr.token })
    eqStatus(list, 200, "GET /employees")
    ok(list.body?.employees?.some((e) => e.id === invitedEmpId), "invited employee in list")
    ok(list.body?.employees?.every((e) => e.tenant_id === A.tenantId), "all employees scoped to tenant A")

    const patch = await api("PATCH", `/employees/${invitedEmpId}`, { token: hr.token, body: { empNo: "EMP-001" } })
    eqStatus(patch, 200, "PATCH /employees/:id")

    const deact = await api("POST", `/employees/${invitedEmpId}/deactivate`, { token: hr.token })
    eqStatus(deact, 200, "POST /employees/:id/deactivate")
    ok(deact.body?.status === "inactive", "deactivate sets status inactive", deact.body)

    const empWrite = await api("POST", "/employees", {
      token: emp.token,
      body: { email: `e2e-${ts}-x@example.com`, name: "x", password: "Passw0rd!123" },
    })
    eqStatus(empWrite, 403, "POST /employees as employee → forbidden")
  }

  // ------------------------------------------------- 5) shifts + schedules
  section("5) shifts CRUD + schedules assign/query")
  let shiftId
  {
    const create = await api("POST", "/shifts", {
      token: hr.token,
      body: { name: "日班", startTime: "09:00", endTime: "18:00", breakMinutes: 60 },
    })
    eqStatus(create, 201, "POST /shifts")
    shiftId = create.body?.id
    ok(!!shiftId, "shift id returned")

    const list = await api("GET", "/shifts", { token: hr.token })
    eqStatus(list, 200, "GET /shifts")
    ok(list.body?.shifts?.some((s) => s.id === shiftId), "shift in list")

    const patch = await api("PATCH", `/shifts/${shiftId}`, { token: hr.token, body: { breakMinutes: 45 } })
    eqStatus(patch, 200, "PATCH /shifts/:id")

    // assign employee a schedule today (used later by punch / detection / settle)
    const wd = todayUTC()
    const assign = await api("POST", "/schedules", {
      token: hr.token,
      body: { employeeId: emp.empId, workDate: wd, shiftId },
    })
    eqStatus(assign, 201, "POST /schedules (assign emp today)")
    ok(assign.body?.count === 1 && Array.isArray(assign.body?.ids), "schedule created (count=1)", assign.body)

    // HR sees all schedules
    const hrView = await api("GET", "/schedules", { token: hr.token })
    eqStatus(hrView, 200, "GET /schedules (hr)")
    ok(hrView.body?.schedules?.some((s) => s.employee_id === emp.empId && s.work_date === wd), "hr sees emp schedule")

    // employee sees only own
    const empView = await api("GET", "/schedules", { token: emp.token })
    eqStatus(empView, 200, "GET /schedules (employee)")
    ok(
      (empView.body?.schedules ?? []).every((s) => s.employee_id === emp.empId),
      "employee schedule view scoped to self",
    )
  }

  // ------------------------------------------------- 6) punch
  section("6) punch in/out/today + anti-proxy")
  {
    const pin = await api("POST", "/punch", { token: emp.token, body: { type: "in", source: "web" } })
    eqStatus(pin, 201, "POST /punch in (employee)")
    ok(pin.body?.type === "in" && !!pin.body?.punchAt, "punch in returns type+punchAt", pin.body)

    const today = await api("GET", "/punch/today", { token: emp.token })
    eqStatus(today, 200, "GET /punch/today")
    ok(today.body?.status === "working", "status working after in", today.body?.status)
    ok((today.body?.records ?? []).length >= 1, "today has >=1 record")

    const pout = await api("POST", "/punch", { token: emp.token, body: { type: "out", source: "web" } })
    eqStatus(pout, 201, "POST /punch out")
    ok(pout.body?.type === "out", "punch out type=out")

    // HR can query punches for the employee
    const hrQuery = await api("GET", `/punch?employeeId=${emp.empId}`, { token: hr.token })
    eqStatus(hrQuery, 200, "GET /punch?employeeId (hr)")
    ok((hrQuery.body?.records ?? []).every((r) => r.employee_id === emp.empId), "hr punch query scoped to that emp")

    // Anti-proxy: employee tries to punch FOR the manager (employeeId in body must be ignored)
    const proxy = await api("POST", "/punch", { token: emp.token, body: { type: "in", employeeId: mgr.empId } })
    eqStatus(proxy, 201, "POST /punch with foreign employeeId (ignored)")
    // verify the punch landed on emp, not mgr
    const mgrToday = await api("GET", "/punch/today", { token: mgr.token })
    ok((mgrToday.body?.records ?? []).length === 0, "anti-proxy: manager has NO punch from employee's spoof", mgrToday.body)
  }

  // ------------------------------------------------- 7) leave-types/flows/requests
  section("7) leave-types + approval-flows + requests lifecycle")
  let leaveTypeId
  {
    // leave type (HR writes, employee reads)
    const lt = await api("POST", "/leave-types", { token: hr.token, body: { code: "annual", name: "特休", paid: true } })
    eqStatus(lt, 201, "POST /leave-types")
    leaveTypeId = lt.body?.id
    ok(!!leaveTypeId, "leave type id")

    const ltRead = await api("GET", "/leave-types", { token: emp.token })
    eqStatus(ltRead, 200, "GET /leave-types (employee reads)")
    ok(ltRead.body?.leaveTypes?.some((x) => x.id === leaveTypeId), "employee sees leave type")

    const ltDup = await api("POST", "/leave-types", { token: hr.token, body: { code: "annual", name: "dup" } })
    eqStatus(ltDup, 409, "POST /leave-types duplicate code → 409")

    // approval flow: route 'leave' through the manager
    const flow = await api("PUT", "/approval-flows/leave", { token: hr.token, body: { approverEmpIds: [mgr.empId] } })
    eqStatus(flow, 200, "PUT /approval-flows/leave")
    ok(flow.body?.appliesTo === "leave" && JSON.stringify(flow.body?.approverEmpIds) === JSON.stringify([mgr.empId]), "flow returns manager as approver")

    const flowBadKind = await api("PUT", "/approval-flows/nonsense", { token: hr.token, body: { approverEmpIds: [] } })
    eqStatus(flowBadKind, 400, "PUT /approval-flows/:badkind → 400")

    // grant the employee an annual-leave balance so used can be observed later
    const year = new Date().getUTCFullYear()
    const bal = await api("PUT", "/leave-balances", {
      token: hr.token,
      body: { employeeId: emp.empId, leaveTypeId, year, entitled: 80 },
    })
    eqStatus(bal, 200, "PUT /leave-balances (entitled 80h)")

    // employee files a leave request (8h) — routed to manager
    const start = `${todayUTC()}T01:00:00.000Z`
    const end = `${todayUTC()}T09:00:00.000Z`
    const reqRes = await api("POST", "/requests", {
      token: emp.token,
      body: { kind: "leave", leaveTypeId, startAt: start, endAt: end, hours: 8, reason: "family" },
    })
    eqStatus(reqRes, 201, "POST /requests (leave, employee)")
    const requestId = reqRes.body?.requestId
    ok(!!requestId, "requestId returned")
    ok(reqRes.body?.steps?.[0]?.approverEmpId === mgr.empId, "step1 approver is manager", reqRes.body?.steps)

    // employee sees own request
    const empReqs = await api("GET", "/requests", { token: emp.token })
    eqStatus(empReqs, 200, "GET /requests (employee sees own)")
    ok(empReqs.body?.requests?.some((r) => r.id === requestId), "own request visible to filer")

    // manager sees the pending request awaiting them
    const mgrReqs = await api("GET", "/requests?status=pending", { token: mgr.token })
    eqStatus(mgrReqs, 200, "GET /requests?status=pending (manager)")
    ok(mgrReqs.body?.requests?.some((r) => r.id === requestId), "pending request visible to approver (manager)")

    // employee cannot approve (not current approver)
    const empApprove = await api("POST", `/requests/${requestId}/approve`, { token: emp.token, body: {} })
    eqStatus(empApprove, 403, "employee approve own → 403 not_current_approver")

    // manager approves → final step → approved
    const approve = await api("POST", `/requests/${requestId}/approve`, { token: mgr.token, body: { comment: "ok" } })
    eqStatus(approve, 200, "POST /requests/:id/approve (manager)")
    ok(approve.body?.status === "approved", "request approved (single-step flow)", approve.body)

    // approving again → 409 not_pending
    const reApprove = await api("POST", `/requests/${requestId}/approve`, { token: mgr.token, body: {} })
    eqStatus(reApprove, 409, "re-approve approved request → 409 not_pending")

    // --- reject path on a second request
    const r2 = await api("POST", "/requests", {
      token: emp.token,
      body: { kind: "leave", leaveTypeId, startAt: start, endAt: end, hours: 4 },
    })
    const r2id = r2.body?.requestId
    const reject = await api("POST", `/requests/${r2id}/reject`, { token: mgr.token, body: { comment: "no" } })
    eqStatus(reject, 200, "POST /requests/:id/reject (manager)")
    ok(reject.body?.status === "rejected", "request rejected", reject.body)

    // --- cancel path on a third request (only filer can cancel)
    const r3 = await api("POST", "/requests", {
      token: emp.token,
      body: { kind: "leave", leaveTypeId, startAt: start, endAt: end, hours: 2 },
    })
    const r3id = r3.body?.requestId
    const mgrCancel = await api("POST", `/requests/${r3id}/cancel`, { token: mgr.token })
    eqStatus(mgrCancel, 403, "manager cancel employee request → 403 not_the_filer")
    const cancel = await api("POST", `/requests/${r3id}/cancel`, { token: emp.token })
    eqStatus(cancel, 200, "POST /requests/:id/cancel (filer)")
    ok(cancel.body?.status === "cancelled", "request cancelled", cancel.body)

    // stash for step 10 leave-balance assertion
    A._leaveTypeId = leaveTypeId
  }

  // ------------------------------------------------- 8) announcements CRUD
  section("8) announcements CRUD")
  {
    const c = await api("POST", "/announcements", { token: hr.token, body: { title: "公告", body: "內容" } })
    eqStatus(c, 201, "POST /announcements")
    const annId = c.body?.id
    const list = await api("GET", "/announcements", { token: emp.token })
    eqStatus(list, 200, "GET /announcements (employee reads)")
    ok(list.body?.announcements?.some((a) => a.id === annId), "announcement visible")
    const patch = await api("PATCH", `/announcements/${annId}`, { token: hr.token, body: { title: "更新公告" } })
    eqStatus(patch, 200, "PATCH /announcements/:id")
    const del = await api("DELETE", `/announcements/${annId}`, { token: hr.token })
    eqStatus(del, 200, "DELETE /announcements/:id")
    const empWrite = await api("POST", "/announcements", { token: emp.token, body: { title: "x", body: "y" } })
    eqStatus(empWrite, 403, "POST /announcements as employee → forbidden")
  }

  // ------------------------------------------------- 9) rule-config / salary / attendance / payroll
  section("9) rule-config + salary + attendance settle + payroll run/finalize/re-run")
  {
    // rule-config: PUT a config with weekday_ot compTime:true (needed for step 10 comp-time)
    const cfg = {
      attendance_bonus: { base: 0, tiers: [{ lateMinutesUpTo: null, deduct: 0 }] },
      overtime: {
        rules: [
          { when: "weekday_ot", multiplier: 1.34, compTime: true },
          { when: "rest_day", multiplier: 1.67 },
          { when: "fixed_holiday", multiplier: 2 },
        ],
      },
      night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
      payroll: { method: "monthly", dailyRegularHours: 8 },
    }
    const putCfg = await api("PUT", "/rule-config", { token: hr.token, body: cfg })
    eqStatus(putCfg, 200, "PUT /rule-config")
    ok(typeof putCfg.body?.version === "number", "rule-config version returned", putCfg.body)

    const getCfg = await api("GET", "/rule-config", { token: hr.token })
    eqStatus(getCfg, 200, "GET /rule-config")
    ok(getCfg.body?.config?.overtime?.rules?.[0]?.compTime === true, "stored config has weekday_ot compTime true")

    const getCfgEmp = await api("GET", "/rule-config", { token: emp.token })
    eqStatus(getCfgEmp, 200, "GET /rule-config (employee read allowed)")

    // salary for the employee (monthly base)
    const sal = await api("PUT", `/salary/${emp.empId}`, {
      token: hr.token,
      body: { method: "monthly", baseSalary: 36000, hourlyWage: 200 },
    })
    eqStatus(sal, 200, "PUT /salary/:employeeId")
    const getSal = await api("GET", `/salary/${emp.empId}`, { token: hr.token })
    eqStatus(getSal, 200, "GET /salary/:employeeId")
    ok(Number(getSal.body?.salary?.base_salary) === 36000, "salary base_salary persisted", getSal.body?.salary)

    // settle attendance for today's window (employee punched in+out earlier)
    const wd = todayUTC()
    const settle = await api("POST", "/attendance/settle", {
      token: hr.token,
      body: { employeeId: emp.empId, from: wd, to: wd },
    })
    eqStatus(settle, 200, "POST /attendance/settle")
    ok(typeof settle.body?.settled === "number" && settle.body.settled >= 1, "settled >=1 day", settle.body)

    const days = await api("GET", `/attendance-days?employeeId=${emp.empId}&from=${wd}&to=${wd}`, { token: hr.token })
    eqStatus(days, 200, "GET /attendance-days")
    ok((days.body?.attendanceDays ?? []).some((d) => d.work_date === wd), "attendance day present for today")

    // payroll run for this month
    const period = monthUTC()
    const run1 = await api("POST", "/payroll/run", { token: hr.token, body: { employeeId: emp.empId, period } })
    eqStatus(run1, 201, "POST /payroll/run (first)")
    ok(run1.body?.generated >= 1, "payroll generated >=1 payslip", run1.body)

    const slips = await api("GET", `/payslips?employeeId=${emp.empId}&period=${period}`, { token: hr.token })
    eqStatus(slips, 200, "GET /payslips")
    const slip = slips.body?.payslips?.[0]
    ok(!!slip?.id, "payslip row exists")
    ok(slip?.status === "draft", "payslip status draft before finalize", slip?.status)

    // re-run while draft → regenerates (still generated, skipped empty)
    const run2 = await api("POST", "/payroll/run", { token: hr.token, body: { employeeId: emp.empId, period } })
    eqStatus(run2, 201, "POST /payroll/run (re-run draft)")
    ok((run2.body?.skipped ?? []).length === 0, "draft re-run does not skip", run2.body)

    // finalize
    const fin = await api("POST", `/payslips/${slip.id}/finalize`, { token: hr.token })
    eqStatus(fin, 200, "POST /payslips/:id/finalize")
    ok(fin.body?.status === "finalized", "payslip finalized", fin.body)

    // re-finalize → 409
    const refin = await api("POST", `/payslips/${slip.id}/finalize`, { token: hr.token })
    eqStatus(refin, 409, "re-finalize → 409 already_finalized")

    // re-run after finalize → skipped contains employee, generated 0
    const run3 = await api("POST", "/payroll/run", { token: hr.token, body: { employeeId: emp.empId, period } })
    eqStatus(run3, 201, "POST /payroll/run (after finalize)")
    ok((run3.body?.skipped ?? []).includes(emp.empId), "finalized employee skipped on re-run", run3.body)
    ok(run3.body?.generated === 0, "generated 0 after finalize", run3.body)

    A._period = period
  }

  // ------------------------------------------------- 10) leave-balances used + comp-time
  section("10) leave-balances used increment + comp-time accrual + adjust")
  {
    const year = new Date().getUTCFullYear()
    // earlier (step 7) we approved an 8h leave → used should be 8
    const bal = await api("GET", `/leave-balances?employeeId=${emp.empId}&year=${year}`, { token: hr.token })
    eqStatus(bal, 200, "GET /leave-balances")
    const row = (bal.body?.balances ?? []).find((b) => b.leave_type_id === A._leaveTypeId)
    ok(!!row, "annual leave balance row present")
    ok(Number(row?.used) === 8, "leave used incremented to 8 after approval", row)
    ok(Number(row?.entitled) === 80, "entitled preserved at 80", row)

    // comp-time via approved OT request (rule_config has weekday_ot compTime:true)
    const start = `${todayUTC()}T10:00:00.000Z`
    const end = `${todayUTC()}T13:00:00.000Z`
    // route ot through manager
    await api("PUT", "/approval-flows/ot", { token: hr.token, body: { approverEmpIds: [mgr.empId] } })
    const otReq = await api("POST", "/requests", {
      token: emp.token,
      body: { kind: "ot", startAt: start, endAt: end, hours: 3, reason: "deadline" },
    })
    eqStatus(otReq, 201, "POST /requests (ot)")
    const otId = otReq.body?.requestId
    const otApprove = await api("POST", `/requests/${otId}/approve`, { token: mgr.token, body: {} })
    eqStatus(otApprove, 200, "approve ot request")
    ok(otApprove.body?.status === "approved", "ot approved")

    const ct = await api("GET", `/comp-time?employeeId=${emp.empId}`, { token: hr.token })
    eqStatus(ct, 200, "GET /comp-time")
    ok(Number(ct.body?.balance) === 3, "comp-time balance == 3h after approved OT", ct.body)
    ok((ct.body?.entries ?? []).some((e) => Number(e.hours_earned) === 3 && e.source_request_id === otId), "ledger entry sourced from OT request")

    // adjust: deduct 1h used
    const adj = await api("POST", "/comp-time/adjust", {
      token: hr.token,
      body: { employeeId: emp.empId, hoursUsed: 1, note: "manual use" },
    })
    eqStatus(adj, 201, "POST /comp-time/adjust")
    const ct2 = await api("GET", `/comp-time?employeeId=${emp.empId}`, { token: hr.token })
    ok(Number(ct2.body?.balance) === 2, "comp-time balance == 2h after adjust(used 1)", ct2.body)
  }

  // ------------------------------------------------- 11) reports + CSV + RBAC
  section("11) reports attendance/payroll/leave/headcount (+csv) + RBAC")
  {
    const wd = todayUTC()
    const period = A._period
    const att = await api("GET", `/reports/attendance?from=${wd}&to=${wd}`, { token: hr.token })
    eqStatus(att, 200, "GET /reports/attendance")
    ok(Array.isArray(att.body?.rows), "attendance report rows[]")

    const attCsv = await api("GET", `/reports/attendance?from=${wd}&to=${wd}&format=csv`, { token: hr.token })
    eqStatus(attCsv, 200, "GET /reports/attendance?format=csv")
    const ctype = attCsv.headers.get("content-type") ?? ""
    ok(ctype.includes("text/csv"), "attendance csv content-type text/csv", ctype)
    ok(typeof attCsv.text === "string" && attCsv.text.includes("employeeId"), "csv has header row")

    const pay = await api("GET", `/reports/payroll?period=${period}`, { token: hr.token })
    eqStatus(pay, 200, "GET /reports/payroll")
    ok(typeof pay.body?.total?.gross === "number", "payroll report total.gross number", pay.body?.total)

    const lv = await api("GET", `/reports/leave?from=${wd}&to=${wd}`, { token: hr.token })
    eqStatus(lv, 200, "GET /reports/leave")
    ok(Array.isArray(lv.body?.rows) && Array.isArray(lv.body?.details), "leave report rows+details")

    const hc = await api("GET", "/reports/headcount", { token: hr.token })
    eqStatus(hc, 200, "GET /reports/headcount")
    ok(typeof hc.body?.total === "number" && hc.body?.byStatus && hc.body?.byRole, "headcount total+byStatus+byRole")

    const empReport = await api("GET", `/reports/attendance?from=${wd}&to=${wd}`, { token: emp.token })
    eqStatus(empReport, 403, "reports as employee → forbidden")
  }

  // ------------------------------------------------- 12) KPI templates + reviews
  section("12) kpi-templates + kpi-reviews lifecycle (weighted total)")
  {
    const tmpl = await api("POST", "/kpi-templates", {
      token: hr.token,
      body: {
        name: "季度考核",
        items: [
          { key: "quality", label: "品質", weight: 60, maxScore: 10 },
          { key: "attitude", label: "態度", weight: 40, maxScore: 10 },
        ],
      },
    })
    eqStatus(tmpl, 201, "POST /kpi-templates")
    const templateId = tmpl.body?.id
    ok(!!templateId, "template id")

    const tmplList = await api("GET", "/kpi-templates", { token: emp.token })
    eqStatus(tmplList, 200, "GET /kpi-templates (employee reads)")
    ok(tmplList.body?.templates?.some((t) => t.id === templateId), "template visible")

    // assign review: employee reviewed by manager
    const assign = await api("POST", "/kpi-reviews", {
      token: hr.token,
      body: { employeeId: emp.empId, reviewerEmpId: mgr.empId, templateId, period: monthUTC() },
    })
    eqStatus(assign, 201, "POST /kpi-reviews (assign)")
    const reviewId = assign.body?.id
    ok(!!reviewId, "review id")

    // duplicate assign → 409
    const dupAssign = await api("POST", "/kpi-reviews", {
      token: hr.token,
      body: { employeeId: emp.empId, reviewerEmpId: mgr.empId, templateId, period: monthUTC() },
    })
    eqStatus(dupAssign, 409, "duplicate review → 409 review_already_exists")

    // manager (appraiser) scores: quality 8/10*60 + attitude 9/10*40 = 48+36 = 84
    const score = await api("PATCH", `/kpi-reviews/${reviewId}`, {
      token: mgr.token,
      body: { scores: [{ key: "quality", score: 8 }, { key: "attitude", score: 9 }] },
    })
    eqStatus(score, 200, "PATCH /kpi-reviews/:id (score, manager)")
    ok(Number(score.body?.totalScore) === 84, "weighted total == 84", score.body)

    // employee cannot score (not appraiser)
    const empScore = await api("PATCH", `/kpi-reviews/${reviewId}`, {
      token: emp.token,
      body: { scores: [{ key: "quality", score: 1 }] },
    })
    eqStatus(empScore, 403, "employee score → 403 not_the_appraiser")

    // submit (manager)
    const submit = await api("POST", `/kpi-reviews/${reviewId}/submit`, { token: mgr.token })
    eqStatus(submit, 200, "POST /kpi-reviews/:id/submit")
    ok(submit.body?.status === "submitted", "review submitted")

    // reviewee cannot see before finalize
    const empViewBefore = await api("GET", "/kpi-reviews", { token: emp.token })
    eqStatus(empViewBefore, 200, "GET /kpi-reviews (reviewee, pre-finalize)")
    ok(!(empViewBefore.body?.reviews ?? []).some((r) => r.id === reviewId), "reviewee cannot see submitted (not finalized) review")

    // finalize (HR only) — manager cannot
    const mgrFin = await api("POST", `/kpi-reviews/${reviewId}/finalize`, { token: mgr.token })
    eqStatus(mgrFin, 403, "manager finalize → 403 forbidden")
    const fin = await api("POST", `/kpi-reviews/${reviewId}/finalize`, { token: hr.token })
    eqStatus(fin, 200, "POST /kpi-reviews/:id/finalize (hr)")
    ok(fin.body?.status === "finalized", "review finalized")

    // now reviewee can see it
    const empViewAfter = await api("GET", "/kpi-reviews", { token: emp.token })
    ok((empViewAfter.body?.reviews ?? []).some((r) => r.id === reviewId), "reviewee sees finalized review")
  }

  // ------------------------------------------------- 13) detection + notifications
  section("13) detection scan-missing-punch → notifications, anomalies, late-stats")
  {
    // The employee punched IN today on a scheduled day but we need a 'no_out'
    // scenario. They DID punch out in step 6, so today is healthy. Create a
    // fresh scheduled employee with an IN-only punch to force a missing punch.
    const ts = Date.now()
    const moEmail = `e2e-${ts}-missing@example.com`
    const moPass = `Pw-${ts}-mo-Aa1!`
    const { data: moUser } = await admin.auth.admin.createUser({
      email: moEmail, password: moPass, email_confirm: true, app_metadata: { tenant_id: A.tenantId },
    })
    created.userIds.push(moUser.user.id)
    const { data: moEmp } = await admin
      .from("employees")
      .insert({ tenant_id: A.tenantId, user_id: moUser.user.id, name: "缺卡員工", role: "employee", employment_type: "regular", status: "active" })
      .select("id")
      .single()
    const wd = todayUTC()
    await api("POST", "/schedules", { token: hr.token, body: { employeeId: moEmp.id, workDate: wd, shiftId } })
    const moTok = (await signIn(moEmail, moPass)).token
    await api("POST", "/punch", { token: moTok, body: { type: "in" } }) // in only, no out

    const scan = await api("POST", "/attendance/scan-missing-punch", { token: hr.token, body: { date: wd } })
    eqStatus(scan, 200, "POST /attendance/scan-missing-punch")
    ok(Array.isArray(scan.body?.missing) && scan.body.missing.some((m) => m.employeeId === moEmp.id && m.issue === "no_out"), "missing punch flagged (no_out)", scan.body)
    ok(scan.body?.queued >= 1, "notification queued >=1", scan.body)

    // re-scan idempotent (queued 0 for same finding)
    const scan2 = await api("POST", "/attendance/scan-missing-punch", { token: hr.token, body: { date: wd } })
    ok(scan2.body?.queued === 0, "re-scan idempotent (queued 0)", scan2.body)

    // notification appears: HR sees all; the offending employee sees their own
    const notifsHr = await api("GET", "/notifications", { token: hr.token })
    eqStatus(notifsHr, 200, "GET /notifications (hr)")
    ok((notifsHr.body?.notifications ?? []).some((n) => n.employee_id === moEmp.id && n.type === "missing_punch"), "hr sees missing_punch notification")

    const notifsEmp = await api("GET", "/notifications", { token: moTok })
    eqStatus(notifsEmp, 200, "GET /notifications (offending employee)")
    const ownNotif = (notifsEmp.body?.notifications ?? []).find((n) => n.type === "missing_punch")
    ok(!!ownNotif, "employee sees own missing_punch notification")
    ok((notifsEmp.body?.notifications ?? []).every((n) => n.employee_id === moEmp.id), "employee notification view scoped to self")

    // mark read
    if (ownNotif) {
      const read = await api("POST", `/notifications/${ownNotif.id}/read`, { token: moTok })
      eqStatus(read, 200, "POST /notifications/:id/read")
      ok(read.body?.read === true, "notification marked read")
    }

    // anomalies + late-stats (HR only) — just assert shape + RBAC
    const anom = await api("GET", `/attendance/anomalies?from=${wd}&to=${wd}`, { token: hr.token })
    eqStatus(anom, 200, "GET /attendance/anomalies")
    ok(Array.isArray(anom.body?.anomalies), "anomalies[] returned")

    const late = await api("GET", `/attendance/late-stats?from=${wd}&to=${wd}`, { token: hr.token })
    eqStatus(late, 200, "GET /attendance/late-stats")
    ok(Array.isArray(late.body?.rows), "late-stats rows[]")

    const empAnom = await api("GET", `/attendance/anomalies?from=${wd}&to=${wd}`, { token: emp.token })
    eqStatus(empAnom, 403, "anomalies as employee → forbidden")
  }

  // ------------------------------------------------- 14) cross-tenant isolation
  section("14) cross-tenant isolation (tenant A vs tenant B)")
  {
    const B = await provisionTenant("E2E-B", [
      { key: "hr", role: "hr_admin" },
      { key: "emp", role: "employee" },
    ])
    // give B a department + employee to look for
    const bDept = await api("POST", "/departments", { token: B.users.hr.token, body: { name: "B部門" } })
    const bDeptId = bDept.body?.id

    // A's HR lists employees — must NOT contain any B employee
    const aEmps = await api("GET", "/employees", { token: hr.token })
    ok((aEmps.body?.employees ?? []).every((e) => e.tenant_id === A.tenantId), "A employees never include B tenant rows")
    ok(!(aEmps.body?.employees ?? []).some((e) => e.id === B.users.emp.empId), "A cannot see B's employee row")

    // A's HR lists departments — must NOT contain B's department
    const aDepts = await api("GET", "/departments", { token: hr.token })
    ok(!(aDepts.body?.departments ?? []).some((d) => d.id === bDeptId), "A cannot see B's department")

    // A's HR tries to PATCH B's department → 404 (tenant-scoped)
    const crossPatch = await api("PATCH", `/departments/${bDeptId}`, { token: hr.token, body: { name: "hijack" } })
    eqStatus(crossPatch, 404, "A patching B's department → 404 (isolation)")

    // A's branding != B's
    const aBrand = await api("GET", "/api/tenant/branding", { token: hr.token })
    ok(aBrand.body?.branding?.appName === A.name, "A branding is A's, not B's", aBrand.body?.branding?.appName)
  }
}

// ===========================================================================
let runError = null
try {
  await main()
} catch (err) {
  runError = err
  console.error("\n!!! RUN ABORTED:", err?.stack || err)
}

await teardown().catch((e) => console.error("teardown error:", e))

console.log(`\n========================================`)
console.log(`PASS: ${PASS} FAIL: ${FAIL}`)
if (failures.length) {
  console.log(`\nFAIL details:`)
  for (const f of failures) {
    console.log(`  [${f.section}] ${f.label}`)
    if (f.detail) console.log(`      ${typeof f.detail === "string" ? f.detail : JSON.stringify(f.detail)}`)
  }
}
if (runError) console.log(`\nRun aborted early: ${runError?.message}`)
console.log(`========================================`)

process.exit(FAIL === 0 && !runError ? 0 : 1)
