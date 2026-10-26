import { describe, expect, it } from "vitest"
import { isLeavingLinkClick, unsavedChangesMessage } from "../unsaved-changes"

const here = "https://hr.example.com/admin/projects/p1"
const click = (href: string, over: Partial<Parameters<typeof isLeavingLinkClick>[0]> = {}) =>
  isLeavingLinkClick({ href, button: 0, modifier: false, currentHref: here, ...over })

describe("isLeavingLinkClick", () => {
  it("站內其他頁面 → 離開", () => {
    expect(click("https://hr.example.com/admin/projects")).toBe(true)
    expect(click("https://hr.example.com/admin/projects/p1/application")).toBe(true)
    expect(click("https://hr.example.com/admin/projects/p1?tab=x")).toBe(true)
  })
  it("只換 #錨點 → 不算離開", () => {
    expect(click("https://hr.example.com/admin/projects/p1#project-contracts")).toBe(false)
  })
  it("開新分頁（中鍵、修飾鍵、target=_blank）、下載 → 不攔", () => {
    expect(click("https://hr.example.com/admin", { button: 1 })).toBe(false)
    expect(click("https://hr.example.com/admin", { modifier: true })).toBe(false)
    expect(click("https://hr.example.com/admin", { target: "_blank" })).toBe(false)
    expect(click("https://hr.example.com/file.pdf", { download: true })).toBe(false)
  })
  it("站外網址 → 離開；mailto 不攔", () => {
    expect(click("https://other.example.org/")).toBe(true)
    expect(click("mailto:a@example.com")).toBe(false)
  })
  it("提示文字含欄位數", () => {
    expect(unsavedChangesMessage(3)).toContain("3 個欄位尚未儲存")
  })
})
