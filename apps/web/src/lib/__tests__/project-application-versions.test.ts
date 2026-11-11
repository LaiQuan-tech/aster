/**
 * 申請單版本（2026-11-10）的純函式：版本下拉文字、舊版橫幅、快照→申請單 props。假資料。
 */
import { describe, expect, it } from "vitest"
import {
  currentVersionNo,
  oldVersionBanner,
  snapshotSheetProps,
  versionDate,
  versionOptions,
  versionReason,
} from "../project-application-versions"
import type { ApplicationData, ApplicationVersionMeta } from "../projects-ext-api"

const meta = (over: Partial<ApplicationVersionMeta>): ApplicationVersionMeta => ({
  id: "v", versionNo: 1, trigger: "initial", amountBefore: null, amountAfter: 1428571, note: null,
  createdByEmpId: null, createdByName: null, createdAt: "2026-03-01T03:00:00.000Z", supersededAt: null, ...over,
})

describe("版本下拉", () => {
  it("最新＝（目前）；舊版帶日期與原因（合約金額 原→新、初版、手動另存＋備註）", () => {
    const opts = versionOptions([
      meta({ versionNo: 1, trigger: "initial", amountAfter: 1428571, createdAt: "2026-02-01T03:00:00.000Z" }),
      meta({ versionNo: 3, trigger: "manual", note: "送業主前", amountAfter: 1600000 }),
      meta({ versionNo: 2, trigger: "contract_amount_changed", amountBefore: 1428571, amountAfter: 1600000 }),
    ])
    expect(opts.map((o) => o.label)).toEqual([
      "第 3 版（目前）",
      "第 2 版 2026-03-01 合約金額 1,428,571→1,600,000",
      "第 1 版 2026-02-01 初版（合約金額 1,428,571）",
    ])
    expect(opts.map((o) => o.current)).toEqual([true, false, false])
  })

  it("還沒有任何版本：只有「第 1 版（目前）」；currentVersionNo＝1", () => {
    expect(versionOptions([])).toEqual([{ value: 0, label: "第 1 版（目前）", current: true }])
    expect(currentVersionNo([])).toBe(1)
    expect(currentVersionNo([meta({ versionNo: 2 }), meta({ versionNo: 5 })])).toBe(5)
  })

  it("手動另存沒備註；日期以台北時區（UTC 16:30 已是隔天）", () => {
    expect(versionReason(meta({ trigger: "manual", note: null }))).toBe("手動另存")
    expect(versionDate("2026-02-28T16:30:00.000Z")).toBe("2026-03-01")
  })

  it("舊版橫幅", () => {
    expect(oldVersionBanner(meta({ versionNo: 2 }))).toBe("正在檢視第 2 版（2026-03-01 建立），非目前內容")
  })
})

describe("快照 → 申請單 props", () => {
  it("project 補回 client／openedOn；科別、客戶清單、訂單文件都帶上", () => {
    const snap = {
      code: "T-1", createdOn: "2026-01-01", dateRoc: "115.1.1", openedOn: "2026-01-02",
      project: { id: "p1", name: "測試工程", openedOn: null }, client: { id: "c1", name: "測試客戶" },
      latestDocument: { id: "k1", docType: "contract", title: "主合約", amount: 1, signedOn: "2026-01-05" },
      designScope: [], engineers: {}, billings: [{ id: "b1" }], subcontracts: [{ id: "s1" }],
      money: { amountUntaxed: 1600000 }, settings: { vatRate: 0.05, disciplines: ["電機"] },
    } as unknown as ApplicationData
    const p = snapshotSheetProps(snap)
    expect(p.project.client?.name).toBe("測試客戶")
    expect(p.project.openedOn).toBe("2026-01-02")
    expect(p.clients).toHaveLength(1)
    expect(p.billings).toHaveLength(1)
    expect(p.subcontracts).toHaveLength(1)
    expect(p.latestDocument?.docType).toBe("contract")
    expect(p.money?.amountUntaxed).toBe(1600000)
    expect(p.disciplines).toContain("電機")
  })
})
