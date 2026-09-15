import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import ExcelJS from "exceljs"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

/**
 * B8 假單人資月底核銷（第二階段）— live 合約測試（仿 approval-chain-live.test.ts /
 * disbursements-live.test.ts）。
 *
 * 涵蓋：
 *   GET  /leave-settlement?period=&status=unsettled           只回 approved 且未核銷的假單
 *   POST /leave-settlement/settle                              not_approved／attachment_missing
 *                                                               正確跳過；force 強制核銷＋稽核留痕；
 *                                                               已核銷再核銷 → already_settled
 *   POST /leave-settlement/unsettle                            三欄清空＋audit_logs 留下 reason
 *   GET  /leave-settlement/export.xlsx                         列數＝GET /leave-settlement 的 items 筆數
 *   attendance-sheets 的月級異常 unsettled_leave_in_period      warn/error 依
 *                                                               tenants.features.attendance
 *                                                               .blockApproveOnUnsettledLeave；
 *                                                               approve 的 409 unsettled_leave 阻擋
 *
 * 正式庫尚未套用 settled_at/settled_by_emp_id/settled_period 欄位時整組
 * describe.skipIf 跳過（仿 approval-chain-live.test.ts 的 migrated() 判斷）。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const r = await supabaseAdmin.from("leave_requests").select("settled_at, settled_by_emp_id, settled_period").limit(1)
  return !r.error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let empId: string
let empId2: string
let leaveTypePlainId: string // paid=true, requires_attachment=false
let leaveTypeAttId: string // paid=false, requires_attachment=true

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}

async function insertLeaveRequest(opts: {
  employeeId: string
  leaveTypeId: string
  startAt: string
  endAt: string
  hours: number
  status: "pending" | "approved"
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .insert({
      tenant_id: tenantId,
      employee_id: opts.employeeId,
      kind: "leave",
      leave_type_id: opts.leaveTypeId,
      start_at: opts.startAt,
      end_at: opts.endAt,
      hours: opts.hours,
      status: opts.status,
      current_step: 1,
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`insertLeaveRequest failed: ${error?.message}`)
  return data.id as string
}

async function leaveRow(id: string) {
  const { data, error } = await supabaseAdmin
    .from("leave_requests")
    .select("id, settled_at, settled_by_emp_id, settled_period")
    .eq("id", id)
    .single()
  if (error || !data) throw new Error(`leaveRow(${id}) failed: ${error?.message}`)
  return data
}

async function sheetRow(employeeId: string, period: string) {
  const { data, error } = await supabaseAdmin
    .from("attendance_sheets")
    .select("id, status, month_anomalies")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("period", period)
    .single()
  if (error || !data) throw new Error(`sheetRow(${employeeId}, ${period}) failed: ${error?.message}`)
  return data as { id: string; status: string; month_anomalies: Array<{ code: string; severity: string }> }
}

const PERIOD = "2026-09"
const PERIOD_2 = "2026-10"

describe.skipIf(!ready)("B8 假單月底核銷 — live", () => {
  let leaveNoAttachment: string
  let leaveNeedsAttachment: string
  let leavePending: string

  beforeAll(async () => {
    const adminEmail = `settle-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `SETTLETEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const empRes = await as(adminToken, request(app).post("/employees")).send({
      email: `settle-${stamp}-emp@example.com`,
      name: `emp-${stamp}`,
      password: `Pw-${stamp}-Emp-Bb2!`,
      role: "employee",
      empNo: `S-${stamp}`,
    })
    if (empRes.status !== 201) throw new Error(`beforeAll: create emp (${empRes.status}): ${JSON.stringify(empRes.body)}`)
    empId = empRes.body.employeeId
    createdUserIds.push(empRes.body.userId)

    const emp2Res = await as(adminToken, request(app).post("/employees")).send({
      email: `settle-${stamp}-emp2@example.com`,
      name: `emp2-${stamp}`,
      password: `Pw-${stamp}-Emp2-Cc3!`,
      role: "employee",
      empNo: `S2-${stamp}`,
    })
    if (emp2Res.status !== 201) throw new Error(`beforeAll: create emp2 (${emp2Res.status}): ${JSON.stringify(emp2Res.body)}`)
    empId2 = emp2Res.body.employeeId
    createdUserIds.push(emp2Res.body.userId)

    // 直接建 leave_types（POST /leave-types 目前的 zod schema 沒有開放
    // requiresAttachment 這個欄位，見回報中的「意外發現」），deduct_rate 故意
    // 留 null 讓 leaveDeductRate 走 paid 推算那條路徑一併驗到。
    const { data: lt1, error: lt1Err } = await supabaseAdmin
      .from("leave_types")
      .insert({ tenant_id: tenantId, code: `annual-${stamp}`, name: "特休", paid: true, requires_attachment: false })
      .select("id")
      .single()
    if (lt1Err || !lt1) throw new Error(`beforeAll: leave type plain: ${lt1Err?.message}`)
    leaveTypePlainId = lt1.id as string

    const { data: lt2, error: lt2Err } = await supabaseAdmin
      .from("leave_types")
      .insert({ tenant_id: tenantId, code: `sick-${stamp}`, name: "病假", paid: false, requires_attachment: true })
      .select("id")
      .single()
    if (lt2Err || !lt2) throw new Error(`beforeAll: leave type attachment: ${lt2Err?.message}`)
    leaveTypeAttId = lt2.id as string

    leaveNoAttachment = await insertLeaveRequest({
      employeeId: empId,
      leaveTypeId: leaveTypePlainId,
      startAt: "2026-09-05T01:00:00.000Z",
      endAt: "2026-09-05T09:00:00.000Z",
      hours: 8,
      status: "approved",
    })
    leaveNeedsAttachment = await insertLeaveRequest({
      employeeId: empId,
      leaveTypeId: leaveTypeAttId,
      startAt: "2026-09-08T01:00:00.000Z",
      endAt: "2026-09-08T09:00:00.000Z",
      hours: 8,
      status: "approved",
    })
    leavePending = await insertLeaveRequest({
      employeeId: empId,
      leaveTypeId: leaveTypePlainId,
      startAt: "2026-09-12T01:00:00.000Z",
      endAt: "2026-09-12T09:00:00.000Z",
      hours: 4,
      status: "pending",
    })
  }, 90_000)

  afterAll(async () => {
    // FK-safe order（比照 approval-chain-live.test.ts）：submit/approve 沿途會經
    // notify() 寫 notifications（employee_id FK），沒清會卡住 employees 的刪除；
    // period_closes 目前這個測試不會用到（沒呼叫 close-period）但留著防呆；
    // audit_logs 放在 employees 之後、tenants 之前——leave_requests 等表都掛了
    // sql/0019 的 audit_all trigger，刪那些表本身也會再寫入 audit_logs。
    for (const tid of createdTenantIds) {
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("request_attachments").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_requests").delete().eq("tenant_id", tid)
      // attendance_sheet_snapshots：C3（另一個並行 agent 新增的月表快照歷史）
      // 每次 approve 都會寫一列 taken_by_emp_id → employees，沒清會卡刪 employees。
      await supabaseAdmin.from("attendance_sheet_snapshots").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_sheet_days").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_sheets").delete().eq("tenant_id", tid)
      // attendance_days：generateSheets 內部呼叫 settleAttendance 會幫整月每天寫一列。
      await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("period_closes").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("leave_types").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("GET /leave-settlement — 清單只回 approved 且未核銷", () => {
    it("2 張 approved（1 張需附件未附）+ 1 張 pending → status=unsettled 恰好 2 筆", async () => {
      const res = await as(adminToken, request(app).get(`/leave-settlement?period=${PERIOD}&status=unsettled`))
      expect(res.status).toBe(200)
      expect(res.body.period).toBe(PERIOD)
      expect(res.body.items).toHaveLength(2)
      const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id).sort()
      expect(ids).toEqual([leaveNoAttachment, leaveNeedsAttachment].sort())
      const needsAtt = (res.body.items as Array<{ id: string; requiresAttachment: boolean; attachmentCount: number; leaveType: { deductRate: number } }>).find(
        (i) => i.id === leaveNeedsAttachment,
      )!
      expect(needsAtt.requiresAttachment).toBe(true)
      expect(needsAtt.attachmentCount).toBe(0)
      expect(needsAtt.leaveType.deductRate).toBe(1) // paid=false 推算
      const plain = (res.body.items as Array<{ id: string; leaveType: { deductRate: number } }>).find((i) => i.id === leaveNoAttachment)!
      expect(plain.leaveType.deductRate).toBe(0) // paid=true 推算
      expect(res.body.summary.totalCount).toBe(2)
      expect(res.body.summary.unsettledCount).toBe(2)
      expect(res.body.summary.settledCount).toBe(0)
    })

    it("非 HR（一般員工）打 → 403", async () => {
      const empEmail = `settle-${stamp}-emp@example.com`
      const empToken = await signIn(empEmail, `Pw-${stamp}-Emp-Bb2!`)
      const res = await as(empToken, request(app).get(`/leave-settlement?period=${PERIOD}`))
      expect(res.status).toBe(403)
    })
  })

  describe("POST /leave-settlement/settle", () => {
    it("3 筆一起 settle → settled=1，skipped 含 not_approved 與 attachment_missing 各一筆", async () => {
      const res = await as(adminToken, request(app).post("/leave-settlement/settle")).send({
        period: PERIOD,
        ids: [leaveNoAttachment, leaveNeedsAttachment, leavePending],
      })
      expect(res.status).toBe(200)
      expect(res.body.settled).toBe(1)
      expect(res.body.skipped).toEqual(
        expect.arrayContaining([
          { id: leavePending, reason: "not_approved" },
          { id: leaveNeedsAttachment, reason: "attachment_missing" },
        ]),
      )
      expect(res.body.skipped).toHaveLength(2)

      const row = await leaveRow(leaveNoAttachment)
      expect(row.settled_at).not.toBeNull()
      expect(row.settled_period).toBe(PERIOD)
    })

    it("被跳過的那筆帶 force:true 再 settle → settled=1，並留下強制核銷的 audit log", async () => {
      const res = await as(adminToken, request(app).post("/leave-settlement/settle")).send({
        period: PERIOD,
        ids: [leaveNeedsAttachment],
        force: true,
      })
      expect(res.status).toBe(200)
      expect(res.body.settled).toBe(1)
      expect(res.body.skipped).toEqual([])

      const row = await leaveRow(leaveNeedsAttachment)
      expect(row.settled_at).not.toBeNull()

      // .contains(...) 篩掉 sql/0019 那個 DB trigger 為同一句 UPDATE 另外
      // 寫的一列（trigger 現在也會把 x-actor-route 填進 context，見下方
      // 「意外發現」——同一個 context 字串可能同時對到 app 層與 trigger 層
      // 兩列，trigger 那列的 new_row 是整列 to_jsonb(NEW)，不會有 forced 這個
      // key，用 .contains 精準只挑我們自己寫的那列）。
      const { data: logs, error } = await supabaseAdmin
        .from("audit_logs")
        .select("new_row, context")
        .eq("tenant_id", tenantId)
        .eq("table_name", "leave_requests")
        .eq("record_id", leaveNeedsAttachment)
        .eq("context", "POST /leave-settlement/settle")
        .contains("new_row", { forced: true })
      expect(error).toBeNull()
      expect(logs!.length).toBeGreaterThanOrEqual(1)
      const newRow = logs![0].new_row as Record<string, unknown>
      expect(newRow.forced).toBe(true)
    })

    it("已核銷的那筆再 settle → skipped 含 already_settled", async () => {
      const res = await as(adminToken, request(app).post("/leave-settlement/settle")).send({
        period: PERIOD,
        ids: [leaveNeedsAttachment],
      })
      expect(res.status).toBe(200)
      expect(res.body.settled).toBe(0)
      expect(res.body.skipped).toEqual([{ id: leaveNeedsAttachment, reason: "already_settled" }])
    })
  })

  describe("POST /leave-settlement/unsettle", () => {
    it("清空三欄，audit_logs 查得到一筆帶 reason 的紀錄", async () => {
      const reason = `退回重辦-${stamp}`
      const res = await as(adminToken, request(app).post("/leave-settlement/unsettle")).send({
        ids: [leaveNoAttachment, leaveNeedsAttachment],
        reason,
      })
      expect(res.status).toBe(200)
      expect(res.body.unsettled).toBe(2)

      for (const id of [leaveNoAttachment, leaveNeedsAttachment]) {
        const row = await leaveRow(id)
        expect(row.settled_at).toBeNull()
        expect(row.settled_by_emp_id).toBeNull()
        expect(row.settled_period).toBeNull()
      }

      // 同上：.contains 篩掉 DB trigger 另外寫的那列（見「意外發現」）。
      const { data: logs, error } = await supabaseAdmin
        .from("audit_logs")
        .select("record_id, new_row")
        .eq("tenant_id", tenantId)
        .eq("table_name", "leave_requests")
        .eq("context", "POST /leave-settlement/unsettle")
        .contains("new_row", { reason })
      expect(error).toBeNull()
      expect(logs!.length).toBeGreaterThanOrEqual(2)
      for (const l of logs!) {
        expect((l.new_row as Record<string, unknown>).reason).toBe(reason)
      }
    })
  })

  describe("GET /leave-settlement/export.xlsx", () => {
    it("200，解析出來的資料列數＝同篩選條件下 GET /leave-settlement 的 items 筆數", async () => {
      const list = await as(adminToken, request(app).get(`/leave-settlement?period=${PERIOD}&status=all`))
      expect(list.status).toBe(200)
      const expectedCount = (list.body.items as unknown[]).length
      expect(expectedCount).toBe(2) // leavePending 是 pending，不算在 status='approved' 的資料底層內

      const res = await as(adminToken, request(app).get(`/leave-settlement/export.xlsx?period=${PERIOD}&status=all`)).buffer(true).parse(binaryParser)
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("spreadsheetml")
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(new Uint8Array(res.body as Buffer) as unknown as ExcelJS.Buffer)
      const ws = wb.getWorksheet("假單核銷")!
      expect(ws.getRow(1).getCell(1).value).toBe("員工姓名")
      expect(ws.rowCount - 1).toBe(expectedCount)
    })
  })

  describe("月表 unsettled_leave_in_period 異常（warn/error）＋ approve 409 阻擋", () => {
    let leaveP1: string
    let leaveP2: string

    it("flag 預設 false：recompute 後異常為 warn，approve 回 200", async () => {
      leaveP1 = await insertLeaveRequest({
        employeeId: empId2,
        leaveTypeId: leaveTypePlainId,
        startAt: "2026-09-10T01:00:00.000Z",
        endAt: "2026-09-10T09:00:00.000Z",
        hours: 8,
        status: "approved",
      })

      const gen = await as(adminToken, request(app).post("/attendance-sheets/generate")).send({ period: PERIOD, employeeId: empId2 })
      expect(gen.status).toBe(200)

      const sheet1 = await sheetRow(empId2, PERIOD)
      const anomaly1 = sheet1.month_anomalies.find((a) => a.code === "unsettled_leave_in_period")
      expect(anomaly1).toBeTruthy()
      expect(anomaly1!.severity).toBe("warn")

      const submit = await as(adminToken, request(app).post(`/attendance-sheets/${sheet1.id}/submit`)).send({})
      expect(submit.status).toBe(200)
      expect(submit.body.status).toBe("manager_reviewed") // empId2 無部門 → 跳過主管關

      const approve = await as(adminToken, request(app).post(`/attendance-sheets/${sheet1.id}/approve`)).send({})
      expect(approve.status).toBe(200)
    })

    it("flag 設 true：recompute 後異常為 error，approve 回 409 unsettled_leave；核銷後再 approve → 200", async () => {
      const setFlag = await as(adminToken, request(app).put("/api/tenant/settings")).send({
        features: { attendance: { blockApproveOnUnsettledLeave: true } },
      })
      expect(setFlag.status).toBe(200)
      expect(setFlag.body.features.attendance.blockApproveOnUnsettledLeave).toBe(true)

      leaveP2 = await insertLeaveRequest({
        employeeId: empId2,
        leaveTypeId: leaveTypePlainId,
        startAt: "2026-10-10T01:00:00.000Z",
        endAt: "2026-10-10T09:00:00.000Z",
        hours: 8,
        status: "approved",
      })

      const gen = await as(adminToken, request(app).post("/attendance-sheets/generate")).send({ period: PERIOD_2, employeeId: empId2 })
      expect(gen.status).toBe(200)

      const sheet2 = await sheetRow(empId2, PERIOD_2)
      const anomaly2 = sheet2.month_anomalies.find((a) => a.code === "unsettled_leave_in_period")
      expect(anomaly2).toBeTruthy()
      expect(anomaly2!.severity).toBe("error")

      const submit = await as(adminToken, request(app).post(`/attendance-sheets/${sheet2.id}/submit`)).send({})
      expect(submit.status).toBe(200)
      expect(submit.body.status).toBe("manager_reviewed")

      const blocked = await as(adminToken, request(app).post(`/attendance-sheets/${sheet2.id}/approve`)).send({})
      expect(blocked.status).toBe(409)
      expect(blocked.body.error).toBe("unsettled_leave")

      const settle = await as(adminToken, request(app).post("/leave-settlement/settle")).send({ period: PERIOD_2, ids: [leaveP2] })
      expect(settle.status).toBe(200)
      expect(settle.body.settled).toBe(1)

      const approveAgain = await as(adminToken, request(app).post(`/attendance-sheets/${sheet2.id}/approve`)).send({})
      expect(approveAgain.status).toBe(200)
    }, 20_000)
  })

  // ─── B 批次驗收修正（fresh-context 驗收抓到的問題 4／5）──────────────────
  describe("B 批次驗收修正：核銷併發不互相覆蓋 ＋ 跨月假單兩套判準統一", () => {
    it("問題 4：同一張假單兩個併發 settle → 合計 settled=1、輸的那次 skipped already_settled，且只留一筆 app 層 audit log", async () => {
      const id = await insertLeaveRequest({
        employeeId: empId,
        leaveTypeId: leaveTypePlainId,
        startAt: "2026-09-20T01:00:00.000Z",
        endAt: "2026-09-20T09:00:00.000Z",
        hours: 8,
        status: "approved",
      })
      const [a, b] = await Promise.all([
        as(adminToken, request(app).post("/leave-settlement/settle")).send({ period: PERIOD, ids: [id] }),
        as(adminToken, request(app).post("/leave-settlement/settle")).send({ period: PERIOD, ids: [id] }),
      ])
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      expect(a.body.settled + b.body.settled).toBe(1)
      const loser = a.body.settled === 0 ? a : b
      expect(loser.body.skipped).toEqual([{ id, reason: "already_settled" }])
      const row = await leaveRow(id)
      expect(row.settled_at).not.toBeNull()
      expect(row.settled_period).toBe(PERIOD)

      // 輸的那次不能再寫 audit log（.contains 用 camelCase 的 settledPeriod 只挑 app 層那列，
      // sql/0019 trigger 那列的 new_row 是整列 snake_case，不會被挑到）。
      const { data: logs, error } = await supabaseAdmin
        .from("audit_logs")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("table_name", "leave_requests")
        .eq("record_id", id)
        .eq("context", "POST /leave-settlement/settle")
        .contains("new_row", { settledPeriod: PERIOD })
      expect(error).toBeNull()
      expect(logs).toHaveLength(1)
    })

    it("問題 4：軟刪除（deleted_at）的 approved 假單不是核銷候選 → not_approved", async () => {
      const id = await insertLeaveRequest({
        employeeId: empId,
        leaveTypeId: leaveTypePlainId,
        startAt: "2026-09-21T01:00:00.000Z",
        endAt: "2026-09-21T09:00:00.000Z",
        hours: 8,
        status: "approved",
      })
      const { error } = await supabaseAdmin.from("leave_requests").update({ deleted_at: new Date().toISOString() }).eq("id", id)
      expect(error).toBeNull()
      const res = await as(adminToken, request(app).post("/leave-settlement/settle")).send({ period: PERIOD, ids: [id] })
      expect(res.status).toBe(200)
      expect(res.body.settled).toBe(0)
      expect(res.body.skipped).toEqual([{ id, reason: "not_approved" }])
      expect((await leaveRow(id)).settled_at).toBeNull()
    })

    it("問題 5：1/28–2/3 的假單在 1 月與 2 月清單都看得到（crossMonth）；2 月月表 approve 409 帶 unsettledIds／count；用 2 月核銷後 settled_period=2026-02、approve 200", async () => {
      // 上一個 describe 已把 flag 設 true；這裡再設一次，不依賴測試順序。
      const setFlag = await as(adminToken, request(app).put("/api/tenant/settings")).send({
        features: { attendance: { blockApproveOnUnsettledLeave: true } },
      })
      expect(setFlag.status).toBe(200)

      const crossId = await insertLeaveRequest({
        employeeId: empId,
        leaveTypeId: leaveTypePlainId,
        startAt: "2026-01-28T01:00:00.000Z",
        endAt: "2026-02-03T09:00:00.000Z",
        hours: 40,
        status: "approved",
      })

      type Item = { id: string; crossMonth: boolean; startDate: string; endDate: string; settledPeriod: string | null }
      const feb = await as(adminToken, request(app).get("/leave-settlement?period=2026-02&status=unsettled"))
      expect(feb.status).toBe(200)
      const febItem = (feb.body.items as Item[]).find((i) => i.id === crossId)
      expect(febItem).toBeDefined() // 舊邏輯以起日歸屬 → 2 月看不到，這就是問題 5
      expect(febItem!.crossMonth).toBe(true)
      expect(febItem!.startDate).toBe("2026-01-28")
      expect(febItem!.endDate).toBe("2026-02-03")
      expect(febItem!.settledPeriod).toBeNull()
      const jan = await as(adminToken, request(app).get("/leave-settlement?period=2026-01&status=unsettled"))
      const janItem = (jan.body.items as Item[]).find((i) => i.id === crossId)
      expect(janItem).toBeDefined()
      expect(janItem!.crossMonth).toBe(true)
      // 沒碰到的月份看不到；單月假單不標跨月。
      const mar = await as(adminToken, request(app).get("/leave-settlement?period=2026-03&status=all"))
      expect((mar.body.items as Item[]).some((i) => i.id === crossId)).toBe(false)
      const sep = await as(adminToken, request(app).get("/leave-settlement?period=2026-09&status=all"))
      const sepPlain = (sep.body.items as Item[]).find((i) => i.id === leaveNoAttachment)
      expect(sepPlain).toBeDefined()
      expect(sepPlain!.crossMonth).toBe(false)

      // 2 月月表：approve 被這張跨月假單擋下，body 要指名是哪一張。
      const gen = await as(adminToken, request(app).post("/attendance-sheets/generate")).send({ period: "2026-02", employeeId: empId })
      expect(gen.status).toBe(200)
      const sheet = await sheetRow(empId, "2026-02")
      const submit = await as(adminToken, request(app).post(`/attendance-sheets/${sheet.id}/submit`)).send({})
      expect(submit.status).toBe(200)
      expect(submit.body.status).toBe("manager_reviewed") // empId 無部門 → 跳過主管關
      const blocked = await as(adminToken, request(app).post(`/attendance-sheets/${sheet.id}/approve`)).send({})
      expect(blocked.status).toBe(409)
      expect(blocked.body.error).toBe("unsettled_leave")
      expect(blocked.body.unsettledIds).toEqual([crossId])
      expect(blocked.body.count).toBe(1)

      // HR 在 2 月清單核銷 → settled_period 記 2 月；1 月清單的 settled 分頁看得到同一張並標示核銷月份。
      const settle = await as(adminToken, request(app).post("/leave-settlement/settle")).send({ period: "2026-02", ids: [crossId] })
      expect(settle.status).toBe(200)
      expect(settle.body.settled).toBe(1)
      const row = await leaveRow(crossId)
      expect(row.settled_period).toBe("2026-02")
      const janSettled = await as(adminToken, request(app).get("/leave-settlement?period=2026-01&status=settled"))
      const janSettledItem = (janSettled.body.items as Item[]).find((i) => i.id === crossId)
      expect(janSettledItem).toBeDefined()
      expect(janSettledItem!.settledPeriod).toBe("2026-02")
      const janUnsettled = await as(adminToken, request(app).get("/leave-settlement?period=2026-01&status=unsettled"))
      expect((janUnsettled.body.items as Item[]).some((i) => i.id === crossId)).toBe(false)

      const approve = await as(adminToken, request(app).post(`/attendance-sheets/${sheet.id}/approve`)).send({})
      expect(approve.status).toBe(200)
    }, 30_000)
  })
})
