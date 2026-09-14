import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import ExcelJS from "exceljs"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { app } from "../app"

/**
 * 放款專區（匯款紀錄 × 專案連動）— live 合約測試（仿 projects-application-live.test.ts）。
 *
 * 流程：vendor＋companies＋兩案（A 下包 3 期、B 技師 1 期）→ POST paid 分攤 A#1+A#2
 * → 期款 paid 同步、專案頁顯示單號、lead 收到通知 → 再對同期款 POST → 409
 * → 舊 PUT 改放款日 → 409 linked_to_disbursement → B 手動標記後 POST → 409 manual
 * → draft→pay→void 清回、note 附理由、payables 重新出現 → 作廢後同期款可再付
 * → 附件 5 檔上限、第 6 檔 409、>5MB 413 → 列表／summary／export.xlsx。
 *
 * 正式庫尚未套 0041（disbursements 三張表不存在）時整組 describe.skipIf 跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function disbursementsMigrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("disbursements").select("id").limit(1)
  return !error
}
const migrated = await disbursementsMigrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let adminEmpId: string
let employeeToken: string

const YEAR = Number(taipeiToday().slice(0, 4))
const ROC = YEAR - 1911
const TODAY = taipeiToday()
/** 一年多前，超出一般列表的近 90 天預設窗，用來驗補單模式不設下限。 */
const OLD_PAID_ON = `${YEAR - 1}-03-10`

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

/* ── 共用狀態 ─────────────────────────────────────────────────────── */
let vendorId: string
let payerId: string // 亞斯特（預設付款公司）
let issuerId: string // 龍權（收據抬頭）
let projectAId: string
let projectBId: string
let subAId: string
let subBId: string
let payA: Array<{ id: string; installmentNo: number; effectiveAmount: number; withheldAmount: number; netAmount: number }>
let payB1Id: string

describe.skipIf(!migrated)("放款專區 — live", () => {
  beforeAll(async () => {
    const name = `DISBTEST ${stamp}`
    const adminEmail = `disb-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
    tenantId = provisioned.tenantId
    createdTenantIds.push(provisioned.tenantId)
    createdUserIds.push(provisioned.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("user_id", provisioned.userId).single()
    adminEmpId = hr!.id as string

    const empEmail = `disb-${stamp}-emp@example.com`
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

    // 我方主體兩家：付款公司 vs 收據抬頭可以不同家。
    const companies = await asAdmin(request(app).put("/companies")).send({
      companies: [
        { name: "亞斯特設計顧問有限公司", isDefault: true, bankName: "台灣銀行", bankAccount: "004-111-222" },
        { name: "龍權工程有限公司" },
      ],
    })
    expect(companies.status).toBe(200)
    payerId = companies.body.companies.find((c: { isDefault: boolean }) => c.isDefault).id
    issuerId = companies.body.companies.find((c: { isDefault: boolean }) => !c.isDefault).id

    // 廠商含收款帳戶（0041 新欄）。
    const vendor = await asAdmin(request(app).post("/vendors")).send({
      name: "大同電機工程行",
      category: "電機",
      bankName: "國泰世華",
      bankCode: "013",
      bankAccount: "013-9999-8888",
      accountHolder: "大同電機工程行",
    })
    expect(vendor.status).toBe(201)
    expect(vendor.body.vendor.bankAccount).toBe("013-9999-8888")
    vendorId = vendor.body.vendor.id

    // 專案 A（lead＝HR 本人，才有通知可收）：下包 1,200,000 分 40/30/30。
    const a = await asAdmin(request(app).post("/projects")).send({ name: "廣修三期機電", leadEmpId: adminEmpId })
    expect(a.status).toBe(201)
    projectAId = a.body.id
    const b = await asAdmin(request(app).post("/projects")).send({ name: "惠特總部", leadEmpId: adminEmpId })
    expect(b.status).toBe(201)
    projectBId = b.body.id

    const subsA = await asAdmin(request(app).put(`/projects/${projectAId}/subcontracts`)).send({
      subcontracts: [{ kind: "subcontract", discipline: "電機", vendorId, item: "高低壓配電", amount: 1_200_000 }],
    })
    expect(subsA.status).toBe(200)
    subAId = subsA.body.subcontracts[0].id
    const paysA = await asAdmin(request(app).put(`/projects/${projectAId}/subcontracts/${subAId}/payments`)).send({
      payments: [
        { installmentNo: 1, percentage: 40, dueWhen: "簽約後" },
        { installmentNo: 2, percentage: 30, dueWhen: "送審後" },
        { installmentNo: 3, percentage: 30, dueWhen: "驗收後" },
      ],
    })
    expect(paysA.status).toBe(200)
    payA = paysA.body.subcontract.payments
    expect(payA.map((p) => p.effectiveAmount)).toEqual([480_000, 360_000, 360_000])
    expect(payA.map((p) => p.withheldAmount)).toEqual([48_000, 36_000, 36_000])

    // 專案 B：技師費 25,000 一期（同一廠商，方便 payables 分組）。
    const subsB = await asAdmin(request(app).put(`/projects/${projectBId}/subcontracts`)).send({
      subcontracts: [{ kind: "technician", discipline: "電機", vendorId, item: "電機技師簽證", amount: 25_000 }],
    })
    expect(subsB.status).toBe(200)
    subBId = subsB.body.subcontracts[0].id
    const paysB = await asAdmin(request(app).put(`/projects/${projectBId}/subcontracts/${subBId}/payments`)).send({
      payments: [{ installmentNo: 1, percentage: 100 }],
    })
    expect(paysB.status).toBe(200)
    payB1Id = paysB.body.subcontract.payments[0].id

    // 專案 A 合約 3,000,000、一期 100% 已請款並收到 900,000 → 收款進度 30%。
    const contract = await asAdmin(request(app).post(`/projects/${projectAId}/contracts`)).send({
      docType: "contract",
      title: "承攬契約",
      amount: 3_000_000,
      signedOn: `${YEAR}-01-15`,
    })
    expect(contract.status).toBe(201)
    const billing = await asAdmin(request(app).put(`/projects/${projectAId}/billings`)).send({
      installments: [{ installmentNo: 1, percentage: 100, milestone: "一次請款" }],
    })
    expect(billing.status).toBe(200)
    const billingId = billing.body.installments[0].id
    expect((await asAdmin(request(app).post(`/billings/${billingId}/bill`)).send({ billedOn: `${YEAR}-02-01` })).status).toBe(200)
    expect(
      (await asAdmin(request(app).post(`/billings/${billingId}/receive`)).send({ receivedOn: `${YEAR}-03-01`, receivedAmount: 900_000 })).status,
    ).toBe(200)
  }, 90_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      const { data: atts } = await supabaseAdmin.from("disbursement_attachments").select("storage_path").eq("tenant_id", tid)
      const paths = (atts ?? []).map((r) => r.storage_path as string)
      if (paths.length > 0) await supabaseAdmin.storage.from("disbursement-vouchers").remove(paths)
      await supabaseAdmin.from("disbursement_attachments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_subcontract_payments").update({ disbursement_id: null }).eq("tenant_id", tid)
      await supabaseAdmin.from("disbursement_allocations").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("disbursements").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_subcontract_payments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_subcontracts").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_members").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_billings").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("contracts").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("project_settings").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("projects").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("companies").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("vendors").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  let firstId: string
  let firstNo: string

  function subcontractsOf(projectId: string) {
    return asAdmin(request(app).get(`/projects/${projectId}/subcontracts`))
  }

  describe("應付清單", () => {
    it("4 個未付期款；毛額／代扣／淨額、應付時機、專案收款進度；按廠商分組", async () => {
      const res = await asAdmin(request(app).get("/disbursements/payables"))
      expect(res.status).toBe(200)
      const rows = res.body.payables as Array<Record<string, unknown>>
      expect(rows).toHaveLength(4)
      const a1 = rows.find((r) => r.subcontractPaymentId === payA[0].id)!
      expect(a1.grossAmount).toBe(480_000)
      expect(a1.withheldAmount).toBe(48_000)
      expect(a1.netAmount).toBe(432_000)
      expect(a1.dueWhen).toBe("簽約後")
      expect(a1.projectReceiptProgressPct).toBe(30)
      expect(a1.vendorName).toBe("大同電機工程行")
      expect(a1.projectCode).toMatch(/^AT-\d{3}-\d{3}$/)
      const b1 = rows.find((r) => r.subcontractPaymentId === payB1Id)!
      expect(b1.grossAmount).toBe(25_000)
      expect(b1.withheldAmount).toBe(2_500)
      expect(b1.netAmount).toBe(22_500)
      expect(b1.projectReceiptProgressPct).toBeNull()
      expect(res.body.groups).toHaveLength(1)
      expect(res.body.groups[0].vendorId).toBe(vendorId)
      expect(res.body.groups[0].count).toBe(4)
      expect(res.body.groups[0].netTotal).toBe(432_000 + 324_000 + 324_000 + 22_500)
      expect(res.body.summary.netTotal).toBe(1_102_500)
    })

    it("?projectId= 只列該案；非 HR → 403", async () => {
      const res = await asAdmin(request(app).get(`/disbursements/payables?projectId=${projectBId}`))
      expect(res.body.payables).toHaveLength(1)
      expect((await asEmployee(request(app).get("/disbursements/payables"))).status).toBe(403)
    })
  })

  describe("建立 paid 匯款分攤到兩期 → 期款連動", () => {
    it("分攤合計 ≠ 毛額 → 400 allocation_mismatch", async () => {
      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId,
        payingCompanyId: payerId,
        method: "transfer",
        paidOn: TODAY,
        amount: 756_000,
        withheldAmount: 84_000,
        status: "paid",
        allocations: [
          { projectId: projectAId, subcontractPaymentId: payA[0].id, amount: 480_000, withheldAmount: 48_000 },
          { projectId: projectAId, subcontractPaymentId: payA[1].id, amount: 360_001, withheldAmount: 36_000 },
        ],
      })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("allocation_mismatch")
      expect(res.body.expected).toBe(840_000)
      expect(res.body.actual).toBe(840_001)
    })

    it("不存在的廠商／公司／專案 → 400；paid 沒放款日 → 400 paid_on_required", async () => {
      const base = { payeeKind: "vendor", vendorId, payingCompanyId: payerId, method: "transfer", amount: 1, allocations: [] }
      const zero = "00000000-0000-0000-0000-000000000000"
      let res = await asAdmin(request(app).post("/disbursements")).send({ ...base, vendorId: zero })
      expect([res.status, res.body.error]).toEqual([400, "invalid_vendor"])
      res = await asAdmin(request(app).post("/disbursements")).send({ ...base, payingCompanyId: zero })
      expect([res.status, res.body.error]).toEqual([400, "invalid_company"])
      res = await asAdmin(request(app).post("/disbursements")).send({ ...base, allocations: [{ projectId: zero, amount: 1 }] })
      expect([res.status, res.body.error]).toEqual([400, "invalid_project"])
      res = await asAdmin(request(app).post("/disbursements")).send({
        ...base,
        status: "paid",
        allocations: [{ projectId: projectAId, subcontractPaymentId: payA[0].id, amount: 1 }],
      })
      expect([res.status, res.body.error]).toEqual([400, "paid_on_required"])
    })

    it("201：單號 D-{民國年}-001、快照從 vendors／companies 複製、期款 paid 同步、專案頁顯示單號", async () => {
      const before = await supabaseAdmin
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("employee_id", adminEmpId)
        .eq("type", "disbursement")
      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId,
        payingCompanyId: payerId,
        receiptIssuerCompanyId: issuerId,
        receiptRef: "收據 0001",
        method: "transfer",
        paidOn: TODAY,
        amount: 756_000,
        withheldAmount: 84_000,
        purpose: "廣修三期第 1、2 期",
        status: "paid",
        allocations: [
          { projectId: projectAId, subcontractPaymentId: payA[0].id, amount: 480_000, withheldAmount: 48_000 },
          { projectId: projectAId, subcontractPaymentId: payA[1].id, amount: 360_000, withheldAmount: 36_000 },
        ],
      })
      expect(res.status).toBe(201)
      const d = res.body.disbursement
      firstId = d.id
      firstNo = d.disbursementNo
      expect(d.disbursementNo).toBe(`D-${ROC}-001`)
      expect(d.status).toBe("paid")
      expect(d.grossAmount).toBe(840_000)
      expect(d.payeeName).toBe("大同電機工程行")
      expect(d.payeeBankName).toBe("國泰世華（013）")
      expect(d.payeeBankAccount).toBe("013-9999-8888 大同電機工程行")
      expect(d.payingCompanyName).toBe("亞斯特設計顧問有限公司")
      expect(d.payingBankAccount).toBe("台灣銀行 004-111-222")
      expect(d.receiptIssuerCompanyName).toBe("龍權工程有限公司")
      expect(d.paidByEmpId).toBe(adminEmpId)
      expect(d.allocations).toHaveLength(2)
      expect(d.allocations[0].installmentNo).toBe(1)
      expect(d.allocations[0].netAmount).toBe(432_000)
      expect(d.allocations[0].projectCode).toMatch(/^AT-/)
      expect(d.allocationLabel).toMatch(/^AT-\d{3}-\d{3} 第1,2期$/)
      expect(d.attachments).toEqual([])

      const subs = await subcontractsOf(projectAId)
      const payments = subs.body.subcontracts[0].payments
      expect(payments[0].paidOn).toBe(TODAY)
      expect(payments[0].paidAmount).toBe(432_000)
      expect(payments[0].withheldAmount).toBe(48_000)
      expect(payments[0].payingCompanyId).toBe(payerId)
      expect(payments[0].receiptIssuerCompanyId).toBe(issuerId)
      expect(payments[0].receiptRef).toBe("收據 0001")
      expect(payments[0].disbursementId).toBe(firstId)
      expect(payments[0].disbursementNo).toBe(firstNo)
      expect(payments[1].paidAmount).toBe(324_000)
      expect(payments[1].disbursementNo).toBe(firstNo)
      expect(payments[2].paidOn).toBeNull()
      expect(payments[2].disbursementId).toBeNull()
      expect(subs.body.summary.paidTotal).toBe(756_000)
      expect(subs.body.summary.withheldTotal).toBe(120_000)

      // lead 的通知多一筆
      const after = await supabaseAdmin
        .from("notifications")
        .select("id, title, body, payload", { count: "exact" })
        .eq("tenant_id", tenantId)
        .eq("employee_id", adminEmpId)
        .eq("type", "disbursement")
      expect((after.count ?? 0) - (before.count ?? 0)).toBe(1)
      expect(after.data![0].title).toBe("已放款 大同電機工程行 756,000")
      expect((after.data![0].payload as { disbursementNo: string }).disbursementNo).toBe(firstNo)
    })

    it("同期款再開一筆 → 409 payment_already_paid（附另一張單號）", async () => {
      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId,
        payingCompanyId: payerId,
        method: "transfer",
        paidOn: TODAY,
        amount: 432_000,
        withheldAmount: 48_000,
        status: "paid",
        allocations: [{ projectId: projectAId, subcontractPaymentId: payA[0].id, amount: 480_000, withheldAmount: 48_000 }],
      })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("payment_already_paid")
      expect(res.body.disbursementNo).toBe(firstNo)
      expect(res.body.manual).toBe(false)
      expect(res.body.installmentNo).toBe(1)
    })

    it("舊 PUT：連動的期款改放款日／撤銷 → 409 linked_to_disbursement；只改備註放行", async () => {
      const put = (payments: unknown[], extra: Record<string, unknown> = {}) =>
        asAdmin(request(app).put(`/projects/${projectAId}/subcontracts/${subAId}/payments`)).send({ payments, ...extra })
      const rows = (await subcontractsOf(projectAId)).body.subcontracts[0].payments as Array<Record<string, unknown>>
      const base = rows.map((p) => ({
        id: p.id,
        installmentNo: p.installmentNo,
        percentage: p.percentage,
        dueWhen: p.dueWhen,
        paidOn: p.paidOn,
        payingCompanyId: p.payingCompanyId,
        receiptIssuerCompanyId: p.receiptIssuerCompanyId,
        receiptRef: p.receiptRef,
        note: p.note,
      }))
      const changed = await put([{ ...base[0], paidOn: `${YEAR}-01-01` }, base[1], base[2]])
      expect(changed.status).toBe(409)
      expect(changed.body.error).toBe("linked_to_disbursement")
      expect(changed.body.disbursementNo).toBe(firstNo)

      const unpay = await put([{ ...base[0], paidOn: null }, base[1], base[2]], { reason: "想撤銷" })
      expect(unpay.status).toBe(409)
      expect(unpay.body.error).toBe("linked_to_disbursement")

      const noteOnly = await put([{ ...base[0], note: "只改備註" }, base[1], base[2]])
      expect(noteOnly.status).toBe(200)
      expect(noteOnly.body.subcontract.payments[0].note).toBe("只改備註")
      expect(noteOnly.body.subcontract.payments[0].paidAmount).toBe(432_000)
      expect(noteOnly.body.subcontract.payments[0].disbursementNo).toBe(firstNo)
    })

    it("payables 不再含已付的 A#1、A#2", async () => {
      const res = await asAdmin(request(app).get("/disbursements/payables"))
      const ids = res.body.payables.map((r: { subcontractPaymentId: string }) => r.subcontractPaymentId)
      expect(ids).not.toContain(payA[0].id)
      expect(ids).not.toContain(payA[1].id)
      expect(ids).toContain(payA[2].id)
      expect(ids).toContain(payB1Id)
    })
  })

  describe("舊路徑手動標記 vs 放款專區", () => {
    it("B#1 舊 PUT 標 paid（無匯款單）→ POST 分攤 B#1 → 409 manual:true；manualPaid=1 列得到", async () => {
      // 故意標在 90 天以前：補單模式的重點就是挖舊期款，不能被一般列表的近 90 天預設濾掉
      const manual = await asAdmin(request(app).put(`/projects/${projectBId}/subcontracts/${subBId}/payments`)).send({
        payments: [{ id: payB1Id, installmentNo: 1, percentage: 100, paidOn: OLD_PAID_ON }],
      })
      expect(manual.status).toBe(200)
      expect(manual.body.subcontract.payments[0].paidAmount).toBe(22_500)
      expect(manual.body.subcontract.payments[0].disbursementId).toBeNull()

      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId,
        payingCompanyId: payerId,
        method: "cash",
        paidOn: TODAY,
        amount: 22_500,
        withheldAmount: 2_500,
        status: "paid",
        allocations: [{ projectId: projectBId, subcontractPaymentId: payB1Id, amount: 25_000, withheldAmount: 2_500 }],
      })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("payment_already_paid")
      expect(res.body.manual).toBe(true)
      expect(res.body.disbursementId).toBeNull()

      const list = await asAdmin(request(app).get("/disbursements?manualPaid=1"))
      expect(list.status).toBe(200)
      expect(list.body.mode).toBe("manualPaid")
      expect(list.body.from).toBe("1900-01-01") // 不帶 from 就是全部，不是近 90 天
      const item = list.body.items.find((i: { subcontractPaymentId: string }) => i.subcontractPaymentId === payB1Id)
      expect(item).toBeDefined()
      expect(item.paidOn).toBe(OLD_PAID_ON)
      expect(item.paidAmount).toBe(22_500)
      expect(item.projectName).toBe("惠特總部")
      // 連動付清的 A#1 不在「無匯款單」清單裡
      expect(list.body.items.map((i: { subcontractPaymentId: string }) => i.subcontractPaymentId)).not.toContain(payA[0].id)

      // 明確給 from 才收窄：從今天起算就不該再看到那筆舊期款
      const narrowed = await asAdmin(request(app).get(`/disbursements?manualPaid=1&from=${TODAY}`))
      expect(narrowed.status).toBe(200)
      expect(narrowed.body.from).toBe(TODAY)
      expect(narrowed.body.items.map((i: { subcontractPaymentId: string }) => i.subcontractPaymentId)).not.toContain(payB1Id)
    })
  })

  describe("draft → PATCH → pay → void", () => {
    let draftId: string

    it("草稿不動期款；PATCH 可改金額與分攤；paid_on 缺 → pay 400", async () => {
      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId,
        payingCompanyId: payerId,
        method: "transfer",
        amount: 300_000,
        withheldAmount: 36_000,
        status: "draft",
        allocations: [{ projectId: projectAId, subcontractPaymentId: payA[2].id, amount: 336_000, withheldAmount: 36_000 }],
      })
      expect(res.status).toBe(201)
      draftId = res.body.disbursement.id
      expect(res.body.disbursement.status).toBe("draft")
      expect(res.body.disbursement.disbursementNo).toBe(`D-${ROC}-002`)
      const subs = await subcontractsOf(projectAId)
      expect(subs.body.subcontracts[0].payments[2].paidOn).toBeNull()

      // 老闆決定照期款全額付：324,000 淨 / 36,000 代扣（整批覆蓋分攤）。
      const patched = await asAdmin(request(app).patch(`/disbursements/${draftId}`)).send({
        amount: 324_000,
        note: "改成全額",
        allocations: [{ projectId: projectAId, subcontractPaymentId: payA[2].id, amount: 360_000, withheldAmount: 36_000 }],
      })
      expect(patched.status).toBe(200)
      expect(patched.body.disbursement.amount).toBe(324_000)
      expect(patched.body.disbursement.grossAmount).toBe(360_000)
      expect(patched.body.disbursement.allocations).toHaveLength(1)
      expect(patched.body.disbursement.allocations[0].amount).toBe(360_000)

      const bad = await asAdmin(request(app).patch(`/disbursements/${draftId}`)).send({ amount: 1 })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("allocation_mismatch")

      const noDate = await asAdmin(request(app).post(`/disbursements/${draftId}/pay`)).send({})
      expect(noDate.status).toBe(400)
      expect(noDate.body.error).toBe("paid_on_required")
    })

    it("pay → 期款 A#3 paid；paid 之後只准改 note/receiptRef/purpose", async () => {
      const paid = await asAdmin(request(app).post(`/disbursements/${draftId}/pay`)).send({ paidOn: TODAY })
      expect(paid.status).toBe(200)
      expect(paid.body.disbursement.status).toBe("paid")
      expect(paid.body.disbursement.paidOn).toBe(TODAY)
      const subs = await subcontractsOf(projectAId)
      expect(subs.body.subcontracts[0].payments[2].paidAmount).toBe(324_000)
      expect(subs.body.subcontracts[0].payments[2].disbursementId).toBe(draftId)
      expect(subs.body.summary.paidTotal).toBe(756_000 + 324_000)

      const again = await asAdmin(request(app).post(`/disbursements/${draftId}/pay`)).send({ paidOn: TODAY })
      expect(again.status).toBe(409)
      expect(again.body.error).toBe("already_paid")

      const locked = await asAdmin(request(app).patch(`/disbursements/${draftId}`)).send({ amount: 1 })
      expect(locked.status).toBe(409)
      expect(locked.body.error).toBe("paid")
      expect(locked.body.field).toBe("amount")

      const ok = await asAdmin(request(app).patch(`/disbursements/${draftId}`)).send({ amount: 324_000, receiptRef: "收據 0002", purpose: "第 3 期" })
      expect(ok.status).toBe(200)
      expect(ok.body.disbursement.receiptRef).toBe("收據 0002")
      // 收據編號跟著寫回期款
      const subs2 = await subcontractsOf(projectAId)
      expect(subs2.body.subcontracts[0].payments[2].receiptRef).toBe("收據 0002")
    })

    it("void → 期款清回未付、note 附理由、payables 重新出現；作廢後不能再改", async () => {
      const noReason = await asAdmin(request(app).post(`/disbursements/${draftId}/void`)).send({})
      expect(noReason.status).toBe(400)
      const voided = await asAdmin(request(app).post(`/disbursements/${draftId}/void`)).send({ reason: "匯錯帳戶" })
      expect(voided.status).toBe(200)
      expect(voided.body.disbursement.status).toBe("void")
      expect(voided.body.disbursement.voidReason).toBe("匯錯帳戶")

      const subs = await subcontractsOf(projectAId)
      const p3 = subs.body.subcontracts[0].payments[2]
      expect(p3.paidOn).toBeNull()
      expect(p3.paidAmount).toBeNull()
      expect(p3.disbursementId).toBeNull()
      expect(p3.receiptRef).toBeNull()
      expect(p3.note).toContain(`作廢匯款 D-${ROC}-002：匯錯帳戶`)
      // 未付期別的代扣回到試算值
      expect(p3.withheldAmount).toBe(36_000)
      expect(subs.body.summary.paidTotal).toBe(756_000)

      const payables = await asAdmin(request(app).get("/disbursements/payables"))
      expect(payables.body.payables.map((r: { subcontractPaymentId: string }) => r.subcontractPaymentId)).toContain(payA[2].id)

      expect((await asAdmin(request(app).patch(`/disbursements/${draftId}`)).send({ note: "x" })).body.error).toBe("void")
      expect((await asAdmin(request(app).post(`/disbursements/${draftId}/pay`)).send({ paidOn: TODAY })).body.error).toBe("void")
      expect((await asAdmin(request(app).post(`/disbursements/${draftId}/void`)).send({ reason: "再作廢" })).status).toBe(409)
    })

    it("作廢第一張 → A#1/A#2 清回 → 同期款可被新匯款付", async () => {
      const voided = await asAdmin(request(app).post(`/disbursements/${firstId}/void`)).send({ reason: "重開" })
      expect(voided.status).toBe(200)
      const subs = await subcontractsOf(projectAId)
      expect(subs.body.subcontracts[0].payments[0].paidOn).toBeNull()
      expect(subs.body.subcontracts[0].payments[1].paidOn).toBeNull()
      expect(subs.body.summary.paidTotal).toBe(0)

      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId,
        payingCompanyId: payerId,
        method: "transfer",
        paidOn: TODAY,
        amount: 432_000,
        withheldAmount: 48_000,
        status: "paid",
        allocations: [{ projectId: projectAId, subcontractPaymentId: payA[0].id, amount: 480_000, withheldAmount: 48_000 }],
      })
      expect(res.status).toBe(201)
      expect(res.body.disbursement.disbursementNo).toBe(`D-${ROC}-003`)
      const subs2 = await subcontractsOf(projectAId)
      expect(subs2.body.subcontracts[0].payments[0].disbursementNo).toBe(`D-${ROC}-003`)
      firstId = res.body.disbursement.id
    })
  })

  describe("其他收款方、列表、老闆卡、匯出", () => {
    it("payeeKind=other 零分攤 → 201（印刷費）", async () => {
      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "other",
        payeeName: "某某印刷行",
        payingCompanyId: payerId,
        method: "cash",
        paidOn: TODAY,
        amount: 5_000,
        purpose: "圖說印刷",
        status: "paid",
        allocations: [],
      })
      expect(res.status).toBe(201)
      expect(res.body.disbursement.payeeName).toBe("某某印刷行")
      expect(res.body.disbursement.vendorId).toBeNull()
      expect(res.body.disbursement.allocations).toEqual([])

      const noName = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "other",
        payingCompanyId: payerId,
        method: "cash",
        amount: 1,
        allocations: [],
      })
      expect(noName.status).toBe(400)
      expect(noName.body.error).toBe("payee_name_required")
    })

    it("列表：預設排除作廢；status=void 只列作廢；?q= 搜單號；?projectId= 用分攤篩", async () => {
      const list = await asAdmin(request(app).get("/disbursements"))
      expect(list.status).toBe(200)
      const nos = list.body.disbursements.map((d: { disbursementNo: string }) => d.disbursementNo)
      expect(nos).toContain(`D-${ROC}-003`)
      expect(nos).toContain(`D-${ROC}-004`)
      expect(nos).not.toContain(`D-${ROC}-001`)
      expect(nos).not.toContain(`D-${ROC}-002`)
      expect(list.body.totals.amount).toBe(437_000)

      const voids = await asAdmin(request(app).get("/disbursements?status=void"))
      expect(voids.body.disbursements.map((d: { disbursementNo: string }) => d.disbursementNo).sort()).toEqual([`D-${ROC}-001`, `D-${ROC}-002`])

      const q = await asAdmin(request(app).get(`/disbursements?q=${encodeURIComponent(`D-${ROC}-004`)}`))
      expect(q.body.disbursements).toHaveLength(1)
      expect(q.body.disbursements[0].payeeName).toBe("某某印刷行")

      const byProject = await asAdmin(request(app).get(`/disbursements?projectId=${projectAId}`))
      expect(byProject.body.disbursements.map((d: { disbursementNo: string }) => d.disbursementNo)).toEqual([`D-${ROC}-003`])
      const byB = await asAdmin(request(app).get(`/disbursements?projectId=${projectBId}`))
      expect(byB.body.disbursements).toEqual([])

      expect((await asAdmin(request(app).get("/disbursements?from=2026-13-01"))).status).toBe(400)
      expect((await asEmployee(request(app).get("/disbursements"))).status).toBe(403)
    })

    it("GET /:id 明細；不存在 404；非 uuid 不會吃掉 summary", async () => {
      const got = await asAdmin(request(app).get(`/disbursements/${firstId}`))
      expect(got.status).toBe(200)
      expect(got.body.disbursement.allocations[0].projectName).toBe("廣修三期機電")
      expect(got.body.disbursement.attachments).toEqual([])
      expect((await asAdmin(request(app).get("/disbursements/00000000-0000-0000-0000-000000000000"))).status).toBe(404)
      expect((await asAdmin(request(app).get("/disbursements/not-a-uuid"))).status).toBe(404)
    })

    it("summary：本月／本年／應付未付／代扣＝手算", async () => {
      const res = await asAdmin(request(app).get("/disbursements/summary"))
      expect(res.status).toBe(200)
      // 有效：D-003（432,000 淨／48,000 代扣）＋ D-004（5,000）；作廢的不算
      expect(res.body.monthTotal).toBe(437_000)
      expect(res.body.monthCount).toBe(2)
      expect(res.body.yearTotal).toBe(437_000)
      expect(res.body.yearWithheldTotal).toBe(48_000)
      expect(res.body.periodTotal).toBe(437_000)
      // 應付未付：A#2 324,000 ＋ A#3 324,000（B#1 手動標 paid、A#1 已付）
      expect(res.body.unpaidPayableTotal).toBe(648_000)
      expect(res.body.unpaidPayableCount).toBe(2)
      expect(res.body.byCompany).toEqual([{ key: payerId, label: "亞斯特設計顧問有限公司", total: 437_000, count: 2 }])
      expect(res.body.byVendorTop5[0]).toEqual({ key: vendorId, label: "大同電機工程行", total: 432_000, count: 1 })
      expect(res.body.byProjectTop5[0].total).toBe(432_000)
      expect(res.body.byProjectTop5[0].projectName).toBe("廣修三期機電")
    })

    it("export.xlsx：200、列數＝篩選結果", async () => {
      const res = await asAdmin(request(app).get("/disbursements/export.xlsx")).buffer(true).parse(binaryParser)
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("spreadsheetml")
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(new Uint8Array(res.body as Buffer) as unknown as ExcelJS.Buffer)
      const ws = wb.getWorksheet("放款紀錄")!
      const nos: string[] = []
      for (let r = 5; r <= ws.rowCount; r++) {
        const v = ws.getRow(r).getCell(1).value
        if (typeof v === "string" && /^D-\d{3}-\d{3}$/.test(v)) nos.push(v)
      }
      expect(nos.sort()).toEqual([`D-${ROC}-003`, `D-${ROC}-004`])
      expect(ws.getRow(4).getCell(1).value).toBe("單號")
    })
  })

  describe("附件（bucket disbursement-vouchers）", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

    it("5 檔上限、第 6 檔 409 max_files_reached、>5MB 413、列表有 signed URL、可刪", async () => {
      const upload = (name: string, data: Buffer) =>
        asAdmin(request(app).post(`/disbursements/${firstId}/attachments`)).send({
          fileName: name,
          contentType: "image/png",
          dataBase64: data.toString("base64"),
        })
      const ids: string[] = []
      for (let i = 1; i <= 5; i++) {
        const res = await upload(`voucher-${i}.png`, png)
        expect(res.status).toBe(201)
        ids.push(res.body.id)
      }
      const sixth = await upload("voucher-6.png", png)
      expect(sixth.status).toBe(409)
      expect(sixth.body.error).toBe("max_files_reached")

      const list = await asAdmin(request(app).get(`/disbursements/${firstId}/attachments`))
      expect(list.status).toBe(200)
      expect(list.body.attachments).toHaveLength(5)
      expect(list.body.attachments[0].url).toMatch(/^https?:\/\//)
      const got = await asAdmin(request(app).get(`/disbursements/${firstId}`))
      expect(got.body.disbursement.attachments).toHaveLength(5)

      const del = await asAdmin(request(app).delete(`/disbursements/${firstId}/attachments/${ids[0]}`))
      expect(del.status).toBe(200)
      expect((await asAdmin(request(app).get(`/disbursements/${firstId}/attachments`))).body.attachments).toHaveLength(4)

      const big = await upload("big.png", Buffer.alloc(5 * 1024 * 1024 + 1, 1))
      expect(big.status).toBe(413)
      expect(big.body.error).toBe("file_too_large")
    }, 60_000)
  })

  describe("B2：發票／收據勾選＋匯款資訊（payeeBankCode／hasInvoice／invoiceNo）", () => {
    let invoiceVendorId: string
    let b2Id: string
    let b2No: string

    beforeAll(async () => {
      const v = await asAdmin(request(app).post("/vendors")).send({
        name: `發票測試廠商 ${stamp}`,
        bankName: "合作金庫",
        bankCode: "012",
        bankAccount: "012-3456-7890",
        accountHolder: `發票測試廠商 ${stamp}`,
      })
      expect(v.status).toBe(201)
      invoiceVendorId = v.body.vendor.id
    })

    it("vendor 帶 bank_code=012、未給 payeeBankCode → POST 201 快照、GET 回 payeeBankCode='012'、hasInvoice=false", async () => {
      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId: invoiceVendorId,
        payingCompanyId: payerId,
        method: "transfer",
        paidOn: TODAY,
        amount: 0,
        withheldAmount: 0,
        status: "paid",
        allocations: [],
      })
      expect(res.status).toBe(201)
      b2Id = res.body.disbursement.id
      b2No = res.body.disbursement.disbursementNo
      expect(res.body.disbursement.payeeBankCode).toBe("012")
      expect(res.body.disbursement.hasInvoice).toBe(false)
      expect(res.body.disbursement.invoiceNo).toBeNull()

      const got = await asAdmin(request(app).get(`/disbursements/${b2Id}`))
      expect(got.status).toBe(200)
      expect(got.body.disbursement.payeeBankCode).toBe("012")
      expect(got.body.disbursement.hasInvoice).toBe(false)
    })

    it("POST 明確帶 payeeBankCode 會覆蓋廠商快照（沿用 payeeBankName／payeeBankAccount 的既有規則）", async () => {
      const res = await asAdmin(request(app).post("/disbursements")).send({
        payeeKind: "vendor",
        vendorId: invoiceVendorId,
        payeeBankCode: "999",
        payingCompanyId: payerId,
        method: "transfer",
        amount: 0,
        withheldAmount: 0,
        status: "draft",
        allocations: [],
      })
      expect(res.status).toBe(201)
      expect(res.body.disbursement.payeeBankCode).toBe("999")
    })

    it("PATCH paid 單 {hasInvoice:true, invoiceNo:'AB12345678'} → 200；改 amount 仍 409 paid", async () => {
      const patched = await asAdmin(request(app).patch(`/disbursements/${b2Id}`)).send({
        hasInvoice: true,
        invoiceNo: "AB12345678",
      })
      expect(patched.status).toBe(200)
      expect(patched.body.disbursement.hasInvoice).toBe(true)
      expect(patched.body.disbursement.invoiceNo).toBe("AB12345678")

      const blocked = await asAdmin(request(app).patch(`/disbursements/${b2Id}`)).send({ amount: 999 })
      expect(blocked.status).toBe(409)
      expect(blocked.body.error).toBe("paid")
      expect(blocked.body.field).toBe("amount")
    })

    it("export.xlsx 多兩欄：有發票／發票號碼（既有列數／合計斷言不受影響，見上一個 describe）", async () => {
      const res = await asAdmin(request(app).get("/disbursements/export.xlsx")).buffer(true).parse(binaryParser)
      expect(res.status).toBe(200)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(new Uint8Array(res.body as Buffer) as unknown as ExcelJS.Buffer)
      const ws = wb.getWorksheet("放款紀錄")!
      expect(ws.getRow(4).getCell(11).value).toBe("有發票")
      expect(ws.getRow(4).getCell(12).value).toBe("發票號碼")
      let row: { hasInvoice: unknown; invoiceNo: unknown } | undefined
      for (let r = 5; r <= ws.rowCount; r++) {
        if (ws.getRow(r).getCell(1).value === b2No) {
          row = { hasInvoice: ws.getRow(r).getCell(11).value, invoiceNo: ws.getRow(r).getCell(12).value }
          break
        }
      }
      expect(row?.hasInvoice).toBe("✓")
      expect(row?.invoiceNo).toBe("AB12345678")
    })
  })
})

describe.skipIf(migrated)("放款專區 — schema not migrated (0041)", () => {
  it("is skipped on a live DB that lacks disbursements (the suite above is what matters)", () => {
    expect(migrated).toBe(false)
  })
})
