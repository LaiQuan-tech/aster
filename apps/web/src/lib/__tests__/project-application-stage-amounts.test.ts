/**
 * 付款階段「金額為主、% 由金額算出」的純函式與存檔計畫測試。假資料，與任何真實客戶、金額無關。
 */
import { describe, expect, it } from "vitest";
import { applicationSheetDraftOf, applicationStageRows, stageRowKey, type StageEdit } from "../project-application-sheet";
import { applicationSheetPlan, stageContractTotal, type SheetSaveContext } from "../project-application-sheet-save";
import {
  amountFromPct,
  applyStageAmountEdit,
  applyStagePctEdit,
  formatStagePct,
  pctFromAmount,
  releaseTypedPercentages,
  stageAmountDisplay,
  stagePctDisplay,
  stageScheduleSummary,
} from "../project-application-stage-amounts";
import type { BillingExt, ProjectDetail, ProjectMoney } from "../projects-ext-api";

function bill(over: Partial<BillingExt>): BillingExt {
  return {
    id: "b1", installmentNo: 1, percentage: 30, milestone: "簽約款", plannedOn: null, calculatedAmount: 30000, residueApplied: 0,
    overrideAmount: null, overrideReason: null, billedOn: null, billedAmount: null, note: null, effectiveAmount: 30000,
    kind: "installment", invoiceNo: null, invoicedOn: null, receivedOn: null, receivedAmount: null, ...over,
  };
}

const twoStages = [
  bill({ id: "b1", installmentNo: 1, percentage: 30, calculatedAmount: 30000, effectiveAmount: 30000 }),
  bill({ id: "b2", installmentNo: 2, percentage: 70, milestone: "完工款", calculatedAmount: 70000, effectiveAmount: 70000, note: "驗收後 30 天" }),
];
const rows = applicationStageRows(twoStages);
const r1 = rows[0];

describe("% 顯示與換算", () => {
  it("小數 2 位、尾數 0 省略", () => {
    expect(formatStagePct(5)).toBe("5");
    expect(formatStagePct(14.285714)).toBe("14.29");
    expect(formatStagePct(12.5)).toBe("12.5");
    expect(formatStagePct(null)).toBe("");
  });

  it("輸入金額算 %：71,429 ÷ 1,428,571 → 5%；200,000 → 14%", () => {
    expect(stagePctDisplay(r1, applyStageAmountEdit(undefined, "71429"), 1428571)).toBe("5");
    expect(stagePctDisplay(r1, applyStageAmountEdit(undefined, "204082"), 1428571)).toBe("14.29");
  });

  it("存檔用 %：取最少小數位，後端 round(總額 × %) 剛好算回輸入的金額", () => {
    for (const [amount, total] of [[71429, 1428571], [200000, 1428571], [333333, 1000000], [1, 99999999], [12345678, 87654321]]) {
      const p = pctFromAmount(amount, total);
      expect(p).not.toBeNull();
      expect(amountFromPct(p as number, total)).toBe(amount);
    }
    expect(pctFromAmount(50000, 100000)).toBe(50);
    // 三期各三分之一：% 合計（取到 3 位）剛好 100。
    const thirds = [333333, 333333, 333334].map((a) => pctFromAmount(a, 1000000) as number);
    expect(Math.round(thirds.reduce((x, y) => x + y, 0) * 1000) / 1000).toBe(100);
    const odd = [204082, 612245, 612244].map((a) => pctFromAmount(a, 1428571) as number);
    expect(Math.round(odd.reduce((x, y) => x + y, 0) * 1000) / 1000).toBe(100);
    expect(pctFromAmount(100, null)).toBeNull();
  });
});

describe("改金額／改 %／改未稅", () => {
  it("改金額：記下金額，% 改由金額算出", () => {
    const e = applyStageAmountEdit({ percentage: "40", amount: "40000" }, "45000");
    expect(e).toEqual({ amount: "45000" });
    expect(stageAmountDisplay(r1, e)).toBe("45000");
    expect(stagePctDisplay(r1, e, 100000)).toBe("45");
  });

  it("改 %：反算金額（以金額為準）", () => {
    const e = applyStagePctEdit(r1, undefined, "12.5", 1428571);
    expect(e).toEqual({ percentage: "12.5", amount: "178571" });
    expect(stagePctDisplay(r1, e, 1428571)).toBe("12.5");
    expect(applyStagePctEdit(r1, undefined, "", 100000)).toEqual({ percentage: "", amount: "" });
    // 只有報價單（沒有合約總額）：填 % 不連帶寫金額，不會變成人工指定。
    expect(applyStagePctEdit(r1, undefined, "40", null)).toEqual({ percentage: "40" });
  });

  it("改未稅重算 %：金額不動", () => {
    const edits = { b1: applyStagePctEdit(r1, undefined, "40", 100000) };
    const released = releaseTypedPercentages(edits);
    expect(released.b1).toEqual({ amount: "40000" });
    expect(stagePctDisplay(r1, released.b1, 200000)).toBe("20");
    // 沒動過的列：照原金額 ÷ 新總額。
    expect(stagePctDisplay(rows[1], undefined, 200000)).toBe("35");
  });

  it("已請款的列金額凍結：顯示原金額，改 % 不反算", () => {
    const billed = applicationStageRows([bill({ ...twoStages[0], billedOn: "2026-10-20", billedAmount: 30000 })])[0];
    expect(stageAmountDisplay(billed, { amount: "1" })).toBe("30000");
    expect(applyStagePctEdit(billed, undefined, "50", 100000)).toEqual({ percentage: "50" });
  });

  it("合計提示：金額合計與未稅不同（尾差）", () => {
    const sum = stageScheduleSummary(rows, { b1: { amount: "20000" } }, stageRowKey, 100000);
    expect(sum).toEqual({ amountTotal: 90000, pctTotal: 90, diff: 10000 });
    expect(stageScheduleSummary(rows, {}, stageRowKey, 100000).diff).toBe(0);
  });
});

describe("存檔計畫：金額為主不要理由", () => {
  const project = { id: "p1", engineers: {}, designScope: [], client: null } as unknown as ProjectDetail;
  const money = { amountUntaxed: 100000, amountSource: "contract", vatRate: 0.05 } as ProjectMoney;
  const ctxOf = (billings: BillingExt[], m: ProjectMoney | null = money) =>
    ({ project, canFinance: true, disciplines: [], client: null, money: m, contracts: [], billings, subcontracts: [], vendors: [] }) as SheetSaveContext;
  const draftOf = (stageEdits: Record<string, StageEdit>, over: Record<string, unknown> = {}) => ({ ...applicationSheetDraftOf(project, []), stageEdits, ...over });

  it("合約總額：有合約才算；只有報價單＝null", () => {
    expect(stageContractTotal(money, [], { amountUntaxed: null, orderDocType: "" } as never)).toBe(100000);
    expect(stageContractTotal(money, [], { amountUntaxed: "1,428,571", orderDocType: "" } as never)).toBe(1428571);
    expect(stageContractTotal({ ...money, amountSource: "quotation" }, [], { amountUntaxed: null, orderDocType: "" } as never)).toBeNull();
  });

  it("輸入金額 → 送 %（不送人工指定、不要理由）", () => {
    const plan = applicationSheetPlan(ctxOf(twoStages), draftOf({ b1: { amount: "41,000" }, b2: { amount: "59000" } }));
    expect(plan.errors).toEqual([]);
    expect(plan.stages.needsReason).toEqual([]);
    expect(plan.stages.installments?.[0]).toMatchObject({ id: "b1", percentage: 41, overrideAmount: null, overrideReason: null });
    expect(plan.stages.installments?.[1]).toMatchObject({ id: "b2", percentage: 59 });
    expect(plan.warnings).toEqual([]);
  });

  it("既有人工指定的列改金額 → 換成 % 並取消人工指定", () => {
    const withOverride = [bill({ ...twoStages[0], overrideAmount: 33333, overrideReason: "談定", effectiveAmount: 33333 }), twoStages[1]];
    const plan = applicationSheetPlan(ctxOf(withOverride), draftOf({ b1: { amount: "30000" } }));
    expect(plan.errors).toEqual([]);
    expect(plan.stages.installments?.[0]).toMatchObject({ percentage: 30, overrideAmount: null, overrideReason: null });
  });

  it("改未稅：金額不動、各列 % 依新總額重送", () => {
    const plan = applicationSheetPlan(ctxOf(twoStages), draftOf({}, { amountUntaxed: "200000" }));
    expect(plan.stages.installments?.map((i) => i.percentage)).toEqual([15, 35]);
  });

  it("合計不等於未稅 → 提示差額會加到最後一期", () => {
    const plan = applicationSheetPlan(ctxOf(twoStages), draftOf({ b1: { amount: "20000" } }));
    expect(plan.warnings.join()).toMatch(/合計 90,000（90%）.*差 10,000.*最後一期/);
  });

  it("金額大於未稅擋存", () => {
    const plan = applicationSheetPlan(ctxOf(twoStages), draftOf({ b1: { amount: "100001" } }));
    expect(plan.errors[0]).toMatchObject({ field: "stage:b1:amount" });
  });

  it("只有報價單：只填 % 照送 %、不要理由", () => {
    const plan = applicationSheetPlan(ctxOf(twoStages, { ...money, amountSource: "quotation" }), draftOf({ b1: { percentage: "40" } }));
    expect(plan.errors).toEqual([]);
    expect(plan.stages.installments?.[0]).toMatchObject({ percentage: 40, overrideAmount: null });
  });

  it("沒有合約（只有報價單）：改金額仍是人工指定、要理由", () => {
    const plan = applicationSheetPlan(ctxOf(twoStages, { ...money, amountSource: "quotation" }), draftOf({ b1: { amount: "41000" } }));
    expect(plan.stages.needsReason).toEqual([{ key: "b1", label: "第 1 列" }]);
  });

  it("備註：接期別 note，改了才送", () => {
    expect(rows[1].note).toBe("驗收後 30 天");
    const plan = applicationSheetPlan(ctxOf(twoStages), draftOf({ b2: { note: " 驗收後 45 天 " } }));
    expect(plan.stages.installments?.[1]).toMatchObject({ id: "b2", note: "驗收後 45 天", percentage: 70 });
    expect(applicationSheetPlan(ctxOf(twoStages), draftOf({ b2: { note: "驗收後 30 天" } })).stages.installments).toBeNull();
  });
});
