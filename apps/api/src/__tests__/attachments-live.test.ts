import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * B7 假單附件對簽核者可見＋病假必附憑證 — live 合約測試（仿 approval-chain-live.test.ts
 * 與 disbursements-live.test.ts 的樣板）。
 *
 * 流程：HR 建立 requiresAttachment=true 的病假假別 → 部門（manager_emp_id=主管）＋
 * 主管＋員工（申請人，歸屬該部門）＋不相關同事（無部門） → 員工申請病假並上傳一個
 * 附件 → 直屬主管／HR／申請人本人 GET 附件列表皆 200 且含 signed URL；不相關同事
 * 403 → 另申請一張病假（先不附附件）→ 主管核准 → 409 attachment_required → 上傳
 * 附件後再核准 → 200 → GET /me：主管 isManager=true；一般員工 isManager 不是 true。
 *
 * 正式庫尚未套 migration 0043（leave_types.requires_attachment）時整組
 * describe.skipIf 跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const a = await supabaseAdmin.from("leave_types").select("requires_attachment").limit(1)
  return !a.error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let mgrId: string
let mgrToken: string
let empId: string
let empToken: string
let colleagueToken: string
let deptId: string
let sickLeaveTypeId: string

// 兩張單用不同區間，避免萬一有隱性的重疊檢查互相干擾。
const START_A = "2026-11-02T01:00:00.000Z"
const END_A = "2026-11-02T09:00:00.000Z"
const START_B = "2026-11-03T01:00:00.000Z"
const END_B = "2026-11-03T09:00:00.000Z"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

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
  const email = `attlive-${stamp}-${opts.label}@example.com`
  const password = `Pw-${stamp}-${opts.label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${opts.label}-${stamp}`,
    password,
    role: opts.role,
    deptId: opts.deptId ?? null,
    empNo: `AT-${opts.label}`,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${opts.label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return { id: res.body.employeeId as string, token: await signIn(email, password) }
}
async function fileSickLeave(token: string, reason: string, startAt: string, endAt: string) {
  return as(token, request(app).post("/requests")).send({
    kind: "leave",
    leaveTypeId: sickLeaveTypeId,
    startAt,
    endAt,
    hours: 8,
    reason,
  })
}
async function uploadAttachment(token: string, requestId: string, fileName: string) {
  return as(token, request(app).post(`/requests/${requestId}/attachments`)).send({
    fileName,
    contentType: "image/png",
    dataBase64: PNG_BASE64,
  })
}

describe.skipIf(!ready)("B7 附件可見性 ＋ 病假必附憑證 — live", () => {
  beforeAll(async () => {
    const adminEmail = `attlive-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `ATTLIVE ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const mgr = await createEmployee({ label: "mgr", role: "manager" })
    mgrId = mgr.id
    mgrToken = mgr.token

    const dept = await as(adminToken, request(app).post("/departments")).send({
      name: `病假測試部 ${stamp}`,
      managerEmpId: mgrId,
    })
    expect(dept.status).toBe(201)
    deptId = dept.body.id

    const emp = await createEmployee({ label: "emp", role: "employee", deptId })
    empId = emp.id
    empToken = emp.token

    // 無部門、非簽核者、非 HR、非申請人本人 —— 應該完全看不到這張單的附件。
    const colleague = await createEmployee({ label: "colleague", role: "employee" })
    colleagueToken = colleague.token

    const lt = await as(adminToken, request(app).post("/leave-types")).send({
      code: `sick-${stamp}`,
      name: "病假",
      requiresAttachment: true,
    })
    expect(lt.status).toBe(201)
    sickLeaveTypeId = lt.body.id
  }, 90_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      const { data: atts } = await supabaseAdmin.from("request_attachments").select("storage_path").eq("tenant_id", tid)
      const paths = (atts ?? []).map((r) => r.storage_path as string)
      if (paths.length > 0) await supabaseAdmin.storage.from("request-attachments").remove(paths)
      await supabaseAdmin.from("request_attachments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_balances").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("approval_steps").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_requests").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_types").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("departments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("附件可見性：申請人／直屬主管／HR／不相關同事", () => {
    let reqId: string

    it("員工申請病假並上傳附件 → 直屬主管、HR、申請人本人 GET 列表皆 200 且含 signed URL；不相關同事 403", async () => {
      const filed = await fileSickLeave(empToken, "發燒看診", START_A, END_A)
      expect(filed.status).toBe(201)
      reqId = filed.body.requestId
      // 無部門主管以外的簽核流程設定時，直屬主管即第 1 關。
      expect(filed.body.steps).toEqual([{ stepOrder: 1, approverEmpId: mgrId }])

      const upload = await uploadAttachment(empToken, reqId, "voucher.png")
      expect(upload.status).toBe(201)

      const asMgr = await as(mgrToken, request(app).get(`/requests/${reqId}/attachments`))
      expect(asMgr.status).toBe(200)
      expect(asMgr.body.attachments).toHaveLength(1)
      expect(asMgr.body.attachments[0].fileName).toBe("voucher.png")
      expect(asMgr.body.attachments[0].url).toMatch(/^https?:\/\//)

      const asHr = await as(adminToken, request(app).get(`/requests/${reqId}/attachments`))
      expect(asHr.status).toBe(200)
      expect(asHr.body.attachments).toHaveLength(1)

      const asFiler = await as(empToken, request(app).get(`/requests/${reqId}/attachments`))
      expect(asFiler.status).toBe(200)
      expect(asFiler.body.attachments).toHaveLength(1)

      const asColleague = await as(colleagueToken, request(app).get(`/requests/${reqId}/attachments`))
      expect(asColleague.status).toBe(403)
      expect(asColleague.body.error).toBe("forbidden")
    })
  })

  describe("病假必附憑證：核准時檢查 leave_types.requires_attachment", () => {
    let reqId: string

    it("無附件時核准 → 409 attachment_required；上傳附件後再核准 → 200", async () => {
      const filed = await fileSickLeave(empToken, "牙痛回診", START_B, END_B)
      expect(filed.status).toBe(201)
      reqId = filed.body.requestId

      const blocked = await as(mgrToken, request(app).post(`/requests/${reqId}/approve`)).send({})
      expect(blocked.status).toBe(409)
      expect(blocked.body.error).toBe("attachment_required")

      const upload = await uploadAttachment(empToken, reqId, "receipt.png")
      expect(upload.status).toBe(201)

      const approved = await as(mgrToken, request(app).post(`/requests/${reqId}/approve`)).send({ comment: "已附收據，准" })
      expect(approved.status).toBe(200)
      expect(approved.body.status).toBe("approved")
    })
  })

  describe("GET /me isManager", () => {
    it("部門主管 → isManager:true；一般員工（非任何部門主管）→ isManager 不是 true", async () => {
      const mgrMe = await as(mgrToken, request(app).get("/me"))
      expect(mgrMe.status).toBe(200)
      expect(mgrMe.body.isManager).toBe(true)

      const empMe = await as(empToken, request(app).get("/me"))
      expect(empMe.status).toBe(200)
      expect(empMe.body.isManager).not.toBe(true)
    })
  })
})

describe.skipIf(ready)("B7 附件可見性 ＋ 病假必附憑證 — schema not migrated (0043)", () => {
  it("is skipped on a live DB that lacks leave_types.requires_attachment (the suite above is what matters)", () => {
    expect(ready).toBe(false)
  })
})
