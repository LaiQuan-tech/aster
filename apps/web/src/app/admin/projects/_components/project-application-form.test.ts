import { describe, expect, it } from "vitest";
import {
  emptyProjectApplicationDraft,
  projectApplicationAmounts,
  projectApplicationErrors,
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
    draft.engineers.電機 = { vendorId: "", name: " 維安 " };
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
});
