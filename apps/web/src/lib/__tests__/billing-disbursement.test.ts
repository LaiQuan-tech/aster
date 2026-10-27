import { describe, expect, it } from "vitest";
import {
  applyBatchPayResults,
  buildLedger,
  filterLedger,
  markPaidCheck,
  parseBillingDisbursementView,
  validateBatchPay,
} from "../billing-disbursement";
import type { Disbursement, Payable } from "../disbursements-api";
import type { ReceivableRow } from "../projects-ext-api";

/** ⚠️ 全部是明顯的假資料（測試案、測試廠商）。 */
const P1 = "p-0001";
const P2 = "p-0002";

function receivable(over: Partial<ReceivableRow> = {}): ReceivableRow {
  return {
    projectId: P1,
    code: "T-001",
    projectName: "測試案甲",
    clientName: "測試客戶甲",
    billingId: `b-${Math.random().toString(36).slice(2, 8)}`,
    installmentNo: 1,
    kind: "normal" as ReceivableRow["kind"],
    milestone: "簽約",
    percentage: 30,
    amount: 300000,
    billedOn: "2026-09-01",
    invoiceNo: "TT00000001",
    invoicedOn: "2026-09-02",
    receivedOn: null,
    receivedAmount: 0,
    unreceived: 300000,
    overdueDays: 40,
    state: "overdue",
    projectUnreceivedPct: 100,
    projectCode: "T-001",
    ...over,
  };
}

function payable(over: Partial<Payable> = {}): Payable {
  return {
    subcontractPaymentId: "sp-1",
    subcontractId: "sc-1",
    projectId: P1,
    projectCode: "T-001",
    projectName: "測試案甲",
    vendorId: "v-1",
    vendorName: "測試廠商甲",
    installmentNo: 1,
    dueWhen: "完工驗收後",
    grossAmount: 50000,
    withheldAmount: 5000,
    netAmount: 45000,
    projectReceiptProgressPct: 40,
    acceptedOn: "2026-10-01",
    ...over,
  };
}

function disbursement(over: Partial<Disbursement> = {}): Disbursement {
  return {
    id: "d-1",
    disbursementNo: "D-TEST-001",
    status: "approved",
    payeeKind: "vendor",
    vendorId: "v-1",
    payeeName: "測試廠商甲",
    payeeBankName: null,
    payeeBankAccount: null,
    payeeBankCode: null,
    payingCompanyId: "c-1",
    payingCompanyName: "測試公司甲",
    payingBankAccount: null,
    method: "transfer",
    paidOn: null,
    amount: 45000,
    withheldAmount: 5000,
    grossAmount: 50000,
    receiptIssuerCompanyId: null,
    receiptRef: "R-001",
    hasInvoice: false,
    invoiceNo: null,
    purpose: null,
    note: null,
    voidReason: null,
    paidByEmpId: null,
    createdAt: "2026-10-01T00:00:00Z",
    currentStep: null,
    allocations: [
      { id: "a-1", projectId: P1, projectCode: "T-001", projectName: "測試案甲", subcontractPaymentId: "sp-1", installmentNo: 1, vendorName: "測試廠商甲", amount: 50000, withheldAmount: 5000, netAmount: 45000 },
    ],
    ...over,
  };
}

describe("parseBillingDisbursementView：?view= 與舊網址相容", () => {
  it("認得的值照收；沒給／亂給 → 對照總表", () => {
    expect(parseBillingDisbursementView("receivables")).toBe("receivables");
    expect(parseBillingDisbursementView("payables")).toBe("payables");
    expect(parseBillingDisbursementView("records")).toBe("records");
    expect(parseBillingDisbursementView(null)).toBe("ledger");
    expect(parseBillingDisbursementView("nope")).toBe("ledger");
  });
});

describe("markPaidCheck：哪些放款單可以打勾放款", () => {
  const accepted = new Map([["sp-1", { acceptedOn: "2026-10-01", installmentNo: 1 }]]);
  const notAccepted = new Map([["sp-1", { acceptedOn: null, installmentNo: 1 }]]);

  it("已核准且期款都已驗收 → 可以", () => {
    expect(markPaidCheck(disbursement(), accepted, true)).toEqual({ ok: true, reason: null });
  });
  it("草稿／送簽中／已放款／作廢 → 不行（附原因）", () => {
    expect(markPaidCheck(disbursement({ status: "draft" }), accepted, true)).toMatchObject({ ok: false, reason: expect.stringContaining("送簽") });
    expect(markPaidCheck(disbursement({ status: "pending_approval", currentStep: 2 }), accepted, true)).toMatchObject({ ok: false, reason: expect.stringContaining("第 2 關") });
    expect(markPaidCheck(disbursement({ status: "paid" }), accepted, true).ok).toBe(false);
    expect(markPaidCheck(disbursement({ status: "void" }), accepted, true).ok).toBe(false);
  });
  it("已核准但期款未驗收 → 不行；驗收欄位未套用（acceptanceTracked=false）→ 不檢查驗收", () => {
    expect(markPaidCheck(disbursement(), notAccepted, true)).toMatchObject({ ok: false, reason: expect.stringContaining("第 1 期尚未驗收") });
    expect(markPaidCheck(disbursement(), notAccepted, false).ok).toBe(true);
  });
});

describe("buildLedger：每個專案的客戶請款 × 廠商付款", () => {
  it("同一案的請款與付款併在一塊；廠商付款狀態依放款單與驗收決定", () => {
    const ledger = buildLedger({
      receivables: [receivable({ installmentNo: 2, billingId: "b-2", unreceived: 100000, amount: 100000, state: "billed", overdueDays: 0 }), receivable({ billingId: "b-1" })],
      payables: [
        payable(), // 在已核准的 d-1 上 → 可放款
        payable({ subcontractPaymentId: "sp-2", installmentNo: 2, acceptedOn: null }), // 沒單、未驗收
        payable({ subcontractPaymentId: "sp-3", installmentNo: 3 }), // 沒單、已驗收
        payable({ subcontractPaymentId: "sp-4", installmentNo: 4 }), // 在送簽中的 d-2 上
      ],
      disbursements: [
        disbursement(),
        disbursement({
          id: "d-2",
          disbursementNo: "D-TEST-002",
          status: "pending_approval",
          currentStep: 1,
          allocations: [{ id: "a-2", projectId: P1, subcontractPaymentId: "sp-4", installmentNo: 4, amount: 50000, withheldAmount: 5000, netAmount: 45000 }],
        }),
        disbursement({ id: "d-9", status: "void", allocations: [{ id: "a-9", projectId: P1, subcontractPaymentId: "sp-3", amount: 1, withheldAmount: 0, netAmount: 1 }] }),
      ],
      acceptanceTracked: true,
      includePaid: false,
    });
    expect(ledger).toHaveLength(1);
    const p = ledger[0];
    expect(p).toMatchObject({ code: "T-001", clientName: "測試客戶甲", receiptProgressPct: 40 });
    expect(p.billings.map((b) => b.installmentNo)).toEqual([1, 2]);
    expect(p.vendorRows.map((v) => [v.installmentNo, v.state])).toEqual([
      [1, "ready_to_pay"],
      [4, "pending_approval"],
      [3, "to_create"],
      [2, "unaccepted"],
    ]);
    expect(p.vendorRows[0].disbursement).toMatchObject({ id: "d-1", payingCompanyName: "測試公司甲", receiptRef: "R-001", projectCount: 1 });
    // 作廢的單不影響狀態（sp-3 仍是待建單）
    expect(p.vendorRows.find((v) => v.installmentNo === 3)?.disbursement).toBeNull();
    expect(p.totals).toEqual({ billingAmount: 400000, unreceived: 400000, overdueCount: 1, unpaidNet: 180000, unpaidNetUnlinked: 0, readyToPayNet: 45000 });
  });

  it("已核准但期款被取消驗收 → approved_unaccepted（不能勾）", () => {
    const [p] = buildLedger({ receivables: [], payables: [payable({ acceptedOn: null })], disbursements: [disbursement()], acceptanceTracked: true, includePaid: false });
    expect(p.vendorRows[0].state).toBe("approved_unaccepted");
    expect(p.totals.readyToPayNet).toBe(0);
  });

  it("已放款的分攤列只在 includePaid 時列出；跨案的單每案各一列、projectCount=2", () => {
    const paid = disbursement({
      id: "d-3",
      status: "paid",
      paidOn: "2026-10-20",
      allocations: [
        { id: "a-31", projectId: P1, projectCode: "T-001", projectName: "測試案甲", subcontractPaymentId: "sp-31", installmentNo: 1, amount: 10000, withheldAmount: 0, netAmount: 10000 },
        { id: "a-32", projectId: P2, projectCode: "T-002", projectName: "測試案乙", subcontractPaymentId: "sp-32", installmentNo: 1, amount: 20000, withheldAmount: 0, netAmount: 20000 },
      ],
    });
    expect(buildLedger({ receivables: [], payables: [], disbursements: [paid], acceptanceTracked: true, includePaid: false })).toEqual([]);
    const ledger = buildLedger({ receivables: [], payables: [], disbursements: [paid], acceptanceTracked: true, includePaid: true });
    expect(ledger.map((p) => p.code).sort()).toEqual(["T-001", "T-002"]);
    for (const p of ledger) {
      expect(p.vendorRows[0]).toMatchObject({ state: "paid", disbursement: { paidOn: "2026-10-20", projectCount: 2 } });
      expect(p.totals.unpaidNet).toBe(0);
    }
  });

  it("未放款含沒有掛期款的放款單分攤：另計 unpaidNetUnlinked，讓畫面標註「含未掛期款的放款單」（應付清單 netTotal 不含）", () => {
    const [p] = buildLedger({
      receivables: [],
      payables: [payable()],
      disbursements: [
        disbursement(),
        disbursement({
          id: "d-5",
          disbursementNo: "D-TEST-005",
          status: "draft",
          allocations: [{ id: "a-5", projectId: P1, subcontractPaymentId: null, amount: 12000, withheldAmount: 0, netAmount: 12000 }],
        }),
      ],
      acceptanceTracked: true,
      includePaid: false,
    });
    // 應付清單只有 sp-1（淨 45,000）；對照總表未放款＝45,000＋未掛期款 12,000
    expect(p.totals.unpaidNet).toBe(57000);
    expect(p.totals.unpaidNetUnlinked).toBe(12000);
    expect(p.totals.unpaidNet - p.totals.unpaidNetUnlinked).toBe(45000);
  });

  it("有可放款的專案排前面", () => {
    const ledger = buildLedger({
      receivables: [receivable({ projectId: P2, code: "T-002", projectName: "測試案乙", projectUnreceivedPct: 100 })],
      payables: [payable()],
      disbursements: [disbursement()],
      acceptanceTracked: true,
      includePaid: false,
    });
    expect(ledger.map((p) => p.code)).toEqual(["T-001", "T-002"]);
  });
});

describe("filterLedger：快速篩選與關鍵字", () => {
  const ledger = buildLedger({
    receivables: [receivable({ projectId: P2, code: "T-002", projectName: "測試案乙", clientName: "測試客戶乙" })],
    payables: [payable(), payable({ subcontractPaymentId: "sp-2", installmentNo: 2, acceptedOn: null, vendorName: "測試技師乙" })],
    disbursements: [disbursement()],
    acceptanceTracked: true,
    includePaid: false,
  });
  it("chips", () => {
    expect(filterLedger(ledger, { chip: "readyToPay" }).map((p) => p.code)).toEqual(["T-001"]);
    expect(filterLedger(ledger, { chip: "overdue" }).map((p) => p.code)).toEqual(["T-002"]);
    expect(filterLedger(ledger, { chip: "unreceived" }).map((p) => p.code)).toEqual(["T-002"]);
    expect(filterLedger(ledger, { chip: "blocked" }).map((p) => p.code)).toEqual(["T-001"]);
  });
  it("關鍵字比對客戶、廠商、放款單號（不分大小寫）", () => {
    expect(filterLedger(ledger, { q: "客戶乙" }).map((p) => p.code)).toEqual(["T-002"]);
    expect(filterLedger(ledger, { q: "技師乙" }).map((p) => p.code)).toEqual(["T-001"]);
    expect(filterLedger(ledger, { q: "d-test-001" }).map((p) => p.code)).toEqual(["T-001"]);
    expect(filterLedger(ledger, { q: "  " })).toHaveLength(2);
  });
});

describe("validateBatchPay／applyBatchPayResults：打勾放款送出前後", () => {
  const rows = [
    { id: "d-1", disbursementNo: "D-1", approvedAmount: 45000, amount: 45000 },
    { id: "d-2", disbursementNo: "D-2", approvedAmount: 9000, amount: 8000 },
    { id: "d-3", disbursementNo: "D-3", approvedAmount: 100, amount: null },
  ];
  it("放款日要是有效日期；實付必須等於核准金額（不同的那列不送）", () => {
    expect(validateBatchPay("2026-02-30", rows).dateError).not.toBeNull();
    const v = validateBatchPay("2026-10-27", rows);
    expect(v.dateError).toBeNull();
    expect(Object.keys(v.rowErrors).sort()).toEqual(["d-2", "d-3"]);
    expect(v.rowErrors["d-2"]).toContain("撤回簽核");
    expect(validateBatchPay("2026-10-27", [{ id: "x", disbursementNo: "X", approvedAmount: 100, amount: 100.004 }]).rowErrors).toEqual({});
  });
  it("成功的移出勾選（不會重送）、失敗的留著並附原因", () => {
    const out = applyBatchPayResults(
      new Set(["d-1", "d-2", "d-4"]),
      [
        { id: "d-1", ok: true },
        { id: "d-4", ok: false, status: 409, error: "acceptance_required" },
      ],
      (code) => `原因:${code}`,
    );
    expect(out.succeeded).toEqual(["d-1"]);
    expect([...out.remaining].sort()).toEqual(["d-2", "d-4"]);
    expect(out.failures).toEqual({ "d-4": "原因:acceptance_required" });
  });
});
