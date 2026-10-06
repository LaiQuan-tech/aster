import { describe, expect, it } from "vitest";
import {
  defaultCompanyIdOf,
  emptyProjectApplicationDraft,
  projectApplicationAmounts,
  projectApplicationErrors,
  projectApplicationSchedule,
  projectApplicationVisibility,
  createAndOpenProject,
  selectedCompanyId,
  toAuthorizedCreateProjectBody,
  toCreateProjectBody,
} from "./project-application-form";

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
