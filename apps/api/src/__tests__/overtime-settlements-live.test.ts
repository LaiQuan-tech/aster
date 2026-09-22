import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { purgeTestTenant } from "./helpers/purge"
import { provisionTenant } from "../services/tenants"
import { zonedTimeToUtc } from "../lib/tz"
import { app } from "../app"

/**
 * 加班超額另計（M1）— live 合約測試（throwaway 租戶，仿 attendance-sheets.test.ts）。
 *
 * 流程：8 個工作日各打 09:00–23:00（每天有效加班 330 分）→ 全月 44 小時，超過
 * 月上限 40 小時 4 小時 → 月表 generate → 超額日出現 `overtime_beyond_cap`（info）
 * 與 `overtime_beyond_cap_unapproved`（error）→ ack → submit → approve → 自動建一列
 * `overtime_settlements`（source='beyond_cap'、minutes=240、status='draft'）→ reopen、
 * 把超額日的加班覆寫成 600 分 → 再核准 → 同一列的分鐘更新成 510 → HR 清單／xlsx 看得到
 * → 標記付款後 PATCH → 409 `settlement_paid` → 員工 `GET /my/overtime-cap` 看得到累計。
 *
 * 正式庫尚未套 migration 0050（overtime_settlements）或 0039（月表兩張表）時整組
 * describe.skipIf 跳過；套完後直接
 * `npx vitest run src/__tests__/overtime-settlements-live.test.ts` 即可。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""
const TPE = "Asia/Taipei"
const PERIOD = "2026-08"
/** 2026-08 的 8 個連續平日（8/3 是週一）。 */
const OT_DAYS = [
  "2026-08-03",
  "2026-08-04",
  "2026-08-05",
  "2026-08-06",
  "2026-08-07",
  "2026-08-10",
  "2026-08-11",
  "2026-08-12",
]
/** 最後一天累計才跨過 40 小時（前 7 天 2310 分 ≤ 2400）。 */
const BEYOND_DAY = OT_DAYS[OT_DAYS.length - 1]
const EXPECTED_BEYOND_MINUTES = 8 * 330 - 40 * 60 // 2640 − 2400 = 240

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const sheets = await supabaseAdmin.from("attendance_sheets").select("id").limit(1)
  const settlements = await supabaseAdmin.from("overtime_settlements").select("id").limit(1)
  return !sheets.error && !settlements.error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let empId: string
let empToken: string
let sheetId: string
let settlementId: string

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

const asHr = (req: request.Test) => req.set("Authorization", `Bearer ${adminToken}`)
const asEmp = (req: request.Test) => req.set("Authorization", `Bearer ${empToken}`)

/** 目前這張表上所有 error 級異常的日子都填說明（submit 的 requireAnomalyAck 關卡）。 */
async function ackAllErrors(): Promise<number> {
  const res = await asHr(request(app).get(`/attendance-sheets/${sheetId}`))
  expect(res.status).toBe(200)
  const days = res.body.sheet.days as Array<{ date: string; anomalies: Array<{ severity: string }> }>
  let acked = 0
  for (const day of days) {
    if (!day.anomalies.some((a) => a.severity === "error")) continue
    const patched = await asHr(request(app).patch(`/attendance-sheets/${sheetId}/days/${day.date}`)).send({
      anomalyAck: "測試：已確認",
    })
    expect(patched.status).toBe(200)
    acked += 1
  }
  return acked
}

/** submit → （無主管，直接 manager_reviewed）→ approve。 */
async function submitAndApprove(): Promise<void> {
  await ackAllErrors()
  const submitted = await asHr(request(app).post(`/attendance-sheets/${sheetId}/submit`))
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
  expect(submitted.body.status).toBe("manager_reviewed")
  const approved = await asHr(request(app).post(`/attendance-sheets/${sheetId}/approve`))
  expect(approved.status, JSON.stringify(approved.body)).toBe(200)
  expect(approved.body.status).toBe("approved")
}

async function beyondCapRow() {
  const { data, error } = await supabaseAdmin
    .from("overtime_settlements")
    .select("id, minutes, status, source, period, sheet_id, employee_id")
    .eq("tenant_id", tenantId)
    .eq("employee_id", empId)
    .eq("period", PERIOD)
    .eq("source", "beyond_cap")
  if (error) throw new Error(`beyondCapRow: ${error.message}`)
  return data ?? []
}

function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}

describe.skipIf(!ready)("加班超額另計（M1）— live", () => {
  beforeAll(async () => {
    const adminEmail = `ot-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const t = await provisionTenant({ name: `OT ${stamp}`, adminEmail, adminPassword })
    tenantId = t.tenantId
    createdTenantIds.push(t.tenantId)
    createdUserIds.push(t.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    // 沒有部門主管 → submit 直接進 manager_reviewed，由 HR 核准。
    const email = `ot-${stamp}-emp@example.com`
    const password = `Pw-${stamp}-Bb2!`
    const res = await asHr(request(app).post("/employees")).send({
      email,
      name: "OT Employee",
      password,
      role: "employee",
      hireDate: "2026-01-05",
    })
    if (res.status !== 201) throw new Error(`createEmployee failed (${res.status}): ${JSON.stringify(res.body)}`)
    createdUserIds.push(res.body.userId)
    empId = res.body.employeeId
    empToken = await signIn(email, password)

    const sal = await asHr(request(app).put(`/salary/${empId}`)).send({ method: "monthly", baseSalary: 48000 })
    if (sal.status !== 200) throw new Error(`PUT salary failed (${sal.status}): ${JSON.stringify(sal.body)}`)

    // 不排班：引擎用 00:00–23:59／休息 0 的預設班，09:00–23:00 → 工時 840、
    // raw 加班 360 → 扣晚餐 330 → 取整仍 330。8 天 = 2640 分 = 44 小時。
    const punches = OT_DAYS.flatMap((d) => [
      { tenant_id: tenantId, employee_id: empId, type: "in", punch_at: at(d, "09:00"), source: "web" },
      { tenant_id: tenantId, employee_id: empId, type: "out", punch_at: at(d, "23:00"), source: "web" },
    ])
    const { error: punchErr } = await supabaseAdmin.from("punch_records").insert(punches)
    if (punchErr) throw new Error(`seed punches: ${punchErr.message}`)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) await purgeTestTenant(tid)
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 60_000)

  it("generate → 每天 330 分加班；最後一天出現超額異常（info ＋ 無加班單的 error）", async () => {
    const gen = await asHr(request(app).post("/attendance-sheets/generate")).send({ period: PERIOD, employeeId: empId })
    expect(gen.status, JSON.stringify(gen.body)).toBe(200)

    const list = await asHr(request(app).get(`/attendance-sheets?period=${PERIOD}`))
    expect(list.status).toBe(200)
    const mine = (list.body.sheets as Array<{ id: string; employeeId: string }>).find((s) => s.employeeId === empId)
    expect(mine).toBeDefined()
    sheetId = mine!.id

    const view = await asHr(request(app).get(`/attendance-sheets/${sheetId}`))
    expect(view.status).toBe(200)
    const days = view.body.sheet.days as Array<{
      date: string
      overtime: { effective: number; beyondCap: number }
      anomalies: Array<{ code: string; severity: string }>
    }>
    const byDate = new Map(days.map((d) => [d.date, d]))
    expect(byDate.get(OT_DAYS[0])!.overtime.effective).toBe(330)
    expect(view.body.sheet.totals.otTotal).toBe(8 * 330)
    expect(view.body.sheet.totals.overtimeBeyondCapMinutes).toBe(EXPECTED_BEYOND_MINUTES)
    expect(view.body.sheet.totals.otTierLabels).toEqual(["≤2h", "3-8h", "9-12h"])

    const last = byDate.get(BEYOND_DAY)!
    expect(last.overtime.beyondCap).toBe(EXPECTED_BEYOND_MINUTES)
    const codes = last.anomalies.map((a) => a.code)
    expect(codes).toContain("overtime_beyond_cap")
    expect(codes).toContain("overtime_beyond_cap_unapproved")
    // 沒跨過上限的日子不該有超額標記。
    expect(byDate.get(OT_DAYS[0])!.overtime.beyondCap).toBe(0)
  }, 120_000)

  it("核准月表 → 自動建一列 draft（source='beyond_cap'，minutes=240）", async () => {
    expect(await beyondCapRow()).toHaveLength(0)
    await submitAndApprove()

    const rows = await beyondCapRow()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      minutes: EXPECTED_BEYOND_MINUTES,
      status: "draft",
      source: "beyond_cap",
      period: PERIOD,
      sheet_id: sheetId,
    })
    settlementId = rows[0].id as string
  }, 120_000)

  it("HR 清單看得到（會計／員工 403）；xlsx 匯出可下載", async () => {
    const list = await asHr(request(app).get(`/overtime-settlements?period=${PERIOD}`))
    expect(list.status).toBe(200)
    expect(list.body.settlements).toHaveLength(1)
    // 回應形狀＝DB 欄位 snake_case ＋ employee_name／emp_no（與 WP7 的後台頁契約一致）。
    expect(list.body.settlements[0]).toMatchObject({
      id: settlementId,
      employee_id: empId,
      period: PERIOD,
      source: "beyond_cap",
      minutes: EXPECTED_BEYOND_MINUTES,
      status: "draft",
      channel: "cash",
      employee_name: "OT Employee",
    })
    expect(list.body.totals).toMatchObject({ count: 1, minutes: EXPECTED_BEYOND_MINUTES, draftCount: 1 })

    const denied = await asEmp(request(app).get(`/overtime-settlements?period=${PERIOD}`))
    expect(denied.status).toBe(403)

    // superagent 對 xlsx 沒有 parser，要 .buffer(true).parse(binaryParser) 才讀得到 body（同 festival-bonuses-live）
    const xlsx = await asHr(request(app).get(`/overtime-settlements/export.xlsx?period=${PERIOD}`)).buffer(true).parse(binaryParser)
    expect(xlsx.status).toBe(200)
    expect(xlsx.headers["content-type"]).toContain("spreadsheetml")
    expect((xlsx.body as Buffer).length).toBeGreaterThan(0)
  }, 60_000)

  it("reopen → 把超額日覆寫成 600 分 → 再核准 → 同一列的分鐘更新（不新增列）", async () => {
    const reopened = await asHr(request(app).post(`/attendance-sheets/${sheetId}/reopen`)).send({ reason: "測試重算" })
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200)

    const patched = await asHr(request(app).patch(`/attendance-sheets/${sheetId}/days/${BEYOND_DAY}`)).send({
      overtimeMinutesOverride: 600,
      overrideReason: "測試：改大",
    })
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)

    await submitAndApprove()

    const rows = await beyondCapRow()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(settlementId)
    // 前 7 天 2310 + 覆寫後的 600 = 2910 → 超額 510。
    expect(rows[0].minutes).toBe(7 * 330 + 600 - 40 * 60)
  }, 120_000)

  it("標記付款後整列凍結：PATCH → 409 settlement_paid、再 pay 也 409", async () => {
    const paid = await asHr(request(app).post(`/overtime-settlements/${settlementId}/pay`)).send({
      paidOn: "2026-09-05",
      channel: "cash",
      amount: 5000,
    })
    expect(paid.status, JSON.stringify(paid.body)).toBe(200)
    expect(paid.body.settlement).toMatchObject({ status: "paid", paid_on: "2026-09-05", amount: 5000 })

    const patch = await asHr(request(app).patch(`/overtime-settlements/${settlementId}`)).send({ minutes: 1 })
    expect(patch.status).toBe(409)
    expect(patch.body.error).toBe("settlement_paid")

    const again = await asHr(request(app).post(`/overtime-settlements/${settlementId}/pay`)).send({ paidOn: "2026-09-06" })
    expect(again.status).toBe(409)
  }, 60_000)

  it("HR 可手動補一列 manual；GET /my/overtime-cap 回本人累計與上限", async () => {
    const created = await asHr(request(app).post("/overtime-settlements")).send({
      employeeId: empId,
      period: PERIOD,
      minutes: 60,
      amount: 500,
      channel: "comp_time",
      note: "測試：手動補",
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body.settlement).toMatchObject({ source: "manual", minutes: 60, channel: "comp_time", status: "draft" })

    const cap = await asEmp(request(app).get(`/my/overtime-cap?period=${PERIOD}`))
    expect(cap.status).toBe(200)
    expect(cap.body).toMatchObject({ period: PERIOD, capMinutes: 40 * 60 })
    expect(cap.body.settledMinutes).toBe(8 * 330)
    expect(cap.body.beyondCapMinutes).toBe(8 * 330 - 40 * 60)
    expect(cap.body.alertHours).toEqual([36, 40, 46])
  }, 60_000)
})

describe.skipIf(ready)("加班超額另計（M1）— schema 尚未遷移（0050）", () => {
  it("正式庫還沒有 overtime_settlements 時整組跳過（上面那組才是驗收）", () => {
    expect(ready).toBe(false)
  })
})
