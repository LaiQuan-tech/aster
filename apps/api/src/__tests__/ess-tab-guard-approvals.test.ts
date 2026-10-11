import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { essTabGuard, resetEssTabGuardCache } from "../middleware/ess-tab-guard.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * ESS 分頁守門——簽核動作歸「簽核」分頁（approvals）的整條行為（middleware 本身，不是只測對照表）。
 *
 * 以前 POST /requests/batch-decision 與單筆 approve／reject 被歸在「請假申請」（requests）：
 *   • essTabs 開了「簽核」沒開「請假申請」的人，前端看得到簽核頁，按核准卻 403；
 *   • 反過來沒開「簽核」、有開「請假申請」的人還能直接打 API 簽核。
 * 現在簽核動作看「簽核」分頁；送單、撤回等仍看「請假申請」。HR／平台管理員／會計不受 essTabs 限制。
 * ⚠️ 識別碼都是明顯的假值。
 */

const app = express()
app.use(express.json())
app.use(essTabGuard)
// 通過守門的請求都會走到這裡。
app.use((_req, res) => {
  res.status(200).json({ reached: true })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const T = {
  noApprovals: "user-no-approvals", // regular，essTabs 有 requests、沒有 approvals
  noRequests: "user-no-requests", // parttime，essTabs 有 approvals、沒有 requests
  unrestricted: "user-unrestricted", // contract：沒設定 → 不限縮
  intern: "user-intern", // intern：沒設定 → 預設清單（沒有 approvals）
  hr: "user-hr",
  accountant: "user-accountant",
}

beforeEach(() => {
  fake.reset()
  resetEssTabGuardCache()
  fake.db.tenants = [
    {
      id: TENANT_ID,
      features: {
        essTabs: {
          regular: ["home", "requests", "notifications"],
          parttime: ["home", "approvals", "notifications"],
        },
      },
    },
  ]
  fake.db.employees = [
    { id: "e1", tenant_id: TENANT_ID, user_id: T.noApprovals, role: "employee", employment_type: "regular" },
    { id: "e2", tenant_id: TENANT_ID, user_id: T.noRequests, role: "employee", employment_type: "parttime" },
    { id: "e3", tenant_id: TENANT_ID, user_id: T.unrestricted, role: "employee", employment_type: "contract" },
    { id: "e4", tenant_id: TENANT_ID, user_id: T.intern, role: "employee", employment_type: "intern" },
    { id: "e5", tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", employment_type: "regular" },
    { id: "e6", tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", employment_type: "regular" },
  ]
})

const SIGN_ACTIONS: Array<[string, string]> = [
  ["POST", "/requests/abc-123/approve"],
  ["POST", "/requests/abc-123/reject"],
  ["POST", "/requests/batch-decision"],
  ["GET", "/requests/pending-approvals"],
]
const FILING_ACTIONS: Array<[string, string]> = [
  ["POST", "/requests"],
  ["GET", "/requests"],
  ["POST", "/requests/abc-123/cancel"],
]

const call = (token: string, [method, path]: [string, string]) =>
  as(token, method === "GET" ? request(app).get(path) : request(app).post(path)).send({})

describe("essTabs 沒開「簽核」（有開「請假申請」）", () => {
  it.each(SIGN_ACTIONS)("%s %s → 403 ess_tab_disabled（tab=approvals）：不能繞過前端直接打 API 簽核", async (method, path) => {
    const res = await call(T.noApprovals, [method, path])
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "ess_tab_disabled", tab: "approvals" })
  })

  it.each(FILING_ACTIONS)("%s %s → 照常（有開「請假申請」）", async (method, path) => {
    const res = await call(T.noApprovals, [method, path])
    expect(res.status).toBe(200)
    expect(res.body.reached).toBe(true)
  })
})

describe("essTabs 開了「簽核」、沒開「請假申請」", () => {
  it.each(SIGN_ACTIONS)("%s %s → 照常（看得到簽核頁就按得下去）", async (method, path) => {
    const res = await call(T.noRequests, [method, path])
    expect(res.status).toBe(200)
    expect(res.body.reached).toBe(true)
  })

  it.each(FILING_ACTIONS)("%s %s → 403 ess_tab_disabled（tab=requests）", async (method, path) => {
    const res = await call(T.noRequests, [method, path])
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "ess_tab_disabled", tab: "requests" })
  })
})

describe("其他身分", () => {
  it("沒設定 essTabs 的身分類別（不限縮）：簽核與送單都通", async () => {
    for (const action of [...SIGN_ACTIONS, ...FILING_ACTIONS]) {
      const res = await call(T.unrestricted, action)
      expect(res.status, action.join(" ")).toBe(200)
    }
  })

  it("實習生沒設定 → 用預設清單（沒有簽核）：簽核動作 403、送單通", async () => {
    for (const action of SIGN_ACTIONS) {
      const res = await call(T.intern, action)
      expect(res.status, action.join(" ")).toBe(403)
      expect(res.body.tab).toBe("approvals")
    }
    for (const action of FILING_ACTIONS) {
      const res = await call(T.intern, action)
      expect(res.status, action.join(" ")).toBe(200)
    }
  })

  it("HR／平台管理員／會計不受 essTabs 限制（後台與 ESS 共用端點；HR 代簽）", async () => {
    for (const token of [T.hr, T.accountant]) {
      for (const action of [...SIGN_ACTIONS, ...FILING_ACTIONS]) {
        const res = await call(token, action)
        expect(res.status, `${token} ${action.join(" ")}`).toBe(200)
      }
    }
  })

  it("沒有 token 的請求不由本 middleware 處理（交給後面的 requireAuth 回 401）", async () => {
    const res = await request(app).post("/requests/abc-123/approve").send({})
    expect(res.status).toBe(200)
    expect(res.body.reached).toBe(true)
  })
})
