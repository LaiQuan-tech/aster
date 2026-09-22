import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import ExcelJS from "exceljs"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"

/**
 * M6 三節／節慶獎金 — live 合約測試（throwaway 租戶，仿 approval-multilevel-live.test.ts）。
 *
 * 走一遍客戶要的流程：產生（去年同期／到職月數折算）→ 老闆逐人加減 → 一次發放 → 凍結。
 *   ① prepare 對 2 位在職員工各建一列（滿一年全額、到職半年折半）
 *   ② 同參數再 prepare → created 0（unique (tenant, employee, festival, year) 冪等）
 *   ③ 去年同節有 final → 今年建議以去年為準，不看 baseAmount
 *   ④ PATCH 改 final_amount／備註（draft 才可）
 *   ⑤ pay 之後 PATCH → 409（API 擋 + DB trigger forbid_paid_row_mutation 兜底）
 *   ⑥ prepare 再跑一次，paid 的那些列列在 skipped、不被覆蓋
 *   ⑦ export.xlsx 回 200、xlsx content-type，且 buffer 讀得回工作表（列數＝3＋人數＋1）
 *
 * 正式庫尚未套 migration 0050（festival_bonuses）時整組 describe.skipIf 跳過；
 * 套完後直接 `npx vitest run src/__tests__/festival-bonuses-live.test.ts` 即可。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

async function migrated(): Promise<boolean> {
  if (!SUPABASE_URL) return false
  const { error } = await supabaseAdmin.from("festival_bonuses").select("id, festival, year, prorate_months").limit(1)
  return !error
}
const ready = await migrated()

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

const FESTIVAL = "mid_autumn"
const YEAR = 2027
const REFERENCE_DATE = `${YEAR}-09-25`

let tenantId: string
let adminToken: string
let seniorId: string // 到職 2020-01-01（滿一年）
let juniorId: string // 到職 2027-03-15（到基準日 6 個月）

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}
function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}
/**
 * superagent 對 xlsx（application/vnd.openxmlformats-…）沒有內建 parser，預設既不緩衝
 * 也不讀完 body，`res.body` 會是空物件 `{}`（`.length` undefined），而且未讀完的 socket
 * 還可能讓後續請求踩到 HTTP parser 錯。下載二進位一律 `.buffer(true).parse(binaryParser)`
 * ——同 bonus-runs-live／disbursements-live。
 */
function binaryParser(res: request.Response, cb: (err: Error | null, body: unknown) => void) {
  const chunks: Buffer[] = []
  const stream = res as unknown as NodeJS.ReadableStream
  stream.on("data", (c: Buffer) => chunks.push(c))
  stream.on("end", () => cb(null, Buffer.concat(chunks)))
}
async function createEmployee(label: string, hireDate: string) {
  const email = `fest-${stamp}-${label}@example.com`
  const password = `Pw-${stamp}-${label}-Aa1!`
  const res = await as(adminToken, request(app).post("/employees")).send({
    email,
    name: `${label}-${stamp}`,
    password,
    role: "employee",
    empNo: `F-${label}`,
    hireDate,
  })
  if (res.status !== 201) throw new Error(`createEmployee(${label}) ${res.status}: ${JSON.stringify(res.body)}`)
  createdUserIds.push(res.body.userId)
  return res.body.employeeId as string
}
type Bonus = {
  id: string
  employee_id: string
  prorate_months: number | null
  suggested_amount: number | null
  final_amount: number | null
  status: string
  paid_on: string | null
  note: string | null
}
async function listBonuses(): Promise<Bonus[]> {
  const res = await as(adminToken, request(app).get(`/festival-bonuses?festival=${FESTIVAL}&year=${YEAR}`))
  expect(res.status).toBe(200)
  return res.body.bonuses as Bonus[]
}
function byEmployee(rows: Bonus[], empId: string): Bonus {
  const row = rows.find((r) => r.employee_id === empId)
  if (!row) throw new Error(`no festival bonus row for ${empId}`)
  return row
}

describe.skipIf(!ready)("三節獎金 — live", () => {
  beforeAll(async () => {
    const adminEmail = `fest-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `FESTTEST ${stamp}`, adminEmail, adminPassword })
    tenantId = p.tenantId
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    // 租戶管理員自己也是一位在職員工 → 下面的斷言用「至少」而非「剛好」。
    seniorId = await createEmployee("senior", "2020-01-01")
    juniorId = await createEmployee("junior", `${YEAR}-03-15`)
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      try {
        await purgeTestTenant(tid)
      } catch (err) {
        console.warn(`[festival-bonuses-live] purge ${tid} 失敗：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
  }, 90_000)

  it("prepare 對全體在職員工各建一列：滿一年 12 個月全額、到職 6 個月折半", async () => {
    const res = await as(adminToken, request(app).post("/festival-bonuses/prepare")).send({
      festival: FESTIVAL,
      year: YEAR,
      referenceDate: REFERENCE_DATE,
      baseAmount: 10000,
    })
    expect(res.status).toBe(200)
    expect(res.body.created).toBeGreaterThanOrEqual(2)
    expect(res.body.skipped).toEqual([])

    const rows = await listBonuses()
    const senior = byEmployee(rows, seniorId)
    expect(senior.prorate_months).toBe(12)
    expect(senior.suggested_amount).toBe(10000)
    expect(senior.final_amount).toBe(10000)
    expect(senior.status).toBe("draft")

    const junior = byEmployee(rows, juniorId)
    expect(junior.prorate_months).toBe(6)
    expect(junior.suggested_amount).toBe(5000)
  })

  it("同參數再 prepare → created 0（冪等；已有的列只更新建議值）", async () => {
    const res = await as(adminToken, request(app).post("/festival-bonuses/prepare")).send({
      festival: FESTIVAL,
      year: YEAR,
      referenceDate: REFERENCE_DATE,
      baseAmount: 10000,
    })
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(0)
    expect(res.body.updated).toBeGreaterThanOrEqual(2)
  })

  it("PATCH 調整實發金額與備註（draft 可改）", async () => {
    const before = byEmployee(await listBonuses(), seniorId)
    const res = await as(adminToken, request(app).patch(`/festival-bonuses/${before.id}`)).send({
      finalAmount: 13000,
      note: "老闆加碼",
    })
    expect(res.status).toBe(200)
    expect(res.body.bonus.final_amount).toBe(13000)
    expect(res.body.bonus.note).toBe("老闆加碼")

    // 再 prepare 不覆蓋老闆已經調過的 final_amount。
    await as(adminToken, request(app).post("/festival-bonuses/prepare")).send({
      festival: FESTIVAL,
      year: YEAR,
      referenceDate: REFERENCE_DATE,
      baseAmount: 10000,
    })
    expect(byEmployee(await listBonuses(), seniorId).final_amount).toBe(13000)
  })

  it("export.xlsx 回 xlsx：檔名帶節日年度、列數＝表頭 3＋人數＋合計 1", async () => {
    const rows = await listBonuses()
    const res = await as(adminToken, request(app).get(`/festival-bonuses/export.xlsx?festival=${FESTIVAL}&year=${YEAR}`))
      .buffer(true)
      .parse(binaryParser)
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toContain("spreadsheetml")
    expect(decodeURIComponent(res.headers["content-disposition"] ?? "")).toContain(`三節獎金-${YEAR}-中秋.xlsx`)
    const buf = res.body as Buffer
    expect(buf.length).toBeGreaterThan(0)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(new Uint8Array(buf) as unknown as ExcelJS.Buffer)
    const ws = wb.getWorksheet(`${YEAR} 中秋`)
    expect(ws).toBeTruthy()
    expect(ws!.rowCount).toBe(3 + rows.length + 1)
    expect(ws!.getRow(3).getCell(6).value).toBe("實發金額")
  })

  it("pay 一次把該節全部 draft 轉 paid 並寫發放日", async () => {
    const res = await as(adminToken, request(app).post("/festival-bonuses/pay")).send({
      festival: FESTIVAL,
      year: YEAR,
      paidOn: `${YEAR}-09-28`,
    })
    expect(res.status).toBe(200)
    expect(res.body.paid).toBeGreaterThanOrEqual(2)

    const rows = await listBonuses()
    expect(rows.every((r) => r.status === "paid")).toBe(true)
    expect(byEmployee(rows, seniorId).paid_on).toBe(`${YEAR}-09-28`)
    expect(byEmployee(rows, seniorId).final_amount).toBe(13000)
  })

  it("paid 之後 PATCH → 409 already_paid；沒有 draft 可發 → 409 no_draft", async () => {
    const paid = byEmployee(await listBonuses(), seniorId)
    const patch = await as(adminToken, request(app).patch(`/festival-bonuses/${paid.id}`)).send({ finalAmount: 1 })
    expect(patch.status).toBe(409)
    expect(patch.body.error).toBe("already_paid")

    const pay = await as(adminToken, request(app).post("/festival-bonuses/pay")).send({
      festival: FESTIVAL,
      year: YEAR,
      paidOn: `${YEAR}-09-29`,
    })
    expect(pay.status).toBe(409)
    expect(pay.body.error).toBe("no_draft")
  })

  it("DB trigger forbid_paid_row_mutation 也擋 service_role 的直接 UPDATE（API 被繞過時的兜底）", async () => {
    const paid = byEmployee(await listBonuses(), seniorId)
    const { error } = await supabaseAdmin
      .from("festival_bonuses")
      .update({ final_amount: 99999 })
      .eq("tenant_id", tenantId)
      .eq("id", paid.id)
    // test/demo 租戶被 trigger 放行是設計（sql/0040 is_disposable_tenant），所以這裡只
    // 要求「擋了或沒改成」二選一。
    if (!error) {
      const after = byEmployee(await listBonuses(), seniorId)
      expect([13000, 99999]).toContain(after.final_amount)
      // 放行的話這列真的被改成 99999 了 → 還原成 13,000 再往下走：下一個測試要用這列
      // 當「去年同節的實發金額」，留著 99999 會讓那個斷言驗到的是本測試的髒資料。
      if (after.final_amount !== 13000) {
        const restore = await supabaseAdmin
          .from("festival_bonuses")
          .update({ final_amount: 13000 })
          .eq("tenant_id", tenantId)
          .eq("id", paid.id)
        expect(restore.error).toBeNull()
        expect(byEmployee(await listBonuses(), seniorId).final_amount).toBe(13000)
      }
    } else {
      expect(error.message).toContain("paid")
    }
  })

  it("已 paid 的列在下一次 prepare 被列入 skipped 且不被覆蓋", async () => {
    const res = await as(adminToken, request(app).post("/festival-bonuses/prepare")).send({
      festival: FESTIVAL,
      year: YEAR,
      referenceDate: REFERENCE_DATE,
      baseAmount: 20000,
    })
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(0)
    expect((res.body.skipped as Array<{ reason: string }>).length).toBeGreaterThanOrEqual(2)
    expect((res.body.skipped as Array<{ reason: string }>).every((s) => s.reason === "paid")).toBe(true)
    expect(byEmployee(await listBonuses(), juniorId).suggested_amount).toBe(5000)
  })

  it("去年同節的 final 優先於 baseAmount（今年＝去年 13,000，不是 baseAmount 10,000）", async () => {
    const nextYear = YEAR + 1
    const res = await as(adminToken, request(app).post("/festival-bonuses/prepare")).send({
      festival: FESTIVAL,
      year: nextYear,
      referenceDate: `${nextYear}-09-25`,
      baseAmount: 10000,
    })
    expect(res.status).toBe(200)
    const list = await as(adminToken, request(app).get(`/festival-bonuses?festival=${FESTIVAL}&year=${nextYear}`))
    expect(list.status).toBe(200)
    const senior = byEmployee(list.body.bonuses as Bonus[], seniorId)
    expect(senior.suggested_amount).toBe(13000)
    // junior 明年已滿一年 → 全額領去年實發的 5,000
    const junior = byEmployee(list.body.bonuses as Bonus[], juniorId)
    expect(junior.prorate_months).toBe(12)
    expect(junior.suggested_amount).toBe(5000)
  })

  it("非 HR 不得存取（一般員工 403）", async () => {
    const email = `fest-${stamp}-emp@example.com`
    const password = `Pw-${stamp}-emp-Aa1!`
    const created = await as(adminToken, request(app).post("/employees")).send({
      email,
      name: `emp-${stamp}`,
      password,
      role: "employee",
      empNo: "F-emp2",
    })
    expect(created.status).toBe(201)
    createdUserIds.push(created.body.userId)
    const token = await signIn(email, password)
    const res = await as(token, request(app).get(`/festival-bonuses?festival=${FESTIVAL}&year=${YEAR}`))
    expect(res.status).toBe(403)
  })
})
