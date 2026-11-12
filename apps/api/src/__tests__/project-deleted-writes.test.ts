import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { createDisbursement, DisbursementError, type DisbursementInput } from "../services/disbursements.js"
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
})
