import { describe, it, expect } from "vitest"
import {
  formatCode,
  parseSeq,
  codeLikePrefix,
  toCodeFormat,
  isUniqueViolation,
  DEFAULT_CODE_FORMAT,
  MAX_CODE_ATTEMPTS,
  parseDupSuffix,
  formatDupCode,
  type CodeFormat,
} from "../services/project-code"
import { duplicateName, archiveReasonFor } from "../services/project-duplicate"

/**
 * 專案編號的格式與流水號解析（模組四第 1 條；P3 改成可設定格式）。
 *
 * 這裡只測純函式——`nextProjectCode()` 要連 DB，屬於整合測試的範圍
 * （projects-application.test.ts）。真正容易出錯的是這幾個純函式：民國年換算、
 * 補零、年度比對、以及「人工編號不得參與流水號計算」。
 * roc／ad 兩種年度取法用同一組案例跑（table-driven），免得改一邊漏一邊。
 */

const ROC: CodeFormat = { prefix: "AT", yearStyle: "roc", seqDigits: 3, separator: "-" }
const AD: CodeFormat = { prefix: "P", yearStyle: "ad", seqDigits: 3, separator: "-" }

const cases: Array<{
  label: string
  fmt: CodeFormat
  year: number
  /** 編號裡的年份段 */
  yearSeg: string
  samples: Array<[seq: number, code: string]>
}> = [
  {
    label: "roc（AT-民國年-流水號，亞斯特申請單）",
    fmt: ROC,
    year: 2026,
    yearSeg: "115",
    samples: [
      [1, "AT-115-001"],
      [13, "AT-115-013"],
      [42, "AT-115-042"],
      [999, "AT-115-999"],
      [1000, "AT-115-1000"],
    ],
  },
  {
    label: "ad（P-西元年-流水號）",
    fmt: AD,
    year: 2026,
    yearSeg: "2026",
    samples: [
      [1, "P-2026-001"],
      [42, "P-2026-042"],
      [999, "P-2026-999"],
      [1000, "P-2026-1000"],
    ],
  },
]

describe.each(cases)("formatCode / parseSeq — $label", ({ fmt, year, yearSeg, samples }) => {
  it.each(samples)("seq %i → %s", (seq, code) => {
    expect(formatCode(fmt, year, seq)).toBe(code)
  })

  it("超過三位不截斷，繼續長出去（繞回會撞號）", () => {
    expect(formatCode(fmt, year, 1000)).toBe(`${fmt.prefix}-${yearSeg}-1000`)
  })

  it.each(samples)("parseSeq(%i ← %s) 與 formatCode 互為反函式", (seq, code) => {
    expect(parseSeq(fmt, code, year)).toBe(seq)
  })

  it("年度不符回 null——流水號每年重置，別年的號不參與計算", () => {
    expect(parseSeq(fmt, formatCode(fmt, year - 1, 50), year)).toBeNull()
    expect(parseSeq(fmt, formatCode(fmt, year, 50), year - 1)).toBeNull()
  })

  it("人工編號回 null，不會把之後的自動編號推高", () => {
    expect(parseSeq(fmt, "ABC-999", year)).toBeNull()
    expect(parseSeq(fmt, `${yearSeg}-001`, year)).toBeNull()
    expect(parseSeq(fmt, "", year)).toBeNull()
  })

  it("只認完整比對，前後多字元都不算", () => {
    expect(parseSeq(fmt, `X${fmt.prefix}-${yearSeg}-001`, year)).toBeNull()
    expect(parseSeq(fmt, `${fmt.prefix}-${yearSeg}-001-A`, year)).toBeNull()
    expect(parseSeq(fmt, `${fmt.prefix}-${yearSeg}-00a`, year)).toBeNull()
  })

  it("LIKE 前綴對得上編號", () => {
    expect(codeLikePrefix(fmt, year)).toBe(`${fmt.prefix}-${yearSeg}-%`)
    expect(formatCode(fmt, year, 7).startsWith(codeLikePrefix(fmt, year).slice(0, -1))).toBe(true)
  })
})

describe("兩種格式互不相認", () => {
  it("roc 的編號在 ad 格式下不參與流水號，反之亦然", () => {
    expect(parseSeq(AD, "AT-115-001", 2026)).toBeNull()
    expect(parseSeq(ROC, "P-2026-001", 2026)).toBeNull()
    // 舊格式 P2026-001（無分隔）在新格式下也不算——正式庫 0 筆，不需相容。
    expect(parseSeq(ROC, "P2026-001", 2026)).toBeNull()
  })

  it("流水號位數可設定", () => {
    const four: CodeFormat = { ...ROC, seqDigits: 4 }
    expect(formatCode(four, 2026, 7)).toBe("AT-115-0007")
    expect(parseSeq(four, "AT-115-0007", 2026)).toBe(7)
    // 位數只是補零的下限：既有 3 位的號改成 4 位設定後仍解析得出來。
    expect(parseSeq(four, "AT-115-007", 2026)).toBe(7)
  })
})

describe("toCodeFormat（project_settings → CodeFormat）", () => {
  it("沒有設定列就是預設 AT / roc / 3", () => {
    expect(toCodeFormat(null)).toEqual(DEFAULT_CODE_FORMAT)
    expect(DEFAULT_CODE_FORMAT).toEqual({ prefix: "AT", yearStyle: "roc", seqDigits: 3, separator: "-" })
  })

  it("讀設定列", () => {
    expect(toCodeFormat({ code_prefix: "XY", code_year_style: "ad", code_seq_digits: 4 })).toEqual({
      prefix: "XY",
      yearStyle: "ad",
      seqDigits: 4,
      separator: "-",
    })
  })

  it("不合法的值退回預設，不讓一筆壞設定把產號弄壞", () => {
    expect(toCodeFormat({ code_prefix: "  ", code_year_style: "lunar", code_seq_digits: 0 })).toEqual(
      DEFAULT_CODE_FORMAT,
    )
    expect(toCodeFormat({ code_prefix: "AT", code_year_style: "roc", code_seq_digits: "3" })).toEqual(
      DEFAULT_CODE_FORMAT,
    )
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

/* ── C2 複製案的尾碼（`{根案 code}-{n}`）───────────────────────────── */

describe("parseDupSuffix（C2 複製案尾碼）", () => {
  it("同源：AT-115-013-7 相對根案 AT-115-013 → 7", () => {
    expect(parseDupSuffix("AT-115-013", "AT-115-013-7")).toBe(7)
    expect(parseDupSuffix("AT-115-013", "AT-115-013-1")).toBe(1)
    expect(parseDupSuffix("AT-115-013", "AT-115-013-12")).toBe(12)
    expect(parseDupSuffix("AT-115-013", formatDupCode("AT-115-013", 3))).toBe(3)
  })

  it("非同源回 null：別的根案、根案本身、黏在一起的數字", () => {
    expect(parseDupSuffix("AT-115-013", "AT-115-014-1")).toBeNull()
    expect(parseDupSuffix("AT-115-013", "AT-115-013")).toBeNull()
    expect(parseDupSuffix("AT-115-013", "AT-115-0131")).toBeNull()
    expect(parseDupSuffix("AT-115-013", "AT-115-01-31")).toBeNull()
    expect(parseDupSuffix("AT-115-013", "")).toBeNull()
    expect(parseDupSuffix("", "AT-115-013-1")).toBeNull()
  })

  it("只認完整的 `{root}-{n}`：疊羅漢與非數字尾碼不算", () => {
    expect(parseDupSuffix("AT-115-013", "AT-115-013-1-1")).toBeNull()
    expect(parseDupSuffix("AT-115-013", "AT-115-013-a")).toBeNull()
    expect(parseDupSuffix("AT-115-013", "XAT-115-013-1")).toBeNull()
  })

  it("根案 code 裡的 regex 特殊字元要跳脫（人工編號可能含 . 或 +）", () => {
    expect(parseDupSuffix("P.1+2", "P.1+2-4")).toBe(4)
    expect(parseDupSuffix("P.1+2", "Px1+2-4")).toBeNull()
  })

  it("複製案的尾碼不參與年度流水號：parseSeq 對 AT-115-013-1 回 null", () => {
    expect(parseSeq(ROC, "AT-115-013-1", 2026)).toBeNull()
    expect(parseSeq(ROC, "AT-115-013-12", 2026)).toBeNull()
    // 反過來，年度流水號也不是任何根案的尾碼。
    expect(parseDupSuffix("AT-115", "AT-115-013")).toBe(13) // 這是同一格式的必然結果——
    // 所以根案永遠取「根 main 案的 code」（AT-115-013），不是前綴＋年度（AT-115）。
  })
})

describe("duplicateName／archiveReasonFor（C2 複製案的名稱與封存理由）", () => {
  it("加後綴「（追加減 n）」或「（加做 n）」", () => {
    expect(duplicateName("惠特總部機電設計", "change", 1)).toBe("惠特總部機電設計（追加減 1）")
    expect(duplicateName("惠特總部機電設計", "addition", 2)).toBe("惠特總部機電設計（加做 2）")
  })

  it("從複製案再複製：先剝掉舊後綴，不會疊成兩個括號", () => {
    expect(duplicateName("惠特總部機電設計（追加減 1）", "change", 2)).toBe("惠特總部機電設計（追加減 2）")
    expect(duplicateName("惠特總部機電設計（加做 1）", "change", 2)).toBe("惠特總部機電設計（追加減 2）")
    // 名稱中間出現的括號不動，只剝結尾那個。
    expect(duplicateName("A（追加減 1）B", "addition", 3)).toBe("A（追加減 1）B（加做 3）")
  })

  it("封存理由帶新編號與原因", () => {
    expect(archiveReasonFor("AT-115-013-1", "合約由 1000 萬變更為 2000 萬")).toBe(
      "已由 AT-115-013-1 取代：合約由 1000 萬變更為 2000 萬",
    )
  })
})
