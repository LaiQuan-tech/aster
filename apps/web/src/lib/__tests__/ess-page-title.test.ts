import { describe, it, expect } from "vitest";
import { resolveEssHeaderTitle } from "../ess-page-title";
import { KIND_LABEL } from "../request-forms";
import { routeForPath } from "../ess-tabs";

const APP = "測試租戶 數位化系統";

function title(pathname: string, override: { path: string; title: string } | null = null) {
  return resolveEssHeaderTitle({ pathname, override, routeTitle: routeForPath(pathname).title, appName: APP });
}

describe("resolveEssHeaderTitle（頂部列標題，2026-10-12）", () => {
  it("沒有覆寫：照路由表；首頁／未知路徑顯示 appName（isAppName）", () => {
    expect(title("/ess/requests")).toEqual({ title: "請假申請", isAppName: false });
    expect(title("/ess/punches")).toEqual({ title: "打卡紀錄", isAppName: false });
    expect(title("/ess")).toEqual({ title: APP, isAppName: true });
    expect(title("/ess/whatever")).toEqual({ title: APP, isAppName: true });
  });

  it("/ess/requests 依種類覆寫成「XX申請」（KIND_LABEL 的實際值）", () => {
    const kinds = ["leave", "fix_punch", "ot", "wfh", "business_trip", "petty_cash"] as const;
    for (const kind of kinds) {
      const t = `${KIND_LABEL[kind]}申請`;
      expect(title("/ess/requests", { path: "/ess/requests", title: t })).toEqual({ title: t, isAppName: false });
    }
    expect(title("/ess/requests", { path: "/ess/requests", title: `${KIND_LABEL.fix_punch}申請` }).title).toBe("補卡申請");
    expect(title("/ess/requests", { path: "/ess/requests", title: `${KIND_LABEL.ot}申請` }).title).toBe("加班申請");
  });

  it("覆寫綁路徑：別頁留下的覆寫不會顯示在新頁（換頁那一瞬間）", () => {
    const stale = { path: "/ess/requests", title: "補卡申請" };
    expect(title("/ess/punches", stale)).toEqual({ title: "打卡紀錄", isAppName: false });
    expect(title("/ess", stale)).toEqual({ title: APP, isAppName: true });
  });

  it("覆寫是空白 → 退回路由表標題", () => {
    expect(title("/ess/requests", { path: "/ess/requests", title: "   " }).title).toBe("請假申請");
  });

  it("首頁也能被覆寫（之後若有頁面需要）：顯示覆寫、不算 appName", () => {
    expect(title("/ess", { path: "/ess", title: "打卡" })).toEqual({ title: "打卡", isAppName: false });
  });
});
