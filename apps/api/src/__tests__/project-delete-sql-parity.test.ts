import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * 刪除專案：TS 預檢（planProjectDelete）與 DB 函式 soft_delete_project（migrations 0096／0097）的擋刪條件必須一致。
 * 在 pglite（WASM Postgres）上以 db:replay 同一套 base 重建 schema、套 0096＋0097，種同一組情境：
 *   • SQL：soft_delete_project 在 BEGIN／ROLLBACK 內跑，取回 blockers（key＋count）
 *   • TS ：把 pglite 的列原樣搬進 fake-supabase，跑 planProjectDelete
 * 兩邊的 blockers 清單（key 與筆數）逐情境比對。沒有 pglite（未 npm install）時整組略過。
 * ⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { planProjectDelete } from "../services/project-delete.js"
import { fake, type Row } from "./helpers/fake-supabase.js"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const DB_PKG = join(REPO, "packages/db")

type PG = {
  exec: (sql: string) => Promise<unknown>
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  close: () => Promise<void>
}

async function loadPglite(): Promise<null | { PGlite: new (o: unknown) => PG; vector: unknown; btree_gist: unknown }> {
  try {
    const req = createRequire(join(DB_PKG, "package.json"))
    const imp = (spec: string) => import(pathToFileURL(req.resolve(spec)).href)
    const { PGlite } = await imp("@electric-sql/pglite")
    const { vector } = await imp("@electric-sql/pglite/vector")
    const { btree_gist } = await imp("@electric-sql/pglite/contrib/btree_gist")
    return { PGlite, vector, btree_gist }
  } catch {
    return null
  }
}

// 與 docs/套用-2026-11-12-刪除專案-修正2.sql 檔頭的 db:replay 指令同一套 base（正式庫實際套用的順序）。
const BASE_FILES = [
  "docs/套用-2026-11-08-薪資津貼勞退.sql",
  "docs/套用-2026-11-08-加班基數.sql",
  "docs/套用-2026-11-10-薪資投保歷程.sql",
  "docs/套用-2026-11-10-副委託事務所與發票.sql",
  "docs/套用-2026-11-10-申請單版本.sql",
  "docs/套用-2026-11-11-每期獎金分潤.sql",
  "docs/套用-2026-11-11-每期獎金分潤-修正.sql",
  "docs/套用-2026-11-11-每期獎金分潤-修正2.sql",
  "docs/套用-2026-11-12-專案序號手動.sql",
  "docs/套用-2026-11-12-刪除專案.sql",
  "docs/套用-2026-11-12-刪除專案-修正.sql",
  "docs/套用-2026-11-12-刪除專案-修正2.sql",
]

const T = "f0000000-0000-4000-8000-0000000000f1"
const pid = (n: number) => `f0000000-0000-4000-8000-0000000a${String(n).padStart(4, "0")}`
const sid = (n: number) => `f0000000-0000-4000-8000-0000000b${String(n).padStart(4, "0")}`

/** 情境：每個一個專案，SQL 種子用 $P（專案 id）、$S（副委託 id）佔位。 */
const SCENARIOS: Array<{ name: string; sql: string }> = [
  { name: "空殼（只有計畫期程、草稿合約、無金流副委託）", sql: `
    INSERT INTO project_billings (tenant_id, project_id, installment_no) VALUES ('${T}', $P, 1);
    INSERT INTO contracts (tenant_id, project_id, doc_type, title) VALUES ('${T}', $P, 'contract', '草稿');
    INSERT INTO project_subcontracts (id, tenant_id, project_id) VALUES ($S, '${T}', $P);
    INSERT INTO project_subcontract_payments (tenant_id, subcontract_id, installment_no) VALUES ('${T}', $S, 1);` },
  { name: "期程已請款", sql: `INSERT INTO project_billings (tenant_id, project_id, installment_no, billed_on, billed_amount) VALUES ('${T}', $P, 1, '2026-11-01', 100);` },
  { name: "期程只有發票號碼空字串（兩邊都不算）＋已開票另一期", sql: `
    INSERT INTO project_billings (tenant_id, project_id, installment_no, invoice_no) VALUES ('${T}', $P, 1, '');
    INSERT INTO project_billings (tenant_id, project_id, installment_no, invoice_no, invoiced_on) VALUES ('${T}', $P, 2, 'ZZ00000001', '2026-11-02');` },
  { name: "已入帳的期程已軟刪除（不算）", sql: `INSERT INTO project_billings (tenant_id, project_id, installment_no, billed_on, billed_amount, received_on, received_amount, deleted_at) VALUES ('${T}', $P, 1, '2026-10-01', 100, '2026-10-02', 100, now());` },
  { name: "合約已簽約＋另一份已繳印花稅＋已刪除的簽約合約", sql: `
    INSERT INTO contracts (tenant_id, project_id, doc_type, title, signed_on) VALUES ('${T}', $P, 'contract', '已簽', '2026-11-01');
    INSERT INTO contracts (tenant_id, project_id, doc_type, title, stamp_duty_paid_on) VALUES ('${T}', $P, 'contract', '已繳', '2026-11-01');
    INSERT INTO contracts (tenant_id, project_id, doc_type, title, signed_on, deleted_at) VALUES ('${T}', $P, 'contract', '刪掉的', '2026-10-01', now());` },
  { name: "副委託已開發票", sql: `INSERT INTO project_subcontracts (id, tenant_id, project_id, invoice_no) VALUES ($S, '${T}', $P, 'ZZ00000002');` },
  { name: "副委託期款已驗收", sql: `
    INSERT INTO project_subcontracts (id, tenant_id, project_id) VALUES ($S, '${T}', $P);
    INSERT INTO project_subcontract_payments (tenant_id, subcontract_id, installment_no, accepted_on) VALUES ('${T}', $S, 1, '2026-11-01');` },
  { name: "已刪除副委託底下的已付期款（仍擋）", sql: `
    INSERT INTO project_subcontracts (id, tenant_id, project_id, deleted_at) VALUES ($S, '${T}', $P, now());
    INSERT INTO project_subcontract_payments (tenant_id, subcontract_id, installment_no, paid_on, paid_amount) VALUES ('${T}', $S, 1, '2026-10-01', 100);` },
  { name: "事務所已代扣", sql: `INSERT INTO project_subcontracts (id, tenant_id, project_id, kind, withholding_date) VALUES ($S, '${T}', $P, 'firm', '2026-11-03');` },
  { name: "非事務所有代扣日（不算代扣）", sql: `INSERT INTO project_subcontracts (id, tenant_id, project_id, kind, withholding_date) VALUES ($S, '${T}', $P, 'subcontract', '2026-11-03');` },
  { name: "專案文件＋分潤異動", sql: `
    INSERT INTO project_documents (tenant_id, project_id, file_name, storage_path) VALUES ('${T}', $P, 'a.pdf', 'x/a.pdf');
    INSERT INTO project_share_adjustments (tenant_id, project_id, field) VALUES ('${T}', $P, 'pool');` },
  { name: "未刪除的子案＋已刪除的子案", sql: `
    INSERT INTO projects (tenant_id, name, code, kind, parent_project_id) VALUES ('${T}', '子案', 'ZZ-PAR-' || substr($P::text, 33), 'change', $P);
    INSERT INTO projects (tenant_id, name, code, kind, parent_project_id, deleted_at) VALUES ('${T}', '刪掉的子案', 'ZZ-PAR-D-' || substr($P::text, 33), 'change', $P, now());` },
  { name: "多項同時（請款＋簽約＋代扣＋文件）", sql: `
    INSERT INTO project_billings (tenant_id, project_id, installment_no, billed_on, billed_amount) VALUES ('${T}', $P, 1, '2026-11-01', 100);
    INSERT INTO contracts (tenant_id, project_id, doc_type, title, signed_on) VALUES ('${T}', $P, 'contract', '已簽', '2026-11-01');
    INSERT INTO project_subcontracts (id, tenant_id, project_id, kind, withholding_date) VALUES ($S, '${T}', $P, 'firm', '2026-11-03');
    INSERT INTO project_documents (tenant_id, project_id, file_name, storage_path) VALUES ('${T}', $P, 'b.pdf', 'x/b.pdf');` },
]

const FAKE_TABLES = [
  "project_billings", "project_billing_shares", "project_billing_bonus_dates", "bonus_run_items", "project_share_adjustments",
  "attendance_sheet_days", "disbursement_allocations", "project_documents", "contracts", "project_subcontracts",
  "project_subcontract_payments", "projects",
]

const pglite = await loadPglite()
let db: PG | null = null

describe.skipIf(!pglite)("刪除專案：TS 預檢 vs DB 函式（pglite）", () => {
  beforeAll(async () => {
    const { PGlite, vector, btree_gist } = pglite!
    db = new PGlite({ extensions: { vector, btree_gist } })
    const script = readFileSync(join(DB_PKG, "scripts/replay-on-pglite.mjs"), "utf8")
    const stubsStart = script.indexOf("const STUBS = `") + "const STUBS = `".length
    const stubs = script.slice(stubsStart, script.indexOf("\n`", stubsStart))
    await db.exec(stubs)
    const mig = join(DB_PKG, "migrations")
    for (const f of readdirSync(mig).filter((f) => f.endsWith(".sql")).sort()) {
      if (parseInt(f.slice(0, 4), 10) > 53) continue
      for (const stmt of readFileSync(join(mig, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await db.exec(stmt)
    }
    const sqlDir = join(DB_PKG, "sql")
    for (const f of readdirSync(sqlDir).filter((f) => f.endsWith(".sql")).sort()) {
      if (parseInt(f.slice(0, 4), 10) > 62) continue
      await db.exec(readFileSync(join(sqlDir, f), "utf8"))
    }
    for (const f of BASE_FILES) await db.exec(readFileSync(join(REPO, f), "utf8"))
    await db.exec(`INSERT INTO public.tenants (id, name, status) VALUES ('${T}', '一致性測試租戶', 'active')`)
    for (let i = 0; i < SCENARIOS.length; i++) {
      await db.exec(`INSERT INTO public.projects (id, tenant_id, name, code) VALUES ('${pid(i)}', '${T}', '情境 ${i}', 'ZZ-PAR-${i}')`)
      await db.exec(
        `SET search_path = public, extensions;\n` +
          SCENARIOS[i]!.sql.replaceAll("$P", `'${pid(i)}'::uuid`).replaceAll("$S", `'${sid(i)}'::uuid`),
      )
    }
    // TS 端讀同一份資料：把 pglite 的列原樣搬進 fake-supabase。
    fake.reset()
    for (const t of FAKE_TABLES) {
      const { rows } = await db.query<Row>(`SELECT * FROM public.${t} WHERE tenant_id = $1`, [T])
      fake.db[t] = rows.map((r) => {
        const out: Row = {}
        for (const [k, v] of Object.entries(r)) out[k] = v instanceof Date ? v.toISOString() : v
        return out
      })
    }
  }, 300_000)

  afterAll(async () => {
    await db?.close()
  })

  it.each(SCENARIOS.map((s, i) => [s.name, i] as const))("%s：兩邊 blockers（key＋筆數）一致", async (_name, i) => {
    await db!.exec("BEGIN")
    let sqlOut: { status: string; blockers?: Array<{ key: string; count: number }> }
    try {
      const { rows } = await db!.query<{ r: typeof sqlOut }>(
        "SELECT public.soft_delete_project($1::uuid, $2::uuid, NULL, '一致性測試') AS r",
        [T, pid(i)],
      )
      sqlOut = rows[0]!.r
    } finally {
      await db!.exec("ROLLBACK")
    }
    const plan = await planProjectDelete(T, pid(i))
    const ts = plan.blockers.map((b) => ({ key: b.key, count: b.count }))
    const sql = sqlOut.status === "blocked" ? (sqlOut.blockers ?? []) : []
    expect(sqlOut.status).toBe(ts.length > 0 ? "blocked" : "deleted")
    expect(ts, JSON.stringify({ ts, sql })).toEqual(sql)
  })

  it("情境確實有覆蓋到擋刪與放行兩種結果（不是全部空轉）", async () => {
    const results = await Promise.all(SCENARIOS.map((_, i) => planProjectDelete(T, pid(i))))
    const keys = new Set(results.flatMap((p) => p.blockers.map((b) => b.key)))
    for (const k of ["billing_activity", "signed_contracts", "invoiced_subcontracts", "paid_subcontract_payments", "withheld_subcontracts", "documents", "share_adjustments", "child_projects"]) {
      expect(keys.has(k as never), k).toBe(true)
    }
    expect(results.some((p) => p.blockers.length === 0)).toBe(true)
  })
})
