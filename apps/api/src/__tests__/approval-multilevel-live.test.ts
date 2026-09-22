import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * 多級簽核（小主管 → 大主管 → HR 覆核）＋ 部門多位主管 — live 合約測試
 * （throwaway 租戶，仿 approval-chain-live.test.ts）。
 *
 * 流程：HR×2（租戶管理員＋第二位 hr_admin）、主管 m1／m2、部門 A（managerEmpIds [m1, m2]）、
 * 員工 e 在 A → PUT /approval-flows/fix_punch mode=manager_hr → e 送補卡 → 三關
 * （m1、m2、HR 群含兩位 HR）→ m2 在第 1 關簽 403 → m1 簽進第 2 關（m2 收 advanced）→
 * m2 簽進第 3 關（兩位 HR 都收 advanced）→ HR1 在 pending-approvals 看得到 → HR2 簽 →
 * approved、approver_emp_id 變 HR2 → HR1 看不到了 → mode=manager 仍只有一關 →
 * PATCH /departments {managerEmpIds:[m2,m1]} 鏈順序反轉 → managerEmpId 相容寫法 →
 * 催簽通知全部候選、change-approver 候選改成一人、/me isManager 對第 2 位主管也 true、
 * 主管鏈上的人與 HR 候選可看附件。
 *
 * 正式庫尚未套 migration 0049（departments.manager_emp_ids／approval_steps.candidate_emp_ids）
 * 時整組 describe.skipIf 跳過；套完後直接跑即可（欄位自動探測），
 * 或 `MULTI_APPROVAL_MIGRATED=1 npx vitest run src/__tests__/approval-multilevel-live.test.ts`。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const a = await supabaseAdmin.from("departments").select("manager_emp_ids").limit(1)
  const b = await supabaseAdmin.from("approval_steps").select("candidate_emp_ids, step_kind").limit(1)
  return !a.error && !b.error
}
const ready = await migrated()
if (!ready && process.env.MULTI_APPROVAL_MIGRATED) {
  console.warn("[approval-multilevel-live] MULTI_APPROVAL_MIGRATED 已設，但正式庫還沒有 migration 0049 的欄位——整組跳過")
}

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let hr1Id: string
let hr2Id: string
let hr2Token: string
let m1Id: string
let m1Token: string
let m2Id: string
let m2Token: string
let empId: string
let empToken: string
let deptId: string

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
  const email = `multi-${stamp}-${opts.label}@example.com`
  const password = `Pw-${stamp}-${opts.label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${opts.label}-${stamp}`,
    password,
    role: opts.role,
    deptId: opts.deptId ?? null,
    empNo: `M-${opts.label}`,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${opts.label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, token: await signIn(email, password) }
}
let day = 1
async function fileFixPunch(token: string, reason: string) {
  const d = String(day++).padStart(2, "0")
  return as(token, request(app).post("/requests")).send({
    kind: "fix_punch",
    startAt: `2027-09-${d}T10:05:00.000Z`,
    endAt: `2027-09-${d}T10:05:00.000Z`,
    reason,
    segments: [{ date: `2027-09-${d}`, startTime: "18:05", endTime: "18:05", hours: 0, type: "out" }],
  })
}
async function notificationsFor(employeeId: string, event: string, requestId: string) {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .select("id, employee_id, title, body, payload")
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
    .select("step_order, approver_emp_id, candidate_emp_ids, step_kind, decision, acted_by_emp_id")
    .eq("tenant_id", tenantId)
    .eq("request_id", requestId)
    .order("step_order", { ascending: true })
  if (error) throw new Error(`steps: ${error.message}`)
  return data ?? []
}
async function pendingFor(token: string) {
  const res = await as(token, request(app).get("/requests/pending-approvals"))
  expect(res.status).toBe(200)
  return res.body.requests as Array<Record<string, unknown>>
}
type StepView = { stepOrder: number; approverEmpId: string; approverName: string | null; candidateEmpIds: string[]; candidateNames: string[]; kind: string }

describe.skipIf(!ready)("多級簽核 — live", () => {
  beforeAll(async () => {
    const adminEmail = `multi-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `MULTITEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("user_id", p.userId).single()
    hr1Id = hr!.id as string

    const hr2 = await createEmployee({ label: "hr2", role: "hr_admin" })
    hr2Id = hr2.id
    hr2Token = hr2.token
    const m1 = await createEmployee({ label: "m1", role: "manager" })
    m1Id = m1.id
    m1Token = m1.token
    const m2 = await createEmployee({ label: "m2", role: "manager" })
    m2Id = m2.id
    m2Token = m2.token

    const dept = await as(adminToken, request(app).post("/departments")).send({ name: `工程部 ${stamp}`, managerEmpIds: [m1Id, m2Id] })
    expect(dept.status).toBe(201)
    deptId = dept.body.id

    const emp = await createEmployee({ label: "emp", role: "employee", deptId })
    empId = emp.id
    empToken = emp.token
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      try {
        await purgeTestTenant(tid)
      } catch (err) {
        console.warn(`[approval-multilevel-live] purge ${tid} 失敗：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("部門多位主管", () => {
    it("POST /departments managerEmpIds [m1, m2] → GET /departments 回 manager_emp_ids／managers[]／manager_label「A → B」，manager_emp_id＝第 1 位", async () => {
      const list = await as(adminToken, request(app).get("/departments"))
      expect(list.status).toBe(200)
      const row = (list.body.departments as Array<Record<string, unknown>>).find((d) => d.id === deptId)!
      expect(row.manager_emp_ids).toEqual([m1Id, m2Id])
      expect(row.manager_emp_id).toBe(m1Id)
      expect(row.manager_name).toBe(`m1-${stamp}`)
      expect((row.managers as Array<{ id: string; label: string }>).map((m) => m.id)).toEqual([m1Id, m2Id])
      expect(row.manager_label).toBe(`M-m1 · m1-${stamp} → M-m2 · m2-${stamp}`)
    })

    it("GET /org-chart 節點帶 managerEmpIds／managers[]；managerEmpId 仍是第 1 位", async () => {
      const res = await as(empToken, request(app).get("/org-chart"))
      expect(res.status).toBe(200)
      const node = (res.body.tree as Array<Record<string, unknown>>).find((n) => n.id === deptId)!
      expect(node.managerEmpIds).toEqual([m1Id, m2Id])
      expect(node.managerEmpId).toBe(m1Id)
      expect((node.managers as Array<{ id: string }>).map((m) => m.id)).toEqual([m1Id, m2Id])
      expect(node.managerLabel).toContain(" → ")
    })

    it("GET /me：第 2 位主管 m2 也是 isManager；員工不是", async () => {
      const me2 = await as(m2Token, request(app).get("/me"))
      expect(me2.status).toBe(200)
      expect(me2.body.isManager).toBe(true)
      const meE = await as(empToken, request(app).get("/me"))
      expect(meE.body.isManager).toBe(false)
    })

    it("主管不是本租戶員工 → 400 manager_not_in_tenant；重複 id 去重", async () => {
      const bad = await as(adminToken, request(app).post("/departments")).send({
        name: `壞部門 ${stamp}`,
        managerEmpIds: [m1Id, "00000000-0000-4000-8000-000000000999"],
      })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("manager_not_in_tenant")
      expect(bad.body.details.managerEmpIds).toEqual(["00000000-0000-4000-8000-000000000999"])

      const dup = await as(adminToken, request(app).post("/departments")).send({ name: `重複 ${stamp}`, managerEmpIds: [m2Id, m2Id, m1Id] })
      expect(dup.status).toBe(201)
      const { data } = await supabaseAdmin.from("departments").select("manager_emp_id, manager_emp_ids").eq("id", dup.body.id).single()
      expect(data!.manager_emp_ids).toEqual([m2Id, m1Id])
      expect(data!.manager_emp_id).toBe(m2Id)
    })
  })

  describe("manager_hr：三關逐級簽核", () => {
    let reqId: string

    it("PUT /approval-flows/fix_punch mode=manager_hr → 200；省略 mode 的 PUT 保留 manager_hr", async () => {
      const put = await as(adminToken, request(app).put("/approval-flows/fix_punch")).send({ mode: "manager_hr" })
      expect(put.status).toBe(200)
      expect(put.body.mode).toBe("manager_hr")
      const keep = await as(adminToken, request(app).put("/approval-flows/fix_punch")).send({ approverEmpIds: [] })
      expect(keep.status).toBe(200)
      expect(keep.body.mode).toBe("manager_hr")
      const list = await as(adminToken, request(app).get("/approval-flows"))
      const flow = (list.body.flows as Array<{ applies_to: string; mode: string }>).find((f) => f.applies_to === "fix_punch")!
      expect(flow.mode).toBe("manager_hr")
    })

    it("e 送補卡 → 201 三關：m1、m2、HR 群（含兩位 HR）；approvalSource=manager_hr；只有 m1 收到 submitted", async () => {
      const res = await fileFixPunch(empToken, "忘了打下班卡")
      expect(res.status).toBe(201)
      reqId = res.body.requestId
      expect(res.body.approvalSource).toBe("manager_hr")
      expect(res.body.notified).toBe(1)
      const steps = res.body.steps as StepView[]
      expect(steps.map((s) => s.candidateEmpIds)).toEqual([[m1Id], [m2Id], [hr1Id, hr2Id]])
      expect(steps.map((s) => s.kind)).toEqual(["manager", "manager", "hr"])
      expect(steps.map((s) => s.approverEmpId)).toEqual([m1Id, m2Id, hr1Id])
      expect(steps[0].approverName).toBe(`m1-${stamp}`)
      expect(steps[2].candidateNames).toHaveLength(2)
      expect(steps[2].candidateNames).toContain(`hr2-${stamp}`)

      const db = await stepsOf(reqId)
      expect(db.map((s) => s.candidate_emp_ids)).toEqual([[m1Id], [m2Id], [hr1Id, hr2Id]])
      expect(db.map((s) => s.step_kind)).toEqual(["manager", "manager", "hr"])
      expect(db.map((s) => s.approver_emp_id)).toEqual([m1Id, m2Id, hr1Id])

      expect(await notificationsFor(m1Id, "submitted", reqId)).toHaveLength(1)
      expect(await notificationsFor(m2Id, "submitted", reqId)).toHaveLength(0)
      expect(await notificationsFor(hr2Id, "submitted", reqId)).toHaveLength(0)
    })

    it("m2（第 2 關）在第 1 關就簽 → 403 not_current_approver；員工自己也 403", async () => {
      const early = await as(m2Token, request(app).post(`/requests/${reqId}/approve`)).send({})
      expect(early.status).toBe(403)
      expect(early.body.error).toBe("not_current_approver")
      const self = await as(empToken, request(app).post(`/requests/${reqId}/approve`)).send({})
      expect(self.status).toBe(403)
    })

    it("m1 簽 → pending、進第 2 關；m2 收到 advanced（第 2 關，共 3 關）", async () => {
      const res = await as(m1Token, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "小主管准" })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ status: "pending", currentStep: 2, notified: 1 })
      const adv = await notificationsFor(m2Id, "advanced", reqId)
      expect(adv).toHaveLength(1)
      expect(adv[0].body).toContain("第 2 關，共 3 關")
      expect(adv[0].payload).toMatchObject({ candidateEmpIds: [m2Id], stepKind: "manager" })
    })

    it("m2 簽 → pending、進第 3 關；兩位 HR 都收到 advanced（HR 覆核）", async () => {
      const res = await as(m2Token, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "大主管准" })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ status: "pending", currentStep: 3, notified: 2 })
      for (const hrId of [hr1Id, hr2Id]) {
        const adv = await notificationsFor(hrId, "advanced", reqId)
        expect(adv).toHaveLength(1)
        expect(adv[0].body).toContain("第 3 關，共 3 關")
        expect(adv[0].body).toContain("HR 覆核")
        expect(adv[0].payload).toMatchObject({ candidateEmpIds: [hr1Id, hr2Id], stepKind: "hr", approverEmpId: hr1Id })
      }
    })

    it("第 3 關時 HR1 與 HR2 在 GET /requests/pending-approvals 都看得到（候選、姓名、HR 覆核前綴）；m1 看不到", async () => {
      for (const token of [adminToken, hr2Token]) {
        const rows = await pendingFor(token)
        const row = rows.find((r) => r.id === reqId)!
        expect(row).toBeTruthy()
        expect(row.current_step).toBe(3)
        expect(row.total_steps).toBe(3)
        expect(row.current_approver_emp_id).toBe(hr1Id)
        expect(row.current_candidate_emp_ids).toEqual([hr1Id, hr2Id])
        expect(row.current_step_kind).toBe("hr")
        expect(row.current_approver_names).toHaveLength(2)
        expect(row.current_approver_names).toContain(`hr2-${stamp}`)
        expect(row.current_approver_name as string).toMatch(/^HR 覆核：.+／.+$/)
        expect(row.employee_name).toBe(`emp-${stamp}`)
        expect(row.employee_emp_no).toBe("M-emp")
        expect(row.department_name).toBe(`工程部 ${stamp}`)
        expect(row.attachment_count).toBe(0)
        expect((row.steps as Array<{ kind: string; decision: string }>).map((s) => [s.kind, s.decision])).toEqual([
          ["manager", "approved"],
          ["manager", "approved"],
          ["hr", "pending"],
        ])
      }
      const m1Rows = await pendingFor(m1Token)
      expect(m1Rows.some((r) => r.id === reqId)).toBe(false)
      // 非 HR 的 GET /requests（本人 ∪ 輪到我）：m2 已簽過、不再輪到 → 看不到；e 自己看得到
      const mine = await as(empToken, request(app).get("/requests?scope=mine"))
      expect((mine.body.requests as Array<Record<string, unknown>>).find((r) => r.id === reqId)?.current_approver_name).toMatch(/^HR 覆核：/)
    })

    it("催簽 → 該關全部候選（兩位 HR）都收到；employeeIds 列出候選", async () => {
      const res = await as(empToken, request(app).post(`/requests/${reqId}/remind`)).send({})
      expect(res.status).toBe(200)
      expect(res.body.notified).toBe(2)
      expect(res.body.employeeId).toBe(hr1Id)
      expect(res.body.employeeIds).toEqual([hr1Id, hr2Id])
      const { data } = await supabaseAdmin
        .from("notifications")
        .select("employee_id")
        .eq("tenant_id", tenantId)
        .eq("title", "待簽核提醒")
        .eq("payload->>requestId", reqId)
      expect((data ?? []).map((n) => n.employee_id).sort()).toEqual([hr1Id, hr2Id].sort())
    })

    it("HR2（候選之一，非 override）簽 → approved；第 3 關 approver_emp_id 改寫成 HR2、acted_by＝HR2；申請人收到 approved", async () => {
      const res = await as(hr2Token, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "HR 覆核完成" })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe("approved")
      const db = await stepsOf(reqId)
      expect(db[2]).toMatchObject({ decision: "approved", approver_emp_id: hr2Id, acted_by_emp_id: hr2Id, candidate_emp_ids: [hr1Id, hr2Id] })
      expect(db[0]).toMatchObject({ decision: "approved", approver_emp_id: m1Id, acted_by_emp_id: m1Id })
      const n = await notificationsFor(empId, "approved", reqId)
      expect(n).toHaveLength(1)
      expect(n[0].payload).toMatchObject({ actedByEmpId: hr2Id })
    })

    it("簽完後 HR1／HR2 的 pending-approvals 都不再有這張單；列表上 current_approver 顯示實際簽的人", async () => {
      expect((await pendingFor(adminToken)).some((r) => r.id === reqId)).toBe(false)
      expect((await pendingFor(hr2Token)).some((r) => r.id === reqId)).toBe(false)
      const all = await as(adminToken, request(app).get("/requests?status=approved"))
      const row = (all.body.requests as Array<Record<string, unknown>>).find((r) => r.id === reqId)!
      expect(row.current_approver_emp_id).toBe(hr2Id)
      expect(row.current_candidate_emp_ids).toEqual([hr2Id])
      expect(row.current_approver_name).toBe(`HR 覆核：hr2-${stamp}`)
      expect(row.decision_comment).toBe("HR 覆核完成")
    })
  })

  describe("change-approver、HR 代簽、附件可見", () => {
    let reqId: string

    it("再送一張 → HR 在第 1 關 change-approver 給 m2 → candidate_emp_ids=[m2]，m1 不能簽、m2 能簽", async () => {
      const filed = await fileFixPunch(empToken, "改簽核人")
      expect(filed.status).toBe(201)
      reqId = filed.body.requestId
      const ch = await as(adminToken, request(app).post(`/requests/${reqId}/change-approver`)).send({ approverEmpId: m2Id, comment: "m1 休假" })
      expect(ch.status).toBe(200)
      expect(ch.body).toMatchObject({ previousApproverEmpId: m1Id, previousCandidateEmpIds: [m1Id], approverEmpId: m2Id, candidateEmpIds: [m2Id] })
      const db = await stepsOf(reqId)
      expect(db[0]).toMatchObject({ approver_emp_id: m2Id, candidate_emp_ids: [m2Id], step_kind: "manager" })
      const denied = await as(m1Token, request(app).post(`/requests/${reqId}/approve`)).send({})
      expect(denied.status).toBe(403)
      const ok = await as(m2Token, request(app).post(`/requests/${reqId}/approve`)).send({})
      expect(ok.status).toBe(200)
      expect(ok.body).toMatchObject({ status: "pending", currentStep: 2 })
    })

    it("附件：第 2 關（m2 本人關）時 m1（主管鏈上、已簽）與 HR2（第 3 關候選）都能列附件；無關員工 403", async () => {
      for (const token of [m1Token, m2Token, hr2Token]) {
        const res = await as(token, request(app).get(`/requests/${reqId}/attachments`))
        expect(res.status).toBe(200)
      }
      const outsider = await createEmployee({ label: "outsider", role: "employee" })
      const denied = await as(outsider.token, request(app).get(`/requests/${reqId}/attachments`))
      expect(denied.status).toBe(403)
    })

    it("HR 代簽（非候選、override）第 2 關 → 200；approver_emp_id 仍是 m2、acted_by＝HR1", async () => {
      const res = await as(adminToken, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "代簽" })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ status: "pending", currentStep: 3 })
      const db = await stepsOf(reqId)
      expect(db[1]).toMatchObject({ decision: "approved", approver_emp_id: m2Id, acted_by_emp_id: hr1Id })
    })

    it("駁回：HR1 在 HR 關駁回 → rejected；approver_emp_id 仍是 HR1（第一候選＝本人）", async () => {
      const res = await as(adminToken, request(app).post(`/requests/${reqId}/reject`)).send({ comment: "資料不齊" })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe("rejected")
      const db = await stepsOf(reqId)
      expect(db[2]).toMatchObject({ decision: "rejected", approver_emp_id: hr1Id, acted_by_emp_id: hr1Id })
    })
  })

  describe("mode=manager 仍單關；主管順序可改；managerEmpId 相容", () => {
    it("PUT mode=manager → e 送單只有一關（m1）", async () => {
      const put = await as(adminToken, request(app).put("/approval-flows/fix_punch")).send({ mode: "manager" })
      expect(put.status).toBe(200)
      const res = await fileFixPunch(empToken, "manager 模式")
      expect(res.status).toBe(201)
      expect(res.body.approvalSource).toBe("manager")
      expect((res.body.steps as StepView[]).map((s) => s.candidateEmpIds)).toEqual([[m1Id]])
      expect((res.body.steps as StepView[])[0].kind).toBe("manager")
    })

    it("PATCH /departments {managerEmpIds:[m2,m1]} → manager_hr 鏈順序變 m2 → m1 → HR；manager_emp_id 同步成 m2", async () => {
      const patch = await as(adminToken, request(app).patch(`/departments/${deptId}`)).send({ managerEmpIds: [m2Id, m1Id] })
      expect(patch.status).toBe(200)
      const { data } = await supabaseAdmin.from("departments").select("manager_emp_id, manager_emp_ids").eq("id", deptId).single()
      expect(data).toEqual({ manager_emp_id: m2Id, manager_emp_ids: [m2Id, m1Id] })

      await as(adminToken, request(app).put("/approval-flows/fix_punch")).send({ mode: "manager_hr" })
      const res = await fileFixPunch(empToken, "順序反轉")
      expect(res.status).toBe(201)
      expect((res.body.steps as StepView[]).map((s) => s.candidateEmpIds)).toEqual([[m2Id], [m1Id], [hr1Id, hr2Id]])
    })

    it("小主管自己送單：跳過本人 → 鏈是 大主管 → HR", async () => {
      const res = await fileFixPunch(m2Token, "主管自己補卡")
      expect(res.status).toBe(201)
      expect((res.body.steps as StepView[]).map((s) => s.candidateEmpIds)).toEqual([[m1Id], [hr1Id, hr2Id]])
    })

    it("舊寫法 PATCH {managerEmpId: m1} → manager_emp_ids=[m1]；{managerEmpId: null} → []；兩者都給以 managerEmpIds 為準", async () => {
      const one = await as(adminToken, request(app).patch(`/departments/${deptId}`)).send({ managerEmpId: m1Id })
      expect(one.status).toBe(200)
      let { data } = await supabaseAdmin.from("departments").select("manager_emp_id, manager_emp_ids").eq("id", deptId).single()
      expect(data).toEqual({ manager_emp_id: m1Id, manager_emp_ids: [m1Id] })

      const none = await as(adminToken, request(app).patch(`/departments/${deptId}`)).send({ managerEmpId: null })
      expect(none.status).toBe(200)
      ;({ data } = await supabaseAdmin.from("departments").select("manager_emp_id, manager_emp_ids").eq("id", deptId).single())
      expect(data).toEqual({ manager_emp_id: null, manager_emp_ids: [] })

      const both = await as(adminToken, request(app).patch(`/departments/${deptId}`)).send({ managerEmpId: m1Id, managerEmpIds: [m2Id] })
      expect(both.status).toBe(200)
      ;({ data } = await supabaseAdmin.from("departments").select("manager_emp_id, manager_emp_ids").eq("id", deptId).single())
      expect(data).toEqual({ manager_emp_id: m2Id, manager_emp_ids: [m2Id] })

      // 只改名字不動主管
      const rename = await as(adminToken, request(app).patch(`/departments/${deptId}`)).send({ name: `工程部改名 ${stamp}` })
      expect(rename.status).toBe(200)
      ;({ data } = await supabaseAdmin.from("departments").select("manager_emp_id, manager_emp_ids").eq("id", deptId).single())
      expect(data).toEqual({ manager_emp_id: m2Id, manager_emp_ids: [m2Id] })
    })

    it("部門沒有主管、沒設老闆 → manager_hr 只剩 HR 關；manager 模式 → 第一位 hr_admin 單關", async () => {
      await as(adminToken, request(app).patch(`/departments/${deptId}`)).send({ managerEmpIds: [] })
      const res = await fileFixPunch(empToken, "無主管")
      expect(res.status).toBe(201)
      expect(res.body.approvalSource).toBe("manager_hr")
      expect((res.body.steps as StepView[]).map((s) => [s.candidateEmpIds, s.kind])).toEqual([[[hr1Id, hr2Id], "hr"]])

      await as(adminToken, request(app).put("/approval-flows/fix_punch")).send({ mode: "manager" })
      const single = await fileFixPunch(empToken, "無主管 manager 模式")
      expect(single.status).toBe(201)
      expect(single.body.approvalSource).toBe("hr_admin")
      expect((single.body.steps as StepView[]).map((s) => s.candidateEmpIds)).toEqual([[hr1Id]])
    })
  })
})
