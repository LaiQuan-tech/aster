import { supabaseAdmin } from "../lib/supabase.js"

/**
 * 員工列表要顯示 Email，但 email 不在 employees 表、在 Supabase auth.users
 * （employees.user_id → auth user）。這裡用 Auth Admin API 逐頁撈全部使用者，
 * 只留呼叫端要的那些 user_id；不另開 DB view／migration。
 *
 * 一頁最多 1000 筆（GoTrue 上限），直到回傳筆數 < perPage 就停。
 * 找不到的 user_id（帳號已刪）不會出現在 Map 裡，呼叫端以 `?? null` 補。
 */
const PER_PAGE = 1000

export async function emailsByUserId(userIds: string[]): Promise<Map<string, string | null>> {
  const wanted = new Set(userIds.filter((id) => id.length > 0))
  const result = new Map<string, string | null>()
  if (wanted.size === 0) return result

  for (let page = 1; ; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) throw new Error(`emailsByUserId: listUsers page ${page}: ${error.message}`)
    const users = data?.users ?? []
    for (const user of users) {
      if (wanted.has(user.id)) result.set(user.id, user.email ?? null)
    }
    // 全部要的都找到了就不用再翻頁。
    if (result.size >= wanted.size) break
    if (users.length < PER_PAGE) break
  }
  return result
}
