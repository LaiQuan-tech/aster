/**
 * docs/test/seed-test/run.mjs — 「後台測試資料」seed 的 runner。
 *
 *   node docs/test/seed-test/run.mjs [--only base,finance,…] [--api-url https://…]
 *
 * 依檔名前綴順序載入同目錄的 NN-xxx.mjs（00-base 永遠先跑；--only 只影響其後的
 * 模組）。每個模組要 export：
 *   export const name = "base"
 *   export async function seed(ctx)   // ctx 見 lib.mjs 的 createContext
 *
 * 跑完印：各模組 created／reused 計數、manifest 表（page｜feature｜筆數｜名稱清單），
 * 並寫 docs/test/seed-test/last-run.json（已加進 .gitignore）。任何模組丟錯 →
 * 印錯誤（含 status／body）後 exit 1，不吞。
 *
 * 環境變數見 lib.mjs 檔頭（SEED_HR_EMAIL／SEED_HR_PASSWORD／SEED_TEST_PASSWORD…）。
 */

import { readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createContext, SEED_DIR } from "./lib.mjs"

// ---------------------------------------------------------------------------
// 參數
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { only: null, apiUrl: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--only") {
      out.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    } else if (a.startsWith("--only=")) {
      out.only = a.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)
    } else if (a === "--api-url") {
      out.apiUrl = argv[++i]
    } else if (a.startsWith("--api-url=")) {
      out.apiUrl = a.slice("--api-url=".length)
    } else {
      console.error(`未知參數：${a}`)
      process.exit(2)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 載入模組（NN-xxx.mjs，依檔名排序）
// ---------------------------------------------------------------------------
async function loadModules() {
  const files = readdirSync(SEED_DIR)
    .filter((f) => /^\d{2}-[a-z0-9-]+\.mjs$/i.test(f))
    .sort()
  const modules = []
  for (const file of files) {
    const mod = await import(pathToFileURL(join(SEED_DIR, file)).href)
    if (typeof mod.name !== "string" || typeof mod.seed !== "function") {
      console.error(`模組 ${file} 必須 export const name 與 export async function seed(ctx)`)
      process.exit(2)
    }
    modules.push({ file, name: mod.name, seed: mod.seed })
  }
  return modules
}

// ---------------------------------------------------------------------------
// 輸出
// ---------------------------------------------------------------------------
function printSummary(ctx, ran) {
  console.log("\n=== 計數（created／reused）===")
  for (const m of ran) {
    const c = ctx.counts[m.name] ?? { created: 0, reused: 0 }
    console.log(`  ${m.name.padEnd(12)} created=${c.created}  reused=${c.reused}`)
  }
  const total = ran.reduce(
    (acc, m) => {
      const c = ctx.counts[m.name] ?? { created: 0, reused: 0 }
      acc.created += c.created
      acc.reused += c.reused
      return acc
    },
    { created: 0, reused: 0 },
  )
  console.log(`  ${"(total)".padEnd(12)} created=${total.created}  reused=${total.reused}`)

  console.log("\n=== manifest（page｜feature｜筆數｜名稱清單）===")
  for (const entry of ctx.manifest) {
    const names = entry.records.map((r) => r.name).join("、")
    console.log(`  ${entry.page}｜${entry.feature}｜${entry.records.length}｜${names}`)
  }

  if (ctx.issues.length > 0) {
    console.log(`\n=== ISSUE（${ctx.issues.length}）===`)
    for (const it of ctx.issues) console.log(`  [${it.module}] ${it.msg}`)
  }
  return total
}

function writeLastRun(ctx, ran, status, error) {
  const out = {
    ranAt: new Date().toISOString(),
    apiUrl: ctx?.apiUrl ?? null,
    tenantId: ctx?.tenantId ?? null,
    status,
    modules: ran.map((m) => ({ name: m.name, file: m.file, counts: ctx?.counts?.[m.name] ?? null })),
    manifest: ctx?.manifest ?? [],
    issues: ctx?.issues ?? [],
    state: ctx?.state ?? {},
    error: error ? { message: error.message, status: error.status ?? null, body: error.body ?? null } : null,
  }
  writeFileSync(join(SEED_DIR, "last-run.json"), JSON.stringify(out, null, 2))
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const modules = await loadModules()
  const base = modules.find((m) => m.name === "base")
  if (!base) {
    console.error("找不到 00-base 模組（export const name = \"base\"），無法繼續")
    process.exit(2)
  }
  const rest = modules.filter((m) => m.name !== "base")
  const selected = args.only ? rest.filter((m) => args.only.includes(m.name)) : rest
  if (args.only) {
    const unknown = args.only.filter((n) => n !== "base" && !rest.some((m) => m.name === n))
    if (unknown.length > 0) {
      console.error(`--only 指定了不存在的模組：${unknown.join(", ")}（可用：${rest.map((m) => m.name).join(", ") || "無"}）`)
      process.exit(2)
    }
  }
  const plan = [base, ...selected]
  console.log(`模組執行順序：${plan.map((m) => `${m.file}(${m.name})`).join(" → ")}`)

  const ctx = await createContext({ apiUrl: args.apiUrl })
  console.log(`API：${ctx.apiUrl}｜租戶：${ctx.tenantId}｜HR：${ctx.hr.name}（${ctx.hr.role}）`)

  const ran = []
  for (const m of plan) {
    ctx.beginModule(m.name)
    ran.push(m)
    try {
      await m.seed(ctx)
    } catch (err) {
      console.error(`\n✗ 模組 ${m.name}（${m.file}）失敗：${err.message}`)
      if (err.status !== undefined) console.error(`  status: ${err.status}`)
      if (err.body !== undefined) console.error(`  body: ${JSON.stringify(err.body)}`)
      if (!err.status) console.error(err.stack)
      printSummary(ctx, ran)
      writeLastRun(ctx, ran, "failed", err)
      process.exit(1)
    }
  }

  const total = printSummary(ctx, ran)
  writeLastRun(ctx, ran, "ok", null)
  console.log(`\n完成：created=${total.created} reused=${total.reused}；已寫 docs/test/seed-test/last-run.json`)
}

main().catch((err) => {
  console.error(`✗ runner 失敗：${err.message}`)
  if (err.status !== undefined) console.error(`  status: ${err.status}`)
  if (err.body !== undefined) console.error(`  body: ${JSON.stringify(err.body)}`)
  process.exit(1)
})
