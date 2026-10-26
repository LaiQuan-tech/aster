#!/usr/bin/env -S npx tsx
/**
 * docs/test/roster-excel-fields-migrate.ts — 客供商名冊：把 2026-10-12 匯入那批資料依 Excel 重新填進 0076 的新欄位。
 *
 * 只產生計畫、不連 DB、不寫任何東西（永遠是 dry-run）：
 *   1. 唯讀匯出目前名冊（含個資，存 repo 外）：
 *        bash ~/.cache/aster-mgmt/q.sh docs/test/roster-excel-fields-dump.sql > <scratch>/roster-db.json
 *   2. 跑本腳本（Excel 執行時才讀，個資不進 repo）：
 *        npx tsx docs/test/roster-excel-fields-migrate.ts \
 *          --tenant 0507ad78-27f4-480e-b99f-a72db2aee50c \
 *          --excel <客供商基本資料.xlsx> [--excel-old <客供商基本資料_20230328.xlsx>] --db <scratch>/roster-db.json \
 *          [--insert-unmatched-new yes] [--out-sql <scratch>/roster-plan.sql] [--out-unmatched <scratch>/roster-unmatched.json]
 *      --tenant 必填：只處理這個租戶（匯出檔的 tenantId 不同就報錯）。
 *      --insert-unmatched-new yes：新版 Excel 有、系統沒有的列也寫進計畫（INSERT，帶匯入標記；舊版沒對到的列永遠不新增）。
 *      stdout 只印摘要（筆數與欄位名，不含任何儲存格內容）。
 *   3. 業主確認後（且 migration 0076 已套）才把 --out-sql 的檔案拿去正式庫執行；它是單一交易、
 *      每筆以匯出當下的 updated_at 做樂觀鎖，期間有人改過就整批回滾——那就重跑 1、2 產新計畫。
 *
 * 規則見 apps/api/src/services/roster-excel-migration.ts（純函式＋單元測試）。
 * --out-sql／--out-unmatched 含個資：不准寫進 repo 目錄（寫了會直接報錯）。
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import ExcelJS from "exceljs"
import {
  cellToString, planRosterMigration, planToSql, sheetToRows, summarizePlan,
  type DbClientRow, type DbVendorRow, type ExcelRosterRow,
} from "../../apps/api/src/services/roster-excel-migration.js"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

function args(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) throw new Error(`看不懂的參數：${a}`)
    const v = argv[i + 1]
    if (!v || v.startsWith("--")) throw new Error(`${a} 缺值`)
    out[a.slice(2)] = v
    i++
  }
  return out
}

function assertOutsideRepo(path: string) {
  const rel = relative(REPO, resolve(path))
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error(`輸出檔含個資，不能寫在 repo 裡：${path}`)
}

async function readWorkbook(path: string, file: "new" | "old"): Promise<ExcelRosterRow[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const rows: ExcelRosterRow[] = []
  wb.eachSheet((ws) => {
    const grid: string[][] = []
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const cells: string[] = []
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellToString(row.getCell(c).value))
      grid.push(cells)
    }
    rows.push(...sheetToRows(file, ws.name, grid))
  })
  return rows
}

function readDb(path: string): { tenantId?: string; vendors: DbVendorRow[]; clients: DbClientRow[] } {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  // q.sh 回的是 [{ dump: {...} }]；也接受直接 { vendors, clients }
  const obj = (Array.isArray(raw) ? (raw[0] as { dump?: unknown })?.dump : raw) as { tenantId?: string; vendors?: DbVendorRow[]; clients?: DbClientRow[] } | undefined
  if (!obj || !Array.isArray(obj.vendors) || !Array.isArray(obj.clients)) throw new Error("--db 不是 roster-excel-fields-dump.sql 的輸出")
  return { tenantId: obj.tenantId, vendors: obj.vendors, clients: obj.clients }
}

async function main() {
  const opt = args(process.argv.slice(2))
  if (!opt.excel || !opt.db || !opt.tenant) {
    console.error("用法：npx tsx docs/test/roster-excel-fields-migrate.ts --tenant <uuid> --excel <新版.xlsx> [--excel-old <舊版.xlsx>] --db <dump.json> [--insert-unmatched-new yes] [--out-sql <file>] [--out-unmatched <file>]")
    process.exit(2)
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opt.tenant)) throw new Error("--tenant 不是 uuid")
  for (const k of ["out-sql", "out-unmatched"]) if (opt[k]) assertOutsideRepo(opt[k])

  const rows = [...(await readWorkbook(opt.excel, "new")), ...(opt["excel-old"] ? await readWorkbook(opt["excel-old"], "old") : [])]
  const db = readDb(opt.db)
  if (db.tenantId && db.tenantId !== opt.tenant) throw new Error("--db 匯出的租戶與 --tenant 不同")
  const plan = planRosterMigration(
    { rows, vendors: db.vendors, clients: db.clients },
    { tenantId: opt.tenant, insertUnmatchedNew: opt["insert-unmatched-new"] === "yes" },
  )

  const excelRows: Record<string, number> = {}
  for (const r of rows) excelRows[`${r.file}:${r.sheet}`] = (excelRows[`${r.file}:${r.sheet}`] ?? 0) + 1
  console.log(JSON.stringify({ mode: "dry-run（不寫 DB）", excelRows, tenant: opt.tenant, dbRows: { vendors: db.vendors.filter((v) => v.tenant_id === opt.tenant).length, clients: db.clients.filter((c) => c.tenant_id === opt.tenant).length }, ...summarizePlan(plan) }, null, 2))

  if (opt["out-sql"]) {
    writeFileSync(opt["out-sql"], planToSql(plan))
    console.error(`SQL 計畫（含個資）→ ${opt["out-sql"]}（${plan.updates.length} 筆 UPDATE、${plan.inserts.length} 筆 INSERT）`)
  }
  if (opt["out-unmatched"]) {
    const nameOf = (file: string, sheet: string, rowNumber: number) => rows.find((r) => r.file === file && r.sheet === sheet && r.rowNumber === rowNumber)
    const detail = (xs: Array<{ file: "new" | "old"; sheet: string; rowNumber: number }>) =>
      xs.map((x) => ({ ...x, 簡稱: nameOf(x.file, x.sheet, x.rowNumber)?.cells["簡稱"] ?? null, 公司名稱: nameOf(x.file, x.sheet, x.rowNumber)?.cells["公司名稱"] ?? null }))
    writeFileSync(
      opt["out-unmatched"],
      JSON.stringify(
        {
          unmatchedExcel: detail(plan.unmatchedExcel),
          ambiguousExcel: detail(plan.ambiguousExcel),
          unmatchedDb: plan.unmatchedDb,
          editedAfterImport: plan.editedAfterImport,
          conflicts: plan.conflicts,
          rejected: plan.rejected,
        },
        null,
        2,
      ),
    )
    console.error(`未對應清單（含個資）→ ${opt["out-unmatched"]}`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
