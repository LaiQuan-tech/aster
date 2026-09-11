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

let tenantId: string
let adminToken: string
let hrEmpId: string

/** 實報實銷類別（要憑證、與出勤交叉檢核）。 */
let taxiCatId: string
/** 定額補貼類別（油錢）。 */
let fuelCatId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

beforeAll(async () => {
  const name = `EXPTEST ${stamp}`
  const adminEmail = `exp-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
  tenantId = provisioned.tenantId
  createdTenantIds.push(provisioned.tenantId)
  createdUserIds.push(provisioned.userId)
  adminToken = await signIn(adminEmail, adminPassword)

  const { data: hr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", provisioned.userId)
    .single()
  hrEmpId = hr!.id as string
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("expense_claim_attachments").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("expense_claims").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("expense_settlements").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("expense_categories").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
}, 60_000)

describe("M3-1 類別目錄 — nature 決定課稅與投保歸屬", () => {
  it("HR 建立實報實銷類別（夜間計程車，要憑證、與出勤交叉檢核）", async () => {
    const res = await request(app)
      .put("/expense-categories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        code: "night_taxi",
        name: "夜間計程車",
        nature: "reimbursement",
        requiresReceipt: true,
        crossCheckAttendance: true,
      })
    expect(res.status).toBe(200)
    expect(res.body.category.nature).toBe("reimbursement")
    taxiCatId = res.body.category.id
  })

  it("HR 建立定額補貼類別（油錢），性質與報銷相反", async () => {
    const res = await request(app)
      .put("/expense-categories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "fuel", name: "油錢補貼", nature: "allowance", requiresReceipt: false })
    expect(res.status).toBe(200)
    expect(res.body.category.nature).toBe("allowance")
    fuelCatId = res.body.category.id
  })

  it("nature 未指定時預設為 reimbursement（較保守那邊需明示）", async () => {
    const res = await request(app)
      .put("/expense-categories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "mrt", name: "捷運" })
    expect(res.status).toBe(200)
    expect(res.body.category.nature).toBe("reimbursement")
  })
})

describe("M3-1 填報 — nature 凍結在單上，不隨類別事後變更", () => {
  let claimId: string

  it("填報一筆油錢，單上帶走類別當時的 allowance", async () => {
    const res = await request(app)
      .post("/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryId: fuelCatId, amount: 3000, incurredOn: "2026-03-05" })
    expect(res.status).toBe(201)
    expect(res.body.nature).toBe("allowance")
    expect(res.body.period).toBe("2026-03") // 由 incurredOn 推導
    claimId = res.body.id
  })

  it("類別事後改成 reimbursement，已送出的單不受影響", async () => {
    await request(app)
      .put("/expense-categories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "fuel", name: "油錢補貼", nature: "reimbursement" })

    const { data } = await supabaseAdmin
      .from("expense_claims")
      .select("nature")
      .eq("id", claimId)
      .single()
    // 稅務認定必須凍結：改回去以免污染後續案例。
    expect(data?.nature).toBe("allowance")

    await request(app)
      .put("/expense-categories")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "fuel", name: "油錢補貼", nature: "allowance" })
  })

  it("遲交的單可明確指定歸屬期，發生日仍保留原月份", async () => {
    const res = await request(app)
      .post("/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        categoryId: taxiCatId,
        amount: 480,
        incurredOn: "2026-02-27",
        period: "2026-03",
      })
    expect(res.status).toBe(201)
    expect(res.body.period).toBe("2026-03")

    const { data } = await supabaseAdmin
      .from("expense_claims")
      .select("incurred_on, period")
      .eq("id", res.body.id)
      .single()
    expect(data?.incurred_on).toBe("2026-02-27") // 發生日不被歸屬期覆蓋
    expect(data?.period).toBe("2026-03")
  })
})

describe("M3-1 月結審視 — 三類異常", () => {
  it("缺憑證與出勤不符都會被標出來", async () => {
    const res = await request(app)
      .get("/expense-settlements/2026-03/review")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)

    // 兩種性質分開統計，不可混算。
    expect(res.body.allowanceTotal).toBe(3000)
    expect(res.body.reimbursementTotal).toBe(480)

    // 計程車類別要求憑證卻沒附 → missingReceipt
    const missing = res.body.issues.missingReceipt as Array<{ amount: number }>
    expect(missing.some((m) => m.amount === 480)).toBe(true)

    // 夜間計程車當日無加班紀錄 → attendanceMismatch
    const mismatch = res.body.issues.attendanceMismatch as Array<{ incurredOn: string }>
    expect(mismatch.some((m) => m.incurredOn === "2026-02-27")).toBe(true)
  })

  it("補上當日加班紀錄後，交叉檢核不再標示該筆", async () => {
    await supabaseAdmin.from("attendance_days").insert({
      tenant_id: tenantId,
      employee_id: hrEmpId,
      work_date: "2026-02-27",
      worked_minutes: 11 * 60,
      overtime_minutes: 180,
      day_type: "workday",
    })

    const res = await request(app)
      .get("/expense-settlements/2026-03/review")
      .set("Authorization", `Bearer ${adminToken}`)
    const mismatch = res.body.issues.attendanceMismatch as Array<{ incurredOn: string }>
    expect(mismatch.some((m) => m.incurredOn === "2026-02-27")).toBe(false)
  })
})

describe("M3-1 核銷 — 一次性、鎖期、兩種性質分開結", () => {
  it("HR 一次核銷該期，兩個合計分開", async () => {
    const res = await request(app)
      .post("/expense-settlements/2026-03/settle")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ note: "3 月月結" })
    expect(res.status).toBe(200)
    expect(res.body.claimCount).toBe(2)
    expect(res.body.allowanceTotal).toBe(3000)
    expect(res.body.reimbursementTotal).toBe(480)
  })

  it("單子轉為 settled 並掛上批次", async () => {
    const { data } = await supabaseAdmin
      .from("expense_claims")
      .select("status, settlement_id")
      .eq("tenant_id", tenantId)
      .eq("period", "2026-03")
    expect((data ?? []).every((c) => c.status === "settled")).toBe(true)
    expect((data ?? []).every((c) => c.settlement_id !== null)).toBe(true)
  })

  it("該期已鎖定 → 不得再填報", async () => {
    const res = await request(app)
      .post("/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ categoryId: taxiCatId, amount: 200, incurredOn: "2026-03-20" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("period_settled")
  })

  it("已核銷的單不得再修改", async () => {
    const { data } = await supabaseAdmin
      .from("expense_claims")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("period", "2026-03")
      .limit(1)
      .single()
    const res = await request(app)
      .patch(`/expenses/${data!.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 999 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("already_settled")
  })

  it("重複核銷 → 409", async () => {
    const res = await request(app)
      .post("/expense-settlements/2026-03/settle")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("already_settled")
  })

  it("核銷動作有進稽核軌跡", async () => {
    const { data } = await supabaseAdmin
      .from("audit_logs")
      .select("table_name, context, actor_emp_id")
      .eq("tenant_id", tenantId)
      .eq("table_name", "expense_settlements")
    expect((data ?? []).length).toBeGreaterThan(0)
    expect(data![0].actor_emp_id).toBe(hrEmpId)
  })
})
