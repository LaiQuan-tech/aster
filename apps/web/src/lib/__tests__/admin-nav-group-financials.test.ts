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
