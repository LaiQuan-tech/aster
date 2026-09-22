import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { ANNUAL_DUPLICATE_COUNT_WARNING } from "../services/project-application-store"
import { app } from "../app"

/**
 * C2 複製專案（追加減／加做）＋原案自動封存＋變更歷史＋重複採計防呆——
 * live 合約測試（仿 projects-application-live.test.ts）。
 *
 * 流程：主案 A（2 期款、1 副委託、1 合約 100 萬、1 成員、第 1 期已請款）
 * → 非 finance 403 → duplicate change 120 萬 → A-1（parent=A、期程只有 %、
 * 副委託無付款、change_order 120 萬、opened_on=今天）、A 封存＋理由
 * → 從 A-1 再 duplicate addition 5 萬（不封存）→ A-2、parent 仍是 A
 * → 年度總表不含 A、含 A-1（120 萬）與 A-2 → lineage 三案都在
 * → 主案 B 自掛 change_order 又有子案 → 總表備註有重複採計警告。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let employeeToken: string
let employeeEmpId: string

const YEAR = Number(taipeiToday().slice(0, 4))
const ROC = YEAR - 1911
const TODAY = taipeiToday()

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
function createProject(body: Record<string, unknown>) {
  return asAdmin(request(app).post("/projects")).send(body)
}
function getProject(id: string) {
  return asAdmin(request(app).get(`/projects/${id}`))
}

beforeAll(async () => {
  const name = `C2TEST ${stamp}`
  const adminEmail = `c2-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
  tenantId = provisioned.tenantId
  createdTenantIds.push(provisioned.tenantId)
  createdUserIds.push(provisioned.userId)
  adminToken = await signIn(adminEmail, adminPassword)

  // 一般員工：看得到專案基本資料與變更歷史，看不到錢、不能複製。
  const empEmail = `c2-${stamp}-emp@example.com`
  const empPassword = `Pw-${stamp}-Bb2!`
  const { data: empUser, error: empErr } = await supabaseAdmin.auth.admin.createUser({
    email: empEmail,
    password: empPassword,
    email_confirm: true,
    app_metadata: { tenant_id: tenantId },
  })
  if (empErr || !empUser?.user) throw new Error(`employee user: ${empErr?.message}`)
  createdUserIds.push(empUser.user.id)
  const { data: empRow, error: rowErr } = await supabaseAdmin
    .from("employees")
    .insert({
      tenant_id: tenantId,
      user_id: empUser.user.id,
      name: "一般員工",
      role: "employee",
      employment_type: "regular",
      status: "active",
    })
    .select("id")
    .single()
  if (rowErr || !empRow) throw new Error(`employee row: ${rowErr?.message}`)
  employeeEmpId = empRow.id as string
  employeeToken = await signIn(empEmail, empPassword)
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("project_subcontract_payments").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_subcontracts").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_share_adjustments").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_members").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_billings").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("contracts").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_settings").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("projects").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("clients").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("companies").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("vendors").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    // audit_logs 放在 employees 之後、tenants 之前：刪員工會再觸發 audit trigger 寫新列（employees 掛 audit_all），
    // 先刪 audit_logs 會留孤兒；tenants 刪掉後 is_disposable_tenant 回 false，append-only trigger 就不放行了。
    await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
}, 60_000)

/* ── 共用狀態（跨 describe 依序使用） ─────────────────────────────────── */
let mainId: string
let mainCode: string
let dup1Id: string
let dup1Code: string
let dup2Id: string
let dup2Code: string
let clientId: string

describe("C2-0 主案：2 期款、1 副委託、1 合約 100 萬、1 成員", () => {
  it("建主案（帶業主、現場、工程師）", async () => {
    const c = await asAdmin(request(app).post("/clients")).send({ name: "惠特科技股份有限公司", taxId: "22099131" })
    expect(c.status).toBe(201)
    clientId = c.body.client.id

    const res = await createProject({
      name: "惠特總部機電設計",
      clientId,
      siteAddress: "新竹縣竹北市",
      siteAreaM2: 3200,
      designScope: [{ discipline: "電機", item: "高低壓", amount: 600000 }],
      // W8：技師的 key ＝租戶設定的科別（中文），不再是 electrical／hvac／fire。
      engineers: { 電機: { name: "王技師" } },
      otherExpenses: 12345,
      bonusPool: 100000,
    })
    expect(res.status).toBe(201)
    mainId = res.body.id
    mainCode = res.body.code
    expect(mainCode).toBe(`AT-${ROC}-001`)
  })

  it("合約 100 萬（已簽）→ 期程 40/60 → 第 1 期請款 → 副委託 1 列 → 成員 1 人", async () => {
    const contract = await asAdmin(request(app).post(`/projects/${mainId}/contracts`)).send({
      docType: "contract",
      title: "承攬契約",
      amount: 1_000_000,
      signedOn: `${YEAR}-01-10`,
    })
    expect(contract.status).toBe(201)

    const sched = await asAdmin(request(app).put(`/projects/${mainId}/billings`)).send({
      installments: [
        { installmentNo: 1, percentage: 40, milestone: "簽約款" },
        { installmentNo: 2, percentage: 60, milestone: "驗收款" },
      ],
    })
    expect(sched.status).toBe(200)
    const bill = await asAdmin(request(app).post(`/billings/${sched.body.installments[0].id}/bill`)).send({ billedOn: `${YEAR}-02-01` })
    expect(bill.status).toBe(200)

    const subs = await asAdmin(request(app).put(`/projects/${mainId}/subcontracts`)).send({
      subcontracts: [{ kind: "subcontract", discipline: "電機", vendorName: "大同電機工程行", item: "高低壓配電", amount: 300_000 }],
    })
    expect(subs.status).toBe(200)
    const subId = subs.body.subcontracts[0].id
    const pay = await asAdmin(request(app).put(`/projects/${mainId}/subcontracts/${subId}/payments`)).send({
      payments: [{ installmentNo: 1, percentage: 100 }],
    })
    expect(pay.status).toBe(200)

    const member = await asAdmin(request(app).post(`/projects/${mainId}/members`)).send({
      employeeId: employeeEmpId,
      roleInProject: "member",
      sharePct: 12.5,
    })
    expect(member.status).toBe(201)

    const got = await getProject(mainId)
    expect(got.body.money.amountUntaxed).toBe(1_000_000)
    expect(got.body.billings.map((b: { billedOn: string | null }) => b.billedOn)).toEqual([`${YEAR}-02-01`, null])
    expect(got.body.subcontracts[0].payments).toHaveLength(1)
  })
})

describe("C2-1 複製為追加減（change 120 萬）", () => {
  it("非 finance 的一般員工 → 403；kind 不合法／缺理由 → 400；不存在 → 404", async () => {
    expect(
      (await asEmployee(request(app).post(`/projects/${mainId}/duplicate`)).send({ kind: "change", amount: 1, reason: "x" })).status,
    ).toBe(403)
    const badKind = await asAdmin(request(app).post(`/projects/${mainId}/duplicate`)).send({ kind: "advance", amount: 1, reason: "x" })
    expect(badKind.status).toBe(400)
    const noReason = await asAdmin(request(app).post(`/projects/${mainId}/duplicate`)).send({ kind: "change", amount: 1 })
    expect(noReason.status).toBe(400)
    const missing = await asAdmin(request(app).post(`/projects/00000000-0000-0000-0000-000000000000/duplicate`)).send({
      kind: "change",
      amount: 1,
      reason: "x",
    })
    expect(missing.status).toBe(404)
  })

  it("預先取號的空列不能複製 → 409 reserved_project", async () => {
    const reserved = await asAdmin(request(app).post("/projects/reserve")).send({ count: 1 })
    expect(reserved.status).toBe(201)
    const res = await asAdmin(request(app).post(`/projects/${reserved.body.projects[0].id}/duplicate`)).send({
      kind: "change",
      amount: 1,
      reason: "x",
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("reserved_project")
  })

  it("duplicate change 120 萬 → 新案 `${root}-1`、parent=根、kind=change；原案封存＋理由", async () => {
    const res = await asAdmin(request(app).post(`/projects/${mainId}/duplicate`)).send({
      kind: "change",
      amount: 1_200_000,
      reason: "合約由 100 萬變更為 120 萬",
    })
    expect(res.status).toBe(201)
    dup1Id = res.body.project.id
    dup1Code = res.body.project.code
    expect(dup1Code).toBe(`${mainCode}-1`)
    expect(res.body.project.kind).toBe("change")
    expect(res.body.project.parentProjectId).toBe(mainId)
    expect(res.body.project.rootCode).toBe(mainCode)
    expect(res.body.project.name).toBe("惠特總部機電設計（追加減 1）")
    expect(res.body.archived).toEqual({ id: mainId, code: mainCode })

    // 原案：archived_at 非 null＋理由帶新編號（serializeProject 不回 archive_reason，直接讀表）。
    const { data: orig } = await supabaseAdmin
      .from("projects")
      .select("archived_at, archive_reason, status")
      .eq("id", mainId)
      .single()
    expect(orig!.archived_at).not.toBeNull()
    expect(orig!.archive_reason).toBe(`已由 ${dup1Code} 取代：合約由 100 萬變更為 120 萬`)
    // 案情不動——封存是可見性，不是案情。
    expect(orig!.status).toBe("active")
  })

  it("新案內容：期程 2 期只有 %（無請款事件、已重算）、副委託 1 列無付款、change_order 120 萬、opened_on=今天", async () => {
    const got = await getProject(dup1Id)
    expect(got.status).toBe(200)
    const p = got.body.project
    expect(p.code).toBe(dup1Code)
    expect(p.kind).toBe("change")
    expect(p.parentProjectId).toBe(mainId)
    expect(p.openedOn).toBe(TODAY)
    expect(p.archivedAt).toBeNull()
    expect(p.status).toBe("active")
    expect(p.reservedAt).toBeNull()
    // 帶過去的：業主／現場／設計範圍／工程師／請款慣例
    expect(p.clientId).toBe(clientId)
    expect(p.siteAddress).toBe("新竹縣竹北市")
    expect(p.siteAreaM2).toBe(3200)
    expect(p.designScope[0].discipline).toBe("電機")
    expect(p.engineers["電機"].name).toBe("王技師")
    // 不帶的：其他支出從零、分潤池不帶、編號另產
    expect(p.otherExpenses).toBe(0)
    expect(p.bonusPool).toBeNull()

    // 合約：只有 1 筆 change_order 120 萬（原案的 contract 不複製）
    expect(got.body.contracts).toHaveLength(1)
    expect(got.body.contracts[0].docType).toBe("change_order")
    expect(got.body.contracts[0].amount).toBe(1_200_000)
    expect(got.body.contracts[0].ourRole).toBe("contractor")
    expect(got.body.money.amountUntaxed).toBe(1_200_000)
    expect(got.body.money.amountSource).toBe("contract")
    // 原案簽了約，但新案的 change_order 沒有簽訂日 → 還不算「已簽約」
    expect(p.hasSignedContract).toBe(false)

    // 期程：2 期、百分比帶過來、事件全空、金額已依 120 萬重算
    const bills = got.body.billings as Array<Record<string, unknown>>
    expect(bills).toHaveLength(2)
    expect(bills.map((b) => b.installmentNo)).toEqual([1, 2])
    expect(bills.map((b) => b.percentage)).toEqual([40, 60])
    expect(bills.map((b) => b.milestone)).toEqual(["簽約款", "驗收款"])
    expect(bills.every((b) => b.billedOn === null && b.invoicedOn === null && b.receivedOn === null)).toBe(true)
    expect(bills.map((b) => b.calculatedAmount)).toEqual([480_000, 720_000])
    expect(got.body.money.billedTotal).toBe(0)

    // 副委託：1 列結構，沒有付款事件
    expect(got.body.subcontracts).toHaveLength(1)
    expect(got.body.subcontracts[0].vendorName).toBe("大同電機工程行")
    expect(got.body.subcontracts[0].amount).toBe(300_000)
    expect(got.body.subcontracts[0].payments).toEqual([])
    expect(got.body.subcontracts[0].contractId).toBeNull()

    // 成員：角色與 % 帶過來
    const members = await asAdmin(request(app).get(`/projects/${dup1Id}/members`))
    expect(members.status).toBe(200)
    expect(members.body.members).toHaveLength(1)
    expect(members.body.members[0].employeeId).toBe(employeeEmpId)
    expect(members.body.members[0].sharePct).toBe(12.5)
  })

  it("列表預設不回已封存的原案，新案在列表上", async () => {
    const list = await asAdmin(request(app).get("/projects"))
    const ids = list.body.projects.map((p: { id: string }) => p.id)
    expect(ids).not.toContain(mainId)
    expect(ids).toContain(dup1Id)
    const all = await asAdmin(request(app).get("/projects?includeArchived=1"))
    expect(all.body.projects.map((p: { id: string }) => p.id)).toContain(mainId)
  })

  it("★ 封存的原案第 1 期已請款未收 → GET /projects/receivables 仍列該期且 archived:true；原案未付的副委託款也仍在 /disbursements/payables 且 archived:true", async () => {
    const recv = await asAdmin(request(app).get("/projects/receivables"))
    expect(recv.status).toBe(200)
    const rows = recv.body.receivables as Array<{ projectId: string; installmentNo: number; archived: boolean; billedOn: string | null; receivedOn: string | null; unreceived: number | null }>
    const orig1 = rows.find((r) => r.projectId === mainId && r.installmentNo === 1)
    expect(orig1, "封存原案的第 1 期（已請款未收）必須還在未收清單").toBeDefined()
    expect(orig1!.archived).toBe(true)
    expect(orig1!.billedOn).toBe(`${YEAR}-02-01`)
    expect(orig1!.receivedOn).toBeNull()
    expect(orig1!.unreceived).toBe(400_000)
    // 原案第 2 期未請款未收 → 同案仍有未收，一併列（open）；新案 -1 的期別 archived:false
    expect(rows.find((r) => r.projectId === mainId && r.installmentNo === 2)?.archived).toBe(true)
    expect(rows.some((r) => r.projectId === dup1Id && r.archived === false)).toBe(true)
    // GET /projects/:id 回 archiveReason（B4／C 批次：serializeProject 補 archive_reason）
    const got = await getProject(mainId)
    expect(got.body.project.archivedAt).not.toBeNull()
    expect(got.body.project.archiveReason).toBe(`已由 ${dup1Code} 取代：合約由 100 萬變更為 120 萬`)
    expect((await getProject(dup1Id)).body.project.archiveReason).toBeNull()

    const pay = await asAdmin(request(app).get("/disbursements/payables"))
    expect(pay.status).toBe(200)
    const payables = pay.body.payables as Array<{ projectId: string; installmentNo: number; archived: boolean; grossAmount: number }>
    const origPay = payables.find((p) => p.projectId === mainId)
    expect(origPay, "封存原案未付的副委託期款必須還在應付清單").toBeDefined()
    expect(origPay!.archived).toBe(true)
    expect(origPay!.grossAmount).toBe(300_000)
  })
})

describe("C2-2 從新案再複製一次（addition 5 萬，不封存原案）", () => {
  it("→ `${root}-2`，parent 仍是根 main 案；不帶 copy 的項目就不複製", async () => {
    const res = await asAdmin(request(app).post(`/projects/${dup1Id}/duplicate`)).send({
      kind: "addition",
      amount: 50_000,
      reason: "加做：增設車道照明",
      archiveOriginal: false,
      copy: { subcontracts: false, members: false },
    })
    expect(res.status).toBe(201)
    dup2Id = res.body.project.id
    dup2Code = res.body.project.code
    expect(dup2Code).toBe(`${mainCode}-2`)
    expect(res.body.project.parentProjectId).toBe(mainId)
    expect(res.body.project.kind).toBe("addition")
    // 從「（追加減 1）」再複製：舊後綴剝掉，不會疊成兩個括號
    expect(res.body.project.name).toBe("惠特總部機電設計（加做 2）")
    expect(res.body.archived).toBeNull()

    const got = await getProject(dup2Id)
    expect(got.body.project.parentProjectId).toBe(mainId)
    expect(got.body.contracts).toHaveLength(1)
    expect(got.body.contracts[0].docType).toBe("contract")
    expect(got.body.contracts[0].amount).toBe(50_000)
    expect(got.body.billings).toHaveLength(2)
    expect(got.body.subcontracts).toEqual([])
    const members = await asAdmin(request(app).get(`/projects/${dup2Id}/members`))
    expect(members.body.members).toEqual([])

    // -1 沒被封存
    const one = await getProject(dup1Id)
    expect(one.body.project.archivedAt).toBeNull()
  })
})

describe("C2-3 年度總表：不含封存原案、含新案；重複採計防呆", () => {
  it("不含已封存原案（100 萬），含 -1（120 萬）與 -2（5 萬）", async () => {
    const res = await asAdmin(request(app).get(`/projects/annual?year=${ROC}`))
    expect(res.status).toBe(200)
    const rows = res.body.rows as Array<Record<string, unknown>>
    expect(rows.find((r) => r.projectId === mainId)).toBeUndefined()
    const one = rows.find((r) => r.projectId === dup1Id)!
    expect(one).toBeDefined()
    expect(one.code).toBe(dup1Code)
    expect(one.amountUntaxed).toBe(1_200_000)
    expect(one.kind).toBe("change")
    expect(one.createdOn).toBe(TODAY)
    const two = rows.find((r) => r.projectId === dup2Id)!
    expect(two.amountUntaxed).toBe(50_000)
    // 兩個複製案都沒有警告（它們不是母案）
    expect(String(one.note)).not.toContain("重複採計")
    // 封存的原案要 includeArchived=1 才看得到，且金額仍是 100 萬（保留供查）
    const all = await asAdmin(request(app).get(`/projects/annual?year=${ROC}&includeArchived=1`))
    const orig = (all.body.rows as Array<Record<string, unknown>>).find((r) => r.projectId === mainId)!
    expect(orig).toBeDefined()
    expect(orig.archived).toBe(true)
    expect(orig.amountUntaxed).toBe(1_000_000)
  })

  it("母案同時有 change_order 合約＋子案 → 該列 note 有警告；只有 change_order 沒子案 → 沒有", async () => {
    // B：自掛追加減帳、又複製出子案（不封存）→ 警告
    const b = await createProject({ name: "母案 B（自掛追加減）" })
    expect(b.status).toBe(201)
    expect((await asAdmin(request(app).post(`/projects/${b.body.id}/contracts`)).send({ docType: "contract", title: "合約", amount: 500_000, signedOn: `${YEAR}-03-01` })).status).toBe(201)
    expect((await asAdmin(request(app).post(`/projects/${b.body.id}/contracts`)).send({ docType: "change_order", title: "追加減帳", amount: 80_000 })).status).toBe(201)
    const child = await asAdmin(request(app).post(`/projects/${b.body.id}/duplicate`)).send({
      kind: "change",
      amount: 580_000,
      reason: "改走複製案",
      archiveOriginal: false,
    })
    expect(child.status).toBe(201)
    expect(child.body.project.code).toBe(`${b.body.code}-1`)

    // C：只有追加減帳、沒子案 → 不警告
    const c = await createProject({ name: "主案 C（只有追加減帳）" })
    expect((await asAdmin(request(app).post(`/projects/${c.body.id}/contracts`)).send({ docType: "contract", title: "合約", amount: 200_000 })).status).toBe(201)
    expect((await asAdmin(request(app).post(`/projects/${c.body.id}/contracts`)).send({ docType: "change_order", title: "追加減帳", amount: 10_000 })).status).toBe(201)

    const res = await asAdmin(request(app).get(`/projects/annual?year=${ROC}`))
    const rows = res.body.rows as Array<Record<string, unknown>>
    const rowB = rows.find((r) => r.projectId === b.body.id)!
    expect(String(rowB.note)).toContain(ANNUAL_DUPLICATE_COUNT_WARNING)
    expect(String(rowB.note)).toContain("母案追加減帳與子案可能重複採計")
    const rowC = rows.find((r) => r.projectId === c.body.id)!
    expect(String(rowC.note)).not.toContain("重複採計")
    const rowChild = rows.find((r) => r.projectId === child.body.project.id)!
    expect(String(rowChild.note)).not.toContain("重複採計")
  })
})

describe("C2-4 變更歷史 GET /projects/:id/lineage", () => {
  it("從任一案出發三案都在，依編號排；封存案帶 archivedAt 與理由；finance 看得到合約總額", async () => {
    for (const startId of [mainId, dup1Id, dup2Id]) {
      const res = await asAdmin(request(app).get(`/projects/${startId}/lineage`))
      expect(res.status).toBe(200)
      expect(res.body.projectId).toBe(startId)
      expect(res.body.rootId).toBe(mainId)
      expect(res.body.finance).toBe(true)
      const projects = res.body.projects as Array<Record<string, unknown>>
      expect(projects.map((p) => p.code)).toEqual([mainCode, dup1Code, dup2Code])
      expect(projects.map((p) => p.kind)).toEqual(["main", "change", "addition"])
      expect(projects.map((p) => p.contractTotal)).toEqual([1_000_000, 1_200_000, 50_000])
      expect(projects[0].archivedAt).not.toBeNull()
      expect(projects[0].archiveReason).toBe(`已由 ${dup1Code} 取代：合約由 100 萬變更為 120 萬`)
      expect(projects[1].archivedAt).toBeNull()
      expect(projects[1].parentProjectId).toBe(mainId)
      expect(projects[2].parentProjectId).toBe(mainId)
      expect(projects[1].openedOn).toBe(TODAY)
    }
  })

  it("一般員工看得到歷史，但合約總額是 null；不存在的案 404", async () => {
    const res = await asEmployee(request(app).get(`/projects/${dup1Id}/lineage`))
    expect(res.status).toBe(200)
    expect(res.body.finance).toBe(false)
    const projects = res.body.projects as Array<Record<string, unknown>>
    expect(projects.map((p) => p.code)).toEqual([mainCode, dup1Code, dup2Code])
    expect(projects.every((p) => p.contractTotal === null)).toBe(true)
    expect((await asAdmin(request(app).get(`/projects/00000000-0000-0000-0000-000000000000/lineage`))).status).toBe(404)
  })

  it("稽核：新案 INSERT 與原案 UPDATE 各留一筆（帶理由與來源案）", async () => {
    const { data } = await supabaseAdmin
      .from("audit_logs")
      .select("record_id, action, new_row, context")
      .eq("tenant_id", tenantId)
      .like("context", "POST /projects/:id/duplicate%")
    // sql/0033 起 DB trigger 也會對同一筆 INSERT／UPDATE 寫一列（context 同為 route、
    // new_row 是整列資料），所以不能只看第一筆——找「應用層那一筆」（帶 reason／replaced_by）。
    const rows = (data ?? []) as Array<{ record_id: string | null; action: string; new_row: Record<string, unknown> | null }>
    const insert = rows.find((r) => r.record_id === dup1Id && r.action === "INSERT" && r.new_row?.duplicated_from === mainId)
    expect(insert).toBeDefined()
    expect(insert!.new_row!.reason).toBe("合約由 100 萬變更為 120 萬")
    expect(insert!.new_row!.code).toBe(dup1Code)
    const archive = rows.find((r) => r.record_id === mainId && r.action === "UPDATE" && r.new_row?.replaced_by === dup1Id)
    expect(archive).toBeDefined()
    expect(String(archive!.new_row!.archive_reason)).toContain(dup1Code)
  })
})

describe("M23 複製即封存：非 HR 的 finance lead 也會封存原案（不再回 archive_requires_hr）", () => {
  it("一般員工設為 -2 的 lead（取得 finance）→ duplicate 預設就把原案封存，archived 非 null＋warnings 空陣列", async () => {
    const { error } = await supabaseAdmin.from("projects").update({ lead_emp_id: employeeEmpId }).eq("tenant_id", tenantId).eq("id", dup2Id)
    expect(error).toBeNull()
    const { data: before } = await supabaseAdmin.from("projects").select("code").eq("id", dup2Id).single()
    const res = await asEmployee(request(app).post(`/projects/${dup2Id}/duplicate`)).send({
      kind: "addition",
      amount: 1_000,
      reason: "lead 自己加做一小段",
      copy: { subcontracts: false, members: false },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.archived).toEqual({ id: dup2Id, code: before!.code })
    expect(res.body.warnings).toEqual([])
    expect(res.body.project.code).toBe(`${mainCode}-3`)
    // 原案 -2 已封存，理由帶新編號
    const { data: orig } = await supabaseAdmin.from("projects").select("archived_at, archive_reason").eq("id", dup2Id).single()
    expect(orig!.archived_at).not.toBeNull()
    expect(String(orig!.archive_reason)).toContain(res.body.project.code)

    // 封存動作有 audit，而且記得下手的人是那位 lead（不是 HR）
    const { data: rows } = await supabaseAdmin
      .from("audit_logs")
      .select("record_id, action, new_row, actor_emp_id")
      .eq("tenant_id", tenantId)
      .eq("table_name", "projects")
      .eq("record_id", dup2Id)
      .eq("action", "UPDATE")
    const archiveLog = (rows ?? []).find((r) => (r.new_row as Record<string, unknown> | null)?.archived_by_duplicate === res.body.project.id)
    expect(archiveLog, "封存原案要留一筆 audit").toBeDefined()
    expect(archiveLog!.actor_emp_id).toBe(employeeEmpId)
  })

  it("明講 archiveOriginal:false 仍然不封存（demo／要保留兩案時的退路）", async () => {
    const quiet = await asEmployee(request(app).post(`/projects/${dup2Id}/duplicate`)).send({
      kind: "addition",
      amount: 1_000,
      reason: "再加做",
      archiveOriginal: false,
      copy: { subcontracts: false, members: false },
    })
    expect(quiet.status, JSON.stringify(quiet.body)).toBe(201)
    expect(quiet.body.warnings).toEqual([])
    expect(quiet.body.archived).toBeNull()

    const hr = await asAdmin(request(app).post(`/projects/${quiet.body.project.id}/duplicate`)).send({
      kind: "addition",
      amount: 500,
      reason: "HR 複製並封存",
      copy: { subcontracts: false, members: false },
    })
    expect(hr.status, JSON.stringify(hr.body)).toBe(201)
    expect(hr.body.warnings).toEqual([])
    expect(hr.body.archived).toEqual({ id: quiet.body.project.id, code: quiet.body.project.code })
  })
})
