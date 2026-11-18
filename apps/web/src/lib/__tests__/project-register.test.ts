import { describe, expect, it } from "vitest";
import {
  MASKED,
  REGISTER_FIXED_HEADERS,
  REGISTER_FROZEN_COLUMNS,
  formatRegisterMoney,
  frozenRegisterColumnCount,
  registerColumns,
  registerRowCells,
  visibleRegisterColumns,
  type ProjectRegisterCells,
} from "../project-register";

const cells: ProjectRegisterCells = {
  projectId: "p1",
  dateRoc: "100.2.3",
  contractStatus: "已簽約",
  engineerSignature: "空調：甲技師",
  leadName: "假業務",
  moneyVisible: true,
  amountUntaxed: 1_234_567,
  taxAmount: 61_728,
  amountTotal: 1_296_295,
  receivedTotal: 0,
  unreceived: 1_234_567,
  invoicedTotal: null,
  subcontractTotal: 30_000,
  subcontractByDiscipline: { 空調: 30_000 },
  note: "累計請款 50%",
};

describe("專案列表＝專案申請單總表欄位", () => {
  it("欄頭＝原 Excel 第 4 列＋「專案單號」後的「專案編號」（2026-11-18），科別接在備註後", () => {
    expect([...REGISTER_FIXED_HEADERS]).toEqual([
      "項次", "專案單號", "專案編號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅",
      "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
    ]);
    expect(registerColumns(["空調", "消防", "汙水"]).map((c) => c.header).slice(17)).toEqual(["空調", "消防", "汙水"]);
    // 凍結窗格：項次…工程名稱（含專案單號、專案編號）。
    expect(registerColumns([]).slice(0, REGISTER_FROZEN_COLUMNS).map((c) => c.header)).toEqual([
      "項次", "專案單號", "專案編號", "日期", "客戶", "工程名稱",
    ]);
  });

  it("I:N（已收帳款…發包）比照原檔預設隱藏，打開後全部顯示；畫面不畫項次與科別欄；index 仍對得到儲存格", () => {
    const disc = ["電機", "空調", "消防", "汙水", "未分類"];
    const hidden = visibleRegisterColumns(disc, false);
    expect(hidden.map((c) => c.header)).toEqual([
      "專案單號", "專案編號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅", "業務", "備註",
    ]);
    expect(hidden.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 15, 16]);
    expect(visibleRegisterColumns(disc, true).map((c) => c.header)).toEqual([...REGISTER_FIXED_HEADERS.slice(1)]);
    // 沒有原檔以外的系統欄（狀態等）；項次、科別只在畫面移除（registerColumns 仍完整）。
    expect(visibleRegisterColumns(disc, true)).toHaveLength(16);
    expect(registerColumns(disc)).toHaveLength(22);
  });

  it("項次移除後凍結欄＝專案單號…工程名稱（顯示／隱藏 I:N 都一樣）", () => {
    for (const showHidden of [false, true]) {
      const cols = visibleRegisterColumns(["空調"], showHidden);
      expect(cols.slice(0, frozenRegisterColumnCount(cols)).map((c) => c.header)).toEqual([
        "專案單號", "專案編號", "日期", "客戶", "工程名稱",
      ]);
    }
  });

  it("金額格式同原檔會計格式：千分位、0 顯示「-」、空值空白", () => {
    expect(formatRegisterMoney(1_234_567)).toBe("1,234,567");
    expect(formatRegisterMoney(0)).toBe("-");
    expect(formatRegisterMoney(null)).toBe("");
    expect(formatRegisterMoney(-5_000)).toBe("-5,000");
    expect(formatRegisterMoney(42_857.4)).toBe("42,857");
  });

  it("看得到金額：一列依欄位順序帶出", () => {
    const row = registerRowCells({ seq: 3, code: "XX-100-001", projectNo: "客-甲-7", clientName: "假客戶", name: "假工程", register: cells }, ["空調", "消防"]);
    expect(row).toEqual([
      "3", "XX-100-001", "客-甲-7", "100.2.3", "假客戶", "假工程",
      "1,234,567", "61,728", "1,296,295", "-", "1,234,567", "",
      "已簽約", "空調：甲技師", "30,000", "假業務", "累計請款 50%",
      "30,000", "",
    ]);
  });

  it("無權限：金額與科別顯示「—」、備註空白，基本欄位照常", () => {
    const masked: ProjectRegisterCells = {
      ...cells,
      moneyVisible: false,
      amountUntaxed: null, taxAmount: null, amountTotal: null, receivedTotal: null,
      unreceived: null, invoicedTotal: null, subcontractTotal: null, subcontractByDiscipline: {}, note: "",
    };
    const row = registerRowCells({ seq: 1, code: "XX-100-002", clientName: "假客戶", name: "假工程", register: masked }, ["空調"]);
    expect(row[2]).toBe("");
    expect(row.slice(6, 12)).toEqual(Array(6).fill(MASKED));
    expect(row[14]).toBe(MASKED);
    expect(row[16]).toBe("");
    expect(row[17]).toBe(MASKED);
    expect(row.slice(12, 14)).toEqual(["已簽約", "空調：甲技師"]);
    expect(row[15]).toBe("假業務");
  });
});
