import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"

/**
 * 員工資料「區塊 → 欄位」對照（services/profile-fields.ts）的純測試，不碰任何 DB：
 * lib/supabase.js 整個換掉，萬一有人在這裡誤打 DB 會直接丟錯。
 *
 * 重點是 2026-10-07 新增的 bank（匯款帳號）區塊——它要同時對齊三處：
 *   1. 這份 SECTION_COLUMNS（員工自改審核的白名單）
 *   2. routes/employee-profile.ts 的 PROFILE_FIELD_TO_COL（PUT 實際會寫的欄位）
 *   3. 後台設定頁 module-settings 的 FIELD_OPTIONS（HR 勾選哪些區塊員工可自改）
 * 少對齊任何一處，就是「某欄永遠不能自改」或「設定頁勾了沒作用」這類靜默壞掉。
 */
vi.mock("../lib/supabase.js", () => ({
  supabaseAdmin: {
    from: () => {
      throw new Error("pure test: 不該打 DB")
    },
  },
  getUserFromToken: async () => null,
}))

import { PROFILE_FIELD_TO_COL } from "../routes/employee-profile.js"
import {
  COLUMN_LABEL,
  PROFILE_SECTIONS,
  SECTION_COLUMNS,
  SECTION_LABEL,
  bankSelfEditable,
  columnLabel,
  diffProfile,
  editableColumns,
  sectionOfColumn,
} from "../services/profile-fields.js"

const BANK_COLUMNS = ["bank_code", "bank_name", "bank_account", "account_holder"]
const allSectionColumns = () => PROFILE_SECTIONS.flatMap((section) => [...SECTION_COLUMNS[section]])

describe("bank（匯款帳號）區塊", () => {
  it("是獨立區塊，正好四個匯款欄，有中文區塊名", () => {
    expect(PROFILE_SECTIONS).toContain("bank")
    expect([...SECTION_COLUMNS.bank]).toEqual(BANK_COLUMNS)
    expect(SECTION_LABEL.bank).toBe("匯款帳號")
  })

  it("沒設過 editableFields（undefined）＝全部可改，含匯款欄（維持既有語意）", () => {
    const all = editableColumns(undefined)
    for (const col of BANK_COLUMNS) expect(all.has(col)).toBe(true)
  })

  it("只開放 basic／contact 的租戶：匯款欄不在白名單（員工不能自改，須 HR 維護）", () => {
    const allowed = editableColumns(["basic", "contact"])
    for (const col of BANK_COLUMNS) expect(allowed.has(col)).toBe(false)
    expect(allowed.has("phone")).toBe(true)
  })

  it("勾選 bank 才開放匯款欄，且不會連帶開放別的區塊", () => {
    const allowed = editableColumns(["bank"])
    expect([...allowed].sort()).toEqual([...BANK_COLUMNS].sort())
  })

  // 審核「關閉」時 PUT 的唯一一道閘：匯款帳號預設由 HR 維護，所以與 editableColumns 的
  // 「沒設過＝全部可改」不同——必須「明確」勾了 bank 才算員工可自改。
  describe("bankSelfEditable（審核關閉時員工能不能自改匯款帳號）", () => {
    it.each([
      ["沒設過（undefined）", undefined],
      ["null", null],
      ["空陣列", []],
      ["只勾 basic／contact", ["basic", "contact"]],
      ["勾了別的但沒有 bank", ["contact", "education", "certification", "workHistory"]],
      ["區塊 key 必須精確（不是欄名）", ["bank_account"]],
      ["區塊 key 大小寫要一致", ["BANK"]],
    ])("%s → 不可自改", (_label, sections) => {
      expect(bankSelfEditable(sections)).toBe(false)
    })

    it.each([
      ["只勾 bank", ["bank"]],
      ["與其他區塊一起勾", ["basic", "contact", "bank"]],
      ["前後空白會 trim（與 editableColumns 同一套正規化）", [" bank "]],
    ])("%s → 可自改", (_label, sections) => {
      expect(bankSelfEditable(sections)).toBe(true)
    })

    it("明確清單時與 editableColumns 一致；差別只在 undefined（其他區塊全開、匯款仍歸 HR）", () => {
      for (const sections of [[], ["basic"], ["contact", "bank"], ["bank"], ["basic", "contact", "education"]]) {
        const columns = editableColumns(sections)
        expect(bankSelfEditable(sections), JSON.stringify(sections)).toBe(BANK_COLUMNS.every((col) => columns.has(col)))
      }
      expect(editableColumns(undefined).has("bank_account")).toBe(true)
      expect(bankSelfEditable(undefined)).toBe(false)
    })
  })

  it("欄位 → 區塊反查、中文標籤（審核單與通知不會顯示英文欄名）", () => {
    for (const col of BANK_COLUMNS) expect(sectionOfColumn(col)).toBe("bank")
    expect(columnLabel("bank_code")).toBe("銀行代碼")
    expect(columnLabel("bank_name")).toBe("銀行名稱")
    expect(columnLabel("bank_account")).toBe("匯款帳號")
    expect(columnLabel("account_holder")).toBe("戶名")
  })

  it("diffProfile：空字串與 null 視為沒變；換帳號才算變", () => {
    expect(diffProfile({ bank_account: null }, { bank_account: "" })).toEqual({})
    expect(diffProfile({ bank_account: "0000000000" }, { bank_account: "0000000000" })).toEqual({})
    expect(diffProfile({ bank_account: "0000000000" }, { bank_account: "1111111111", bank_code: undefined })).toEqual({
      bank_account: { from: "0000000000", to: "1111111111" },
    })
  })
})

describe("三處對齊", () => {
  it("PUT 會寫的每個欄位（PROFILE_FIELD_TO_COL）都屬於某個區塊，反之亦然", () => {
    const written = Object.values(PROFILE_FIELD_TO_COL).sort()
    const sectioned = allSectionColumns().sort()
    expect(sectioned).toEqual(written)
  })

  it("每個欄位、每個區塊都有中文標籤", () => {
    for (const col of allSectionColumns()) expect(COLUMN_LABEL[col], `COLUMN_LABEL 缺 ${col}`).toBeTruthy()
    for (const section of PROFILE_SECTIONS) expect(SECTION_LABEL[section], `SECTION_LABEL 缺 ${section}`).toBeTruthy()
  })

  const settingsPage = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../web/src/app/admin/module-settings/page.tsx",
  )
  it.skipIf(!existsSync(settingsPage))("後台設定頁 FIELD_OPTIONS 的區塊 key 與 PROFILE_SECTIONS 完全一致（含順序）", () => {
    const source = readFileSync(settingsPage, "utf8")
    const block = /const FIELD_OPTIONS = \[([\s\S]*?)\];/.exec(source)?.[1] ?? ""
    const keys = [...block.matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1])
    expect(keys).toEqual([...PROFILE_SECTIONS])
  })
})
