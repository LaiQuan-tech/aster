import { createClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isMailConfigured, sendMail } from "../lib/resend.js"
import { parseCsv } from "../lib/csv.js"
import { logger } from "../lib/logger.js"
import { writeAuditLog } from "./audit.js"

/**
 * 帳號邀請／重設密碼／改密碼（A1）。
 *
 * 寄信路徑刻意**不用** Supabase 的 action_link（會經 Supabase 的 /verify 再
 * redirect，受 redirect allow list 管），而是拿 `generateLink` 回的
 * `hashed_token` 自組 `${WEB_URL}/auth/set-password?token_hash=…&type=…`，
 * 前端再用 `verifyOtp({ token_hash, type })` 換 session、`updateUser({ password })`
 * 設密碼。信件由我們自己（Resend）寄，Supabase 的 SMTP 完全不碰。
 *
 * `RESEND_API_KEY` 未設或呼叫端指定 dryRun → 不寄信、把連結回給 HR 手動轉交。
 *
 * 帳號存在與否的判斷：先 `generateLink({ type: "recovery" })`——存在就直接拿到
 * recovery token（要寄的就是它）；回 404 `user_not_found` 才走 `invite`（會建
 * auth user）。`invite` 的 `options.data` 只會進 user_metadata，`app_metadata.tenant_id`
 * （requireTenant／RLS 讀的那個）要再用 `updateUserById` 補上，跟 `POST /employees`
 * 的 `createUser({ app_metadata: { tenant_id } })` 對齊。
 */

export type LinkType = "invite" | "recovery"

export class AccountError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? code)
    this.name = "AccountError"
  }
}

const DEFAULT_WEB_URL = "https://aster-system.vercel.app"
const DEFAULT_APP_NAME = "亞斯特系統"

export function webUrl(): string {
  return (process.env.WEB_URL?.trim() || DEFAULT_WEB_URL).replace(/\/+$/, "")
}

export function buildSetPasswordLink(hashedToken: string, type: LinkType): string {
  return `${webUrl()}/auth/set-password?token_hash=${encodeURIComponent(hashedToken)}&type=${type}`
}

export interface AuthUserLite {
  id: string
  email: string | null
  appMetadata: Record<string, unknown>
}

interface LinkToken {
  user: AuthUserLite
  hashedToken: string
  type: LinkType
}

function liteUser(user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> }): AuthUserLite {
  return { id: user.id, email: user.email ?? null, appMetadata: user.app_metadata ?? {} }
}

/** 既有 auth user → recovery token；查無（404 user_not_found）→ null。 */
export async function recoveryLinkFor(email: string): Promise<LinkToken | null> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: "recovery", email })
  if (error) {
    if (error.status === 404 || error.code === "user_not_found") return null
    throw new Error(`generateLink(recovery): ${error.message}`)
  }
  if (!data?.user || !data.properties?.hashed_token) throw new Error("generateLink(recovery): empty response")
  return { user: liteUser(data.user), hashedToken: data.properties.hashed_token, type: "recovery" }
}

/** 建 auth user（未確認、無密碼）並取 invite token；同時把 app_metadata.tenant_id 補齊。 */
export async function inviteLinkFor(email: string, tenantId: string): Promise<LinkToken> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { data: { tenant_id: tenantId } },
  })
  if (error || !data?.user || !data.properties?.hashed_token) {
    throw new Error(`generateLink(invite): ${error?.message ?? "empty response"}`)
  }
  const userId = data.user.id
  const { data: updated, error: metaErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    app_metadata: { tenant_id: tenantId },
  })
  if (metaErr) {
    await supabaseAdmin.auth.admin.deleteUser(userId)
    throw new Error(`invite: set app_metadata failed: ${metaErr.message}`)
  }
  return {
    user: liteUser(updated.user ?? data.user),
    hashedToken: data.properties.hashed_token,
    type: "invite",
  }
}

/**
 * 依 email 決定該寄 invite 還是 recovery，並確保 auth user 屬於本租戶且尚未
 * 綁到本租戶其他員工列。回傳的 `fresh` 表示 auth user 是這次新建的（呼叫端
 * 之後若寫 employees 失敗要把它刪掉，避免留下孤兒帳號）。
 */
export async function resolveAuthUserForEmail(
  tenantId: string,
  email: string,
): Promise<LinkToken & { fresh: boolean }> {
  const existing = await recoveryLinkFor(email)
  if (existing) {
    const userTenant = existing.user.appMetadata.tenant_id
    if (userTenant && userTenant !== tenantId) {
      throw new AccountError("email_in_other_tenant", 409, "此 Email 已屬於其他公司的帳號")
    }
    const { data: bound, error: boundErr } = await supabaseAdmin
      .from("employees")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("user_id", existing.user.id)
      .maybeSingle()
    if (boundErr) throw new Error(`resolveAuthUserForEmail (bound): ${boundErr.message}`)
    if (bound) {
      throw new AccountError("email_already_bound", 409, `此 Email 已綁定員工「${bound.name as string}」`)
    }
    if (!userTenant) {
      const { error: metaErr } = await supabaseAdmin.auth.admin.updateUserById(existing.user.id, {
        app_metadata: { tenant_id: tenantId },
      })
      if (metaErr) throw new Error(`resolveAuthUserForEmail (app_metadata): ${metaErr.message}`)
      existing.user.appMetadata = { ...existing.user.appMetadata, tenant_id: tenantId }
    }
    return { ...existing, fresh: false }
  }
  const created = await inviteLinkFor(email, tenantId)
  return { ...created, fresh: true }
}

/**
 * 把 auth user 綁到員工列（只綁 `user_id is null` 的列；同時清 must_change_password，
 * 因為 invite／recovery 路徑是員工自己設密碼）。撞到 employees_user_id_uq → 409。
 */
export async function bindEmployeeUser(opts: {
  tenantId: string
  employeeId: string
  userId: string
  extra?: Record<string, unknown>
  actorEmpId?: string | null
  context: string
}): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .update({ user_id: opts.userId, must_change_password: false, ...(opts.extra ?? {}) })
    .eq("tenant_id", opts.tenantId)
    .eq("id", opts.employeeId)
    .is("user_id", null)
    .select("id")
    .maybeSingle()
  if (error) {
    if (error.code === "23505") throw new AccountError("user_already_bound", 409, "此帳號已綁定其他員工")
    throw new Error(`bindEmployeeUser: ${error.message}`)
  }
  if (!data) throw new AccountError("already_bound", 409, "此員工已綁定登入帳號")
  await writeAuditLog({
    tenantId: opts.tenantId,
    tableName: "employees",
    recordId: opts.employeeId,
    action: "UPDATE",
    oldRow: { user_id: null },
    newRow: { user_id: opts.userId, must_change_password: false, ...(opts.extra ?? {}) },
    actorEmpId: opts.actorEmpId ?? null,
    context: opts.context,
  })
}

/* ── 信件 ─────────────────────────────────────────────────────────── */

export interface DeliverInput {
  to: string
  name: string | null
  type: LinkType
  hashedToken: string
  dryRun: boolean
  appName?: string | null
}

export interface DeliverResult {
  sent: boolean
  dryRun: boolean
  type: LinkType
  /** 只在 dryRun 回傳（HR 複製後手動轉交）。 */
  link?: string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function composeMail(input: { name: string | null; type: LinkType; link: string; appName?: string | null }) {
  const app = input.appName?.trim() || DEFAULT_APP_NAME
  const greeting = input.name ? `${input.name} 您好：` : "您好："
  const isInvite = input.type === "invite"
  const subject = isInvite ? "亞斯特系統帳號啟用" : "亞斯特系統重設密碼"
  const lead = isInvite
    ? `HR 已為您在「${app}」建立登入帳號，請點下方連結設定您的登入密碼：`
    : `我們收到了重設「${app}」登入密碼的請求，請點下方連結設定新密碼：`
  const tail = isInvite
    ? "連結 24 小時內有效；逾期請洽 HR 重新寄送邀請信。"
    : "連結 24 小時內有效；若您沒有提出這項請求，請忽略此信，密碼不會被更動。"
  const text = [greeting, "", lead, "", input.link, "", tail, "", "此信由系統自動寄出，請勿直接回覆。"].join("\n")
  const html = [
    `<div style="font-family:-apple-system,'Noto Sans TC',sans-serif;font-size:15px;line-height:1.7;color:#1f2937">`,
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(lead)}</p>`,
    `<p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 18px;background:#1F4E79;color:#fff;border-radius:6px;text-decoration:none">${isInvite ? "設定密碼並啟用帳號" : "設定新密碼"}</a></p>`,
    `<p style="font-size:13px;color:#6b7280">按鈕無法點擊時，請複製下列網址到瀏覽器開啟：<br><a href="${escapeHtml(input.link)}">${escapeHtml(input.link)}</a></p>`,
    `<p style="font-size:13px;color:#6b7280">${escapeHtml(tail)}</p>`,
    `<p style="font-size:12px;color:#9ca3af">此信由系統自動寄出，請勿直接回覆。</p>`,
    `</div>`,
  ].join("")
  return { subject, text, html }
}

export async function deliverAccountLink(input: DeliverInput): Promise<DeliverResult> {
  const link = buildSetPasswordLink(input.hashedToken, input.type)
  const dryRun = input.dryRun || !isMailConfigured()
  if (dryRun) {
    return { sent: false, dryRun: true, type: input.type, link }
  }
  const mail = composeMail({ name: input.name, type: input.type, link, appName: input.appName })
  await sendMail({ to: input.to, ...mail })
  return { sent: true, dryRun: false, type: input.type }
}

async function tenantAppName(tenantId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("tenants").select("name, branding").eq("id", tenantId).maybeSingle()
  const branding = (data?.branding as Record<string, unknown> | null) ?? null
  const appName = branding?.appName
  if (typeof appName === "string" && appName.trim()) return appName.trim()
  return (data?.name as string | null) ?? null
}

/* ── 單筆：邀請 / 重設 ─────────────────────────────────────────────── */

export interface EmployeeAccountRow {
  id: string
  user_id: string | null
  name: string
}

export interface LinkOutcome extends DeliverResult {
  email: string
  /** created＝新建員工列；bound＝既有列綁上帳號；existing＝本來就有帳號（只寄信）。 */
  action: "created" | "bound" | "existing"
}

async function profileEmail(tenantId: string, employeeId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("employee_profiles")
    .select("company_email, personal_email")
    .eq("tenant_id", tenantId)
    .eq("employee_id", employeeId)
    .maybeSingle()
  const company = (data?.company_email as string | null)?.trim()
  const personal = (data?.personal_email as string | null)?.trim()
  return company || personal || null
}

/**
 * 對一位員工寄帳號信：已綁帳號 → recovery；未綁但 email 已有 auth user → 綁上後
 * recovery；都沒有 → invite（建 auth user、回填 user_id）。`forceRecovery`（HR 的
 * 「寄重設密碼信」）對沒帳號的員工回 409 no_account，不會偷建帳號。
 */
export async function sendEmployeeAccountLink(opts: {
  tenantId: string
  employee: EmployeeAccountRow
  email?: string | null
  dryRun?: boolean
  forceRecovery?: boolean
  actorEmpId?: string | null
  context: string
}): Promise<LinkOutcome> {
  const { tenantId, employee } = opts
  const appName = await tenantAppName(tenantId)

  if (employee.user_id) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(employee.user_id)
    if (error || !data.user) throw new AccountError("auth_user_missing", 409, "員工綁定的登入帳號已不存在")
    const email = data.user.email ?? null
    if (!email) throw new AccountError("no_email", 409, "登入帳號沒有 Email")
    const token = await recoveryLinkFor(email)
    if (!token) throw new AccountError("auth_user_missing", 409, "員工綁定的登入帳號已不存在")
    const delivered = await deliverAccountLink({
      to: email,
      name: employee.name,
      type: "recovery",
      hashedToken: token.hashedToken,
      dryRun: !!opts.dryRun,
      appName,
    })
    await writeAuditLog({
      tenantId,
      tableName: "employees",
      recordId: employee.id,
      action: "UPDATE",
      newRow: { account_link: "recovery", sent: delivered.sent, dryRun: delivered.dryRun },
      actorEmpId: opts.actorEmpId ?? null,
      context: opts.context,
    })
    return { ...delivered, email, action: "existing" }
  }

  if (opts.forceRecovery) throw new AccountError("no_account", 409, "此員工尚未綁定登入帳號")

  const email = opts.email?.trim().toLowerCase() || (await profileEmail(tenantId, employee.id))
  if (!email) throw new AccountError("no_email", 409, "此員工沒有 Email（請在 My Data 填公司或私人信箱，或在邀請時指定）")

  const resolved = await resolveAuthUserForEmail(tenantId, email)
  try {
    await bindEmployeeUser({
      tenantId,
      employeeId: employee.id,
      userId: resolved.user.id,
      actorEmpId: opts.actorEmpId,
      context: opts.context,
    })
  } catch (err) {
    if (resolved.fresh) await supabaseAdmin.auth.admin.deleteUser(resolved.user.id)
    throw err
  }
  const delivered = await deliverAccountLink({
    to: email,
    name: employee.name,
    type: resolved.type,
    hashedToken: resolved.hashedToken,
    dryRun: !!opts.dryRun,
    appName,
  })
  return { ...delivered, email, action: "bound" }
}

/* ── 批次：CSV ─────────────────────────────────────────────────────── */

export interface BulkRowResult {
  line: number
  name: string | null
  email: string | null
  action: "created" | "bound" | "skipped"
  type?: LinkType
  sent?: boolean
  link?: string
  warning?: string
  error?: string
}

export interface BulkInviteSummary {
  created: number
  bound: number
  invited: number
  sent: number
  skipped: number
  dryRun: boolean
  errors: Array<{ line: number; error: string }>
  rows: BulkRowResult[]
}

interface EmployeeLite {
  id: string
  name: string
  emp_no: string | null
  user_id: string | null
  dept_id: string | null
  hire_date: string | null
  status: string
}

const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  姓名: "name",
  email: "email",
  "e-mail": "email",
  信箱: "email",
  empno: "empNo",
  emp_no: "empNo",
  工號: "empNo",
  deptname: "deptName",
  dept: "deptName",
  部門: "deptName",
  單位: "deptName",
  employmenttype: "employmentType",
  employment_type: "employmentType",
  身分類別: "employmentType",
  hiredate: "hireDate",
  hire_date: "hireDate",
  到職日: "hireDate",
  role: "role",
  角色: "role",
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function bulkInviteFromCsv(opts: {
  tenantId: string
  csv: string
  dryRun?: boolean
  actorEmpId?: string | null
  context: string
}): Promise<BulkInviteSummary> {
  const { tenantId } = opts
  const table = parseCsv(opts.csv)
  const headerIdx = table.findIndex((r) => r.length > 0)
  if (headerIdx < 0) throw new AccountError("empty_csv", 400, "CSV 沒有內容")
  const headers = table[headerIdx].map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? h.trim())
  if (!headers.includes("name") || !headers.includes("email")) {
    throw new AccountError("invalid_header", 400, "表頭至少要有 name 與 email 兩欄")
  }

  const [{ data: empRows, error: empErr }, { data: deptRows, error: deptErr }] = await Promise.all([
    supabaseAdmin
      .from("employees")
      .select("id, name, emp_no, user_id, dept_id, hire_date, status")
      .eq("tenant_id", tenantId),
    supabaseAdmin.from("departments").select("id, name").eq("tenant_id", tenantId),
  ])
  if (empErr) throw new Error(`bulk-invite (employees): ${empErr.message}`)
  if (deptErr) throw new Error(`bulk-invite (departments): ${deptErr.message}`)
  const employees = (empRows ?? []) as EmployeeLite[]
  const deptByName = new Map<string, string>()
  for (const d of deptRows ?? []) deptByName.set((d.name as string).trim(), d.id as string)

  const appName = await tenantAppName(tenantId)
  const dryRun = !!opts.dryRun || !isMailConfigured()
  const summary: BulkInviteSummary = {
    created: 0,
    bound: 0,
    invited: 0,
    sent: 0,
    skipped: 0,
    dryRun,
    errors: [],
    rows: [],
  }

  const skip = (line: number, name: string | null, email: string | null, error: string) => {
    summary.skipped += 1
    summary.errors.push({ line, error })
    summary.rows.push({ line, name, email, action: "skipped", error })
  }

  for (let i = headerIdx + 1; i < table.length; i++) {
    const cells = table[i]
    if (cells.length === 0) continue
    const line = i + 1
    const raw: Record<string, string> = {}
    headers.forEach((h, col) => {
      const v = (cells[col] ?? "").trim()
      if (v) raw[h] = v
    })
    const name = raw.name ?? null
    const email = raw.email?.toLowerCase() ?? null
    try {
      if (!name) {
        skip(line, name, email, "name 必填")
        continue
      }
      if (!email || !EMAIL_RE.test(email)) {
        skip(line, name, email, "email 必填且須為有效格式")
        continue
      }
      if (raw.hireDate && !DATE_RE.test(raw.hireDate)) {
        skip(line, name, email, "hireDate 須為 YYYY-MM-DD")
        continue
      }
      const empNo = raw.empNo ?? null
      let warning: string | undefined
      let deptId: string | null = null
      if (raw.deptName) {
        deptId = deptByName.get(raw.deptName) ?? null
        if (!deptId) warning = `dept_not_found: 找不到部門「${raw.deptName}」，已留空`
      }

      // ── 找既有列：工號 → 唯一同名 → 新建 ──
      let target: EmployeeLite | null = null
      if (empNo) {
        const hits = employees.filter((e) => e.emp_no === empNo)
        const free = hits.filter((e) => !e.user_id)
        if (free.length === 1) target = free[0]
        else if (free.length > 1) {
          skip(line, name, email, `ambiguous_emp_no: 工號 ${empNo} 有 ${free.length} 列未綁帳號`)
          continue
        } else if (hits.length > 0) {
          skip(line, name, email, `emp_no_already_bound: 工號 ${empNo} 的員工已有登入帳號`)
          continue
        }
      }
      if (!target) {
        const sameName = employees.filter((e) => e.name === name && !e.user_id && e.status === "active")
        if (sameName.length === 1) target = sameName[0]
        else if (sameName.length > 1) {
          skip(line, name, email, `ambiguous_name: 有 ${sameName.length} 位同名且未綁帳號的員工，請補工號`)
          continue
        }
      }

      const resolved = await resolveAuthUserForEmail(tenantId, email)
      let action: "created" | "bound"
      try {
        if (target) {
          // 只補空值，不覆蓋既有資料。
          const extra: Record<string, unknown> = {}
          if (empNo && !target.emp_no) extra.emp_no = empNo
          if (deptId && !target.dept_id) extra.dept_id = deptId
          if (raw.hireDate && !target.hire_date) extra.hire_date = raw.hireDate
          await bindEmployeeUser({
            tenantId,
            employeeId: target.id,
            userId: resolved.user.id,
            extra,
            actorEmpId: opts.actorEmpId,
            context: opts.context,
          })
          target.user_id = resolved.user.id
          if (extra.emp_no) target.emp_no = extra.emp_no as string
          action = "bound"
        } else {
          const insert = {
            tenant_id: tenantId,
            user_id: resolved.user.id,
            name,
            role: raw.role ?? "employee",
            dept_id: deptId,
            emp_no: empNo,
            employment_type: raw.employmentType ?? "regular",
            hire_date: raw.hireDate ?? null,
            status: "active",
            must_change_password: false,
          }
          const { data: created, error: insErr } = await supabaseAdmin
            .from("employees")
            .insert(insert)
            .select("id")
            .single()
          if (insErr || !created) {
            if (insErr?.code === "23505") throw new AccountError("user_already_bound", 409, "此帳號已綁定其他員工")
            throw new Error(`bulk-invite insert: ${insErr?.message}`)
          }
          const employeeId = created.id as string
          employees.push({
            id: employeeId,
            name,
            emp_no: empNo,
            user_id: resolved.user.id,
            dept_id: deptId,
            hire_date: raw.hireDate ?? null,
            status: "active",
          })
          await writeAuditLog({
            tenantId,
            tableName: "employees",
            recordId: employeeId,
            action: "INSERT",
            newRow: insert,
            actorEmpId: opts.actorEmpId ?? null,
            context: opts.context,
          })
          action = "created"
        }
      } catch (err) {
        if (resolved.fresh) await supabaseAdmin.auth.admin.deleteUser(resolved.user.id)
        throw err
      }

      if (action === "created") summary.created += 1
      else summary.bound += 1
      summary.invited += 1

      const row: BulkRowResult = { line, name, email, action, type: resolved.type, warning }
      try {
        const delivered = await deliverAccountLink({
          to: email,
          name,
          type: resolved.type,
          hashedToken: resolved.hashedToken,
          dryRun,
          appName,
        })
        row.sent = delivered.sent
        if (delivered.link) row.link = delivered.link
        if (delivered.sent) summary.sent += 1
      } catch (err) {
        // 列已建立／綁定，只是信沒寄出：保留 action，另外回報錯誤。
        const msg = err instanceof Error ? err.message : "mail_failed"
        row.sent = false
        row.error = `mail_failed: ${msg}`
        summary.errors.push({ line, error: row.error })
      }
      summary.rows.push(row)
    } catch (err) {
      const msg = err instanceof AccountError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : "failed"
      skip(line, name, email, msg)
    }
  }

  return summary
}

/* ── 忘記密碼（未登入） ─────────────────────────────────────────────── */

const forgotLastSent = new Map<string, number>()
const FORGOT_WINDOW_MS = 60_000

/**
 * 找得到帳號才寄 recovery；同一 email 60 秒內只寄一次。回傳值只給呼叫端做
 * log／測試用，端點一律回 `{ ok: true }`，不透露帳號是否存在。
 */
export async function requestPasswordReset(emailRaw: string): Promise<{ sent: boolean; found: boolean; throttled: boolean }> {
  const email = emailRaw.trim().toLowerCase()
  const now = Date.now()
  const last = forgotLastSent.get(email) ?? 0
  if (now - last < FORGOT_WINDOW_MS) return { sent: false, found: false, throttled: true }
  forgotLastSent.set(email, now)
  // 簡單防止 Map 無限成長。
  if (forgotLastSent.size > 5000) {
    for (const [k, t] of forgotLastSent) if (now - t > FORGOT_WINDOW_MS) forgotLastSent.delete(k)
  }

  const token = await recoveryLinkFor(email)
  if (!token) return { sent: false, found: false, throttled: false }
  const tenantId = token.user.appMetadata.tenant_id
  const appName = typeof tenantId === "string" ? await tenantAppName(tenantId) : null
  const delivered = await deliverAccountLink({
    to: email,
    name: null,
    type: "recovery",
    hashedToken: token.hashedToken,
    dryRun: false,
    appName,
  })
  if (delivered.dryRun) {
    // 沒設 RESEND_API_KEY：不寄信。連結只在 debug level 記（本機除錯用）。
    logger.warn({ email }, "forgot-password: RESEND_API_KEY not set, mail not sent (dryRun)")
    logger.debug({ link: delivered.link }, "forgot-password dryRun link")
  }
  return { sent: delivered.sent, found: true, throttled: false }
}

/* ── 已登入：改密碼 / 清旗標 ───────────────────────────────────────── */

/** 用舊密碼登入一次驗證身分，再以 admin 改密碼並清 must_change_password。 */
export async function changeOwnPassword(opts: {
  tenantId: string
  userId: string
  email: string
  currentPassword: string
  newPassword: string
}): Promise<void> {
  const url = process.env.SUPABASE_URL ?? ""
  const anonKey = process.env.SUPABASE_ANON_KEY ?? ""
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email: opts.email, password: opts.currentPassword })
  if (error || !data.session || data.user?.id !== opts.userId) {
    throw new AccountError("invalid_current_password", 401, "目前密碼不正確")
  }
  // 驗證用的那個 session 立刻登出，不留多餘的 refresh token。
  await supabaseAdmin.auth.admin.signOut(data.session.access_token, "local").catch(() => undefined)

  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(opts.userId, { password: opts.newPassword })
  if (updErr) throw new Error(`changeOwnPassword: ${updErr.message}`)
  await clearMustChangePassword({ tenantId: opts.tenantId, userId: opts.userId, context: "POST /me/password" })
}

/** 清掉自己的 must_change_password（只動 (tenant_id, user_id) 是本人的那一列）。 */
export async function clearMustChangePassword(opts: {
  tenantId: string
  userId: string
  context: string
}): Promise<{ employeeId: string | null; cleared: boolean }> {
  const { data: emp, error } = await supabaseAdmin
    .from("employees")
    .select("id, must_change_password")
    .eq("tenant_id", opts.tenantId)
    .eq("user_id", opts.userId)
    .maybeSingle()
  if (error) throw new Error(`clearMustChangePassword (load): ${error.message}`)
  if (!emp) return { employeeId: null, cleared: false }
  if (!emp.must_change_password) return { employeeId: emp.id as string, cleared: false }
  const { error: updErr } = await supabaseAdmin
    .from("employees")
    .update({ must_change_password: false })
    .eq("tenant_id", opts.tenantId)
    .eq("id", emp.id)
  if (updErr) throw new Error(`clearMustChangePassword (update): ${updErr.message}`)
  await writeAuditLog({
    tenantId: opts.tenantId,
    tableName: "employees",
    recordId: emp.id as string,
    action: "UPDATE",
    oldRow: { must_change_password: true },
    newRow: { must_change_password: false },
    actorEmpId: emp.id as string,
    context: opts.context,
  })
  return { employeeId: emp.id as string, cleared: true }
}
