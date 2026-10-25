import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_FILTER,
  companyErrorMessage,
  companyLabel,
  filterByCompany,
  toggleAllVisible,
  toggleSelected,
} from "../employee-company";

// 假資料：識別碼、名稱都是明顯的假值。
const companies = [
  { id: "co-a", name: "測試公司A", isActive: true },
  { id: "co-b", name: "測試公司B", isActive: true },
  { id: "co-x", name: "測試停用公司", isActive: false },
];
const rows = [
  { id: "e1", company_id: "co-a" },
  { id: "e2", company_id: null },
  { id: "e3", company_id: "co-b" },
  { id: "e4" },
];

describe("filterByCompany", () => {
  it("空字串＝全部；指定公司；未指派含舊 API 沒有欄位的列", () => {
    expect(filterByCompany(rows, "").map((r) => r.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(filterByCompany(rows, "co-b").map((r) => r.id)).toEqual(["e3"]);
    expect(filterByCompany(rows, UNASSIGNED_FILTER).map((r) => r.id)).toEqual(["e2", "e4"]);
  });
});

describe("companyLabel", () => {
  it("API 名稱優先、退回名冊、未指派", () => {
    expect(companyLabel({ company_id: "co-a", company_name: "後端名稱" }, companies)).toBe("後端名稱");
    expect(companyLabel({ company_id: "co-b" }, companies)).toBe("測試公司B");
    expect(companyLabel({ company_id: null }, companies)).toBe("未指派");
    expect(companyLabel({ company_id: "gone" }, companies)).toBe("（找不到公司）");
  });
});

describe("勾選", () => {
  it("toggleSelected 不改原本的 Set", () => {
    const a = new Set(["e1"]);
    const b = toggleSelected(a, "e2");
    expect([...a]).toEqual(["e1"]);
    expect([...b].sort()).toEqual(["e1", "e2"]);
    expect([...toggleSelected(b, "e1")]).toEqual(["e2"]);
  });

  it("toggleAllVisible：沒全勾 → 全勾（保留畫面外的）；全勾 → 只取消畫面上的", () => {
    const on = toggleAllVisible(new Set(["outside", "e1"]), ["e1", "e2"]);
    expect([...on].sort()).toEqual(["e1", "e2", "outside"]);
    expect([...toggleAllVisible(on, ["e1", "e2"])]).toEqual(["outside"]);
    expect([...toggleAllVisible(new Set(), [])]).toEqual([]);
  });
});

describe("companyErrorMessage", () => {
  it("認得的碼翻成中文，其他回 null", () => {
    expect(companyErrorMessage("company_inactive")).toContain("已停用");
    expect(companyErrorMessage("invalid_company")).toContain("不屬於");
    expect(companyErrorMessage("employee_not_found")).toContain("不存在");
    expect(companyErrorMessage("weak_password")).toBeNull();
    expect(companyErrorMessage(null)).toBeNull();
  });
});
