/**
 * 付款階段金額依 % 預填的純函式測試。假資料，與任何真實客戶、金額無關。
 */
import { describe, expect, it } from "vitest";
import { applicationSheetDraftOf, applicationStageRows, stageRowKey, type StageEdit } from "../project-application-sheet";
import { applicationSheetPlan, stageContractTotal, type SheetSaveContext } from "../project-application-sheet-save";
import {
  applyStagePercentageEdit,
  releaseAutoEqualAmounts,
  savedOverrideOf,
  stageAmountView,
  stageAutoAmounts,
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
  bill({ id: "b2", installmentNo: 2, percentage: 70, milestone: "完工款", calculatedAmount: 70000, effectiveAmount: 70000 }),
];

function autos(billings: BillingExt[], edits: Record<string, StageEdit>, total: number | null) {
  return stageAutoAmounts(applicationStageRows(billings), billings, edits, total);
}

describe("stageAutoAmounts：未稅 × %", () => {
  it("改 % 立即預填：第 1 期 30% → 40%＝40,000，最後一期吸收差額", () => {
    const a = autos(twoStages, { b1: { percentage: "40" } }, 100000);
    expect(a.get("b1")).toBe(40000);
    // 40% + 70% ＝ 110%：最後一期吸收尾差（合計＝合約總額），同後端 computeInstallments。
    expect(a.get("b2")).toBe(60000);
  });

  it("改未稅重算", () => {
    expect(autos(twoStages, {}, 100000).get("b1")).toBe(30000);
    expect(autos(twoStages, {}, 1428571).get("b1")).toBe(428571);
    expect(autos(twoStages, {}, 1428571).get("b2")).toBe(1000000);
  });

  it("尾差：8,888,888 分 5 期各 20%，前 4 期 1,777,778、末期 1,777,776", () => {
    const five = [1, 2, 3, 4, 5].map((n) => bill({ id: `b${n}`, installmentNo: n, percentage: 20, calculatedAmount: null, effectiveAmount: null }));
    const a = autos(five, {}, 8888888);
    expect([1, 2, 3, 4, 5].map((n) => a.get(`b${n}`))).toEqual([1777778, 1777778, 1777778, 1777778, 1777776]);
  });

  it("空白列填 % 也預填；沒有合約總額不預填；已請款凍結", () => {
    const rows = applicationStageRows(twoStages);
    const blankKey = stageRowKey(rows[2]);
    expect(autos(twoStages, { b2: { percentage: "60" }, [blankKey]: { percentage: "10" } }, 100000).get(blankKey)).toBe(10000);
    expect(autos(twoStages, {}, null).get("b1")).toBeNull();
    const billed = [twoStages[0], bill({ ...twoStages[1], billedOn: "2026-10-20", billedAmount: 70000 })];
    expect(autos(billed, {}, 100000).get("b2")).toBeNull();
  });

  it("其他列人工指定 → 尾差落在未指定的最後一期", () => {
    const a = autos(twoStages, { b1: { amount: "35000" } }, 100000);
    expect(a.get("b2")).toBe(65000);
  });
});

describe("stageAmountView／applyStagePercentageEdit：% 是主要輸入", () => {
  const rows = applicationStageRows(twoStages);
  const r1 = rows[0];

  it("沒手改：顯示試算值、不算人工指定", () => {
    expect(stageAmountView(r1, { percentage: "40" }, null, 40000)).toEqual({ auto: 40000, display: "40000", manual: false });
  });

  it("手改且與試算不同＝人工指定；等於試算值＝跟著 % 走", () => {
    expect(stageAmountView(r1, { amount: "41000" }, null, 30000).manual).toBe(true);
    expect(stageAmountView(r1, { amount: "30,000" }, null, 30000).manual).toBe(false);
  });

  it("手改後再改 % → 金額改回跟著 % 走並標記已重算", () => {
    const edits = { b1: { amount: "41000", overrideReason: "議價" } };
    const res = applyStagePercentageEdit(edits, r1, "50", null, 30000);
    expect(res.recalculated).toBe(true);
    expect(res.stageEdits.b1).toEqual({ amount: "", percentage: "50" });
    const a = stageAutoAmounts(rows, twoStages, res.stageEdits, 100000);
    expect(a.get("b1")).toBe(50000);
    expect(stageAmountView(r1, res.stageEdits.b1, null, a.get("b1") ?? null)).toMatchObject({ display: "50000", manual: false });
  });

  it("已存的人工指定，改 % 也重算（存檔時取消指定）", () => {
    const withOverride = [bill({ ...twoStages[0], overrideAmount: 33333, overrideReason: "談定", effectiveAmount: 33333 }), twoStages[1]];
    const r = applicationStageRows(withOverride)[0];
    expect(savedOverrideOf(r, withOverride)).toBe(33333);
    const res = applyStagePercentageEdit({}, r, "40", 33333, 30000);
    expect(res.recalculated).toBe(true);
    expect(res.stageEdits.b1.amount).toBe("");
  });

  it("沒手改的列改 % 不提示", () => {
    expect(applyStagePercentageEdit({}, r1, "40", null, 30000)).toEqual({ stageEdits: { b1: { percentage: "40" } }, recalculated: false });
  });

  it("改未稅前：剛好等於試算值的手打金額改回跟著 %；人工指定保留", () => {
    const next = releaseAutoEqualAmounts({ b1: { amount: "30000" }, b2: { amount: "65000" } }, new Map([["b1", 30000], ["b2", 70000]]));
    expect(next.b1.amount).toBe("");
    expect(next.b2.amount).toBe("65000");
  });
});

describe("存檔計畫：等於試算值不算人工指定", () => {
  const project = { id: "p1", engineers: {}, designScope: [], client: null } as unknown as ProjectDetail;
  const money = { amountUntaxed: 100000, amountSource: "contract", vatRate: 0.05 } as ProjectMoney;
  const ctx = { project, canFinance: true, disciplines: [], client: null, money, contracts: [], billings: twoStages, subcontracts: [], vendors: [] } as SheetSaveContext;
  const draftOf = (stageEdits: Record<string, StageEdit>) => ({ ...applicationSheetDraftOf(project, []), stageEdits });

  it("合約總額：有合約才試算；只有報價單＝null", () => {
    expect(stageContractTotal(money, [], { amountUntaxed: null, orderDocType: "" } as never)).toBe(100000);
    expect(stageContractTotal(money, [], { amountUntaxed: "1,428,571", orderDocType: "" } as never)).toBe(1428571);
    expect(stageContractTotal({ ...money, amountSource: "quotation" }, [], { amountUntaxed: null, orderDocType: "" } as never)).toBeNull();
  });

  it("改 % 後金額等於預填值 → 只送 %，不要理由", () => {
    const plan = applicationSheetPlan(ctx, draftOf({ b1: { percentage: "40", amount: "40000" } }));
    expect(plan.errors).toEqual([]);
    expect(plan.stages.installments?.[0]).toMatchObject({ id: "b1", percentage: 40, overrideAmount: null });
  });

  it("手改金額與 % 不同 → 人工指定要理由，提示依 % 應為多少", () => {
    const plan = applicationSheetPlan(ctx, draftOf({ b1: { percentage: "40", amount: "41000" } }));
    expect(plan.stages.needsReason).toEqual([{ key: "b1", label: "第 1 列", expected: 40000 }]);
    expect(plan.errors.map((e) => e.message)).toContain("付款階段第 1 列改了金額（人工指定，依 % 應為 40,000），請填理由。");
  });
});
