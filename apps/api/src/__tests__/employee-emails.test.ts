import { describe, it, expect, vi, beforeEach } from "vitest"

// 不打真 Supabase：把 auth.admin.listUsers 換成可控的 mock，只驗分頁與過濾邏輯。
const { listUsers } = vi.hoisted(() => ({ listUsers: vi.fn() }))
vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: { auth: { admin: { listUsers } } },
}))

import { emailsByUserId } from "../services/employee-emails.js"

function page(users: Array<{ id: string; email?: string }>) {
  return { data: { users, aud: "authenticated", nextPage: null, lastPage: 1, total: users.length }, error: null }
}

beforeEach(() => {
  listUsers.mockReset()
})

describe("emailsByUserId", () => {
  it("沒有要查的 id 就不呼叫 listUsers，回空 Map", async () => {
    const result = await emailsByUserId([])
    expect(result.size).toBe(0)
    expect(listUsers).not.toHaveBeenCalled()
  })

  it("只保留有在 userIds 裡的使用者；沒 email 的回 null；找不到的不進 Map", async () => {
    listUsers.mockResolvedValueOnce(page([{ id: "u1", email: "a@x.tw" }, { id: "u2" }, { id: "u3", email: "c@x.tw" }]))
    const result = await emailsByUserId(["u1", "u2", "missing"])
    expect(result.get("u1")).toBe("a@x.tw")
    expect(result.get("u2")).toBeNull()
    expect(result.has("u3")).toBe(false)
    expect(result.has("missing")).toBe(false)
    expect(listUsers).toHaveBeenCalledWith({ page: 1, perPage: 1000 })
  })

  it("整頁都是 1000 筆就翻下一頁，回傳數 < perPage 才停", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `p1-${i}`, email: `${i}@x.tw` }))
    listUsers.mockResolvedValueOnce(page(full)).mockResolvedValueOnce(page([{ id: "target", email: "t@x.tw" }]))
    const result = await emailsByUserId(["target"])
    expect(result.get("target")).toBe("t@x.tw")
    expect(listUsers).toHaveBeenCalledTimes(2)
    expect(listUsers).toHaveBeenLastCalledWith({ page: 2, perPage: 1000 })
  })

  it("要的 id 都找到就提早停，不再翻頁", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `p1-${i}`, email: `${i}@x.tw` }))
    listUsers.mockResolvedValueOnce(page(full))
    const result = await emailsByUserId(["p1-5"])
    expect(result.get("p1-5")).toBe("5@x.tw")
    expect(listUsers).toHaveBeenCalledTimes(1)
  })

  it("listUsers 回錯誤就 throw，訊息含頁碼", async () => {
    listUsers.mockResolvedValueOnce({ data: null, error: { message: "boom" } })
    await expect(emailsByUserId(["u1"])).rejects.toThrow(/page 1: boom/)
  })
})
