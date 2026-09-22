import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import ExcelJS from "exceljs"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { zonedTimeToUtc } from "../lib/tz"
import { IMPORT_KIND_DEFS, type ImportKind } from "../services/imports/kinds"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * 批次匯入（POST /imports/:kind、GET /imports/:kind/template）— live 合約測試。
 *
 * throwaway 租戶：2 位員工（A001 王小明、B002 李小華）＋ 1 班別（早班）＋ 1 部門（業務部）。
 * 每個 kind：用 exceljs 在記憶體組一份「中文表頭」的 xlsx（含一列不存在的工號／壞值）
 * → dryRun（只驗證：total／valid／errors，DB 不變）→ 實匯（imported）→ 讀回筆數。
 * employees kind 用 options.dryRunInvite:true（建帳號不寄信）；email 一律 example.com。
 * 另驗：範本下載（工作表／表頭／員工清單）、副檔名不對 400、超過 4MB 413、缺欄 400 invalid_header、
 * 非 HR 403、未知 kind 404。
 * 清理走 purge_test_tenant（helpers/purge）；bulk-invite 建的 auth user 從 employees.user_id 撈回來刪。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""
const ready = !!SUPABASE_URL && !!SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY !== "placeholder"

const stamp = Date.now()
const createdUserIds = new Set<string>()
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let empToken: string
let empAId: string
let empBId: string
let shiftId: string
let deptId: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function asAdmin(req: request.Test) {
  return req.set("Authorization", `Bearer ${adminToken}`)
}

/** 中文表頭 + 列 → xlsx base64（沿用範本的表頭順序）。 */
async function xlsxBase64(kind: ImportKind, rows: ExcelJS.CellValue[][], headers?: string[]): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("資料")
  ws.addRow(headers ?? IMPORT_KIND_DEFS[kind].columns.map((c) => c.header))
  for (const r of rows) ws.addRow(r)
  const data = await wb.xlsx.writeBuffer()
  return Buffer.from(data as ArrayBuffer).toString("base64")
}

async function upload(kind: ImportKind, dataBase64: string, dryRun: boolean, options?: Record<string, unknown>) {
  return asAdmin(request(app).post(`/imports/${kind}`)).send({ fileName: `${kind}.xlsx`, dataBase64, dryRun, options })
}

function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}

async function countRows(table: string): Promise<number> {
  const { count, error } = await supabaseAdmin.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
  if (error) throw new Error(`count ${table}: ${error.message}`)
  return count ?? 0
}

describe.skipIf(!ready)("批次匯入（Excel）— live", () => {
  beforeAll(async () => {
    const adminEmail = `imp-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const prov = await provisionTenant({ name: `IMPORTTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = prov.tenantId
    createdTenantIds.push(tenantId)
    createdUserIds.add(prov.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const { data: dept, error: deptErr } = await supabaseAdmin
      .from("departments")
      .insert({ tenant_id: tenantId, name: "業務部" })
      .select("id")
      .single()
    if (deptErr || !dept) throw new Error(`dept: ${deptErr?.message}`)
    deptId = dept.id as string

    const { data: emps, error: empErr } = await supabaseAdmin
      .from("employees")
      .insert([
        { tenant_id: tenantId, name: "王小明", emp_no: "A001", dept_id: deptId, role: "employee", employment_type: "regular", status: "active" },
        { tenant_id: tenantId, name: "李小華", emp_no: "B002", role: "employee", employment_type: "regular", status: "active" },
      ])
      .select("id, emp_no")
    if (empErr || !emps) throw new Error(`employees: ${empErr?.message}`)
    empAId = emps.find((e) => e.emp_no === "A001")!.id as string
    empBId = emps.find((e) => e.emp_no === "B002")!.id as string

    const { data: shift, error: shiftErr } = await supabaseAdmin
      .from("shifts")
      .insert({ tenant_id: tenantId, name: "早班", start_time: "09:00", end_time: "18:00", break_minutes: 60 })
      .select("id")
      .single()
    if (shiftErr || !shift) throw new Error(`shift: ${shiftErr?.message}`)
    shiftId = shift.id as string

    // 一般員工（有 token）驗 403。
    const empEmail = `imp-${stamp}-emp@example.com`
    const empPassword = `Pw-${stamp}-Bb2!`
    const empRes = await asAdmin(request(app).post("/employees")).send({ email: empEmail, name: "一般員工", password: empPassword, role: "employee" })
    if (empRes.status !== 201) throw new Error(`create emp failed (${empRes.status}): ${JSON.stringify(empRes.body)}`)
    createdUserIds.add(empRes.body.userId as string)
    empToken = await signIn(empEmail, empPassword)
  }, 60_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      const { data: emps } = await supabaseAdmin.from("employees").select("user_id").eq("tenant_id", tid)
      for (const e of emps ?? []) if (e.user_id) createdUserIds.add(e.user_id as string)
      await purgeTestTenant(tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  describe("範本下載", () => {
    it("GET /imports/schedules/template → xlsx：資料／說明／員工清單／班別清單，表頭＝columns.header，員工清單列出兩位員工", async () => {
      const res = await asAdmin(request(app).get("/imports/schedules/template")).buffer(true).parse(binaryParser)
      expect(res.status).toBe(200)
      expect(res.headers["content-type"]).toContain("spreadsheetml")
      expect(res.headers["content-disposition"]).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("匯入範本-批次排班.xlsx")}`)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(res.body as unknown as ArrayBuffer)
      expect(wb.worksheets.map((w) => w.name)).toEqual(["資料", "說明", "員工清單", "班別清單"])
      const headers: string[] = []
      wb.getWorksheet("資料")!.getRow(1).eachCell((c) => headers.push(String(c.value)))
      expect(headers).toEqual(IMPORT_KIND_DEFS.schedules.columns.map((c) => c.header))
      const emps: string[][] = []
      wb.getWorksheet("員工清單")!.eachRow((row, n) => {
        if (n === 1) return
        const cells: string[] = []
        row.eachCell({ includeEmpty: true }, (c) => cells.push(c.value === null ? "" : String(c.value)))
        emps.push(cells)
      })
      expect(emps).toEqual(
        expect.arrayContaining([
          ["A001", "王小明", "業務部"],
          ["B002", "李小華", ""],
        ]),
      )
      const shifts: string[] = []
      wb.getWorksheet("班別清單")!.getRow(2).eachCell((c) => shifts.push(String(c.value)))
      expect(shifts).toEqual(["早班", "09:00", "18:00"])
    })

    it("未知 kind → 404；非 HR → 403", async () => {
      const unknown = await asAdmin(request(app).get("/imports/nope/template"))
      expect(unknown.status).toBe(404)
      expect(unknown.body.error).toBe("unknown_kind")
      const forbidden = await request(app).get("/imports/punches/template").set("Authorization", `Bearer ${empToken}`)
      expect(forbidden.status).toBe(403)
    })
  })

  describe("上傳的守門", () => {
    it("副檔名不是 .xlsx → 400 unsupported_file；讀不出來的 xlsx → 400 unsupported_file", async () => {
      const csv = Buffer.from("name,email\n", "utf8").toString("base64")
      const r1 = await asAdmin(request(app).post("/imports/employees")).send({ fileName: "list.csv", dataBase64: csv, dryRun: true })
      expect(r1.status).toBe(400)
      expect(r1.body.error).toBe("unsupported_file")
      const r2 = await asAdmin(request(app).post("/imports/employees")).send({ fileName: "list.xlsx", dataBase64: csv, dryRun: true })
      expect(r2.status).toBe(400)
      expect(r2.body.error).toBe("unsupported_file")
    })

    it("解碼後超過 4MB → 413 file_too_large", async () => {
      const big = Buffer.alloc(4 * 1024 * 1024 + 1, 1).toString("base64")
      const res = await asAdmin(request(app).post("/imports/punches")).send({ fileName: "big.xlsx", dataBase64: big, dryRun: true })
      expect(res.status).toBe(413)
      expect(res.body.error).toBe("file_too_large")
    }, 30_000)

    it("缺必填欄 → 400 invalid_header 且 message 說缺哪個", async () => {
      const b64 = await xlsxBase64("punches", [["A001", "王小明", "09:00", "上班"]], ["工號", "姓名", "時間", "類型"])
      const res = await upload("punches", b64, true)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe("invalid_header")
      expect(res.body.message).toContain("「日期」")
    })

    it("非 HR 上傳 → 403", async () => {
      const b64 = await xlsxBase64("holidays", [["2026-04-04", "兒童節"]])
      const res = await request(app).post("/imports/holidays").set("Authorization", `Bearer ${empToken}`).send({ fileName: "h.xlsx", dataBase64: b64, dryRun: true })
      expect(res.status).toBe(403)
    })
  })

  describe("punches", () => {
    let b64: string
    beforeAll(async () => {
      b64 = await xlsxBase64("punches", [
        ["A001", "王小明", "2026-09-17", "09:00", "上班"],
        ["", "李小華", "2026-09-17", "18:05", "下班"], // 工號空白 → 姓名唯一
        ["Z999", "不存在", "2026-09-17", "09:00", "上班"], // 錯誤列
        ["A001", "李小華", "2026-09-17", "10:00", "上班"], // 工號與姓名不符
        ["A001", "王小明", "2026-09-17", "25:00", "上班"], // 時間格式錯
        ...IMPORT_KIND_DEFS.punches.examples, // 沒刪的範例列 → 略過並回報
      ])
    })

    it("dryRun：total 7、valid 2、errors 5（含範例列）；DB 不變", async () => {
      const res = await upload("punches", b64, true)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ kind: "punches", dryRun: true, total: 7, valid: 2 })
      expect(res.body.imported).toBeUndefined()
      const lines = (res.body.errors as Array<{ line: number; message: string }>).map((e) => e.line)
      expect(lines).toEqual([4, 5, 6, 7, 8])
      const byLine = new Map((res.body.errors as Array<{ line: number; message: string }>).map((e) => [e.line, e.message]))
      expect(byLine.get(4)).toContain("Z999")
      expect(byLine.get(5)).toContain("不符")
      expect(byLine.get(6)).toContain("時間")
      expect(byLine.get(7)).toContain("範例列")
      expect(await countRows("punch_records")).toBe(0)
    })

    it("實匯：imported 2，punch_at 以台北時間換算成 UTC，source=manual", async () => {
      const res = await upload("punches", b64, false)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ dryRun: false, total: 7, valid: 2, imported: 2 })
      const { data } = await supabaseAdmin
        .from("punch_records")
        .select("employee_id, punch_at, type, source")
        .eq("tenant_id", tenantId)
        .order("punch_at", { ascending: true })
      expect(data).toHaveLength(2)
      expect(data![0]).toMatchObject({ employee_id: empAId, type: "in", source: "manual" })
      expect(new Date(data![0].punch_at as string).toISOString()).toBe(zonedTimeToUtc("2026-09-17", 9, 0, "Asia/Taipei").toISOString())
      expect(data![1]).toMatchObject({ employee_id: empBId, type: "out", source: "manual" })
      expect(new Date(data![1].punch_at as string).toISOString()).toBe(zonedTimeToUtc("2026-09-17", 18, 5, "Asia/Taipei").toISOString())
    })
  })

  describe("schedules", () => {
    let b64: string
    beforeAll(async () => {
      b64 = await xlsxBase64("schedules", [
        ["A001", "王小明", "2026-10-06", "早班", "待確認"],
        ["B002", "", "2026-10-07", "", "休假"],
        ["A001", "王小明", "2026-10-06", "早班", ""], // 同人同天重複
        ["A001", "王小明", "2026-10-08", "夜班", ""], // 找不到班別
        ["Z999", "", "2026-10-08", "早班", ""],
      ])
    })

    it("dryRun：valid 2、errors 3（重複／找不到班別／找不到工號）", async () => {
      const res = await upload("schedules", b64, true)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ kind: "schedules", total: 5, valid: 2 })
      expect((res.body.errors as Array<{ line: number }>).map((e) => e.line)).toEqual([4, 5, 6])
      expect(await countRows("schedules")).toBe(0)
    })

    it("實匯：imported 2；班別 id 與狀態正確、休假列 shift_id 為空", async () => {
      const res = await upload("schedules", b64, false)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ valid: 2, imported: 2 })
      const { data } = await supabaseAdmin
        .from("schedules")
        .select("employee_id, work_date, shift_id, status")
        .eq("tenant_id", tenantId)
        .order("work_date", { ascending: true })
      expect(data).toEqual([
        { employee_id: empAId, work_date: "2026-10-06", shift_id: shiftId, status: "scheduled" },
        { employee_id: empBId, work_date: "2026-10-07", shift_id: null, status: "day_off" },
      ])
    })
  })

  describe("salary-adjustments", () => {
    let b64: string
    beforeAll(async () => {
      b64 = await xlsxBase64("salary-adjustments", [
        ["A001", "王小明", "2026-11-01", "45,000", "年度調薪"],
        ["B002", "李小華", new Date(Date.UTC(2026, 10, 1)), 52000, ""], // Excel 日期／數字儲存格
        ["Z999", "", "2026-11-01", "50000", ""],
        ["A001", "", "2026-11-01", "-1", ""], // 負數
      ])
    })

    it("dryRun：valid 2、errors 2", async () => {
      const res = await upload("salary-adjustments", b64, true)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ kind: "salary-adjustments", total: 4, valid: 2 })
      expect((res.body.errors as Array<{ line: number }>).map((e) => e.line)).toEqual([4, 5])
      expect(await countRows("salary_adjustments")).toBe(0)
    })

    it("實匯：imported 2；金額與生效日正確", async () => {
      const res = await upload("salary-adjustments", b64, false)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ valid: 2, imported: 2 })
      const { data } = await supabaseAdmin
        .from("salary_adjustments")
        .select("employee_id, effective_date, new_salary, reason")
        .eq("tenant_id", tenantId)
        .order("new_salary", { ascending: true })
      expect(data).toHaveLength(2)
      expect(data![0]).toMatchObject({ employee_id: empAId, effective_date: "2026-11-01", reason: "年度調薪" })
      expect(Number(data![0].new_salary)).toBe(45000)
      expect(data![1]).toMatchObject({ employee_id: empBId, effective_date: "2026-11-01", reason: null })
      expect(Number(data![1].new_salary)).toBe(52000)
    })
  })

  describe("onboardings", () => {
    let b64: string
    beforeAll(async () => {
      b64 = await xlsxBase64("onboardings", [
        ["陳小新", "2026-10-05", "本國籍", "台北", "正職", "業務部", "A001"],
        ["林實習生", "2026-10-15", "", "", "intern", "", ""],
        ["", "2026-10-15", "", "", "", "", ""], // 姓名必填
        ["張三", "2026-10-15", "", "", "正職", "不存在的部門", ""],
        ["李四", "2026-10-15", "", "", "正職", "", "Z999"],
      ])
    })

    it("dryRun：valid 2、errors 3", async () => {
      const res = await upload("onboardings", b64, true)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ kind: "onboardings", total: 5, valid: 2 })
      expect((res.body.errors as Array<{ line: number }>).map((e) => e.line)).toEqual([4, 5, 6])
      expect(await countRows("onboardings")).toBe(0)
    })

    it("實匯：imported 2；部門／主管／僱用類型對應正確、status=pending", async () => {
      const res = await upload("onboardings", b64, false)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ valid: 2, imported: 2 })
      const { data } = await supabaseAdmin
        .from("onboardings")
        .select("name, report_date, identity_type, region, employment_type, dept_id, manager_emp_id, status")
        .eq("tenant_id", tenantId)
        .order("name", { ascending: true })
      expect(data).toEqual([
        { name: "林實習生", report_date: "2026-10-15", identity_type: null, region: null, employment_type: "intern", dept_id: null, manager_emp_id: null, status: "pending" },
        { name: "陳小新", report_date: "2026-10-05", identity_type: "本國籍", region: "台北", employment_type: "regular", dept_id: deptId, manager_emp_id: empAId, status: "pending" },
      ])
    })
  })

  describe("employees（批次建立帳號）", () => {
    const NEW_EMAIL = `imp-${stamp}-new@example.com`
    const BIND_EMAIL = `imp-${stamp}-bind@example.com`
    let b64: string
    beforeAll(async () => {
      b64 = await xlsxBase64("employees", [
        ["陳新人", { text: NEW_EMAIL, hyperlink: `mailto:${NEW_EMAIL}` }, "", "業務部", "正職", "2026-10-01", "一般員工"], // Email 超連結儲存格
        ["李小華", BIND_EMAIL, "B002", "", "", "", "主管"], // 綁到預建的 B002
        ["沒信箱", "", "", "", "", "", ""], // Email 必填
        ["壞角色", `imp-${stamp}-role@example.com`, "", "", "", "", "老闆"],
        ["重複", NEW_EMAIL, "", "", "", "", ""], // Email 與第 2 列重複
      ])
    })

    it("dryRun：valid 2、errors 3；不建帳號", async () => {
      const res = await upload("employees", b64, true)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ kind: "employees", dryRun: true, total: 5, valid: 2 })
      expect((res.body.errors as Array<{ line: number }>).map((e) => e.line)).toEqual([4, 5, 6])
      const { data: bind } = await supabaseAdmin.from("employees").select("user_id").eq("id", empBId).single()
      expect(bind!.user_id).toBeNull()
    })

    it("實匯（options.dryRunInvite → 建帳號不寄信）：imported 2 = created 1 + bound 1；result 列號是 Excel 列號", async () => {
      const res = await upload("employees", b64, false, { dryRunInvite: true })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ dryRun: false, total: 5, valid: 2, imported: 2 })
      const result = res.body.result as { created: number; bound: number; sent: number; dryRun: boolean; rows: Array<{ line: number; email: string; action: string; link?: string }> }
      expect(result.created).toBe(1)
      expect(result.bound).toBe(1)
      expect(result.sent).toBe(0)
      expect(result.dryRun).toBe(true)
      const created = result.rows.find((r) => r.email === NEW_EMAIL)!
      expect(created.line).toBe(2)
      expect(created.action).toBe("created")
      expect(String(created.link)).toContain("/auth/set-password?token_hash=")
      const bound = result.rows.find((r) => r.email === BIND_EMAIL)!
      expect(bound.line).toBe(3)
      expect(bound.action).toBe("bound")

      const { data: bind } = await supabaseAdmin.from("employees").select("user_id").eq("id", empBId).single()
      expect(bind!.user_id).toBeTruthy()
      const { data: newRow } = await supabaseAdmin
        .from("employees")
        .select("user_id, dept_id, employment_type, hire_date, role")
        .eq("tenant_id", tenantId)
        .eq("name", "陳新人")
        .single()
      expect(newRow!.user_id).toBeTruthy()
      expect(newRow!.dept_id).toBe(deptId)
      expect(newRow!).toMatchObject({ employment_type: "regular", hire_date: "2026-10-01", role: "employee" })
    })

    it("再上傳一次 → dryRun 兩列都是「已綁定」錯誤（冪等）", async () => {
      const res = await upload("employees", b64, true)
      expect(res.status).toBe(200)
      expect(res.body.valid).toBe(0)
      const byLine = new Map((res.body.errors as Array<{ line: number; message: string }>).map((e) => [e.line, e.message]))
      expect(byLine.get(2)).toContain("已綁定")
      expect(byLine.get(3)).toContain("已有登入帳號")
    })
  })

  describe("holidays", () => {
    let migrated = false
    let b64: string
    beforeAll(async () => {
      const { error } = await supabaseAdmin.from("tenant_calendar_days").select("id").limit(1)
      migrated = !error
      b64 = await xlsxBase64("holidays", [
        ["2026-04-04", "兒童節"],
        [new Date(Date.UTC(2026, 5, 19)), "端午節"], // Excel 日期儲存格
        ["2027-01-01", "跨年"], // 年份不同
        ["2026-04-04", "重複"],
        ["2026-13-01", "壞日期"],
      ])
    })

    it("dryRun：valid 2、errors 3", async () => {
      const res = await upload("holidays", b64, true)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ kind: "holidays", total: 5, valid: 2 })
      expect((res.body.errors as Array<{ line: number }>).map((e) => e.line)).toEqual([4, 5, 6])
    })

    it("實匯：走 calendar/generate 的邏輯 → result {year, generated, imported, skipped}，DB 有 2 筆 fixed_holiday（未建表則 503）", async () => {
      const res = await upload("holidays", b64, false)
      if (!migrated) {
        expect(res.status).toBe(503)
        expect(res.body.error).toBe("calendar_not_migrated")
        return
      }
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ valid: 2, imported: 2 })
      expect(res.body.result).toMatchObject({ year: 2026, imported: 2, skipped: 0 })
      expect(res.body.result.generated).toBeGreaterThan(100) // 2026 的週六日
      const { data } = await supabaseAdmin
        .from("tenant_calendar_days")
        .select("date, day_type, label, source")
        .eq("tenant_id", tenantId)
        .eq("day_type", "fixed_holiday")
        .order("date", { ascending: true })
      expect(data).toEqual([
        { date: "2026-04-04", day_type: "fixed_holiday", label: "兒童節", source: "import" },
        { date: "2026-06-19", day_type: "fixed_holiday", label: "端午節", source: "import" },
      ])
    })
  })
})
