import { describe, expect, it } from "vitest";
import {
  ADMIN_REDIRECTS,
  canSeeGroupFinancialsOf,
  isAdminPathAllowed,
  isGroupFinancialsAdminPath,
  offLimitsCopy,
  tabsForSection,
} from "../admin-nav";

// 集團財務頁（獎金分潤）只給老闆／platform_admin／授權 HR（/me.canSeeGroupFinancials，2026-10-26）。
// 集團總覽 2026-10-27 起移到首頁、只給在職 platform_admin，不再是分頁（舊網址轉址到 /admin#group-overview）。
describe("集團財務導覽", () => {
  const financeKeys = (canSeeGroupFinancials?: boolean) =>
    tabsForSection("finance", null, { canSeeGroupFinancials }).map((t) => t.key);

  it("集團總覽不再是分頁：不論 canSeeGroupFinancials 都不列；舊網址導到首頁的集團總覽區塊", () => {
    for (const v of [false, true, undefined]) expect(financeKeys(v)).not.toContain("groupOverview");
    expect(ADMIN_REDIRECTS).toContainEqual({ source: "/admin/group-overview", destination: "/admin#group-overview" });
    expect(isGroupFinancialsAdminPath("/admin/group-overview")).toBe(false);
  });

  it("canSeeGroupFinancials=false 剔除獎金分潤；true／省略保留；其他頁不受影響", () => {
    expect(financeKeys(false)).not.toContain("bonusSheet");
    expect(financeKeys(true)).toContain("bonusSheet");
    expect(financeKeys(undefined)).toContain("bonusSheet");
    expect(isGroupFinancialsAdminPath("/admin/projects")).toBe(false);
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
    expect(offLimitsCopy({ pathname: "/admin/bonus-sheet", roleLabel: "此角色", canSeeGroupFinancials: false }).title).toBe("此頁僅限老闆與授權人員");
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
