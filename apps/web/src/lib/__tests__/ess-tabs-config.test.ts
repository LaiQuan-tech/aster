import { describe, it, expect } from "vitest";
import { ALWAYS_VISIBLE_TAB_KEYS, EMPLOYMENT_TYPES, ESS_TABS, INTERN_DEFAULT_ESS_TABS } from "../ess-tabs";
import {
  configurableEssTabs,
  defaultEssTabsConfig,
  defaultEssTabsFor,
  hydrateEssTabsConfig,
  sortedByEssTabs,
  toggleEssTab,
} from "../ess-tabs-config";

const ALL_KEYS = ESS_TABS.map((t) => t.key);

describe("defaultEssTabsFor / defaultEssTabsConfig", () => {
  it("intern 預設只開後端預設的那幾個；其餘三種身分全開", () => {
    expect(defaultEssTabsFor("intern")).toEqual([...INTERN_DEFAULT_ESS_TABS]);
    for (const type of ["regular", "parttime", "contract"] as const) {
      expect(defaultEssTabsFor(type)).toEqual(ALL_KEYS);
    }
  });

  it("預設 config 剛好涵蓋四種身分，且每次回傳新陣列（不共用參照）", () => {
    const cfg = defaultEssTabsConfig();
    expect(Object.keys(cfg).sort()).toEqual([...EMPLOYMENT_TYPES].sort());
    expect(cfg.intern).not.toBe(INTERN_DEFAULT_ESS_TABS);
    expect(defaultEssTabsConfig().regular).not.toBe(cfg.regular);
  });
});

describe("hydrateEssTabsConfig", () => {
  it("null／undefined／字串／數字／陣列（不是物件）都退回預設", () => {
    const dflt = defaultEssTabsConfig();
    for (const raw of [null, undefined, "x", 3, [], ["home"]]) {
      expect(hydrateEssTabsConfig(raw)).toEqual(dflt);
    }
  });

  it("有效的清單原樣保留（含順序、含空陣列），缺的身分類別補預設", () => {
    const cfg = hydrateEssTabsConfig({ intern: ["mydata", "home"], regular: [] });
    expect(cfg.intern).toEqual(["mydata", "home"]);
    expect(cfg.regular).toEqual([]);
    expect(cfg.parttime).toEqual(ALL_KEYS);
    expect(cfg.contract).toEqual(ALL_KEYS);
  });

  it("清單裡混到非字串、或不是陣列的身分類別，只有該類別退回預設", () => {
    const cfg = hydrateEssTabsConfig({ regular: ["home", 1], contract: "home", intern: ["schedule"] });
    expect(cfg.regular).toEqual(ALL_KEYS);
    expect(cfg.contract).toEqual(ALL_KEYS);
    expect(cfg.intern).toEqual(["schedule"]);
  });

  it("不共用輸入陣列的參照（之後 toggle 不會改到後端回傳的物件）", () => {
    const list = ["home", "schedule"];
    const cfg = hydrateEssTabsConfig({ intern: list });
    expect(cfg.intern).toEqual(list);
    expect(cfg.intern).not.toBe(list);
  });
});

describe("sortedByEssTabs / configurableEssTabs", () => {
  it("照 ESS_TABS 順序重排；未知 key 丟掉、重複只留一個", () => {
    expect(sortedByEssTabs(["mydata", "home", "nope", "schedule", "home"])).toEqual(["home", "schedule", "mydata"]);
    expect(sortedByEssTabs([])).toEqual([]);
  });

  it("可勾選的 tab 排除永遠可見的 home／announcements，順序照 ESS_TABS", () => {
    const keys = configurableEssTabs().map((t) => t.key);
    for (const always of ALWAYS_VISIBLE_TAB_KEYS) expect(keys).not.toContain(always);
    expect(keys).toEqual(ALL_KEYS.filter((k) => !ALWAYS_VISIBLE_TAB_KEYS.has(k)));
    expect(keys.length).toBe(ALL_KEYS.length - ALWAYS_VISIBLE_TAB_KEYS.size);
  });
});

describe("toggleEssTab", () => {
  it("新增：插進 ESS_TABS 的位置而不是尾巴；不改輸入、其他身分類別沿用同一參照", () => {
    const cfg = hydrateEssTabsConfig({ intern: ["home", "mydata"] });
    const next = toggleEssTab(cfg, "intern", "schedule");
    expect(next.intern).toEqual(["home", "schedule", "mydata"]);
    expect(cfg.intern).toEqual(["home", "mydata"]);
    expect(next).not.toBe(cfg);
    expect(next.regular).toBe(cfg.regular);
  });

  it("移除：已勾的再切一次就拿掉", () => {
    const cfg = hydrateEssTabsConfig({ intern: ["home", "schedule", "mydata"] });
    expect(toggleEssTab(cfg, "intern", "schedule").intern).toEqual(["home", "mydata"]);
  });

  it("切換時順便把不在 ESS_TABS 的 key 清掉", () => {
    const cfg = hydrateEssTabsConfig({ regular: ["ghost", "home"] });
    expect(toggleEssTab(cfg, "regular", "payslips").regular).toEqual(["home", "payslips"]);
  });

  it("永遠可見的 home／announcements 不可切換：原物件原樣回傳", () => {
    const cfg = defaultEssTabsConfig();
    for (const key of ALWAYS_VISIBLE_TAB_KEYS) {
      expect(toggleEssTab(cfg, "intern", key)).toBe(cfg);
      expect(toggleEssTab(cfg, "regular", key)).toBe(cfg);
    }
  });
});
