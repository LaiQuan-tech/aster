import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import { gunzipSync } from "node:zlib"
import { createHash } from "node:crypto"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { PREVIOUS_MANIFEST_FILE, SNAPSHOT_BUCKET, SNAPSHOT_PAGE_SIZE, SNAPSHOT_TABLES, type SnapshotManifest } from "../services/backup-snapshot"
import { app } from "../app"

/**
 * C3 月度快照備份＋整公司月結 Final＋月表快照歷史 — live 合約測試（仿 disbursements-live）。
 *
 * 流程：throwaway 租戶（HR＋兩名員工）→ generate 2026-08 月表（3 張）→ 員工甲
 * submit→approve（快照 seq 1）→ reopen→submit→approve（seq 2）→ GET /snapshots 列 2 筆
 * → close-period 在其他表仍 draft 時 409 附清單 → 全部核准後 200、月表全 locked、
 * period_closes 有列 → reopen-period 標 reopened（月表仍 locked）→ 另一月份 force 月結
 * → 內部端點（INTERNAL_JOB_TOKEN）迴圈到 done：Storage 有各表 gz＋manifest、三張表列數
 * 與 count(*) 相符、gz 解開列數／sha256 相符、單次呼叫 <20 秒 → HR /backups 端點列表
 * ／run／signed URL，非 HR 403。
 *
 * C3 驗收修正補案：先灌 >1000 列 audit_logs（超過 PostgREST max-rows），manifest 該表
 * rows＝count(*)、拆成多個 part 檔、拼回列數相符、status 仍 complete（以前 5000 一頁被
 * 截到 1000 列還標 complete）；重跑前塞一個不在 manifest 裡的殘檔，完成後被清掉、
 * manifest.prev.json 也不留。
 *
 * 正式庫尚未套 0044（period_closes 不存在）時整組 describe.skipIf 跳過。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""
const PERIOD = "2026-08"
const FORCE_PERIOD = "2026-07"
const SNAPSHOT_PERIOD = "2026-09"
const INTERNAL_TOKEN = `test-internal-${Date.now()}`

async function periodClosesMigrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("period_closes").select("id").limit(1)
  return !error
}
const migrated = await periodClosesMigrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string
let hrEmpId: string
let empAId: string
let empBId: string
let empAToken: string
let sheetAId: string

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
  return req.set("Authorization", `Bearer ${empAToken}`)
}
function asInternal(req: request.Test) {
  return req.set("x-internal-job-token", INTERNAL_TOKEN)
}

/** 月表的日異常一律先 ack，submit 才不會被 anomalies_unacknowledged 擋（這裡驗的不是異常流程）。 */
async function ackAllDays(tid: string): Promise<void> {
  const { error } = await supabaseAdmin.from("attendance_sheet_days").update({ anomaly_ack: "測試確認" }).eq("tenant_id", tid)
  if (error) throw new Error(`ack days: ${error.message}`)
}

async function sheetOf(employeeId: string, period: string): Promise<{ id: string; status: string }> {
  const { data, error } = await supabaseAdmin
    .from("attendance_sheets")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .eq("period", period)
    .single()
  if (error || !data) throw new Error(`sheetOf: ${error?.message}`)
  return data as { id: string; status: string }
}

/** submit（HR 代送）→ 無主管直接 manager_reviewed → approve。 */
async function approveFlow(sheetId: string): Promise<void> {
  const submitted = await asAdmin(request(app).post(`/attendance-sheets/${sheetId}/submit`))
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200)
  expect(submitted.body.status).toBe("manager_reviewed")
  const approved = await asAdmin(request(app).post(`/attendance-sheets/${sheetId}/approve`))
  expect(approved.status, JSON.stringify(approved.body)).toBe(200)
  expect(approved.body.status).toBe("approved")
}

async function countRows(table: string): Promise<number> {
  const { count, error } = await supabaseAdmin.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
  if (error) throw new Error(`count ${table}: ${error.message}`)
  return count ?? 0
}

async function downloadJsonGz(path: string): Promise<{ rows: unknown[]; sha256: string; bytes: number }> {
  const { data, error } = await supabaseAdmin.storage.from(SNAPSHOT_BUCKET).download(path)
  if (error || !data) throw new Error(`download ${path}: ${error?.message}`)
  const gz = Buffer.from(await data.arrayBuffer())
  const rows = JSON.parse(gunzipSync(gz).toString("utf8")) as unknown[]
  return { rows, sha256: createHash("sha256").update(gz).digest("hex"), bytes: gz.length }
}

describe.skipIf(!migrated)("C3 快照備份／月結 Final／月表快照歷史 — live", () => {
  beforeAll(async () => {
    process.env.INTERNAL_JOB_TOKEN = INTERNAL_TOKEN
    process.env.ENABLE_INTERNAL_JOBS = "true"

    const adminEmail = `bk-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Aa1!`
    const t = await provisionTenant({ name: `BKTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = t.tenantId
    createdTenantIds.push(t.tenantId)
    createdUserIds.push(t.userId)
    adminToken = await signIn(adminEmail, adminPassword)
    const { data: hr } = await supabaseAdmin.from("employees").select("id").eq("tenant_id", tenantId).eq("user_id", t.userId).single()
    hrEmpId = hr!.id as string

    const a = await asAdmin(request(app).post("/employees")).send({
      email: `bk-${stamp}-a@example.com`,
      name: "員工甲",
      password: `Pw-${stamp}-Bb2!`,
      role: "employee",
      hireDate: "2026-01-05",
    })
    if (a.status !== 201) throw new Error(`create employee A (${a.status}): ${JSON.stringify(a.body)}`)
    createdUserIds.push(a.body.userId)
    empAId = a.body.employeeId
    empAToken = await signIn(`bk-${stamp}-a@example.com`, `Pw-${stamp}-Bb2!`)

    const b = await asAdmin(request(app).post("/employees")).send({
      email: `bk-${stamp}-b@example.com`,
      name: "員工乙",
      password: `Pw-${stamp}-Cc3!`,
      role: "employee",
      hireDate: "2026-02-01",
    })
    if (b.status !== 201) throw new Error(`create employee B (${b.status}): ${JSON.stringify(b.body)}`)
    createdUserIds.push(b.body.userId)
    empBId = b.body.employeeId

    for (const period of [PERIOD, FORCE_PERIOD]) {
      const gen = await asAdmin(request(app).post("/attendance-sheets/generate")).send({ period })
      if (gen.status !== 200) throw new Error(`generate ${period} (${gen.status}): ${JSON.stringify(gen.body)}`)
      expect(gen.body.generated).toBe(3)
    }
    await ackAllDays(tenantId)
    sheetAId = (await sheetOf(empAId, PERIOD)).id
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      const { data: files } = await supabaseAdmin.storage.from(SNAPSHOT_BUCKET).list(`${tid}/${SNAPSHOT_PERIOD}`, { limit: 1000 })
      const paths = (files ?? []).filter((f) => f.id !== null).map((f) => `${tid}/${SNAPSHOT_PERIOD}/${f.name}`)
      if (paths.length > 0) await supabaseAdmin.storage.from(SNAPSHOT_BUCKET).remove(paths)
      await supabaseAdmin.from("attendance_sheet_snapshots").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("period_closes").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_sheet_days").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_sheets").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("notifications").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("attendance_days").delete().eq("tenant_id", tid)
      // audit_logs 最後才刪（employees 之後、tenants 之前）：刪員工會再觸發 audit
      // trigger 寫新列，先刪 audit_logs 會留孤兒；tenants 刪掉後 is_disposable_tenant
      // 回 false，append-only trigger 就不放行了。
      await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
      await supabaseAdmin.from("tenants").delete().eq("id", tid)
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 120_000)

  describe("月表快照歷史", () => {
    it("approve → reopen → approve：attendance_sheet_snapshots 兩列 seq 1,2；GET /snapshots 列出", async () => {
      await approveFlow(sheetAId)
      const reopened = await asAdmin(request(app).post(`/attendance-sheets/${sheetAId}/reopen`)).send({ reason: "補打卡後重算" })
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200)
      expect(reopened.body.status).toBe("draft")
      // reopen 清掉 sheets.snapshot，但歷史留著
      const { data: mid } = await supabaseAdmin.from("attendance_sheets").select("snapshot").eq("id", sheetAId).single()
      expect(mid!.snapshot).toBeNull()
      await ackAllDays(tenantId)
      await approveFlow(sheetAId)

      const { data: rows, error } = await supabaseAdmin
        .from("attendance_sheet_snapshots")
        .select("seq, reason, employee_id, period, taken_by_emp_id, snapshot")
        .eq("tenant_id", tenantId)
        .eq("sheet_id", sheetAId)
        .order("seq")
      expect(error).toBeNull()
      expect(rows!.map((r) => r.seq)).toEqual([1, 2])
      expect(rows!.every((r) => r.reason === "approve" && r.employee_id === empAId && r.period === PERIOD && r.taken_by_emp_id === hrEmpId)).toBe(true)
      expect((rows![1].snapshot as { status: string }).status).toBe("approved")

      const listed = await asAdmin(request(app).get(`/attendance-sheets/${sheetAId}/snapshots`))
      expect(listed.status).toBe(200)
      expect(listed.body.snapshots).toHaveLength(2)
      expect(listed.body.snapshots.map((s: { seq: number }) => s.seq)).toEqual([1, 2])
      expect(listed.body.snapshots[0].snapshot).toBeUndefined()
      const full = await asAdmin(request(app).get(`/attendance-sheets/${sheetAId}/snapshots?full=1`))
      expect(full.body.snapshots[1].snapshot.status).toBe("approved")
      expect((await asEmployee(request(app).get(`/attendance-sheets/${sheetAId}/snapshots`))).status).toBe(403)
    }, 60_000)
  })

  describe("整公司月結 Final", () => {
    it("有 draft 月表 → 409 sheets_not_approved 附清單（HR 本人＋員工乙）", async () => {
      const res = await asAdmin(request(app).post("/attendance-sheets/close-period")).send({ period: PERIOD })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe("sheets_not_approved")
      const ids = (res.body.sheets as Array<{ employeeId: string; status: string }>).map((s) => s.employeeId).sort()
      expect(ids).toEqual([hrEmpId, empBId].sort())
      expect(res.body.sheets.every((s: { status: string }) => s.status === "draft")).toBe(true)
      expect((await asEmployee(request(app).post("/attendance-sheets/close-period")).send({ period: PERIOD })).status).toBe(403)
    })

    it("全部核准後 → 200、月表全 locked、period_closes 有列；GET /period-closes 看得到", async () => {
      await approveFlow((await sheetOf(hrEmpId, PERIOD)).id)
      await approveFlow((await sheetOf(empBId, PERIOD)).id)
      const res = await asAdmin(request(app).post("/attendance-sheets/close-period")).send({ period: PERIOD })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body).toMatchObject({ period: PERIOD, status: "closed", sheetCount: 3, lockedCount: 3, lockedNow: 3, skipped: [] })

      const { data: sheets } = await supabaseAdmin.from("attendance_sheets").select("status").eq("tenant_id", tenantId).eq("period", PERIOD)
      expect(sheets!.map((s) => s.status)).toEqual(["locked", "locked", "locked"])
      const { data: pc } = await supabaseAdmin.from("period_closes").select("status, sheet_count, locked_count, closed_by_emp_id").eq("tenant_id", tenantId).eq("period", PERIOD).single()
      expect(pc).toMatchObject({ status: "closed", sheet_count: 3, locked_count: 3, closed_by_emp_id: hrEmpId })

      const listed = await asAdmin(request(app).get(`/attendance-sheets/period-closes?period=${PERIOD}`))
      expect(listed.status).toBe(200)
      expect(listed.body.closes).toHaveLength(1)
      expect(listed.body.closes[0]).toMatchObject({ period: PERIOD, status: "closed", lockedCount: 3, closedByEmpId: hrEmpId })

      // 重跑冪等：已 locked 不動、數字覆蓋
      const again = await asAdmin(request(app).post("/attendance-sheets/close-period")).send({ period: PERIOD })
      expect(again.status).toBe(200)
      expect(again.body).toMatchObject({ lockedCount: 3, lockedNow: 0 })
    }, 60_000)

    it("reopen-period → reopened（月表仍 locked）；未月結的月份 → 404 period_not_closed", async () => {
      const res = await asAdmin(request(app).post("/attendance-sheets/reopen-period")).send({ period: PERIOD, reason: "老闆要補一筆加班" })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ period: PERIOD, status: "reopened", note: "老闆要補一筆加班" })
      const { data: sheets } = await supabaseAdmin.from("attendance_sheets").select("status").eq("tenant_id", tenantId).eq("period", PERIOD)
      expect(sheets!.every((s) => s.status === "locked")).toBe(true)
      const listed = await asAdmin(request(app).get("/attendance-sheets/period-closes"))
      expect(listed.body.closes.find((c: { period: string }) => c.period === PERIOD).status).toBe("reopened")
      expect((await asAdmin(request(app).post("/attendance-sheets/reopen-period")).send({ period: "2025-01", reason: "x" })).status).toBe(404)
    })

    it("force：只鎖已核准的（1/3），略過的記在 note", async () => {
      await approveFlow((await sheetOf(empAId, FORCE_PERIOD)).id)
      const blocked = await asAdmin(request(app).post("/attendance-sheets/close-period")).send({ period: FORCE_PERIOD })
      expect(blocked.status).toBe(409)
      const forced = await asAdmin(request(app).post("/attendance-sheets/close-period")).send({ period: FORCE_PERIOD, force: true })
      expect(forced.status, JSON.stringify(forced.body)).toBe(200)
      expect(forced.body).toMatchObject({ sheetCount: 3, lockedCount: 1, lockedNow: 1 })
      expect(forced.body.skipped).toHaveLength(2)
      expect(forced.body.note).toContain("強制月結")
      expect((await sheetOf(empBId, FORCE_PERIOD)).status).toBe("draft")
    }, 60_000)
  })

  describe("月度快照（內部端點）", () => {
    let manifest: SnapshotManifest
    const timings: number[] = []
    // 灌到超過一頁（PostgREST max-rows＝SNAPSHOT_PAGE_SIZE＝1000）的 audit_logs，
    // 逼分頁真的翻到第 2 頁；以前 pageSize 5000 在這裡會只備到 1000 列。
    const BULK_AUDIT_ROWS = SNAPSHOT_PAGE_SIZE + 200
    let auditCount = 0

    beforeAll(async () => {
      const rows = Array.from({ length: BULK_AUDIT_ROWS }, (_, i) => ({
        tenant_id: tenantId,
        table_name: "bk_bulk",
        record_id: crypto.randomUUID(),
        action: "INSERT",
        new_row: { i },
        context: "backups-live bulk",
      }))
      for (let i = 0; i < rows.length; i += 400) {
        const { error } = await supabaseAdmin.from("audit_logs").insert(rows.slice(i, i + 400))
        if (error) throw new Error(`bulk audit_logs insert: ${error.message}`)
      }
      auditCount = await countRows("audit_logs")
      expect(auditCount).toBeGreaterThan(SNAPSHOT_PAGE_SIZE)
    }, 60_000)

    it("帶 INTERNAL_JOB_TOKEN 迴圈到 done；每段 <20 秒", async () => {
      const bad = await request(app).post("/internal/backups/monthly-snapshot").set("x-internal-job-token", "wrong").send({ tenantId })
      expect(bad.status).toBe(401)

      let body: Record<string, unknown> = { tenantId, period: SNAPSHOT_PERIOD }
      let calls = 0
      let rowsWritten = 0
      for (;;) {
        calls += 1
        const started = Date.now()
        const res = await asInternal(request(app).post("/internal/backups/monthly-snapshot")).send(body)
        timings.push(Date.now() - started)
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        expect(res.body.tenantId).toBe(tenantId)
        expect(res.body.period).toBe(SNAPSHOT_PERIOD)
        rowsWritten += res.body.rowsWritten as number
        if (res.body.done) {
          expect(res.body.manifestPath).toBe(`${tenantId}/${SNAPSHOT_PERIOD}/manifest.json`)
          expect(res.body.nextTenantId).toBeUndefined()
          break
        }
        expect(calls).toBeLessThan(300)
        body = { tenantId, period: SNAPSHOT_PERIOD, table: res.body.nextTable, offset: res.body.nextOffset }
      }
      const max = Math.max(...timings)
      console.log(`[backups-live] monthly-snapshot: ${calls} call(s), rows=${rowsWritten}, per-call ms=${timings.join(",")}, max=${max}`)
      expect(max).toBeLessThan(20_000)
      expect(rowsWritten).toBeGreaterThan(0)
    }, 300_000)

    it("Storage 有各表 gz＋manifest；manifest 列數＝count(*)（抽三張表）；gz 解開列數／sha256 相符", async () => {
      const { data: files, error } = await supabaseAdmin.storage.from(SNAPSHOT_BUCKET).list(`${tenantId}/${SNAPSHOT_PERIOD}`, { limit: 1000 })
      expect(error).toBeNull()
      const names = (files ?? []).map((f) => f.name)
      expect(names).toContain("manifest.json")
      expect(names).toContain("employees.json.gz")
      expect(names).toContain("attendance_sheets.json.gz")
      expect(names).toContain("attendance_sheet_snapshots.json.gz")

      const { data: mf } = await supabaseAdmin.storage.from(SNAPSHOT_BUCKET).download(`${tenantId}/${SNAPSHOT_PERIOD}/manifest.json`)
      manifest = JSON.parse(await mf!.text()) as SnapshotManifest
      expect(manifest.status).toBe("complete")
      expect(manifest.generatedAt).toBeTruthy()
      expect(manifest.tenantId).toBe(tenantId)
      expect(manifest.schemaVersion.drizzle).toMatch(/^\d{4}_/)
      const done = manifest.tables.filter((t) => t.completedAt && !t.skipped).map((t) => t.name)
      expect(done.length).toBeGreaterThanOrEqual(SNAPSHOT_TABLES.length - 5)
      expect(manifest.totals.tables).toBe(done.length)

      for (const table of ["employees", "attendance_sheet_days", "attendance_sheet_snapshots"]) {
        const entry = manifest.tables.find((t) => t.name === table)!
        const expected = await countRows(table)
        expect(entry.rows, table).toBe(expected)
        expect(expected, table).toBeGreaterThan(0)
        const got = await downloadJsonGz(`${tenantId}/${SNAPSHOT_PERIOD}/${entry.files[0].path}`)
        expect(got.rows, table).toHaveLength(expected)
        expect(got.sha256, table).toBe(entry.sha256)
        expect(got.bytes, table).toBe(entry.bytes)
      }
      const tenantsEntry = manifest.tables.find((t) => t.name === "tenants")!
      expect(tenantsEntry.rows).toBe(1)
      const closes = manifest.tables.find((t) => t.name === "period_closes")!
      expect(closes.rows).toBe(2)
    }, 120_000)

    it("★ >1000 列的表（audit_logs）：manifest rows＝count(*)、拆成多個 part 檔、拼回列數相符、status 仍 complete", async () => {
      expect(manifest.pageSize).toBe(SNAPSHOT_PAGE_SIZE)
      expect(manifest.incompleteTables).toEqual([])
      const entry = manifest.tables.find((t) => t.name === "audit_logs")!
      expect(entry.skipped).toBeUndefined()
      expect(entry.incomplete).toBeFalsy()
      expect(entry.expectedRows).toBe(auditCount)
      expect(entry.rows).toBe(auditCount)
      expect(entry.rows).toBeGreaterThan(SNAPSHOT_PAGE_SIZE)
      expect(entry.files.length).toBe(Math.ceil(auditCount / SNAPSHOT_PAGE_SIZE))
      expect(entry.pages).toBe(entry.files.length)
      expect(entry.files.map((f) => f.path)).toEqual(entry.files.map((_, i) => `audit_logs.part-${String(i + 1).padStart(4, "0")}.json.gz`))
      let reassembled = 0
      const ids = new Set<string>()
      for (const f of entry.files) {
        const got = await downloadJsonGz(`${tenantId}/${SNAPSHOT_PERIOD}/${f.path}`)
        expect(got.rows, f.path).toHaveLength(f.rows)
        expect(got.sha256, f.path).toBe(f.sha256)
        reassembled += got.rows.length
        for (const r of got.rows as Array<{ id: string }>) ids.add(r.id)
      }
      expect(reassembled).toBe(auditCount)
      expect(ids.size).toBe(auditCount) // 逐頁不重疊、不漏
      // 表清單補了 bonus_runs／bonus_run_items（正式庫未套 0045 的環境會記 skipped，但一定有這兩列）
      expect(manifest.tables.map((t) => t.name)).toEqual(expect.arrayContaining(["bonus_runs", "bonus_run_items"]))
    }, 120_000)

    it("HR 端點：GET /backups 列出 2026-09 與 manifest；signed URL 可下載；非 HR 403", async () => {
      const list = await asAdmin(request(app).get("/backups"))
      expect(list.status).toBe(200)
      expect(list.body.tables).toEqual(SNAPSHOT_TABLES.map((t) => t.name))
      expect(list.body.retentionMonths).toBe(24)
      const entry = list.body.periods.find((p: { period: string }) => p.period === SNAPSHOT_PERIOD)
      expect(entry).toBeTruthy()
      expect(entry.manifest.status).toBe("complete")
      expect(entry.manifest.totals.rows).toBe(manifest.totals.rows)
      expect(entry.files.some((f: { name: string }) => f.name === "employees.json.gz")).toBe(true)

      const url = await asAdmin(request(app).get(`/backups/${SNAPSHOT_PERIOD}/files/manifest.json/url`))
      expect(url.status).toBe(200)
      expect(url.body.url).toMatch(/^https?:\/\//)
      const fetched = await fetch(url.body.url as string)
      expect(fetched.status).toBe(200)
      const viaUrl = (await fetched.json()) as SnapshotManifest
      expect(viaUrl.totals.rows).toBe(manifest.totals.rows)
      expect((await asAdmin(request(app).get(`/backups/${SNAPSHOT_PERIOD}/files/nope.json.gz/url`))).status).toBe(404)
      expect((await asAdmin(request(app).get(`/backups/${SNAPSHOT_PERIOD}/files/..%2Fx/url`))).status).toBe(400)

      expect((await asEmployee(request(app).get("/backups"))).status).toBe(403)
      expect((await asEmployee(request(app).post("/backups/run")).send({ period: SNAPSHOT_PERIOD })).status).toBe(403)
    }, 60_000)

    it("HR POST /backups/run 前端式迴圈重跑同月份 → 覆蓋且 manifest 仍 complete；不在新 manifest 的殘檔完成後才被清掉", async () => {
      // 模擬上一輪多出來的 part 檔：重跑不先清資料夾（中途失敗上一份仍在），完成後才 prune。
      const stale = `${tenantId}/${SNAPSHOT_PERIOD}/audit_logs.part-0099.json.gz`
      const { error: staleErr } = await supabaseAdmin.storage.from(SNAPSHOT_BUCKET).upload(stale, Buffer.from("stale"), { contentType: "application/gzip", upsert: true })
      expect(staleErr).toBeNull()

      let body: Record<string, unknown> = { period: SNAPSHOT_PERIOD }
      let calls = 0
      let last: Record<string, unknown> = {}
      for (;;) {
        calls += 1
        const res = await asAdmin(request(app).post("/backups/run")).send(body)
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        last = res.body
        if (res.body.done) break
        expect(calls).toBeLessThan(300)
        body = { period: SNAPSHOT_PERIOD, table: res.body.nextTable, offset: res.body.nextOffset }
      }
      expect(last.tenantId).toBe(tenantId)
      console.log(`[backups-live] HR rerun: ${calls} call(s), last=${JSON.stringify(last)}`)
      // 同路徑覆寫後 Supabase Storage 的 CDN 失效會慢 16～34 秒（物件先前被 signed URL 抓過時）：
      // service 端完成前會用 list() 的 ETag 核對回讀並等 CDN 追上，所以這裡的 GET /backups
      // 必須直接拿到新一輪的 manifest（generatedAt 較晚、多了 backups/run 那筆稽核列）。
      const after = await asAdmin(request(app).get("/backups"))
      const entry = after.body.periods.find((p: { period: string }) => p.period === SNAPSHOT_PERIOD)
      expect(entry.manifestStale).toBeUndefined()
      expect(entry.manifest.status).toBe("complete")
      expect(new Date(entry.manifest.generatedAt).getTime()).toBeGreaterThan(new Date(manifest.generatedAt!).getTime())
      const { data: audit } = await supabaseAdmin.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("context", "backups/run")
      expect((audit ?? []).length).toBeGreaterThanOrEqual(1)

      // 完成後：殘檔與 manifest.prev.json 都不在了；資料夾＝manifest.json＋manifest 列出的檔案
      const names = (entry.files as Array<{ name: string }>).map((f) => f.name)
      expect(names).not.toContain("audit_logs.part-0099.json.gz")
      expect(names).not.toContain(PREVIOUS_MANIFEST_FILE)
      const listed = new Set<string>(["manifest.json"])
      for (const t of (entry.manifest as SnapshotManifest).tables) for (const f of t.files) listed.add(f.path)
      expect([...names].sort()).toEqual([...listed].sort())
      // 重跑後 audit_logs 多了這輪 backups/run 的稽核列，仍等於 count(*)（>1000）
      const auditEntry = (entry.manifest as SnapshotManifest).tables.find((t) => t.name === "audit_logs")!
      expect(auditEntry.rows).toBe(await countRows("audit_logs"))
      expect(auditEntry.incomplete).toBeFalsy()
    }, 300_000)
  })
})
