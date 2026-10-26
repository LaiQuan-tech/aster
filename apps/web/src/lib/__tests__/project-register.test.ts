import { describe, expect, it } from "vitest";
import {
  MASKED,
  REGISTER_FIXED_HEADERS,
  REGISTER_FROZEN_COLUMNS,
  formatRegisterMoney,
  registerColumns,
  registerRowCells,
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
  it("欄頭與原 Excel 第 4 列一字不差（A:P），科別從 Q 欄起", () => {
    expect([...REGISTER_FIXED_HEADERS]).toEqual([
      "項次", "專案單號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅",
      "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
    ]);
    expect(registerColumns(["空調", "消防", "汙水"]).map((c) => c.header).slice(16)).toEqual(["空調", "消防", "汙水"]);
    // 凍結窗格 F5：A:E（含專案單號、工程名稱）。
    expect(registerColumns([]).slice(0, REGISTER_FROZEN_COLUMNS).map((c) => c.header)).toEqual([
      "項次", "專案單號", "日期", "客戶", "工程名稱",
    ]);
  });

  it("金額格式同原檔會計格式：千分位、0 顯示「-」、空值空白", () => {
    expect(formatRegisterMoney(1_234_567)).toBe("1,234,567");
    expect(formatRegisterMoney(0)).toBe("-");
    expect(formatRegisterMoney(null)).toBe("");
    expect(formatRegisterMoney(-5_000)).toBe("-5,000");
    expect(formatRegisterMoney(42_857.4)).toBe("42,857");
  });

  it("看得到金額：一列依欄位順序帶出", () => {
    const row = registerRowCells({ seq: 3, code: "XX-100-001", clientName: "假客戶", name: "假工程", register: cells }, ["空調", "消防"]);
    expect(row).toEqual([
      "3", "XX-100-001", "100.2.3", "假客戶", "假工程",
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
    expect(row.slice(5, 11)).toEqual(Array(6).fill(MASKED));
    expect(row[13]).toBe(MASKED);
    expect(row[15]).toBe("");
    expect(row[16]).toBe(MASKED);
    expect(row.slice(11, 13)).toEqual(["已簽約", "空調：甲技師"]);
    expect(row[14]).toBe("假業務");
  });
});
