import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（只給守門用的 employees）；放款單的載入／單筆付款換成假的記憶體實作，
// 驗「打勾放款」批次端點：逐筆走既有付款、規則不放寬、權限照舊、單筆失敗不影響其他筆。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

const store = vi.hoisted(() => ({
  rows: new Map<string, { id: string; status: string; amount: number; disbursement_no: string }>(),
  payCalls: [] as Array<{ id: string; input: Record<string, unknown> }>,
  /** 付款時要丟 acceptance_required 的單（模擬已核准但期款被取消驗收）。 */
  unaccepted: new Set<string>(),
  /** 付款時丟非預期錯誤的單。 */
  explode: new Set<string>(),
}))

vi.mock("../services/disbursements.js", async (orig) => {
  const real = await orig<typeof import("../services/disbursements.js")>()
  return {
    ...real,
    loadDisbursement: async (_tenantId: string, id: string) => store.rows.get(id) ?? null,
    payDisbursement: async (_tenantId: string, _actor: unknown, id: string, input: Record<string, unknown>) => {
      store.payCalls.push({ id, input })
      if (store.unaccepted.has(id)) throw new real.DisbursementError(409, "acceptance_required", { installmentNo: 2 })
      if (store.explode.has(id)) throw new Error("connection reset (fake)")
      const row = store.rows.get(id)
      if (!row) return null
      row.status = "paid"
      return { id, status: "paid", paidOn: input.paidOn, amount: row.amount, disbursementNo: row.disbursement_no }
    },
  }
})

import { disbursementsRouter } from "../routes/disbursements.js"
import { batchPayAmountError, batchPayStatusError } from "../services/disbursement-batch-pay.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/** ⚠️ 全部是明顯的假資料。 */
const app = express()
app.use(express.json())
app.use(disbursementsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})
const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const id = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`
const APPROVED_A = id(1)
const APPROVED_B = id(2)
const DRAFT = id(3)
const PENDING = id(4)
const PAID = id(5)
const VOIDED = id(6)
const UNACCEPTED = id(7)
const EXPLODES = id(8)
const MISSING = id(9)

function seed(n: string, status: string, amount = 10000) {
  store.rows.set(n, { id: n, status, amount, disbursement_no: `D-TEST-${n.slice(-3)}` })
}

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: "cccccccc-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000003", tenant_id: TENANT_ID, user_id: "accountant-user", role: "accountant", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000005", tenant_id: TENANT_ID, user_id: "manager-user", role: "manager", dept_id: null },
    { id: "cccccccc-0000-4000-8000-000000000007", tenant_id: TENANT_ID, user_id: "employee-user", role: "employee", dept_id: null },
  ]
  store.rows.clear()
  store.payCalls.length = 0
  store.unaccepted.clear()
  store.explode.clear()
  seed(APPROVED_A, "approved", 18000)
  seed(APPROVED_B, "approved", 9000)
  seed(DRAFT, "draft")
  seed(PENDING, "pending_approval")
  seed(PAID, "paid")
  seed(VOIDED, "void")
  seed(UNACCEPTED, "approved")
  seed(EXPLODES, "approved")
  store.unaccepted.add(UNACCEPTED)
  store.explode.add(EXPLODES)
})

const post = (token: string, body: unknown) => as(token, request(app).post("/disbursements/batch-pay")).send(body as object)

describe("POST /disbursements/batch-pay：打勾放款", () => {
  it("會計：可放款的逐筆付款，其餘逐筆回原因；單筆失敗不影響其他筆", async () => {
    const res = await post("accountant-user", {
      paidOn: "2026-10-27",
      items: [
        { id: APPROVED_A, amount: 18000 },
        { id: DRAFT },
        { id: PENDING },
        { id: PAID },
        { id: VOIDED },
        { id: UNACCEPTED },
        { id: EXPLODES },
        { id: MISSING },
        { id: APPROVED_B, paidOn: "2026-10-20" },
      ],
    })
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.results as Array<{ id: string }>).map((r) => [r.id, r]))
    expect(byId[APPROVED_A]).toMatchObject({ ok: true, disbursement: { status: "paid", paidOn: "2026-10-27" } })
    expect(byId[APPROVED_B]).toMatchObject({ ok: true, disbursement: { paidOn: "2026-10-20" } })
    expect(byId[DRAFT]).toMatchObject({ ok: false, status: 409, error: "approval_required" })
    expect(byId[PENDING]).toMatchObject({ ok: false, status: 409, error: "approval_required" })
    expect(byId[PAID]).toMatchObject({ ok: false, status: 409, error: "already_paid" })
    expect(byId[VOIDED]).toMatchObject({ ok: false, status: 409, error: "void" })
    expect(byId[UNACCEPTED]).toMatchObject({ ok: false, status: 409, error: "acceptance_required", details: { installmentNo: 2 } })
    expect(byId[EXPLODES]).toMatchObject({ ok: false, status: 500, error: "internal_error" })
    expect(JSON.stringify(byId[EXPLODES])).not.toContain("connection reset")
    expect(byId[MISSING]).toMatchObject({ ok: false, status: 404, error: "not_found" })
    expect(res.body.summary).toEqual({ total: 9, succeeded: 2, failed: 7 })
    // 草稿／送簽中／已付／作廢根本不會呼叫付款；呼叫付款時不帶任何強制旗標。
    expect(store.payCalls.map((c) => c.id).sort()).toEqual([APPROVED_A, APPROVED_B, UNACCEPTED, EXPLODES].sort())
    for (const c of store.payCalls) {
      expect(c.input).not.toHaveProperty("forceReason")
      expect(c.input).not.toHaveProperty("forceAcceptance")
    }
  })

  it("實付與核准金額不同 → amount_locked，不付款（已核准單金額凍結，要改得撤回重簽）", async () => {
    const res = await post("accountant-user", { paidOn: "2026-10-27", items: [{ id: APPROVED_A, amount: 17999 }] })
    expect(res.status).toBe(200)
    expect(res.body.results[0]).toMatchObject({ ok: false, status: 409, error: "amount_locked", details: { approvedAmount: 18000, requestedAmount: 17999 } })
    expect(store.payCalls).toHaveLength(0)
    expect(store.rows.get(APPROVED_A)!.status).toBe("approved")
  })

  it("成功的再送一次 → already_paid（重送失敗筆時不會重複付款）；同批重複 id 只處理一次", async () => {
    const first = await post("accountant-user", { paidOn: "2026-10-27", items: [{ id: APPROVED_A }, { id: APPROVED_A }] })
    expect(first.body.results.map((r: { ok: boolean; error?: string }) => r.error ?? "ok")).toEqual(["ok", "duplicate_item"])
    const again = await post("accountant-user", { paidOn: "2026-10-27", items: [{ id: APPROVED_A }] })
    expect(again.body.results[0]).toMatchObject({ ok: false, error: "already_paid" })
    expect(store.payCalls).toHaveLength(1)
  })

  it("HR 也不能用批次強制付款草稿：仍是 approval_required", async () => {
    const res = await post("hr-user", { paidOn: "2026-10-27", items: [{ id: DRAFT }] })
    expect(res.status).toBe(200)
    expect(res.body.results[0]).toMatchObject({ ok: false, error: "approval_required" })
    expect(store.payCalls).toHaveLength(0)
  })

  it("帶強制旗標 → 400 invalid_body（批次不開強制例外，不是默默忽略）", async () => {
    const top = await post("hr-user", { paidOn: "2026-10-27", forceReason: "老闆口頭同意", items: [{ id: DRAFT }] })
    expect(top.status).toBe(400)
    const inItem = await post("hr-user", { paidOn: "2026-10-27", items: [{ id: DRAFT, forceAcceptance: true }] })
    expect(inItem.status).toBe(400)
    expect(store.payCalls).toHaveLength(0)
  })

  it("格式：空清單、超過 100 筆、日期不合法、id 不是 uuid → 400", async () => {
    expect((await post("accountant-user", { items: [] })).status).toBe(400)
    const many = Array.from({ length: 101 }, (_, i) => ({ id: id(1000 + i) }))
    expect((await post("accountant-user", { items: many })).status).toBe(400)
    expect((await post("accountant-user", { paidOn: "2026-13-01", items: [{ id: APPROVED_A }] })).status).toBe(400)
    expect((await post("accountant-user", { items: [{ id: "not-a-uuid" }] })).status).toBe(400)
    expect(store.payCalls).toHaveLength(0)
  })

  it.each([
    ["主管", "manager-user"],
    ["一般員工", "employee-user"],
  ])("權限反例：%s 403，且沒有付款", async (_label, token) => {
    const res = await post(token, { paidOn: "2026-10-27", items: [{ id: APPROVED_A }] })
    expect(res.status).toBe(403)
    expect(store.payCalls).toHaveLength(0)
    expect(store.rows.get(APPROVED_A)!.status).toBe("approved")
  })

  it("沒登入 → 401", async () => {
    const res = await request(app).post("/disbursements/batch-pay").send({ items: [{ id: APPROVED_A }] })
    expect(res.status).toBe(401)
    expect(store.payCalls).toHaveLength(0)
  })
})

describe("批次付款前置檢查（純函式）", () => {
  it("只有 approved 放行", () => {
    expect(batchPayStatusError("approved")).toBeNull()
    expect(batchPayStatusError("draft")?.code).toBe("approval_required")
    expect(batchPayStatusError("pending_approval")?.code).toBe("approval_required")
    expect(batchPayStatusError("paid")?.code).toBe("already_paid")
    expect(batchPayStatusError("void")?.code).toBe("void")
  })
  it("實付省略＝不比對；差 0.01 內放行；超過 → amount_locked", () => {
    expect(batchPayAmountError(1000, undefined)).toBeNull()
    expect(batchPayAmountError(1000, null)).toBeNull()
    expect(batchPayAmountError(1000, 1000.005)).toBeNull()
    expect(batchPayAmountError(1000, 999)?.code).toBe("amount_locked")
  })
})
