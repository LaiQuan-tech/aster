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
 * 對照 supabase/auth internal/api/admin.go）。所以 reset-password 仍走明文 password、
 * 仍受 GoTrue 檢查；HR 要略過 HIBP 只能用後端產生的隨機暫時密碼（不帶 body）。
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
