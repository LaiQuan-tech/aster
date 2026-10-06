import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 員工列表的個資欄位（idNumber／registeredAddress／birthday／bankCode／bankName／
 * bankAccount／accountHolder）與匯款帳號寫入（2026-10-07）。
 *
 *   GET /employees?include=profile
 *     • HR／平台管理員／會計拿得到七個欄位（每人一組，沒資料＝null）。
 *     • 不帶 include＝回應與以前完全一樣（後台約 30 個頁面、ESS 人員挑選都只拿來對照姓名）。
 *     • 一般員工／主管：路由層 requireFinance 直接 403；就算日後路由被放寬，handler 內
 *       的 isFinanceRole 判斷仍讓他們拿不到任何個資鍵，而且根本不去查 employee_profiles。
 *     • 批次：一批 100 人一次查詢，不是每人一查。
 *   PUT /employees/:empId/profile：接受匯款四欄；既有「非 HR 改資料需審核」邏輯對新區塊同樣成立。
 *
 * lib/supabase.js 換成記憶體假 PostgREST，**不碰任何 DB**；requireAuth／requireTenant／
 * requireRole 照跑（Bearer token 直接當 user id）。所有識別碼、姓名、證號、帳號都是明顯的假值。
 */

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  type Op = "select" | "insert" | "upsert" | "update"
  type Filter = { kind: "eq" | "in"; col: string; val: unknown }
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const OTHER_TENANT = "99999999-9999-4999-8999-999999999999"
  const ids = {
    hr: "aaaaaaaa-1111-4111-8111-aaaaaaaa0001",
    platform: "aaaaaaaa-1111-4111-8111-aaaaaaaa0002",
    accountant: "aaaaaaaa-1111-4111-8111-aaaaaaaa0003",
    manager: "aaaaaaaa-1111-4111-8111-aaaaaaaa0004",
    staff: "aaaaaaaa-1111-4111-8111-aaaaaaaa0005",
    other: "aaaaaaaa-1111-4111-8111-aaaaaaaa0006",
  }
  const db: Record<string, Row[]> = {}
  const calls: Array<{ table: string; op: Op; cols: string; filters: Filter[]; payload?: unknown }> = []
  const enqueued: Array<Record<string, any>> = []
  // true＝模擬「有人把 GET /employees 的路由層守門放寬成任何登入員工都能列」。
  const guard = { relaxFinance: false }
  let seq = 0

  function fakeFrom(table: string) {
    let op: Op = "select"
    let cols = "*"
    let payload: unknown
    let conflict: string[] = []
    const filters: Filter[] = []
    const preds: Array<(r: Row) => boolean> = []
    const matching = () => (db[table] ?? []).filter((r) => preds.every((p) => p(r)))
    // 仿 PostgREST：select 只回要的欄位（沒值＝null）；「*」回整列複本。
    const pick = (r: Row): Row =>
      cols === "*"
        ? { ...r }
        : Object.fromEntries(
            cols
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
              .map((c) => [c, r[c] ?? null]),
          )

    function run(): { data: Row[]; error: null } {
      calls.push({ table, op, cols, filters: [...filters], payload })
      const rows = (db[table] ??= [])
      if (op === "select") return { data: matching().map(pick), error: null }
      if (op === "insert") {
        const created = ((Array.isArray(payload) ? payload : [payload]) as Row[]).map((r) => ({ id: `gen-${++seq}`, ...r }))
        rows.push(...created)
        return { data: created.map(pick), error: null }
      }
      if (op === "upsert") {
        const row = payload as Row
        const existing = rows.find((r) => conflict.every((c) => r[c] === row[c]))
        if (existing) {
          Object.assign(existing, row)
          return { data: [pick(existing)], error: null }
        }
        const created = { id: `gen-${++seq}`, ...row }
        rows.push(created)
        return { data: [pick(created)], error: null }
      }
      const hit = matching()
      for (const r of hit) Object.assign(r, payload)
      return { data: hit.map(pick), error: null }
    }

    const builder: any = {
      select: (c = "*") => ((cols = c), builder),
      insert: (p: unknown) => ((op = "insert"), (payload = p), builder),
      upsert: (p: unknown, opts?: { onConflict?: string }) => (
        (op = "upsert"),
        (payload = p),
        (conflict = String(opts?.onConflict ?? "id").split(",").map((s) => s.trim())),
        builder
      ),
      update: (p: unknown) => ((op = "update"), (payload = p), builder),
      eq: (col: string, val: unknown) => (filters.push({ kind: "eq", col, val }), preds.push((r) => r[col] === val), builder),
      in: (col: string, vals: unknown[]) => (filters.push({ kind: "in", col, val: vals }), preds.push((r) => vals.includes(r[col])), builder),
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      single: async () => {
        const first = run().data[0]
        return first ? { data: first, error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } }
      },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    }
    return builder
  }

  return { TENANT, OTHER_TENANT, ids, db, calls, enqueued, guard, fakeFrom }
})

vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: (table: string) => h.fakeFrom(table) },
  getUserFromToken: async (token: string) =>
    token ? { userId: token, email: null, appMetadata: { tenant_id: h.TENANT } } : null,
}))

// email 在 auth.users：這個測試只關心個資欄位，換成確定性的假 email。
vi.mock("../services/employee-emails.js", () => ({
  emailsByUserId: async (userIds: string[]) => new Map(userIds.map((id) => [id, `${id}@example.test`])),
}))

vi.mock("../services/notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/notify.js")>()),
  enqueue: async (input: Record<string, any>) => {
    h.enqueued.push(input)
    return 1
  },
}))

vi.mock("../middleware/role.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/role.js")>()
  return {
    ...actual,
    requireFinance: (req: Request, res: Response, next: NextFunction) =>
      h.guard.relaxFinance ? next() : actual.requireFinance(req, res, next),
  }
})

import { employeesRouter } from "../routes/employees.js"
import { employeeProfileRouter } from "../routes/employee-profile.js"

const { ids } = h

const app = express()
app.use(express.json())
app.use(employeesRouter, employeeProfileRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

// supertest 對「還沒 listen 的 app」會自己 listen(0)；macOS 上偶發被別的程式接走同 port 的請求，
// 所以自己先綁 127.0.0.1（同 ess-scope-mine.test.ts）。
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const PERSONAL_KEYS = ["idNumber", "registeredAddress", "birthday", "bankCode", "bankName", "bankAccount", "accountHolder"] as const
// 這些假值若出現在不該出現的回應裡，就是外洩。
const SECRET_STRINGS = ["A123456789", "0000000000", "測試市測試區測試路1號", "測試銀行", "測試戶名"]

function get(path: string, userId: string) {
  return request(server).get(path).set("Authorization", `Bearer ${userId}`)
}
function put(path: string, userId: string, body: unknown) {
  return request(server).put(path).set("Authorization", `Bearer ${userId}`).send(body as object)
}
const profileReads = () => h.calls.filter((c) => c.table === "employee_profiles" && c.op === "select")
const profileWrites = () => h.calls.filter((c) => c.table === "employee_profiles" && c.op !== "select")
const row = (list: any[], id: string) => list.find((e) => e.id === id)

beforeEach(() => {
  const t = h.TENANT
  const emp = (id: string, userId: string, role: string, name: string) => ({
    id,
    tenant_id: t,
    user_id: userId,
    role,
    name,
    dept_id: null,
    emp_no: null,
    employment_type: "regular",
    hire_date: null,
    terminated_at: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
  })
  h.db.employees = [
    emp(ids.hr, "user-hr", "hr_admin", "測試HR"),
    emp(ids.platform, "user-platform", "platform_admin", "測試平台"),
    emp(ids.accountant, "user-accountant", "accountant", "測試會計"),
    emp(ids.manager, "user-manager", "manager", "測試主管"),
    emp(ids.staff, "user-staff", "employee", "測試員工甲"),
    emp(ids.other, "user-other", "employee", "測試員工乙"),
  ]
  h.db.employee_profiles = [
    {
      id: "prof-staff",
      tenant_id: t,
      employee_id: ids.staff,
      id_number: "A123456789",
      registered_address: "測試市測試區測試路1號",
      birthday: "2000-01-01",
      bank_code: "000",
      bank_name: "測試銀行",
      bank_account: "0000000000",
      account_holder: "測試戶名",
      phone: "0900000000", // 不在清單的欄位，不得出現在 GET /employees
    },
    // 只填了生日（其餘為 null／空字串）。
    { id: "prof-hr", tenant_id: t, employee_id: ids.hr, birthday: "1990-05-05", id_number: "", bank_account: null },
    // 別租戶、同一個 employee_id 的列：租戶條件擋不住就會把這組值帶出來。
    {
      id: "prof-other-tenant",
      tenant_id: h.OTHER_TENANT,
      employee_id: ids.staff,
      id_number: "Z999999999",
      bank_account: "9999999999",
    },
  ]
  h.db.tenants = [{ id: t, features: {} }]
  h.db.employee_profile_change_requests = []
  h.calls.length = 0
  h.enqueued.length = 0
  h.guard.relaxFinance = false
})

describe("GET /employees?include=profile — 個資欄位只給 HR／財會", () => {
  it.each([
    ["HR", "user-hr"],
    ["平台管理員", "user-platform"],
    ["會計", "user-accountant"],
  ])("%s：每位員工都帶七個個資欄位（有資料的帶值，沒有的為 null）", async (_label, caller) => {
    const res = await get("/employees?include=profile", caller)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const list = res.body.employees as any[]
    expect(list).toHaveLength(6)
    for (const e of list) for (const key of PERSONAL_KEYS) expect(e, `${e.name} 缺 ${key}`).toHaveProperty(key)

    // 帶了個資的回應不准被快取落地；沒帶個資的清單維持原樣（見下方「不帶 include」案例）。
    expect(res.headers["cache-control"]).toBe("no-store")

    expect(row(list, ids.staff)).toMatchObject({
      idNumber: "A123456789",
      registeredAddress: "測試市測試區測試路1號",
      birthday: "2000-01-01",
      bankCode: "000",
      bankName: "測試銀行",
      bankAccount: "0000000000",
      accountHolder: "測試戶名",
    })
    // 只有生日；空字串、null 一律回 null。
    expect(row(list, ids.hr)).toMatchObject({
      birthday: "1990-05-05",
      idNumber: null,
      bankAccount: null,
      registeredAddress: null,
    })
    // 沒有 employee_profiles 列的員工：七個鍵都在、都是 null。
    for (const key of PERSONAL_KEYS) expect(row(list, ids.other)[key]).toBeNull()
  })

  it("原本的欄位不受影響（email 仍在）；不在清單的 profile 欄位（phone）不會跟著出現", async () => {
    const res = await get("/employees?include=profile", "user-hr")
    const staff = row(res.body.employees, ids.staff)
    expect(staff.email).toBe("user-staff@example.test")
    expect(staff.name).toBe("測試員工甲")
    expect(staff).not.toHaveProperty("phone")
    expect(JSON.stringify(res.body)).not.toContain("0900000000")
  })

  it("租戶條件：別租戶同 employee_id 的 profile 列不會被帶出", async () => {
    const res = await get("/employees?include=profile", "user-hr")
    const text = JSON.stringify(res.body)
    expect(text).not.toContain("Z999999999")
    expect(text).not.toContain("9999999999")
    const read = profileReads()[0]
    expect(read.filters).toContainEqual({ kind: "eq", col: "tenant_id", val: h.TENANT })
  })

  it("不帶 include：回應與以前一樣，任何個資鍵都不存在、也不查 employee_profiles", async () => {
    const res = await get("/employees", "user-hr")
    expect(res.status).toBe(200)
    for (const e of res.body.employees) for (const key of PERSONAL_KEYS) expect(e).not.toHaveProperty(key)
    for (const secret of SECRET_STRINGS) expect(JSON.stringify(res.body)).not.toContain(secret)
    expect(profileReads()).toHaveLength(0)
    expect(res.headers["cache-control"]).toBeUndefined()
  })

  it("include 的值不是 profile（或亂帶）：等同沒帶；include=a,profile 才算", async () => {
    const none = await get("/employees?include=salary", "user-hr")
    expect(none.body.employees[0]).not.toHaveProperty("idNumber")
    const multi = await get("/employees?include=foo,profile", "user-hr")
    expect(row(multi.body.employees, ids.staff).idNumber).toBe("A123456789")
  })
})

describe("GET /employees — 非 HR／財會拿不到個資", () => {
  it.each([
    ["一般員工", "user-staff"],
    ["主管", "user-manager"],
  ])("%s：路由層 requireFinance 直接 403，回應不含任何個資", async (_label, caller) => {
    for (const path of ["/employees", "/employees?include=profile"]) {
      const res = await get(path, caller)
      expect(res.status, path).toBe(403)
      expect(res.body).toEqual({ error: "forbidden" })
    }
    expect(profileReads()).toHaveLength(0)
  })

  it("縱深防禦：就算路由層被放寬成任何員工都能列，非財務層帶 include=profile 仍拿不到個資、也不會去查 employee_profiles", async () => {
    h.guard.relaxFinance = true
    for (const caller of ["user-staff", "user-manager"]) {
      h.calls.length = 0
      const res = await get("/employees?include=profile", caller)
      expect(res.status, caller).toBe(200)
      expect(res.body.employees.length).toBeGreaterThan(0)
      for (const e of res.body.employees) for (const key of PERSONAL_KEYS) expect(e, caller).not.toHaveProperty(key)
      for (const secret of SECRET_STRINGS) expect(JSON.stringify(res.body), caller).not.toContain(secret)
      expect(profileReads(), caller).toHaveLength(0)
    }
    // 同樣放寬下，財務層照常拿得到（證明上面是 handler 的角色判斷在擋，不是 include 解析壞掉）。
    const hr = await get("/employees?include=profile", "user-hr")
    expect(row(hr.body.employees, ids.staff).idNumber).toBe("A123456789")
  })

  it("沒有對應員工列的帳號（幽靈使用者）：403", async () => {
    const res = await get("/employees?include=profile", "user-ghost")
    expect(res.status).toBe(403)
  })
})

describe("GET /employees?include=profile — 批次查詢（不是 N+1）", () => {
  it("一般人數：整份清單只查一次 employee_profiles，用 tenant_id＋employee_id in (...)", async () => {
    const res = await get("/employees?include=profile", "user-hr")
    expect(res.status).toBe(200)
    const reads = profileReads()
    expect(reads).toHaveLength(1)
    const inFilter = reads[0].filters.find((f) => f.kind === "in" && f.col === "employee_id")
    expect([...((inFilter?.val as string[]) ?? [])].sort()).toEqual(Object.values(ids).sort())
  })

  it("超過 100 人：每 100 人一批（250 人＝3 次查詢），仍不是每人一查", async () => {
    for (let i = 0; i < 244; i++) {
      h.db.employees.push({
        id: `bbbbbbbb-1111-4111-8111-bbbb${String(i).padStart(8, "0")}`,
        tenant_id: h.TENANT,
        user_id: null,
        role: "employee",
        name: `測試員工${i}`,
        dept_id: null,
        emp_no: null,
        employment_type: "regular",
        hire_date: null,
        terminated_at: null,
        status: "active",
        created_at: "2026-02-01T00:00:00Z",
      })
    }
    const res = await get("/employees?include=profile", "user-hr")
    expect(res.status).toBe(200)
    expect(res.body.employees).toHaveLength(250)
    const reads = profileReads()
    expect(reads).toHaveLength(3)
    const sizes = reads.map((r) => (r.filters.find((f) => f.kind === "in")?.val as string[]).length).sort((a, b) => b - a)
    expect(sizes).toEqual([100, 100, 50])
    // 分批後值仍對得上人。
    expect(row(res.body.employees, ids.staff).bankAccount).toBe("0000000000")
  })
})

describe("PUT /employees/:empId/profile — 匯款四欄", () => {
  const BANK_BODY = { bankCode: "000", bankName: "測試銀行", bankAccount: "0000000000", accountHolder: "測試戶名" }

  it("HR 可寫：upsert 帶 bank_code／bank_name／bank_account／account_holder，只動有帶的欄位", async () => {
    const res = await put(`/employees/${ids.other}/profile`, "user-hr", BANK_BODY)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const writes = profileWrites()
    expect(writes).toHaveLength(1)
    expect(writes[0].op).toBe("upsert")
    expect(writes[0].payload).toMatchObject({
      tenant_id: h.TENANT,
      employee_id: ids.other,
      bank_code: "000",
      bank_name: "測試銀行",
      bank_account: "0000000000",
      account_holder: "測試戶名",
    })
    // partial 語意：沒帶的欄位（身分證、生日…）不在 payload，不會被洗掉。
    for (const col of ["id_number", "birthday", "registered_address", "phone"]) {
      expect(writes[0].payload).not.toHaveProperty(col)
    }
    // 真的寫進該員工的列。
    const stored = h.db.employee_profiles.find((r) => r.employee_id === ids.other && r.tenant_id === h.TENANT)
    expect(stored).toMatchObject({ bank_code: "000", bank_account: "0000000000" })
  })

  it("只改一個欄位（帳號）：payload 只有那一欄；前後空白會被 trim", async () => {
    await put(`/employees/${ids.staff}/profile`, "user-hr", { bankAccount: "  1111111111  " })
    const payload = profileWrites()[0].payload as Record<string, unknown>
    expect(payload.bank_account).toBe("1111111111")
    for (const col of ["bank_code", "bank_name", "account_holder"]) expect(payload).not.toHaveProperty(col)
  })

  it("空字串與 null 都是「清空」：存成 null（不是空字串）", async () => {
    const res = await put(`/employees/${ids.staff}/profile`, "user-hr", { bankCode: "", bankName: null, bankAccount: "   " })
    expect(res.status).toBe(200)
    const payload = profileWrites()[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({ bank_code: null, bank_name: null, bank_account: null })
    expect(payload).not.toHaveProperty("account_holder")
  })

  it("長度上限（比照 vendors）：帳號 60、代碼 20、銀行名稱／戶名 120；超過回 400 且不寫入", async () => {
    for (const body of [
      { bankAccount: "1".repeat(61) },
      { bankCode: "1".repeat(21) },
      { bankName: "行".repeat(121) },
      { accountHolder: "戶".repeat(121) },
    ]) {
      const res = await put(`/employees/${ids.staff}/profile`, "user-hr", body)
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(res.body.error).toBe("invalid_body")
    }
    expect(profileWrites()).toHaveLength(0)
    // 剛好在上限內可以。
    const ok = await put(`/employees/${ids.staff}/profile`, "user-hr", { bankAccount: "1".repeat(60) })
    expect(ok.status).toBe(200)
  })

  it("不做格式驗證：外幣／郵局／帶連字號的帳號都收", async () => {
    const res = await put(`/employees/${ids.staff}/profile`, "user-hr", { bankAccount: "0000-000-0000000", bankCode: "700" })
    expect(res.status).toBe(200)
  })

  it("別人不能改：一般員工 PUT 他人 profile → 403，沒有任何寫入", async () => {
    const res = await put(`/employees/${ids.other}/profile`, "user-staff", BANK_BODY)
    expect(res.status).toBe(403)
    expect(profileWrites()).toHaveLength(0)
  })

  it("會計不能寫（沿用既有：只有本人或 HR）→ 403", async () => {
    const res = await put(`/employees/${ids.staff}/profile`, "user-accountant", BANK_BODY)
    expect(res.status).toBe(403)
    expect(profileWrites()).toHaveLength(0)
  })

  describe("非 HR 本人改自己 ＋ 租戶開了「資料異動需審核」：bank 區塊照既有審核邏輯走", () => {
    it("editableFields 只開 contact：改匯款帳號被擋 403 field_not_editable，profile 不動、不建審核單", async () => {
      h.db.tenants = [{ id: h.TENANT, features: { formParameters: { myDataRequiresApproval: true, editableFields: ["contact"] } } }]
      const res = await put(`/employees/${ids.staff}/profile`, "user-staff", { bankAccount: "1111111111" })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe("field_not_editable")
      expect(res.body.fields).toEqual(["bank_account"])
      expect(res.body.message).toContain("匯款帳號")
      expect(profileWrites()).toHaveLength(0)
      expect(h.db.employee_profile_change_requests).toHaveLength(0)
    })

    it("editableFields 勾了 bank：改成待審單 202（diff 只含真的有變的欄位），profile 本身不動，並通知 HR", async () => {
      h.db.tenants = [{ id: h.TENANT, features: { formParameters: { myDataRequiresApproval: true, editableFields: ["bank"] } } }]
      const res = await put(`/employees/${ids.staff}/profile`, "user-staff", {
        bankCode: "000", // 與現值相同＝不算變
        bankAccount: "1111111111",
        accountHolder: "測試戶名乙",
      })
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      expect([...res.body.fields].sort()).toEqual(["account_holder", "bank_account"])
      expect(profileWrites()).toHaveLength(0)
      expect(h.db.employee_profile_change_requests).toHaveLength(1)
      expect(h.db.employee_profile_change_requests[0]).toMatchObject({
        employee_id: ids.staff,
        status: "pending",
        changes: {
          bank_account: { from: "0000000000", to: "1111111111" },
          account_holder: { from: "測試戶名", to: "測試戶名乙" },
        },
      })
      expect(h.enqueued).toHaveLength(1)
      expect(h.enqueued[0].body).toContain("匯款帳號")
      expect(h.enqueued[0].body).toContain("戶名")
      // 審核通過前，正式資料維持原值。
      expect(h.db.employee_profiles.find((r) => r.id === "prof-staff")?.bank_account).toBe("0000000000")
    })

    it("沒設過 editableFields＝全部可改（含 bank）：照樣送審 202", async () => {
      h.db.tenants = [{ id: h.TENANT, features: { formParameters: { myDataRequiresApproval: true } } }]
      const res = await put(`/employees/${ids.staff}/profile`, "user-staff", { bankName: "測試銀行乙" })
      expect(res.status, JSON.stringify(res.body)).toBe(202)
      expect(res.body.fields).toEqual(["bank_name"])
    })

    it("HR 自己改（含代員工改）不受審核影響：直接寫入 200", async () => {
      h.db.tenants = [{ id: h.TENANT, features: { formParameters: { myDataRequiresApproval: true, editableFields: [] } } }]
      const res = await put(`/employees/${ids.staff}/profile`, "user-hr", { bankAccount: "2222222222" })
      expect(res.status).toBe(200)
      expect(h.db.employee_profiles.find((r) => r.id === "prof-staff")?.bank_account).toBe("2222222222")
      expect(h.db.employee_profile_change_requests).toHaveLength(0)
    })
  })
})

describe("GET /employees/:empId/profile — 匯款四欄隨「我的資料」一起回", () => {
  it("select 清單含四個匯款欄；HR 與本人拿得到值，別的員工 403", async () => {
    const hr = await get(`/employees/${ids.staff}/profile`, "user-hr")
    expect(hr.status, JSON.stringify(hr.body)).toBe(200)
    expect(hr.body.profile).toMatchObject({
      bank_code: "000",
      bank_name: "測試銀行",
      bank_account: "0000000000",
      account_holder: "測試戶名",
    })
    const select = profileReads().find((c) => c.cols !== "*")
    for (const col of ["bank_code", "bank_name", "bank_account", "account_holder"]) expect(select?.cols).toContain(col)

    const self = await get(`/employees/${ids.staff}/profile`, "user-staff")
    expect(self.status).toBe(200)
    expect(self.body.profile.bank_account).toBe("0000000000")

    const peer = await get(`/employees/${ids.staff}/profile`, "user-other")
    expect(peer.status).toBe(403)
    expect(JSON.stringify(peer.body)).not.toContain("0000000000")
  })
})
