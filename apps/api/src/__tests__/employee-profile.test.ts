import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let adminToken: string
let tenantId: string
let empId: string
let empToken: string
let otherEmpId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

async function createEmployee(email: string, password: string, name: string) {
  const res = await request(app)
    .post("/employees")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, name, password, role: "employee" })
  if (res.status !== 201) throw new Error(`createEmployee failed (${res.status})`)
  createdUserIds.push(res.body.userId)
  return res.body.employeeId as string
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE creds missing — cannot run employee-profile test")
  }
  const adminEmail = `prof-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const prov = await provisionTenant({ name: `PROFTEST ${stamp}`, adminEmail, adminPassword })
  tenantId = prov.tenantId
  createdTenantIds.push(prov.tenantId)
  createdUserIds.push(prov.userId)
  adminToken = await signIn(adminEmail, adminPassword)

  const empEmail = `prof-${stamp}-emp@example.com`
  const empPassword = `Pw-${stamp}-emp-Bb2!`
  empId = await createEmployee(empEmail, empPassword, "Profile Pat")
  empToken = await signIn(empEmail, empPassword)

  otherEmpId = await createEmployee(`prof-${stamp}-other@example.com`, `Pw-${stamp}-oth-Cc3!`, "Other O")
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    for (const t of [
      "employee_profiles",
      "employee_educations",
      "employee_certifications",
      "employee_work_history",
      "employee_job_history",
    ]) {
      await supabaseAdmin.from(t).delete().eq("tenant_id", tid)
    }
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(uid)
  }
}, 60_000)

describe("F-MyData 履歷 — employee profile aggregate + sub-resources", () => {
  it("PUT /employees/:id/profile (self) upserts contact info", async () => {
    const res = await request(app)
      .put(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ phone: "0912345678", address: "Taipei", maritalStatus: "single" })
    expect(res.status).toBe(200)

    // Upsert again → still one row, updated.
    const again = await request(app)
      .put(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ phone: "0900000000" })
    expect(again.status).toBe(200)

    const { data } = await supabaseAdmin
      .from("employee_profiles")
      .select("id, phone")
      .eq("tenant_id", tenantId)
      .eq("employee_id", empId)
    expect(data?.length).toBe(1)
    expect(data?.[0].phone).toBe("0900000000")
  })

  it("self can add education + certification + work-history", async () => {
    const edu = await request(app)
      .post(`/employees/${empId}/educations`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ school: "NTU", major: "CS", degree: "BSc", startDate: "2010-09-01", endDate: "2014-06-30" })
    expect(edu.status).toBe(201)

    const cert = await request(app)
      .post(`/employees/${empId}/certifications`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ name: "PMP", issuer: "PMI", issuedDate: "2020-01-01" })
    expect(cert.status).toBe(201)

    const work = await request(app)
      .post(`/employees/${empId}/work-history`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ company: "Acme", title: "Engineer", startDate: "2015-01-01", endDate: "2019-12-31" })
    expect(work.status).toBe(201)
  })

  it("GET /employees/:id/profile aggregates everything (self)", async () => {
    const res = await request(app)
      .get(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
    expect(res.status).toBe(200)
    expect(res.body.basic.id).toBe(empId)
    expect(res.body.profile.phone).toBe("0900000000")
    expect(res.body.educations.length).toBe(1)
    expect(res.body.certifications.length).toBe(1)
    expect(res.body.workHistory.length).toBe(1)
    // seniorityDays is a number or null (hire_date may be unset).
    expect(res.body).toHaveProperty("seniorityDays")
    // Extended fields: jobHistory list + seniority breakdown.
    expect(Array.isArray(res.body.jobHistory)).toBe(true)
    expect(res.body.seniority).toHaveProperty("internalYears")
    expect(res.body.seniority).toHaveProperty("gradeYears")
    expect(res.body.seniority).toHaveProperty("unitYears")
  })

  it("基本/通訊 fields roundtrip; partial PUT leaves other fields intact", async () => {
    // Fill 基本資料 fields.
    const put1 = await request(app)
      .put(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({
        englishName: "Pat",
        nationality: "台灣",
        idType: "台灣身分證",
        idNumber: "A123456789",
        registeredAddress: "高雄市...",
        companyEmail: "pat@corp.example.com",
        emergencyRelationship: "配偶",
        phoneLandline: "07-1234567",
      })
    expect(put1.status).toBe(200)

    // Partial update of ONE field must not wipe the rest.
    const put2 = await request(app)
      .put(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ phone: "0911222333" })
    expect(put2.status).toBe(200)

    const res = await request(app)
      .get(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
    expect(res.body.profile.english_name).toBe("Pat")
    expect(res.body.profile.id_number).toBe("A123456789")
    expect(res.body.profile.registered_address).toBe("高雄市...")
    expect(res.body.profile.company_email).toBe("pat@corp.example.com")
    expect(res.body.profile.emergency_relationship).toBe("配偶")
    expect(res.body.profile.phone).toBe("0911222333")
  })

  it("education accepts extended fields (isHighest/studyType/studyStatus/region)", async () => {
    const res = await request(app)
      .post(`/employees/${empId}/educations`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({
        school: "NCKU",
        isHighest: true,
        majorCategory: "工程",
        major: "EE",
        degree: "碩士",
        studyType: "日間部",
        studyStatus: "畢業",
        region: "台南",
        startDate: "2014-09-01",
        endDate: "2016-06-30",
      })
    expect(res.status).toBe(201)
    const { data } = await supabaseAdmin
      .from("employee_educations")
      .select("is_highest, study_type, study_status, region, major_category")
      .eq("id", res.body.id)
      .single()
    expect(data?.is_highest).toBe(true)
    expect(data?.study_type).toBe("日間部")
    expect(data?.study_status).toBe("畢業")
    expect(data?.region).toBe("台南")
    expect(data?.major_category).toBe("工程")
  })

  it("job-history: HR can record 職務經歷; employee cannot; it shows in aggregate", async () => {
    const denied = await request(app)
      .post(`/employees/${empId}/job-history`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ effectiveDate: "2026-01-01", action: "新進" })
    expect(denied.status).toBe(403)

    const ok = await request(app)
      .post(`/employees/${empId}/job-history`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ effectiveDate: "2026-01-01", action: "新進", deptName: "工程部", grade: "P3", title: "工程師" })
    expect(ok.status).toBe(201)

    const res = await request(app)
      .get(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
    const jh = res.body.jobHistory as Array<{ action: string; dept_name: string; grade: string | null }>
    expect(jh.some((j) => j.action === "新進" && j.dept_name === "工程部" && j.grade === "P3")).toBe(true)
    // unitYears and gradeYears now derive from that entry's effective_date.
    expect(res.body.seniority.unitYears).not.toBeNull()
    expect(res.body.seniority.gradeYears).not.toBeNull()
  })

  it("HR can read any employee's profile", async () => {
    const res = await request(app)
      .get(`/employees/${empId}/profile`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.basic.id).toBe(empId)
  })

  it("an employee cannot read another employee's profile → 403", async () => {
    const res = await request(app)
      .get(`/employees/${otherEmpId}/profile`)
      .set("Authorization", `Bearer ${empToken}`)
    expect(res.status).toBe(403)
  })

  it("an employee cannot add education to another employee → 403", async () => {
    const res = await request(app)
      .post(`/employees/${otherEmpId}/educations`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ school: "Hack U" })
    expect(res.status).toBe(403)
  })
})
