import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { zonedTimeToUtc } from "../lib/tz"
import { app } from "../app"

/**
 * 出勤月表（P1）— live 合約測試：generate → GET → PATCH（override 無 reason 400）
 * → submit（error 異常未確認 400 → ack → 200）→ review → approve（snapshot 存在）
 * → PATCH 409 → payroll run 讀快照 → reopen → 重算不覆蓋 note → 再送出 → 退回
 * → 再核准 → 薪資定稿鎖定 → locked 後 PATCH / return 皆 409。
 *
 * 正式庫尚未套 0039 時兩張表不存在：整組用 describe.skipIf 保護（先探測）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""
const TPE = "Asia/Taipei"
const PERIOD = "2026-08"

async function sheetsMigrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("attendance_sheets").select("id").limit(1)
  return !error
}
const migrated = await sheetsMigrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let hrEmpId: string
let empId: string
let empToken: string
let sheetId: string

function at(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number)
  return zonedTimeToUtc(date, h, m, TPE).toISOString()
}

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

describe.skipIf(!migrated)("P1 attendance sheets — live", () => {
  beforeAll(async () => {
    const adminEmail = `p1-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const t = await provisionTenant({ name: `P1 ${stamp}`, adminEmail, adminPassword })
    tenantId = t.tenantId
    createdTenantIds.push(t.tenantId)
    createdUserIds.push(t.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin
      .from("employees")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("user_id", t.userId)
      .single()
    hrEmpId = hr!.id as string

    // 部門主管 = HR 本人 → submit 後進 submitted（由 HR 以主管身分 review）。
    const dept = await request(app)
      .post("/departments")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "工程部", managerEmpId: hrEmpId })
    if (dept.status !== 201) throw new Error(`createDepartment failed (${dept.status}): ${JSON.stringify(dept.body)}`)
    const deptId = dept.body.id as string

    const email = `p1-${stamp}-emp@example.com`
    const password = `Pw-${stamp}-Bb2!`
    const res = await request(app)
      .post("/employees")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, name: "P1 Employee", password, role: "employee", deptId, hireDate: "2026-01-05" })
    if (res.status !== 201) throw new Error(`createEmployee failed (${res.status}): ${JSON.stringify(res.body)}`)
    createdUserIds.push(res.body.userId)
    empId = res.body.employeeId
    empToken = await signIn(email, password)

    const sal = await request(app)
      .put(`/salary/${empId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ method: "monthly", baseSalary: 48000 })
    if (sal.status !== 200) throw new Error(`PUT salary failed (${sal.status}): ${JSON.stringify(sal.body)}`)

    // 班表 09:00–18:00（休息 60）排在 8/3、8/4、8/5 → 工時扣休息、遲到早退有基準。
    const { data: shift, error: shiftErr } = await supabaseAdmin
      .from("shifts")
      .insert({ tenant_id: tenantId, name: "日班", start_time: "09:00", end_time: "18:00", break_minutes: 60 })
      .select("id")
      .single()
    if (shiftErr || !shift) throw new Error(`seed shift: ${shiftErr?.message}`)
    const { error: schedErr } = await supabaseAdmin.from("schedules").insert(
      ["2026-08-03", "2026-08-04", "2026-08-05"].map((work_date) => ({
        tenant_id: tenantId,
        employee_id: empId,
        work_date,
        shift_id: shift.id as string,
      })),
    )
    if (schedErr) throw new Error(`seed schedules: ${schedErr.message}`)

    // 8/3（一）09:00–18:00 → 工時 480、無加班；8/4（二）09:00–22:00 → 工時 720
    // → raw OT 240 → 扣晚餐 210 → 30 分捨去 210（tier1 120 / tier2 90）；
    // 8/5（三）只有上班卡 → missing_out（有排班但有打卡 → 不是 absent_scheduled）。
    const { error: punchErr } = await supabaseAdmin.from("punch_records").insert([
      { tenant_id: tenantId, employee_id: empId, type: "in", punch_at: at("2026-08-03", "09:00"), source: "web" },
      { tenant_id: tenantId, employee_id: empId, type: "out", punch_at: at("2026-08-03", "18:00"), source: "web" },
      { tenant_id: tenantId, employee_id: empId, type: "in", punch_at: at("2026-08-04", "09:00"), source: "web" },
      { tenant_id: tenantId, employee_id: empId, type: "out", punch_at: at("2026-08-04", "22:00"), source: "web" },
      { tenant_id: tenantId, employee_id: empId, type: "in", punch_at: at("2026-08-05", "09:00"), source: "web" },
    ])
    if (punchErr) throw new Error(`seed punches: ${punchErr.message}`)
  }, 60_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      await supabaseAdmin.from("attendance_sheet_days").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_sheets").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("payslips").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("punch_records").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("schedules").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("shifts").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("salary_structures").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("departments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 60_000)

  it("generate（HR）→ 兩位在職員工各一張 draft；再跑一次 → rebuilt", async () => {
    const first = await request(app)
      .post("/attendance-sheets/generate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ period: PERIOD })
    expect(first.status).toBe(200)
    expect(first.body.generated).toBe(2)
    expect(first.body.rebuilt).toBe(0)
    expect(first.body.skipped).toEqual([])

    const again = await request(app)
      .post("/attendance-sheets/generate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ period: PERIOD, employeeId: empId })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ generated: 0, rebuilt: 1 })

    const denied = await request(app)
      .post("/attendance-sheets/generate")
      .set("Authorization", `Bearer ${empToken}`)
      .send({ period: PERIOD })
    expect(denied.status).toBe(403)
  })

  it("GET 列表：HR 看全部；員工只看自己", async () => {
    const hr = await request(app).get(`/attendance-sheets?period=${PERIOD}`).set("Authorization", `Bearer ${adminToken}`)
    expect(hr.status).toBe(200)
    expect(hr.body.sheets).toHaveLength(2)
    const mine = hr.body.sheets.find((s: { employeeId: string }) => s.employeeId === empId)
    expect(mine).toBeDefined()
    sheetId = mine.id
    expect(mine).toMatchObject({ status: "draft", department: "工程部", employeeName: "P1 Employee" })
    expect(mine.anomalyCount.error).toBeGreaterThanOrEqual(1) // 8/5 missing_out
    expect(mine.otTotalMinutes).toBe(210)

    const emp = await request(app).get(`/attendance-sheets?period=${PERIOD}`).set("Authorization", `Bearer ${empToken}`)
    expect(emp.status).toBe(200)
    expect(emp.body.sheets).toHaveLength(1)
    expect(emp.body.sheets[0].id).toBe(sheetId)

    const onlyAnomaly = await request(app).get(`/attendance-sheets?period=${PERIOD}&anomaly=1`).set("Authorization", `Bearer ${adminToken}`)
    expect(onlyAnomaly.body.sheets.map((s: { id: string }) => s.id)).toContain(sheetId)
  })

  it("GET /:id：整月 31 天、計算欄正確；money 只給 HR；GET /my/attendance-sheet 回同一張", async () => {
    const hr = await request(app).get(`/attendance-sheets/${sheetId}`).set("Authorization", `Bearer ${adminToken}`)
    expect(hr.status).toBe(200)
    const sheet = hr.body.sheet
    expect(sheet.days).toHaveLength(31)
    expect(sheet.frozen).toBe(false)
    const d3 = sheet.days.find((d: { date: string }) => d.date === "2026-08-03")
    expect(d3).toMatchObject({ weekday: 1, dayType: "workday", workedMinutes: 480, lateMinutes: 0, overtime: { computed: 0, effective: 0 } })
    expect(d3.anomalies).toEqual([])
    expect(d3.firstIn).toBe(at("2026-08-03", "09:00"))
    expect(d3.lastOut).toBe(at("2026-08-03", "18:00"))
    const d6 = sheet.days.find((d: { date: string }) => d.date === "2026-08-06")
    expect(d6.anomalies).toEqual([]) // 沒排班的平日不判曠職
    const d4 = sheet.days.find((d: { date: string }) => d.date === "2026-08-04")
    expect(d4.overtime).toMatchObject({ computed: 210, override: null, effective: 210, tier1: 120, tier2: 90, tier3: 0 })
    expect(d4.anomalies.map((a: { code: string }) => a.code)).toContain("meal_deducted")
    const d5 = sheet.days.find((d: { date: string }) => d.date === "2026-08-05")
    expect(d5.anomalies.map((a: { code: string }) => a.code)).toContain("missing_out")
    expect(d5.firstIn).toBe(at("2026-08-05", "09:00"))
    const d1 = sheet.days.find((d: { date: string }) => d.date === "2026-08-01")
    expect(d1.dayType).toBe("rest_day")
    expect(sheet.totals).toMatchObject({ attendanceDays: 2, workedMinutes: 1200, otTotal: 210, otTier1: 120, otTier2: 90, overtimeMonthlyAlert: "none" })
    expect(sheet.money).not.toBeNull()
    expect(sheet.money.hourlyWage).toBe(200) // 48000 ÷ 240
    expect(sheet.money.otPay).toBeGreaterThan(0)
    expect(sheet.anomalyCount.error).toBeGreaterThanOrEqual(1)

    const emp = await request(app).get(`/attendance-sheets/${sheetId}`).set("Authorization", `Bearer ${empToken}`)
    expect(emp.status).toBe(200)
    expect(emp.body.sheet.money).toBeNull()

    const my = await request(app).get(`/my/attendance-sheet?period=${PERIOD}`).set("Authorization", `Bearer ${empToken}`)
    expect(my.status).toBe(200)
    expect(my.body.sheet.id).toBe(sheetId)
    expect(my.body.sheet.money).toBeNull()

    const future = await request(app).get(`/my/attendance-sheet?period=2099-01`).set("Authorization", `Bearer ${empToken}`)
    expect(future.status).toBe(404)
  })

  it("PATCH：override 無 reason → 400；有 reason → 200 且分級／異常跟著變", async () => {
    const noReason = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-04`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ overtimeMinutesOverride: 120 })
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("override_reason_required")

    const ok = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-04`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ overtimeMinutesOverride: 120, overrideReason: "與主管談定 2 小時", content: "客戶現場" })
    expect(ok.status).toBe(200)
    expect(ok.body.day).toMatchObject({ overtimeMinutesComputed: 210, overtimeMinutesOverride: 120, otTier1: 120, otTier2: 0, content: "客戶現場" })
    expect(ok.body.day.anomalies.map((a: { code: string }) => a.code)).toContain("overtime_override")

    const missingDay = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-09-01`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ note: "x" })
    expect(missingDay.status).toBe(404)
  })

  it("submit：error 異常未 ack → 400 附清單；ack 後 → submitted（主管 = HR）", async () => {
    const blocked = await request(app).post(`/attendance-sheets/${sheetId}/submit`).set("Authorization", `Bearer ${empToken}`)
    expect(blocked.status).toBe(400)
    expect(blocked.body.error).toBe("anomalies_unacknowledged")
    expect(blocked.body.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({ date: "2026-08-05", code: "missing_out" })]))

    const ack = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-05`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ anomalyAck: "忘記打下班卡，已補申請" })
    expect(ack.status).toBe(200)

    const submitted = await request(app).post(`/attendance-sheets/${sheetId}/submit`).set("Authorization", `Bearer ${empToken}`)
    expect(submitted.status).toBe(200)
    expect(submitted.body).toMatchObject({ status: "submitted", managerEmpId: hrEmpId })

    // 送出後員工不可再改
    const locked = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-03`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ note: "late edit" })
    expect(locked.status).toBe(409)
    expect(locked.body.error).toBe("sheet_not_editable")

    const twice = await request(app).post(`/attendance-sheets/${sheetId}/submit`).set("Authorization", `Bearer ${empToken}`)
    expect(twice.status).toBe(409)
    expect(twice.body.error).toBe("invalid_transition")

    const { data: notif } = await supabaseAdmin
      .from("notifications")
      .select("employee_id, type, payload")
      .eq("tenant_id", tenantId)
      .eq("type", "attendance_sheet")
    expect((notif ?? []).some((n) => n.employee_id === hrEmpId && (n.payload as { action?: string })?.action === "submitted")).toBe(true)
  })

  it("review（主管）→ manager_reviewed；approve（HR）→ approved，snapshot 含 money 與 payrollDays", async () => {
    const empReview = await request(app)
      .post(`/attendance-sheets/${sheetId}/review`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ decision: "approve" })
    expect(empReview.status).toBe(403)

    const reviewed = await request(app)
      .post(`/attendance-sheets/${sheetId}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approve" })
    expect(reviewed.status).toBe(200)
    expect(reviewed.body.status).toBe("manager_reviewed")

    const approved = await request(app).post(`/attendance-sheets/${sheetId}/approve`).set("Authorization", `Bearer ${adminToken}`)
    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe("approved")

    const { data: row } = await supabaseAdmin
      .from("attendance_sheets")
      .select("status, snapshot, approved_by")
      .eq("id", sheetId)
      .single()
    expect(row!.status).toBe("approved")
    expect(row!.approved_by).toBe(hrEmpId)
    const snap = row!.snapshot as { days: unknown[]; money: { otPay: number } | null; payrollDays: Array<{ date: string; overtimeMinutes: number }>; salaryStructure: unknown }
    expect(snap.days).toHaveLength(31)
    expect(snap.money).not.toBeNull()
    expect(snap.salaryStructure).not.toBeNull()
    expect(snap.payrollDays.find((d) => d.date === "2026-08-04")).toMatchObject({ overtimeMinutes: 120 })

    const view = await request(app).get(`/attendance-sheets/${sheetId}`).set("Authorization", `Bearer ${adminToken}`)
    expect(view.body.sheet.frozen).toBe(true)
    expect(view.body.sheet.status).toBe("approved")
    expect(view.body.sheet.money.otPay).toBe(snap.money!.otPay)
  })

  it("approved 後 PATCH：員工 409；HR 改 override 409；HR 改註記 200 並鏡射進快照", async () => {
    const emp = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-04`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ overtimeMinutesOverride: 60, overrideReason: "改" })
    expect(emp.status).toBe(409)
    expect(emp.body.error).toBe("sheet_not_editable")

    const hrOverride = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-04`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ overtimeMinutesOverride: 60, overrideReason: "改" })
    expect(hrOverride.status).toBe(409)
    expect(hrOverride.body.error).toBe("sheet_not_editable")

    const hrNote = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-04`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ note: "HR 備註" })
    expect(hrNote.status).toBe(200)
    const view = await request(app).get(`/attendance-sheets/${sheetId}`).set("Authorization", `Bearer ${adminToken}`)
    expect(view.body.sheet.days.find((d: { date: string }) => d.date === "2026-08-04").note).toBe("HR 備註")
  })

  it("payroll run 讀快照：有效加班 120 分（非 210）；unapprovedSheets 不含該員", async () => {
    const run = await request(app)
      .post("/payroll/run")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ period: PERIOD, employeeId: empId })
    expect(run.status).toBe(201)
    expect(run.body.generated).toBe(1)
    expect(run.body.unapprovedSheets).toEqual([])
    const { data: slip } = await supabaseAdmin
      .from("payslips")
      .select("breakdown")
      .eq("tenant_id", tenantId)
      .eq("employee_id", empId)
      .eq("period", PERIOD)
      .single()
    const segments = (slip!.breakdown as { overtimeSegments: Array<{ hours: number }> }).overtimeSegments
    expect(segments.reduce((s, x) => s + x.hours, 0)).toBeCloseTo(2, 6)
  })

  it("reopen（HR）→ draft，快照清空；重算不覆蓋 note／override；recompute 只准 draft/returned", async () => {
    const reopened = await request(app)
      .post(`/attendance-sheets/${sheetId}/reopen`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "補登 8/5 下班卡" })
    expect(reopened.status).toBe(200)
    expect(reopened.body.status).toBe("draft")
    const { data: row } = await supabaseAdmin.from("attendance_sheets").select("snapshot, reopen_reason").eq("id", sheetId).single()
    expect(row!.snapshot).toBeNull()
    expect(row!.reopen_reason).toBe("補登 8/5 下班卡")

    const note = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-03`)
      .set("Authorization", `Bearer ${empToken}`)
      .send({ note: "keep me" })
    expect(note.status).toBe(200)

    // 補上 8/5 下班卡 → recompute 後 missing_out 消失，人工欄全數保留。
    await supabaseAdmin.from("punch_records").insert({ tenant_id: tenantId, employee_id: empId, type: "out", punch_at: at("2026-08-05", "18:00"), source: "manual" })
    const recomputed = await request(app).post(`/attendance-sheets/${sheetId}/recompute`).set("Authorization", `Bearer ${adminToken}`)
    expect(recomputed.status).toBe(200)

    const view = await request(app).get(`/attendance-sheets/${sheetId}`).set("Authorization", `Bearer ${adminToken}`)
    expect(view.body.sheet.frozen).toBe(false)
    const days = view.body.sheet.days as Array<{ date: string; note: string | null; content: string | null; anomalyAck: string | null; overtime: { override: number | null; overrideReason: string | null }; anomalies: Array<{ code: string }>; workedMinutes: number }>
    expect(days.find((d) => d.date === "2026-08-03")!.note).toBe("keep me")
    const d4 = days.find((d) => d.date === "2026-08-04")!
    expect(d4.overtime).toMatchObject({ override: 120, overrideReason: "與主管談定 2 小時" })
    expect(d4.content).toBe("客戶現場")
    expect(d4.note).toBe("HR 備註")
    const d5 = days.find((d) => d.date === "2026-08-05")!
    expect(d5.workedMinutes).toBe(480)
    expect(d5.anomalies.map((a) => a.code)).not.toContain("missing_out")
    expect(d5.anomalies.map((a) => a.code)).toContain("manual_punch")
    expect(d5.anomalyAck).toBe("忘記打下班卡，已補申請")
  })

  it("return（主管/HR）→ returned 可再送出；HR 核准後薪資定稿 → locked；locked 後 PATCH/return 409", async () => {
    const submitted = await request(app).post(`/attendance-sheets/${sheetId}/submit`).set("Authorization", `Bearer ${empToken}`)
    expect(submitted.status).toBe(200)
    expect(submitted.body.status).toBe("submitted")

    const returned = await request(app)
      .post(`/attendance-sheets/${sheetId}/return`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "8/4 加班請附說明" })
    expect(returned.status).toBe(200)
    expect(returned.body).toMatchObject({ status: "returned", returnReason: "8/4 加班請附說明" })

    const resubmit = await request(app).post(`/attendance-sheets/${sheetId}/submit`).set("Authorization", `Bearer ${empToken}`)
    expect(resubmit.status).toBe(200)
    const reviewed = await request(app)
      .post(`/attendance-sheets/${sheetId}/review`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ decision: "approve" })
    expect(reviewed.body.status).toBe("manager_reviewed")
    const approved = await request(app).post(`/attendance-sheets/${sheetId}/approve`).set("Authorization", `Bearer ${adminToken}`)
    expect(approved.body.status).toBe("approved")

    // 薪資：重跑（draft 可覆蓋）→ 定稿 → 月表鎖定。
    const run = await request(app).post("/payroll/run").set("Authorization", `Bearer ${adminToken}`).send({ period: PERIOD, employeeId: empId })
    expect(run.status).toBe(201)
    const { data: slip } = await supabaseAdmin.from("payslips").select("id").eq("tenant_id", tenantId).eq("employee_id", empId).eq("period", PERIOD).single()
    const fin = await request(app).post(`/payslips/${slip!.id}/finalize`).set("Authorization", `Bearer ${adminToken}`)
    expect(fin.status).toBe(200)
    expect(fin.body.sheetLocked).toBe(true)

    const view = await request(app).get(`/attendance-sheets/${sheetId}`).set("Authorization", `Bearer ${adminToken}`)
    expect(view.body.sheet.status).toBe("locked")
    expect(view.body.sheet.frozen).toBe(true)
    expect(view.body.sheet.lockedAt).not.toBeNull()

    const patch = await request(app)
      .patch(`/attendance-sheets/${sheetId}/days/2026-08-03`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ note: "too late" })
    expect(patch.status).toBe(409)
    expect(patch.body.error).toBe("sheet_not_editable")

    const ret = await request(app)
      .post(`/attendance-sheets/${sheetId}/return`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "x" })
    expect(ret.status).toBe(409)
    expect(ret.body.error).toBe("locked")

    const reopen = await request(app)
      .post(`/attendance-sheets/${sheetId}/reopen`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "x" })
    expect(reopen.status).toBe(409)
    expect(reopen.body.error).toBe("locked")
  
  }, 60_000) // 10 次以上的往返（送出→退回→再送→審→核→薪資 run→定稿→查），從台灣打東京 Supabase 實測 18 秒，預設 15 秒必炸
})

describe.skipIf(migrated)("P1 attendance sheets — schema not migrated (0039)", () => {
  it("is skipped on a live DB that lacks attendance_sheets (the suite above is what matters)", () => {
    expect(migrated).toBe(false)
  })
})
