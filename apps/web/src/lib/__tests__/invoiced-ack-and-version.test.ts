import { describe, expect, it } from "vitest";
import { billingScheduleVersion } from "../billing-version";
import { invoicedAckBodyOf, invoicedChangeLines, invoicedChangesOf } from "../invoiced-ack";

/** 期程版本：後端 apps/api/src/lib/billing-version.ts 用同一組向量、同一個期望值，兩邊實作必須一致。 */
const VECTOR = [
  { id: "B-2", installmentNo: 2, kind: "installment", percentage: 50, milestone: "期中", plannedOn: null, overrideAmount: null, overrideReason: null, note: "備註" },
  { id: "b-1", installmentNo: 1, kind: "guild_advance", percentage: null, milestone: null, plannedOn: "2026-01-02", overrideAmount: 1000.5, overrideReason: "談價", note: null },
];

describe("billingScheduleVersion（前端）", () => {
  it("與後端同一組向量得到同一個版本", () => {
    expect(billingScheduleVersion(VECTOR)).toBe("2-a07eead6");
    expect(billingScheduleVersion([...VECTOR].reverse())).toBe("2-a07eead6");
  });
});

describe("已開票期別金額變動確認", () => {
  it("辨認 409 invoiced_amount_would_change 並取出變動清單；其他錯誤回 null", () => {
    const err = Object.assign(new Error("[409] invoiced_amount_would_change"), {
      code: "invoiced_amount_would_change",
      body: { changes: [{ billingId: "b2", installmentNo: 2, before: 100000, after: 110000 }] },
    });
    expect(invoicedChangesOf(err)).toEqual([{ billingId: "b2", installmentNo: 2, before: 100000, after: 110000 }]);
    expect(invoicedChangeLines(invoicedChangesOf(err)!)).toEqual(["第 2 期（已開發票）：100,000 → 110,000"]);
    expect(invoicedChangesOf(Object.assign(new Error("[409] already_billed"), { code: "already_billed" }))).toBeNull();
    expect(invoicedChangesOf(null)).toBeNull();
  });
  it("理由必填：空白不產生 ack；有填就帶 acknowledgeInvoicedChange", () => {
    expect(invoicedAckBodyOf("  ")).toBeNull();
    expect(invoicedAckBodyOf(" 折讓 ")).toEqual({ acknowledgeInvoicedChange: true, invoicedChangeReason: "折讓", acknowledgedChanges: [] });
    // 綁定確認過的變動（期別＋變動後金額），後端重新試算不一致會再要求確認。
    expect(invoicedAckBodyOf("折讓", [{ billingId: "b2", installmentNo: 2, before: 100000, after: 110000 }])).toEqual({
      acknowledgeInvoicedChange: true,
      invoicedChangeReason: "折讓",
      acknowledgedChanges: [{ billingId: "b2", after: 110000 }],
    });
  });
});
