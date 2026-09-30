import { describe, expect, it } from "vitest"
import { catalogCode } from "./catalog-code.js"

describe("catalogCode", () => {
  it("creates a stable internal key without requiring an English key from the administrator", () => {
    expect(catalogCode("夜間計程車")).toBe(catalogCode("夜間計程車"))
    expect(catalogCode("夜間計程車")).toMatch(/^option_[a-f0-9]{12}$/)
  })

  it("normalizes equivalent labels before generating the key", () => {
    expect(catalogCode(" 夜間計程車 ")).toBe(catalogCode("夜間計程車"))
  })
})
