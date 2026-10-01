import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  const tenantId = "11111111-1111-4111-8111-111111111111"
  const projectId = "22222222-2222-4222-8222-222222222222"
  const db: Record<string, Row[]> = {}
  let failPrimaryContractInsert = false
  let idSeq = 0

  function fakeFrom(table: string) {
    const predicates: Array<(row: Row) => boolean> = []
    let action: "select" | "insert" | "update" | "delete" = "select"
    let payload: Row | Row[] | null = null
    const filtered = () => (db[table] ?? []).filter((row) => predicates.every((predicate) => predicate(row)))
    const execute = async (single: boolean) => {
      if (action === "insert") {
        if (table === "contracts" && failPrimaryContractInsert) {
          return { data: null, error: { message: "contract insert failed", code: "XX000" } }
        }
        const inputs = Array.isArray(payload) ? payload : [payload]
        const rows = inputs.map((input) => ({
          id: input?.id ?? (table === "projects" ? projectId : `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`),
          created_at: "2026-10-01T00:00:00.000Z",
          deleted_at: null,
          version: 1,
          copies: 1,
          stamp_duty_required: "auto",
          ...input,
        }))
        db[table] ??= []
        db[table].push(...rows)
        return { data: single ? rows[0] : rows, error: null }
      }
      if (action === "update") {
        const rows = filtered()
        rows.forEach((row) => Object.assign(row, payload))
        return { data: single ? rows[0] ?? null : rows, error: null }
      }
      if (action === "delete") {
        const doomed = new Set(filtered())
        db[table] = (db[table] ?? []).filter((row) => !doomed.has(row))
        return { data: null, error: null }
      }
      const rows = filtered()
      return { data: single ? rows[0] ?? null : rows, error: null }
    }
    const builder: any = {
      select: () => builder,
      insert: (value: Row | Row[]) => ((action = "insert"), (payload = value), builder),
      update: (value: Row) => ((action = "update"), (payload = value), builder),
      delete: () => ((action = "delete"), builder),
      eq: (column: string, value: unknown) => (predicates.push((row) => row[column] === value), builder),
      is: (column: string, value: unknown) => (predicates.push((row) => (row[column] ?? null) === value), builder),
      in: (column: string, values: unknown[]) => (predicates.push((row) => values.includes(row[column])), builder),
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => execute(true),
      single: () => execute(true),
      then: (resolve: any, reject: any) => execute(false).then(resolve, reject),
    }
    return builder
  }

  return {
    tenantId,
    projectId,
    db,
    fakeFrom,
    setFailPrimaryContractInsert(value: boolean) {
      failPrimaryContractInsert = value
    },
  }
})

vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { from: (table: string) => h.fakeFrom(table) },
  getUserFromToken: async (token: string) =>
    token ? { userId: token, email: null, appMetadata: { tenant_id: h.tenantId } } : null,
}))

vi.mock("../lib/tenant-tz.js", () => ({ getTenantTimezone: async () => "Asia/Taipei" }))
vi.mock("../lib/schema-compat.js", () => ({ columnsExist: async () => false }))

import { projectsRouter } from "../routes/projects.js"
import { contractsRouter } from "../routes/contracts.js"

const app = express()
app.use(express.json())
app.use(projectsRouter, contractsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

function auth(path: string, user = "finance-user") {
  return request(app).get(path).set("Authorization", `Bearer ${user}`)
}

beforeEach(() => {
  h.setFailPrimaryContractInsert(false)
  h.db.tenants = [{ id: h.tenantId, timezone: "Asia/Taipei" }]
  h.db.employees = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", tenant_id: h.tenantId, user_id: "finance-user", role: "accountant", dept_id: null },
    { id: "aaaaaaaa-0000-4000-8000-000000000002", tenant_id: h.tenantId, user_id: "staff-user", role: "employee", dept_id: null },
  ]
  h.db.projects = [{ id: h.projectId, tenant_id: h.tenantId, dept_id: null, lead_emp_id: null, code: "AT-115-001" }]
  h.db.project_members = []
  h.db.project_settings = [{ tenant_id: h.tenantId, stamp_duty_rate: "0.001", stamp_duty_lookback_years: 7 }]
  h.db.contracts = [{
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: h.tenantId,
    project_id: h.projectId,
    doc_type: "contract",
    our_role: "contractor",
    title: "主合約",
    counterparty: null,
    amount: "1000000",
    signed_on: "2026-10-01",
    version: 1,
    supersedes_id: null,
    copies: 1,
    stamp_duty_required: "auto",
    stamp_duty_rate: "0.001",
    stamp_duty_amount: "1000",
    stamp_duty_paid_on: null,
    stamp_duty_note: null,
    created_at: "2026-10-01T00:00:00.000Z",
    deleted_at: null,
    is_primary: true,
  }]
  h.db.project_billings = []
})

describe("primary contract authorization", () => {
  it("requires authentication and project finance access for contract reads", async () => {
    expect((await request(app).get(`/projects/${h.projectId}/contracts`)).status).toBe(401)
    expect((await auth(`/projects/${h.projectId}/contracts`, "staff-user")).status).toBe(403)
    const allowed = await auth(`/projects/${h.projectId}/contracts`)
    expect(allowed.status).toBe(200)
    expect(allowed.body.contracts[0]).toMatchObject({ amount: 1_000_000, isPrimary: true })
  })

  it("requires finance access and validates a nonnegative primary amount", async () => {
    const forbidden = await request(app)
      .put(`/projects/${h.projectId}/main-contract`)
      .set("Authorization", "Bearer staff-user")
      .send({ amount: 2_000_000 })
    expect(forbidden.status).toBe(403)

    const invalid = await request(app)
      .put(`/projects/${h.projectId}/main-contract`)
      .set("Authorization", "Bearer finance-user")
      .send({ amount: -1 })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe("invalid_body")
  })

  it("loads and upserts the authoritative primary contract", async () => {
    const loaded = await auth(`/projects/${h.projectId}/main-contract`)
    expect(loaded.status).toBe(200)
    expect(loaded.body.contract).toMatchObject({ amount: 1_000_000, isPrimary: true })

    const updated = await request(app)
      .put(`/projects/${h.projectId}/main-contract`)
      .set("Authorization", "Bearer finance-user")
      .send({ amount: 2_000_000, title: "統包主合約", copies: 2 })
    expect(updated.status).toBe(200)
    expect(updated.body.contract).toMatchObject({ amount: 2_000_000, title: "統包主合約", stampDutyAmount: 4_000, isPrimary: true })
  })
})

describe("POST /projects primary contract", () => {
  it.each([
    [{ contractAmount: 880_000 }, 880_000],
    [{ primaryContract: { amount: 990_000, title: "專案主約", signedOn: "2026-09-30" } }, 990_000],
  ])("creates one primary contractor contract from %o", async (contractInput, amount) => {
    h.db.projects = []
    h.db.contracts = []
    const response = await request(app)
      .post("/projects")
      .set("Authorization", "Bearer finance-user")
      .send({ name: "新專案", code: `MANUAL-${amount}`, ...contractInput })
    expect(response.status).toBe(201)
    expect(h.db.projects).toHaveLength(1)
    expect(h.db.contracts).toHaveLength(1)
    expect(h.db.contracts[0]).toMatchObject({
      tenant_id: h.tenantId,
      project_id: response.body.id,
      doc_type: "contract",
      our_role: "contractor",
      amount,
      is_primary: true,
    })
  })

  it("rejects negative shorthand amounts before inserting a project", async () => {
    h.db.projects = []
    const response = await request(app)
      .post("/projects")
      .set("Authorization", "Bearer finance-user")
      .send({ name: "負數專案", code: "NEG-1", contractAmount: -1 })
    expect(response.status).toBe(400)
    expect(h.db.projects).toHaveLength(0)
  })

  it("compensates only the just-created project when primary-contract creation fails", async () => {
    h.db.projects = [{ id: "99999999-9999-4999-8999-999999999999", tenant_id: h.tenantId, name: "既有專案" }]
    h.db.contracts = []
    h.setFailPrimaryContractInsert(true)
    const response = await request(app)
      .post("/projects")
      .set("Authorization", "Bearer finance-user")
      .send({ name: "會回滾的新專案", code: "ROLLBACK-1", contractAmount: 123_000 })
    expect(response.status).toBe(500)
    expect(response.body.error).toBe("project_application_create_failed")
    expect(h.db.projects.map((project) => project.id)).toEqual(["99999999-9999-4999-8999-999999999999"])
  })
})
