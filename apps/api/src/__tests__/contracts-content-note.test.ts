import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { contractsRouter } from "../routes/contracts.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 合約「內容／說明」欄位（contracts.content_note，業主 2026-09-30 會議 A 批）。
 * 合約列本身是 finance 範圍（HR／會計／該案 lead／經理與主辦成員／所屬部門主管都看得到金額與印花稅），
 * 內容欄位比 finance 窄：只有 HR、該案 lead_emp_id、該案經理與主辦成員讀寫得到；
 * 會計與部門主管讀到 null、寫入回 403，一般成員／非成員照舊整支 403。
 */

const app = express()
app.use(express.json())
app.use(contractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000000d1"
const C_NORMAL = "cccccccc-0000-4000-8000-000000000001"
const C_PRIMARY = "cccccccc-0000-4000-8000-000000000002"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = { hr: emp(1), accountant: emp(2), lead: emp(3), manager: emp(4), leadRole: emp(5), member: emp(6), deptManager: emp(7) }
const T = {
  hr: "hr-user",
  accountant: "accountant-user",
  lead: "lead-user",
  manager: "manager-user",
  leadRole: "lead-role-user",
  member: "member-user",
  deptManager: "dept-manager-user",
}

const SECRET = "付款條件：驗收後 30 日內付清；保固 2 年。（機密）"

function contractRow(over: Row): Row {
  return {
    tenant_id: TENANT_ID,
    project_id: PROJECT,
    doc_type: "contract",
    our_role: "contractor",
    title: "承攬契約",
    counterparty: "某某業主",
    amount: "1000000",
    is_primary: false,
    signed_on: "2026-10-01",
    version: 1,
    supersedes_id: null,
    copies: 1,
    stamp_duty_required: "auto",
    stamp_duty_rate: "0.001",
    stamp_duty_amount: "1000",
    stamp_duty_paid_on: null,
    stamp_duty_note: null,
    content_note: SECRET,
    created_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  }
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null },
    { id: E.lead, tenant_id: TENANT_ID, user_id: T.lead, role: "employee", dept_id: null },
    { id: E.manager, tenant_id: TENANT_ID, user_id: T.manager, role: "employee", dept_id: null },
    { id: E.leadRole, tenant_id: TENANT_ID, user_id: T.leadRole, role: "employee", dept_id: null },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null },
    { id: E.deptManager, tenant_id: TENANT_ID, user_id: T.deptManager, role: "employee", dept_id: DEPT },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: E.deptManager, manager_emp_ids: [E.deptManager], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [{ id: PROJECT, tenant_id: TENANT_ID, dept_id: DEPT, lead_emp_id: E.lead }]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.manager, role_in_project: "manager" },
    { id: "m2", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.leadRole, role_in_project: "lead" },
    { id: "m3", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.member, role_in_project: "member" },
  ]
  fake.db.project_settings = [{ tenant_id: TENANT_ID, stamp_duty_rate: "0.001", stamp_duty_lookback_years: 7 }]
  fake.db.project_billings = []
  fake.db.contracts = [
    contractRow({ id: C_NORMAL }),
    contractRow({ id: C_PRIMARY, is_primary: true, title: "主合約", content_note: SECRET }),
  ]
})

const contractUpdates = () => fake.writes.filter((w) => w.table === "contracts" && w.action === "update")
const contractInserts = () => fake.writes.filter((w) => w.table === "contracts" && w.action === "insert")
const stored = (id: string) => fake.db.contracts.find((c) => c.id === id) as Row

describe("GET /projects/:id/contracts — 合約內容欄位只給 HR／lead／經理與主辦", () => {
  it.each([
    ["HR", T.hr],
    ["該案 lead_emp_id", T.lead],
    ["經理成員", T.manager],
    ["主辦成員", T.leadRole],
  ])("%s：讀得到 contentNote", async (_label, token) => {
    const res = await as(token, request(app).get(`/projects/${PROJECT}/contracts`))

    expect(res.status).toBe(200)
    const rows = res.body.contracts as Array<Row>
    expect(rows.map((c) => c.contentNote)).toEqual([SECRET, SECRET])
  })

  it.each([
    ["會計", T.accountant],
    ["部門主管（該案所屬部門）", T.deptManager],
  ])("%s：有 finance、看得到合約列的金額與印花稅，但 contentNote 是 null、整份回應裡也找不到內容", async (_label, token) => {
    const res = await as(token, request(app).get(`/projects/${PROJECT}/contracts`))

    expect(res.status).toBe(200)
    const rows = res.body.contracts as Array<Row>
    expect(rows).toHaveLength(2)
    expect(rows.map((c) => c.contentNote)).toEqual([null, null])
    expect(rows[0]).toMatchObject({ title: expect.any(String), amount: 1_000_000, stampDutyAmount: 1000 })
    expect(JSON.stringify(res.body)).not.toContain("機密")
  })

  it("一般成員：沒有 finance → 整支 403（維持原本的合約列範圍）", async () => {
    const res = await as(T.member, request(app).get(`/projects/${PROJECT}/contracts`))
    expect(res.status).toBe(403)
  })
})

describe("POST /projects/:id/contracts — contentNote", () => {
  const body = (over: Row = {}) => ({ docType: "contract", title: "新合約", ...over })

  it("有權者建立時帶 contentNote：trim 後寫入，回應帶回", async () => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/contracts`)).send(body({ contentNote: "  施工範圍：全棟機電  " }))

    expect(res.status).toBe(201)
    expect(res.body.contract.contentNote).toBe("施工範圍：全棟機電")
    expect(contractInserts()[0]?.payload).toMatchObject({ content_note: "施工範圍：全棟機電" })
  })

  it("沒帶、帶 null、只有空白 → 一律存 null", async () => {
    for (const extra of [{}, { contentNote: null }, { contentNote: "   " }]) {
      fake.writes.length = 0
      const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/contracts`)).send(body(extra))
      expect(res.status).toBe(201)
      expect(contractInserts()[0]?.payload).toMatchObject({ content_note: null })
      expect(res.body.contract.contentNote).toBeNull()
    }
  })

  it("超過 2000 字 → 400 invalid_body，沒寫入；剛好 2000 字可以", async () => {
    const tooLong = await as(T.hr, request(app).post(`/projects/${PROJECT}/contracts`)).send(body({ contentNote: "字".repeat(2001) }))
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toBe("invalid_body")
    expect(contractInserts()).toHaveLength(0)

    const ok = await as(T.hr, request(app).post(`/projects/${PROJECT}/contracts`)).send(body({ contentNote: "字".repeat(2000) }))
    expect(ok.status).toBe(201)
  })

  it.each([
    ["會計", T.accountant],
    ["部門主管", T.deptManager],
  ])("%s 帶 contentNote 進來 → 403 forbidden_contract_content，什麼都沒寫", async (_label, token) => {
    const res = await as(token, request(app).post(`/projects/${PROJECT}/contracts`)).send(body({ contentNote: "我想寫內容" }))

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "forbidden_contract_content" })
    expect(contractInserts()).toHaveLength(0)
  })

  it("會計不帶內容欄位照常建合約列（原本的 finance 工作不受影響），回應的 contentNote 是 null", async () => {
    const res = await as(T.accountant, request(app).post(`/projects/${PROJECT}/contracts`)).send(body())

    expect(res.status).toBe(201)
    expect(res.body.contract.contentNote).toBeNull()
  })

  it("經理／主辦成員、lead 都可以寫", async () => {
    for (const token of [T.manager, T.leadRole, T.lead]) {
      const res = await as(token, request(app).post(`/projects/${PROJECT}/contracts`)).send(body({ contentNote: `由 ${token} 寫的` }))
      expect(res.status, token).toBe(201)
      expect(res.body.contract.contentNote).toBe(`由 ${token} 寫的`)
    }
  })
})

describe("PATCH /contracts/:id — contentNote", () => {
  const patch = (token: string, id: string, body: Row) => as(token, request(app).patch(`/contracts/${id}`)).send(body)

  it("有權者可改：寫進 content_note，回應帶回；留稽核", async () => {
    const res = await patch(T.manager, C_NORMAL, { contentNote: "  改過的內容  " })

    expect(res.status).toBe(200)
    expect(res.body.contract.contentNote).toBe("改過的內容")
    expect(contractUpdates()[0]?.payload).toEqual({ content_note: "改過的內容" })
    expect(stored(C_NORMAL).content_note).toBe("改過的內容")
    const audit = fake.writes.find((w) => w.table === "audit_logs")
    expect(audit?.payload).toMatchObject({ table_name: "contracts", record_id: C_NORMAL, new_row: { content_note: "改過的內容" } })
  })

  it("帶 null 或空白＝清空", async () => {
    for (const contentNote of [null, "   "]) {
      stored(C_NORMAL).content_note = SECRET
      const res = await patch(T.hr, C_NORMAL, { contentNote })
      expect(res.status).toBe(200)
      expect(res.body.contract.contentNote).toBeNull()
      expect(stored(C_NORMAL).content_note).toBeNull()
    }
  })

  it("超過 2000 字 → 400", async () => {
    const res = await patch(T.hr, C_NORMAL, { contentNote: "字".repeat(2001) })
    expect(res.status).toBe(400)
    expect(contractUpdates()).toHaveLength(0)
  })

  it.each([
    ["會計", T.accountant],
    ["部門主管", T.deptManager],
  ])("%s 想改內容（含想清空）→ 403 forbidden_contract_content，合約列不動", async (_label, token) => {
    for (const contentNote of ["亂寫", null]) {
      const res = await patch(token, C_NORMAL, { contentNote })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: "forbidden_contract_content" })
    }
    expect(contractUpdates()).toHaveLength(0)
    expect(stored(C_NORMAL).content_note).toBe(SECRET)
  })

  it("會計照常改貼花欄位，但回應裡的 contentNote 是 null（列上有內容也不外洩）", async () => {
    const res = await patch(T.accountant, C_NORMAL, { stampDutyPaidOn: "2026-10-05" })

    expect(res.status).toBe(200)
    expect(res.body.contract.stampDutyPaidOn).toBe("2026-10-05")
    expect(res.body.contract.contentNote).toBeNull()
    expect(JSON.stringify(res.body)).not.toContain("機密")
    expect(stored(C_NORMAL).content_note).toBe(SECRET)
  })

  it("主合約（is_primary）：內容欄位可以改（不影響金額）；金額／名稱等仍走 main-contract 端點（409）", async () => {
    const ok = await patch(T.hr, C_PRIMARY, { contentNote: "主合約的說明" })
    expect(ok.status).toBe(200)
    expect(stored(C_PRIMARY).content_note).toBe("主合約的說明")

    const stamp = await patch(T.hr, C_PRIMARY, { stampDutyNote: "各自貼", contentNote: "一起改" })
    expect(stamp.status).toBe(200)

    for (const bad of [{ title: "改名" }, { amount: 5 }, { title: "改名", contentNote: "夾帶" }]) {
      const res = await patch(T.hr, C_PRIMARY, bad)
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("primary_contract_requires_main_endpoint")
    }
    expect(stored(C_PRIMARY).title).toBe("主合約")
  })

  it("一般成員：沒有 finance → 403（維持原本範圍）", async () => {
    const res = await patch(T.member, C_NORMAL, { contentNote: "x" })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "forbidden" })
  })
})
