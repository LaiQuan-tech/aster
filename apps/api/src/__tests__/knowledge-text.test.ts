import { describe, it, expect } from "vitest"
import { chunkText, kindOf } from "../services/knowledge-text"

describe("chunkText", () => {
  it("空白 → []", () => {
    expect(chunkText("   \n\n ")).toEqual([])
  })
  it("短文一塊", () => {
    expect(chunkText("公司福利：勞保、健保、勞退。")).toEqual(["公司福利：勞保、健保、勞退。"])
  })
  it("短段落會合併到接近上限，不會一段一塊", () => {
    const text = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 條：內容。`).join("\n\n")
    const chunks = chunkText(text, { maxChars: 200, overlap: 0 })
    expect(chunks.length).toBeLessThan(10)
    expect(chunks.join("\n")).toContain("第 10 條")
  })
  it("超長段落照句號切，每塊不超過上限", () => {
    const text = Array.from({ length: 50 }, (_, i) => `這是第 ${i + 1} 句，用來測試切塊。`).join("")
    const chunks = chunkText(text, { maxChars: 120, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120)
    expect(chunks[0].endsWith("。")).toBe(true)
  })
  it("沒有標點的超長字串會硬切", () => {
    const text = "甲".repeat(1000)
    const chunks = chunkText(text, { maxChars: 300, overlap: 0 })
    expect(chunks.map((c) => c.length)).toEqual([300, 300, 300, 100])
  })
  it("overlap：後一塊開頭帶前一塊的尾巴", () => {
    const text = `${"A".repeat(500)}\n\n${"B".repeat(500)}`
    const [a, b] = chunkText(text, { maxChars: 500, overlap: 50 })
    expect(a).toBe("A".repeat(500))
    expect(b.startsWith("A".repeat(50))).toBe(true)
    expect(b.endsWith("B".repeat(500))).toBe(true)
  })
  it("★ 內容不會遺失：去掉 overlap 後所有原文都在", () => {
    const text = Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}：${"字".repeat(80)}。`).join("\n\n")
    const chunks = chunkText(text, { maxChars: 400, overlap: 40 })
    const joined = chunks.join("")
    for (let i = 1; i <= 30; i++) expect(joined).toContain(`段落 ${i}：`)
  })
})

describe("kindOf", () => {
  it("依 contentType，缺時看副檔名", () => {
    expect(kindOf("application/pdf", "x.bin")).toBe("pdf")
    expect(kindOf("application/octet-stream", "sop.docx")).toBe("docx")
    expect(kindOf("text/markdown; charset=utf-8", "a.md")).toBe("text")
    expect(kindOf("image/png", "card.png")).toBeNull()
  })
})
