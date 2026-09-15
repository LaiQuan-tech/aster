import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import ExcelJS from "exceljs"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { loadPaidBefore, buildSummary } from "../services/bonus-run-store"
import { paidBeforeKey } from "../services/bonus-run"
import { app } from "../app"

/**
 * D1 專案獎金季發放批次 — live 合約測試（仿 disbursements-live.test.ts）。
 *
 * 流程：建案（合約 100 萬、2 成員 pool_pct 10%/20%、pool 10 萬）→ 第 1 期入帳 40 萬
 * → preview 兩人 4,000/8,000 → create draft（同 label 再建 409）→ PATCH note → 另開一個
 * draft 後 pay 第一批 → 第二個 draft pay 409 stale_paid_before → 重算歸零 → 軟刪
 * → 再入帳 30 萬 → 第二批 preview 3,000/6,000（paid_before 正確）→ create → pay
 * → paid 批次 PATCH／DELETE／pay 皆 409 not_draft → summary 年度合計 21,000
 * → export.xlsx 列數＝表頭 3＋items＋合計 1 → /my/bonus-history 員工看得到自己的兩筆
 * → 調降 pct 讓累計 < 已發 → overpaid 紅字（amount 0，不自動追討）。
 *
 * 正式庫尚未套 0045／sql/0034（bonus_runs 不存在）時整組 describe.skipIf 跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function bonusRunsMigrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("bonus_runs").select("id").limit(1)
  return !error
}
const migrated = await bonusRunsMigrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let adminEmpId: string
let employeeToken: string
let empAId: string
let empBId: string

const YEAR = Number(taipeiToday().slice(0, 4))
const TODAY = taipeiToday()
const Q1 = `${YEAR}-Q1`
const Q2 = `${YEAR}-Q2`

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${adminToken}`)
}
function asEmployee(req: request.Test) {
  return req.set("Authorization", `Bearer ${employeeToken}`)
}
function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}

type Item = {
  projectId: string
  projectCode: string | null
  projectName: string | null
  employeeId: string
  employeeName: string | null
  receivedPct: number
  entitledCumulative: number
  paidBefore: number
  amount: number
  overpaid: boolean
  overpaidBy: number
}
function byEmp(items: Item[], empId: string): Item {
  const it = items.find((i) => i.employeeId === empId)
  if (!it) throw new Error(`no item for ${empId}`)
  return it
}

let projectId: string
let installments: Array<{ id: string; installmentNo: number }>
let q1Id: string
let q2Id: string

describe.skipIf(!migrated)("獎金季發放批次 — live", () => {
  beforeAll(async () => {
    const name = `BONUSTEST ${stamp}`
    const adminEmail = `bonus-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
    tenantId = provisioned.tenantId
    createdTenantIds.push(provisioned.tenantId)
    createdUserIds.push(provisioned.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("user_id", provisioned.userId).single()
    adminEmpId = hr!.id as string

    // 成員 A 有登入帳號（驗 ESS /my/bonus-history）；成員 B 只有員工列。
    const empEmail = `bonus-${stamp}-emp@example.com`
    const empPassword = `Pw-${stamp}-Bb2!`
    const { data: empUser, error: empErr } = await supabaseAdmin.auth.admin.createUser({
      email: empEmail,
      password: empPassword,
      email_confirm: true,
      app_metadata: { tenant_id: tenantId },
    })
    if (empErr || !empUser?.user) throw new Error(`employee user: ${empErr?.message}`)
    createdUserIds.push(empUser.user.id)
    const { data: rowA, error: rowErr } = await supabaseAdmin
      .from("employees")
      .insert({ tenant_id: tenantId, user_id: empUser.user.id, name: "成員甲", emp_no: "A001", role: "employee", employment_type: "regular", status: "active" })
      .select("id")
      .single()
    if (rowErr || !rowA) throw new Error(`employee row A: ${rowErr?.message}`)
    empAId = rowA.id as string
    employeeToken = await signIn(empEmail, empPassword)
    const { data: rowB, error: rowBErr } = await supabaseAdmin
      .from("employees")
      .insert({ tenant_id: tenantId, name: "成員乙", emp_no: "B002", role: "employee", employment_type: "regular", status: "active" })
      .select("id")
      .single()
    if (rowBErr || !rowB) throw new Error(`employee row B: ${rowBErr?.message}`)
    empBId = rowB.id as string

    // 建案：pool_pct、獎金池 10 萬；A 10%、B 20%。
    const p = await asAdmin(request(app).post("/projects")).send({ name: "獎金季發放測試案", shareMode: "pool_pct", bonusPool: 100_000, leadEmpId: adminEmpId })
    expect(p.status).toBe(201)
    projectId = p.body.id
    for (const [employeeId, sharePct] of [
      [empAId, 10],
      [empBId, 20],
    ] as const) {
      const m = await asAdmin(request(app).post(`/projects/${projectId}/members`)).send({ employeeId, sharePct })
      expect(m.status).toBe(201)
    }

    // 合約 100 萬、三期 40/30/30，第 1 期入帳 40 萬。
    const c = await asAdmin(request(app).post(`/projects/${projectId}/contracts`)).send({ docType: "contract", title: "承攬契約", amount: 1_000_000, signedOn: `${YEAR}-01-10` })
    expect(c.status).toBe(201)
    const sched = await asAdmin(request(app).put(`/projects/${projectId}/billings`)).send({
      installments: [
        { installmentNo: 1, percentage: 40, milestone: "簽約款" },
        { installmentNo: 2, percentage: 30, milestone: "送審款" },
        { installmentNo: 3, percentage: 30, milestone: "驗收款" },
      ],
    })
    expect(sched.status).toBe(200)
    installments = sched.body.installments
    const rcv = await asAdmin(request(app).post(`/billings/${installments[0].id}/receive`)).send({ receivedOn: TODAY })
    expect(rcv.status).toBe(200)
    expect(rcv.body.summary.receivedTotal).toBe(400_000)
  }, 60_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      await supabaseAdmin.from("bonus_run_items").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("bonus_runs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      // 調分潤留痕（PATCH members 會寫）FK 到 projects，不先刪會讓 projects／employees 的刪除靜默失敗、租戶殘留。
      await supabaseAdmin.from("project_share_adjustments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_members").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_billings").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("contracts").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_settings").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("projects").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  it("preview：入帳 40% → A 4,000／B 8,000，totals 12,000、2 人 1 案；非 HR 403", async () => {
    const res = await asAdmin(request(app).post("/bonus-runs/preview")).send({ asOf: TODAY, label: Q1 })
    expect(res.status).toBe(200)
    expect(res.body.label).toBe(Q1)
    expect(res.body.asOf).toBe(TODAY)
    const items = res.body.items as Item[]
    expect(items).toHaveLength(2)
    const a = byEmp(items, empAId)
    const b = byEmp(items, empBId)
    expect(a.receivedPct).toBe(0.4)
    expect(a.entitledCumulative).toBe(4_000)
    expect(a.paidBefore).toBe(0)
    expect(a.amount).toBe(4_000)
    expect(b.amount).toBe(8_000)
    expect(a.employeeName).toBe("成員甲")
    expect(a.projectName).toBe("獎金季發放測試案")
    expect(res.body.totals).toMatchObject({ amount: 12_000, employeeCount: 2, projectCount: 1, itemCount: 2, overpaidCount: 0, skipped: [] })

    expect((await asEmployee(request(app).post("/bonus-runs/preview")).send({})).status).toBe(403)
    expect((await asEmployee(request(app).get("/bonus-runs"))).status).toBe(403)
  })

  it("create draft：201＋items；同 label 再建 409 label_exists；列表看得到；PATCH note 不重算", async () => {
    const res = await asAdmin(request(app).post("/bonus-runs")).send({ asOf: TODAY, label: Q1, note: "中秋" })
    expect(res.status).toBe(201)
    expect(res.body.run.status).toBe("draft")
    expect(res.body.run.label).toBe(Q1)
    expect(res.body.run.note).toBe("中秋")
    expect(res.body.run.totals.amount).toBe(12_000)
    expect(res.body.items).toHaveLength(2)
    q1Id = res.body.run.id

    const dup = await asAdmin(request(app).post("/bonus-runs")).send({ asOf: TODAY, label: Q1 })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe("label_exists")

    const list = await asAdmin(request(app).get("/bonus-runs"))
    expect(list.status).toBe(200)
    expect(list.body.runs.map((r: { id: string }) => r.id)).toContain(q1Id)

    const got = await asAdmin(request(app).get(`/bonus-runs/${q1Id}`))
    expect(got.status).toBe(200)
    expect(byEmp(got.body.items, empBId).amount).toBe(8_000)
    expect(byEmp(got.body.items, empBId).projectCode).toBeTruthy()

    const patched = await asAdmin(request(app).patch(`/bonus-runs/${q1Id}`)).send({ note: "中秋節前發" })
    expect(patched.status).toBe(200)
    expect(patched.body.run.note).toBe("中秋節前發")
    expect(patched.body.run.totals.amount).toBe(12_000)
  })

  it("pay 第一批後，另一個 draft 的 paid_before 過期 → pay 409 stale_paid_before → 重算歸零 → 軟刪後 label 可重用", async () => {
    const tmp = await asAdmin(request(app).post("/bonus-runs")).send({ asOf: TODAY, label: "tmp-draft" })
    expect(tmp.status).toBe(201)
    const tmpId = tmp.body.run.id as string

    const pay = await asAdmin(request(app).post(`/bonus-runs/${q1Id}/pay`)).send({ paidOn: TODAY })
    expect(pay.status).toBe(200)
    expect(pay.body.run.status).toBe("paid")
    expect(pay.body.run.paidOn).toBe(TODAY)
    expect(pay.body.run.paidByEmpId).toBe(adminEmpId)

    const stale = await asAdmin(request(app).post(`/bonus-runs/${tmpId}/pay`)).send({ paidOn: TODAY })
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe("stale_paid_before")

    const recomputed = await asAdmin(request(app).patch(`/bonus-runs/${tmpId}`)).send({ recompute: true })
    expect(recomputed.status).toBe(200)
    expect(byEmp(recomputed.body.items, empAId)).toMatchObject({ entitledCumulative: 4_000, paidBefore: 4_000, amount: 0, overpaid: false })
    expect(recomputed.body.run.totals.amount).toBe(0)

    const noReason = await asAdmin(request(app).delete(`/bonus-runs/${tmpId}`)).send({})
    expect(noReason.status).toBe(400)
    const del = await asAdmin(request(app).delete(`/bonus-runs/${tmpId}`)).send({ reason: "測試用" })
    expect(del.status).toBe(200)
    expect((await asAdmin(request(app).get(`/bonus-runs/${tmpId}`))).status).toBe(404)
    const list = await asAdmin(request(app).get("/bonus-runs"))
    expect(list.body.runs.map((r: { id: string }) => r.id)).not.toContain(tmpId)

    const again = await asAdmin(request(app).post("/bonus-runs")).send({ asOf: TODAY, label: "tmp-draft" })
    expect(again.status).toBe(201)
    expect((await asAdmin(request(app).delete(`/bonus-runs/${again.body.run.id}`)).send({ reason: "清掉" })).status).toBe(200)
  })

  it("再入帳 30 萬 → 第二批 preview 3,000／6,000（paid_before 4,000／8,000）→ create → pay", async () => {
    const rcv = await asAdmin(request(app).post(`/billings/${installments[1].id}/receive`)).send({ receivedOn: TODAY })
    expect(rcv.status).toBe(200)
    expect(rcv.body.summary.receivedTotal).toBe(700_000)

    const pv = await asAdmin(request(app).post("/bonus-runs/preview")).send({ asOf: TODAY, label: Q2 })
    expect(pv.status).toBe(200)
    const a = byEmp(pv.body.items, empAId)
    const b = byEmp(pv.body.items, empBId)
    expect(a).toMatchObject({ receivedPct: 0.7, entitledCumulative: 7_000, paidBefore: 4_000, amount: 3_000, overpaid: false })
    expect(b).toMatchObject({ entitledCumulative: 14_000, paidBefore: 8_000, amount: 6_000 })
    expect(pv.body.totals.amount).toBe(9_000)

    const created = await asAdmin(request(app).post("/bonus-runs")).send({ asOf: TODAY, label: Q2 })
    expect(created.status).toBe(201)
    q2Id = created.body.run.id
    const pay = await asAdmin(request(app).post(`/bonus-runs/${q2Id}/pay`)).send({ paidOn: TODAY })
    expect(pay.status).toBe(200)
    expect(pay.body.run.status).toBe("paid")
    expect(pay.body.run.totals.amount).toBe(9_000)
  })

  it("paid 批次凍結：PATCH／DELETE／再 pay 皆 409 not_draft", async () => {
    const patch = await asAdmin(request(app).patch(`/bonus-runs/${q2Id}`)).send({ note: "改不得" })
    expect(patch.status).toBe(409)
    expect(patch.body.error).toBe("not_draft")
    const del = await asAdmin(request(app).delete(`/bonus-runs/${q2Id}`)).send({ reason: "刪不得" })
    expect(del.status).toBe(409)
    expect(del.body.error).toBe("not_draft")
    const pay = await asAdmin(request(app).post(`/bonus-runs/${q2Id}/pay`)).send({ paidOn: TODAY })
    expect(pay.status).toBe(409)
    expect(pay.body.error).toBe("not_draft")
    const got = await asAdmin(request(app).get(`/bonus-runs/${q2Id}`))
    expect(got.body.run.status).toBe("paid")
    expect(byEmp(got.body.items, empAId).amount).toBe(3_000)
  })

  it("summary：年度合計 21,000、兩季 12,000／9,000、上季對比 −3,000、員工累計 7,000／14,000", async () => {
    const res = await asAdmin(request(app).get(`/bonus-runs/summary?year=${YEAR}`))
    expect(res.status).toBe(200)
    const s = res.body.summary
    expect(s.year).toBe(YEAR)
    expect(s.years).toContain(YEAR)
    expect(s.yearTotal).toBe(21_000)
    expect(s.byQuarter.map((q: { label: string; amount: number }) => [q.label, q.amount])).toEqual([
      [Q1, 12_000],
      [Q2, 9_000],
    ])
    expect(s.comparison.latest.label).toBe(Q2)
    expect(s.comparison.previous.label).toBe(Q1)
    expect(s.comparison.delta).toBe(-3_000)
    const a = s.byEmployee.find((e: { employeeId: string }) => e.employeeId === empAId)
    const b = s.byEmployee.find((e: { employeeId: string }) => e.employeeId === empBId)
    expect(a).toMatchObject({ employeeName: "成員甲", empNo: "A001", amountYear: 7_000, amountAllTime: 7_000, runCount: 2 })
    expect(b).toMatchObject({ amountYear: 14_000 })

    const onlyA = await asAdmin(request(app).get(`/bonus-runs/summary?year=${YEAR}&empId=${empAId}`))
    expect(onlyA.body.summary.yearTotal).toBe(7_000)
    expect(onlyA.body.summary.byEmployee).toHaveLength(1)

    expect((await asAdmin(request(app).get("/bonus-runs/summary?year=abc"))).status).toBe(400)
  })

  it("export.xlsx：200、列數＝表頭 3＋items＋合計 1，合計格＝本季應發總額", async () => {
    const res = await asAdmin(request(app).get(`/bonus-runs/${q2Id}/export.xlsx`)).buffer(true).parse(binaryParser)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
    expect(decodeURIComponent(res.headers["content-disposition"] ?? "")).toContain(`獎金季發放-${Q2}.xlsx`)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(new Uint8Array(res.body as Buffer) as unknown as ExcelJS.Buffer)
    const ws = wb.getWorksheet(Q2)
    expect(ws).toBeTruthy()
    expect(ws!.rowCount).toBe(3 + 2 + 1)
    expect(ws!.getRow(3).getCell(13).value).toBe("本季應發")
    expect(ws!.getRow(ws!.rowCount).getCell(13).value).toBe(9_000)
    expect((await asAdmin(request(app).get(`/bonus-runs/00000000-0000-0000-0000-000000000000/export.xlsx`))).status).toBe(404)
  })

  it("/my/bonus-history：成員甲看到自己的兩筆（Q2 3,000、Q1 4,000）合計 7,000；HR 本人沒分潤 → 空", async () => {
    const res = await asEmployee(request(app).get("/my/bonus-history"))
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(7_000)
    expect(res.body.rows.map((r: { label: string; amount: number }) => [r.label, r.amount])).toEqual([
      [Q2, 3_000],
      [Q1, 4_000],
    ])
    expect(res.body.rows[0].paidOn).toBe(TODAY)
    expect(res.body.rows[0].projectName).toBe("獎金季發放測試案")
    const mine = await asAdmin(request(app).get("/my/bonus-history"))
    expect(mine.status).toBe(200)
    expect(mine.body.rows).toEqual([])
  })

  it("調降 A 的 pct 至 5% → 累計 3,500 < 已發 7,000 → amount 0＋overpaid 3,500（不自動追討）", async () => {
    const { data: member } = await supabaseAdmin.from("project_members").select("id").eq("project_id", projectId).eq("employee_id", empAId).single()
    const upd = await asAdmin(request(app).patch(`/projects/${projectId}/members/${member!.id}`)).send({ sharePct: 5 })
    expect(upd.status).toBe(200)
    const pv = await asAdmin(request(app).post("/bonus-runs/preview")).send({ asOf: TODAY })
    expect(pv.status).toBe(200)
    expect(pv.body.label).toBe(`${YEAR}-Q${Math.ceil(Number(TODAY.slice(5, 7)) / 3)}`)
    const a = byEmp(pv.body.items, empAId)
    expect(a).toMatchObject({ entitledCumulative: 3_500, paidBefore: 7_000, amount: 0, overpaid: true, overpaidBy: 3_500 })
    expect(pv.body.totals.overpaidCount).toBe(1)
    expect(byEmp(pv.body.items, empBId).amount).toBe(0)
  })
})

/**
 * D 批次驗收追加案 1／2——正式庫 PostgREST max-rows=1000，bonus-run-store.ts
 * 有 5 處查詢（loadInputs 的成員／合約／入帳、loadPaidBefore、summary／ESS 的
 * items）原本沒有 `.range()`，筆數一旦超過 1000 就被靜默截斷。改用共用的
 * fetchAll 分頁後在這裡補案：直接用 supabaseAdmin 灌 1 專案＋1200 個員工、
 * 各掛一列 bonus_run_items（amount 都是 1），跳過 preview／members／
 * contracts／billings 整條業務流程（撐出 1200 個真實成員太貴，考驗的是查詢
 * 撈不撈得全，不是分潤算法本身）。
 */
describe.skipIf(!migrated)("查詢分頁：>1000 筆 paid items 不再靜默截斷", () => {
  const stamp2 = `${stamp}p`
  const ROWS = 1200
  let tid: string
  let uid: string
  let pageProjectId: string
  let pageRunId: string
  const empIds: string[] = []

  beforeAll(async () => {
    const name = `BONUSPAGE ${stamp2}`
    const adminEmail = `bonus-${stamp2}-admin@example.com`
    const adminPassword = `Pw-${stamp2}-Aa1!`
    const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
    tid = provisioned.tenantId
    uid = provisioned.userId

    const { data: proj, error: projErr } = await supabaseAdmin
      .from("projects")
      .insert({ tenant_id: tid, name: "分頁測試案", share_mode: "fixed_amount" })
      .select("id")
      .single()
    if (projErr || !proj) throw new Error(`page project: ${projErr?.message}`)
    pageProjectId = proj.id as string

    for (let i = 0; i < ROWS; i += 500) {
      const chunk = Array.from({ length: Math.min(500, ROWS - i) }, (_, j) => ({
        tenant_id: tid,
        name: `分頁員工${i + j}`,
        emp_no: `PG${i + j}`,
        role: "employee",
        employment_type: "regular",
        status: "active",
      }))
      const { data: rows, error } = await supabaseAdmin.from("employees").insert(chunk).select("id")
      if (error || !rows) throw new Error(`page employees chunk ${i}: ${error?.message}`)
      empIds.push(...rows.map((r) => r.id as string))
    }
    expect(empIds).toHaveLength(ROWS)

    const { data: run, error: runErr } = await supabaseAdmin
      .from("bonus_runs")
      .insert({ tenant_id: tid, label: `分頁測試-${stamp2}`, as_of: TODAY, status: "paid", paid_on: TODAY, totals: {} })
      .select("id")
      .single()
    if (runErr || !run) throw new Error(`page run: ${runErr?.message}`)
    pageRunId = run.id as string

    for (let i = 0; i < empIds.length; i += 500) {
      const chunk = empIds.slice(i, i + 500).map((employeeId, j) => ({
        tenant_id: tid,
        run_id: pageRunId,
        project_id: pageProjectId,
        employee_id: employeeId,
        share_mode: "fixed_amount",
        amount: 1,
        snapshot: { employeeName: `分頁員工${i + j}`, empNo: `PG${i + j}` },
      }))
      const { error } = await supabaseAdmin.from("bonus_run_items").insert(chunk)
      if (error) throw new Error(`page items chunk ${i}: ${error.message}`)
    }
  }, 120_000)

  afterAll(async () => {
    await supabaseAdmin.from("bonus_run_items").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("bonus_runs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("projects").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
    await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 120_000)

  it(`loadPaidBefore：${ROWS} 筆 paid items 全部撈到、每人 amount=1 加總正確`, async () => {
    const map = await loadPaidBefore(tid)
    expect(map.size).toBe(ROWS)
    let total = 0
    for (const empId of empIds) total += map.get(paidBeforeKey(pageProjectId, empId)) ?? 0
    expect(total).toBe(ROWS)
  })

  it(`summary／ESS：${ROWS} 筆 items 的年度合計與人數不因分頁被截斷`, async () => {
    const summary = await buildSummary(tid, {})
    expect(summary.allTimeTotal).toBe(ROWS)
    expect(summary.byEmployee).toHaveLength(ROWS)
    expect(summary.byEmployee.reduce((s, e) => s + e.amountAllTime, 0)).toBe(ROWS)
  })
})

/**
 * D 批次驗收追加案 2／2——payRun 先前是 check-then-update：兩個併發 pay 都能
 * 通過「current.status === draft」的檢查，最後的 UPDATE 雖帶 `.eq("status",
 * "draft")` 卻沒確認真的改到列，後到的那個 WHERE 完全不命中也不算 error，
 * 於是兩個都拿 200、重複記一次 audit log。改成 UPDATE 後 `.select("id")`
 * 檢查受影響列數，0 列即視同「已經不是 draft」，回 409 not_draft。
 *
 * 直接塞一筆空白 draft（不掛任何專案／成員，items 天生 0 筆，pay 前的
 * stale_paid_before 檢查對空陣列必過）單純考驗這個原子更新本身。
 */
describe.skipIf(!migrated)("pay 併發：同一 run 兩次同時 pay 只有一次成功", () => {
  const stamp3 = `${stamp}r`
  let tid: string
  let uid: string
  let token: string
  let runId: string

  beforeAll(async () => {
    const name = `BONUSRACE ${stamp3}`
    const adminEmail = `bonus-${stamp3}-admin@example.com`
    const adminPassword = `Pw-${stamp3}-Aa1!`
    const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
    tid = provisioned.tenantId
    uid = provisioned.userId
    token = await signIn(adminEmail, adminPassword)

    const { data: run, error } = await supabaseAdmin
      .from("bonus_runs")
      .insert({ tenant_id: tid, label: `race-${stamp3}`, as_of: TODAY, status: "draft", totals: {} })
      .select("id")
      .single()
    if (error || !run) throw new Error(`race draft: ${error?.message}`)
    runId = run.id as string
  }, 30_000)

  afterAll(async () => {
    await supabaseAdmin.from("bonus_run_items").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("bonus_runs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
    await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 30_000)

  it("兩個併發 POST /bonus-runs/:id/pay：一個 200 一個 409 not_draft，不會兩個都成功", async () => {
    const [a, b] = await Promise.all([
      request(app).post(`/bonus-runs/${runId}/pay`).set("Authorization", `Bearer ${token}`).send({ paidOn: TODAY }),
      request(app).post(`/bonus-runs/${runId}/pay`).set("Authorization", `Bearer ${token}`).send({ paidOn: TODAY }),
    ])
    const statuses = [a.status, b.status].sort((x, y) => x - y)
    expect(statuses).toEqual([200, 409])
    const failed = a.status === 409 ? a : b
    expect(failed.body.error).toBe("not_draft")

    const got = await request(app).get(`/bonus-runs/${runId}`).set("Authorization", `Bearer ${token}`)
    expect(got.body.run.status).toBe("paid")
    expect(got.body.run.paidByEmpId).toBeTruthy()
  })
})
