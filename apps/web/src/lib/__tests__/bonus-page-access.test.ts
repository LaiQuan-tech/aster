import { describe, expect, it } from "vitest";
import { bonusSheetAccess } from "../bonus-page-access";

describe("獎金分潤分頁各區塊權限（2026-10-27 獎金季發放併入）", () => {
  it("看得到集團財務的 HR／平台管理員：兩塊都有", () => {
    expect(bonusSheetAccess({ role: "hr_admin", canSeeGroupFinancials: true })).toEqual({ runs: true, sheet: true });
    expect(bonusSheetAccess({ role: "platform_admin", canSeeGroupFinancials: true })).toEqual({ runs: true, sheet: true });
  });

  it("看不到集團財務的 HR：批次作業照做，總表不畫", () => {
    expect(bonusSheetAccess({ role: "hr_admin", canSeeGroupFinancials: false })).toEqual({ runs: true, sheet: false });
  });

  it("會計：兩塊都沒有（批次 API requireHrAdmin、總表原本 hrOnly），就算被授權看集團財務也一樣", () => {
    expect(bonusSheetAccess({ role: "accountant", canSeeGroupFinancials: false })).toEqual({ runs: false, sheet: false });
    expect(bonusSheetAccess({ role: "accountant", canSeeGroupFinancials: true })).toEqual({ runs: false, sheet: false });
  });

  it("舊 API 缺 canSeeGroupFinancials：退回 HR 角色規則", () => {
    expect(bonusSheetAccess({ role: "hr_admin" })).toEqual({ runs: true, sheet: true });
    expect(bonusSheetAccess(null)).toEqual({ runs: false, sheet: false });
  });
});
