import { describe, expect, it } from "vitest"
import type { AnnualRow } from "../services/project-application-store"
import { annualDisciplines, assembleAnnualTable } from "../services/project-application-store"
import { maskRegisterRow, maskRegisterRows } from "../services/project-register"

function row(projectId: string, over: Partial<AnnualRow> = {}): AnnualRow {
  return {
    seq: 0,
    projectId,
    code: `XX-100-${projectId}`,
    dateRoc: "100.2.3",
    createdOn: "2011-02-03",
    clientName: "假客戶",
    name: "假工程",
    kind: "main",
    reserved: false,
    amountUntaxed: 100_000,
    amountSource: "contract",
    taxAmount: 5_000,
    amountTotal: 105_000,
    receivedTotal: 40_000,
    unreceived: 60_000,
    invoicedTotal: 50_000,
    invoiceStatus: "部分開票",
    contractStatus: "已簽約",
    engineerSignature: "空調：甲技師",
    subcontractTotal: 30_000,
    technicianTotal: 1_000,
    leadName: "假業務",
    note: "累計請款 50%；應付假技師 1,000",
    subcontractByDiscipline: { 空調: 30_000 },
    billedTotal: 50_000,
    billingProgressPct: 50,
    receiptProgressPct: 40,
    unreceivedPct: 60,
    status: "active",
    archived: false,
    installments: "1/2",
    installmentsBilled: 1,
    installmentsTotal: 2,
    ...over,
  }
}

describe("專案列表總表欄位遮罩", () => {
  it("看得到金額：金額、發包、科別、備註原樣帶出", () => {
    const r = maskRegisterRow(row("1"), true)
    expect(r).toMatchObject({
      moneyVisible: true,
      amountUntaxed: 100_000,
      taxAmount: 5_000,
      amountTotal: 105_000,
      receivedTotal: 40_000,
      unreceived: 60_000,
      invoicedTotal: 50_000,
      subcontractTotal: 30_000,
      subcontractByDiscipline: { 空調: 30_000 },
      note: "累計請款 50%；應付假技師 1,000",
      leadName: "假業務",
      contractStatus: "已簽約",
    })
  })

  it("看不到金額：所有金額欄 null、科別空、備註清空，但基本資料保留", () => {
    const r = maskRegisterRow(row("1"), false)
    expect(r.moneyVisible).toBe(false)
    for (const k of ["amountUntaxed", "taxAmount", "amountTotal", "receivedTotal", "unreceived", "invoicedTotal", "subcontractTotal"] as const) {
      expect(r[k]).toBeNull()
    }
    expect(r.subcontractByDiscipline).toEqual({})
    expect(r.note).toBe("")
    expect(r).toMatchObject({ dateRoc: "100.2.3", leadName: "假業務", engineerSignature: "空調：甲技師", contractStatus: "已簽約" })
    // 不得夾帶任何年度總表的其他金額欄（期數、進度、技師應付等）。
    const json = JSON.stringify(r)
    for (const leak of ["100000", "105000", "60000", "50000", "1000", "billingProgressPct", "technicianTotal", "bonus"]) {
      expect(json).not.toContain(leak)
    }
  })

  it("整份遮罩：null＝全部看得到；集合＝只有集合內的案帶金額", () => {
    const rows = [row("a"), row("b")]
    expect(maskRegisterRows(rows, null).map((r) => r.moneyVisible)).toEqual([true, true])
    const partial = maskRegisterRows(rows, new Set(["b"]))
    expect(partial.map((r) => [r.projectId, r.moneyVisible, r.amountUntaxed])).toEqual([
      ["a", false, null],
      ["b", true, 100_000],
    ])
  })

  it("科別欄由遮罩後的列推：被遮的案不會冒出額外科別", () => {
    const rows = [row("a", { subcontractByDiscipline: { 機密科別: 1 } }), row("b")]
    const masked = maskRegisterRows(rows, new Set(["b"]))
    expect(annualDisciplines(["空調", "消防"], masked)).toEqual(["空調", "消防"])
    expect(annualDisciplines(["空調"], maskRegisterRows(rows, null))).toEqual(["空調", "機密科別"])
  })

  it("assembleAnnualTable 抽出後行為不變：依單號排序、編項次、月份小計", () => {
    const t = assembleAnnualTable(2011, [row("10", { code: "XX-100-10" }), row("2", { code: "XX-100-2" })], "code", { disciplines: ["空調"] })
    expect(t.rows.map((r) => [r.seq, r.code])).toEqual([[1, "XX-100-2"], [2, "XX-100-10"]])
    expect(t.blocks).toHaveLength(1)
    expect(t.totals.amountUntaxed).toBe(200_000)
    expect(t.rocYear).toBe(100)
  })
})
