import { describe, expect, it } from "vitest";
import {
  ADMIN_REDIRECTS,
  canSeeGroupFinancialsOf,
  isAdminPathAllowed,
  isGroupFinancialsAdminPath,
  offLimitsCopy,
  tabsForSection,
  type AdminSectionKey,
} from "../admin-nav";

// 集團財務（/me.canSeeGroupFinancials，2026-10-26）只給老闆／platform_admin／授權 HR。
// 2026-10-27 起：集團總覽移到首頁、只給在職 platform_admin，不再是分頁（舊網址轉址到 /admin#group-overview）；
// 獎金分潤併入獎金季發放，專案獎金總表改在頁內區塊守門——目前沒有分頁帶 groupFinancials（機制保留）。
describe("集團財務導覽", () => {
  const financeKeys = (canSeeGroupFinancials?: boolean) =>
    tabsForSection("finance", null, { canSeeGroupFinancials }).map((t) => t.key);

  it("集團總覽不再是分頁：不論 canSeeGroupFinancials 都不列；舊網址導到首頁的集團總覽區塊", () => {
    for (const v of [false, true, undefined]) expect(financeKeys(v)).not.toContain("groupOverview");
    expect(ADMIN_REDIRECTS).toContainEqual({ source: "/admin/group-overview", destination: "/admin#group-overview" });
    expect(isGroupFinancialsAdminPath("/admin/group-overview")).toBe(false);
  });

  it("目前沒有集團財務分頁：canSeeGroupFinancials 不論 true／false／省略，財務分頁清單都一樣；其他頁不受影響", () => {
    expect(financeKeys(false)).toEqual(financeKeys(true));
    expect(financeKeys(undefined)).toEqual(financeKeys(true));
    expect(isGroupFinancialsAdminPath("/admin/projects")).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/payroll", roleNav: null, canSeeGroupFinancials: false })).toBe(true);
  });

  it("獎金分潤（2026-10-27 併入獎金季發放）：分頁條件＝兩者聯集——HR 不論能否看集團財務都列；總表改在頁內守門", () => {
    expect(financeKeys(false)).toContain("bonus");
    expect(financeKeys(true)).toContain("bonus");
    expect(financeKeys(true)).not.toContain("bonusSheet");
    expect(isGroupFinancialsAdminPath("/admin/bonus-sheet")).toBe(false);
    expect(isGroupFinancialsAdminPath("/admin/bonus-runs/r1")).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-sheet", roleNav: null, canSeeGroupFinancials: false })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-runs/r1", roleNav: null, canSeeGroupFinancials: false })).toBe(true);
    // 會計：預設範圍不含；租戶開了 bonus 才列（同原「獎金季發放」，頁內兩塊對會計仍不畫，見 bonus-page-access）
    const accountantNav = { sections: ["home", "finance"] as AdminSectionKey[], tabs: {} };
    expect(tabsForSection("finance", null, { roleNav: accountantNav, canSeeGroupFinancials: true }).map((t) => t.key)).toContain("bonus");
    expect(tabsForSection("finance", null, { roleNav: { sections: ["home", "finance"], tabs: { finance: ["projects"] } }, canSeeGroupFinancials: true }).map((t) => t.key)).not.toContain("bonus");
  });

  it("被擋時的說明：獎金分潤已不是集團財務頁，看不到集團財務也照一般文案；其他頁維持原說法", () => {
    expect(offLimitsCopy({ pathname: "/admin/bonus-sheet", roleLabel: "此角色", canSeeGroupFinancials: false }).title).toBe("此頁未開放給此角色");
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
