import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

/**
 * 真的在 PostgreSQL 上跑 migration 0103＋0104 的 decide_vendor_bank_change（API 測試裡它是 mock）。
 * 需要一個可以隨意建表的空資料庫：VBC_PG_URL=postgres://postgres@localhost:55433/xxx（本機臨時 cluster）。
 * 沒設就整組略過（CI 不連 DB）。全部是假資料；每個測試前重建 schema。
 */
const URL = process.env.VBC_PG_URL
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const M0103 = readFileSync(resolve(root, "migrations/0103_vendor_bank_change_review.sql"), "utf8")
const M0104 = readFileSync(resolve(root, "migrations/0104_vendor_bank_verified.sql"), "utf8")

const T = "11111111-1111-4111-8111-111111111111"
const V = "a0000000-0000-4000-8000-000000000001"
const V2 = "a0000000-0000-4000-8000-000000000002"
const E1 = "e0000000-0000-4000-8000-000000000001"
const E2 = "e0000000-0000-4000-8000-000000000002"
const R = "b0000000-0000-4000-8000-000000000001"

const BASE = `
DROP SCHEMA public CASCADE; CREATE SCHEMA public;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.tenants(id uuid PRIMARY KEY);
CREATE TABLE public.employees(id uuid PRIMARY KEY, tenant_id uuid);
CREATE TABLE public.vendors(id uuid PRIMARY KEY, tenant_id uuid, name text, bank_code text, bank_name text, bank_account text, account_holder text, deleted_at timestamptz, updated_at timestamptz);
CREATE TABLE public.disbursements(id uuid PRIMARY KEY, tenant_id uuid, vendor_id uuid, status text);
CREATE TABLE public.audit_logs(id bigserial PRIMARY KEY, tenant_id uuid, table_name text, record_id uuid, action text, old_row jsonb, new_row jsonb, db_user text, actor_emp_id uuid, context text);
INSERT INTO public.tenants VALUES ('${T}');
INSERT INTO public.employees VALUES ('${E1}', '${T}'), ('${E2}', '${T}');
INSERT INTO public.vendors VALUES ('${V}', '${T}', '測試甲', '000', '測試銀行', '0000000000001', '測試甲', NULL, now());
INSERT INTO public.vendors VALUES ('${V2}', '${T}', '測試乙', NULL, NULL, NULL, NULL, NULL, now());
`

describe.skipIf(!URL)("decide_vendor_bank_change（真 PostgreSQL）", () => {
  const sql = postgres(URL ?? "postgres://invalid", { max: 1, onnotice: () => {} })
  const decide = (actor: string, action: string, note: string | null = null, id = R) =>
    sql`select public.decide_vendor_bank_change(${T}::uuid, ${id}::uuid, ${actor}::uuid, ${action}, ${note}) as out`.then((r) => r[0]!.out as Record<string, unknown>)
  const errOf = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message)
  const vendor = (id = V) => sql`select * from public.vendors where id = ${id}`.then((r) => r[0]!)
  const request = () => sql`select * from public.vendor_bank_change_requests where id = ${R}`.then((r) => r[0]!)

  beforeAll(async () => {
    await sql`select 1`
  })
  afterAll(async () => {
    await sql.end()
  })
  beforeEach(async () => {
    await sql.unsafe(BASE)
    await sql.unsafe(M0103)
    await sql.unsafe(M0104)
    await sql.unsafe(M0104) // 可重跑
    await sql`insert into public.vendor_bank_change_requests
      (id, tenant_id, vendor_id, requested_by_emp_id, old_bank_code, old_bank_name, old_bank_account, old_account_holder,
       new_bank_code, new_bank_name, new_bank_account, new_account_holder, reason)
      values (${R}, ${T}, ${V}, ${E1}, '000', '測試銀行', '0000000000001', '測試甲', '000', '測試銀行', '0000000000002', '測試甲', '測試原因')`
  })

  it("回填：既有有帳號的廠商標已確認、沒帳號的不標；重跑 0104 不會把之後新建的未確認帳號標成已確認", async () => {
    expect((await vendor()).bank_verified_at).not.toBeNull()
    expect((await vendor()).bank_verified_by).toBeNull()
    expect((await vendor(V2)).bank_verified_at).toBeNull()
    await sql`update public.vendors set bank_account = '0000000000009' where id = ${V2}`
    await sql.unsafe(M0104)
    expect((await vendor(V2)).bank_verified_at).toBeNull()
  })

  it("申請人本人核准 → self_review；名冊不變", async () => {
    expect(await errOf(decide(E1, "approve"))).toContain("vendor_bank_change_self_review")
    expect((await vendor()).bank_account).toBe("0000000000001")
  })

  it("舊值樂觀檢查：申請後名冊被改過 → stale、不套用、仍 pending", async () => {
    await sql`update public.vendors set bank_account = '0000000000077' where id = ${V}`
    expect(await errOf(decide(E2, "approve"))).toContain("vendor_bank_change_stale")
    expect((await vendor()).bank_account).toBe("0000000000077")
    expect((await request()).status).toBe("pending")
  })

  it("送簽中／已核准的放款單擋核准；草稿不擋", async () => {
    await sql`insert into public.disbursements values (gen_random_uuid(), ${T}, ${V}, 'pending_approval')`
    expect(await errOf(decide(E2, "approve"))).toContain("vendor_has_open_disbursements")
    await sql`update public.disbursements set status = 'draft'`
    expect((await decide(E2, "approve")).status).toBe("approved")
  })

  it("核准：寫入名冊＋bank_verified_at／by＋bank_changed_at、狀態 approved、寫稽核；不能再處理", async () => {
    expect((await decide(E2, "approve", "測試核對過")).status).toBe("approved")
    const v = await vendor()
    expect(v.bank_account).toBe("0000000000002")
    expect(v.bank_verified_by).toBe(E2)
    expect(v.bank_verified_at).not.toBeNull()
    expect(v.bank_changed_at).not.toBeNull()
    expect(await request()).toMatchObject({ status: "approved", decided_by_emp_id: E2, decision_note: "測試核對過" })
    const audits = await sql`select new_row from public.audit_logs where table_name = 'vendor_bank_change_requests'`
    expect(audits.some((a) => (a.new_row as Record<string, unknown>).status === "approved")).toBe(true)
    expect(await errOf(decide(E2, "reject", "x"))).toContain("vendor_bank_change_not_pending")
  })

  it("退回：名冊不變、狀態 rejected；同廠商第二筆 pending 被唯一索引擋", async () => {
    await expect(
      sql`insert into public.vendor_bank_change_requests (tenant_id, vendor_id, requested_by_emp_id) values (${T}, ${V}, ${E2})`,
    ).rejects.toThrow(/vendor_bank_change_requests_one_pending_uq/)
    expect((await decide(E2, "reject", "不符")).status).toBe("rejected")
    expect((await vendor()).bank_account).toBe("0000000000001")
    await sql`insert into public.vendor_bank_change_requests (tenant_id, vendor_id, requested_by_emp_id) values (${T}, ${V}, ${E2})`
  })

  it("權限：anon／authenticated 不能讀表或執行函式", async () => {
    const [p] = await sql`select has_table_privilege('anon', 'public.vendor_bank_change_requests', 'select') as a,
      has_function_privilege('authenticated', 'public.decide_vendor_bank_change(uuid,uuid,uuid,text,text)', 'execute') as b,
      has_function_privilege('service_role', 'public.decide_vendor_bank_change(uuid,uuid,uuid,text,text)', 'execute') as c`
    expect(p).toMatchObject({ a: false, b: false, c: true })
  })
})
