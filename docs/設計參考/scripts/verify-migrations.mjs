// 用 pglite（WASM PostgreSQL）實跑 migration，驗證 SQL 正確性。
// 不需要 Docker 或本機 postgres。每次改 migration 都應重跑：
//   node scripts/verify-migrations.mjs
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR = new URL('../supabase/migrations/', import.meta.url).pathname

// Supabase 專有的 auth schema，本機驗證時以 stub 代替
const AUTH_STUB = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid
  language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;
`

const db = new PGlite()
let failed = 0

try {
  await db.exec(AUTH_STUB)
  console.log('✓ auth stub')
} catch (e) {
  console.error('✗ auth stub:', e.message)
  process.exit(1)
}

const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()

for (const f of files) {
  const sql = readFileSync(join(MIG_DIR, f), 'utf8')
  try {
    await db.exec(sql)
    console.log(`✓ ${f}`)
  } catch (e) {
    failed++
    console.error(`✗ ${f}`)
    console.error(`  ${e.message}`)
    if (e.position) {
      const pos = parseInt(e.position, 10)
      const before = sql.slice(Math.max(0, pos - 220), pos)
      const line = sql.slice(0, pos).split('\n').length
      console.error(`  行 ${line} 附近: ...${before.slice(-180).replace(/\n/g, '\n  ')}<<<HERE`)
    }
  }
}

if (failed === 0) {
  const { rows } = await db.query(`
    select table_name from information_schema.tables
    where table_schema='public' order by table_name`)
  const { rows: fns } = await db.query(`
    select routine_name from information_schema.routines
    where routine_schema='public' order by routine_name`)
  console.log(`\n所有 migration 通過。建立 ${rows.length} 張表 / ${fns.length} 個 function`)
}
process.exit(failed > 0 ? 1 : 0)
