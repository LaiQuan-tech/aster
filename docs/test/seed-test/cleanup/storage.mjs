/**
 * storage.mjs — 刪掉測試資料在 Supabase Storage 裡的檔案（SQL 刪不到物件）。
 *
 *   node docs/test/seed-test/cleanup/storage.mjs            列出並刪除
 *   node docs/test/seed-test/cleanup/storage.mjs --list     只列出不刪
 *   node docs/test/seed-test/cleanup/storage.mjs --backups  連 2026-06／07／08 三份備份快照也刪
 *                                                           （預設不刪：那是整租戶全表快照，留著無害）
 *
 * ⚠️ 要在跑 docs/test/清理-後台測試資料.sql **之前**執行：路徑是從 DB 的 storage_path 讀的，
 *    DB 先清就找不到路徑了。用 .env 的 SUPABASE_SERVICE_ROLE_KEY（值不會被印出）。
 * 涵蓋：disbursement-vouchers（放款憑證）、project-documents（專案文件）、request-attachments
 *      （假單附件）、expense-receipts（報銷收據）；announcement-sheets／knowledge-files／vendor-cards
 *      seed 沒上傳檔案，只在這裡順手檢查一次（有就一起刪）。
 */
import dotenv from "dotenv"
import { createClient } from "@supabase/supabase-js"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(here, "../../../../.env") })
const TENANT = "0507ad78-27f4-480e-b99f-a72db2aee50c"
const TAG = "【測試】"
const listOnly = process.argv.includes("--list")
const withBackups = process.argv.includes("--backups")

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("缺少 .env 的 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
  process.exit(2)
}
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const must = ({ data, error }) => { if (error) throw new Error(error.message); return data ?? [] }

// 測試員工 id（含報到完成產生的無帳號員工）
const testEmp = must(await admin.from("employees").select("id").eq("tenant_id", TENANT).like("name", `${TAG}%`)).map((r) => r.id)

/** 各 bucket 要刪的路徑 */
const plan = {}
const add = (bucket, paths) => { (plan[bucket] ??= new Set()); for (const p of paths) if (p) plan[bucket].add(p) }

// 放款憑證：purpose 以【測試】開頭的放款單
const testDisb = must(await admin.from("disbursements").select("id").eq("tenant_id", TENANT).like("purpose", `${TAG}%`)).map((r) => r.id)
if (testDisb.length) add("disbursement-vouchers", must(await admin.from("disbursement_attachments").select("storage_path").eq("tenant_id", TENANT).in("disbursement_id", testDisb)).map((r) => r.storage_path))

// 專案文件：檔名以【測試】開頭
add("project-documents", must(await admin.from("project_documents").select("storage_path").eq("tenant_id", TENANT).like("file_name", `${TAG}%`)).map((r) => r.storage_path))

// 假單附件／報銷收據：掛在測試員工的單
if (testEmp.length) {
  const reqIds = must(await admin.from("leave_requests").select("id").eq("tenant_id", TENANT).in("employee_id", testEmp)).map((r) => r.id)
  if (reqIds.length) add("request-attachments", must(await admin.from("request_attachments").select("storage_path").eq("tenant_id", TENANT).in("request_id", reqIds)).map((r) => r.storage_path))
  const claimIds = must(await admin.from("expense_claims").select("id").eq("tenant_id", TENANT).in("employee_id", testEmp)).map((r) => r.id)
  if (claimIds.length) add("expense-receipts", must(await admin.from("expense_claim_attachments").select("storage_path").eq("tenant_id", TENANT).in("claim_id", claimIds)).map((r) => r.storage_path))
}

// 生日紅包照片（2026-09-23 需求補齊）：掛在測試員工的 birthday_gifts
if (testEmp.length) add("birthday-photos", must(await admin.from("birthday_gifts").select("photo_path").eq("tenant_id", TENANT).in("employee_id", testEmp)).map((r) => r.photo_path))

// seed 沒上傳、但順手檢查：公告簽名單掃描檔、知識庫檔案、廠商名片
const testAnn = must(await admin.from("announcements").select("id").eq("tenant_id", TENANT).like("title", `${TAG}%`)).map((r) => r.id)
if (testAnn.length) {
  const verIds = must(await admin.from("announcement_versions").select("id").eq("tenant_id", TENANT).in("announcement_id", testAnn)).map((r) => r.id)
  if (verIds.length) add("announcement-sheets", must(await admin.from("announcement_signature_sheets").select("storage_path").eq("tenant_id", TENANT).in("version_id", verIds)).map((r) => r.storage_path))
}
add("knowledge-files", must(await admin.from("knowledge_documents").select("storage_path").eq("tenant_id", TENANT).like("title", `${TAG}%`)).map((r) => r.storage_path))
add("vendor-cards", must(await admin.from("vendors").select("card_storage_path").eq("tenant_id", TENANT).like("name", `${TAG}%`)).map((r) => r.card_storage_path))

// 備份快照（選用）：tenant-snapshots/<tenant>/<period>/…
if (withBackups) {
  for (const period of ["2026-06", "2026-07", "2026-08"]) {
    const prefix = `${TENANT}/${period}`
    const { data, error } = await admin.storage.from("tenant-snapshots").list(prefix, { limit: 1000 })
    if (error) { console.log(`[warn] list tenant-snapshots/${prefix}: ${error.message}`); continue }
    add("tenant-snapshots", (data ?? []).filter((o) => o.name && !o.id?.endsWith("/")).map((o) => `${prefix}/${o.name}`))
  }
}

let total = 0
for (const [bucket, set] of Object.entries(plan)) {
  const paths = [...set]
  if (!paths.length) { console.log(`${bucket}: 0`); continue }
  total += paths.length
  console.log(`${bucket}: ${paths.length}`)
  for (const p of paths) console.log(`  ${p}`)
  if (listOnly) continue
  const { data, error } = await admin.storage.from(bucket).remove(paths)
  if (error) console.log(`  [error] ${error.message}`)
  else console.log(`  removed ${data?.length ?? 0}`)
}
console.log(`${listOnly ? "[list] " : ""}total ${total} 個檔案${withBackups ? "（含備份快照）" : "（不含備份快照；要刪加 --backups）"}`)
