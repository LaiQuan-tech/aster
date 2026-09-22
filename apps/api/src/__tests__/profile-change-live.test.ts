import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * 員工自改資料要 HR 審核（W6）— live 合約測試（throwaway 租戶）。
 *
 * `features.formParameters.myDataRequiresApproval` 與 `editableFields` 原本存了
 * 完全不生效（計畫 §1b W6）。這裡驗的是三件事：開關打開後員工改的東西**不會**
 * 直接落 employee_profiles、白名單外的欄位直接 403、HR 核准後才套用。
 *
 * ⚠️ 需要 migration 0050 的 `employee_profile_change_requests`：正式庫套用前
 * 整組 skipIf 跳過。套完後直接 `npx vitest run src/__tests__/profile-change-live.test.ts`。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function probe(): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false
  const { error } = await supabaseAdmin
    .from("employee_profile_change_requests")
    .select("id, changes, status")
    .limit(1)
  return !error
}
const ready = await probe()
if (!ready) {
  console.warn(
    "[profile-change-live] 正式庫尚未有 employee_profile_change_requests（migration 0050）——整組跳過",
  )
}

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let empId: string
let empToken: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}

beforeAll(async () => {
  if (!ready) return
  const adminEmail = `pcr-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const prov = await provisionTenant({ name: `PCRTEST ${stamp}`, adminEmail, adminPassword })
  tenantId = prov.tenantId
  createdTenantIds.push(prov.tenantId)
  createdUserIds.push(prov.userId)
  adminToken = await signIn(adminEmail, adminPassword)

  const empEmail = `pcr-${stamp}-emp@example.com`
  const empPassword = `Pw-${stamp}-emp-Bb2!`
  const created = await as(adminToken, request(app).post("/employees")).send({
    email: empEmail,
    name: `PCR Pat ${stamp}`,
    password: empPassword,
    role: "employee",
  })
  if (created.status !== 201) throw new Error(`createEmployee ${created.status}`)
  createdUserIds.push(created.body.userId)
  empId = created.body.employeeId
  empToken = await signIn(empEmail, empPassword)

  // 開審核，且只允許員工自己改「通訊資料」。
  const settings = await as(adminToken, request(app).put("/api/tenant/settings")).send({
    features: {
      formParameters: { myDataRequiresApproval: true, editableFields: ["contact"] },
    },
  })
  if (settings.status !== 200) throw new Error(`tenant settings ${settings.status}`)
}, 90_000)

afterAll(async () => {
  for (const id of createdTenantIds) {
    try {
      await purgeTestTenant(id)
    } catch (err) {
      console.warn(`purge ${id} failed:`, err)
    }
  }
  for (const uid of createdUserIds) {
    try {
      await supabaseAdmin.auth.admin.deleteUser(uid)
    } catch {
      /* best effort */
    }
  }
}, 90_000)

async function profileOf(): Promise<Record<string, unknown> | null> {
  const { data } = await supabaseAdmin
    .from("employee_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("employee_id", empId)
    .maybeSingle()
  return (data as Record<string, unknown> | null) ?? null
}

describe.skipIf(!ready)("員工改資料審核（W6）— live", () => {
  let changeRequestId: string

  it("員工改白名單內的欄位 → 202 待審，profile 沒被改", async () => {
    const res = await as(empToken, request(app).put(`/employees/${empId}/profile`)).send({
      phone: "0912345678",
      address: "台北市信義區",
    })
    expect(res.status).toBe(202)
    expect(res.body.changeRequestId).toBeTruthy()
    expect(res.body.fields.sort()).toEqual(["address", "phone"])
    changeRequestId = res.body.changeRequestId

    const profile = await profileOf()
    expect(profile?.phone ?? null).toBeNull()
    expect(profile?.address ?? null).toBeNull()
  })

  it("HR 看得到待審清單；員工只看得到自己的", async () => {
    const hr = await as(adminToken, request(app).get("/profile-change-requests"))
    expect(hr.status).toBe(200)
    expect(hr.body.requests).toHaveLength(1)
    expect(hr.body.requests[0].id).toBe(changeRequestId)
    expect(hr.body.requests[0].employeeName).toContain("PCR Pat")
    expect(hr.body.requests[0].fields.map((f: { column: string }) => f.column).sort()).toEqual([
      "address",
      "phone",
    ])
    expect(hr.body.requests[0].fields.find((f: { column: string }) => f.column === "phone")).toMatchObject(
      { label: "手機", from: null, to: "0912345678" },
    )

    const mine = await as(empToken, request(app).get("/profile-change-requests"))
    expect(mine.status).toBe(200)
    expect(mine.body.requests).toHaveLength(1)
  })

  it("白名單外的欄位 → 403 field_not_editable，不建待審單", async () => {
    const before = await as(adminToken, request(app).get("/profile-change-requests?status=all"))
    const res = await as(empToken, request(app).put(`/employees/${empId}/profile`)).send({
      gender: "female", // basic 區塊，沒在 editableFields 裡
    })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("field_not_editable")
    expect(res.body.fields).toEqual(["gender"])

    const after = await as(adminToken, request(app).get("/profile-change-requests?status=all"))
    expect(after.body.requests.length).toBe(before.body.requests.length)
  })

  it("送出沒有變更的內容 → 200 changed:0，不留待審單", async () => {
    const res = await as(empToken, request(app).put(`/employees/${empId}/profile`)).send({
      phone: null, // 現況就是 null
    })
    expect(res.status).toBe(200)
    expect(res.body.changed).toBe(0)
  })

  it("HR 核准 → diff 套進 employee_profiles，狀態變 approved", async () => {
    const res = await as(
      adminToken,
      request(app).post(`/profile-change-requests/${changeRequestId}/approve`),
    ).send({})
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("approved")
    expect(res.body.applied.sort()).toEqual(["address", "phone"])

    const profile = await profileOf()
    expect(profile?.phone).toBe("0912345678")
    expect(profile?.address).toBe("台北市信義區")

    // 重複核准 → 409。
    const again = await as(
      adminToken,
      request(app).post(`/profile-change-requests/${changeRequestId}/approve`),
    ).send({})
    expect(again.status).toBe(409)
    expect(again.body.error).toBe("already_reviewed")
  })

  it("HR 退回需要理由，退回後 profile 不動", async () => {
    const submitted = await as(empToken, request(app).put(`/employees/${empId}/profile`)).send({
      phone: "0900000000",
    })
    expect(submitted.status).toBe(202)
    const id = submitted.body.changeRequestId as string

    const noReason = await as(
      adminToken,
      request(app).post(`/profile-change-requests/${id}/reject`),
    ).send({})
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("reason_required")

    const rejected = await as(
      adminToken,
      request(app).post(`/profile-change-requests/${id}/reject`),
    ).send({ reason: "請附上門號變更證明" })
    expect(rejected.status).toBe(200)

    const profile = await profileOf()
    expect(profile?.phone).toBe("0912345678") // 仍是核准過的那組
    const list = await as(adminToken, request(app).get("/profile-change-requests?status=rejected"))
    expect(list.body.requests[0].review_comment).toBe("請附上門號變更證明")
  })

  it("HR 自己改不受審核影響（直接落庫）", async () => {
    const res = await as(adminToken, request(app).put(`/employees/${empId}/profile`)).send({
      emergencyContact: "王小明",
      gender: "male", // HR 改 basic 也不受白名單限制
    })
    expect(res.status).toBe(200)
    const profile = await profileOf()
    expect(profile?.emergency_contact).toBe("王小明")
    expect(profile?.gender).toBe("male")
  })

  it("關掉審核開關後，員工改資料回到直接寫入", async () => {
    const off = await as(adminToken, request(app).put("/api/tenant/settings")).send({
      features: { formParameters: { myDataRequiresApproval: false, editableFields: ["contact"] } },
    })
    expect(off.status).toBe(200)

    const res = await as(empToken, request(app).put(`/employees/${empId}/profile`)).send({
      phoneLandline: "02-12345678",
    })
    expect(res.status).toBe(200)
    const profile = await profileOf()
    expect(profile?.phone_landline).toBe("02-12345678")
  })
})
