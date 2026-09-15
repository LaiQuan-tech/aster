#!/usr/bin/env node
/**
 * docs/test/import-employees-xlsx.mjs — 從「員工基本資料」xlsx 批次開帳號＋填個人資料
 *
 * 用法：
 *   IMPORT_DEFAULT_PASSWORD='<預設密碼>' node docs/test/import-employees-xlsx.mjs \
 *     --file <名冊.xlsx> [--sheet 到職日] --config <config.json> [--dry-run] [--only 姓名,姓名] [--out summary.json]
 *
 * 讀 repo 根目錄 .env（SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY），
 * 用 ADMIN_EMAIL / ADMIN_PASSWORD（HR 管理員）登入 API 做所有業務寫入，只有兩件事走 service role：
 *   1. 既有員工的 Supabase Auth email 換成名冊上的 email（API 沒有端點）
 *   2. 既有員工 demo 職務經歷列的職稱／生效日改成名冊值（job-history 沒有 PUT 端點）
 *
 * 名冊欄位（表頭列自動偵測，別名見 HEADER_ALIASES）：編號、姓名、職稱、e-mail、出生年月日、行動電話、到職日、備註
 *   - 民國日期（61.1.12 / 104.7.1 / 111年2月1日）與西元（2015/7/1、Excel 日期格）都吃
 *   - 手機只留數字；9 碼且 9 開頭補 0（Excel 數字格會吃掉前導零）；其他形狀留空並警告
 *
 * config.json（含個資決策，放 repo 外）：
 *   {
 *     "empNoPrefix": "A", "empNoWidth": 3,               // 編號 n → A001（不設 prefix 就用原字串）
 *     "roles": { "<姓名>": "hr_admin" },                  // 指名角色，優先於 roleByTitle
 *     "roleByTitle": { "經理": "manager", "副理": "manager" },
 *     "employmentTypeByTitle": { "工讀": "intern" },      // 其餘 regular
 *     "emailOverrides": { "<姓名>": "x@y.z" },
 *     "phoneOverrides": { "<姓名>": "09xxxxxxxx" },
 *     "birthdayOverrides": {}, "hireDateOverrides": {},   // YYYY-MM-DD
 *     "notes": { "<姓名>": "下次健檢：116年3月" },        // 寫進 employee_profiles.note
 *     "fallbackApprover": "<姓名>",                      // tenants.features.approval.fallbackApproverEmpId
 *     "jobHistoryActionNew": "新進",
 *     "jobHistoryActionNoHireDate": "資料建檔（到職日待補）"
 *   }
 *
 * 行為：
 *   - 同姓名的既有員工 → 就地更新（換 email、重設密碼＋強制改密碼、改工號／角色／到職日、upsert 個人資料、改職務經歷）
 *   - 其他 → POST /employees（API 自動 must_change_password=true）→ PUT profile → POST job-history
 *   - 單人失敗不中斷；結束時輸出遮罩後的彙總 JSON；任何失敗 exit 1
 *   - 可重跑：既有走更新路徑、profile 是 upsert、職務經歷已有同職稱就跳過、reset-password 重跑無害
 *   - --dry-run 只印計畫（email／電話／生日遮罩）不寫任何東西
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve, join } from "node:path"
import dotenv from "dotenv"
import ExcelJS from "exceljs"
import { createClient } from "@supabase/supabase-js"

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../../")
dotenv.config({ path: join(REPO_ROOT, ".env") })

const API_URL = process.env.API_URL ?? "https://aster-hr-api.vercel.app"
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@kimihr.app"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "000000"
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DEFAULT_PASSWORD = process.env.IMPORT_DEFAULT_PASSWORD

const HEADER_ALIASES = {
  seq: ["編號", "工號", "empno", "emp_no", "員工編號"],
  name: ["姓名", "name", "員工姓名"],
  title: ["職稱", "title", "職務"],
  email: ["e-mail", "email", "信箱", "電子郵件", "mail"],
  birthday: ["出生年月日", "生日", "birthday"],
  phone: ["行動電話", "手機", "mobile", "phone", "電話"],
  hireDate: ["到職日", "到職日期", "hiredate", "hire_date"],
  note: ["備註", "note"],
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { sheet: "到職日", dryRun: false, only: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--file") out.file = next()
    else if (a === "--sheet") out.sheet = next()
    else if (a === "--config") out.config = next()
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--only") out.only = new Set(next().split(",").map((s) => s.trim()).filter(Boolean))
    else if (a === "--out") out.out = next()
    else throw new Error(`未知參數 ${a}`)
  }
  if (!out.file) throw new Error("缺 --file <xlsx>")
  if (!out.config) throw new Error("缺 --config <json>")
  return out
}

// ---------------------------------------------------------------------------
// 轉換小工具
// ---------------------------------------------------------------------------
function cellText(v) {
  if (v == null) return ""
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("").trim()
    if ("text" in v) return String(v.text).trim()
    if ("result" in v) return cellText(v.result)
    if ("hyperlink" in v) return String(v.text ?? v.hyperlink).trim()
  }
  return String(v).trim()
}

/** 民國／西元日期字串 → YYYY-MM-DD；不合法回 null */
export function parseRocDate(raw) {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10)
  const s = cellText(raw)
  if (!s) return null
  if (DATE_RE.test(s)) return isRealDate(s) ? s : null
  const m = s.match(/^(\d{2,4})\s*[./年\-]\s*(\d{1,2})\s*[./月\-]\s*(\d{1,2})\s*日?$/)
  if (!m) return null
  let y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1000) y += 1911 // 民國
  const key = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  return isRealDate(key) ? key : null
}
function isRealDate(key) {
  const [y, m, d] = key.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** 手機正規化 → 09xxxxxxxx；不成形回 { value: null, warning } */
export function normalizeMobile(raw) {
  const digits = cellText(raw).replace(/\D/g, "")
  if (!digits) return { value: null }
  if (digits.length === 10 && digits.startsWith("09")) return { value: digits }
  if (digits.length === 9 && digits.startsWith("9")) return { value: `0${digits}`, warning: "phone_leading_zero_restored" }
  return { value: null, warning: `phone_unrecognized(len=${digits.length})` }
}

function maskEmail(e) {
  if (!e) return ""
  const [local, domain] = e.split("@")
  return `${local.slice(0, 2)}***@${domain ?? ""}`
}
const maskPhone = (p) => (p ? `***${p.slice(-3)}` : "")
const maskDate = (d) => (d ? `${d.slice(0, 4)}-**-**` : "")
const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) // Asia/Taipei

// ---------------------------------------------------------------------------
// 讀名冊
// ---------------------------------------------------------------------------
async function readRoster(file, sheetName) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.getWorksheet(sheetName)
  if (!ws) throw new Error(`找不到工作表「${sheetName}」，有：${wb.worksheets.map((w) => w.name).join("、")}`)

  // 表頭列：前 10 列裡第一列含「姓名」別名者
  let headerRow = 0
  const colMap = {}
  for (let r = 1; r <= Math.min(ws.rowCount, 10) && !headerRow; r++) {
    const row = ws.getRow(r)
    const found = {}
    row.eachCell({ includeEmpty: false }, (c, i) => {
      const h = cellText(c.value).toLowerCase().replace(/\s+/g, "")
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (!found[key] && aliases.some((a) => a.toLowerCase() === h)) found[key] = i
      }
    })
    if (found.name) {
      headerRow = r
      Object.assign(colMap, found)
    }
  }
  if (!headerRow) throw new Error("找不到含「姓名」的表頭列")
  if (!colMap.email) throw new Error("表頭缺 e-mail 欄")

  const records = []
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const get = (key) => (colMap[key] ? row.getCell(colMap[key]).value : null)
    const name = cellText(get("name"))
    if (!name) continue
    const warnings = []
    const birthdayRaw = cellText(get("birthday"))
    const hireRaw = cellText(get("hireDate"))
    const birthday = parseRocDate(get("birthday"))
    const hireDate = parseRocDate(get("hireDate"))
    if (birthdayRaw && !birthday) warnings.push(`birthday_unparsed(${birthdayRaw})`)
    if (hireRaw && !hireDate) warnings.push(`hire_date_unparsed(${hireRaw})`)
    const phone = normalizeMobile(get("phone"))
    if (phone.warning) warnings.push(phone.warning)
    records.push({
      row: r,
      seq: cellText(get("seq")),
      name,
      title: cellText(get("title")),
      email: cellText(get("email")).toLowerCase(),
      birthday,
      phone: phone.value,
      hireDate,
      note: cellText(get("note")) || null,
      warnings,
    })
  }
  return records
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
let TOKEN = ""
async function login() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  const data = await res.json()
  if (!res.ok || !data.access_token) throw new Error(`HR 登入失敗 → ${res.status}`)
  return data.access_token
}
async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${TOKEN}` }
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`)
  return parsed
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cfg = JSON.parse(readFileSync(args.config, "utf8"))
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) throw new Error(".env 缺 SUPABASE_URL / ANON / SERVICE_ROLE")
  if (!args.dryRun && !DEFAULT_PASSWORD) throw new Error("缺 env IMPORT_DEFAULT_PASSWORD（dry-run 可省略）")
  if (DEFAULT_PASSWORD && DEFAULT_PASSWORD.length < 8) throw new Error("IMPORT_DEFAULT_PASSWORD 至少 8 字元（API 限制）")

  const roster = await readRoster(args.file, args.sheet)
  const records = args.only ? roster.filter((r) => args.only.has(r.name)) : roster
  console.log(`名冊「${args.sheet}」讀到 ${roster.length} 人，本次處理 ${records.length} 人${args.dryRun ? "（dry-run）" : ""}`)

  // 套 config 決策
  for (const rec of records) {
    if (cfg.emailOverrides?.[rec.name]) rec.email = String(cfg.emailOverrides[rec.name]).trim().toLowerCase()
    if (cfg.phoneOverrides?.[rec.name]) {
      const p = normalizeMobile(cfg.phoneOverrides[rec.name])
      rec.phone = p.value
      if (p.warning) rec.warnings.push(`override:${p.warning}`)
    }
    if (cfg.birthdayOverrides?.[rec.name]) rec.birthday = cfg.birthdayOverrides[rec.name]
    if (cfg.hireDateOverrides?.[rec.name]) rec.hireDate = cfg.hireDateOverrides[rec.name]
    if (cfg.notes?.[rec.name]) rec.note = rec.note ? `${rec.note}；${cfg.notes[rec.name]}` : cfg.notes[rec.name]
    rec.role = cfg.roles?.[rec.name] ?? cfg.roleByTitle?.[rec.title] ?? "employee"
    rec.employmentType = cfg.employmentTypeByTitle?.[rec.title] ?? "regular"
    if (cfg.empNoPrefix != null && /^\d+$/.test(rec.seq)) rec.empNo = `${cfg.empNoPrefix}${rec.seq.padStart(cfg.empNoWidth ?? 3, "0")}`
    else rec.empNo = rec.seq || null
    if (!EMAIL_RE.test(rec.email)) rec.warnings.push("email_invalid")
    if (rec.birthday && !DATE_RE.test(rec.birthday)) rec.warnings.push("birthday_override_invalid")
    if (rec.hireDate && !DATE_RE.test(rec.hireDate)) rec.warnings.push("hire_date_override_invalid")
  }

  // 現況：租戶員工 + Auth 使用者
  TOKEN = await login()
  const { employees } = await api("GET", "/employees")
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const meRes = await api("GET", "/me")
  const tenantId = employees.find((e) => e.id === meRes.id)?.tenant_id
  if (!tenantId) throw new Error("推不出 tenant id")
  const users = []
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers: ${error.message}`)
    users.push(...data.users)
    if (data.users.length < 200) break
  }
  const userByEmail = new Map(users.map((u) => [(u.email ?? "").toLowerCase(), u]))
  const userById = new Map(users.map((u) => [u.id, u]))

  // 計畫
  const plan = []
  for (const rec of records) {
    const sameName = employees.filter((e) => e.name === rec.name)
    const item = { rec, action: null, employee: null, errors: [] }
    if (rec.warnings.includes("email_invalid")) item.errors.push("email_invalid")
    if (sameName.length > 1) item.errors.push(`ambiguous_name(${sameName.length})`)
    const existing = sameName[0] ?? null
    const authHit = userByEmail.get(rec.email) ?? null
    if (authHit && authHit.app_metadata?.tenant_id !== tenantId) item.errors.push("email_in_other_tenant")
    if (authHit && existing && existing.user_id && existing.user_id !== authHit.id) item.errors.push("email_bound_to_another_user")
    if (authHit && !existing) {
      const boundRow = employees.find((e) => e.user_id === authHit.id)
      item.errors.push(boundRow ? `email_bound_to_employee(${boundRow.name})` : "auth_user_exists_unbound")
    }
    if (existing) {
      item.action = "update"
      item.employee = existing
      const curUser = existing.user_id ? userById.get(existing.user_id) : null
      item.currentEmail = curUser?.email?.toLowerCase() ?? null
      if (!existing.user_id) item.errors.push("existing_without_auth_user")
    } else {
      item.action = "create"
    }
    if (item.errors.length) item.action = "skip"
    plan.push(item)
  }

  // 印計畫（遮罩）
  console.log("\n列 | 動作 | 工號 | 姓名 | 職稱→角色/身分 | email | 生日 | 手機 | 到職日 | 備註/警告")
  for (const p of plan) {
    const r = p.rec
    const extra = [...r.warnings, ...p.errors]
    if (p.action === "update" && p.currentEmail && p.currentEmail !== r.email) extra.push(`email_change(${maskEmail(p.currentEmail)}→)`)
    if (p.action === "update") extra.push(`empNo ${p.employee.emp_no ?? "∅"}→${r.empNo}`, `role ${p.employee.role}→${r.role}`)
    console.log(
      [r.row, p.action, r.empNo, r.name, `${r.title || "?"}→${r.role}/${r.employmentType}`, maskEmail(r.email), maskDate(r.birthday), maskPhone(r.phone), r.hireDate ?? "∅", (r.note ? "note " : "") + extra.join(",")].join(" | "),
    )
  }
  const counts = (k) => plan.filter((p) => p.action === k).length
  console.log(`\n計畫：新建 ${counts("create")}、更新 ${counts("update")}、跳過 ${counts("skip")}`)
  if (args.dryRun) {
    writeSummary(args, plan, [])
    return
  }

  // 執行
  const results = []
  for (const p of plan) {
    if (p.action === "skip") {
      results.push({ name: p.rec.name, status: "skipped", errors: p.errors })
      continue
    }
    const r = p.rec
    const done = []
    const partialErrors = []
    try {
      let empId
      if (p.action === "create") {
        const created = await api("POST", "/employees", {
          email: r.email,
          name: r.name,
          password: DEFAULT_PASSWORD,
          role: r.role,
          empNo: r.empNo ?? undefined,
          employmentType: r.employmentType,
          hireDate: r.hireDate ?? undefined,
        })
        empId = created.employeeId
        done.push("created")
      } else {
        empId = p.employee.id
        if (p.currentEmail !== r.email) {
          const { error } = await admin.auth.admin.updateUserById(p.employee.user_id, { email: r.email, email_confirm: true })
          if (error) throw new Error(`updateUserById(email): ${error.message}`)
          done.push("email_changed")
        }
        // 既有帳號重設密碼失敗（例如 Supabase 弱密碼防護拒絕這把預設密碼）不中斷：其餘資料照填，最後標成 partial 交人工處理
        try {
          await api("POST", `/employees/${empId}/reset-password`, { password: DEFAULT_PASSWORD })
          done.push("password_reset+must_change")
        } catch (err) {
          partialErrors.push(`password_reset_failed: ${err.message}`)
        }
        const patch = { empNo: r.empNo ?? undefined, role: r.role, employmentType: r.employmentType }
        if (r.hireDate) patch.hireDate = r.hireDate
        await api("PATCH", `/employees/${empId}`, patch)
        done.push("patched")
      }
      p.employeeId = empId

      // 個人資料（upsert，只送有值的欄位；姓氏＝首字）
      const profile = { personalEmail: r.email, lastName: r.name.slice(0, 1), firstName: r.name.slice(1) || r.name }
      if (r.birthday) profile.birthday = r.birthday
      if (r.phone) profile.phone = r.phone
      if (r.note) profile.note = r.note
      await api("PUT", `/employees/${empId}/profile`, profile)
      done.push("profile")

      // 職務經歷（職稱）
      if (r.title) {
        const detail = await api("GET", `/employees/${empId}/profile`)
        const history = detail.jobHistory ?? []
        if (history.some((h) => h.title === r.title)) {
          done.push("job_history_exists")
        } else if (p.action === "update" && history.length > 0) {
          const earliest = [...history].sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)))[0]
          const upd = { title: r.title }
          if (r.hireDate) upd.effective_date = r.hireDate
          const { error } = await admin.from("employee_job_history").update(upd).eq("tenant_id", tenantId).eq("id", earliest.id)
          if (error) throw new Error(`job_history update: ${error.message}`)
          done.push(history.length > 1 ? "job_history_rewritten(earliest_of_many)" : "job_history_rewritten")
        } else {
          await api("POST", `/employees/${empId}/job-history`, {
            effectiveDate: r.hireDate ?? todayKey(),
            action: r.hireDate ? (cfg.jobHistoryActionNew ?? "新進") : (cfg.jobHistoryActionNoHireDate ?? "資料建檔（到職日待補）"),
            title: r.title,
          })
          done.push("job_history_added")
        }
      }
      if (partialErrors.length) {
        results.push({ name: r.name, status: "partial", action: p.action, done, errors: partialErrors })
        console.log(`△ ${r.empNo} ${r.name}: ${done.join(", ")} → ${partialErrors.join("; ")}`)
      } else {
        results.push({ name: r.name, status: "ok", action: p.action, done })
        console.log(`✓ ${r.empNo} ${r.name}: ${done.join(", ")}`)
      }
    } catch (err) {
      results.push({ name: r.name, status: "failed", action: p.action, done, error: String(err.message ?? err) })
      console.log(`✗ ${r.empNo} ${r.name}: ${done.join(", ")} → ${err.message}`)
    }
  }

  // 備援簽核者
  if (cfg.fallbackApprover) {
    try {
      const { employees: after } = await api("GET", "/employees")
      const boss = after.find((e) => e.name === cfg.fallbackApprover && e.status === "active")
      if (!boss) throw new Error(`找不到 ${cfg.fallbackApprover}`)
      const cur = await api("GET", "/api/tenant/branding")
      const approval = { ...(cur.features?.approval ?? {}), fallbackApproverEmpId: boss.id }
      await api("PUT", "/api/tenant/settings", { features: { approval } })
      results.push({ name: cfg.fallbackApprover, status: "ok", action: "fallback_approver", employeeId: boss.id })
      console.log(`✓ 備援簽核者 → ${cfg.fallbackApprover} (${boss.id})`)
    } catch (err) {
      results.push({ name: cfg.fallbackApprover, status: "failed", action: "fallback_approver", error: String(err.message ?? err) })
      console.log(`✗ 備援簽核者: ${err.message}`)
    }
  }

  const failed = results.filter((x) => x.status !== "ok")
  console.log(`\n完成：成功 ${results.length - failed.length}、失敗／跳過 ${failed.length}`)
  writeSummary(args, plan, results)
  if (failed.length) process.exit(1)
}

function writeSummary(args, plan, results) {
  const outPath = args.out ?? join(dirname(resolve(args.config)), "import-employees-summary.json")
  const summary = {
    at: new Date().toISOString(),
    dryRun: args.dryRun,
    plan: plan.map((p) => ({
      row: p.rec.row,
      action: p.action,
      empNo: p.rec.empNo,
      name: p.rec.name,
      title: p.rec.title,
      role: p.rec.role,
      employmentType: p.rec.employmentType,
      email: maskEmail(p.rec.email),
      birthday: maskDate(p.rec.birthday),
      phone: maskPhone(p.rec.phone),
      hireDate: p.rec.hireDate,
      hasNote: Boolean(p.rec.note),
      employeeId: p.employeeId ?? p.employee?.id ?? null,
      warnings: p.rec.warnings,
      errors: p.errors,
    })),
    results,
  }
  writeFileSync(outPath, JSON.stringify(summary, null, 2))
  console.log(`彙總已寫到 ${outPath}`)
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message ?? err}`)
  process.exit(1)
})
