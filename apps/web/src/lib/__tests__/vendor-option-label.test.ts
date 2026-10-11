import { describe, it, expect } from "vitest";
import { vendorOptionLabel } from "../company-api";

/**
 * lib/company-api.ts 的 vendorOptionLabel：廠商下拉（VendorCombo、DisbursementForm）的顯示字。
 * ⚠️ 名稱都是明顯的假值（repo 是公開的）。
 */
describe("vendorOptionLabel — 廠商下拉選項的顯示字", () => {
  it("有簡稱：簡稱（全名）", () => {
    expect(vendorOptionLabel({ name: "測試廠商甲股份有限公司", shortName: "測試甲" })).toBe("測試甲（測試廠商甲股份有限公司）");
  });

  it("沒有簡稱（null／undefined／空字串）：只顯示全名", () => {
    expect(vendorOptionLabel({ name: "測試廠商乙", shortName: null })).toBe("測試廠商乙");
    expect(vendorOptionLabel({ name: "測試廠商乙" })).toBe("測試廠商乙");
    expect(vendorOptionLabel({ name: "測試廠商乙", shortName: "" })).toBe("測試廠商乙");
  });

  it("簡稱與全名相同：不重複顯示", () => {
    expect(vendorOptionLabel({ name: "測試廠商丙", shortName: "測試廠商丙" })).toBe("測試廠商丙");
  });
});
