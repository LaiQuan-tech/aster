import { describe, expect, it } from "vitest"

/**
 * 防匯錯人名稱比對（2026-11-17 r13）：鄉鎮簡稱＋市／鎮／鄉／區（中壢市、板橋市…改制前寫法）與舊縣名（台北縣、桃園縣…）
 * 也算地名，可從名冊名稱／收款名稱剝除。⚠️ 全是假資料（repo 公開）；公司名只當比對字串範例。
 */
import { buildRosterKeyIndex, compareRosterKeySets, rosterKeyMatches, rosterVendorKeys } from "../lib/payee-name.js"

type Rel = "exact" | "similar" | "none"
/** 放款「其他」收款／副委託共用的 rosterKeyMatches。 */
function relation(roster: string, name: string): Rel {
  const m = rosterKeyMatches(buildRosterKeyIndex([{ id: "v", name: roster, short_name: null }]), name)
  return m.exact.length > 0 ? "exact" : m.similar.length > 0 ? "similar" : "none"
}
/** 名冊新增 name（compareRosterKeySets）。 */
function rosterRelation(existing: string, name: string): Rel {
  return compareRosterKeySets(rosterVendorKeys({ name }), rosterVendorKeys({ name: existing })) ?? "none"
}
function expectAll(roster: string, name: string, want: Rel) {
  expect(relation(roster, name), `其他收款／副委託 ${roster} ← ${name}`).toBe(want)
  expect(rosterRelation(roster, name), `名冊 ${roster} ← ${name}`).toBe(want)
}

describe("鄉鎮簡稱＋市／鎮／鄉、舊縣名", () => {
  it("4 組名冊×收款與反向：三入口皆相近", () => {
    const cases: Array<[string, string]> = [
      ["中壢市宏碁有限公司", "宏碁"], ["板橋市宏碁有限公司", "宏碁"], ["台北縣板橋市3M有限公司", "3M"], ["中壢市王明水電行", "王明"],
    ]
    for (const [roster, name] of cases) {
      expectAll(roster, name, "similar")
      expectAll(name, roster, "similar")
    }
    expectAll("宏碁", "中壢市宏碁", "similar")
  })
  it("改制前縣轄市 × 宏碁／3M／王明 皆相近", () => {
    const towns = ["中壢市", "板橋市", "豐原市", "三重市", "新莊市", "鳳山市", "永和市", "中和市", "新店市", "土城市", "平鎮市", "八德市", "大里市", "太平市"]
    const cores: Array<[string, string]> = [["宏碁", "有限公司"], ["3M", "有限公司"], ["王明", "水電行"]]
    for (const t of towns) for (const [core, tail] of cores) {
      expectAll(`${t}${core}${tail}`, core, "similar")
      expectAll(core, `${t}${core}`, "similar")
    }
  })
  it("舊縣名＋縣轄市", () => {
    for (const county of ["台北縣", "臺北縣", "桃園縣", "台中縣", "臺中縣", "台南縣", "臺南縣", "高雄縣", "新竹縣"]) {
      expectAll(`${county}宏碁有限公司`, "宏碁", "similar")
    }
    expectAll("桃園縣中壢市宏碁有限公司", "宏碁", "similar")
    expectAll("高雄縣鳳山市王明水電行", "王明", "similar")
  })
  it("現行縣轄市（竹北市、員林市）仍正常", () => {
    for (const t of ["竹北市", "員林市"]) for (const core of ["宏碁", "王明"]) {
      expectAll(`${t}${core}有限公司`, core, "similar")
      expectAll(core, `${t}${core}`, "similar")
    }
  })
})

describe("誤報評估（假資料）：名冊 20 家常見公司 × 收款 60 個機關／銀行／超商／電信／保險／個人", () => {
  const ROSTER = [
    "台灣積體電路製造股份有限公司", "鴻海精密工業股份有限公司", "宏碁股份有限公司", "華碩電腦股份有限公司", "統一企業股份有限公司",
    "台灣塑膠工業股份有限公司", "中國鋼鐵股份有限公司", "長榮海運股份有限公司", "大同股份有限公司", "聯華電子股份有限公司",
    "台達電子工業股份有限公司", "廣達電腦股份有限公司", "遠東新世紀股份有限公司", "王品餐飲股份有限公司", "信義房屋股份有限公司",
    "新光三越百貨股份有限公司", "永豐餘投資控股股份有限公司", "裕隆汽車製造股份有限公司", "和泰汽車股份有限公司", "研華股份有限公司",
  ]
  const PAYEES = [
    // 機關／公用事業
    "台北市政府", "新北市政府", "財政部台北國稅局", "勞動部勞工保險局", "衛生福利部中央健康保險署", "內政部", "經濟部",
    "台中市政府地方稅務局", "高雄市政府", "交通部公路局台北區監理所", "台灣自來水股份有限公司", "台灣電力股份有限公司",
    "欣欣天然氣股份有限公司", "中華郵政股份有限公司", "法務部行政執行署",
    // 銀行
    "台灣銀行", "第一商業銀行", "合作金庫商業銀行", "華南商業銀行", "彰化商業銀行", "國泰世華商業銀行", "中國信託商業銀行",
    "玉山商業銀行", "台北富邦商業銀行", "兆豐國際商業銀行", "台灣土地銀行", "永豐商業銀行",
    // 超商
    "統一超商股份有限公司", "全家便利商店股份有限公司", "萊爾富國際股份有限公司", "來來超商股份有限公司",
    // 電信
    "中華電信股份有限公司", "台灣大哥大股份有限公司", "遠傳電信股份有限公司", "亞太電信股份有限公司", "台灣之星電信股份有限公司",
    // 保險
    "國泰人壽保險股份有限公司", "富邦產物保險股份有限公司", "新光人壽保險股份有限公司", "南山人壽保險股份有限公司", "台灣人壽保險股份有限公司",
    "三商美邦人壽保險股份有限公司", "全球人壽保險股份有限公司",
    // 個人（虛構）
    "王小明", "陳大文", "林美玲", "張志豪", "李淑芬", "黃建國", "劉家豪", "蔡佩君", "楊雅婷", "許文雄", "鄭志明", "謝宜蓁",
    "洪秀英", "郭俊傑", "周美華", "曾國峰", "吳宗翰",
  ]
  it("硬擋 0、相近 0（其他收款與名冊入口各自計算）", () => {
    expect(ROSTER).toHaveLength(20)
    expect(PAYEES).toHaveLength(60)
    const index = buildRosterKeyIndex(ROSTER.map((name, i) => ({ id: `v${i}`, name })))
    let exact = 0
    let similarPairs = 0
    let rosterExact = 0
    let rosterSimilar = 0
    const hits: string[] = []
    for (const p of PAYEES) {
      const m = rosterKeyMatches(index, p)
      exact += m.exact.length
      similarPairs += m.similar.length
      for (const v of m.similar) hits.push(`${v.name} ← ${p}`)
      for (const r of ROSTER) {
        const k = rosterRelation(r, p)
        if (k === "exact") rosterExact++
        if (k === "similar") rosterSimilar++
      }
    }
    const total = ROSTER.length * PAYEES.length
    expect(exact).toBe(0)
    expect(rosterExact).toBe(0)
    expect(similarPairs, hits.join("；")).toBe(0)
    expect(rosterSimilar).toBe(0)
    console.info(`誤報評估：其他收款 exact ${exact}／similar ${similarPairs}／${total}；名冊入口 exact ${rosterExact}／similar ${rosterSimilar}／${total}；${hits.join("；")}`)
  })
})
