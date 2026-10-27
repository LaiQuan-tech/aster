import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，驗 payDisbursement 的「條件更新」——讀到 approved 之後、
// 寫 paid 之前被別的請求搶先付掉時，後到的不能再寫一次（批次放款逾時重按的並發情境）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { payDisbursement, DisbursementError } from "../services/disbursements.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/** ⚠️ 全部是明顯的假資料。 */
const DISB = "dddddddd-0000-4000-8000-0000000000aa"
const ACTOR = { empId: "cccccccc-0000-4000-8000-000000000003", role: "accountant" }

function seed(status: string) {
  fake.db.disbursements = [
    {
      id: DISB, tenant_id: TENANT_ID, disbursement_no: "D-TEST-0001", status, payee_kind: "other", vendor_id: null,
      payee_name: "測試收款方", payee_bank_name: null, payee_bank_account: null, payee_bank_code: null,
      paying_company_id: "eeeeeeee-0000-4000-8000-000000000001", paying_company_name: "測試公司", paying_bank_account: null,
      method: "transfer", paid_on: null, amount: 1000, withheld_amount: 0, receipt_issuer_company_id: null, receipt_ref: null,
      has_invoice: false, invoice_no: null, purpose: "測試", note: null, void_reason: null, paid_by_emp_id: null,
      created_by_emp_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
      current_step: null, approval_round: 1, submitted_at: null, submitted_by_emp_id: null, approved_at: "2026-10-02T00:00:00Z",
    },
  ]
  fake.db.disbursement_allocations = []
}

beforeEach(() => {
  fake.reset()
})

describe("payDisbursement 條件更新（並發重複付款防線）", () => {
  it("一般情況：approved → paid", async () => {
    seed("approved")
    const out = await payDisbursement(TENANT_ID, ACTOR, DISB, { paidOn: "2026-10-27" })
    expect(out?.status).toBe("paid")
    expect(fake.db.disbursements[0]).toMatchObject({ status: "paid", paid_on: "2026-10-27" })
  })

  it("讀到 approved 後被別的請求搶先付掉 → 409 already_paid，且沒有第二次寫入 paid", async () => {
    seed("approved")
    const realFrom = fake.from
    let raced = false
    // 在本請求寫 paid 之前，模擬另一個請求已把單子付掉（paid_on 不同，用來確認沒被覆寫）。
    fake.from = ((table: string) => {
      const builder = realFrom(table)
      if (table === "disbursements" && !raced) {
        const update = builder.update.bind(builder)
        builder.update = ((payload: Record<string, unknown>) => {
          if (payload.status === "paid") {
            raced = true
            fake.db.disbursements[0].status = "paid"
            fake.db.disbursements[0].paid_on = "2026-10-20"
          }
          return update(payload)
        }) as typeof builder.update
      }
      return builder
    }) as typeof fake.from
    try {
      const err = await payDisbursement(TENANT_ID, ACTOR, DISB, { paidOn: "2026-10-27" }).catch((e) => e)
      expect(raced).toBe(true)
      expect(err).toBeInstanceOf(DisbursementError)
      expect((err as DisbursementError).code).toBe("already_paid")
      expect(fake.db.disbursements[0].paid_on).toBe("2026-10-20")
    } finally {
      fake.from = realFrom
    }
  })
})
