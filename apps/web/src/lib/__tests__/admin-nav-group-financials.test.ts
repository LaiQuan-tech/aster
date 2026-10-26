import { describe, expect, it } from "vitest";
import {
  canSeeGroupFinancialsOf,
  isAdminPathAllowed,
  isGroupFinancialsAdminPath,
  offLimitsCopy,
  tabsForSection,
} from "../admin-nav";

// 集團財務（集團總覽）只給老闆／platform_admin／授權 HR（/me.canSeeGroupFinancials，2026-10-26）。
describe("集團財務導覽", () => {
  const financeKeys = (canSeeGroupFinancials?: boolean) =>
    tabsForSection("finance", null, { canSeeGroupFinancials }).map((t) => t.key);

  it("canSeeGroupFinancials=false 剔除集團總覽；true／省略保留", () => {
    expect(financeKeys(false)).not.toContain("groupOverview");
    expect(financeKeys(true)).toContain("groupOverview");
    expect(financeKeys(undefined)).toContain("groupOverview");
  });

  it("直開集團總覽：看不到集團財務的 HR 也不放行；看得到的放行", () => {
    expect(isGroupFinancialsAdminPath("/admin/group-overview")).toBe(true);
    expect(isGroupFinancialsAdminPath("/admin/projects")).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/group-overview", roleNav: null, canSeeGroupFinancials: false })).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/group-overview", roleNav: null, canSeeGroupFinancials: true })).toBe(true);
    // 其他頁不受影響
    expect(isAdminPathAllowed({ pathname: "/admin/payroll", roleNav: null, canSeeGroupFinancials: false })).toBe(true);
  });

  it("獎金分潤（2026-10-27）：集團財務頁、HR 限定——看不到集團財務的 HR、會計都不列也不放行", () => {
    expect(financeKeys(false)).not.toContain("bonusSheet");
    expect(financeKeys(true)).toContain("bonusSheet");
    // 緊接在獎金季發放之後
    const keys = financeKeys(true);
    expect(keys.indexOf("bonusSheet")).toBe(keys.indexOf("bonus") + 1);
    expect(isGroupFinancialsAdminPath("/admin/bonus-sheet")).toBe(true);
    expect(isGroupFinancialsAdminPath("/admin/bonus-runs")).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-sheet", roleNav: null, canSeeGroupFinancials: false })).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-sheet", roleNav: null, canSeeGroupFinancials: true })).toBe(true);
    // 會計（帶 roleNav）即使租戶把整個財務分區開給會計，hrOnly 仍剔除
    const accountantNav = { sections: ["home", "finance"] as const, tabs: {} };
    expect(tabsForSection("finance", null, { roleNav: { ...accountantNav, sections: [...accountantNav.sections] }, canSeeGroupFinancials: true }).map((t) => t.key)).not.toContain("bonusSheet");
  });

  it("被擋時的說明指向老闆授權", () => {
    expect(offLimitsCopy({ pathname: "/admin/group-overview", roleLabel: "此角色", canSeeGroupFinancials: false }).title).toBe("此頁僅限老闆與授權人員");
    expect(offLimitsCopy({ pathname: "/admin/payroll", roleLabel: "會計", canSeeGroupFinancials: false }).title).toBe("此頁未開放給會計");
  });

  it("canSeeGroupFinancialsOf：新 API 照布林；舊 API 缺欄位退回 HR 角色", () => {
    expect(canSeeGroupFinancialsOf({ role: "hr_admin", canSeeGroupFinancials: false })).toBe(false);
    expect(canSeeGroupFinancialsOf({ role: "employee", canSeeGroupFinancials: true })).toBe(true);
    expect(canSeeGroupFinancialsOf({ role: "hr_admin" })).toBe(true);
    expect(canSeeGroupFinancialsOf({ role: "accountant" })).toBe(false);
    expect(canSeeGroupFinancialsOf(null)).toBe(false);
  });
});
