import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nextConfig from "../../../next.config";
import {
  ACCOUNTANT_DEFAULT_NAV,
  ADMIN_MODULES,
  ADMIN_REDIRECTS,
  ADMIN_ROUTES,
  ADMIN_SECTIONS,
  ADMIN_TABS,
  adminModulesOf,
  homeEntries,
  isModuleEnabled,
  normalizeAdminPath,
  parentPathFor,
  resolveAdminPath,
  roleNavOf,
  sectionForPath,
  sectionsForRole,
  subTabsFor,
  tabsForSection,
  type AdminSectionKey,
} from "../admin-nav";

const SECTION_KEYS: AdminSectionKey[] = [
  "home",
  "finance",
  "approvals",
  "attendance",
  "payroll",
  "people",
  "announce",
  "settings",
  "system",
];

/** apps/web/src/app/admin */
const ADMIN_APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app", "admin");

/** 遍歷 app/admin 底下所有 page.tsx 的靜態 URL 路徑；含 `[param]` 的目錄整條略過、`_` 開頭的私有目錄略過。 */
function staticAdminPages(dir: string, urlPath: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.includes("[") || entry.name.startsWith("_")) continue;
      staticAdminPages(join(dir, entry.name), `${urlPath}/${entry.name}`, out);
    } else if (entry.name === "page.tsx") {
      out.push(urlPath);
    }
  }
  return out.sort();
}

describe("normalizeAdminPath", () => {
  it("去 query／hash／尾斜線；空字串回 /", () => {
    expect(normalizeAdminPath("/admin")).toBe("/admin");
    expect(normalizeAdminPath("/admin/")).toBe("/admin");
    expect(normalizeAdminPath("/admin?x=1")).toBe("/admin");
    expect(normalizeAdminPath("/admin/projects/#top")).toBe("/admin/projects");
    expect(normalizeAdminPath("/admin/approvals?status=all")).toBe("/admin/approvals");
    expect(normalizeAdminPath("")).toBe("/");
  });
});

describe("resolveAdminPath：首頁與未知路徑", () => {
  it("/admin、/admin/、/admin?x=1 同結果：section home、tab null、title 空字串、非 detail", () => {
    const home = resolveAdminPath("/admin");
    expect(home).toMatchObject({
      section: "home",
      tab: null,
      sub: null,
      title: "",
      narrow: false,
      isDetail: false,
      parentPath: null,
    });
    expect(home.desc).toBeUndefined();
    expect(home.route).toMatchObject({ prefix: "/admin", exact: true, section: "home", tab: null, title: "" });
    expect(resolveAdminPath("/admin/")).toEqual(home);
    expect(resolveAdminPath("/admin?x=1")).toEqual(home);
  });

  it("未知路徑 → home、title 空字串（route.prefix 是 /admin，不等於原路徑）", () => {
    for (const path of ["/admin/whatever", "/admin/no/such/page", "/login", "/ess/requests"]) {
      const resolved = resolveAdminPath(path);
      expect(resolved.section).toBe("home");
      expect(resolved.title).toBe("");
      expect(resolved.route.prefix).toBe("/admin");
      expect(resolved.isDetail).toBe(false);
      expect(resolved.parentPath).toBe(null);
    }
    expect(sectionForPath("/admin/whatever").key).toBe("home");
  });
});

describe("resolveAdminPath：最長前綴", () => {
  it("/admin/projects/overview 只亮 overview，不被 /admin/projects 搶走", () => {
    expect(resolveAdminPath("/admin/projects/overview")).toMatchObject({
      section: "finance",
      tab: "overview",
      sub: null,
      title: "專案總覽",
      isDetail: false,
    });
    expect(resolveAdminPath("/admin/projects")).toMatchObject({ tab: "projects", sub: null, title: "專案與成員分潤" });
    expect(resolveAdminPath("/admin/projects/receivables")).toMatchObject({ tab: "receivables", title: "未收款追蹤" });
  });

  it("/admin/projects/annual → reports 分頁的 annual 子分頁；印花稅／示警也掛在 reports 下", () => {
    expect(resolveAdminPath("/admin/projects/annual")).toMatchObject({
      section: "finance",
      tab: "reports",
      sub: "annual",
      title: "年度專案申請單總表",
    });
    expect(resolveAdminPath("/admin/stamp-duty")).toMatchObject({ tab: "reports", sub: "stampDuty" });
    expect(resolveAdminPath("/admin/projects/alerts")).toMatchObject({ tab: "reports", sub: "alerts", title: "AI 進度示警" });
  });

  it("/admin/disbursements/pivot → disbursements 分頁 sub pivot；/admin/disbursements → sub list；/approvals → sub approvals（不是匯款單 detail）", () => {
    expect(resolveAdminPath("/admin/disbursements/pivot")).toMatchObject({
      section: "finance",
      tab: "disbursements",
      sub: "pivot",
      title: "放款年度總覽",
      isDetail: false,
    });
    expect(resolveAdminPath("/admin/disbursements")).toMatchObject({ tab: "disbursements", sub: "list", title: "放款專區" });
    expect(resolveAdminPath("/admin/disbursements/approvals")).toMatchObject({
      tab: "disbursements",
      sub: "approvals",
      title: "放款單簽核",
      isDetail: false,
    });
  });

  it("2026-09-23 新分頁：現金給付（三節獎金／加班超額另計）、生日紅包、值日／總機", () => {
    expect(resolveAdminPath("/admin/festival-bonuses")).toMatchObject({ section: "payroll", tab: "cash", sub: "festival", title: "三節／節慶獎金" });
    expect(resolveAdminPath("/admin/overtime-settlements")).toMatchObject({ section: "payroll", tab: "cash", sub: "otSettlements", title: "加班超額另計" });
    expect(resolveAdminPath("/admin/birthday-gifts")).toMatchObject({ section: "people", tab: "birthdays", title: "生日紅包登記" });
    expect(resolveAdminPath("/admin/duty-rosters")).toMatchObject({ section: "attendance", tab: "duty", title: "值日生／總機輪播排班" });
    for (const path of ["/admin/festival-bonuses", "/admin/overtime-settlements", "/admin/birthday-gifts", "/admin/duty-rosters"]) {
      expect(resolveAdminPath(path).module, path).toBeUndefined();
      expect(resolveAdminPath(path).narrow, path).toBe(false);
    }
  });

  it("名冊三頁都是 directory 分頁的子分頁", () => {
    expect(resolveAdminPath("/admin/clients")).toMatchObject({ tab: "directory", sub: "clients", title: "客戶名冊" });
    expect(resolveAdminPath("/admin/vendors")).toMatchObject({ tab: "directory", sub: "vendors" });
    expect(resolveAdminPath("/admin/companies")).toMatchObject({ tab: "directory", sub: "companies" });
  });

  it("/admin/knowledge/ask → knowledge 的 ask 子分頁，且帶 module knowledge", () => {
    expect(resolveAdminPath("/admin/knowledge/ask")).toMatchObject({
      section: "announce",
      tab: "knowledge",
      sub: "ask",
      module: "knowledge",
      title: "AI 文件問答",
    });
    expect(resolveAdminPath("/admin/knowledge")).toMatchObject({ tab: "knowledge", sub: "docs", module: "knowledge" });
  });

  it("兩個尚未建立的新頁也有路由：/admin/module-settings/ess-tabs 與 /admin/settings/advanced（narrow）", () => {
    expect(resolveAdminPath("/admin/module-settings/ess-tabs")).toMatchObject({
      section: "settings",
      tab: "essTabs",
      narrow: true,
    });
    expect(resolveAdminPath("/admin/module-settings")).toMatchObject({ tab: "rules", title: "規則參數", narrow: false });
    expect(resolveAdminPath("/admin/settings/advanced")).toMatchObject({ section: "settings", tab: "advanced", narrow: true });
  });

  it("相似前綴不互相污染：payroll-tax／leave-*／attendance-*", () => {
    expect(resolveAdminPath("/admin/payroll-tax")).toMatchObject({ section: "payroll", tab: "tax" });
    expect(resolveAdminPath("/admin/payroll")).toMatchObject({ section: "payroll", tab: "payroll" });
    expect(resolveAdminPath("/admin/leave-settlement")).toMatchObject({ section: "approvals", tab: "settlement" });
    expect(resolveAdminPath("/admin/leave-types")).toMatchObject({ section: "settings", tab: "leaveTypes" });
    expect(resolveAdminPath("/admin/leave-balances")).toMatchObject({ section: "approvals", tab: "balances" });
    expect(resolveAdminPath("/admin/attendance-settlement")).toMatchObject({
      section: "attendance",
      tab: "settlement",
      module: "attendanceSettlement",
    });
    expect(resolveAdminPath("/admin/attendance-sheets")).toMatchObject({ section: "attendance", tab: "sheets" });
  });

  it("query／尾斜線不影響：/admin/approvals?status=all 是簽核分頁", () => {
    expect(resolveAdminPath("/admin/approvals?status=all")).toMatchObject({ section: "approvals", tab: "approvals", title: "簽核" });
    expect(resolveAdminPath("/admin/approvals/")).toEqual(resolveAdminPath("/admin/approvals"));
  });

  it("隱藏模組的路由帶 module，一般分頁沒有", () => {
    expect(resolveAdminPath("/admin/kpi").module).toBe("kpi");
    expect(resolveAdminPath("/admin/recruitment").module).toBe("recruitment");
    expect(resolveAdminPath("/admin/employee-mail").module).toBe("employeeMail");
    expect(resolveAdminPath("/admin/dashboard").module).toBe("dashboard");
    expect(resolveAdminPath("/admin/ai").module).toBe("ai");
    expect(resolveAdminPath("/admin/employees").module).toBeUndefined();
    expect(sectionForPath("/admin/kpi").key).toBe("people");
  });
});

describe("resolveAdminPath：detail 頁（isDetail／parentPath／title）", () => {
  it("/admin/projects/[id] → 專案明細，父分頁 projects", () => {
    const resolved = resolveAdminPath("/admin/projects/abc-123");
    expect(resolved).toMatchObject({
      section: "finance",
      tab: "projects",
      sub: null,
      title: "專案明細",
      isDetail: true,
      parentPath: "/admin/projects",
      narrow: false,
    });
    expect(resolved.desc).toBeUndefined();
    expect(resolved.route.prefix).toBe("/admin/projects");
  });

  it("/admin/projects/[id]/application → pattern 路由：專案申請單，父路徑是專案明細", () => {
    const resolved = resolveAdminPath("/admin/projects/abc-123/application");
    expect(resolved).toMatchObject({
      section: "finance",
      tab: "projects",
      title: "專案申請單",
      isDetail: true,
      parentPath: "/admin/projects/abc-123",
    });
    expect(resolved.route.pattern).toBeInstanceOf(RegExp);
    expect(resolveAdminPath("/admin/projects/abc-123/application/")).toEqual(resolved);
    // 不是 application 的子路徑仍是專案明細
    expect(resolveAdminPath("/admin/projects/abc-123/other")).toMatchObject({ title: "專案明細", isDetail: true });
  });

  it("/admin/disbursements/[id] → 匯款單，父分頁 disbursements／list", () => {
    expect(resolveAdminPath("/admin/disbursements/9f")).toMatchObject({
      tab: "disbursements",
      sub: "list",
      title: "匯款單",
      isDetail: true,
      parentPath: "/admin/disbursements",
    });
  });

  it("/admin/bonus-runs/[id] → 獎金批次", () => {
    expect(resolveAdminPath("/admin/bonus-runs/2026-q1")).toMatchObject({
      tab: "bonus",
      title: "獎金批次",
      isDetail: true,
      parentPath: "/admin/bonus-runs",
    });
  });

  it("/admin/attendance-sheets/[id] → 出勤月表", () => {
    expect(resolveAdminPath("/admin/attendance-sheets/9f")).toMatchObject({
      section: "attendance",
      tab: "sheets",
      title: "出勤月表",
      isDetail: true,
      parentPath: "/admin/attendance-sheets",
    });
  });

  it("/admin/announcements/[id] → 公告版本與簽收", () => {
    expect(resolveAdminPath("/admin/announcements/a1")).toMatchObject({
      section: "announce",
      tab: "announcements",
      title: "公告版本與簽收",
      isDetail: true,
      parentPath: "/admin/announcements",
    });
  });

  it("沒有 detail 的分頁其子路徑不是 detail（title 沿用分頁、parentPath null）", () => {
    expect(resolveAdminPath("/admin/employees/zzz")).toMatchObject({
      tab: "employees",
      title: "員工主檔",
      isDetail: false,
      parentPath: null,
    });
    expect(resolveAdminPath("/admin/projects/overview/x")).toMatchObject({ tab: "overview", isDetail: false });
  });

  it("parentPathFor：非 detail → null；detail → 去掉最後一段（query／尾斜線不影響）", () => {
    expect(parentPathFor("/admin/projects")).toBe(null);
    expect(parentPathFor("/admin")).toBe(null);
    expect(parentPathFor("/admin/whatever")).toBe(null);
    expect(parentPathFor("/admin/employees")).toBe(null);
    expect(parentPathFor("/admin/projects/abc")).toBe("/admin/projects");
    expect(parentPathFor("/admin/projects/abc/application?print=1")).toBe("/admin/projects/abc");
    expect(parentPathFor("/admin/attendance-sheets/9f/")).toBe("/admin/attendance-sheets");
  });
});

describe("ADMIN_SECTIONS／homeEntries", () => {
  it("9 個分區、順序固定、href 不重複且都解析回自己的分區", () => {
    expect(ADMIN_SECTIONS).toHaveLength(9);
    expect(ADMIN_SECTIONS.map((s) => s.key)).toEqual(SECTION_KEYS);
    const hrefs = ADMIN_SECTIONS.map((s) => s.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const section of ADMIN_SECTIONS) {
      expect(section.icon).toBe(section.key);
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.desc.length).toBeGreaterThan(0);
      expect(resolveAdminPath(section.href).section).toBe(section.key);
    }
  });

  it("分區 href 是該區第一個非隱藏分頁（home 是 /admin）", () => {
    expect(ADMIN_SECTIONS[0]).toMatchObject({ key: "home", href: "/admin" });
    for (const section of ADMIN_SECTIONS.slice(1)) {
      expect(tabsForSection(section.key, null)[0]?.href).toBe(section.href);
    }
  });

  it("homeEntries() 8 格、排除 home、順序照側欄", () => {
    const entries = homeEntries();
    expect(entries).toHaveLength(8);
    expect(entries.map((s) => s.key)).toEqual(SECTION_KEYS.slice(1));
    expect(entries.some((s) => s.key === "home")).toBe(false);
  });
});

describe("ADMIN_TABS／tabsForSection／subTabsFor", () => {
  it("finance 7 個分頁 key 順序固定", () => {
    expect(ADMIN_TABS.finance.map((t) => t.key)).toEqual([
      "projects",
      "overview",
      "receivables",
      "disbursements",
      "bonus",
      "reports",
      "directory",
    ]);
    expect(tabsForSection("finance", null).map((t) => t.key)).toEqual(ADMIN_TABS.finance.map((t) => t.key));
  });

  it("每個分區的分頁 key 與 href（含子分頁）全站不重複，且都在 /admin/ 下", () => {
    const hrefs: string[] = [];
    for (const key of SECTION_KEYS) {
      const tabs = ADMIN_TABS[key];
      expect(new Set(tabs.map((t) => t.key)).size).toBe(tabs.length);
      for (const tab of tabs) {
        expect(tab.href.startsWith("/admin/")).toBe(true);
        if (tab.children && tab.children.length > 0) {
          expect(tab.children[0]?.href).toBe(tab.href);
          for (const child of tab.children) hrefs.push(child.href);
        } else {
          hrefs.push(tab.href);
        }
      }
    }
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(ADMIN_TABS.home).toEqual([]);
  });

  it("payroll 分頁順序：薪資 → 薪資單 → 稅務 → 現金給付（三節／加班超額）→ 報銷 → 預支", () => {
    expect(ADMIN_TABS.payroll.map((t) => t.key)).toEqual(["payroll", "payslips", "tax", "cash", "expenses", "advances"]);
    expect(subTabsFor("payroll", "cash").map((s) => `${s.key}:${s.href}`)).toEqual([
      "festival:/admin/festival-bonuses",
      "otSettlements:/admin/overtime-settlements",
    ]);
  });

  it("tabsForSection('people')：預設 4 個（含生日紅包）；{recruitment:true} 加進來且順序照表", () => {
    expect(tabsForSection("people", null).map((t) => t.key)).toEqual(["employees", "departments", "onboarding", "birthdays"]);
    expect(tabsForSection("people", {}).map((t) => t.key)).toEqual(["employees", "departments", "onboarding", "birthdays"]);
    expect(tabsForSection("people", { recruitment: true }).map((t) => t.key)).toEqual([
      "employees",
      "departments",
      "onboarding",
      "birthdays",
      "recruitment",
    ]);
    expect(tabsForSection("people", { employeeMail: true, kpi: true, recruitment: true }).map((t) => t.key)).toEqual([
      "employees",
      "departments",
      "onboarding",
      "birthdays",
      "recruitment",
      "kpi",
      "employeeMail",
    ]);
    // false／非 boolean 都算未啟用
    expect(tabsForSection("people", { kpi: false }).map((t) => t.key)).toEqual(["employees", "departments", "onboarding", "birthdays"]);
  });

  it("includeTab 強制保留目前所在的隱藏分頁；不認得的 key／null 沒作用", () => {
    expect(tabsForSection("people", {}, { includeTab: "kpi" }).map((t) => t.key)).toEqual([
      "employees",
      "departments",
      "onboarding",
      "birthdays",
      "kpi",
    ]);
    expect(tabsForSection("people", {}, { includeTab: null }).map((t) => t.key)).toEqual(["employees", "departments", "onboarding", "birthdays"]);
    expect(tabsForSection("people", {}, { includeTab: "nope" })).toHaveLength(4);
    expect(tabsForSection("system", null, { includeTab: "ai" }).map((t) => t.key)).toEqual([
      "reports",
      "audit",
      "backups",
      "notifications",
      "ai",
    ]);
    expect(tabsForSection("announce", { knowledge: true }).map((t) => t.key)).toEqual(["announcements", "companyInfo", "knowledge"]);
    expect(tabsForSection("attendance", null).map((t) => t.key)).toEqual(["punches", "sheets", "schedules", "duty"]);
  });

  it("subTabsFor：有 children 回子分頁（含 href）、沒有回 []、null 回 []", () => {
    expect(subTabsFor("finance", "disbursements")).toEqual([
      expect.objectContaining({ key: "list", label: "放款作業", href: "/admin/disbursements" }),
      expect.objectContaining({ key: "approvals", label: "待簽核", href: "/admin/disbursements/approvals" }),
      expect.objectContaining({ key: "pivot", label: "年度總覽", href: "/admin/disbursements/pivot" }),
    ]);
    expect(subTabsFor("finance", "reports").map((s) => s.key)).toEqual(["annual", "stampDuty", "alerts"]);
    expect(subTabsFor("finance", "directory").map((s) => s.key)).toEqual(["clients", "vendors", "companies"]);
    expect(subTabsFor("announce", "knowledge").map((s) => s.key)).toEqual(["docs", "ask"]);
    expect(subTabsFor("finance", "projects")).toEqual([]);
    expect(subTabsFor("finance", null)).toEqual([]);
    expect(subTabsFor("home", undefined)).toEqual([]);
  });

  it("narrow 只有 shifts／essTabs／site／advanced 四頁", () => {
    const narrowRoutes = ADMIN_ROUTES.filter((r) => r.narrow).map((r) => r.prefix);
    expect(narrowRoutes).toEqual([
      "/admin/shifts",
      "/admin/module-settings/ess-tabs",
      "/admin/company-space",
      "/admin/settings/advanced",
    ]);
    expect(resolveAdminPath("/admin/shifts").narrow).toBe(true);
    expect(resolveAdminPath("/admin/employees").narrow).toBe(false);
  });
});

describe("角色導覽：ACCOUNTANT_DEFAULT_NAV／roleNavOf／sectionsForRole／tabsForSection({ roleNav })", () => {
  const NAV = ACCOUNTANT_DEFAULT_NAV;

  it("會計預設範圍不含 bonus／payroll／payslips／tax／cash；分區只有 首頁、專案與財務、出勤、薪資與費用、人員", () => {
    expect(NAV.sections).toEqual(["home", "finance", "attendance", "payroll", "people"]);
    const finance = tabsForSection("finance", null, { roleNav: NAV }).map((t) => t.key);
    expect(finance).not.toContain("bonus");
    expect(finance).toEqual(["projects", "overview", "receivables", "disbursements", "reports", "directory"]);
    const payroll = tabsForSection("payroll", null, { roleNav: NAV }).map((t) => t.key);
    expect(payroll).toEqual(["expenses", "advances"]);
    for (const key of ["payroll", "payslips", "tax", "cash"]) expect(payroll).not.toContain(key);
    expect(tabsForSection("attendance", null, { roleNav: NAV }).map((t) => t.key)).toEqual(["sheets"]);
    expect(tabsForSection("people", { recruitment: true }, { roleNav: NAV }).map((t) => t.key)).toEqual(["employees"]);
    // 沒列在 tabs 的分區＝該區全部（module 開關照舊）
    expect(tabsForSection("system", null, { roleNav: NAV }).map((t) => t.key)).toEqual(["reports", "audit", "backups", "notifications"]);
    // includeTab 仍強制保留（直開未開放網址時分頁列標「未開放」）
    expect(tabsForSection("payroll", null, { roleNav: NAV, includeTab: "payslips" }).map((t) => t.key)).toEqual(["payslips", "expenses", "advances"]);
  });

  it("sectionsForRole：null → 9 個分區原樣；會計 → 5 個且 href 改成該區第一個可見分頁", () => {
    expect(sectionsForRole(null)).toEqual([...ADMIN_SECTIONS]);
    expect(sectionsForRole(undefined).map((s) => s.key)).toEqual(SECTION_KEYS);
    const acc = sectionsForRole(NAV);
    expect(acc.map((s) => s.key)).toEqual(["home", "finance", "attendance", "payroll", "people"]);
    expect(acc.map((s) => s.href)).toEqual(["/admin", "/admin/projects", "/admin/attendance-sheets", "/admin/expenses", "/admin/employees"]);
    // 分區被列了但一個分頁都不剩 → 不列
    expect(sectionsForRole({ sections: ["home", "system"], tabs: { system: ["nope"] } }).map((s) => s.key)).toEqual(["home"]);
    // homeEntries 帶 roleNav → 排除 home 的可見分區
    expect(homeEntries(NAV).map((s) => s.key)).toEqual(["finance", "attendance", "payroll", "people"]);
    expect(homeEntries()).toHaveLength(8);
  });

  it("roleNavOf：非會計 → null；會計沒設定 → 預設；features.roles.accountant 有效時整鍵覆蓋（只收認得的 key、補 home）", () => {
    expect(roleNavOf("hr_admin", { roles: { accountant: { sections: ["finance"] } } })).toBeNull();
    expect(roleNavOf("platform_admin", null)).toBeNull();
    expect(roleNavOf("employee", {})).toBeNull();
    expect(roleNavOf(null, {})).toBeNull();
    expect(roleNavOf("accountant", null)).toBe(NAV);
    expect(roleNavOf("accountant", {})).toBe(NAV);
    expect(roleNavOf("accountant", { roles: { accountant: "finance" } })).toBe(NAV);
    expect(roleNavOf("accountant", { roles: { accountant: { sections: ["system", "finance", "bogus"], tabs: { finance: ["projects"], bogus: ["x"], system: "all" } } } })).toEqual({
      sections: ["home", "finance", "system"],
      tabs: { finance: ["projects"] },
    });
    // 只帶 tabs → sections 退回預設的分區清單
    expect(roleNavOf("accountant", { roles: { accountant: { tabs: { people: ["employees", "departments"] } } } })).toEqual({
      sections: NAV.sections,
      tabs: { people: ["employees", "departments"] },
    });
  });
});

describe("ADMIN_MODULES／isModuleEnabled／adminModulesOf", () => {
  it("7 個隱藏模組，每個對到一條帶 module 的路由（href／section 一致）", () => {
    expect(ADMIN_MODULES).toHaveLength(7);
    expect(ADMIN_MODULES.map((m) => m.key)).toEqual([
      "recruitment",
      "kpi",
      "ai",
      "knowledge",
      "dashboard",
      "employeeMail",
      "attendanceSettlement",
    ]);
    for (const mod of ADMIN_MODULES) {
      const routes = ADMIN_ROUTES.filter((r) => r.module === mod.key && r.prefix === mod.href);
      expect(routes, mod.key).toHaveLength(1);
      expect(routes[0]?.section).toBe(mod.section);
      expect(mod.label.length).toBeGreaterThan(0);
      expect(mod.desc.length).toBeGreaterThan(0);
    }
    // 帶 module 的路由只會是這 7 個模組（knowledge 有 docs／ask 兩條）
    const moduleRoutes = ADMIN_ROUTES.filter((r) => r.module);
    expect(moduleRoutes).toHaveLength(8);
    expect(new Set(moduleRoutes.map((r) => r.module))).toEqual(new Set(ADMIN_MODULES.map((m) => m.key)));
  });

  it("isModuleEnabled：無 key → true；有 key → 必須 === true", () => {
    expect(isModuleEnabled(null)).toBe(true);
    expect(isModuleEnabled({}, undefined)).toBe(true);
    expect(isModuleEnabled({ kpi: true }, "kpi")).toBe(true);
    expect(isModuleEnabled({ kpi: false }, "kpi")).toBe(false);
    expect(isModuleEnabled({}, "kpi")).toBe(false);
    expect(isModuleEnabled(null, "kpi")).toBe(false);
    expect(isModuleEnabled(undefined, "ai")).toBe(false);
  });

  it("adminModulesOf：只收 boolean 且認得的 key；null／undefined／格式不對 → {}", () => {
    expect(adminModulesOf({ adminModules: { kpi: true, ai: "yes" } })).toEqual({ kpi: true });
    expect(adminModulesOf({ adminModules: { kpi: false, dashboard: true, foo: true } })).toEqual({ kpi: false, dashboard: true });
    expect(adminModulesOf(null)).toEqual({});
    expect(adminModulesOf(undefined)).toEqual({});
    expect(adminModulesOf({})).toEqual({});
    expect(adminModulesOf({ adminModules: "kpi" })).toEqual({});
    expect(adminModulesOf({ adminModules: ["kpi"] })).toEqual({});
    expect(adminModulesOf({ adminModules: null })).toEqual({});
  });
});

describe("ADMIN_ROUTES", () => {
  it("首頁精準路由只有一條；pattern 路由只有專案申請單；非 pattern 的 prefix 不重複", () => {
    expect(ADMIN_ROUTES.filter((r) => r.exact)).toEqual([{ prefix: "/admin", exact: true, section: "home", tab: null, title: "" }]);
    const patterns = ADMIN_ROUTES.filter((r) => r.pattern);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({ prefix: "/admin/projects", section: "finance", tab: "projects", title: "專案申請單" });
    const prefixes = ADMIN_ROUTES.filter((r) => !r.pattern).map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("首頁以外每條路由都有 title 與 desc（pattern 路由除外），detail 的 title 不為空", () => {
    for (const route of ADMIN_ROUTES) {
      if (route.exact) continue;
      expect(route.title.length, route.prefix).toBeGreaterThan(0);
      if (!route.pattern) expect(route.desc?.length ?? 0, route.prefix).toBeGreaterThan(0);
      if (route.detail) expect(route.detail.title.length).toBeGreaterThan(0);
    }
  });

  it("6 種 detail：projects／disbursements list／bonus／sheets／announcements／專案申請單", () => {
    const details = ADMIN_ROUTES.filter((r) => r.detail).map((r) => `${r.prefix}${r.pattern ? "#pattern" : ""}`);
    expect(details).toEqual([
      "/admin/projects",
      "/admin/disbursements",
      "/admin/bonus-runs",
      "/admin/attendance-sheets",
      "/admin/announcements",
      "/admin/projects#pattern",
    ]);
  });
});

describe("ADMIN_REDIRECTS 與 next.config.ts", () => {
  it("兩條轉址：form-records → approvals?status=all、org-chart → departments", () => {
    expect(ADMIN_REDIRECTS).toEqual([
      { source: "/admin/form-records", destination: "/admin/approvals?status=all" },
      { source: "/admin/org-chart", destination: "/admin/departments" },
    ]);
    // 轉址目標都解析得到自己的路由
    for (const redirect of ADMIN_REDIRECTS) {
      const target = normalizeAdminPath(redirect.destination);
      expect(resolveAdminPath(target).route.prefix).toBe(target);
    }
  });

  it("next.config.ts 的 redirects() 與 ADMIN_REDIRECTS 一致（permanent:false）", async () => {
    expect(typeof nextConfig.redirects).toBe("function");
    const redirects = await nextConfig.redirects!();
    expect(redirects).toEqual(ADMIN_REDIRECTS.map((r) => ({ ...r, permanent: false })));
  });
});

describe("檔案系統覆蓋（app/admin/**/page.tsx）", () => {
  it("每個靜態頁面路徑都有自己的路由（route.prefix === path）；/admin 與兩個轉址頁除外", () => {
    const pages = staticAdminPages(ADMIN_APP_DIR, "/admin");
    expect(pages.length).toBeGreaterThanOrEqual(40);
    expect(pages).toContain("/admin");
    expect(pages).toContain("/admin/projects/overview");
    const skip = new Set<string>(["/admin", ...ADMIN_REDIRECTS.map((r) => r.source)]);
    const missing = pages.filter((path) => !skip.has(path) && resolveAdminPath(path).route.prefix !== path);
    expect(missing).toEqual([]);
  });

  it("路由表裡的每個 prefix 都有頁面（尚未建立的新頁除外：2026-09-23 五頁由 WP6／WP7／WP8 建立）", () => {
    const pages = new Set(staticAdminPages(ADMIN_APP_DIR, "/admin"));
    const pending = new Set([
      "/admin/settings/advanced",
      "/admin/module-settings/ess-tabs",
      "/admin/disbursements/approvals",
      "/admin/festival-bonuses",
      "/admin/overtime-settlements",
      "/admin/birthday-gifts",
      "/admin/duty-rosters",
    ]);
    const orphan = ADMIN_ROUTES.filter((r) => !r.pattern && !pages.has(r.prefix) && !pending.has(r.prefix)).map((r) => r.prefix);
    expect(orphan).toEqual([]);
  });
});
