import { describe, it, expect } from "vitest"
import { isValidTaiwanTaxId } from "../services/tax-id"

/** 對照組以獨立的 Python 實作算過（財政部 2021 規則）。 */
describe("統一編號檢查碼", () => {
  it.each(["22099131", "96979933", "04541302", "04595257"])("%s 有效", (id) => {
    expect(isValidTaiwanTaxId(id)).toBe(true)
  })
  it.each(["12345678", "11111111", "20938987"])("%s 檢查碼錯", (id) => {
    expect(isValidTaiwanTaxId(id)).toBe(false)
  })
  it("格式不對一律無效", () => {
    for (const bad of ["", "1234567", "123456789", "abcdefgh", "2209913a", "2209 9131"]) expect(isValidTaiwanTaxId(bad)).toBe(false)
  })
  it("第 7 碼為 7 的特例：28 → 視為 1 或 0 都可", () => {
    // 構造：前 6 碼與第 8 碼固定，第 7 碼 = 7，總和 +1 才整除 5 的案例
    const candidates: string[] = []
    for (let n = 0; n < 100000000 && candidates.length < 1; n += 7919) {
      const id = String(n).padStart(8, "0")
      if (id[6] !== "7") continue
      const w = [1, 2, 1, 2, 1, 2, 4, 1]
      let sum = 0
      for (let i = 0; i < 8; i++) {
        const p = Number(id[i]) * w[i]
        sum += Math.floor(p / 10) + (p % 10)
      }
      if (sum % 5 !== 0 && (sum + 1) % 5 === 0) candidates.push(id)
    }
    expect(candidates.length).toBe(1)
    expect(isValidTaiwanTaxId(candidates[0])).toBe(true)
  })
})
