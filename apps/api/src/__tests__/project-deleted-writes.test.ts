import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { createDisbursement, DisbursementError, syncPaymentsOnPay, type DisbursementInput } from "../services/disbursements.js"
import { isProjectDeletedError, projectDeletedErrorHandler } from "../middleware/project-deleted.js"
import { dangerOf } from "../services/mcp/danger.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 2026-11-12 刪除專案驗收修正——「已刪除的專案不能再寫入」的應用層防線：
 *   • 放款／請款分攤（resolveAllocations）選到已刪除的專案 → 409 project_deleted（不是 invalid_project 也不是照寫）
 *   • DB 觸發器 assert_project_not_deleted 的 PD409（服務層包成 Error 往上丟）→ 全域錯誤處理回 409 project_deleted
 *   • MCP：DELETE /projects/:id 屬最高風險（要後台本人確認）
 * 觸發器本身在 docs/驗證-2026-11-12-刪除專案-修正.sql 以 pglite 實測。⚠️ 識別碼、名稱、金額都是明顯的假值。
 */

const COMPANY = "cccccccc-0000-4000-8000-000000000701"
const LIVE = "dddddddd-0000-4000-8000-000000000701"
const GONE = "dddddddd-0000-4000-8000-000000000702"
const HR = "eeeeeeee-0000-4000-8000-000000000701"

const input = (projectId: string): DisbursementInput => ({
  payeeKind: "other",
  payeeName: "測試收款方",
  payingCompanyId: COMPANY,
  method: "transfer" as DisbursementInput["method"],
  amount: 1000,
  status: "draft",
  allocations: [{ projectId, amount: 1000 }],
})

beforeEach(() => {
  fake.reset()
  fake.db.companies = [{ id: COMPANY, tenant_id: TENANT_ID, name: "測試公司", bank_name: null, bank_account: null, is_active: true }]
  fake.db.projects = [
    { id: LIVE, tenant_id: TENANT_ID, code: "ZZ-701", name: "活的案", lead_emp_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: null },
    { id: GONE, tenant_id: TENANT_ID, code: "ZZ-702", name: "已刪除的案", lead_emp_id: null, archived_at: null, reserved_at: null, client_id: null, deleted_at: "2026-11-12T00:00:00.000Z" },
  ]
  fake.db.employees = [{ id: HR, tenant_id: TENANT_ID, user_id: "hr-user", role: "hr_admin", name: "人資", status: "active" }]
  for (const t of ["disbursements", "disbursement_allocations", "project_subcontract_payments", "project_subcontracts", "audit_logs"]) fake.db[t] = []
})

describe("放款分攤：已刪除的專案", () => {
  it("新增匯款單分攤到已刪除專案 → DisbursementError 409 project_deleted，一筆都沒寫", async () => {
    const err = await createDisbursement(TENANT_ID, { empId: HR, role: "hr_admin" }, input(GONE)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DisbursementError)
    expect((err as DisbursementError).httpStatus).toBe(409)
    expect((err as DisbursementError).code).toBe("project_deleted")
    expect((err as DisbursementError).details).toEqual({ projectId: GONE })
    expect(fake.db.disbursements).toHaveLength(0)
    expect(fake.db.disbursement_allocations).toHaveLength(0)
  })

  it("對照：未刪除的專案不會被 project_deleted 擋", async () => {
    const err = await createDisbursement(TENANT_ID, { empId: HR, role: "hr_admin" }, input(LIVE)).catch((e: unknown) => e)
    expect((err as DisbursementError | undefined)?.code).not.toBe("project_deleted")
  })
})

describe("DB 觸發器 PD409 → 409 project_deleted", () => {
  it("isProjectDeletedError：認 code PD409 與包過一層的訊息前綴；不誤認其他錯誤", () => {
    expect(isProjectDeletedError({ code: "PD409", message: "x" })).toBe(true)
    expect(isProjectDeletedError(new Error("insertAllocations: project_deleted: 專案已刪除，不能再寫入 disbursement_allocations"))).toBe(true)
    expect(isProjectDeletedError(new Error("project_deleted: 專案已刪除"))).toBe(true)
    expect(isProjectDeletedError(new Error("column projects.project_deleted_at does not exist"))).toBe(false)
    expect(isProjectDeletedError(new Error("boom"))).toBe(false)
    expect(isProjectDeletedError(null)).toBe(false)
  })

  it("RD409 → row_deleted；40P01／40001（含包過一層的訊息）→ conflict_retry", async () => {
    const { isRowDeletedError, isRetryableConflictError } = await import("../middleware/project-deleted.js")
    expect(isRowDeletedError({ code: "RD409" })).toBe(true)
    expect(isRowDeletedError(new Error("x: row_deleted: 這一列已刪除"))).toBe(true)
    expect(isRetryableConflictError({ code: "40P01" })).toBe(true)
    expect(isRetryableConflictError({ code: "40001" })).toBe(true)
    expect(isRetryableConflictError(new Error("POST /billings/x/receive: deadlock detected"))).toBe(true)
    expect(isRetryableConflictError(new Error("boom"))).toBe(false)
  })

  it("全域錯誤處理：PD409 回 409，其他錯誤交給下一個處理器", async () => {
    const app = express()
    app.get("/deleted", (_req, _res, next) => next(new Error("PUT billings: project_deleted: 專案已刪除，不能再寫入 project_billings")))
    app.get("/other", (_req, _res, next) => next(new Error("boom")))
    app.use(projectDeletedErrorHandler)
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: "internal_server_error" })
    })
    const a = await request(app).get("/deleted")
    expect(a.status).toBe(409)
    expect(a.body.error).toBe("project_deleted")
    expect((await request(app).get("/other")).status).toBe(500)
  })
})

describe("MCP：刪除專案是最高風險", () => {
  it("DELETE /projects/:id → high（要後台本人確認）；GET 不受影響", () => {
    expect(dangerOf("DELETE", "/projects/dddddddd-0000-4000-8000-000000000701", { confirmCode: "ZZ-701" })?.tier).toBe("high")
    expect(dangerOf("GET", "/projects/dddddddd-0000-4000-8000-000000000701")).toBeNull()
  })

  it("只精確比對 DELETE /projects/:id：刪專案文件維持原本的中風險；移除成員維持原本的最高風險", () => {
    expect(dangerOf("DELETE", "/projects/x/documents/d")?.tier).toBe("medium")
    expect(dangerOf("DELETE", "/projects/x/members/m")?.tier).toBe("high")
  })
})

describe("匯款付款同步（syncPaymentsOnPay）：期款所屬副委託已刪除", () => {
  const SUB = "f0000000-0000-4000-8000-000000000731"
  const PAY = "f0000000-0000-4000-8000-000000000732"
  const header = { id: "dddddddd-0000-4000-8000-0000000007d1", disbursement_no: "D-2026-001", paid_on: "2026-11-12", paying_company_id: COMPANY, receipt_issuer_company_id: null, receipt_ref: null }
  const allocs = [{ subcontract_payment_id: PAY, amount: 1000, withheld_amount: 0 }]
  const payment = () => fake.db.project_subcontract_payments!.find((p) => p.id === PAY)!
  beforeEach(() => {
    fake.db.project_subcontracts = [{ id: SUB, tenant_id: TENANT_ID, project_id: LIVE, deleted_at: null }]
    fake.db.project_subcontract_payments = [{
      id: PAY, tenant_id: TENANT_ID, subcontract_id: SUB, installment_no: 1, percentage: "100", amount: "1000", override_amount: null,
      override_reason: null, due_when: null, paid_on: null, paid_amount: null, withheld_amount: "0", paying_company_id: null,
      receipt_issuer_company_id: null, receipt_ref: null, disbursement_id: null, note: null,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    }]
  })

  it("副委託已軟刪除 → 寫入前就 409 subcontract_deleted，期款不動", async () => {
    fake.db.project_subcontracts![0]!.deleted_at = "2026-11-12T00:00:00.000Z"
    const err = await syncPaymentsOnPay(TENANT_ID, header, allocs).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DisbursementError)
    expect((err as DisbursementError).httpStatus).toBe(409)
    expect((err as DisbursementError).code).toBe("subcontract_deleted")
    expect(payment().paid_on).toBeNull()
  })

  it("檢查之後副委託才被刪（觸發器 RD409）→ 409 subcontract_deleted（不是 500、也沒有靜默吞掉付款）", async () => {
    fake.injectError({ table: "project_subcontract_payments", action: "update", error: { code: "RD409", message: "row_deleted: 副委託已刪除，不能再寫入期款的付款／驗收／金額" } })
    const err = await syncPaymentsOnPay(TENANT_ID, header, allocs).catch((e: unknown) => e)
    expect((err as DisbursementError).code).toBe("subcontract_deleted")
    expect((err as DisbursementError).httpStatus).toBe(409)
    expect(payment().paid_on).toBeNull()
  })

  it("撞到 PD409（專案剛被刪）→ 409 project_deleted", async () => {
    fake.injectError({ table: "project_subcontract_payments", action: "update", error: { code: "PD409", message: "project_deleted: 專案已刪除，不能再寫入 project_subcontract_payments" } })
    const err = await syncPaymentsOnPay(TENANT_ID, header, allocs).catch((e: unknown) => e)
    expect((err as DisbursementError).code).toBe("project_deleted")
  })

  it("對照組：副委託未刪除 → 正常寫入已付", async () => {
    expect(await syncPaymentsOnPay(TENANT_ID, header, allocs)).toEqual([PAY])
    expect(payment().paid_on).toBe("2026-11-12")
  })
})
