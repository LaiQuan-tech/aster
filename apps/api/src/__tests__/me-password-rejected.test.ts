import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts）；auth.admin 用 spy、驗舊密碼用的 anon client 也換掉，
// 不連任何 DB／GoTrue。
const adminAuth = vi.hoisted(() => ({
  updateUserById: vi.fn(),
  signOut: vi.fn(),
}))
const anonSignIn = vi.hoisted(() => vi.fn())

vi.mock("../lib/supabase.js", async () => {
  const base = await import("./helpers/fake-supabase.js")
  const mod = base.fakeSupabaseModule()
  return {
    ...mod,
    supabaseAdmin: { ...mod.supabaseAdmin, auth: { admin: adminAuth } },
    // fake 版的 email 是 null；POST /me/password 要有 email 才會驗舊密碼。token 直接當 userId。
    getUserFromToken: async (token: string) =>
      token ? { userId: token, email: "a@example.test", appMetadata: { tenant_id: base.TENANT_ID } } : null,
  }
})
// changeOwnPassword 用 createClient(...).auth.signInWithPassword 驗舊密碼；其餘匯出（錯誤類別）保留真的。
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>()
  return { ...actual, createClient: () => ({ auth: { signInWithPassword: anonSignIn } }) }
})

import { AuthApiError, AuthRetryableFetchError, AuthWeakPasswordError } from "@supabase/supabase-js"
import { authAccountsRouter } from "../routes/auth-accounts.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * POST /me/password 的錯誤回應（2026-10-12：改密碼遇弱密碼／外洩以前一律 500 internal_server_error）：
 *   • GoTrue 擋新密碼（太短／字元不足／外洩）→ 422 { error: "password_rejected", message, reasons }
 *   • GoTrue 說新舊相同 → 400 same_password（跟路由預先檢查的既有回應同形狀）
 *   • 其他 GoTrue 錯誤 → 照舊 500
 *   • 舊密碼錯 → 401 invalid_current_password（形狀不變）；成功 → 200 { ok: true }
 * ⚠️ 識別碼、Email 都是明顯的假值（repo 是公開的）。
 */

const USER_ID = "u-self"
const EMP_ID = "e0000000-0000-4000-8000-000000000001"

const app = express()
app.use(express.json())
app.use(authAccountsRouter)
app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: "internal_server_error" })
})

// supertest 拿到「還沒 listen 的 app」會 listen(0)（不指定 host），macOS 上偶發被別的程式接走；自己先綁 127.0.0.1。
let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const post = (body: Record<string, unknown>) =>
  request(server).post("/me/password").set("Authorization", `Bearer ${USER_ID}`).send(body)

const GOOD_BODY = { currentPassword: "old-pass-1234", newPassword: "new-pass-5678" }

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: EMP_ID, tenant_id: TENANT_ID, user_id: USER_ID, role: "employee", name: "員工甲", must_change_password: true },
  ]
  adminAuth.updateUserById.mockReset()
  adminAuth.signOut.mockReset()
  adminAuth.signOut.mockResolvedValue({ error: null })
  anonSignIn.mockReset()
  // 舊密碼驗證通過：回一個屬於本人的 session。
  anonSignIn.mockResolvedValue({ data: { session: { access_token: "tok" }, user: { id: USER_ID } }, error: null })
})

describe("POST /me/password — GoTrue 擋下新密碼", () => {
  it.each([
    ["外洩", ["pwned"]],
    ["太短", ["length"]],
    ["字元不足", ["characters"]],
    ["太短又字元不足", ["length", "characters"]],
  ] as const)("%s → 422 password_rejected＋reasons，不再是 500", async (_label, reasons) => {
    adminAuth.updateUserById.mockResolvedValue({
      data: { user: null },
      error: new AuthWeakPasswordError("Password is known to be weak and easy to guess.", 422, [...reasons]),
    })
    const res = await post(GOOD_BODY)
    expect(res.status, JSON.stringify(res.body)).toBe(422)
    expect(res.body).toEqual({ error: "password_rejected", message: "這組密碼太弱或曾外洩，請換一組", reasons })
    expect(res.body.error).not.toContain("weak_password")
    // 密碼沒改成：旗標不動、沒有寫入。
    expect(fake.db.employees[0]!.must_change_password).toBe(true)
    expect(fake.writes).toHaveLength(0)
  })

  it("只有 code／status 的 plain object 錯誤（沒有 reasons）→ 422，reasons 為空陣列", async () => {
    adminAuth.updateUserById.mockResolvedValue({ data: { user: null }, error: { code: "weak_password", status: 422, message: "x" } })
    const res = await post(GOOD_BODY)
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: "password_rejected", reasons: [] })
  })

  it("GoTrue 回 same_password → 400 same_password（跟預先檢查同形狀 { error, message }）", async () => {
    adminAuth.updateUserById.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("New password should be different from the old password.", 422, "same_password"),
    })
    const res = await post(GOOD_BODY)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "same_password", message: "新密碼不可與目前密碼相同" })
  })

  it("其他 GoTrue 錯誤（伺服器錯誤、網路）維持 500 internal_server_error", async () => {
    adminAuth.updateUserById.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("Database error updating user", 500, "unexpected_failure"),
    })
    const server500 = await post(GOOD_BODY)
    expect(server500.status).toBe(500)
    expect(server500.body).toEqual({ error: "internal_server_error" })

    adminAuth.updateUserById.mockResolvedValue({ data: { user: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) })
    const network = await post(GOOD_BODY)
    expect(network.status).toBe(500)
    expect(network.body).toEqual({ error: "internal_server_error" })
  })
})

describe("POST /me/password — 既有行為不變", () => {
  it("新舊密碼相同（預先檢查）→ 400 same_password，不打 GoTrue", async () => {
    const res = await post({ currentPassword: "same-pass-1234", newPassword: "same-pass-1234" })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "same_password", message: "新密碼不可與目前密碼相同" })
    expect(anonSignIn).not.toHaveBeenCalled()
    expect(adminAuth.updateUserById).not.toHaveBeenCalled()
  })

  it("舊密碼錯 → 401 invalid_current_password，回應形狀仍是 { error, message }", async () => {
    anonSignIn.mockResolvedValue({ data: { session: null, user: null }, error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") })
    const res = await post(GOOD_BODY)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "invalid_current_password", message: "目前密碼不正確" })
    expect(adminAuth.updateUserById).not.toHaveBeenCalled()
  })

  it("新密碼太短（zod）→ 400 invalid_body", async () => {
    const res = await post({ currentPassword: "old-pass-1234", newPassword: "short" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
  })

  it("成功 → 200 { ok: true }、清掉 must_change_password", async () => {
    adminAuth.updateUserById.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null })
    const res = await post(GOOD_BODY)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(adminAuth.updateUserById).toHaveBeenCalledWith(USER_ID, { password: GOOD_BODY.newPassword })
    expect(fake.db.employees[0]!.must_change_password).toBe(false)
  })
})
