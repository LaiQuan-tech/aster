import { createHash, randomBytes } from "node:crypto"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { app } from "../app.js"
import { dangerOf } from "../services/mcp/danger.js"
import { isBlockedPath } from "../services/mcp/catalog.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * MCP 連接（2026-11-02）：OAuth 2.1（DCR → authorize＋PKCE → token → MCP → refresh → revoke）、個人金鑰、
 * 以本人身分派送到既有 route（權限沿用）、危險操作二段確認、停用帳號／跨租戶即時失效、稽核標記。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

process.env.MCP_TOKEN_SECRET = "test-secret-0123456789abcdef0123456789abcdef"
process.env.WEB_URL = "https://web.example.test"
process.env.MCP_PUBLIC_URL = "https://api.example.test"

const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MGR_ID = "bbbbbbbb-0000-4000-8000-000000000002"
const BOSS_ID = "bbbbbbbb-0000-4000-8000-000000000003"
const STAFF_ID = "bbbbbbbb-0000-4000-8000-000000000004"
const HR2_ID = "bbbbbbbb-0000-4000-8000-000000000008"
const T = { hr: "user-hr", mgr: "user-mgr", boss: "user-boss", staff: "user-staff", hr2: "user-hr2" } as const
const DEPT_OPS = "dddddddd-0000-4000-8000-000000000001"
const DEPT_HR = "dddddddd-0000-4000-8000-000000000003"
const DEPT_OTHER = "dddddddd-0000-4000-8000-000000000009"
const LT_ID = "cccccccc-0000-4000-8000-000000000001"
const REDIRECT = "https://client.example.test/callback"

let server: Server
let base = ""
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const employee = (id: string, userId: string, role: string, name: string, deptId: string | null = null, status = "active"): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: userId,
  role,
  name,
  emp_no: null,
  dept_id: deptId,
  status,
  created_at: "2026-01-01T00:00:00.000Z",
})
const dept = (id: string, name: string, managers: string[], tenantId = TENANT_ID): Row => ({
  id,
  tenant_id: tenantId,
  parent_id: null,
  name,
  manager_emp_id: managers[0] ?? null,
  manager_emp_ids: managers,
  created_at: "2026-01-01T00:00:00.000Z",
})

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    employee(HR_ID, T.hr, "hr_admin", "HR 小花", DEPT_HR),
    employee(HR2_ID, T.hr2, "hr_admin", "HR 小草", null),
    employee(MGR_ID, T.mgr, "manager", "主管老王", DEPT_OPS),
    employee(BOSS_ID, T.boss, "employee", "老闆大頭", null),
    employee(STAFF_ID, T.staff, "employee", "員工甲", DEPT_OPS),
  ]
  fake.db.departments = [dept(DEPT_OPS, "營運部", [MGR_ID]), dept(DEPT_HR, "人資部", [MGR_ID]), dept(DEPT_OTHER, "別家公司部門", [], OTHER_TENANT_ID)]
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS_ID } } }]
  fake.db.approval_flows = []
  fake.db.leave_types = [{ id: LT_ID, tenant_id: TENANT_ID, name: "特休", requires_attachment: false }]
  fake.db.__auth_users = []
})

// ── helpers ──────────────────────────────────────────────────────────

function pkce() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

async function register(redirectUris = [REDIRECT], extra: Row = {}) {
  const res = await request(app).post("/oauth/register").send({ client_name: "Test AI", redirect_uris: redirectUris, ...extra })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body as { client_id: string; client_secret?: string }
}

/** 跑 authorize → 同意頁 → 回 code（使用者 userToken＝fake 的 Supabase token＝userId）。 */
async function authorize(clientId: string, userToken: string, challenge: string, redirectUri = REDIRECT) {
  const auth = await request(app)
    .get("/oauth/authorize")
    .query({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-123",
      scope: "aster",
    })
  expect(auth.status, auth.text).toBe(302)
  const consent = new URL(auth.headers.location as string)
  expect(consent.origin + consent.pathname).toBe("https://web.example.test/oauth/consent")
  const req = consent.searchParams.get("req") as string
  const desc = await request(app).get("/oauth/authorize/describe").query({ req })
  expect(desc.body.clientName).toBe("Test AI")
  const decision = await request(app).post("/oauth/authorize/decision").set("Authorization", `Bearer ${userToken}`).send({ req, approve: true })
  expect(decision.status, JSON.stringify(decision.body)).toBe(200)
  const back = new URL(decision.body.redirect_to as string)
  expect(back.searchParams.get("state")).toBe("st-123")
  expect(back.searchParams.get("iss")).toBeTruthy()
  return back.searchParams.get("code") as string
}

async function exchange(clientId: string, code: string, verifier: string, redirectUri = REDIRECT) {
  return request(app)
    .post("/oauth/token")
    .type("form")
    .send({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri })
}

async function oauthLogin(userToken: string) {
  const client = await register()
  const { verifier, challenge } = pkce()
  const code = await authorize(client.client_id, userToken, challenge)
  const tok = await exchange(client.client_id, code, verifier)
  expect(tok.status, JSON.stringify(tok.body)).toBe(200)
  return { clientId: client.client_id, ...(tok.body as { access_token: string; refresh_token: string; expires_in: number }) }
}

async function createPat(userToken: string, name = "Claude Code") {
  const res = await request(app).post("/me/mcp/keys").set("Authorization", `Bearer ${userToken}`).send({ name })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body as { id: string; token: string; prefix: string }
}

async function connect(token: string) {
  const client = new Client({ name: "vitest", version: "0.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

async function callTool(token: string, name: string, args: Row = {}) {
  const client = await connect(token)
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
    return { text: res.content[0]?.text ?? "", isError: !!res.isError }
  } finally {
    await client.close()
  }
}

const rawMcp = (token?: string) => {
  const r = request(app).post("/mcp").set("Accept", "application/json, text/event-stream").set("Content-Type", "application/json")
  return token ? r.set("Authorization", `Bearer ${token}`) : r
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } }

// ── 測試 ─────────────────────────────────────────────────────────────

describe("中繼資料與 401 探索", () => {
  it("RFC 9728／8414 中繼資料；沒帶 token 的 /mcp → 401 + WWW-Authenticate resource_metadata", async () => {
    const prm = await request(app).get("/.well-known/oauth-protected-resource/mcp")
    expect(prm.status).toBe(200)
    expect(prm.body.resource).toMatch(/\/mcp$/)
    const as = await request(app).get("/.well-known/oauth-authorization-server")
    expect(as.body.code_challenge_methods_supported).toEqual(["S256"])
    expect(as.body.registration_endpoint).toMatch(/\/oauth\/register$/)
    expect(prm.body.authorization_servers).toEqual([as.body.issuer])

    const res = await rawMcp().send(INIT)
    expect(res.status).toBe(401)
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer resource_metadata="http.+\/\.well-known\/oauth-protected-resource\/mcp"/)
    const bad = await rawMcp("aster_at_nope").send(INIT)
    expect(bad.status).toBe(401)
    expect(bad.headers["www-authenticate"]).toContain('error="invalid_token"')
  })

  it("不在允許清單的 Origin → 403；claude.ai／沒帶 Origin 放行到認證", async () => {
    expect((await rawMcp().set("Origin", "https://evil.example").send(INIT)).status).toBe(403)
    expect((await rawMcp().set("Origin", "https://claude.ai").send(INIT)).status).toBe(401)
  })

  it("沒設 MCP_TOKEN_SECRET → 503（不會用弱預設值）", async () => {
    const saved = process.env.MCP_TOKEN_SECRET
    delete process.env.MCP_TOKEN_SECRET
    try {
      expect((await rawMcp("aster_at_x").send(INIT)).status).toBe(503)
      expect((await request(app).post("/oauth/register").send({ redirect_uris: [REDIRECT] })).status).toBe(503)
    } finally {
      process.env.MCP_TOKEN_SECRET = saved
    }
  })
})

describe("OAuth 全流程：DCR → authorize(PKCE) → token → MCP → refresh → revoke", () => {
  it("走完全程，token 只存雜湊", async () => {
    const login = await oauthLogin(T.hr)
    expect(login.access_token).toMatch(/^aster_at_/)
    expect(login.refresh_token).toMatch(/^aster_rt_/)
    expect(login.expires_in).toBe(3600)
    const stored = JSON.stringify(fake.db.mcp_tokens)
    expect(stored).not.toContain(login.access_token)
    expect(stored).not.toContain(login.refresh_token)

    // MCP：initialize + tools/list + 唯讀工具
    const client = await connect(login.access_token)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["list_endpoints", "call_api", "my_pending_approvals", "decide_request", "search_employees"]))
    expect(names.length).toBeGreaterThanOrEqual(20)
    const depts = (await client.callTool({ name: "list_departments", arguments: {} })) as { content: Array<{ text: string }> }
    expect(depts.content[0]!.text).toContain("營運部")
    expect(depts.content[0]!.text).not.toContain("別家公司部門") // 跨租戶資料看不到
    await client.close()

    // refresh（輪替）
    const r1 = await request(app).post("/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: login.refresh_token, client_id: login.clientId })
    expect(r1.status, JSON.stringify(r1.body)).toBe(200)
    expect(r1.body.refresh_token).not.toBe(login.refresh_token)
    expect((await callTool(r1.body.access_token, "list_departments")).isError).toBe(false)

    // revoke（RFC 7009）→ 新 access token 立即失效
    const rv = await request(app).post("/oauth/revoke").type("form").send({ token: r1.body.refresh_token, client_id: login.clientId })
    expect(rv.status).toBe(200)
    expect((await rawMcp(r1.body.access_token).send(INIT)).status).toBe(401)
  })

  it("refresh token 重放 → invalid_grant，且整個授權撤銷（新 token 也失效）", async () => {
    const login = await oauthLogin(T.hr)
    const r1 = await request(app).post("/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: login.refresh_token, client_id: login.clientId })
    expect(r1.status).toBe(200)
    const replay = await request(app).post("/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: login.refresh_token, client_id: login.clientId })
    expect([replay.status, replay.body.error]).toEqual([400, "invalid_grant"])
    expect((await rawMcp(r1.body.access_token).send(INIT)).status).toBe(401)
  })

  it("錯誤 PKCE → invalid_grant；授權碼重放 → invalid_grant 並撤銷已發的 token", async () => {
    const client = await register()
    const p = pkce()
    const code = await authorize(client.client_id, T.hr, p.challenge)
    const wrong = await exchange(client.client_id, code, pkce().verifier)
    expect([wrong.status, wrong.body.error]).toEqual([400, "invalid_grant"])

    const p2 = pkce()
    const code2 = await authorize(client.client_id, T.hr, p2.challenge)
    const ok = await exchange(client.client_id, code2, p2.verifier)
    expect(ok.status).toBe(200)
    const again = await exchange(client.client_id, code2, p2.verifier)
    expect([again.status, again.body.error]).toEqual([400, "invalid_grant"])
    expect((await rawMcp(ok.body.access_token).send(INIT)).status).toBe(401)
  })

  it("沒帶 PKCE／用 plain → 不發 code（redirect error=invalid_request）", async () => {
    const client = await register()
    const res = await request(app)
      .get("/oauth/authorize")
      .query({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "plain" })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.location as string).searchParams.get("error")).toBe("invalid_request")
  })

  it("redirect_uri 與註冊值不符：authorize 直接 400（不轉址）；token 交換時不符 → invalid_grant", async () => {
    const client = await register()
    const p = pkce()
    const res = await request(app)
      .get("/oauth/authorize")
      .query({ response_type: "code", client_id: client.client_id, redirect_uri: `${REDIRECT}/evil`, code_challenge: p.challenge, code_challenge_method: "S256" })
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()

    const code = await authorize(client.client_id, T.hr, p.challenge)
    const tok = await exchange(client.client_id, code, p.verifier, "https://client.example.test/other")
    expect([tok.status, tok.body.error]).toEqual([400, "invalid_grant"])
  })

  it("過期的授權碼 → invalid_grant", async () => {
    const client = await register()
    const p = pkce()
    const code = await authorize(client.client_id, T.hr, p.challenge)
    for (const row of fake.db.mcp_oauth_codes ?? []) row.expires_at = "2000-01-01T00:00:00.000Z"
    const tok = await exchange(client.client_id, code, p.verifier)
    expect([tok.status, tok.body.error]).toEqual([400, "invalid_grant"])
  })

  it("使用者按拒絕 → redirect error=access_denied，不發 code", async () => {
    const client = await register()
    const auth = await request(app)
      .get("/oauth/authorize")
      .query({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s" })
    const req = new URL(auth.headers.location as string).searchParams.get("req")
    const d = await request(app).post("/oauth/authorize/decision").set("Authorization", `Bearer ${T.hr}`).send({ req, approve: false })
    expect(new URL(d.body.redirect_to).searchParams.get("error")).toBe("access_denied")
    expect(fake.db.mcp_oauth_codes ?? []).toHaveLength(0)
  })

  it("DCR 拒絕非 https 的 redirect_uri（loopback http 例外）", async () => {
    expect((await request(app).post("/oauth/register").send({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400)
    expect((await request(app).post("/oauth/register").send({ redirect_uris: ["http://localhost:33418/callback"] })).status).toBe(201)
  })

  it("機密用戶端（client_secret_post）：secret 錯 → invalid_client", async () => {
    const client = await register([REDIRECT], { token_endpoint_auth_method: "client_secret_post" })
    expect(client.client_secret).toMatch(/^aster_cs_/)
    const p = pkce()
    const code = await authorize(client.client_id, T.hr, p.challenge)
    const bad = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "authorization_code", client_id: client.client_id, client_secret: "wrong", code, code_verifier: p.verifier, redirect_uri: REDIRECT })
    expect([bad.status, bad.body.error]).toEqual([401, "invalid_client"])
  })
})

describe("個人存取金鑰", () => {
  it("產生（只回一次、DB 只存雜湊）→ 列出 → MCP 可用 → 撤銷後立即 401", async () => {
    const key = await createPat(T.hr)
    expect(key.token).toMatch(/^aster_pat_/)
    expect(JSON.stringify(fake.db.mcp_tokens)).not.toContain(key.token)
    expect(JSON.stringify(fake.db.mcp_grants)).not.toContain(key.token)
    const list = await request(app).get("/me/mcp/keys").set("Authorization", `Bearer ${T.hr}`)
    expect(list.body.keys.map((k: Row) => k.id)).toEqual([key.id])
    expect(JSON.stringify(list.body)).not.toContain(key.token)

    expect((await callTool(key.token, "list_departments")).isError).toBe(false)
    const del = await request(app).delete(`/me/mcp/keys/${key.id}`).set("Authorization", `Bearer ${T.hr}`)
    expect(del.status).toBe(200)
    expect((await rawMcp(key.token).send(INIT)).status).toBe(401)
  })

  it("別人（或別租戶）的金鑰／授權撤銷不了 → 404", async () => {
    const key = await createPat(T.hr)
    expect((await request(app).delete(`/me/mcp/keys/${key.id}`).set("Authorization", `Bearer ${T.staff}`)).status).toBe(404)
    const login = await oauthLogin(T.hr)
    const grantId = (fake.db.mcp_grants ?? []).find((g) => g.kind === "oauth")!.id as string
    expect((await request(app).delete(`/me/mcp/grants/${grantId}`).set("Authorization", `Bearer ${T.staff}`)).status).toBe(404)
    expect((await callTool(login.access_token, "list_departments")).isError).toBe(false)
    // 本人撤銷已授權的 OAuth 應用 → 立即失效
    const grants = await request(app).get("/me/mcp/grants").set("Authorization", `Bearer ${T.hr}`)
    expect(grants.body.grants.map((g: Row) => g.clientName)).toEqual(["Test AI"])
    expect((await request(app).delete(`/me/mcp/grants/${grantId}`).set("Authorization", `Bearer ${T.hr}`)).status).toBe(200)
    expect((await rawMcp(login.access_token).send(INIT)).status).toBe(401)
  })

  it("MCP 不能替自己發金鑰：call_api 打 /me/mcp/keys、/oauth/* → 拒絕", async () => {
    const key = await createPat(T.hr)
    const r1 = await callTool(key.token, "call_api", { method: "POST", path: "/me/mcp/keys", body: { name: "x" } })
    expect(r1.isError).toBe(true)
    expect(r1.text).toContain("不開放")
    const r2 = await callTool(key.token, "call_api", { method: "GET", path: "/oauth/authorize/describe" })
    expect(r2.isError).toBe(true)
    expect((fake.db.mcp_grants ?? []).filter((g) => g.kind === "pat")).toHaveLength(1)
  })
})

describe("權限沿用既有 route（以本人身分派送）", () => {
  it("員工經 MCP 打 HR-only API（稽核紀錄、員工名冊）→ 403", async () => {
    const key = await createPat(T.staff)
    const audit = await callTool(key.token, "call_api", { method: "GET", path: "/audit-logs" })
    expect(audit.isError).toBe(true)
    expect(audit.text).toMatch(/^HTTP 403/)
    const emps = await callTool(key.token, "search_employees", {})
    expect(emps.text).toMatch(/^HTTP 403/)
  })

  it("不能經 MCP 簽自己的單（403 own_request）；別的 HR 經 MCP 可以簽", async () => {
    const hrKey = await createPat(T.hr)
    const filed = await callTool(hrKey.token, "call_api", {
      method: "POST",
      path: "/requests",
      body: { kind: "leave", leaveTypeId: LT_ID, startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z", hours: 8 },
    })
    expect(filed.text, filed.text).toMatch(/^HTTP 201/)
    const requestId = (fake.db.leave_requests ?? [])[0]!.id as string
    const own = await callTool(hrKey.token, "decide_request", { requestId, decision: "approve" })
    expect(own.isError).toBe(true)
    expect(own.text).toContain("own_request")
    const hr2 = await createPat(T.hr2)
    const other = await callTool(hr2.token, "decide_request", { requestId, decision: "approve" })
    expect(other.text, other.text).toMatch(/^HTTP 200/)
  })

  it("經 MCP 的寫入：audit_logs 有 mcp_calls（via=mcp、用戶端名稱），route 自己的稽核 context 也標 [mcp:…]", async () => {
    const key = await createPat(T.hr, "My Laptop")
    await callTool(key.token, "call_api", {
      method: "POST",
      path: "/requests",
      body: { kind: "leave", leaveTypeId: LT_ID, startAt: "2027-06-03T01:00:00.000Z", endAt: "2027-06-03T09:00:00.000Z", hours: 8 },
    })
    const mcpRows = (fake.db.audit_logs ?? []).filter((r) => r.table_name === "mcp_calls")
    expect(mcpRows).toHaveLength(1)
    expect(mcpRows[0]).toMatchObject({ actor_emp_id: HR_ID, context: "[mcp:My Laptop] POST /requests", tenant_id: TENANT_ID })
    expect(mcpRows[0]!.new_row).toMatchObject({ via: "mcp", client: "My Laptop", method: "POST", path: "/requests", status: 201 })
  })

  it("降權立即生效：HR 被改成 employee 後，同一把 token 打 HR API → 403", async () => {
    const key = await createPat(T.hr)
    expect((await callTool(key.token, "call_api", { method: "GET", path: "/audit-logs" })).text).toMatch(/^HTTP 200/)
    ;(fake.db.employees.find((e) => e.id === HR_ID) as Row).role = "employee"
    expect((await callTool(key.token, "call_api", { method: "GET", path: "/audit-logs" })).text).toMatch(/^HTTP 403/)
  })
})

describe("危險操作二段確認", () => {
  const CLOSE = { method: "POST", path: "/payroll-periods/2026-10/close", body: {} }
  const confirmOf = (text: string) => /confirm_token="([^"]+)"/.exec(text)?.[1] as string

  it("沒帶 confirm_token → 只回預覽、不執行；換參數 → 失效（token 作廢）；重放 → 失效；正確帶 → 執行一次", async () => {
    const key = await createPat(T.hr)
    const preview = await callTool(key.token, "call_api", CLOSE)
    expect(preview.isError).toBe(false)
    expect(preview.text).toContain("危險操作，尚未執行")
    const token = confirmOf(preview.text)
    expect(token).toMatch(/^cfm_/)
    expect((fake.db.audit_logs ?? []).filter((r) => r.table_name === "mcp_calls")).toHaveLength(0) // 沒派送

    const swapped = await callTool(key.token, "call_api", { ...CLOSE, path: "/payroll-periods/2026-09/close", confirm_token: token })
    expect(swapped.isError).toBe(true)
    expect(swapped.text).toContain("未執行")
    const afterSwap = await callTool(key.token, "call_api", { ...CLOSE, confirm_token: token })
    expect(afterSwap.isError).toBe(true) // 換參數時已作廢

    const token2 = confirmOf((await callTool(key.token, "call_api", CLOSE)).text)
    const run = await callTool(key.token, "call_api", { ...CLOSE, confirm_token: token2 })
    expect(run.text).toMatch(/^HTTP \d{3}｜已執行：完成本月發薪/)
    expect((fake.db.audit_logs ?? []).filter((r) => r.table_name === "mcp_calls" && r.new_row.confirmed === true)).toHaveLength(1)
    const replay = await callTool(key.token, "call_api", { ...CLOSE, confirm_token: token2 })
    expect(replay.isError).toBe(true)
    expect(replay.text).toContain("無效或已使用過")
  })

  it("confirm_token 綁使用者：別人的 token 無效", async () => {
    const hr = await createPat(T.hr)
    const hr2 = await createPat(T.hr2)
    const token = confirmOf((await callTool(hr.token, "call_api", CLOSE)).text)
    const stolen = await callTool(hr2.token, "call_api", { ...CLOSE, confirm_token: token })
    expect(stolen.isError).toBe(true)
  })

  it("過期的 confirm_token 無效", async () => {
    const key = await createPat(T.hr)
    const token = confirmOf((await callTool(key.token, "call_api", CLOSE)).text)
    for (const row of fake.db.mcp_confirmations ?? []) row.expires_at = "2000-01-01T00:00:00.000Z"
    const res = await callTool(key.token, "call_api", { ...CLOSE, confirm_token: token })
    expect(res.isError).toBe(true)
    expect(res.text).toContain("過期")
  })

  it("高階工具也套用（批次簽核）；DELETE 一律危險；PATCH 員工只有改角色才算", () => {
    expect(dangerOf("POST", "/requests/batch-decision", {})).toBe("批次簽核申請單")
    expect(dangerOf("DELETE", "/clients/abc")).toBe("刪除資料")
    expect(dangerOf("PATCH", "/employees/abc", { role: "hr_admin" })).toContain("角色")
    expect(dangerOf("PATCH", "/employees/abc", { name: "x" })).toBeNull()
    expect(dangerOf("POST", "/disbursements/abc/pay")).toContain("放款")
    expect(dangerOf("POST", "/bonus-runs/abc/pay")).toContain("獎金")
    expect(dangerOf("POST", "/payroll/run")).toContain("薪資")
    expect(dangerOf("PUT", "/rule-config")).toContain("規則")
    expect(dangerOf("GET", "/payslips")).toBeNull()
  })

  it("批次簽核經高階工具 → 先回預覽", async () => {
    const key = await createPat(T.hr)
    const res = await callTool(key.token, "batch_decide_requests", { requestIds: ["11111111-2222-4333-8444-555555555555"], decision: "approve" })
    expect(res.text).toContain("危險操作，尚未執行")
  })
})

describe("帳號狀態與跨租戶：每次請求重新檢查", () => {
  it("停用帳號（employees.status ≠ active）→ token 立即失效；復職後恢復", async () => {
    const login = await oauthLogin(T.staff)
    expect((await rawMcp(login.access_token).send(INIT)).status).toBe(200)
    ;(fake.db.employees.find((e) => e.id === STAFF_ID) as Row).status = "inactive"
    expect((await rawMcp(login.access_token).send(INIT)).status).toBe(401)
    const refresh = await request(app).post("/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: login.refresh_token, client_id: login.clientId })
    expect([refresh.status, refresh.body.error]).toEqual([400, "invalid_grant"])
  })

  it("Supabase 帳號被停權 → 個人金鑰立即失效", async () => {
    const key = await createPat(T.staff)
    fake.db.__auth_users = [{ id: T.staff, banned: true }]
    expect((await rawMcp(key.token).send(INIT)).status).toBe(401)
  })

  it("帳號的租戶換了（app_metadata.tenant_id ≠ 授權當時）→ 失效", async () => {
    const key = await createPat(T.hr)
    fake.db.__auth_users = [{ id: T.hr, tenant_id: OTHER_TENANT_ID }]
    expect((await rawMcp(key.token).send(INIT)).status).toBe(401)
  })

  it("停用帳號不能在同意頁授權", async () => {
    const client = await register()
    ;(fake.db.employees.find((e) => e.id === STAFF_ID) as Row).status = "inactive"
    const auth = await request(app)
      .get("/oauth/authorize")
      .query({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256" })
    const req = new URL(auth.headers.location as string).searchParams.get("req")
    const d = await request(app).post("/oauth/authorize/decision").set("Authorization", `Bearer ${T.staff}`).send({ req, approve: true })
    expect(d.status).toBe(403)
  })
})

describe("內部派送 token 的邊界", () => {
  it("偽造的內部 token（aster_mcpi_…）打 API → 401", async () => {
    const res = await request(app).get("/departments").set("Authorization", "Bearer aster_mcpi_forged")
    expect(res.status).toBe(401)
  })

  it("封鎖路徑", () => {
    expect(isBlockedPath("/oauth/token")).toBe(true)
    expect(isBlockedPath("/me/mcp/keys")).toBe(true)
    expect(isBlockedPath("/me/password-done")).toBe(true)
    expect(isBlockedPath("/internal/attendance/daily-settle")).toBe(true)
    expect(isBlockedPath("/me")).toBe(false)
    expect(isBlockedPath("/requests")).toBe(false)
  })

  it("list_endpoints 列出既有 route、標危險、不含封鎖路徑", async () => {
    const key = await createPat(T.hr)
    const res = await callTool(key.token, "list_endpoints", { keyword: "disbursements" })
    expect(res.text).toContain("GET /disbursements")
    expect(res.text).toContain("⚠️ POST /disbursements/:id/pay")
    const all = await callTool(key.token, "list_endpoints", { keyword: "oauth" })
    expect(all.text).toMatch(/^共 0 個端點/)
  })

  it("大清單分頁截斷並提示 offset", async () => {
    fake.db.departments = Array.from({ length: 120 }, (_, i) => dept(`dddddddd-1111-4000-8000-${String(i).padStart(12, "0")}`, `部門${i}`, []))
    const key = await createPat(T.hr)
    const res = await callTool(key.token, "list_departments", { limit: 10 })
    expect(res.text).toContain("要看下一頁請帶 offset=10")
  })
})
