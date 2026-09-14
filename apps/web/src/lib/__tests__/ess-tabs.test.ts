import { describe, it, expect } from "vitest";
import { visibleTabs } from "../ess-tabs";

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
});
