import { describe, it, expect } from "vitest"
import {
  formatCode,
  parseSeq,
  isUniqueViolation,
  MAX_CODE_ATTEMPTS,
} from "../services/project-code"

/**
 * 專案編號的格式與流水號解析（模組四第 1 條）。
 *
 * 這裡只測純函式——`nextProjectCode()` 要連 DB，屬於整合測試的範圍。
 * 但真正容易出錯的就是這幾個純函式：補零、年度比對、以及「人工編號不得
 * 參與流水號計算」。
 */

describe("formatCode", () => {
  it("產生 P{年}-{三位流水號}", () => {
    expect(formatCode(2026, 1)).toBe("P2026-001")
    expect(formatCode(2026, 42)).toBe("P2026-042")
    expect(formatCode(2026, 999)).toBe("P2026-999")
  })

  it("超過三位不截斷，繼續長出去", () => {
    // 一年開超過 999 個案子時，編號變四位而不是繞回 000——
    // 繞回會造成撞號，unique index 會擋下，但那是把問題丟給 DB。
    expect(formatCode(2026, 1000)).toBe("P2026-1000")
  })

  it("年度直接取用，不做任何換算", () => {
    expect(formatCode(2025, 7)).toBe("P2025-007")
    expect(formatCode(2030, 7)).toBe("P2030-007")
  })
})

describe("parseSeq", () => {
  it("取出流水號（含前導零）", () => {
    expect(parseSeq("P2026-001", 2026)).toBe(1)
    expect(parseSeq("P2026-042", 2026)).toBe(42)
    expect(parseSeq("P2026-1000", 2026)).toBe(1000)
  })

  it("年度不符回 null——流水號每年重置，別年的號不參與計算", () => {
    expect(parseSeq("P2025-050", 2026)).toBeNull()
    expect(parseSeq("P2026-050", 2025)).toBeNull()
  })

  it("人工編號回 null，不會把之後的自動編號推高", () => {
    // 一筆手打的 ABC-999 若被算進去，下一個自動編號會變成 1000。
    expect(parseSeq("ABC-999", 2026)).toBeNull()
    expect(parseSeq("2026-001", 2026)).toBeNull()
    expect(parseSeq("", 2026)).toBeNull()
  })

  it("只認完整比對，前後多字元都不算", () => {
    expect(parseSeq("XP2026-001", 2026)).toBeNull()
    expect(parseSeq("P2026-001-A", 2026)).toBeNull()
    expect(parseSeq("P2026-00a", 2026)).toBeNull()
  })

  it("與 formatCode 互為反函式", () => {
    for (const n of [1, 9, 10, 99, 100, 999, 1000]) {
      expect(parseSeq(formatCode(2026, n), 2026)).toBe(n)
    }
  })
})

describe("isUniqueViolation", () => {
  it("只認 Postgres 的 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true)
    expect(isUniqueViolation({ code: "23503" })).toBe(false)
    expect(isUniqueViolation({})).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
  })
})

describe("重試上限", () => {
  it("是個正整數——0 會讓系統產號永遠失敗", () => {
    expect(Number.isInteger(MAX_CODE_ATTEMPTS)).toBe(true)
    expect(MAX_CODE_ATTEMPTS).toBeGreaterThan(0)
  })
})
