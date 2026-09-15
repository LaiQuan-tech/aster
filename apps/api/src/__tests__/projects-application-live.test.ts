import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import ExcelJS from "exceljs"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { app } from "../app"

/**
 * P3 專案申請單——整合測試（live Supabase，仿 projects.test.ts）。
 * 純函式的錢在 projects-application.test.ts。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let employeeToken: string

/** 編號的年度＝建立年（台北）；民國年＝西元 − 1911。 */
const YEAR = Number(taipeiToday().slice(0, 4))
const ROC = YEAR - 1911

// 有效統編（檢查碼規則見 services/tax-id.ts）。
const TAX_ID_A = "22099131"
const TAX_ID_B = "04595257"

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

/** supertest 預設把回應當文字；xlsx 要用 buffer 收。 */
function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}

beforeAll(async () => {
  const name = `P3TEST ${stamp}`
  const adminEmail = `p3-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
  tenantId = provisioned.tenantId
  createdTenantIds.push(provisioned.tenantId)
  createdUserIds.push(provisioned.userId)
  adminToken = await signIn(adminEmail, adminPassword)

  // 一般員工：看得到專案基本資料，看不到錢。
  const empEmail = `p3-${stamp}-emp@example.com`
  const empPassword = `Pw-${stamp}-Bb2!`
  const { data: empUser, error: empErr } = await supabaseAdmin.auth.admin.createUser({
    email: empEmail,
    password: empPassword,
    email_confirm: true,
    app_metadata: { tenant_id: tenantId },
  })
  if (empErr || !empUser?.user) throw new Error(`employee user: ${empErr?.message}`)
  createdUserIds.push(empUser.user.id)
  const { error: rowErr } = await supabaseAdmin.from("employees").insert({
    tenant_id: tenantId,
    user_id: empUser.user.id,
    name: "一般員工",
    role: "employee",
    employment_type: "regular",
    status: "active",
  })
  if (rowErr) throw new Error(`employee row: ${rowErr.message}`)
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
let mainProjectId: string
let clientId: string
let vendorId: string

describe("P3-1 編號 AT-民國年-流水號", () => {
  it("第一個案子拿到 AT-{民國年}-001", async () => {
    const res = await createProject({ name: "某某大樓機電設計" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`AT-${ROC}-001`)
    mainProjectId = res.body.id
  })

  it("流水號遞增 → 002", async () => {
    const res = await createProject({ name: "第二個案子" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`AT-${ROC}-002`)
  })

  it("歸屬年度預設＝建立年（西元存），編號用民國", async () => {
    const res = await asAdmin(request(app).get(`/projects/${mainProjectId}`))
    expect(res.status).toBe(200)
    expect(res.body.project.fiscalYear).toBe(YEAR)
    expect(res.body.project.kind).toBe("main")
  })
})

describe("P3-1 預先取號", () => {
  let reserved: Array<{ id: string; code: string }>

  it("reserve 5 筆連號", async () => {
    const res = await asAdmin(request(app).post("/projects/reserve")).send({ count: 5 })
    expect(res.status).toBe(201)
    reserved = res.body.projects
    expect(reserved.map((p) => p.code)).toEqual([3, 4, 5, 6, 7].map((n) => `AT-${ROC}-00${n}`))

    // A5 修法：預先取號要跟正式建案一樣補租戶今天，不能等填真名才補開案日期——
    // 不然填真名之前，申請單抬頭與年度總表都會退回用（其實不存在的）建立日。
    const got = await asAdmin(request(app).get(`/projects/${reserved[0].id}`))
    expect(got.body.project.openedOn).toBe(taipeiToday())
  })

  it("count 超過 20 或非 HR 都擋", async () => {
    expect((await asAdmin(request(app).post("/projects/reserve")).send({ count: 21 })).status).toBe(400)
    expect((await asEmployee(request(app).post("/projects/reserve")).send({ count: 1 })).status).toBe(403)
  })

  it("列表預設不回 reserved 空列；?includeReserved=1 才回", async () => {
    const list = await asAdmin(request(app).get("/projects"))
    const ids = list.body.projects.map((p: { id: string }) => p.id)
    expect(ids).not.toContain(reserved[0].id)
    expect(ids).toContain(mainProjectId)

    const all = await asAdmin(request(app).get("/projects?includeReserved=1"))
    const allIds = all.body.projects.map((p: { id: string }) => p.id)
    expect(allIds).toContain(reserved[0].id)
    const row = all.body.projects.find((p: { id: string }) => p.id === reserved[0].id)
    expect(row.name).toBe("（預先取號）")
    expect(row.reservedAt).not.toBeNull()
  })

  it("PATCH 填上名字就變成正式案子（reservedAt 清空、進列表）", async () => {
    const res = await asAdmin(request(app).patch(`/projects/${reserved[0].id}`)).send({ name: "後來談成的案子" })
    expect(res.status).toBe(200)
    const got = await asAdmin(request(app).get(`/projects/${reserved[0].id}`))
    expect(got.body.project.reservedAt).toBeNull()
    expect(got.body.project.code).toBe(`AT-${ROC}-003`)
    const list = await asAdmin(request(app).get("/projects"))
    expect(list.body.projects.map((p: { id: string }) => p.id)).toContain(reserved[0].id)

    // 詳情頁的「開案日期」欄位（B4）：PATCH openedOn 早就支援，缺的是 UI——
    // 這裡直接打 API 驗 PATCH → GET 一致，事後補 K 單的案子才改得了這欄。
    // 改完隨即還原成今天：這個值也是年度總表的建立月份分區依據
    // （project-application-store.ts buildAnnualTable），改成舊日期會讓這筆
    // 跑進更早的月份區塊、排到 P3-6 的總表最前面，弄壞後面「第一列是 001」
    // 那些不相干的斷言——這裡只驗 PATCH／GET 這條路本身，不該留副作用。
    const patched = await asAdmin(request(app).patch(`/projects/${reserved[0].id}`)).send({ openedOn: "2024-05-20" })
    expect(patched.status).toBe(200)
    const got2 = await asAdmin(request(app).get(`/projects/${reserved[0].id}`))
    expect(got2.body.project.openedOn).toBe("2024-05-20")
    const restored = await asAdmin(request(app).patch(`/projects/${reserved[0].id}`)).send({ openedOn: taipeiToday() })
    expect(restored.status).toBe(200)
  })

  it("取號之後建案繼續往下編（008），不會回頭用到保留的號", async () => {
    const res = await createProject({ name: "取號之後的案子" })
    expect(res.body.code).toBe(`AT-${ROC}-008`)
  })
})

describe("P3-3 案型與母案", () => {
  it("kind=addition 沒帶母案 → 400 parent_required", async () => {
    const res = await createProject({ name: "加做", kind: "addition" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("parent_required")
  })

  it("母案是 main → 201；母案不是 main → 400 invalid_parent", async () => {
    const ok = await createProject({ name: "加做：增設車道", kind: "addition", parentProjectId: mainProjectId })
    expect(ok.status).toBe(201)
    const got = await asAdmin(request(app).get(`/projects/${ok.body.id}`))
    expect(got.body.project.kind).toBe("addition")
    expect(got.body.project.parentProjectId).toBe(mainProjectId)

    const bad = await createProject({ name: "疊羅漢", kind: "change", parentProjectId: ok.body.id })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("invalid_parent")
  })

  it("main 不能掛母案、也不能掛不存在的母案", async () => {
    const a = await createProject({ name: "主案掛母案", kind: "main", parentProjectId: mainProjectId })
    expect(a.status).toBe(400)
    expect(a.body.error).toBe("invalid_parent")
    const b = await createProject({ name: "母案不存在", kind: "advance", parentProjectId: "00000000-0000-0000-0000-000000000000" })
    expect(b.status).toBe(400)
    expect(b.body.error).toBe("invalid_parent")
  })

  it("PATCH 改案型也走同一套規則", async () => {
    const res = await asAdmin(request(app).patch(`/projects/${mainProjectId}`)).send({ kind: "change" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("parent_required")
  })
})

describe("P3-2 客戶名冊", () => {
  it("統編檢查碼錯 → 400；正確 → 201", async () => {
    const bad = await asAdmin(request(app).post("/clients")).send({ name: "檢查碼錯", taxId: "12345678" })
    expect(bad.status).toBe(400)
    const ok = await asAdmin(request(app).post("/clients")).send({
      name: "某某建設股份有限公司",
      taxId: TAX_ID_A,
      invoiceType: "triplicate",
      paymentMethod: "transfer",
      closingDay: "每月 25 日",
      paymentDay: "次月 10 日",
      contactName: "陳經理",
    })
    expect(ok.status).toBe(201)
    expect(ok.body.client.taxId).toBe(TAX_ID_A)
    clientId = ok.body.client.id
  })

  it("統編重複 → 409 tax_id_taken", async () => {
    const dup = await asAdmin(request(app).post("/clients")).send({ name: "另一家", taxId: TAX_ID_A })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe("tax_id_taken")
  })

  it("非 HR 不能寫，但讀得到；?q= 搜尋", async () => {
    expect((await asEmployee(request(app).post("/clients")).send({ name: "x" })).status).toBe(403)
    const list = await asEmployee(request(app).get("/clients?q=某某建設"))
    expect(list.status).toBe(200)
    expect(list.body.clients.map((c: { id: string }) => c.id)).toContain(clientId)
  })

  it("PATCH 改資料；軟刪後不在列表", async () => {
    const other = await asAdmin(request(app).post("/clients")).send({ name: "要刪的客戶", taxId: TAX_ID_B })
    expect(other.status).toBe(201)
    const patched = await asAdmin(request(app).patch(`/clients/${other.body.client.id}`)).send({ phone: "02-1234-5678" })
    expect(patched.status).toBe(200)
    expect(patched.body.client.phone).toBe("02-1234-5678")
    const del = await asAdmin(request(app).delete(`/clients/${other.body.client.id}`))
    expect(del.status).toBe(200)
    const list = await asAdmin(request(app).get("/clients"))
    expect(list.body.clients.map((c: { id: string }) => c.id)).not.toContain(other.body.client.id)
    // 刪掉之後同一統編可以再建（partial unique 只看未刪的列）。
    const again = await asAdmin(request(app).post("/clients")).send({ name: "重建", taxId: TAX_ID_B })
    expect(again.status).toBe(201)
  })
})

describe("P3-2 我方主體", () => {
  it("整批 upsert；isDefault 只能一筆", async () => {
    const two = await asAdmin(request(app).put("/companies")).send({
      companies: [
        { name: "亞斯特設計顧問有限公司", isDefault: true },
        { name: "亞斯特工程有限公司", isDefault: true },
      ],
    })
    expect(two.status).toBe(400)
    expect(two.body.error).toBe("multiple_defaults")

    const ok = await asAdmin(request(app).put("/companies")).send({
      companies: [
        { name: "亞斯特設計顧問有限公司", isDefault: true, taxId: TAX_ID_A },
        { name: "亞斯特工程有限公司" },
      ],
    })
    expect(ok.status).toBe(200)
    expect(ok.body.companies).toHaveLength(2)
    expect(ok.body.companies.filter((c: { isDefault: boolean }) => c.isDefault)).toHaveLength(1)
    expect(ok.body.companies[0].name).toBe("亞斯特設計顧問有限公司")

    // 切換預設：舊的自動取消。
    const second = ok.body.companies[1]
    const sw = await asAdmin(request(app).put("/companies")).send({ companies: [{ id: second.id, name: second.name, isDefault: true }] })
    expect(sw.status).toBe(200)
    expect(sw.body.companies.find((c: { isDefault: boolean }) => c.isDefault).id).toBe(second.id)
    expect(sw.body.companies).toHaveLength(2)

    const list = await asEmployee(request(app).get("/companies"))
    expect(list.status).toBe(200)
    expect(list.body.companies).toHaveLength(2)
  })
})

describe("P3-3 申請單欄位與三段權限", () => {
  it("建案帶 clientId：請款慣例從業主預填", async () => {
    const res = await createProject({
      name: "帶業主的案子",
      clientId,
      siteAddress: "台北市信義區",
      siteAreaM2: 1234.5,
      designScope: [{ discipline: "電機", item: "高低壓", amount: 800000 }],
      engineers: { electrical: { name: "王技師" } },
      otherExpenses: 18645,
    })
    expect(res.status).toBe(201)
    const got = await asAdmin(request(app).get(`/projects/${res.body.id}`))
    expect(got.body.project.invoiceType).toBe("triplicate")
    expect(got.body.project.paymentMethod).toBe("transfer")
    expect(got.body.project.closingDay).toBe("每月 25 日")
    expect(got.body.project.client.name).toBe("某某建設股份有限公司")
    expect(got.body.project.designScope[0].amount).toBe(800000)
    expect(got.body.project.engineers.electrical.name).toBe("王技師")
    expect(got.body.project.otherExpenses).toBe(18645)
    expect(got.body.access).toEqual({ finance: true, bonus: true })
    expect(got.body.money).not.toBeNull()
  })

  it("不存在的業主 → 400 invalid_client", async () => {
    const res = await createProject({ name: "x", clientId: "00000000-0000-0000-0000-000000000000" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_client")
  })

  it("一般員工：basic 看得到、錢看不到", async () => {
    const list = await asAdmin(request(app).get("/projects"))
    const p = list.body.projects.find((x: { name: string }) => x.name === "帶業主的案子")
    const got = await asEmployee(request(app).get(`/projects/${p.id}`))
    expect(got.status).toBe(200)
    expect(got.body.project.name).toBe("帶業主的案子")
    expect(got.body.project.client.name).toBe("某某建設股份有限公司")
    expect(got.body.access).toEqual({ finance: false, bonus: false })
    expect(got.body.money).toBeNull()
    expect(got.body.billings).toEqual([])
    expect(got.body.subcontracts).toEqual([])
    expect(got.body.project.otherExpenses).toBeNull()
    expect(got.body.project.designScope[0].amount).toBeNull()
    expect(got.body.project.designScope[0].discipline).toBe("電機")

    expect((await asEmployee(request(app).get(`/projects/${p.id}/billings`))).status).toBe(403)
    expect((await asEmployee(request(app).get(`/projects/${p.id}/subcontracts`))).status).toBe(403)
  })
})

describe("P3-4 合約 → 期程 → 請款／開票／入帳 → money", () => {
  let installments: Array<{ id: string; installmentNo: number }>

  function schedule(body: Record<string, unknown>) {
    return asAdmin(request(app).put(`/projects/${mainProjectId}/billings`)).send(body)
  }

  it("沒合約、有報價單：分母退用報價單並標 amountSource=quotation", async () => {
    const q = await asAdmin(request(app).post(`/projects/${mainProjectId}/contracts`)).send({
      docType: "quotation",
      title: "報價單",
      amount: 2_900_000,
    })
    expect(q.status).toBe(201)
    const got = await asAdmin(request(app).get(`/projects/${mainProjectId}`))
    expect(got.body.money.amountUntaxed).toBe(2_900_000)
    expect(got.body.money.amountSource).toBe("quotation")
  })

  it("簽約 3,043,645 → 稅 152,182、含稅 3,195,827", async () => {
    const c = await asAdmin(request(app).post(`/projects/${mainProjectId}/contracts`)).send({
      docType: "contract",
      title: "承攬契約",
      amount: 3_043_645,
      signedOn: `${YEAR}-01-15`,
    })
    expect(c.status).toBe(201)
    const got = await asAdmin(request(app).get(`/projects/${mainProjectId}`))
    expect(got.body.money.amountSource).toBe("contract")
    expect(got.body.money.amountUntaxed).toBe(3_043_645)
    expect(got.body.money.vatRate).toBe(0.05)
    expect(got.body.money.taxAmount).toBe(152_182)
    expect(got.body.money.amountTotal).toBe(3_195_827)
    expect(got.body.project.hasSignedContract).toBe(true)
    expect(got.body.contracts.map((x: { docType: string }) => x.docType).sort()).toEqual(["contract", "quotation"])
  })

  it("期程 30/30/40：尾差落末期", async () => {
    const res = await schedule({
      installments: [
        { installmentNo: 1, percentage: 30, milestone: "簽約款" },
        { installmentNo: 2, percentage: 30, milestone: "送審款" },
        { installmentNo: 3, percentage: 40, milestone: "驗收款" },
      ],
    })
    expect(res.status).toBe(200)
    installments = res.body.installments
    expect(res.body.installments[0].calculatedAmount).toBe(913_094)
    expect(res.body.installments[2].calculatedAmount).toBe(1_217_457)
    expect(res.body.summary.effectiveTotal).toBe(3_043_645)
    expect(res.body.installments[0].kind).toBe("installment")
    expect(res.body.installments[0].invoicedOn).toBeNull()
    expect(res.body.installments[0].receivedOn).toBeNull()
  })

  it("請款 → 開票 → 入帳（預設實收＝該期金額）", async () => {
    const bill = await asAdmin(request(app).post(`/billings/${installments[0].id}/bill`)).send({ billedOn: `${YEAR}-02-01` })
    expect(bill.status).toBe(200)
    expect(bill.body.warnings).toEqual([])

    const inv = await asAdmin(request(app).post(`/billings/${installments[0].id}/invoice`)).send({
      invoiceNo: "AB-12345678",
      invoicedOn: `${YEAR}-02-03`,
    })
    expect(inv.status).toBe(200)
    expect(inv.body.warnings).toEqual([])
    expect(inv.body.installments[0].invoiceNo).toBe("AB-12345678")
    expect(inv.body.summary.invoicedTotal).toBe(913_094)

    const rcv = await asAdmin(request(app).post(`/billings/${installments[0].id}/receive`)).send({ receivedOn: `${YEAR}-03-01` })
    expect(rcv.status).toBe(200)
    expect(rcv.body.warnings).toEqual([])
    expect(rcv.body.installments[0].receivedAmount).toBe(913_094)
    expect(rcv.body.summary.receivedTotal).toBe(913_094)
    expect(rcv.body.summary.unreceivedTotal).toBe(0)

    const got = await asAdmin(request(app).get(`/projects/${mainProjectId}`))
    const m = got.body.money
    expect(m.billedTotal).toBe(913_094)
    expect(m.invoicedTotal).toBe(913_094)
    expect(m.receivedTotal).toBe(913_094)
    expect(m.unreceived).toBe(2_130_551)
    expect(m.billingProgressPct).toBe(30)
    expect(m.receiptProgressPct).toBe(30)
    expect(got.body.billings).toHaveLength(3)
  })

  it("重複開票／入帳 → 409", async () => {
    const inv = await asAdmin(request(app).post(`/billings/${installments[0].id}/invoice`)).send({ invoiceNo: "X" })
    expect(inv.status).toBe(409)
    expect(inv.body.error).toBe("already_invoiced")
    const rcv = await asAdmin(request(app).post(`/billings/${installments[0].id}/receive`)).send({})
    expect(rcv.status).toBe(409)
    expect(rcv.body.error).toBe("already_received")
  })

  it("順序不擋只提醒：未請款就開票 → warnings invoiced_before_billed；未開票就收款 → received_before_invoiced", async () => {
    const inv = await asAdmin(request(app).post(`/billings/${installments[1].id}/invoice`)).send({ invoiceNo: "AB-00000002" })
    expect(inv.status).toBe(200)
    expect(inv.body.warnings).toContain("invoiced_before_billed")

    const rcv = await asAdmin(request(app).post(`/billings/${installments[2].id}/receive`)).send({ receivedAmount: 100_000 })
    expect(rcv.status).toBe(200)
    expect(rcv.body.warnings).toContain("received_before_invoiced")
    expect(rcv.body.installments[2].receivedAmount).toBe(100_000)
  })

  it("已入帳的期別：改金額 → 409 received；移除 → 409 received", async () => {
    const change = await schedule({
      installments: [
        { id: installments[0].id, installmentNo: 1, percentage: 35 },
        { id: installments[1].id, installmentNo: 2, percentage: 25 },
        { id: installments[2].id, installmentNo: 3, percentage: 40 },
      ],
    })
    expect(change.status).toBe(409)
    expect(change.body.error).toBe("received")
    expect(change.body.installmentNo).toBe(1)

    const remove = await schedule({
      installments: [
        { id: installments[0].id, installmentNo: 1, percentage: 30 },
        { id: installments[1].id, installmentNo: 2, percentage: 70 },
      ],
    })
    expect(remove.status).toBe(409)
    expect(remove.body.error).toBe("received")
  })

  it("撤銷入帳／開票要理由；撤銷後可再改", async () => {
    const noReason = await asAdmin(request(app).post(`/billings/${installments[2].id}/unreceive`)).send({})
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("reason_required")
    const un = await asAdmin(request(app).post(`/billings/${installments[2].id}/unreceive`)).send({ reason: "誤登" })
    expect(un.status).toBe(200)
    expect(un.body.installments[2].receivedOn).toBeNull()
    expect(un.body.installments[2].note).toContain("撤銷入帳")

    const uninv = await asAdmin(request(app).post(`/billings/${installments[1].id}/uninvoice`)).send({ reason: "作廢重開" })
    expect(uninv.status).toBe(200)
    expect(uninv.body.installments[1].invoiceNo).toBeNull()
    expect(uninv.body.installments[1].invoicedOn).toBeNull()
  })

  it("guild_advance：只是一筆金額，不進百分比／尾差；同樣可請款", async () => {
    const res = await schedule({
      installments: [
        { id: installments[0].id, installmentNo: 1, percentage: 30, milestone: "簽約款" },
        { id: installments[1].id, installmentNo: 2, percentage: 30, milestone: "送審款" },
        { id: installments[2].id, installmentNo: 3, percentage: 40, milestone: "驗收款" },
        { installmentNo: 9, kind: "guild_advance", overrideAmount: 100_000, overrideReason: "公會估驗預付", milestone: "公會預付款" },
      ],
    })
    expect(res.status).toBe(200)
    const adv = res.body.installments.find((i: { kind: string }) => i.kind === "guild_advance")
    expect(adv.effectiveAmount).toBe(100_000)
    expect(adv.residueApplied).toBe(0)
    expect(res.body.summary.percentageTotal).toBe(100)
    expect(res.body.summary.effectiveTotal).toBe(3_043_645)
    expect(res.body.summary.guildAdvanceTotal).toBe(100_000)
    // 末期仍是吸收尾差的那一期，不受預付款影響。
    expect(res.body.installments.find((i: { installmentNo: number }) => i.installmentNo === 3).calculatedAmount).toBe(1_217_457)
  })
})

describe("P3-5 副委託與期款", () => {
  let technicianId: string
  let subcontractId: string

  it("vendorId 要在名冊裡", async () => {
    const v = await asAdmin(request(app).post("/vendors")).send({ name: "大同電機工程行", category: "電機" })
    expect(v.status).toBe(201)
    vendorId = v.body.vendor.id

    const bad = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts`)).send({
      subcontracts: [{ kind: "subcontract", vendorId: "00000000-0000-0000-0000-000000000000", amount: 1 }],
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("invalid_vendor")
  })

  it("整批建立：下包 1,200,000（電機）＋技師費 25,000 → money 的發包與損益", async () => {
    const res = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts`)).send({
      subcontracts: [
        { kind: "subcontract", discipline: "電機", vendorId, item: "高低壓配電", amount: 1_200_000, orderType: "quotation" },
        { kind: "technician", discipline: "電機", vendorName: "王技師", item: "電機技師簽證", amount: 25_000 },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.subcontracts).toHaveLength(2)
    expect(res.body.subcontracts[0].vendorName).toBe("大同電機工程行")
    expect(res.body.summary.subcontractTotal).toBe(1_200_000)
    expect(res.body.summary.technicianTotal).toBe(25_000)
    subcontractId = res.body.subcontracts[0].id
    technicianId = res.body.subcontracts[1].id

    const got = await asAdmin(request(app).get(`/projects/${mainProjectId}`))
    expect(got.body.money.subcontractTotal).toBe(1_225_000)
    expect(got.body.money.technicianTotal).toBe(25_000)
    expect(got.body.money.profit).toBe(3_043_645 - 1_225_000)
    expect(got.body.subcontracts).toHaveLength(2)
  })

  it("技師費一期 100%：代扣 2,500、實付 22,500；付款主體要在 companies", async () => {
    const companies = (await asAdmin(request(app).get("/companies"))).body.companies
    const payer = companies[0].id
    const issuer = companies[1].id

    const badCompany = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${technicianId}/payments`)).send({
      payments: [{ installmentNo: 1, percentage: 100, payingCompanyId: "00000000-0000-0000-0000-000000000000" }],
    })
    expect(badCompany.status).toBe(400)
    expect(badCompany.body.error).toBe("invalid_company")

    const res = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${technicianId}/payments`)).send({
      payments: [{ installmentNo: 1, percentage: 100, dueWhen: "簽證完成後 30 天", payingCompanyId: payer, receiptIssuerCompanyId: issuer }],
    })
    expect(res.status).toBe(200)
    const p = res.body.subcontract.payments[0]
    expect(p.effectiveAmount).toBe(25_000)
    expect(p.withheldAmount).toBe(2_500)
    expect(p.netAmount).toBe(22_500)
    expect(p.paidOn).toBeNull()
    expect(p.payingCompanyId).toBe(payer)
    expect(p.receiptIssuerCompanyId).toBe(issuer)
  })

  it("下包 1,200,000 分 50/50，每期 600,000 各扣 60,000；18,000 的期別不扣", async () => {
    const res = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${subcontractId}/payments`)).send({
      payments: [
        { installmentNo: 1, percentage: 50 },
        { installmentNo: 2, percentage: 50 },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.subcontract.payments.map((p: { withheldAmount: number }) => p.withheldAmount)).toEqual([60_000, 60_000])
    expect(res.body.subcontract.summary.effectiveTotal).toBe(1_200_000)

    // 覆寫一期成 18,000（未達門檻）→ 0；覆寫要理由。
    const noReason = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${subcontractId}/payments`)).send({
      payments: [
        { installmentNo: 1, percentage: 50, overrideAmount: 18_000 },
        { installmentNo: 2, percentage: 50 },
      ],
    })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("override_reason_required")

    const ok = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${subcontractId}/payments`)).send({
      payments: [
        { installmentNo: 1, percentage: 50, overrideAmount: 18_000, overrideReason: "先付一小筆" },
        { installmentNo: 2, percentage: 50 },
      ],
    })
    expect(ok.status).toBe(200)
    expect(ok.body.subcontract.payments[0].withheldAmount).toBe(0)
    // 差額落末期：1,200,000 − 18,000 = 1,182,000
    expect(ok.body.subcontract.payments[1].effectiveAmount).toBe(1_182_000)
    expect(ok.body.subcontract.summary.effectiveTotal).toBe(1_200_000)
  })

  it("標記已付：實付預設＝毛額 − 代扣；之後改金額／漏掉 → 409 paid", async () => {
    const pay = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${technicianId}/payments`)).send({
      payments: [{ installmentNo: 1, percentage: 100, paidOn: `${YEAR}-04-01` }],
    })
    expect(pay.status).toBe(200)
    expect(pay.body.subcontract.payments[0].paidOn).toBe(`${YEAR}-04-01`)
    expect(pay.body.subcontract.payments[0].paidAmount).toBe(22_500)
    expect(pay.body.subcontract.summary.paidTotal).toBe(22_500)

    const change = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${technicianId}/payments`)).send({
      payments: [{ installmentNo: 1, percentage: 60, paidOn: `${YEAR}-04-01` }],
    })
    expect(change.status).toBe(409)
    expect(change.body.error).toBe("paid")

    const omit = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${technicianId}/payments`)).send({
      payments: [{ installmentNo: 2, percentage: 100 }],
    })
    expect(omit.status).toBe(409)
    expect(omit.body.error).toBe("paid")

    // 改回未付要理由。
    const unpayNoReason = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts/${technicianId}/payments`)).send({
      payments: [{ installmentNo: 1, percentage: 100, paidOn: null }],
    })
    expect(unpayNoReason.status).toBe(400)
    expect(unpayNoReason.body.error).toBe("reason_required")
  })

  it("有已付期款的副委託不可移除；未付的可軟刪但要理由", async () => {
    const noReason = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts`)).send({
      subcontracts: [{ id: technicianId, kind: "technician", discipline: "電機", vendorName: "王技師", amount: 25_000 }],
    })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("delete_reason_required")

    const paid = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts`)).send({
      subcontracts: [{ id: subcontractId, kind: "subcontract", discipline: "電機", vendorId, amount: 1_200_000 }],
      deleteReason: "取消技師",
    })
    expect(paid.status).toBe(409)
    expect(paid.body.error).toBe("paid")

    // 未付的下包可以拿掉，之後再放回來（新列）。
    const removed = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts`)).send({
      subcontracts: [{ id: technicianId, kind: "technician", discipline: "電機", vendorName: "王技師", amount: 25_000 }],
      deleteReason: "改自辦",
    })
    expect(removed.status).toBe(200)
    expect(removed.body.subcontracts).toHaveLength(1)
    const back = await asAdmin(request(app).put(`/projects/${mainProjectId}/subcontracts`)).send({
      subcontracts: [
        { id: technicianId, kind: "technician", discipline: "電機", vendorName: "王技師", amount: 25_000 },
        { kind: "subcontract", discipline: "空調", vendorId, item: "空調", amount: 300_000 },
      ],
    })
    expect(back.status).toBe(200)
    expect(back.body.subcontracts).toHaveLength(2)
  })
})

describe("P3-6 年度總表與未收款", () => {
  it("json：一列一案，含 reserved 空列；金額／稅／備註／科別發包／期數", async () => {
    const res = await asAdmin(request(app).get(`/projects/annual?year=${ROC}`))
    expect(res.status).toBe(200)
    expect(res.body.year).toBe(YEAR)
    expect(res.body.rocYear).toBe(ROC)
    const rows = res.body.rows as Array<Record<string, unknown>>
    const main = rows.find((r) => r.projectId === mainProjectId)!
    expect(main).toBeDefined()
    expect(main.code).toBe(`AT-${ROC}-001`)
    expect(main.dateRoc).toMatch(/^\d{3}\.\d{1,2}\.\d{1,2}$/)
    expect(main.amountUntaxed).toBe(3_043_645)
    expect(main.taxAmount).toBe(152_182)
    expect(main.amountTotal).toBe(3_195_827)
    expect(main.note).toContain("累計請款 30%")
    expect(main.note).toContain("應付王技師 25,000")
    expect(main.subcontractByDiscipline).toEqual({ 空調: 300_000 })
    expect(main.billingProgressPct).toBe(30)
    expect(main.receiptProgressPct).toBe(30)
    expect(main.unreceived).toBe(2_130_551)
    expect(main.installments).toBe("1/3")
    expect(main.status).toBe("active")
    // reserved 空列也在（還沒填名字的那 4 筆）
    expect(rows.filter((r) => r.reserved).length).toBe(4)
    // 項次連號、預設按編號排
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1))
    expect(rows[0].code).toBe(`AT-${ROC}-001`)
    // 區塊與總計
    expect(res.body.blocks.length).toBeGreaterThanOrEqual(1)
    expect(res.body.totals.count).toBe(rows.length)
    expect(res.body.totals.amountUntaxed).toBe(rows.reduce((s, r) => s + ((r.amountUntaxed as number | null) ?? 0), 0))
    expect(res.body.totals.subcontractByDiscipline).toEqual({ 空調: 300_000 })
    expect(res.body.disciplines.slice(0, 4)).toEqual(["電機", "空調", "消防", "汙水"])
  })

  it("year 可用西元；sort=unreceived_pct 把未收比例高的排前面；非 HR 403", async () => {
    const ad = await asAdmin(request(app).get(`/projects/annual?year=${YEAR}&sort=unreceived_pct`))
    expect(ad.status).toBe(200)
    const rows = ad.body.rows as Array<{ unreceivedPct: number | null }>
    const known = rows.filter((r) => r.unreceivedPct !== null).map((r) => r.unreceivedPct as number)
    expect(known).toEqual([...known].sort((a, b) => b - a))
    // 分母未知的排最後
    const firstNull = rows.findIndex((r) => r.unreceivedPct === null)
    if (firstNull >= 0) expect(rows.slice(firstNull).every((r) => r.unreceivedPct === null)).toBe(true)

    expect((await asEmployee(request(app).get(`/projects/annual?year=${ROC}`))).status).toBe(403)
    expect((await asAdmin(request(app).get(`/projects/annual?year=abc`))).status).toBe(400)
  })

  it("xlsx：A1 專案申請單、A2 公司＋年度、表頭、總計列；檔名帶民國年", async () => {
    const res = await asAdmin(request(app).get(`/projects/annual?year=${ROC}&format=xlsx`))
      .buffer(true)
      .parse(binaryParser)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
    expect(res.headers["content-disposition"]).toContain(encodeURIComponent(`AT-${ROC}年專案申請單總表.xlsx`))

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(new Uint8Array(res.body as Buffer) as unknown as ExcelJS.Buffer)
    const ws = wb.worksheets[0]
    expect(ws.getCell("A1").value).toBe("專案申請單")
    // A2 公司名：companies 的預設主體（上面切成了亞斯特工程）
    expect(String(ws.getCell("A2").value)).toBe(`亞斯特工程有限公司 ${ROC}年度總表`)
    expect(String(ws.getCell("A3").value)).toMatch(/^日期：\d{3}\.\d{1,2}\.\d{1,2}$/)
    const header = ws.getRow(5).values as unknown[]
    expect(header.slice(1, 11)).toEqual(["項次", "專案單號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅", "業務", "備註"])
    expect(header).toContain("電機發包")
    expect(header).toContain("請款進度%")
    expect(header[header.length - 1]).toBe("期數")
    // 第一筆資料列是 AT-{ROC}-001，金額是數字不是字串
    expect(ws.getCell("B6").value).toBe(`AT-${ROC}-001`)
    expect(ws.getCell("F6").value).toBe(3_043_645)
    expect(ws.getCell("G6").value).toBe(152_182)
    // 最後一列是年度總計
    const last = ws.getRow(ws.rowCount)
    expect(String(last.getCell(1).value)).toContain("年度總計")
    expect(last.getCell(6).value).toBeTypeOf("number")
  })

  it("receivables：每期一列，逾期天數從開票日算；一般員工只回自己的案（沒有就空）", async () => {
    const res = await asAdmin(request(app).get("/projects/receivables"))
    expect(res.status).toBe(200)
    expect(res.body.scope).toBe("all")
    const rows = res.body.receivables as Array<Record<string, unknown>>
    const mine = rows.filter((r) => r.projectId === mainProjectId)
    // 第 1 期已全收 → open 清單不含；第 2、3 期與公會預付款在。
    expect(mine.map((r) => r.installmentNo).sort()).toEqual([2, 3, 9])
    const second = mine.find((r) => r.installmentNo === 2)!
    expect(second.amount).toBe(913_094)
    expect(second.unreceived).toBe(913_094)
    expect(second.clientName).toBeNull()
    expect(second.overdueDays).toBeNull() // 已撤銷開票
    expect(res.body.summary.count).toBe(rows.length)

    const all = await asAdmin(request(app).get("/projects/receivables?status=all"))
    expect((all.body.receivables as Array<Record<string, unknown>>).filter((r) => r.projectId === mainProjectId)).toHaveLength(4)

    const emp = await asEmployee(request(app).get("/projects/receivables"))
    expect(emp.status).toBe(200)
    expect(emp.body.scope).toBe("mine")
    expect(emp.body.receivables).toEqual([])
  })

  it("receivables 逾期：開票後未入帳從開票日起算（即使從沒請款——basis='billed' 沒有請款日時要退回開票日，不能讓這筆錢從逾期清單消失）", async () => {
    const sched = await asAdmin(request(app).get(`/projects/${mainProjectId}/billings`))
    const second = sched.body.installments.find((i: { installmentNo: number }) => i.installmentNo === 2)
    // 刻意不先 /bill：這是系統明確支援的順序（invoice 前 billings.ts 只會提醒
    // invoiced_before_billed，不會擋），也是 unbill 之後 invoiced_on 被保留、
    // billed_on 被清空的真實狀態。overdueDays 在 basis='billed' 下若沒有 billedOn
    // 退回用 invoicedOn，這筆錢才不會從逾期清單裡消失（B5 review 抓到的迴歸）。
    const inv = await asAdmin(request(app).post(`/billings/${second.id}/invoice`)).send({ invoiceNo: "AB-00000003", invoicedOn: `${YEAR - 1}-12-01` })
    expect(inv.status).toBe(200)
    const res = await asAdmin(request(app).get("/projects/receivables"))
    expect(res.body.basis).toBe("billed")
    const row = (res.body.receivables as Array<Record<string, unknown>>).find((r) => r.billingId === second.id)!
    expect(row.billedOn).toBeNull()
    expect(row.overdueDays as number).toBeGreaterThan(200)
    expect(row.state).toBe("overdue")
    expect(res.body.summary.overdueCount).toBeGreaterThanOrEqual(1)
    // 逾期的要排在清單最前面幾名（compareReceivables 用新算出的 overdueDays 重排，
    // 不能還在用 buildReceivables 內部那個舊基準排好的順序）。
    const idx = (res.body.receivables as Array<Record<string, unknown>>).findIndex((r) => r.billingId === second.id)
    expect(idx).toBeLessThan(3)
  })

  it("receivables：?state= 篩選——billed 只回已請款未開票未入帳；overdue 每列 state 都是 overdue；不帶 state 回全部且每列有 state", async () => {
    const all = await asAdmin(request(app).get("/projects/receivables?status=all"))
    expect(all.status).toBe(200)
    const allRows = all.body.receivables as Array<Record<string, unknown>>
    expect(allRows.length).toBeGreaterThan(0)
    for (const r of allRows) {
      expect(["unbilled", "billed", "invoiced", "overdue", "received"]).toContain(r.state)
    }

    const overdue = await asAdmin(request(app).get("/projects/receivables?status=all&state=overdue"))
    expect(overdue.status).toBe(200)
    const overdueRows = overdue.body.receivables as Array<Record<string, unknown>>
    expect(overdueRows.length).toBeGreaterThan(0)
    for (const r of overdueRows) expect(r.state).toBe("overdue")
    expect(overdueRows.map((r) => r.billingId).sort()).toEqual(
      allRows.filter((r) => r.state === "overdue").map((r) => r.billingId).sort(),
    )

    const billed = await asAdmin(request(app).get("/projects/receivables?status=all&state=billed"))
    expect(billed.status).toBe(200)
    const billedRows = billed.body.receivables as Array<Record<string, unknown>>
    for (const r of billedRows) {
      expect(r.state).toBe("billed")
      expect(r.billedOn).not.toBeNull()
      expect(r.invoicedOn).toBeNull()
      expect(r.receivedOn).toBeNull()
    }

    const bad = await asAdmin(request(app).get("/projects/receivables?state=not_a_state"))
    expect(bad.status).toBe(400)
  })

  it("receivables：剛請款／剛開票（今天，還沒逾期）分別落在 billed／invoiced，不會被誤判成 overdue", async () => {
    // 專案共用夾具到這裡已經被前面很多 it 改動過，另開一個乾淨的小案子，
    // 才能保證「今天請款」「今天開票」不會被夾具裡的舊日期資料混到。
    const proj = await createProject({ name: "B5：billed／invoiced 非逾期驗證" })
    expect(proj.status).toBe(201)
    const projId = proj.body.id
    const c = await asAdmin(request(app).post(`/projects/${projId}/contracts`)).send({
      docType: "contract",
      title: "承攬契約",
      amount: 1_000_000,
      signedOn: `${YEAR}-01-15`,
    })
    expect(c.status).toBe(201)
    const sch = await asAdmin(request(app).put(`/projects/${projId}/billings`)).send({
      installments: [{ installmentNo: 1, percentage: 100, milestone: "全額" }],
    })
    expect(sch.status).toBe(200)
    const billingId = sch.body.installments[0].id as string

    // 還沒請款：unbilled。
    const beforeBill = await asAdmin(request(app).get(`/projects/receivables?status=all`))
    const rowUnbilled = (beforeBill.body.receivables as Array<Record<string, unknown>>).find((r) => r.billingId === billingId)!
    expect(rowUnbilled.state).toBe("unbilled")
    expect(rowUnbilled.overdueDays).toBeNull()

    // 今天請款（不帶 billedOn，伺服器補今天）：billed，不是 overdue。
    const bill = await asAdmin(request(app).post(`/billings/${billingId}/bill`)).send({})
    expect(bill.status).toBe(200)
    const afterBill = await asAdmin(request(app).get(`/projects/receivables?status=all`))
    const rowBilled = (afterBill.body.receivables as Array<Record<string, unknown>>).find((r) => r.billingId === billingId)!
    expect(rowBilled.state).toBe("billed")
    expect(rowBilled.overdueDays).toBe(0)
    const billedFilter = await asAdmin(request(app).get(`/projects/receivables?status=all&state=billed`))
    expect((billedFilter.body.receivables as Array<Record<string, unknown>>).some((r) => r.billingId === billingId)).toBe(true)
    const overdueFilter = await asAdmin(request(app).get(`/projects/receivables?status=all&state=overdue`))
    expect((overdueFilter.body.receivables as Array<Record<string, unknown>>).some((r) => r.billingId === billingId)).toBe(false)

    // 今天開票：invoiced，一樣不是 overdue。
    const inv = await asAdmin(request(app).post(`/billings/${billingId}/invoice`)).send({ invoiceNo: "B5-TEST-0001" })
    expect(inv.status).toBe(200)
    const afterInvoice = await asAdmin(request(app).get(`/projects/receivables?status=all`))
    const rowInvoiced = (afterInvoice.body.receivables as Array<Record<string, unknown>>).find((r) => r.billingId === billingId)!
    expect(rowInvoiced.state).toBe("invoiced")
    expect(rowInvoiced.overdueDays).toBe(0)
    const invoicedFilter = await asAdmin(request(app).get(`/projects/receivables?status=all&state=invoiced`))
    expect((invoicedFilter.body.receivables as Array<Record<string, unknown>>).some((r) => r.billingId === billingId)).toBe(true)
  })

  it("/application：申請單資料（民國日期、最新文件、期程、副委託、money）", async () => {
    const res = await asAdmin(request(app).get(`/projects/${mainProjectId}/application`))
    expect(res.status).toBe(200)
    const a = res.body.application
    expect(a.code).toBe(`AT-${ROC}-001`)
    expect(a.dateRoc).toMatch(/^\d{3}\.\d{1,2}\.\d{1,2}$/)
    // mainProjectId 建立時沒帶 openedOn，A5 預設值＝建立當天（租戶今天）。
    expect(a.openedOn).toBe(taipeiToday())
    expect(a.latestDocument.docType).toBe("contract")
    expect(a.latestDocument.signedOn).toBe(`${YEAR}-01-15`)
    expect(a.billings).toHaveLength(4)
    expect(a.subcontracts).toHaveLength(2)
    expect(a.money.amountTotal).toBe(3_195_827)
    expect(res.body.access.finance).toBe(true)

    const emp = await asEmployee(request(app).get(`/projects/${mainProjectId}/application`))
    expect(emp.status).toBe(200)
    expect(emp.body.application.money).toBeNull()
    expect(emp.body.application.billings).toEqual([])
    expect(emp.body.application.latestDocument).toBeNull()
  })
})

describe("P3-1 編號格式可設定", () => {
  it("改成 XY／西元／4 位 → 新案 XY-{西元}-0001；既有編號不動", async () => {
    const put = await asAdmin(request(app).put("/project-settings")).send({ codePrefix: "XY", codeYearStyle: "ad", codeSeqDigits: 4 })
    expect(put.status).toBe(200)
    expect(put.body.settings.codePrefix).toBe("XY")
    expect(put.body.settings.codeYearStyle).toBe("ad")
    expect(put.body.settings.vatRate).toBe(0.05)

    const res = await createProject({ name: "新格式的案子" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`XY-${YEAR}-0001`)

    const old = await asAdmin(request(app).get(`/projects/${mainProjectId}`))
    expect(old.body.project.code).toBe(`AT-${ROC}-001`)

    // 改回來；流水號從既有 AT 編號接著算，不會重複。
    // 011（不是 010）：B5 的 receivables 測試在這之前多開了一個 AT 案子驗證
    // billed／invoiced 非逾期的狀態，流水號跟著往後推一個。
    await asAdmin(request(app).put("/project-settings")).send({ codePrefix: "AT", codeYearStyle: "roc", codeSeqDigits: 3 })
    const back = await createProject({ name: "改回舊格式的案子" })
    expect(back.body.code).toBe(`AT-${ROC}-012`)
  })
})

// 這個 describe 刻意放在檔案最後——它另外 createProject 兩次，若插在中段會
// 讓後面依賴精確流水號（如上面「改回舊格式的案子」的 011）的斷言全部位移。
describe("A5 開案日期", () => {
  it("POST 不帶 openedOn → 預設租戶今天", async () => {
    const res = await createProject({ name: "開案日期預設今天" })
    expect(res.status).toBe(201)
    const got = await asAdmin(request(app).get(`/projects/${res.body.id}`))
    expect(got.body.project.openedOn).toBe(taipeiToday())
  })

  it("PATCH 改 2024-03-01 → GET 回同值；年度總表該列日期＝2024-03-01；申請單抬頭也跟著走", async () => {
    const created = await createProject({ name: "補登開案日期案", fiscalYear: YEAR })
    expect(created.status).toBe(201)
    const id = created.body.id as string

    const patched = await asAdmin(request(app).patch(`/projects/${id}`)).send({ openedOn: "2024-03-01" })
    expect(patched.status).toBe(200)
    const got = await asAdmin(request(app).get(`/projects/${id}`))
    expect(got.body.project.openedOn).toBe("2024-03-01")

    const annual = await asAdmin(request(app).get(`/projects/annual?year=${ROC}`))
    const row = (annual.body.rows as Array<Record<string, unknown>>).find((r) => r.projectId === id)!
    expect(row).toBeDefined()
    expect(row.createdOn).toBe("2024-03-01")
    expect(row.dateRoc).toBe("113.3.1")

    const application = await asAdmin(request(app).get(`/projects/${id}/application`))
    expect(application.body.application.openedOn).toBe("2024-03-01")
  })
})

// ─── B 批次驗收修正（fresh-context 驗收抓到的問題 1／2／6）─────────────────
// 一樣放在檔案最後：會另外 createProject，插在中段會位移前面依賴精確流水號的斷言。
describe("B 批次驗收修正：改角色重算期程／部分入帳可逾期／缺簽訂日排除不用貼", () => {
  it("問題 1：PATCH 合約 ourRole client→both，期程的 calculated_amount 跟著重算（分母從 null 變合約額）；改回 client 再清掉", async () => {
    const proj = await createProject({ name: "B 批次：改角色重算期程" })
    expect(proj.status).toBe(201)
    const projId = proj.body.id as string

    // 先標成「我方定作」（下包合約）：不算我方營收，分母 null、各期試算 null。
    const c = await asAdmin(request(app).post(`/projects/${projId}/contracts`)).send({
      docType: "contract",
      ourRole: "client",
      title: "先標成下包合約",
      amount: 2_000_000,
      signedOn: `${YEAR}-02-01`,
    })
    expect(c.status).toBe(201)
    const contractId = c.body.contract.id as string
    const sch = await asAdmin(request(app).put(`/projects/${projId}/billings`)).send({
      installments: [
        { installmentNo: 1, percentage: 60, milestone: "簽約款" },
        { installmentNo: 2, percentage: 40, milestone: "驗收款" },
      ],
    })
    expect(sch.status).toBe(200)
    expect(sch.body.contract.total).toBeNull()
    expect(sch.body.installments.map((i: { calculatedAmount: number | null }) => i.calculatedAmount)).toEqual([null, null])

    // 改成 both（印花稅各自貼，我方仍是承攬方）：分母變 2,000,000，存在 DB 的試算值要跟著變。
    const toBoth = await asAdmin(request(app).patch(`/contracts/${contractId}`)).send({ ourRole: "both" })
    expect(toBoth.status).toBe(200)
    expect(toBoth.body.contract.ourRole).toBe("both")
    const after = await asAdmin(request(app).get(`/projects/${projId}/billings`))
    expect(after.status).toBe(200)
    expect(after.body.contract.total).toBe(2_000_000)
    expect(after.body.installments.map((i: { calculatedAmount: number | null }) => i.calculatedAmount)).toEqual([1_200_000, 800_000])

    // 改回 client：分母回 null，不能留著 both 時算出的數字。
    const toClient = await asAdmin(request(app).patch(`/contracts/${contractId}`)).send({ ourRole: "client" })
    expect(toClient.status).toBe(200)
    const back = await asAdmin(request(app).get(`/projects/${projId}/billings`))
    expect(back.body.contract.total).toBeNull()
    expect(back.body.installments.map((i: { calculatedAmount: number | null }) => i.calculatedAmount)).toEqual([null, null])
  })

  it("問題 2：部分入帳（收 30 萬／應收 100 萬、一年前請款）仍在未收款清單、state=overdue；撤銷後收足才是 received 並離開 open 清單", async () => {
    const proj = await createProject({ name: "B 批次：部分入帳仍可逾期" })
    expect(proj.status).toBe(201)
    const projId = proj.body.id as string
    const c = await asAdmin(request(app).post(`/projects/${projId}/contracts`)).send({
      docType: "contract",
      title: "承攬契約",
      amount: 1_000_000,
      signedOn: `${YEAR - 1}-01-15`,
    })
    expect(c.status).toBe(201)
    const sch = await asAdmin(request(app).put(`/projects/${projId}/billings`)).send({
      installments: [{ installmentNo: 1, percentage: 100, milestone: "全額" }],
    })
    expect(sch.status).toBe(200)
    const billingId = sch.body.installments[0].id as string

    // 一年前的今天請款（2/29 退一天，免得去年沒這天）。
    const mmdd = taipeiToday().slice(5) === "02-29" ? "02-28" : taipeiToday().slice(5)
    const billedOn = `${YEAR - 1}-${mmdd}`
    expect((await asAdmin(request(app).post(`/billings/${billingId}/bill`)).send({ billedOn })).status).toBe(200)
    const partial = await asAdmin(request(app).post(`/billings/${billingId}/receive`)).send({ receivedOn: billedOn, receivedAmount: 300_000 })
    expect(partial.status).toBe(200)
    expect(partial.body.installments[0].receivedAmount).toBe(300_000)

    const open = await asAdmin(request(app).get("/projects/receivables"))
    expect(open.status).toBe(200)
    const row = (open.body.receivables as Array<Record<string, unknown>>).find((r) => r.billingId === billingId)!
    expect(row).toBeDefined() // 部分入帳仍是 open
    expect(row.receivedOn).toBe(billedOn)
    expect(row.receivedAmount).toBe(300_000)
    expect(row.unreceived).toBe(700_000)
    expect(row.overdueDays as number).toBeGreaterThanOrEqual(365)
    expect(row.state).toBe("overdue")
    const overdueOnly = await asAdmin(request(app).get("/projects/receivables?state=overdue"))
    expect((overdueOnly.body.receivables as Array<Record<string, unknown>>).some((r) => r.billingId === billingId)).toBe(true)
    const receivedOnly = await asAdmin(request(app).get("/projects/receivables?status=all&state=received"))
    expect((receivedOnly.body.receivables as Array<Record<string, unknown>>).some((r) => r.billingId === billingId)).toBe(false)

    // 撤銷後收足（省略 receivedAmount ＝ 該期有效金額）→ received、逾期 null、open 清單不含。
    expect((await asAdmin(request(app).post(`/billings/${billingId}/unreceive`)).send({ reason: "改為收足" })).status).toBe(200)
    const full = await asAdmin(request(app).post(`/billings/${billingId}/receive`)).send({ receivedOn: billedOn })
    expect(full.status).toBe(200)
    expect(full.body.installments[0].receivedAmount).toBe(1_000_000)
    const all = await asAdmin(request(app).get("/projects/receivables?status=all"))
    const rowAll = (all.body.receivables as Array<Record<string, unknown>>).find((r) => r.billingId === billingId)!
    expect(rowAll.state).toBe("received")
    expect(rowAll.overdueDays).toBeNull()
    expect(rowAll.unreceived).toBe(0)
    const openAgain = await asAdmin(request(app).get("/projects/receivables"))
    expect((openAgain.body.receivables as Array<Record<string, unknown>>).some((r) => r.billingId === billingId)).toBe(false)
  })

  it("問題 6：印花稅報表的 missingSignedOn 不計 stamp_duty_required='no' 的合約；auto 的沒簽訂日才計", async () => {
    const proj = await createProject({ name: "B 批次：缺簽訂日排除不用貼" })
    expect(proj.status).toBe(201)
    const projId = proj.body.id as string
    const before = await asAdmin(request(app).get("/reports/stamp-duty"))
    expect(before.status).toBe(200)
    const base = before.body.summary.missingSignedOn as number

    const no = await asAdmin(request(app).post(`/projects/${projId}/contracts`)).send({
      docType: "contract",
      title: "免稅憑證（不用貼）",
      amount: 500_000,
      stampDutyRequired: "no",
    })
    expect(no.status).toBe(201)
    expect(no.body.contract.dutiable).toBe(false)
    const afterNo = await asAdmin(request(app).get("/reports/stamp-duty"))
    expect(afterNo.body.summary.missingSignedOn).toBe(base)

    const auto = await asAdmin(request(app).post(`/projects/${projId}/contracts`)).send({
      docType: "contract",
      title: "還沒補簽訂日",
      amount: 500_000,
    })
    expect(auto.status).toBe(201)
    expect(auto.body.contract.dutiable).toBe(true)
    const afterAuto = await asAdmin(request(app).get("/reports/stamp-duty"))
    expect(afterAuto.body.summary.missingSignedOn).toBe(base + 1)

    // 把 auto 那張改成 no → 又從這格消失；改回 auto → 回來。
    const flip = await asAdmin(request(app).patch(`/contracts/${auto.body.contract.id}`)).send({ stampDutyRequired: "no" })
    expect(flip.status).toBe(200)
    expect((await asAdmin(request(app).get("/reports/stamp-duty"))).body.summary.missingSignedOn).toBe(base)
    const flipBack = await asAdmin(request(app).patch(`/contracts/${auto.body.contract.id}`)).send({ stampDutyRequired: "auto" })
    expect(flipBack.status).toBe(200)
    expect((await asAdmin(request(app).get("/reports/stamp-duty"))).body.summary.missingSignedOn).toBe(base + 1)
  })
})
