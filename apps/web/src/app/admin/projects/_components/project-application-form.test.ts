import { describe, expect, it } from "vitest";
import {
  defaultCompanyIdOf,
  emptyProjectApplicationDraft,
  projectApplicationAmounts,
  projectApplicationErrors,
  projectApplicationSchedule,
  projectApplicationVisibility,
  createAndOpenProject,
  parentProjectChoices,
  parentProjectPatch,
  selectedCompanyId,
  toAuthorizedCreateProjectBody,
  toCreateProjectBody,
} from "./project-application-form";
import { humanizeProjectExtError } from "../../../../lib/projects-ext-api";

describe("project application form model", () => {
  it("starts with the eight rows printed on the project application", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", ["電機", "空調"]);

    expect(draft.billings).toHaveLength(8);
    expect(draft.billings.map((row) => [row.installmentNo, row.kind, row.milestone, row.percentage])).toEqual([
      [1, "installment", "訂金款", "10"],
      [2, "installment", "初步設計", "10"],
      [3, "installment", "五管核准", "30"],
      [4, "installment", "發包後", "30"],
      [5, "installment", "工程50%", "10"],
      [6, "installment", "施工驗收", "10"],
      [7, "installment", "候選綠建築證書", ""],
      [8, "guild_advance", "技師公會代墊", ""],
    ]);
    expect(draft.openedOn).toBe("2026-10-01");
    expect(Object.keys(draft.engineers)).toEqual(["電機", "空調"]);
  });

  it("derives tax and tax-inclusive total from the editable contract amount", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.contractAmount = "3043645";

    expect(projectApplicationAmounts(draft, 0.05)).toEqual({
      amountUntaxed: 3_043_645,
      taxAmount: 152_182,
      amountTotal: 3_195_827,
    });
  });

  it("normalizes blank optional fields and numeric strings for CreateProjectExtBody", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", ["電機"]);
    Object.assign(draft, {
      name: " 惠特科技總部大樓 ",
      code: " ",
      fiscalYear: "115",
      clientId: "client-id",
      siteAreaM2: " 1200.5 ",
      contractAmount: "3043645",
      otherExpenses: "",
      closingDay: " 每月 5 日 ",
      bonusPool: "",
    });
    draft.designScope = [
      { discipline: " 空調 ", item: " 設計及簽證 ", amount: "130000" },
      { discipline: "", item: "不應送出", amount: "" },
    ];
    draft.engineers.電機 = { vendorId: "", name: " 維安 ", amount: "" };
    draft.billings[0] = { ...draft.billings[0], percentage: "", plannedOn: "", overrideAmount: "", overrideReason: "" };

    const body = toCreateProjectBody(draft);

    expect(body).toMatchObject({
      name: "惠特科技總部大樓",
      code: null,
      fiscalYear: 115,
      clientId: "client-id",
      siteAreaM2: 1200.5,
      contractAmount: 3_043_645,
      otherExpenses: null,
      closingDay: "每月 5 日",
      bonusPool: null,
      designScope: [{ discipline: "空調", item: "設計及簽證", amount: 130_000 }],
      engineers: { 電機: { vendorId: null, name: "維安" } },
    });
    expect(body.billings?.[0]).toMatchObject({
      installmentNo: 1,
      kind: "installment",
      percentage: null,
      plannedOn: null,
      overrideAmount: null,
      overrideReason: null,
    });
  });

  it("creates formal initial subcontracts from the application vendor amounts", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", ["電機", "空調"]);
    draft.name = "惠特科技總部大樓";
    draft.engineers.電機 = { vendorId: "vendor-1", name: "維安工程", amount: "250000" };
    draft.engineers.空調 = { vendorId: "", name: "李廣修", amount: "130000" };

    const body = toCreateProjectBody(draft);

    expect(body.initialSubcontracts).toEqual([
      {
        kind: "subcontract",
        discipline: "電機",
        vendorId: "vendor-1",
        vendorName: "維安工程",
        item: "電機協力技師／發包",
        amount: 250_000,
        sortOrder: 0,
      },
      {
        kind: "subcontract",
        discipline: "空調",
        vendorId: null,
        vendorName: "李廣修",
        item: "空調協力技師／發包",
        amount: 130_000,
        sortOrder: 1,
      },
    ]);
    expect(body.designScope).toEqual([]);
  });

  it("reports invalid percentages and required override reasons before submit", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "案名";
    draft.contractAmount = "100000";
    draft.billings[0] = { ...draft.billings[0], percentage: "101" };
    draft.billings[1] = { ...draft.billings[1], percentage: "-1" };
    draft.billings[2] = { ...draft.billings[2], overrideAmount: "5000", overrideReason: "" };

    expect(projectApplicationErrors(draft)).toEqual(expect.arrayContaining([
      "第 1 期百分比須介於 0 到 100",
      "第 2 期百分比須介於 0 到 100",
      "第 3 期填寫指定金額時必須填理由",
    ]));
  });

  it("does not silently discard a partially filled design-scope row", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "案名";
    draft.designScope = [{ discipline: "", item: "空調設計", amount: "5000" }];

    expect(projectApplicationErrors(draft)).toContain("科別與服務項目第 1 列已填內容或金額，請選擇科別");
  });

  it("mirrors the formal tail-residue schedule and rejects totals over 100%", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "案名";
    draft.contractAmount = "8888888";
    draft.billings = [1, 2, 3, 4, 5].map((installmentNo) => ({
      ...draft.billings[installmentNo - 1],
      installmentNo,
      percentage: "20",
    }));

    const schedule = projectApplicationSchedule(draft);
    expect(schedule.percentageTotal).toBe(100);
    expect(schedule.rows.map((row) => row.effectiveAmount)).toEqual([1_777_778, 1_777_778, 1_777_778, 1_777_778, 1_777_776]);
    expect(schedule.rows[4].residueApplied).toBe(-2);

    draft.billings[0].percentage = "80";
    expect(projectApplicationErrors(draft)).toContain("一般期款百分比合計不可超過 100%（目前 160%）");
  });

  it("strips bonus fields from an accountant payload", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "會計建立的案子";
    draft.shareMode = "fixed_amount";
    draft.bonusPool = "99999";

    const body = toAuthorizedCreateProjectBody(draft, { canFinance: true, canBonus: false });
    expect(body).not.toHaveProperty("shareMode");
    expect(body).not.toHaveProperty("bonusPool");
    expect(projectApplicationVisibility({ canFinance: true, canBonus: false })).toEqual({
      showFinanceFields: true,
      showBonusFields: false,
    });
  });

  it("各角色分潤趴數：預填新專案起始值；老闆送出四鍵，非老闆不送（後端複製起始值）", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", [], { manager: 12, lead: 8, support: 3, member: 1 });
    draft.name = "分潤趴數測試案";
    expect(draft.sharePctByRole).toEqual({ manager: "12", lead: "8", support: "3", member: "1" });
    draft.sharePctByRole.manager = "20";

    const boss = toAuthorizedCreateProjectBody(draft, { canFinance: true, canBonus: true });
    expect(boss.sharePctByRole).toEqual({ manager: 20, lead: 8, support: 3, member: 1 });

    const hr = toAuthorizedCreateProjectBody(draft, { canFinance: true, canBonus: false });
    expect(hr).not.toHaveProperty("sharePctByRole");
  });

  it("各角色分潤趴數：四格全空白＝null；超出 0–100 擋在表單驗證", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "未設定趴數的案子";
    expect(toCreateProjectBody(draft).sharePctByRole).toBeNull();
    draft.sharePctByRole.lead = "150";
    expect(projectApplicationErrors(draft)).toContain("主辦的分潤趴數必須介於 0 與 100 之間");
  });

  it("does not expose contract, billing, or subcontract amounts without finance access", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", ["電機"]);
    draft.name = "一般主管建立的案子";
    draft.contractAmount = "100000";
    draft.engineers.電機 = { vendorId: "vendor-1", name: "維安工程", amount: "50000" };

    const body = toAuthorizedCreateProjectBody(draft, { canFinance: false, canBonus: true });

    expect(body.contractAmount).toBeUndefined();
    expect(body.billings).toBeUndefined();
    expect(body.initialSubcontracts).toBeUndefined();
  });

  it("opens the created project after the atomic create succeeds", async () => {
    const navigated: string[] = [];
    const body = { name: "新案" };
    await createAndOpenProject(
      body,
      async (payload) => ({ id: payload.name === "新案" ? "project-1" : "wrong", code: "AT-115-001" }),
      (href) => navigated.push(href),
    );
    expect(navigated).toEqual(["/admin/projects/project-1"]);
  });
});

describe("承接公司（申請單左上角下拉）", () => {
  const companies = [
    { id: "company-second", isDefault: false },
    { id: "company-default", isDefault: true },
  ];

  it("預設選 isDefault 那間（不是清單第一間）；沒有標預設時退而取第一間；沒有公司回空字串", () => {
    expect(defaultCompanyIdOf(companies)).toBe("company-default");
    expect(defaultCompanyIdOf([{ id: "only-one", isDefault: false }])).toBe("only-one");
    expect(defaultCompanyIdOf([{ id: "only-one", isDefault: true }])).toBe("only-one");
    expect(defaultCompanyIdOf([])).toBe("");
  });

  it("已停用的公司不會被當成預設或第一間：新表單預設只從啟用的公司挑", () => {
    const withInactive = [
      { id: "company-old", isDefault: false, isActive: false },
      { id: "company-second", isDefault: false, isActive: true },
      { id: "company-default", isDefault: true, isActive: true },
    ];
    expect(defaultCompanyIdOf(withInactive)).toBe("company-default");
    // 沒有標預設：跳過排在最前面的停用公司，取第一間啟用的
    expect(defaultCompanyIdOf(withInactive.filter((c) => !c.isDefault))).toBe("company-second");
    expect(defaultCompanyIdOf([{ id: "company-old", isDefault: false, isActive: false }])).toBe("");
    // 草稿沒動過 → 解成啟用的預設公司，不會落到停用的那間
    expect(selectedCompanyId("", withInactive)).toBe("company-default");
  });

  it("編輯既有專案：專案上已存的公司就算已停用也保留，不會悄悄換成預設公司", () => {
    const withInactive = [
      { id: "company-old", isDefault: false, isActive: false },
      { id: "company-default", isDefault: true, isActive: true },
    ];
    expect(selectedCompanyId("company-old", withInactive)).toBe("company-old");
    expect(selectedCompanyId("removed-company", withInactive)).toBe("company-default");
  });

  it("使用者選過（且還在名冊裡）就用選的；沒動過或選的已不在名冊就用預設", () => {
    expect(selectedCompanyId("company-second", companies)).toBe("company-second");
    expect(selectedCompanyId("", companies)).toBe("company-default");
    expect(selectedCompanyId("removed-company", companies)).toBe("company-default");
    expect(selectedCompanyId("", [])).toBe("");
  });

  it("草稿預設沒選；送出內容帶 companyId，沒選就是 null（交給後端補預設公司）", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "案名";
    expect(draft.companyId).toBe("");
    expect(toCreateProjectBody(draft).companyId).toBeNull();

    draft.companyId = "company-second";
    expect(toCreateProjectBody(draft).companyId).toBe("company-second");
  });

  it("元件送出前把下拉實際選到的公司（含預設）寫進草稿，一般權限的 payload 也保留 companyId", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "案名";
    const resolved = { ...draft, companyId: selectedCompanyId(draft.companyId, companies) };

    expect(toAuthorizedCreateProjectBody(resolved, { canFinance: true, canBonus: false }).companyId).toBe("company-default");
    expect(toAuthorizedCreateProjectBody(resolved, { canFinance: false, canBonus: false }).companyId).toBe("company-default");
  });
});

describe("母案是選填（業主 2026-09-30 會議：拿掉「必須先有母案」）", () => {
  it("變更設計／追加／代墊沒選母案也能送出：表單驗證不再要求母案", () => {
    for (const kind of ["change", "addition", "advance"] as const) {
      const draft = emptyProjectApplicationDraft("2026-10-01", []);
      draft.name = "先開案的案子";
      draft.kind = kind;
      draft.parentProjectId = "";
      expect(projectApplicationErrors(draft), kind).toEqual([]);
      const body = toCreateProjectBody(draft);
      expect(body.kind).toBe(kind);
      expect(body.parentProjectId).toBeNull();
    }
  });

  it("有選母案就帶母案；主案一律不帶（就算草稿裡殘留著先前選的母案）", () => {
    const draft = emptyProjectApplicationDraft("2026-10-01", []);
    draft.name = "追加案";
    draft.kind = "addition";
    draft.parentProjectId = "main-1";
    expect(toCreateProjectBody(draft).parentProjectId).toBe("main-1");

    draft.kind = "main";
    expect(toCreateProjectBody(draft).parentProjectId).toBeNull();
  });

  it("parentProjectChoices：只列主案、排除自己；kind 缺值當主案；已封存的標註", () => {
    const projects = [
      { id: "main-1", code: "AT-115-001", name: "甲案", kind: "main" },
      { id: "main-2", code: "AT-115-002", name: "乙案", kind: null, archivedAt: "2026-09-01T00:00:00Z" },
      { id: "main-3", code: null, name: "沒編號的主案" },
      { id: "add-1", code: "AT-115-001-1", name: "加做", kind: "addition" },
      { id: "chg-1", code: "AT-115-001-2", name: "變更", kind: "change" },
      { id: "adv-1", code: "AT-115-003", name: "代墊", kind: "advance" },
    ];

    expect(parentProjectChoices(projects, "main-1", null)).toEqual([
      { id: "main-2", label: "AT-115-002　乙案（已封存）" },
      { id: "main-3", label: "沒編號的主案" },
    ]);
    // 子案掛母案：自己是追加案，不在選項裡；主案甲可選
    expect(parentProjectChoices(projects, "add-1", "main-1").map((c) => c.id)).toEqual(["main-1", "main-2", "main-3"]);
    expect(parentProjectChoices([], "add-1", null)).toEqual([]);
  });

  it("parentProjectChoices：目前的母案不在清單裡（例如查不到）也保留一個選項，不悄悄顯示成未指定", () => {
    const projects = [{ id: "main-1", code: "AT-115-001", name: "甲案", kind: "main" }];
    const choices = parentProjectChoices(projects, "add-1", "gone-main");
    expect(choices[0]).toEqual({ id: "gone-main", label: "（目前的母案，不在清單內）" });
    expect(choices.map((c) => c.id)).toEqual(["gone-main", "main-1"]);
  });

  it("parentProjectPatch：存申請單時母案只在「改了」才送——沒改不送、補上送 id、清空送 null、主案永不送", () => {
    // 沒改（有母案、表單還是它；沒母案、表單還是空）→ 不送，免得悄悄蓋掉別人剛改的母案
    expect(parentProjectPatch({ kind: "addition", parentProjectId: "main-1" }, "main-1")).toEqual({});
    expect(parentProjectPatch({ kind: "advance", parentProjectId: null }, "")).toEqual({});
    // 事後補母案
    expect(parentProjectPatch({ kind: "advance", parentProjectId: null }, "main-1")).toEqual({ parentProjectId: "main-1" });
    // 換母案
    expect(parentProjectPatch({ kind: "change", parentProjectId: "main-1" }, "main-2")).toEqual({ parentProjectId: "main-2" });
    // 母案可清空：表單選回「未指定」→ 送 null
    expect(parentProjectPatch({ kind: "addition", parentProjectId: "main-1" }, "")).toEqual({ parentProjectId: null });
    // 主案不能掛母案：就算表單值怪怪的也不送
    expect(parentProjectPatch({ kind: "main", parentProjectId: null }, "main-1")).toEqual({});
    expect(parentProjectPatch({ kind: "main", parentProjectId: null }, "")).toEqual({});
  });

  it("錯誤訊息：has_child_projects（底下還有子案的主案不能改案型）有專屬說明", () => {
    expect(humanizeProjectExtError(new Error("[409] has_child_projects"), "x")).toContain("底下還有追加／變更／代墊案");
  });

  it("錯誤訊息：invalid_parent 說明三種不合法（非主案／自己／主案掛母案）；不再有 parent_required 的專屬訊息", () => {
    expect(humanizeProjectExtError(new Error("[400] invalid_parent"), "x")).toContain("必須是同租戶的主案");
    expect(humanizeProjectExtError(new Error("[400] parent_required"), "x")).toBe("[400] parent_required");
  });
});
