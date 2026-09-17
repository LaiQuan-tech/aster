import { describe, it, expect } from "vitest";
import {
  ALWAYS_VISIBLE_TAB_KEYS,
  BOTTOM_TAB_KEYS,
  ESS_ROUTES,
  ESS_TABS,
  INTERN_DEFAULT_ESS_TABS,
  MORE_GROUPS,
  bottomTabs,
  isBottomRootPath,
  moreGroups,
  parentPathFor,
  routeForPath,
  visibleTabs,
} from "../ess-tabs";

const TABS = [
  { key: "home", label: "今日打卡" },
  { key: "schedule", label: "個人班表" },
  { key: "requests", label: "我的申請" },
  { key: "approvals", label: "待我簽核" },
  { key: "payslips", label: "我的薪資單" },
  { key: "mydata", label: "我的資料" },
] as const;

describe("visibleTabs（ESS 分頁限縮純函式）", () => {
  it("allowedKeys 為 null／undefined → 全部可見，順序不變", () => {
    expect(visibleTabs(TABS, null).map((t) => t.key)).toEqual(TABS.map((t) => t.key));
    expect(visibleTabs(TABS, undefined).map((t) => t.key)).toEqual(TABS.map((t) => t.key));
  });

  it("有清單 → 只留清單內的分頁，順序照原本分頁順序而非清單順序", () => {
    expect(visibleTabs(TABS, ["mydata", "requests", "schedule"]).map((t) => t.key)).toEqual([
      "home",
      "schedule",
      "requests",
      "mydata",
    ]);
  });

  it("home 永遠保留（即使清單沒列），空清單只剩 home", () => {
    expect(visibleTabs(TABS, ["payslips"]).map((t) => t.key)).toEqual(["home", "payslips"]);
    expect(visibleTabs(TABS, []).map((t) => t.key)).toEqual(["home"]);
  });

  it("清單裡不認得的 key 忽略，不炸", () => {
    expect(visibleTabs(TABS, ["nope", "approvals"]).map((t) => t.key)).toEqual(["home", "approvals"]);
  });

  it("回傳新陣列，不動原本的 tabs", () => {
    const out = visibleTabs(TABS, null);
    expect(out).not.toBe(TABS);
    expect(TABS).toHaveLength(6);
  });

  it("announcements 永遠可見：空清單過 ESS_TABS 只剩 home＋announcements", () => {
    expect(ALWAYS_VISIBLE_TAB_KEYS.has("home")).toBe(true);
    expect(ALWAYS_VISIBLE_TAB_KEYS.has("announcements")).toBe(true);
    expect(visibleTabs(ESS_TABS, []).map((t) => t.key)).toEqual(["home", "announcements"]);
    // intern 預設清單沒列 announcements，一樣看得到
    expect(visibleTabs(ESS_TABS, INTERN_DEFAULT_ESS_TABS).map((t) => t.key)).toContain("announcements");
  });
});

describe("ESS_TABS（key 順序與新分頁）", () => {
  it("舊 key 順序不變、announcements 追加在最後、請假／打卡短標", () => {
    const keys = ESS_TABS.map((t) => t.key);
    expect(keys.slice(0, 17)).toEqual([
      "home",
      "schedule",
      "punches",
      "sheet",
      "balances",
      "requests",
      "approvals",
      "projects",
      "bonus",
      "payslips",
      "expenses",
      "kpi",
      "jobs",
      "ai",
      "company",
      "notifications",
      "mydata",
    ]);
    expect(keys[keys.length - 1]).toBe("announcements");
    expect(ESS_TABS.find((t) => t.key === "announcements")?.href).toBe("/ess/announcements");
    expect(ESS_TABS.find((t) => t.key === "requests")).toMatchObject({ label: "請假申請", short: "請假" });
    expect(ESS_TABS.find((t) => t.key === "home")?.short).toBe("打卡");
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("bottomTabs（底部分頁列）", () => {
  it("一般員工（非主管、無待簽）：打卡・請假・通知・更多", () => {
    expect(bottomTabs({ essTabs: null, isManager: false, pendingApprovals: 0 })).toEqual([
      { key: "home", label: "打卡", href: "/ess" },
      { key: "requests", label: "請假", href: "/ess/requests" },
      { key: "notifications", label: "通知", href: "/ess/notifications" },
      { key: "more", label: "更多", href: "/ess/more" },
    ]);
  });

  it("主管：多「簽核」，位置在請假與通知之間", () => {
    expect(bottomTabs({ essTabs: null, isManager: true, pendingApprovals: 0 }).map((t) => t.key)).toEqual([
      "home",
      "requests",
      "approvals",
      "notifications",
      "more",
    ]);
  });

  it("非主管但有待簽單（被指定的簽核者）：也顯示「簽核」", () => {
    expect(bottomTabs({ essTabs: null, isManager: false, pendingApprovals: 2 }).map((t) => t.key)).toEqual([
      "home",
      "requests",
      "approvals",
      "notifications",
      "more",
    ]);
  });

  it("essTabs 限縮：後台取消 requests → 底列沒有請假；主管被限縮 approvals 也不顯示；home／更多永遠在", () => {
    expect(bottomTabs({ essTabs: ["notifications"], isManager: true, pendingApprovals: 3 }).map((t) => t.key)).toEqual([
      "home",
      "notifications",
      "more",
    ]);
    expect(bottomTabs({ essTabs: [], isManager: false, pendingApprovals: 0 }).map((t) => t.key)).toEqual([
      "home",
      "more",
    ]);
  });

  it("BOTTOM_TAB_KEYS 固定四個 ESS key，順序即顯示順序", () => {
    expect(BOTTOM_TAB_KEYS).toEqual(["home", "requests", "approvals", "notifications"]);
  });
});

describe("moreGroups（更多頁分組）", () => {
  it("不限縮：四組齊全，且不含任何底列 key", () => {
    const groups = moreGroups(null);
    expect(groups.map((g) => g.title)).toEqual(["差勤", "薪資與費用", "公司", "個人"]);
    const keys = groups.flatMap((g) => g.items.map((i) => i.key));
    for (const bottom of BOTTOM_TAB_KEYS) expect(keys).not.toContain(bottom);
    expect(keys).toContain("announcements");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("分組內順序照 MORE_GROUPS 定義，項目是完整的 EssTab（含 href／label）", () => {
    const groups = moreGroups(null);
    expect(groups[0]?.items.map((i) => i.key)).toEqual(["punches", "schedule", "sheet", "balances"]);
    expect(groups[0]?.items[0]).toMatchObject({ key: "punches", label: "打卡紀錄", href: "/ess/punches" });
    expect(MORE_GROUPS.flatMap((g) => g.keys)).not.toContain("home");
  });

  it("essTabs 限縮：空組整組消失、公告永遠在公司組", () => {
    // intern 預設：punches／schedule／mydata 可見；薪資組整組沒有
    const groups = moreGroups(INTERN_DEFAULT_ESS_TABS);
    expect(groups.map((g) => g.title)).toEqual(["差勤", "公司", "個人"]);
    expect(groups.find((g) => g.title === "差勤")?.items.map((i) => i.key)).toEqual(["punches", "schedule"]);
    expect(groups.find((g) => g.title === "公司")?.items.map((i) => i.key)).toEqual(["announcements"]);
    expect(groups.find((g) => g.title === "個人")?.items.map((i) => i.key)).toEqual(["mydata"]);
    // 什麼都不開：只剩公告
    expect(moreGroups([])).toEqual([
      { title: "公司", items: [{ key: "announcements", label: "公告", short: "公告", href: "/ess/announcements" }] },
    ]);
  });
});

describe("routeForPath（pathname → 路由）", () => {
  it("首頁只在精準 /ess 相符；動態子路徑走最長前綴", () => {
    expect(routeForPath("/ess")).toMatchObject({ key: "home", prefix: "/ess", title: "" });
    expect(routeForPath("/ess/")).toMatchObject({ key: "home" });
    expect(routeForPath("/ess/projects/abc-123")).toMatchObject({ key: "projects", prefix: "/ess/projects" });
    expect(routeForPath("/ess/attendance-sheet/9f")).toMatchObject({ key: "sheet", prefix: "/ess/attendance-sheet" });
    expect(routeForPath("/ess/requests?kind=leave")).toMatchObject({ key: "requests", title: "請假申請" });
  });

  it("wide 只有月表與班表；其餘沒有 wide", () => {
    expect(routeForPath("/ess/attendance-sheet").wide).toBe(true);
    expect(routeForPath("/ess/attendance-sheet/9f").wide).toBe(true);
    expect(routeForPath("/ess/schedule").wide).toBe(true);
    expect(routeForPath("/ess/requests").wide).toBeUndefined();
    expect(routeForPath("/ess").wide).toBeUndefined();
    expect(ESS_ROUTES.filter((r) => r.wide).map((r) => r.key)).toEqual(["schedule", "sheet"]);
  });

  it("更多與公告有路由：更多 key 為 null（不 gate）、公告 key 為 announcements", () => {
    expect(routeForPath("/ess/more")).toEqual({ prefix: "/ess/more", key: null, title: "更多" });
    expect(routeForPath("/ess/announcements")).toMatchObject({ key: "announcements", title: "公告" });
  });

  it("未知路徑 → { prefix: '/ess', key: null, title: '' }", () => {
    expect(routeForPath("/ess/whatever")).toEqual({ prefix: "/ess", key: null, title: "" });
    expect(routeForPath("/login")).toEqual({ prefix: "/ess", key: null, title: "" });
  });
});

describe("parentPathFor（返回鍵目標）與 isBottomRootPath", () => {
  it("動態子頁回自己的列表", () => {
    expect(parentPathFor("/ess/projects/abc")).toBe("/ess/projects");
    expect(parentPathFor("/ess/attendance-sheet/9f")).toBe("/ess/attendance-sheet");
  });

  it("其他頁一律回更多（含列表根頁與未知路徑）", () => {
    expect(parentPathFor("/ess/projects")).toBe("/ess/more");
    expect(parentPathFor("/ess/punches")).toBe("/ess/more");
    expect(parentPathFor("/ess/whatever")).toBe("/ess/more");
    expect(parentPathFor("/ess")).toBe("/ess/more");
  });

  it("底列根路徑不顯示返回鍵", () => {
    for (const p of ["/ess", "/ess/requests", "/ess/approvals", "/ess/notifications", "/ess/more"]) {
      expect(isBottomRootPath(p)).toBe(true);
    }
    expect(isBottomRootPath("/ess/requests/")).toBe(true);
    expect(isBottomRootPath("/ess/punches")).toBe(false);
    expect(isBottomRootPath("/ess/projects/abc")).toBe(false);
  });
});
