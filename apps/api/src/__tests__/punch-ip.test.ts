import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { punchRouter } from "../routes/punch.js"
import { fake, OTHER_TENANT_ID, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 打卡來源 IP（packages/db 0060 punch_records.ip_address）：
 *   • POST /punch 記 IP（x-forwarded-for 第一段 → x-real-ip → req.ip，不合法存 null）；
 *   • 補登（/punch/manual、/punch/manual/import）不記；
 *   • IP 只在 HR 的後台列表（GET /punch 非 mine）以 ipAddress 回出，員工端任何回應都沒有。
 * ⚠️ 位址一律用文件保留段：IPv4 203.0.113.0/24、198.51.100.0/24，IPv6 2001:db8::/32。
 */
const app = express()
app.use(express.json())
app.use(punchRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const HR_TOKEN = "hr-user"
const EMP_TOKEN = "emp-user"
const EMP2_TOKEN = "emp2-user"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const EMP_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const EMP2_ID = "bbbbbbbb-0000-4000-8000-000000000003"

const as = (token: string) => (req: request.Test) => req.set("Authorization", `Bearer ${token}`)
const asHr = as(HR_TOKEN)
const asEmp = as(EMP_TOKEN)

// 冷卻（連按防呆）關掉，同一個測試才能連打兩筆；結束後還原。
const COOLDOWN_ENV = "PUNCH_COOLDOWN_SECONDS"
let savedCooldown: string | undefined
beforeAll(() => {
  savedCooldown = process.env[COOLDOWN_ENV]
  process.env[COOLDOWN_ENV] = "0"
})
afterAll(() => {
  if (savedCooldown === undefined) delete process.env[COOLDOWN_ENV]
  else process.env[COOLDOWN_ENV] = savedCooldown
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR_TOKEN, role: "hr_admin", dept_id: null },
    { id: EMP_ID, tenant_id: TENANT_ID, user_id: EMP_TOKEN, role: "employee", dept_id: null },
    { id: EMP2_ID, tenant_id: TENANT_ID, user_id: EMP2_TOKEN, role: "employee", dept_id: null },
  ]
  fake.db.punch_records = []
})

function punchInserts() {
  return fake.writes.filter((write) => write.table === "punch_records" && write.action === "insert")
}
/** 每一筆寫進 punch_records 的 payload（單筆或批次都攤平成陣列）。 */
function insertedRows(): Array<Record<string, unknown>> {
  return punchInserts().flatMap((write) => (Array.isArray(write.payload) ? write.payload : [write.payload])) as Array<Record<string, unknown>>
}
/** 寫入時帶的 ip_address；沒帶這個鍵視同 null（DB 欄位無預設值，缺鍵＝NULL）。 */
const ipWritten = (row: Record<string, unknown> | undefined) => (row && "ip_address" in row ? row.ip_address : null)

const hasIpKey = (record: Record<string, unknown>) => "ip_address" in record || "ipAddress" in record

describe("POST /punch — 記錄打卡 IP", () => {
  const punchFrom = (headers: Record<string, string>) => {
    let req = asEmp(request(app).post("/punch")).send({ type: "in" })
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value)
    return req
  }

  it("x-forwarded-for 多段：只取第一段（前後空白先 trim）", async () => {
    const res = await punchFrom({ "x-forwarded-for": "  203.0.113.7 , 198.51.100.1, 198.51.100.2" })

    expect(res.status).toBe(201)
    expect(insertedRows()).toHaveLength(1)
    expect(insertedRows()[0]).toMatchObject({ tenant_id: TENANT_ID, employee_id: EMP_ID, type: "in", source: "web", ip_address: "203.0.113.7" })
    // 真的寫進資料庫那一列
    expect(fake.db.punch_records?.[0]?.ip_address).toBe("203.0.113.7")
  })

  it("IPv6：單一位址與多段第一段都收", async () => {
    await punchFrom({ "x-forwarded-for": "2001:db8::1" })
    await punchFrom({ "x-forwarded-for": "2001:db8:85a3::8a2e:370:7334, 203.0.113.9" })

    expect(insertedRows().map((row) => row.ip_address)).toEqual(["2001:db8::1", "2001:db8:85a3::8a2e:370:7334"])
  })

  it.each([
    ["亂寫的字串", "not-an-ip"],
    ["unknown", "unknown"],
    ["IPv4 欄位超出範圍", "999.999.999.999"],
    ["帶連接埠", "203.0.113.7:8080"],
    ["SQL 字樣", "'; drop table punch_records;--"],
    ["超過 64 字", `2001:db8::1%${"z".repeat(60)}`],
  ])("垃圾值（%s）：存 null，打卡本身照常成功", async (_label, value) => {
    const res = await punchFrom({ "x-forwarded-for": value })

    expect(res.status).toBe(201)
    expect(insertedRows()).toHaveLength(1)
    expect(insertedRows()[0]).toHaveProperty("ip_address", null)
    expect(fake.db.punch_records?.[0]?.ip_address).toBeNull()
  })

  it("垃圾的 x-forwarded-for 不會退到合法的 x-real-ip（記不明，不記錯的）", async () => {
    await punchFrom({ "x-forwarded-for": "garbage", "x-real-ip": "203.0.113.20" })

    expect(insertedRows()[0]).toHaveProperty("ip_address", null)
  })

  it("沒有 x-forwarded-for 時退到 x-real-ip", async () => {
    await punchFrom({ "x-real-ip": "203.0.113.20" })

    expect(insertedRows()[0]).toHaveProperty("ip_address", "203.0.113.20")
  })

  it("兩個 header 都沒有：用連線對端（req.ip），存的是合法的本機位址", async () => {
    await punchFrom({})

    expect(["127.0.0.1", "::1"]).toContain(insertedRows()[0]?.ip_address)
  })

  it("員工自己的 201 回應不帶 IP：本體與 record 都沒有 ip_address／ipAddress，record 其餘欄位照舊", async () => {
    const res = await punchFrom({ "x-forwarded-for": "203.0.113.7" })

    expect(res.status).toBe(201)
    expect(hasIpKey(res.body)).toBe(false)
    expect(hasIpKey(res.body.record)).toBe(false)
    expect(res.body.record).toMatchObject({ id: res.body.id, employee_id: EMP_ID, tenant_id: TENANT_ID, type: "in", source: "web" })
    // 但資料庫那一列確實有記
    expect(fake.db.punch_records?.[0]?.ip_address).toBe("203.0.113.7")
  })
})

describe("補登與匯入不記 IP", () => {
  it("POST /punch/manual：即使請求帶了 x-forwarded-for，寫入也沒有 IP", async () => {
    const res = await asHr(request(app).post("/punch/manual"))
      .set("x-forwarded-for", "203.0.113.7")
      .send({ employeeId: EMP_ID, punchAt: "2026-10-01T01:00:00.000Z", type: "in" })

    expect(res.status).toBe(201)
    expect(insertedRows()).toHaveLength(1)
    expect(insertedRows()[0]).toMatchObject({ employee_id: EMP_ID, source: "manual" })
    expect(ipWritten(insertedRows()[0])).toBeNull()
    expect(fake.db.punch_records?.[0]?.ip_address ?? null).toBeNull()
  })

  it("POST /punch/manual/import：每一列都沒有 IP", async () => {
    const csv = [
      "employeeId,punchAt,type",
      `${EMP_ID},2026-10-01T01:00:00.000Z,in`,
      `${EMP2_ID},2026-10-01T10:00:00.000Z,out`,
    ].join("\n")
    const res = await asHr(request(app).post("/punch/manual/import")).set("x-forwarded-for", "203.0.113.7").send({ csv })

    expect(res.status).toBe(201)
    expect(res.body.count).toBe(2)
    expect(insertedRows()).toHaveLength(2)
    for (const row of insertedRows()) {
      expect(row).toMatchObject({ source: "manual" })
      expect(ipWritten(row)).toBeNull()
    }
  })
})

describe("IP 只回給 HR 的後台列表（ipAddress）", () => {
  const NOW = new Date().toISOString()
  const row = (id: string, employeeId: string, extra: Record<string, unknown> = {}) => ({
    id,
    tenant_id: TENANT_ID,
    employee_id: employeeId,
    punch_at: NOW,
    type: "in",
    source: "web",
    lat: null,
    lng: null,
    device_id: null,
    geo_status: null,
    ip_address: null,
    ...extra,
  })

  beforeEach(() => {
    fake.db.punch_records = [
      row("r1", EMP_ID, { ip_address: "203.0.113.7" }),
      row("r2", EMP2_ID, { source: "manual", ip_address: null }),
      row("r3", HR_ID, { ip_address: "198.51.100.9" }),
      row("r4", EMP_ID, { tenant_id: OTHER_TENANT_ID, ip_address: "203.0.113.99" }),
    ]
  })

  const records = (res: request.Response) => res.body.records as Array<Record<string, unknown>>
  const byId = (res: request.Response) => Object.fromEntries(records(res).map((r) => [r.id as string, r]))

  it("HR（後台列表、沒帶 mine）：每列都有 ipAddress（沒記的是 null），且沒有原始的 ip_address；不含別租戶", async () => {
    const res = await asHr(request(app).get("/punch")).query({ order: "desc" })

    expect(res.status).toBe(200)
    expect(records(res)).toHaveLength(3)
    const rows = byId(res)
    expect(rows.r1).toMatchObject({ employee_id: EMP_ID, ipAddress: "203.0.113.7" })
    expect(rows.r2).toMatchObject({ employee_id: EMP2_ID, ipAddress: null })
    expect(rows.r3).toMatchObject({ employee_id: HR_ID, ipAddress: "198.51.100.9" })
    for (const r of records(res)) {
      expect(r).toHaveProperty("ipAddress")
      expect("ip_address" in r).toBe(false)
    }
    expect(rows.r4).toBeUndefined()
  })

  it("HR 篩單一員工：只回該員工的列，仍帶 ipAddress", async () => {
    const res = await asHr(request(app).get("/punch")).query({ employeeId: EMP_ID })

    expect(res.status).toBe(200)
    expect(records(res).map((r) => r.id)).toEqual(["r1"])
    expect(records(res)[0]).toMatchObject({ ipAddress: "203.0.113.7" })
  })

  it("HR 帶 mine=1（員工端看自己）：只有自己的列，且沒有任何 IP 欄位", async () => {
    const res = await asHr(request(app).get("/punch")).query({ mine: "1" })

    expect(res.status).toBe(200)
    expect(records(res).map((r) => r.id)).toEqual(["r3"])
    expect(hasIpKey(records(res)[0] as Record<string, unknown>)).toBe(false)
  })

  it("非 HR 員工：只拿得到自己的列，沒有 ipAddress／ip_address（就算庫裡有記）", async () => {
    const res = await asEmp(request(app).get("/punch"))

    expect(res.status).toBe(200)
    expect(records(res).map((r) => r.id)).toEqual(["r1"])
    expect(hasIpKey(records(res)[0] as Record<string, unknown>)).toBe(false)
    expect(JSON.stringify(res.body)).not.toContain("203.0.113.7")
  })

  it("非 HR 員工硬帶別人的 employeeId、deptId 也一樣：只有自己的列、沒有 IP", async () => {
    const res = await asEmp(request(app).get("/punch")).query({ employeeId: EMP2_ID })

    expect(res.status).toBe(200)
    expect(records(res).map((r) => r.id)).toEqual(["r1"])
    expect(records(res).some(hasIpKey)).toBe(false)
  })

  it("員工的 GET /punch/today：沒有 IP 欄位", async () => {
    const res = await asEmp(request(app).get("/punch/today"))

    expect(res.status).toBe(200)
    expect(records(res).map((r) => r.id)).toEqual(["r1"])
    expect(records(res).some(hasIpKey)).toBe(false)
    expect(JSON.stringify(res.body)).not.toContain("203.0.113.7")
  })

  it("HR 的 GET /punch/today（看自己）也沒有 IP 欄位", async () => {
    const res = await asHr(request(app).get("/punch/today"))

    expect(res.status).toBe(200)
    expect(records(res).map((r) => r.id)).toEqual(["r3"])
    expect(records(res).some(hasIpKey)).toBe(false)
  })
})
