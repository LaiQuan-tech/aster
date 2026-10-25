import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { BEYOND_CAP_VOID_NOTE, isVoidedBeyondCapDraft } from "../services/overtime-void.js"
import { BEYOND_CAP_VOID_NOTE as FROM_SHEETS } from "../services/attendance-sheets.js"

/** 加班超額另計「作廢草稿」判斷（services/overtime-void.ts）＋前端鏡像（apps/web/src/lib/overtime-void.ts）常數對照。 */

const voided = { status: "draft", source: "beyond_cap", minutes: 0, amount: 0, note: BEYOND_CAP_VOID_NOTE }

describe("isVoidedBeyondCapDraft", () => {
  it("四個條件都成立才算作廢：draft＋beyond_cap＋0 分鐘＋金額 0／null＋作廢註記", () => {
    expect(isVoidedBeyondCapDraft(voided)).toBe(true)
    expect(isVoidedBeyondCapDraft({ ...voided, amount: null })).toBe(true)
    expect(isVoidedBeyondCapDraft({ ...voided, amount: "0", minutes: "0" })).toBe(true)
    expect(isVoidedBeyondCapDraft({ ...voided, note: `前綴 ${BEYOND_CAP_VOID_NOTE}` })).toBe(true)
  })

  it("手動補登 0 分鐘固定金額、有金額、有分鐘、沒註記、已付款 → 不是作廢", () => {
    expect(isVoidedBeyondCapDraft({ ...voided, source: "manual" })).toBe(false)
    expect(isVoidedBeyondCapDraft({ ...voided, amount: 500 })).toBe(false)
    expect(isVoidedBeyondCapDraft({ ...voided, minutes: 30 })).toBe(false)
    expect(isVoidedBeyondCapDraft({ ...voided, minutes: null })).toBe(false)
    expect(isVoidedBeyondCapDraft({ ...voided, note: null })).toBe(false)
    expect(isVoidedBeyondCapDraft({ ...voided, status: "paid" })).toBe(false)
  })

  it("attendance-sheets 的舊匯入點與前端鏡像用同一個註記字串", () => {
    expect(FROM_SHEETS).toBe(BEYOND_CAP_VOID_NOTE)
    const web = readFileSync(fileURLToPath(new URL("../../../web/src/lib/overtime-void.ts", import.meta.url)), "utf8")
    expect(web).toContain(`export const BEYOND_CAP_VOID_NOTE = "${BEYOND_CAP_VOID_NOTE}"`)
  })
})
