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
  configurableTabsForRole,
  isAdminPathAllowed,
  isHrOnlyAdminPath,
  isModuleEnabled,
  nextRoleTabs,
  normalizeAdminPath,
  offLimitsCopy,
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
  it("專案與財務的子分頁各自亮燈，不被 /admin/projects 搶走", () => {
    expect(resolveAdminPath("/admin/projects")).toMatchObject({ tab: "projects", sub: null, title: "專案與成員分潤" });
    expect(resolveAdminPath("/admin/projects/receivables")).toMatchObject({ tab: "receivables", title: "未收款追蹤" });
  });

  it("報表分頁（年度總表／印花稅／專案示警，2026-10-27 移除）：舊網址不再有自己的路由，落回專案列表", () => {
    for (const path of ["/admin/projects/annual", "/admin/stamp-duty", "/admin/projects/alerts"]) {
      expect(resolveAdminPath(path).route.prefix, path).not.toBe(path);
    }
    expect(ADMIN_TABS.finance.map((t) => t.key)).not.toContain("reports");
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

  it("2026-09-23 新分頁：現金給付（三節獎金／加班超額另計）、值日／總機", () => {
    expect(resolveAdminPath("/admin/festival-bonuses")).toMatchObject({ section: "payroll", tab: "cash", sub: "festival", title: "三節／節慶獎金" });
    expect(resolveAdminPath("/admin/overtime-settlements")).toMatchObject({ section: "payroll", tab: "cash", sub: "otSettlements", title: "加班超額另計" });
    expect(resolveAdminPath("/admin/duty-rosters")).toMatchObject({ section: "attendance", tab: "duty", title: "值日生／總機輪播排班" });
    for (const path of ["/admin/festival-bonuses", "/admin/overtime-settlements", "/admin/duty-rosters"]) {
      expect(resolveAdminPath(path).module, path).toBeUndefined();
      expect(resolveAdminPath(path).narrow, path).toBe(false);
    }
  });

  it("名冊三頁都是 directory 分頁的子分頁", () => {
    expect(resolveAdminPath("/admin/clients")).toMatchObject({ tab: "directory", sub: "clients", title: "客戶名冊" });
    expect(resolveAdminPath("/admin/vendors")).toMatchObject({ tab: "directory", sub: "vendors" });
    expect(resolveAdminPath("/admin/companies")).toMatchObject({ tab: "directory", sub: "companies" });
  });

  it("/admin/group-overview 已不是分頁（2026-10-27 移到首頁）：不解析成任何財務分頁，靠轉址導到 /admin#group-overview", () => {
    expect(resolveAdminPath("/admin/group-overview").tab).not.toBe("groupOverview");
    expect(ADMIN_REDIRECTS.find((r) => r.source === "/admin/group-overview")?.destination).toBe("/admin#group-overview");
    expect(subTabsFor("finance", "groupOverview")).toEqual([]);
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

  it("選項清單頁（2026-10-10）：/admin/option-lists 在設定區、narrow，標題「選項清單」、說明寫明用途；分區入口不變", () => {
    const resolved = resolveAdminPath("/admin/option-lists");
    expect(resolved).toMatchObject({ section: "settings", tab: "optionLists", title: "選項清單", narrow: true, isDetail: false });
    expect(resolved.desc).toContain("客戶分類");
    expect(resolved.desc).toContain("停用");
    expect(ADMIN_TABS.settings.map((t) => t.key)).toEqual([
      "leaveTypes",
      "shifts",
      "calendar",
      "rules",
      "essTabs",
      "site",
      "optionLists",
      "advanced",
    ]);
    expect(ADMIN_SECTIONS.find((s) => s.key === "settings")?.href).toBe("/admin/leave-types");
    expect(tabsForSection("settings", null).map((t) => t.key)).toContain("optionLists");
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
    expect(resolveAdminPath("/admin/late-reports")).toMatchObject({ section: "attendance", tab: "lateReports", title: "遲到說明" });
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

  it("/admin/employees/[id] → 員工資料（2026-10-26 員工內頁）", () => {
    expect(resolveAdminPath("/admin/employees/e1")).toMatchObject({
      section: "people",
      tab: "employees",
      title: "員工資料",
      isDetail: true,
      parentPath: "/admin/employees",
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
    expect(resolveAdminPath("/admin/departments/zzz")).toMatchObject({
      tab: "departments",
      isDetail: false,
      parentPath: null,
    });
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

describe("ADMIN_SECTIONS", () => {
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
});

describe("ADMIN_TABS／tabsForSection／subTabsFor", () => {
  it("finance 6 個分頁 key 順序固定（獎金分潤緊接獎金季發放；集團總覽 2026-10-27 移到首頁）", () => {
    expect(ADMIN_TABS.finance.map((t) => t.key)).toEqual([
      "projects",
      "receivables",
      "disbursements",
      "bonus",
      "bonusSheet",
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

  it("tabsForSection('people')：預設 2 個；{recruitment:true} 加進來且順序照表", () => {
    expect(tabsForSection("people", null).map((t) => t.key)).toEqual(["employees", "departments"]);
    expect(tabsForSection("people", {}).map((t) => t.key)).toEqual(["employees", "departments"]);
    expect(tabsForSection("people", { recruitment: true }).map((t) => t.key)).toEqual([
      "employees",
      "departments",
      "recruitment",
    ]);
    expect(tabsForSection("people", { employeeMail: true, kpi: true, recruitment: true }).map((t) => t.key)).toEqual([
      "employees",
      "departments",
      "recruitment",
      "kpi",
      "employeeMail",
    ]);
    // false／非 boolean 都算未啟用
    expect(tabsForSection("people", { kpi: false }).map((t) => t.key)).toEqual(["employees", "departments"]);
  });

  it("includeTab 強制保留目前所在的隱藏分頁；不認得的 key／null 沒作用", () => {
    expect(tabsForSection("people", {}, { includeTab: "kpi" }).map((t) => t.key)).toEqual([
      "employees",
      "departments",
      "kpi",
    ]);
    expect(tabsForSection("people", {}, { includeTab: null }).map((t) => t.key)).toEqual(["employees", "departments"]);
    expect(tabsForSection("people", {}, { includeTab: "nope" })).toHaveLength(2);
    expect(tabsForSection("system", null, { includeTab: "ai" }).map((t) => t.key)).toEqual([
      "reports",
      "audit",
      "backups",
      "notifications",
      "ai",
    ]);
    expect(tabsForSection("announce", { knowledge: true }).map((t) => t.key)).toEqual(["announcements", "companyInfo", "knowledge"]);
    // 班表（/admin/schedules）2026-10-11 移除；班別在設定區、值日／總機保留。
    expect(tabsForSection("attendance", null).map((t) => t.key)).toEqual(["punches", "sheets", "lateReports", "duty"]);
  });

  it("subTabsFor：有 children 回子分頁（含 href）、沒有回 []、null 回 []", () => {
    expect(subTabsFor("finance", "disbursements")).toEqual([
      expect.objectContaining({ key: "list", label: "放款作業", href: "/admin/disbursements" }),
      expect.objectContaining({ key: "approvals", label: "待簽核", href: "/admin/disbursements/approvals" }),
      expect.objectContaining({ key: "pivot", label: "年度總覽", href: "/admin/disbursements/pivot" }),
    ]);
    expect(subTabsFor("finance", "reports")).toEqual([]);
    expect(subTabsFor("finance", "directory").map((s) => s.key)).toEqual(["clients", "vendors", "companies"]);
    expect(subTabsFor("announce", "knowledge").map((s) => s.key)).toEqual(["docs", "ask"]);
    expect(subTabsFor("finance", "projects")).toEqual([]);
    expect(subTabsFor("finance", null)).toEqual([]);
    expect(subTabsFor("home", undefined)).toEqual([]);
  });

  it("narrow 只有 shifts／essTabs／site／optionLists／advanced 五頁", () => {
    const narrowRoutes = ADMIN_ROUTES.filter((r) => r.narrow).map((r) => r.prefix);
    expect(narrowRoutes).toEqual([
      "/admin/shifts",
      "/admin/module-settings/ess-tabs",
      "/admin/company-space",
      "/admin/option-lists",
      "/admin/settings/advanced",
    ]);
    expect(resolveAdminPath("/admin/shifts").narrow).toBe(true);
    expect(resolveAdminPath("/admin/employees").narrow).toBe(false);
  });
});

describe("角色導覽：ACCOUNTANT_DEFAULT_NAV／roleNavOf／sectionsForRole／tabsForSection({ roleNav })", () => {
  const NAV = ACCOUNTANT_DEFAULT_NAV;

  it("會計預設範圍不含 bonus／payroll／payslips／tax／cash；分區只有 首頁、專案與財務、出勤、薪資與費用、人員、設定（只有選項清單）", () => {
    expect(NAV.sections).toEqual(["home", "finance", "attendance", "payroll", "people", "settings"]);
    const finance = tabsForSection("finance", null, { roleNav: NAV }).map((t) => t.key);
    expect(finance).not.toContain("bonus");
    expect(finance).toEqual(["projects", "receivables", "disbursements", "directory"]);
    const payroll = tabsForSection("payroll", null, { roleNav: NAV }).map((t) => t.key);
    expect(payroll).toEqual(["expenses", "advances"]);
    for (const key of ["payroll", "payslips", "tax", "cash"]) expect(payroll).not.toContain(key);
    expect(tabsForSection("attendance", null, { roleNav: NAV }).map((t) => t.key)).toEqual(["sheets"]);
    expect(tabsForSection("people", { recruitment: true }, { roleNav: NAV }).map((t) => t.key)).toEqual(["employees"]);
    // 設定區只開選項清單（客戶分類的管理權限比照客戶名冊的寫入）；假別、班別、規則參數、進階功能等仍是 HR 專屬
    expect(tabsForSection("settings", null, { roleNav: NAV }).map((t) => t.key)).toEqual(["optionLists"]);
    // 沒列在 tabs 的分區＝該區全部（module 開關照舊）
    expect(tabsForSection("system", null, { roleNav: NAV }).map((t) => t.key)).toEqual(["reports", "audit", "backups", "notifications"]);
    // includeTab 仍強制保留（直開未開放網址時分頁列標「未開放」）
    expect(tabsForSection("payroll", null, { roleNav: NAV, includeTab: "payslips" }).map((t) => t.key)).toEqual(["payslips", "expenses", "advances"]);
  });

  it("sectionsForRole：null → 9 個分區原樣；會計 → 6 個且 href 改成該區第一個可見分頁", () => {
    expect(sectionsForRole(null)).toEqual([...ADMIN_SECTIONS]);
    expect(sectionsForRole(undefined).map((s) => s.key)).toEqual(SECTION_KEYS);
    const acc = sectionsForRole(NAV);
    expect(acc.map((s) => s.key)).toEqual(["home", "finance", "attendance", "payroll", "people", "settings"]);
    expect(acc.map((s) => s.href)).toEqual([
      "/admin",
      "/admin/projects",
      "/admin/attendance-sheets",
      "/admin/expenses",
      "/admin/employees",
      "/admin/option-lists",
    ]);
    // 分區被列了但一個分頁都不剩 → 不列
    expect(sectionsForRole({ sections: ["home", "system"], tabs: { system: ["nope"] } }).map((s) => s.key)).toEqual(["home"]);
  });

  it("獎金分潤 hrOnly：HR（roleNav null）看得到；會計預設範圍不列；租戶自訂成「整個財務分區」也不列", () => {
    expect(ADMIN_TABS.finance.find((t) => t.key === "bonusSheet")).toMatchObject({ hrOnly: true, href: "/admin/bonus-sheet" });
    // hrOnly 的只剩獎金分潤（集團總覽 2026-10-27 移到首頁）
    const hrOnlyKeys = (Object.values(ADMIN_TABS).flat() as Array<{ key: string; hrOnly?: boolean }>).filter((t) => t.hrOnly).map((t) => t.key);
    expect(hrOnlyKeys).toEqual(["bonusSheet"]);

    expect(tabsForSection("finance", null).map((t) => t.key)).toContain("bonusSheet");
    expect(tabsForSection("finance", null, { roleNav: null }).map((t) => t.key)).toContain("bonusSheet");
    expect(tabsForSection("finance", null, { roleNav: NAV }).map((t) => t.key)).not.toContain("bonusSheet");

    // 自訂範圍只列分區、沒列 tabs → 「該區全部分頁」，但 hrOnly 的仍然剔除
    const custom = roleNavOf("accountant", { roles: { accountant: { sections: ["finance"] } } });
    const customFinance = tabsForSection("finance", null, { roleNav: custom }).map((t) => t.key);
    expect(customFinance).toEqual(["projects", "receivables", "disbursements", "bonus", "directory"]);
    // 就算把它明列進 tabs 白名單也不行（hrOnly 優先）
    const listed = roleNavOf("accountant", { roles: { accountant: { sections: ["finance"], tabs: { finance: ["projects", "bonusSheet"] } } } });
    expect(tabsForSection("finance", null, { roleNav: listed }).map((t) => t.key)).toEqual(["projects"]);
    // includeTab（直開網址）仍會把它塞回分頁列，讓 AdminShell 標「未開放」
    expect(tabsForSection("finance", null, { roleNav: NAV, includeTab: "bonusSheet" }).map((t) => t.key)).toContain("bonusSheet");
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

describe("isAdminPathAllowed：直開網址的角色守門（2026-09-23 驗收修正）", () => {
  const NAV = ACCOUNTANT_DEFAULT_NAV;
  const allowed = (pathname: string, roleNav = NAV) => isAdminPathAllowed({ pathname, roleNav });

  it("會計：bonus-runs／payroll／payslips 與其他未開放分區 → false", () => {
    for (const path of [
      "/admin/bonus-runs",
      "/admin/bonus-runs/2026-q1",
      "/admin/payroll",
      "/admin/payslips",
      "/admin/payroll-tax",
      "/admin/festival-bonuses",
      "/admin/overtime-settlements",
      "/admin/approvals",
      "/admin/punch-records",
      "/admin/departments",
      "/admin/announcements",
      "/admin/leave-types",
      // 設定區只開選項清單，其餘（班別、行事曆、規則參數、員工端功能開放、站台、進階功能）仍是 HR 專屬
      "/admin/shifts",
      "/admin/calendar",
      "/admin/module-settings",
      "/admin/module-settings/ess-tabs",
      "/admin/company-space",
      "/admin/settings/advanced",
      "/admin/backups",
      "/admin/reports",
      "/admin/whatever",
    ]) {
      expect(allowed(path), path).toBe(false);
    }
  });

  it("會計：首頁、projects/[id]、disbursements/approvals、employees 與其他開放分頁（含子路徑）→ true", () => {
    for (const path of [
      "/admin",
      "/admin/",
      "/admin?x=1",
      "/admin/projects",
      "/admin/projects/abc-123",
      "/admin/projects/abc-123/application",
      "/admin/projects/receivables",
      "/admin/disbursements",
      "/admin/disbursements/approvals",
      "/admin/disbursements/pivot",
      "/admin/disbursements/9f",
      "/admin/clients",
      "/admin/vendors",
      "/admin/companies",
      // 客戶分類的管理權限比照客戶名冊的寫入：客戶名冊的「管理分類」連結會連到這裡
      "/admin/option-lists",
      "/admin/attendance-sheets",
      "/admin/attendance-sheets/9f",
      "/admin/expenses",
      "/admin/advances",
      "/admin/employees",
      "/admin/employees/zzz",
    ]) {
      expect(allowed(path), path).toBe(true);
    }
  });

  it("獎金分潤（hrOnly）：會計（預設範圍或自訂成整個財務分區）直開網址 → false；HR → true", () => {
    expect(allowed("/admin/bonus-sheet")).toBe(false);
    const wholeFinance = roleNavOf("accountant", { roles: { accountant: { sections: ["finance"] } } });
    expect(allowed("/admin/bonus-sheet", wholeFinance ?? NAV)).toBe(false);
    // 同一個自訂範圍下，財務分區其他分頁照常放行
    expect(allowed("/admin/projects/receivables", wholeFinance ?? NAV)).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-sheet", roleNav: null })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-sheet", roleNav: roleNavOf("hr_admin", null) })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-sheet", roleNav: roleNavOf("platform_admin", {}) })).toBe(true);
  });

  it("hr_admin／platform_admin（roleNav null）→ 一律 true，含隱藏模組與未知路徑", () => {
    expect(isAdminPathAllowed({ pathname: "/admin/bonus-runs", roleNav: roleNavOf("hr_admin", null) })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/payroll", roleNav: roleNavOf("platform_admin", {}) })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/kpi", roleNav: null, modules: {} })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/whatever", roleNav: undefined })).toBe(true);
  });

  it("自訂範圍：分區沒列 tabs＝整區開放（module 開關照舊）；不在分頁清單的子分頁不因前綴放行", () => {
    const nav = roleNavOf("accountant", {
      roles: { accountant: { sections: ["finance", "system"], tabs: { finance: ["projects"] } } },
    });
    expect(isAdminPathAllowed({ pathname: "/admin/projects/abc", roleNav: nav })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/disbursements", roleNav: nav })).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/reports", roleNav: nav })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/audit-logs", roleNav: nav })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/ai", roleNav: nav })).toBe(false);
    expect(isAdminPathAllowed({ pathname: "/admin/ai", roleNav: nav, modules: { ai: true } })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/employees", roleNav: nav })).toBe(false);
    // 租戶自訂範圍沒列 settings 的會計：選項清單也不開（直開網址只看到「未開放」，API 仍是 requireFinance 層）
    expect(isAdminPathAllowed({ pathname: "/admin/option-lists", roleNav: nav })).toBe(false);
    const withSettings = roleNavOf("accountant", { roles: { accountant: { sections: ["settings"], tabs: { settings: ["optionLists"] } } } });
    expect(isAdminPathAllowed({ pathname: "/admin/option-lists", roleNav: withSettings })).toBe(true);
    expect(isAdminPathAllowed({ pathname: "/admin/shifts", roleNav: withSettings })).toBe(false);
  });

  it("首頁老闆看板：會計看不到獎金／快照兩張（目標頁未開放），放款／未收款看得到", () => {
    expect(allowed("/admin/bonus-runs")).toBe(false);
    expect(allowed("/admin/backups")).toBe(false);
    expect(allowed("/admin/disbursements")).toBe(true);
    expect(allowed("/admin/projects/receivables")).toBe(true);
    for (const href of ["/admin/bonus-runs", "/admin/backups", "/admin/approvals", "/admin/company-info"]) {
      expect(isAdminPathAllowed({ pathname: href, roleNav: null }), href).toBe(true);
    }
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

  it("7 種 detail：projects／disbursements list／bonus／sheets／employees／announcements／專案申請單", () => {
    const details = ADMIN_ROUTES.filter((r) => r.detail).map((r) => `${r.prefix}${r.pattern ? "#pattern" : ""}`);
    expect(details).toEqual([
      "/admin/projects",
      "/admin/disbursements",
      "/admin/bonus-runs",
      "/admin/attendance-sheets",
      "/admin/employees",
      "/admin/announcements",
      "/admin/projects#pattern",
    ]);
  });
});

describe("ADMIN_REDIRECTS 與 next.config.ts", () => {
  it("九條轉址：form-records → approvals?status=all、org-chart → departments、onboarding／birthday-gifts → employees、projects/overview／annual／alerts、stamp-duty → projects、group-overview → 首頁 #group-overview", () => {
    expect(ADMIN_REDIRECTS).toEqual([
      { source: "/admin/form-records", destination: "/admin/approvals?status=all" },
      { source: "/admin/org-chart", destination: "/admin/departments" },
      { source: "/admin/onboarding", destination: "/admin/employees" },
      { source: "/admin/birthday-gifts", destination: "/admin/employees" },
      { source: "/admin/projects/overview", destination: "/admin/projects" },
      { source: "/admin/projects/annual", destination: "/admin/projects" },
      { source: "/admin/projects/alerts", destination: "/admin/projects" },
      { source: "/admin/stamp-duty", destination: "/admin/projects" },
      { source: "/admin/group-overview", destination: "/admin#group-overview" },
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
    const skip = new Set<string>(["/admin", ...ADMIN_REDIRECTS.map((r) => r.source)]);
    const missing = pages.filter((path) => !skip.has(path) && resolveAdminPath(path).route.prefix !== path);
    expect(missing).toEqual([]);
  });

  it("路由表裡的每個 prefix 都有頁面（尚未建立的新頁除外）", () => {
    const pages = new Set(staticAdminPages(ADMIN_APP_DIR, "/admin"));
    // 2026-09-23：WP6／WP7／WP8 的四頁（disbursements/approvals、festival-bonuses、
    // overtime-settlements、duty-rosters）已建，從豁免名單移除，讓本案例真的檢查它們。
    const pending = new Set([
      "/admin/settings/advanced",
      "/admin/module-settings/ess-tabs",
    ]);
    const orphan = ADMIN_ROUTES.filter((r) => !r.pattern && !pages.has(r.prefix) && !pending.has(r.prefix)).map((r) => r.prefix);
    expect(orphan).toEqual([]);
  });
});

describe("HR 限定頁（hrOnly）：會計可用範圍的設定與直開被擋的提示（2026-10-11）", () => {
  const HR_ONLY_TABS = (Object.entries(ADMIN_TABS) as Array<[AdminSectionKey, readonly (typeof ADMIN_TABS)[AdminSectionKey][number][]]>).flatMap(
    ([section, tabs]) => tabs.filter((tab) => tab.hrOnly).map((tab) => ({ section, tab })),
  );

  it("configurableTabsForRole：「會計可用範圍」可勾選的分頁排除 hrOnly（獎金分潤），其餘照表、順序不變", () => {
    const finance = configurableTabsForRole("finance").map((t) => t.key);
    expect(finance).not.toContain("groupOverview");
    expect(finance).not.toContain("bonusSheet");
    expect(finance).toEqual(ADMIN_TABS.finance.filter((t) => t.key !== "bonusSheet").map((t) => t.key));
    expect(finance).toEqual(expect.arrayContaining(["projects", "receivables", "disbursements", "bonus", "directory"]));
    // 沒有 hrOnly 分頁的分區：跟 ADMIN_TABS 完全一樣
    for (const section of SECTION_KEYS) {
      const expected = ADMIN_TABS[section].filter((t) => !t.hrOnly).map((t) => t.key);
      expect(configurableTabsForRole(section).map((t) => t.key), section).toEqual(expected);
    }
    // 任何 hrOnly 分頁都不會出現在可勾選清單
    for (const { section, tab } of HR_ONLY_TABS) {
      expect(configurableTabsForRole(section).map((t) => t.key)).not.toContain(tab.key);
    }
  });

  it("nextRoleTabs：勾／取消單一分頁——沒有 tabs 鍵（＝全部）先展開再加減，只算可勾選的分頁，照表順序", () => {
    const configurable = configurableTabsForRole("finance").map((t) => t.key);
    // 原本沒有 tabs 鍵＝該區全部：取消 directory → 其餘全留，且不含 hrOnly 的 bonusSheet
    expect(nextRoleTabs("finance", undefined, "directory", false)).toEqual(configurable.filter((k) => k !== "directory"));
    expect(nextRoleTabs("finance", undefined, "directory", false)).not.toContain("bonusSheet");
    // 已有清單：再勾回來 → 照表順序插回去（不是接在最後）
    expect(nextRoleTabs("finance", ["projects", "bonus"], "receivables", true)).toEqual(["projects", "receivables", "bonus"]);
    // 取消清單裡的一個
    expect(nextRoleTabs("finance", ["projects", "receivables", "bonus"], "receivables", false)).toEqual(["projects", "bonus"]);
    // 重複勾／重複取消是冪等的
    expect(nextRoleTabs("finance", ["projects"], "projects", true)).toEqual(["projects"]);
    expect(nextRoleTabs("finance", ["projects"], "receivables", false)).toEqual(["projects"]);
    // 取消到沒有 → 空陣列（該區沒有任何可見分頁）
    expect(nextRoleTabs("finance", ["projects"], "projects", false)).toEqual([]);
  });

  it("nextRoleTabs：殘留的 hrOnly／不認得的 key 順手丟掉；勾 hrOnly 的 key 不會加進去", () => {
    // 舊版設定頁可能把 groupOverview（已移除的分頁）或 hrOnly 的 bonusSheet 展開進清單
    expect(nextRoleTabs("finance", ["projects", "groupOverview", "bonusSheet", "nope"], "receivables", true)).toEqual(["projects", "receivables"]);
    expect(nextRoleTabs("finance", ["projects", "groupOverview"], "projects", false)).toEqual([]);
    expect(nextRoleTabs("finance", ["projects"], "bonusSheet", true)).toEqual(["projects"]);
    expect(nextRoleTabs("finance", undefined, "bonusSheet", true)).toEqual(configurableTabsForRole("finance").map((t) => t.key));
  });

  it("目前 hrOnly 的是財務分區的獎金分潤（新增 hrOnly 分頁時，下面的路徑與提示測試會自動涵蓋）", () => {
    expect(HR_ONLY_TABS.map(({ section, tab }) => `${section}/${tab.key}`)).toEqual(["finance/bonusSheet"]);
  });

  it("isHrOnlyAdminPath：HR 限定頁（含 query／尾斜線／子路徑）→ true；其他頁、首頁、未知路徑 → false", () => {
    for (const { tab } of HR_ONLY_TABS) {
      expect(isHrOnlyAdminPath(tab.href), tab.href).toBe(true);
      expect(isHrOnlyAdminPath(`${tab.href}/`), tab.href).toBe(true);
      expect(isHrOnlyAdminPath(`${tab.href}?year=2026`), tab.href).toBe(true);
      expect(isHrOnlyAdminPath(`${tab.href}/detail`), tab.href).toBe(true);
    }
    for (const path of ["/admin", "/admin/projects", "/admin/projects/receivables", "/admin/payroll", "/admin/bonus-runs", "/admin/settings/advanced", "/admin/whatever"]) {
      expect(isHrOnlyAdminPath(path), path).toBe(false);
    }
  });

  it("offLimitsCopy：HR 限定頁說「此頁僅限 HR／管理者」，不說「未開放給會計」也不叫人去進階功能開放", () => {
    const copy = offLimitsCopy({ pathname: "/admin/bonus-sheet", roleLabel: "會計" });
    expect(copy.title).toBe("此頁僅限 HR／管理者");
    expect(copy.title).not.toContain("會計");
    expect(copy.body).toContain("HR");
    expect(copy.body).toContain("無法");
    // 角色名稱不影響 HR 限定頁的說法
    expect(offLimitsCopy({ pathname: "/admin/bonus-sheet", roleLabel: "此角色" })).toEqual(copy);
  });

  it("offLimitsCopy：其他被擋的頁維持原本的說法（未開放給{角色}，請 HR 到進階功能調整）", () => {
    for (const path of ["/admin/payroll", "/admin/bonus-runs", "/admin/whatever"]) {
      const copy = offLimitsCopy({ pathname: path, roleLabel: "會計" });
      expect(copy.title, path).toBe("此頁未開放給會計");
      expect(copy.body, path).toBe("這個功能不在會計的後台範圍內；需要的話請 HR 到「設定 → 進階功能」調整可用範圍。");
    }
    expect(offLimitsCopy({ pathname: "/admin/payroll", roleLabel: "此角色" }).title).toBe("此頁未開放給此角色");
  });

  it("會計預設範圍與自訂範圍的分頁清單都不含 hrOnly 的 key（設定頁不會再把它寫進去）", () => {
    const keys = HR_ONLY_TABS.map(({ tab }) => tab.key);
    for (const list of Object.values(ACCOUNTANT_DEFAULT_NAV.tabs)) {
      for (const key of keys) expect(list ?? []).not.toContain(key);
    }
  });
});
