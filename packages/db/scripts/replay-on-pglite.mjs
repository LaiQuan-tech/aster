#!/usr/bin/env node
/**
 * 在 pglite（WASM PostgreSQL，不用裝 Postgres 也不用 Docker）上重建正式庫的 schema，
 * 再把「待套用」的 SQL 檔套上去，套兩次（驗冪等），最後跑驗證檔並印出每一條的結果。
 * 目的：**碰正式庫之前**先知道待套用的 SQL 在既有 schema 之上跑不跑得過。
 *
 *   npm run db:replay -- --base-migration 25 --base-sql 17 --base-file docs/套用-2026-09-12.sql \
 *     --seed docs/test/replay-seed.sql \
 *     docs/套用-2026-09-12-增量-v2.sql docs/套用-2026-09-13-增量.sql \
 *     --verify docs/驗證-2026-09-13-套用後.sql
 *
 * --base-migration N   正式庫已套到 drizzle migrations/00NN（含）
 * --base-sql N         正式庫已套到 sql/00NN（含）
 * --base-file file     raw 檔之後再套的「實際套用檔」（可多個）。正式庫是用 docs/套用-*.sql
 *                      這種合併檔套的，而 repo 裡的 raw 檔事後可能又改過（例：sql/0018 後來
 *                      把 advances 納入，直接跑 raw 檔會缺表），所以 base 要照「當時真的跑了
 *                      什麼」來重建，不是照 repo 現況。
 * --seed file          重建完 base 後先種資料（讓資料轉換那類語句有東西可轉）
 * --verify file        套用後執行，並印出每條語句回傳的列（可多個）
 * --compare-raw        另建一個「全部 raw migrations + 全部 sql/」的庫，比對兩邊的
 *                      欄位／索引／約束／trigger／policy／function／RLS 是否完全一致。
 *                      合併檔是手工組的，漏一段或多一段只有這樣抓得到
 *                      （2026-09-13 就是這樣抓到 project_settings 的 audit_all 只在合併檔裡）。
 *
 * 限制：auth / storage schema 是 stub，RLS 的實際行為與 storage policy 在這裡驗不了
 * （那要在 Supabase 上以真實身分測，見 docs/驗證-trigger行為實測.sql 的說明）。
 * 這裡驗的是：語法、物件相依順序、冪等、資料轉換邏輯。
 */
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

let PGlite, vector
try {
  ;({ PGlite } = await import("@electric-sql/pglite"))
  ;({ vector } = await import("@electric-sql/pglite/vector"))
} catch {
  console.error("缺 @electric-sql/pglite：npm install（它是 @hr/db 的 devDependency）")
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const MIG = resolve(here, "../migrations")
const SQL = resolve(here, "../sql")
const baseDir = process.env.INIT_CWD ?? process.cwd()

const args = process.argv.slice(2)
const opt = { baseMigration: Infinity, baseSql: Infinity, baseFiles: [], seed: null, verify: [], pending: [], compareRaw: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--base-migration") opt.baseMigration = Number(args[++i])
  else if (a === "--base-sql") opt.baseSql = Number(args[++i])
  else if (a === "--base-file") opt.baseFiles.push(args[++i])
  else if (a === "--compare-raw") opt.compareRaw = true
  else if (a === "--seed") opt.seed = args[++i]
  else if (a === "--verify") opt.verify.push(args[++i])
  else opt.pending.push(a)
}
const read = (f) => readFileSync(resolve(baseDir, f), "utf8")

// Supabase 專有物件的 stub：只求 migration / policy 寫得出來，不模擬行為
const STUBS = `
create schema if not exists extensions;
set search_path = public, extensions;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('test.user_id', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
  as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now());
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
`

// pgvector：migration 0037 起 knowledge_chunks.embedding 用 vector(768)
const newDb = () => new PGlite({ extensions: { vector } })
const db = newDb()
let failed = 0

async function exec(label, text) {
  try {
    const results = await db.exec(text)
    console.log(`✓ ${label}`)
    return results
  } catch (e) {
    failed++
    console.error(`✗ ${label}\n  ${e.message}`)
    if (e.position) {
      const pos = parseInt(e.position, 10)
      const line = text.slice(0, pos).split("\n").length
      console.error(`  第 ${line} 行附近: ...${text.slice(Math.max(0, pos - 160), pos).replace(/\n/g, "\n  ")}<<<HERE`)
    }
    return null
  }
}

await exec("stubs (auth / storage / roles)", STUBS)

const migs = readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()
let baseCount = 0
for (const f of migs) {
  if (parseInt(f.slice(0, 4), 10) > opt.baseMigration) continue
  const text = readFileSync(join(MIG, f), "utf8")
  for (const stmt of text.split("--> statement-breakpoint")) {
    if (!stmt.trim()) continue
    if ((await exec(`base migration ${f}`, stmt)) === null) process.exit(1)
  }
  baseCount++
}
let baseSqlCount = 0
for (const f of readdirSync(SQL).filter((f) => f.endsWith(".sql")).sort()) {
  if (parseInt(f.slice(0, 4), 10) > opt.baseSql) continue
  if ((await exec(`base sql/${f}`, readFileSync(join(SQL, f), "utf8"))) === null) process.exit(1)
  baseSqlCount++
}
for (const f of opt.baseFiles) if ((await exec(`base file ${f}`, read(f))) === null) process.exit(1)
console.log(`\nbase 重建完成：migrations ×${baseCount}、sql ×${baseSqlCount}、實際套用檔 ×${opt.baseFiles.length}`)

if (opt.seed) await exec(`seed ${opt.seed}`, read(opt.seed))

console.log("\n── 待套用")
for (const f of opt.pending) if ((await exec(f, read(f))) === null) process.exit(1)
console.log("── 再套一次（冪等）")
for (const f of opt.pending) await exec(`${f}（第二次）`, read(f))

for (const f of opt.verify) {
  console.log(`\n── 驗證 ${f}`)
  const results = await exec(f, read(f))
  for (const r of results ?? []) if (r.rows?.length) console.table(r.rows)
}

// ── 合併檔 vs raw 檔：schema 目錄快照必須一模一樣 ─────────────────────
async function catalog(d) {
  const q = async (t) => (await d.query(t)).rows
  return {
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`),
    constraints: await q(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace='public'::regnamespace order by 1,2`),
    triggers: await q(`select c.relname, t.tgname, pg_get_triggerdef(t.oid) d from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relnamespace='public'::regnamespace order by 1,2`),
    policies: await q(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname='public' order by 1,2`),
    functions: await q(`select proname, pg_get_function_identity_arguments(oid) a, md5(prosrc) src from pg_proc where pronamespace='public'::regnamespace order by 1,2`),
    rls: await q(`select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`),
  }
}
if (opt.compareRaw) {
  console.log("\n── 與「全部 raw migrations + 全部 sql/」比對 schema")
  const raw = newDb()
  await raw.exec(STUBS)
  for (const f of migs) for (const stmt of readFileSync(join(MIG, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await raw.exec(stmt)
  for (const f of readdirSync(SQL).filter((f) => f.endsWith(".sql")).sort()) await raw.exec(readFileSync(join(SQL, f), "utf8"))
  const A = await catalog(db), B = await catalog(raw)
  for (const k of Object.keys(A)) {
    if (JSON.stringify(A[k]) === JSON.stringify(B[k])) { console.log(`✓ ${k} 一致（${A[k].length}）`); continue }
    failed++
    const sa = new Set(A[k].map((r) => JSON.stringify(r))), sb = new Set(B[k].map((r) => JSON.stringify(r)))
    console.error(`✗ ${k} 不一致`)
    for (const r of sa) if (!sb.has(r)) console.error(`   只在合併檔那邊: ${r.slice(0, 200)}`)
    for (const r of sb) if (!sa.has(r)) console.error(`   只在 raw 那邊  : ${r.slice(0, 200)}`)
  }
}

console.log(failed ? `\n❌ ${failed} 個失敗` : "\n✅ 全部通過")
process.exit(failed ? 1 : 0)
