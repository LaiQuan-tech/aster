import { describe, expect, it } from "vitest";
import {
  AMOUNT_MAX,
  LABEL_MAX,
  NOTE_MAX,
  adjustmentDisplayLabel,
  adjustmentDisplayOf,
  adjustmentErrorMessage,
  adjustmentPrintRows,
  adjustmentTreatment,
  buildCreateBody,
  buildPatch,
  draftFromAdjustment,
  emptyAdjustmentDraft,
  parseAmountInput,
  payslipStateNote,
  previousPeriod,
  relatedAdjustmentsNote,
  signedMoney,
  summarizeAdjustments,
  type AdjustmentDraft,
} from "../payroll-adjustments-api";
import { PRIOR_PERIOD_CORRECTION_HREF } from "../payroll-periods-api";

/**
 * 薪資一次性加減項（前期更正）的畫面端純函式：表單驗證、歸屬、合計、薪資單顯示列（後台列印與員工端共用）、錯誤訊息。
 * 與後端的規則一一對應（apps/api/src/routes/payroll-adjustments.ts、packages/rules/src/payroll-engine.ts）。
 */

const EMP = "a0000000-0000-4000-8000-000000000004";

const apiError = (status: number, code: string, serverMessage?: string) =>
  Object.assign(new Error(`[${status}] ${code}`), { status, code, serverMessage });

const draft = (over: Partial<AdjustmentDraft> = {}): AdjustmentDraft => ({
  label: "補發 9 月加班費",
  amount: "3000",
  kind: "add",
  taxable: true,
  relatedPeriod: "2026-09",
  note: "",
  ...over,
});

describe("前期更正入口連結", () => {
  it("重新開放對話框的連結指到薪資作業頁的加減項卡（#payroll-adjustments）", () => {
    expect(PRIOR_PERIOD_CORRECTION_HREF).toBe("/admin/payroll#payroll-adjustments");
  });
});

describe("顯示名稱與歸屬", () => {
  it("adjustmentDisplayLabel：有更正月份標 (更正 YYYY-MM)；沒有就是原名稱；已寫同樣標示不重複（與引擎同一個規則）", () => {
    expect(adjustmentDisplayLabel("補發加班費", "2026-09")).toBe("補發加班費(更正 2026-09)");
    expect(adjustmentDisplayLabel("  補發加班費  ", "2026-09")).toBe("補發加班費(更正 2026-09)");
    expect(adjustmentDisplayLabel("補發加班費", null)).toBe("補發加班費");
    expect(adjustmentDisplayLabel("補發加班費")).toBe("補發加班費");
    expect(adjustmentDisplayLabel("9 月加班費（更正 2026-09）", "2026-09")).toBe("9 月加班費（更正 2026-09）");
  });

  it("adjustmentTreatment：負＝扣回（不論課稅）、正且課稅＝計入應發、正且不課稅＝只加實發；有明確 treatment 就用它", () => {
    expect(adjustmentTreatment({ amount: -1 })).toBe("deduction");
    expect(adjustmentTreatment({ amount: -1, taxable: false })).toBe("deduction");
    expect(adjustmentTreatment({ amount: 1 })).toBe("earning");
    expect(adjustmentTreatment({ amount: 1, taxable: true })).toBe("earning");
    expect(adjustmentTreatment({ amount: 1, taxable: false })).toBe("non_taxable");
    expect(adjustmentTreatment({ amount: 1, treatment: "non_taxable" })).toBe("non_taxable");
  });

  it("summarizeAdjustments：課稅補發／扣回／不課稅補發各自合計；對實發的淨影響 = 補發 − 扣回 + 不課稅補發", () => {
    const totals = summarizeAdjustments([
      { amount: 3000.5 },
      { amount: -1000 },
      { amount: 450, taxable: false },
      { amount: 700 },
      { amount: -100.25 },
    ]);
    expect(totals).toEqual({ count: 5, earnings: 3700.5, deductions: 1100.25, nonTaxable: 450, netEffect: 3050.25 });
    expect(summarizeAdjustments([])).toEqual({ count: 0, earnings: 0, deductions: 0, nonTaxable: 0, netEffect: 0 });
  });

  it("signedMoney：帶正負號、千分位、最多兩位小數", () => {
    expect(signedMoney(3000)).toBe("+3,000");
    expect(signedMoney(-2000)).toBe("-2,000");
    expect(signedMoney(1234.5)).toBe("+1,234.5");
    expect(signedMoney(-0.25)).toBe("-0.25");
  });
});

describe("薪資單顯示列（後台列印、員工端共用）", () => {
  const breakdown = {
    adjustments: [
      { id: "a", label: "補發 9 月加班費", amount: 3000, taxable: true, relatedPeriod: "2026-09", treatment: "earning" },
      { id: "b", label: "扣回 8 月誤發獎金", amount: -2000, taxable: true, relatedPeriod: "2026-08", treatment: "deduction" },
      { id: "c", label: "補發交通費", amount: 450, taxable: false, relatedPeriod: "2026-09", treatment: "non_taxable" },
      { id: "d", label: "年終補差", amount: 700, taxable: true, relatedPeriod: null, treatment: "earning" },
    ],
  };

  it("adjustmentDisplayOf：依歸屬分好；標題帶更正月份；不課稅補發另標『不計薪資所得』；金額顯示正值、signed 保留原符號", () => {
    const d = adjustmentDisplayOf(breakdown);
    expect(d.earning.map((r) => r.label)).toEqual(["補發 9 月加班費(更正 2026-09)", "年終補差"]);
    expect(d.deduction.map((r) => [r.label, r.amount, r.signed])).toEqual([["扣回 8 月誤發獎金(更正 2026-08)", 2000, -2000]]);
    expect(d.nonTaxable.map((r) => r.label)).toEqual(["補發交通費(更正 2026-09)（不計薪資所得）"]);
    expect(d.all).toHaveLength(4);
  });

  it("舊薪資單（沒有 adjustments、null、undefined、格式不對、金額 0）一律是空的，不丟錯", () => {
    for (const legacy of [undefined, null, {}, { adjustments: "x" }, { adjustments: [{ label: "零", amount: 0 }, { label: "壞", amount: Number.NaN }] }]) {
      expect(adjustmentDisplayOf(legacy).all).toEqual([]);
    }
  });

  it("沒帶 treatment 時由金額與 taxable 推出歸屬（容忍較舊格式）", () => {
    const d = adjustmentDisplayOf({ adjustments: [{ label: "A", amount: 10 }, { label: "B", amount: -5 }, { label: "C", amount: 3, taxable: false }] });
    expect(d.earning).toHaveLength(1);
    expect(d.deduction).toHaveLength(1);
    expect(d.nonTaxable).toHaveLength(1);
  });

  it("adjustmentPrintRows：一筆一列 <tr>、名稱 escape、金額用傳入的格式；沒有該歸屬的加減項就是空字串（列印版面不多一列）", () => {
    const format = { money: (n: number) => `$${n.toLocaleString("zh-TW")}`, esc: (s: string) => s.replace(/</g, "&lt;") };
    const earning = adjustmentPrintRows(breakdown, "earning", format);
    expect(earning).toContain("<td>補發 9 月加班費(更正 2026-09)</td><td style=\"text-align:right\">$3,000</td>");
    expect(earning.match(/<tr>/g)).toHaveLength(2);
    expect(adjustmentPrintRows(breakdown, "deduction", format)).toContain("$2,000");
    expect(adjustmentPrintRows(breakdown, "non_taxable", format)).toContain("（不計薪資所得）");
    expect(adjustmentPrintRows({}, "earning", format)).toBe("");
    const evil = adjustmentPrintRows({ adjustments: [{ label: "<b>x</b>", amount: 1 }] }, "earning", format);
    expect(evil).toContain("&lt;b>x&lt;/b>");
    expect(evil).not.toContain("<b>");
  });
});

describe("金額輸入", () => {
  it("parseAmountInput：正數、最多兩位小數、允許千分位逗號；0、負數、三位小數、非數字、超過上限都是 null", () => {
    expect(parseAmountInput("3000")).toBe(3000);
    expect(parseAmountInput(" 3,000.5 ")).toBe(3000.5);
    expect(parseAmountInput("0.01")).toBe(0.01);
    for (const bad of ["", "0", "-5", "1.234", "abc", "1e3", "１２３", ".5", "5.", String(AMOUNT_MAX + 1)]) {
      expect(parseAmountInput(bad), bad).toBeNull();
    }
    expect(parseAmountInput(String(AMOUNT_MAX))).toBe(AMOUNT_MAX);
  });
});

describe("表單 → 請求內容（含驗證）", () => {
  const ctx = { employeeId: EMP, period: "2026-10" };

  it("補發：金額為正；扣回：金額為負；名稱、備註去頭尾空白；空的更正月份與備註變 null", () => {
    expect(buildCreateBody(draft({ label: "  補發  " }), ctx)).toEqual({
      ok: true,
      value: { employeeId: EMP, period: "2026-10", label: "補發", amount: 3000, taxable: true, relatedPeriod: "2026-09", note: null },
    });
    const deduct = buildCreateBody(draft({ kind: "deduct", amount: "1,200.5", relatedPeriod: "", note: " 多領 " }), ctx);
    expect(deduct).toMatchObject({ ok: true, value: { amount: -1200.5, relatedPeriod: null, note: "多領" } });
  });

  it("不課稅的補發：taxable=false 照送", () => {
    expect(buildCreateBody(draft({ taxable: false }), ctx)).toMatchObject({ ok: true, value: { taxable: false } });
  });

  it("名稱空白、超過 100 字（用字元數算）、金額不合法、更正月份格式錯或晚於薪資月份、備註太長 → 給人看的錯誤訊息", () => {
    expect(buildCreateBody(draft({ label: "   " }), ctx)).toMatchObject({ ok: false, error: expect.stringContaining("名稱") });
    expect(buildCreateBody(draft({ label: "字".repeat(LABEL_MAX + 1) }), ctx)).toMatchObject({ ok: false, error: `名稱最多 ${LABEL_MAX} 字` });
    expect(buildCreateBody(draft({ label: "字".repeat(LABEL_MAX) }), ctx).ok).toBe(true);
    expect(buildCreateBody(draft({ amount: "0" }), ctx)).toMatchObject({ ok: false, error: expect.stringContaining("金額") });
    expect(buildCreateBody(draft({ amount: "12.345" }), ctx).ok).toBe(false);
    expect(buildCreateBody(draft({ relatedPeriod: "2026-9" }), ctx)).toMatchObject({ ok: false, error: "更正月份格式不正確" });
    expect(buildCreateBody(draft({ relatedPeriod: "2026-11" }), ctx)).toMatchObject({ ok: false, error: "更正月份不能晚於薪資單所屬月份" });
    expect(buildCreateBody(draft({ relatedPeriod: "2026-10" }), ctx).ok).toBe(true); // 同月可以
    expect(buildCreateBody(draft({ note: "字".repeat(NOTE_MAX + 1) }), ctx)).toMatchObject({ ok: false, error: `備註最多 ${NOTE_MAX} 字` });
  });

  it("buildPatch：同一套驗證，只送可改的欄位（沒有員工與期別）", () => {
    const patch = buildPatch(draft({ kind: "deduct", amount: "50", note: "" }), "2026-10");
    expect(patch).toEqual({ ok: true, value: { label: "補發 9 月加班費", amount: -50, taxable: true, relatedPeriod: "2026-09", note: null } });
    expect(patch.ok && "employeeId" in patch.value).toBe(false);
    expect(buildPatch(draft({ amount: "" }), "2026-10").ok).toBe(false);
  });

  it("emptyAdjustmentDraft 預設更正上個月；previousPeriod 跨年；draftFromAdjustment 來回一致", () => {
    expect(emptyAdjustmentDraft("2026-10")).toEqual({ label: "", amount: "", kind: "add", taxable: true, relatedPeriod: "2026-09", note: "" });
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(previousPeriod("2026-12")).toBe("2026-11");
    expect(previousPeriod("nope")).toBe("");
    const stored = { label: "扣回", amount: -250.5, taxable: false, relatedPeriod: "2026-08", note: "備註" };
    const back = draftFromAdjustment(stored);
    expect(back).toEqual({ label: "扣回", amount: "250.5", kind: "deduct", taxable: false, relatedPeriod: "2026-08", note: "備註" });
    expect(buildPatch(back, "2026-10")).toMatchObject({ ok: true, value: { amount: -250.5, taxable: false } });
    expect(draftFromAdjustment({ ...stored, amount: 10, relatedPeriod: null, note: null })).toMatchObject({ kind: "add", relatedPeriod: "", note: "" });
  });
});

describe("錯誤訊息與提醒", () => {
  it("後端有給中文訊息的（薪資單已定稿、更正月份不合理）直接用；已結算月份是 YYYY-MM 已結算，請洽管理者", () => {
    expect(adjustmentErrorMessage(apiError(409, "payslip_finalized", "2026-10 的薪資單已定稿，不能再改加減項；如需更正請加在下個月的薪資"))).toContain("已定稿");
    expect(adjustmentErrorMessage(apiError(400, "invalid_related_period", "relatedPeriod 不能晚於薪資單所屬月份"))).toContain("relatedPeriod");
    const closed = Object.assign(new Error("[409] period_closed"), { status: 409, code: "period_closed", body: { error: "period_closed", period: "2026-10" } });
    expect(adjustmentErrorMessage(closed)).toBe("2026-10 已結算，請洽管理者");
  });

  it("沒給訊息的代碼補上白話：invalid_employee／invalid_body／forbidden／not_found；其他走原訊息或 fallback", () => {
    expect(adjustmentErrorMessage(apiError(400, "invalid_employee"))).toContain("找不到這位員工");
    expect(adjustmentErrorMessage(apiError(400, "invalid_body"))).toContain("欄位格式不正確");
    expect(adjustmentErrorMessage(apiError(403, "forbidden"))).toContain("HR");
    expect(adjustmentErrorMessage(apiError(404, "not_found"))).toContain("已不存在");
    expect(adjustmentErrorMessage(new Error("boom"))).toBe("boom");
    expect(adjustmentErrorMessage("x", "儲存失敗")).toBe("儲存失敗");
  });

  it("payslipStateNote：已定稿 → 不能再改；草稿過期 → 請重新執行薪資作業；其餘 null", () => {
    expect(payslipStateNote({ status: "finalized", stale: false }, "2026-10")).toMatchObject({ tone: "locked", text: expect.stringContaining("已定稿") });
    expect(payslipStateNote({ status: "draft", stale: true }, "2026-10")).toMatchObject({ tone: "warn", text: expect.stringContaining("重新執行") });
    expect(payslipStateNote({ status: "draft", stale: false }, "2026-10")).toBeNull();
    expect(payslipStateNote({ status: null, stale: false }, "2026-10")).toBeNull();
    expect(payslipStateNote(null, "2026-10")).toBeNull();
  });
});

describe("重新開放某月之前：後續月份已經更正過它", () => {
  it("沒有就是 null；有就說明可能重複入帳，逐筆列出（最多 5 筆，其餘寫還有 N 筆）", () => {
    expect(relatedAdjustmentsNote("2026-09", [])).toBeNull();
    expect(relatedAdjustmentsNote("2026-09", null)).toBeNull();
    const note = relatedAdjustmentsNote("2026-09", [
      { period: "2026-10", label: "補發加班費", amount: 3000 },
      { period: "2026-10", label: "扣回誤發", amount: -500 },
    ]);
    expect(note?.title).toContain("2026-09 已經有 2 筆前期更正");
    expect(note?.title).toContain("重複入帳");
    expect(note?.lines).toEqual(["2026-10 薪資：補發加班費（+3,000）", "2026-10 薪資：扣回誤發（-500）"]);
    const many = Array.from({ length: 7 }, (_, i) => ({ period: "2026-10", label: `第 ${i + 1} 筆`, amount: 1 }));
    const long = relatedAdjustmentsNote("2026-09", many);
    expect(long?.lines).toHaveLength(6);
    expect(long?.lines[5]).toBe("還有 2 筆");
  });
});
