import { describe, expect, it } from "vitest"
import { SEARCH_TERM_MAX_LEN, sanitizeSearchTerm } from "../lib/search-term.js"

/**
 * lib/search-term.ts：關鍵字 q 塞進 PostgREST `.or("col.ilike.%q%,…")` 之前的共用清洗（純函式）。
 * 端點層的行為另見 vendors-search／disbursements-search／clients-short-name 三個測試檔。
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe("sanitizeSearchTerm — 剝除 % _ , ( )", () => {
  it.each(["%", "_", ",", "(", ")"])("剝除 %s", (ch) => {
    expect(sanitizeSearchTerm(`${ch}測試${ch}廠商${ch}${ch}甲${ch}`)).toBe("測試廠商甲")
  })

  it("or() 注入樣態（多塞條件、提早關括號）剝完只剩字面字元", () => {
    expect(sanitizeSearchTerm("甲,name.not.is.null")).toBe("甲name.not.is.null")
    expect(sanitizeSearchTerm("甲),and(id.gt.0")).toBe("甲andid.gt.0")
  })

  it.each([
    [".", "02.1234"],
    [":", "a:b"],
    ['"', 'a"b'],
    ["*", "a*b"],
    ["\\", "a\\b"],
    ["-", "02-1234-5678"],
    ["中文", "測試廠商甲"],
    ["全形括號（）", "測試廠商（台北）"],
  ])("保留 %s", (_label, q) => {
    expect(sanitizeSearchTerm(q)).toBe(q)
  })
})

describe("sanitizeSearchTerm — 截到 100 字", () => {
  it("上限常數是 100", () => {
    expect(SEARCH_TERM_MAX_LEN).toBe(100)
  })

  it("剛好 100 字不動、101 字截成 100 字", () => {
    expect(sanitizeSearchTerm("乙".repeat(100))).toBe("乙".repeat(100))
    expect(sanitizeSearchTerm("乙".repeat(101))).toBe("乙".repeat(100))
  })

  it.each([
    ["8000 個英文字", "a".repeat(8000), "a"],
    ["1000 個中文字", "字".repeat(1000), "字"],
  ])("%s → 前 100 字", (_label, q, ch) => {
    expect(sanitizeSearchTerm(q)).toBe(ch.repeat(100))
  })

  it("先剝除再截長：被剝掉的字元不佔名額", () => {
    expect(sanitizeSearchTerm(`%_,()${"丙".repeat(100)}%_,()`)).toBe("丙".repeat(100))
    expect(sanitizeSearchTerm(`${"丙".repeat(60)}${"%_,()".repeat(30)}${"丁".repeat(60)}`)).toBe(`${"丙".repeat(60)}${"丁".repeat(40)}`)
  })

  it("以字元（code point）截斷，emoji 不會被切成半個 surrogate", () => {
    const out = sanitizeSearchTerm("😀".repeat(150))
    expect(out).toBe("😀".repeat(100))
    expect(out).toHaveLength(200) // 100 個 emoji＝200 個 UTF-16 code unit

    // 前面墊 1 字：若以 code unit 截 100，第 100 個 code unit 剛好落在某個 emoji 的前半
    const shifted = sanitizeSearchTerm(`a${"😀".repeat(150)}`)
    expect(shifted).toBe(`a${"😀".repeat(99)}`)
    expect(LONE_SURROGATE.test(shifted)).toBe(false)
  })

  it("空字串、只有被剝字元 → 空字串", () => {
    expect(sanitizeSearchTerm("")).toBe("")
    expect(sanitizeSearchTerm("%_,()")).toBe("")
  })
})
