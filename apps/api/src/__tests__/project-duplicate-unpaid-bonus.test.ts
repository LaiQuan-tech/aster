import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 驗收 #8（2026-10-26）：複製並封存原案前，原案若「累計應得 > 已發」（估算服務判斷）→ 409
 * original_has_unpaid_bonus（列出金額），提示先發放；老闆可帶 force:true 強制並寫稽核。
 * 純測試：fake-supabase；估算服務與 duplicateProject 本體換成替身。
 */

const h = vi.hoisted(() => ({
  estimate: [] as unknown[],
  estimateThrows: false,
  dupCalls: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}))

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
vi.mock("../services/bonus-estimate.js", () => ({
  estimateProjectBonus: async () => {
    if (h.estimateThrows) throw new Error("estimate down")
    return h.estimate
  },
}))
vi.mock("../services/project-bonus-recompute.js", () => ({ recomputeDraftRunsAfterWrite: async () => {} }))
vi.mock("../services/audit.js", () => ({
  writeAuditLog: async (entry: Record<string, unknown>) => {
    h.audits.push(entry)
  },
}))
vi.mock("../services/project-duplicate.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/project-duplicate.js")>()
  return {
    ...orig,
    duplicateProject: async (input: Record<string, unknown>) => {
      h.dupCalls.push(input)
      return {
        ok: true,
        project: { id: "dddddddd-0000-4000-8000-0000000000aa", code: "AT-115-001-1", name: "測試案（追加減 1）", kind: "change", parentProjectId: PROJECT, rootCode: "AT-115-001" },
        archived: input.archiveOriginal ? { id: PROJECT, code: "AT-115-001" } : null,
      }
    },
  }
})

import { projectDuplicateRouter } from "../routes/project-duplicate.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = { boss: emp(1), hr: emp(2), accountant: emp(3), member: emp(4), lead: emp(5) }

const app = express()
app.use(express.json())
app.use(projectDuplicateRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const dup = (token: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/projects/${PROJECT}/duplicate`).set("Authorization", `Bearer ${token}`)
    .send({ kind: "change", amount: 100000, reason: "追加", ...body })

const owing = () => ({
  projectId: PROJECT, pool: 80000, basis: "gross_profit", bonusRatePct: 10, contractTotal: 1000000,
  revenue: 900000, cost: 100000, grossProfit: 800000, overContractPct: null, skipped: null,
  members: [
    { employeeId: E.member, sharePct: 50, shareAmount: null, estimatedAmount: 40000, paidAmount: 30000 },
    { employeeId: E.lead, sharePct: 50, shareAmount: null, estimatedAmount: 40000, paidAmount: 40000 },
  ],
})

beforeEach(() => {
  fake.reset()
  h.estimate = [owing()]
  h.estimateThrows = false
  h.dupCalls.length = 0
  h.audits.length = 0
  fake.db.tenants = [{ id: TENANT_ID, timezone: "Asia/Taipei", features: { approval: { fallbackApproverEmpId: E.boss } } }]
  fake.db.employees = [
    { id: E.boss, tenant_id: TENANT_ID, user_id: "boss-user", role: "accountant", name: "老闆甲", dept_id: null },
    { id: E.hr, tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", name: "人資乙", dept_id: null },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: "acct-user", role: "accountant", name: "會計丙", dept_id: null },
    { id: E.member, tenant_id: TENANT_ID, user_id: "member-user", role: "employee", name: "組員丁", dept_id: null },
    { id: E.lead, tenant_id: TENANT_ID, user_id: "lead-user", role: "employee", name: "主辦戊", dept_id: null },
  ]
  fake.db.projects = [{ id: PROJECT, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: E.lead }]
  fake.db.project_members = []
})

describe("POST /projects/:id/duplicate — 原案有未發獎金", () => {
  it("HR 複製並封存 → 409 original_has_unpaid_bonus，列出未發金額，不複製", async () => {
    const res = await dup("hr-user")
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "original_has_unpaid_bonus", unpaidCount: 1, unpaidTotal: 10000, canForce: false })
    expect(res.body.unpaid).toEqual([{ employeeId: E.member, name: "組員丁", estimatedAmount: 40000, paidAmount: 30000, unpaidAmount: 10000 }])
    expect(h.dupCalls).toHaveLength(0)
  })

  it("會計／負責人（看不到分潤）→ 409 但不帶金額明細", async () => {
    for (const token of ["acct-user", "lead-user"]) {
      const res = await dup(token)
      expect(res.status).toBe(409)
      expect(res.body.unpaidCount).toBe(1)
      expect(res.body).not.toHaveProperty("unpaid")
      expect(res.body).not.toHaveProperty("unpaidTotal")
    }
  })

  it("HR 帶 force → 403 bonus_edit_boss_only", async () => {
    const res = await dup("hr-user", { force: true })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe("bonus_edit_boss_only")
    expect(h.dupCalls).toHaveLength(0)
  })

  it("老闆帶 force → 201，寫一筆強制複製的稽核", async () => {
    const res = await dup("boss-user", { force: true })
    expect(res.status).toBe(201)
    expect(h.dupCalls).toHaveLength(1)
    const forced = h.audits.find((a) => String(a.context).includes("force"))
    expect(forced).toBeDefined()
    expect(forced!.newRow).toMatchObject({ forced_duplicate_with_unpaid_bonus: true, unpaid_total: 10000 })
  })

  it("老闆沒帶 force → 仍 409，canForce=true", async () => {
    const res = await dup("boss-user")
    expect(res.status).toBe(409)
    expect(res.body.canForce).toBe(true)
  })

  it("不封存原案 → 不檢查，照常複製", async () => {
    const res = await dup("hr-user", { archiveOriginal: false })
    expect(res.status).toBe(201)
  })

  it("已全部發放（應得 ≤ 已發）→ 照常複製並封存", async () => {
    h.estimate = [{ ...owing(), members: [{ employeeId: E.member, sharePct: 50, shareAmount: null, estimatedAmount: 30000, paidAmount: 35000 }] }]
    const res = await dup("hr-user")
    expect(res.status).toBe(201)
    expect(h.audits.some((a) => String(a.context).includes("force"))).toBe(false)
  })

  it("估算服務失敗＋要封存原案 → 409 bonus_check_unavailable，不複製", async () => {
    h.estimateThrows = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await dup("hr-user")
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: "bonus_check_unavailable", canForce: false })
    expect(h.dupCalls).toHaveLength(0)
    warn.mockRestore()
  })

  it("估算服務失敗＋不封存原案 → 照常複製", async () => {
    h.estimateThrows = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await dup("hr-user", { archiveOriginal: false })
    expect(res.status).toBe(201)
    warn.mockRestore()
  })

  it("估算服務失敗＋HR 帶 force → 403；老闆帶 force → 201 並寫稽核", async () => {
    h.estimateThrows = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const hr = await dup("hr-user", { force: true })
    expect(hr.status).toBe(403)
    expect(hr.body.error).toBe("bonus_edit_boss_only")
    const boss = await dup("boss-user", { force: true })
    expect(boss.status).toBe(201)
    const audit = h.audits.find((a) => String(a.context).includes("bonus check unavailable"))
    expect(audit?.newRow).toMatchObject({ forced_duplicate_without_bonus_check: true })
    warn.mockRestore()
  })
})
