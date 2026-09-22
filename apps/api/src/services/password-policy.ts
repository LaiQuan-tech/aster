import bcrypt from "bcryptjs"
import { supabaseAdmin } from "../lib/supabase.js"

/**
 * HR 配發初始密碼的租戶政策（tenants.features.accounts.allowWeakInitialPassword，
 * zod 在 routes/tenant.ts）。
 *
 * 背景：Supabase 專案開著 password_hibp_enabled（外洩密碼名單）時，GoTrue 連
 * admin API 的 createUser({ password }) / updateUserById({ password }) 都會擋
 * （422 weak_password）。但 createUser 若改帶 `password_hash`（bcrypt），GoTrue
 * 視為「從別的系統搬進來的雜湊」直接寫入，不做 HIBP／長度檢查，之後用該密碼登入
 * 正常。租戶若明確允許，HR 就能用像 password123 這種簡單密碼當初始密碼——初始密碼
 * 本來就會被 employees.must_change_password=true 在首次登入時強制改掉。
 *
 * 🔴 只有 createUser 吃 password_hash。GoTrue 的 adminUserUpdate（updateUserById）
 * 完全不讀 password_hash：回 200 但密碼不變（2026-09-22 用 throwaway 帳號實測＋
 * 對照 supabase/auth internal/api/admin.go），帶明文 password 又一定過 HIBP。所以
 * 「管理員直接設定員工密碼」（POST /employees/:id/reset-password 帶 password）在租戶
 * 允許簡單密碼時**繞過 GoTrue**：API 端算好 bcrypt，交給 sql/0038 的
 * `auth_set_user_password`（SECURITY DEFINER，直接寫 auth.users.encrypted_password
 * 並刪掉該使用者所有 auth.sessions），見下方 setPasswordDirect。租戶沒開開關時仍走
 * updateUserById({ password })、仍受 GoTrue 檢查。
 *
 * 員工自設的新密碼（services/auth-invite.ts changeOwnPassword、set-password）走
 * `password` 明文路徑、仍受 GoTrue 檢查，這裡不碰。
 */

/** bcrypt cost；GoTrue 自己存密碼也是 10，再高只是拖慢建帳號。 */
const BCRYPT_COST = 10

/** 產生可直接交給 GoTrue admin createUser `password_hash` 的 bcrypt 雜湊（$2b$10$…）。 */
export async function hashPasswordForGoTrue(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST)
}

/** 純函式：從 tenants.features 讀開關。未設定／非 boolean true 一律 false（維持 GoTrue 檢查）。 */
export function allowWeakInitialPasswordFrom(features: unknown): boolean {
  if (!features || typeof features !== "object") return false
  const accounts = (features as Record<string, unknown>).accounts
  if (!accounts || typeof accounts !== "object") return false
  return (accounts as { allowWeakInitialPassword?: unknown }).allowWeakInitialPassword === true
}

/** 該租戶是否允許 HR 配發簡單初始密碼（每次即時讀 DB，不快取：後台勾選要立刻生效）。 */
export async function allowWeakInitialPassword(tenantId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`allowWeakInitialPassword: ${error.message}`)
  return allowWeakInitialPasswordFrom(data?.features)
}

/** GoTrue admin createUser 收密碼的兩種形狀：明文（受 HIBP 檢查）或 bcrypt 雜湊（不檢查）。 */
export type CreateUserPasswordAttributes = { password: string } | { password_hash: string }

/**
 * 依租戶設定決定 **createUser** 要帶哪一種密碼欄位：允許弱密碼 → `{ password_hash }`；
 * 否則 `{ password }` 維持原本的 GoTrue 檢查。兩種形狀互斥（GoTrue 兩個都帶會 400），
 * 呼叫端把回傳值展開進 createUser 參數即可，不要再另外帶 password。
 * 不要拿去餵 updateUserById——它不吃 password_hash（見檔頭）。
 */
export async function createUserPasswordAttributes(tenantId: string, plain: string): Promise<CreateUserPasswordAttributes> {
  if (await allowWeakInitialPassword(tenantId)) return { password_hash: await hashPasswordForGoTrue(plain) }
  return { password: plain }
}

/**
 * 繞過 GoTrue 直接設定某 auth user 的密碼（sql/0038 `auth_set_user_password`）：
 * bcrypt 由這裡算、DB 函式只認 $2a$/$2b$/$2y$ 雜湊，寫完會刪掉該使用者所有 auth.sessions
 * （舊裝置的 refresh 立刻失效，手上的 access token 最多再活到到期）。
 *
 * 只給「租戶允許簡單密碼」的重設路徑用——GoTrue admin 沒有能略過 HIBP 的重設方式（見檔頭）。
 * 回 false＝找不到該 user（或已軟刪除），沒有寫入；RPC 本身出錯（含 anon 呼叫被 42501 擋、
 * 雜湊格式不對的 invalid_password_hash）直接 throw。
 * ⚠️ 呼叫端必須先確認該 user 屬於本租戶（routes/employees.ts 的 belongsToTenant）；DB 函式
 * 只擋「誰能呼叫」（service_role），不擋「改誰」。
 */
export async function setPasswordDirect(userId: string, plain: string): Promise<boolean> {
  const hash = await hashPasswordForGoTrue(plain)
  const { data, error } = await supabaseAdmin.rpc("auth_set_user_password", { p_user_id: userId, p_password_hash: hash })
  if (error) throw new Error(`auth_set_user_password: ${error.message}`)
  return data === true
}
