import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import {
  decideDisbursement,
  listPendingDisbursementApprovals,
  resetDisbursementApprovalProbe,
  submitDisbursement,
} from "../services/disbursement-approval.js"
import { DisbursementError } from "../services/disbursements.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 放款單的老闆關也派給平台管理員（2026-10-27 業主：平台管理員就是老闆）——
 * 與假單同一套判斷（services/approval-steps.ts stepActorStanding／stepNotifyRecipients）：
 * 老闆本人或任一在職 platform_admin 可簽、一人簽即過；通知老闆＋所有在職 platform_admin（不含建單人）；
 * 建單人本人不能簽自己單的老闆關；hr_admin 不放寬。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const BOSS = "eeeeeeee-0000-4000-8000-000000000001"
const PA = "eeeeeeee-0000-4000-8000-000000000002"
const PA2 = "eeeeeeee-0000-4000-8000-000000000003"
const HR = "eeeeeeee-0000-4000-8000-000000000004"
const CLERK = "eeeeeeee-0000-4000-8000-000000000005"
const DISB = "ffffffff-0000-4000-8000-000000000001"

const employee = (id: string, role: string, name: string): Row => ({
  id,
  tenant_id: TENANT_ID,
  user_id: `user-${id.slice(-4)}`,
  role,
  name,
  emp_no: null,
  dept_id: null,
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
})

const draft = (createdBy: string): Row => ({
  id: DISB,
  tenant_id: TENANT_ID,
  disbursement_no: "D-2027-001",
  status: "draft",
  payee_kind: "other",
  vendor_id: null,
  payee_name: "測試收款方",
  amount: 1000,
  withheld_amount: 0,
  purpose: "測試",
  note: null,
  created_by_emp_id: createdBy,
  created_at: "2027-01-01T00:00:00.000Z",
  updated_at: "2027-01-01T00:00:00.000Z",
  current_step: null,
  approval_round: 0,
  submitted_at: null,
  submitted_by_emp_id: null,
  approved_at: null,
})

beforeEach(() => {
  fake.reset()
  resetDisbursementApprovalProbe()
  fake.db.employees = [
    employee(BOSS, "employee", "老闆大頭"),
    employee(PA, "platform_admin", "平台管理員一號"),
    employee(PA2, "platform_admin", "平台管理員二號"),
    employee(HR, "hr_admin", "HR 小花"),
    employee(CLERK, "employee", "承辦小明"),
  ]
  fake.db.departments = []
  fake.db.tenants = [{ id: TENANT_ID, features: { approval: { fallbackApproverEmpId: BOSS } } }]
  fake.db.approval_flows = []
  fake.db.disbursement_approval_steps = []
  fake.db.disbursement_allocations = []
})

const noticesTo = (id: string) => (fake.db.notifications ?? []).filter((n) => n.employee_id === id)
const steps = () => (fake.db.disbursement_approval_steps ?? []) as Row[]
const header = () => (fake.db.disbursements ?? []).find((d) => d.id === DISB) as Row

async function submittedBy(creator: string, role: string) {
  fake.db.disbursements = [draft(creator)]
  const out = await submitDisbursement(TENANT_ID, { empId: creator, role }, DISB)
  expect(out?.steps.map((s) => s.kind)).toEqual(["fallback"])
}

describe("放款單老闆關：平台管理員也可簽", () => {
  it("送簽 → 通知老闆＋兩位 platform_admin（不含建單人）；兩位都在待簽清單", async () => {
    await submittedBy(CLERK, "employee")
    expect(noticesTo(BOSS)).toHaveLength(1)
    expect(noticesTo(PA)).toHaveLength(1)
    expect(noticesTo(PA2)).toHaveLength(1)
    expect(noticesTo(HR)).toHaveLength(0)
    expect(String(noticesTo(PA)[0].body)).toContain("老闆或任一位平台管理員")

    const list = await listPendingDisbursementApprovals(TENANT_ID, { empId: PA, role: "platform_admin" })
    expect(list.map((d) => [d.id, d.mine])).toEqual([[DISB, true]])
    expect(await listPendingDisbursementApprovals(TENANT_ID, { empId: HR, role: "hr_admin" })).toEqual([])
  })

  it("platform_admin 核准 → 一人簽即核准；approver_emp_id／acted_by_emp_id 記實際簽的人", async () => {
    await submittedBy(CLERK, "employee")
    const out = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { empId: PA, role: "platform_admin" } })
    expect(out?.status).toBe("approved")
    expect(header().status).toBe("approved")
    expect(steps()[0]).toMatchObject({ decision: "approved", approver_emp_id: PA, acted_by_emp_id: PA })
    const audit = (fake.db.audit_logs ?? []).find((r) => r.record_id === DISB && r.context === "POST /disbursements/:id/approve")
    expect(audit?.new_row).toMatchObject({ byProxy: false, bossByPlatformAdmin: true })
  })

  it("hr_admin 不能 HR 代簽老闆關（2026-10-27 業主追加 C）→ 403 not_current_approver", async () => {
    await submittedBy(CLERK, "employee")
    const err = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { empId: HR, role: "hr_admin" } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DisbursementError)
    expect((err as DisbursementError).code).toBe("not_current_approver")
    expect(steps()[0]).toMatchObject({ decision: "pending", approver_emp_id: BOSS })
    expect(header().status).toBe("pending_approval")
  })

  it("platform_admin 自己建的單：不通知自己、清單看不到、簽了 403 own_request；另一位可簽", async () => {
    await submittedBy(PA, "platform_admin")
    expect(noticesTo(PA).filter((n) => String(n.title).startsWith("待簽核"))).toHaveLength(0)
    expect(noticesTo(PA2)).toHaveLength(1)
    expect(await listPendingDisbursementApprovals(TENANT_ID, { empId: PA, role: "platform_admin" })).toEqual([])

    const err = await decideDisbursement({
      action: "approve",
      tenantId: TENANT_ID,
      id: DISB,
      actor: { empId: PA, role: "platform_admin" },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DisbursementError)
    expect((err as DisbursementError).code).toBe("own_request")
    expect((err as DisbursementError).httpStatus).toBe(403)
    expect(header().status).toBe("pending_approval")

    const ok = await decideDisbursement({ action: "approve", tenantId: TENANT_ID, id: DISB, actor: { empId: PA2, role: "platform_admin" } })
    expect(ok?.status).toBe("approved")
  })
})
