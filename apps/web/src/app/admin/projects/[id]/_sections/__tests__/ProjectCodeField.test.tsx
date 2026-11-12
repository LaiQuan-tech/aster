/** 專案序號編輯欄（2026-11-12）：前端輸入檢查與錯誤訊息。假資料。 */
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ProjectCodeField, projectCodeInputError } from "../ProjectCodeField"
import { humanizeProjectCodeError, PROJECT_CODE_MAX } from "@/lib/projects-ext-api"

describe("projectCodeInputError", () => {
  it("空白擋下", () => {
    expect(projectCodeInputError("")).toBe("序號不可空白")
    expect(projectCodeInputError("   ")).toBe("序號不可空白")
  })
  it("超過上限擋下、剛好上限可以（去頭尾空白後計）", () => {
    expect(projectCodeInputError("A".repeat(PROJECT_CODE_MAX + 1))).toContain("最多")
    expect(projectCodeInputError(` ${"A".repeat(PROJECT_CODE_MAX)} `)).toBeNull()
  })
  it("一般序號可以", () => expect(projectCodeInputError("AT-115-118")).toBeNull())
})

describe("humanizeProjectCodeError", () => {
  it("重複 → 此序號已被其他專案使用", () => {
    expect(humanizeProjectCodeError(new Error("[409] project_no_taken"))).toBe("此序號已被其他專案使用")
  })
  it("權限／空白", () => {
    expect(humanizeProjectCodeError(new Error("[403] forbidden"))).toContain("權限")
    expect(humanizeProjectCodeError(new Error("[400] project_no_required"))).toBe("序號不可空白")
  })
})

describe("ProjectCodeField 靜態渲染", () => {
  it("canEdit：有鉛筆鈕", () => {
    const html = renderToStaticMarkup(<ProjectCodeField projectId="p1" code="T-115-001" canEdit />)
    expect(html).toContain('aria-label="編輯專案序號"')
  })
  it("不能編輯：沒有鉛筆鈕；沒有序號顯示 —", () => {
    const html = renderToStaticMarkup(<ProjectCodeField projectId="p1" code={null} canEdit={false} />)
    expect(html).not.toContain("編輯專案序號")
    expect(html).toContain("—")
  })
})
