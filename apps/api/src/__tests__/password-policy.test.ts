import { describe, it, expect } from "vitest"
import bcrypt from "bcryptjs"
import { allowWeakInitialPasswordFrom, hashPasswordForGoTrue } from "../services/password-policy"

/**
 * services/password-policy.ts 的純函式部分（不打 DB）：
 *   - hashPasswordForGoTrue 產出 GoTrue 吃得下的 bcrypt 雜湊（$2a$／$2b$、cost 10、可 compare、每次不同 salt）
 *   - allowWeakInitialPasswordFrom 只認 boolean true，其他形狀一律 false（維持 GoTrue 檢查）
 * 真的打 Supabase 的流程在 employees-weak-password-live.test.ts。
 */
describe("hashPasswordForGoTrue", () => {
  it("輸出 bcrypt 格式（$2a$ 或 $2b$ 開頭）且 cost 為 10", async () => {
    const hash = await hashPasswordForGoTrue("password123")
    expect(hash).toMatch(/^\$2[ab]\$10\$/)
    expect(hash.length).toBe(60)
  })

  it("bcrypt.compare 對原文為 true、對別的密碼為 false", async () => {
    const hash = await hashPasswordForGoTrue("password123")
    await expect(bcrypt.compare("password123", hash)).resolves.toBe(true)
    await expect(bcrypt.compare("password1234", hash)).resolves.toBe(false)
  })

  it("同一密碼連 hash 兩次結果不同（salt 隨機）", async () => {
    const a = await hashPasswordForGoTrue("password123")
    const b = await hashPasswordForGoTrue("password123")
    expect(a).not.toBe(b)
  })
})

describe("allowWeakInitialPasswordFrom", () => {
  it("features 沒有／不是物件／accounts 缺席 → false", () => {
    expect(allowWeakInitialPasswordFrom(undefined)).toBe(false)
    expect(allowWeakInitialPasswordFrom(null)).toBe(false)
    expect(allowWeakInitialPasswordFrom("x")).toBe(false)
    expect(allowWeakInitialPasswordFrom({})).toBe(false)
    expect(allowWeakInitialPasswordFrom({ payroll: true, kpi: true })).toBe(false)
    expect(allowWeakInitialPasswordFrom({ accounts: null })).toBe(false)
    expect(allowWeakInitialPasswordFrom({ accounts: {} })).toBe(false)
  })

  it("只有 boolean true 才算開；字串 'true'／1／false 都不算", () => {
    expect(allowWeakInitialPasswordFrom({ accounts: { allowWeakInitialPassword: true } })).toBe(true)
    expect(allowWeakInitialPasswordFrom({ accounts: { allowWeakInitialPassword: false } })).toBe(false)
    expect(allowWeakInitialPasswordFrom({ accounts: { allowWeakInitialPassword: "true" } })).toBe(false)
    expect(allowWeakInitialPasswordFrom({ accounts: { allowWeakInitialPassword: 1 } })).toBe(false)
  })
})
