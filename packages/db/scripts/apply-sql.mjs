#!/usr/bin/env node
/**
 * 把一或多個 .sql 檔依序套到 DATABASE_URL 指的資料庫，並把**每一條**回傳列的
 * 語句結果都印出來（Supabase SQL Editor 一次只顯示最後一條的結果，這是它做不到的）。
 *
 *   npm run db:apply -- docs/套用-2026-09-12-增量-v2.sql docs/驗證-2026-09-13-套用後.sql
 *
 * 規則：
 * - 一個檔案 = 一次 simple-protocol 多語句查詢 = **一個隱含交易**。檔案中任何一條
 *   失敗，整個檔案回滾，資料庫回到執行前的狀態；後面的檔案不會再跑。
 *   這與把整檔貼進 SQL Editor 執行的語意相同。
 * - 連線資訊只從環境變數（或 repo 根目錄 .env）讀，**永遠不印出來**；錯誤只印 postgres
 *   回的訊息。金鑰不要貼進對話、不要寫進任何會 commit 的檔案。兩種寫法擇一：
 *     DATABASE_URL=postgresql://user:pass@host:5432/postgres
 *     PGHOST= / PGPORT= / PGDATABASE= / PGUSER= / PGPASSWORD=   （密碼有特殊字元時用這種，免 URL 編碼）
 *   Supabase 的 direct host（db.<ref>.supabase.co）只有 IPv6；沒有 IPv6 的機器要用
 *   Session pooler（aws-0-<region>.pooler.supabase.com:5432，使用者 postgres.<ref>）。
 * - --dry-run：只讀檔、列出將執行的檔案與大小，不連線。
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../../..")

function loadDotEnv() {
  const p = resolve(repoRoot, ".env")
  if (!existsSync(p)) return
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    if (process.env[key] === undefined && val !== "") process.env[key] = val
  }
}

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const files = args.filter((a) => !a.startsWith("--"))
if (files.length === 0) {
  console.error("用法: node scripts/apply-sql.mjs [--dry-run] <file.sql> [more.sql ...]")
  process.exit(2)
}

// 經 npm -w 執行時 cwd 是 packages/db；INIT_CWD 才是使用者下指令的目錄
const baseDir = process.env.INIT_CWD ?? process.cwd()
const jobs = files.map((f) => {
  const abs = resolve(baseDir, f)
  const text = readFileSync(abs, "utf8")
  return { name: f, text }
})

for (const j of jobs) console.log(`將執行 ${j.name}（${j.text.length.toLocaleString()} 字元）`)
if (dryRun) process.exit(0)

loadDotEnv()
const url = process.env.DATABASE_URL
const pg = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "postgres",
  username: process.env.PGUSER,
  password: process.env.PGPASSWORD,
}
if (!url && !(pg.host && pg.username && pg.password)) {
  console.error(
    "找不到連線資訊。在 repo 根目錄 .env 填 DATABASE_URL=，或拆開填 PGHOST / PGPORT / " +
      "PGDATABASE / PGUSER / PGPASSWORD（.env 已在 .gitignore，不要貼進對話）。",
  )
  process.exit(2)
}

const hostForSsl = url ? url : pg.host
const isLocal = /(@|^)(localhost|127\.0\.0\.1)([:/]|$)/.test(hostForSsl)
const common = {
  max: 1, // 單一連線：多語句批次與隱含交易都綁在同一條連線上
  prepare: false, // 相容 transaction pooler
  ssl: isLocal ? false : "require",
  onnotice: (n) => console.log(`  notice: ${n.message}`),
}
const sql = url ? postgres(url, common) : postgres({ ...pg, ...common })
console.log(`連線目標：${url ? "DATABASE_URL" : `${pg.host}:${pg.port}/${pg.database}（${pg.username}）`}`)

function printResult(r) {
  const rows = Array.isArray(r) ? r : []
  const cmd = r?.command ?? ""
  if (rows.length === 0) {
    console.log(`  ${cmd || "(ok)"}${r?.count != null && cmd !== "SELECT" ? ` ${r.count}` : ""}`)
    return
  }
  console.log(`  ${cmd} → ${rows.length} 列`)
  console.table(rows.map((row) => ({ ...row })))
}

let failed = false
try {
  for (const j of jobs) {
    console.log(`\n=== ${j.name} ===`)
    const t0 = Date.now()
    const res = await sql.unsafe(j.text)
    // 多語句時 postgres.js 回「每個有回傳列的語句」一個 Result；單一結果就直接是 Result
    const list = Array.isArray(res) && res.length > 0 && Array.isArray(res[0]) ? res : [res]
    for (const r of list) printResult(r)
    console.log(`  完成（${Date.now() - t0} ms）`)
  }
} catch (err) {
  failed = true
  console.error(`\n❌ 失敗：${err?.message ?? err}`)
  if (err?.position) console.error(`   位置（字元）: ${err.position}`)
  if (err?.hint) console.error(`   hint: ${err.hint}`)
  console.error("   這個檔案已整個回滾；後面的檔案未執行。")
} finally {
  await sql.end({ timeout: 5 })
}
process.exit(failed ? 1 : 0)
