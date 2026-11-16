import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 防匯錯人第十輪（2026-11-17）：短名稱廠商「名冊名稱被新名稱包含」、核心＋地名／分公司、注音聲調等附加字、
 * 建案補記稽核以列 index 對回副委託 id。⚠️ 全是假資料（repo 公開）；公司名只當比對字串範例。
 */
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))

import { disbursementsRouter } from "../routes/disbursements.js"
import { vendorsRouter } from "../routes/vendors.js"
import { buildRosterKeyIndex, compareRosterKeySets, exactNameKey, rosterKeyMatches, rosterVendorKeys, similarNameKeys } from "../lib/payee-name.js"
import { mapInitialSubcontractRows } from "../services/project-creation.js"
import { resetDisbursementApprovalProbe } from "../services/disbursement-approval.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(disbursementsRouter)
app.use(vendorsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

/** 兩個名稱在兩級比對下的關係（放款「其他」收款／副委託用的 rosterKeyMatches）。 */
function relation(roster: string, name: string): "exact" | "similar" | "none" {
  const m = rosterKeyMatches(buildRosterKeyIndex([{ id: "v", name: roster }]), name)
  return m.exact.length > 0 ? "exact" : m.similar.length > 0 ? "similar" : "none"
}
/** 名冊新增 name 時與既有 roster 的關係（compareRosterKeySets）。 */
function rosterRelation(existing: string, name: string): "exact" | "similar" | null {
  return compareRosterKeySets(rosterVendorKeys({ name }), rosterVendorKeys({ name: existing }))
}

const SIMILAR: Array<[string, string[]]> = [
  ["大同行", ["大同行 台中", "大同行台中營業所", "(台中)大同行", "台中大同行", "大同行企業有限公司", "（台中）大同行", "大同行-台中"]],
  ["全聯社", ["全聯社 台北", "全聯社台北門市", "(高雄)全聯社", "高雄全聯社", "全聯社股份有限公司", "全聯社台中辦事處"]],
  ["永豐行", ["永豐行 新竹", "永豐行新竹分公司", "(台南)永豐行", "台南永豐行", "永豐行企業有限公司"]],
  ["IBM", ["IBM Taiwan", "IBM 台灣分公司", "(台北)IBM", "台灣IBM", "IBM Corporation", "IBM Taiwan Branch"]],
  ["HP Inc", ["HP Inc. Taiwan", "HP Inc 台灣分公司", "HP 台灣分公司", "台灣HP", "(台北)HP Inc", "HP Taiwan Branch"]],
  ["3M", ["3M Taiwan", "3M 台灣分公司", "台灣3M", "(台中)3M", "3M Company", "3M台中營業所"]],
  ["宏碁", ["宏碁台中分公司", "台中宏碁", "宏碁(台中)", "宏碁股份有限公司", "宏碁台北市門市"]],
  ["金德行", ["金德行貿易有限公司", "金德行 台中"]],
  ["ABCD", ["ABCD Design"]],
]

describe("第十輪：短名稱廠商「名冊名稱被新名稱包含」（lib）", () => {
  it("驗收情境全部判為相近（不是完全相同）", () => {
    for (const [roster, names] of SIMILAR) {
      for (const n of names) {
        expect(relation(roster, n), `${roster} ← ${n}`).toBe("similar")
        expect(rosterRelation(roster, n), `名冊 ${roster} ← 新增 ${n}`).toBe("similar")
        // 名冊互比雙向：先有長名、後新增短名也要相近
        expect(rosterRelation(n, roster), `名冊 ${n} ← 新增 ${roster}`).toBe("similar")
      }
    }
  })
  it("不得變成相近：e-Life／e-Home、7-ELEVEN／7-11、全家／全家便利商店；2 字核心後接非地名不相近", () => {
    for (const [a, b] of [["e-Life", "e-Home"], ["7-ELEVEN", "7-11"], ["全家", "全家便利商店"], ["王明", "王明德"], ["宏碁", "宏碁電子材料"], ["3M", "3MX Taiwan"]] as const) {
      expect(relation(a, b), `${a} ← ${b}`).toBe("none")
      expect(relation(b, a), `${b} ← ${a}`).toBe("none")
    }
  })
  it("收尾輪 F1／F3：「大同」對「大同工程有限公司台中」（產業詞＋型態字＋地名）→ 相近；反方向名冊長名的核心不是「大同」→ 不相近", () => {
    expect(relation("大同", "大同工程有限公司台中")).toBe("similar")
    expect(relation("大同工程有限公司台中", "大同")).toBe("none")
  })
  it("只看「名冊名稱被新名稱包含」：新名稱短、被名冊長名包含不因新規則相近", () => {
    expect(relation("大同行台中營業所", "大同")).toBe("none")
    // （「宏碁台中分公司」對「宏碁」本來就因去分公司段後相同而相近，不是這條規則。）
  })
  it("完全相同仍是 exact（硬擋）", () => {
    expect(relation("大同行", " 大同行 ")).toBe("exact")
    expect(relation("3M", "３Ｍ")).toBe("exact")
  })
})

describe("第十輪：注音／聲調／日文長音等附加字", () => {
  it("相近級別的 key 去掉注音、聲調、丶、々、ー、™（收尾輪：exact 不去，改判相近）", () => {
    for (const n of ["測試ㄅ甲ㄆ工程行", "測試甲ˊˇˋ˙ˉ工程行", "測試ㆠ甲工程行", "測試丶甲々工程行ー", "測試甲ｰ工程行"]) {
      expect(exactNameKey(n), n).not.toBe(exactNameKey("測試甲工程行"))
      expect(similarNameKeys(n), n).toContain(exactNameKey("測試甲工程行"))
      expect(relation("測試甲工程行", n), n).toBe("similar")
    }
    expect(similarNameKeys("ACME™")).toContain("acme")
    expect(similarNameKeys("ACME℠ ℡")).toContain("acme")
    expect(exactNameKey("ACME™")).not.toBe("acme")
    expect(exactNameKey("ACME™")).not.toBe(exactNameKey("ACMETM"))
    expect(similarNameKeys("測試ㄅ甲有限公司")).toContain("測試甲")
    expect(relation("測試甲工程行", "測試ㄅ甲工程行ˋ")).toBe("similar")
    expect(relation("ACME Design", "ACME™ Design")).toBe("similar")
  })
})

describe("第十輪：建案補記稽核以列 index 對回副委託 id", () => {
  const row = (id: string, sort: number, name: string, amount: number, extra: Row = {}) =>
    ({ id, sort_order: sort, vendor_id: null, vendor_name: name, amount, item: null, contact: null, note: null, discipline: null, kind: "subcontract", ...extra }) as never
  it("同名非登錄多列（預設 sortOrder＝index）→ 各自對到自己那列", () => {
    const inputs = [
      { vendorName: "測試同名下包", amount: 100, sortOrder: 0 },
      { vendorName: "測試同名下包", amount: 200, sortOrder: 1 },
      { vendorName: "測試同名下包", amount: 300, sortOrder: 2 },
    ]
    const rows = [row("r-c", 2, "測試同名下包", 300), row("r-a", 0, "測試同名下包", 100), row("r-b", 1, "測試同名下包", 200)]
    expect(mapInitialSubcontractRows(inputs, rows)).toEqual(["r-a", "r-b", "r-c"])
  })
  it("同一 sortOrder 的同名多列 → 依內容對，同一列不重複指派；內容完全相同依序各取一列", () => {
    const inputs = [
      { vendorName: "測試同名下包", amount: 100, sortOrder: 0 },
      { vendorName: "測試同名下包", amount: 200, sortOrder: 0 },
      { vendorName: "測試同名下包", amount: 200, sortOrder: 0 },
    ]
    const rows = [row("r-2", 0, "測試同名下包", 200), row("r-1", 0, "測試同名下包", 100), row("r-3", 0, "測試同名下包", 200)]
    const ids = mapInitialSubcontractRows(inputs, rows)
    expect(ids[0]).toBe("r-1")
    expect(new Set(ids).size).toBe(3)
    expect(ids.slice(1).sort()).toEqual(["r-2", "r-3"])
  })
})

const HR = "bbbbbbbb-0000-4000-8000-000000000001"
const BOSS = "bbbbbbbb-0000-4000-8000-000000000009"
const COMPANY = "cccccccc-0000-4000-8000-000000000001"
const VS = "aaaaaaaa-0000-4000-8000-0000000001a1"
const VT = "aaaaaaaa-0000-4000-8000-0000000001a2"
const as = (r: request.Test) => r.set("Authorization", "Bearer hr-user")
const V = (id: string, name: string): Row => ({ id, tenant_id: TENANT_ID, name, short_name: null, bank_name: null, bank_code: null, bank_account: null, account_holder: null, deleted_at: null, is_affiliate: false })
const other = (payeeName: string, over: Row = {}): Row => ({
  payeeKind: "other", vendorId: null, payeeName, payingCompanyId: COMPANY, method: "cash", amount: 300, withheldAmount: 0, status: "draft", allocations: [], ...over,
})

describe("第十輪：API 層（放款「其他」收款、名冊新增）", () => {
  beforeEach(() => {
    fake.reset()
    resetDisbursementApprovalProbe()
    fake.db.employees = [
      { id: HR, tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", dept_id: null, name: "測試人資", status: "active", emp_no: null, created_at: "2026-01-01T00:00:00.000Z" },
      { id: BOSS, tenant_id: TENANT_ID, user_id: "boss", role: "employee", dept_id: null, name: "測試老闆", status: "active", emp_no: null, created_at: "2026-01-01T00:00:00.000Z" },
    ]
    fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS } } }]
    for (const t of ["departments", "approval_flows", "disbursement_approval_steps", "project_members", "contracts", "project_billings", "projects", "project_subcontracts", "project_subcontract_payments"]) fake.db[t] = []
    fake.db.companies = [{ id: COMPANY, tenant_id: TENANT_ID, name: "測試付款公司", bank_name: null, bank_account: null, is_active: true, is_default: true }]
    fake.db.vendors = [V(VS, "測試行"), V(VT, "測試宏")]
    for (const t of ["disbursements", "disbursement_allocations", "disbursement_attachments", "audit_logs", "notifications"]) fake.db[t] = []
  })
  it("「其他」收款：短名稱名冊被包含／核心＋地名 → 409 payee_name_similar；帶說明 → 201；完全相同 → 400", async () => {
    for (const n of ["測試行 台中", "(台中)測試行", "測試行企業有限公司", "測試宏台中分公司", "台中測試宏"]) {
      const no = await as(request(app).post("/disbursements")).send(other(n))
      expect(no.status, n).toBe(409)
      expect(no.body.error, n).toBe("payee_name_similar")
      const ok = await as(request(app).post("/disbursements")).send(other(n, { confirmDistinctReason: "測試：不同公司" }))
      expect(ok.status, n).toBe(201)
    }
    // 收尾輪：聲調等附加字不進 exact →「測試ˋ行」對「測試行」改為相近（需說明）
    const tone = await as(request(app).post("/disbursements")).send(other("測試ˋ行"))
    expect(tone.status).toBe(409)
    expect(tone.body.error).toBe("payee_name_similar")
    const hard = await as(request(app).post("/disbursements")).send(other(" 測試 行 ", { confirmDistinctReason: "測試：說明也不行" }))
    expect(hard.status).toBe(400)
    expect(hard.body.error).toBe("payee_is_registered_vendor")
  })
  it("名冊新增：「測試行台中營業所」→ 409 vendor_name_similar；帶說明 → 201", async () => {
    const no = await as(request(app).post("/vendors")).send({ name: "測試行台中營業所" })
    expect(no.status).toBe(409)
    expect(no.body).toMatchObject({ error: "vendor_name_similar", matchedVendorName: "測試行" })
    const ok = await as(request(app).post("/vendors")).send({ name: "測試行台中營業所", confirmDistinctReason: "測試：不同統編" })
    expect(ok.status).toBe(201)
  })
})
