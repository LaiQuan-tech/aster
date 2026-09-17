import { describe, it, expect } from "vitest"
import { mergeEnrichment, emptyLookups, type EnrichLookups, type EnrichStep } from "../services/request-enrich.js"

// Pure — no DB. 申請單列表補齊欄位的對照邏輯（ESS「我的申請」要顯示假別名、
// 等待誰簽／第幾關、駁回理由、附件數）。

const EMP = "emp-alice"
const MGR = "emp-mona"
const HR = "emp-hr"
const ANNUAL = "lt-annual"
const SICK = "lt-sick"

function lookups(overrides: Partial<EnrichLookups> = {}): EnrichLookups {
  return {
    employeesById: new Map([
      [EMP, { name: "Alice One", emp_no: "A001" }],
      [MGR, { name: "Mona Manager", emp_no: "M001" }],
      [HR, { name: "HR Admin", emp_no: null }],
    ]),
    leaveTypesById: new Map([
      [ANNUAL, { name: "特休", requires_attachment: false }],
      [SICK, { name: "病假", requires_attachment: true }],
    ]),
    attachmentCountByRequest: new Map(),
    stepsByRequest: new Map(),
    ...overrides,
  }
}

function step(partial: Partial<EnrichStep> & { step_order: number; approver_emp_id: string }): EnrichStep {
  return { decision: "pending", comment: null, acted_at: null, ...partial }
}

const baseRow = {
  id: "req-1",
  employee_id: EMP,
  leave_type_id: ANNUAL as string | null,
  kind: "leave",
  status: "pending",
  current_step: 1,
  reason: "family",
}

describe("mergeEnrichment — 申請單列表補齊", () => {
  it("pending 單關：等待第 1 關簽核者，決定欄位皆 null，既有欄位原樣保留", () => {
    const [row] = mergeEnrichment([baseRow], lookups({ stepsByRequest: new Map([["req-1", [step({ step_order: 1, approver_emp_id: MGR })]]]) }))
    expect(row.employee_name).toBe("Alice One")
    expect(row.leave_type_name).toBe("特休")
    expect(row.requires_attachment).toBe(false)
    expect(row.attachment_count).toBe(0)
    expect(row.total_steps).toBe(1)
    expect(row.current_approver_emp_id).toBe(MGR)
    expect(row.current_approver_name).toBe("Mona Manager")
    expect(row.decision_comment).toBeNull()
    expect(row.decided_at).toBeNull()
    // superset: nothing dropped or renamed
    expect(row.reason).toBe("family")
    expect(row.kind).toBe("leave")
    expect(row.status).toBe("pending")
  })

  it("多關 pending 在第 2 關：current_approver 取 step_order = current_step 那關，total_steps = 3", () => {
    const steps = [
      step({ step_order: 1, approver_emp_id: MGR, decision: "approved", comment: "ok", acted_at: "2026-09-01T01:00:00.000Z" }),
      step({ step_order: 2, approver_emp_id: HR }),
      step({ step_order: 3, approver_emp_id: EMP }),
    ]
    const [row] = mergeEnrichment([{ ...baseRow, current_step: 2 }], lookups({ stepsByRequest: new Map([["req-1", steps]]) }))
    expect(row.total_steps).toBe(3)
    expect(row.current_approver_emp_id).toBe(HR)
    expect(row.current_approver_name).toBe("HR Admin")
    // 仍 pending → 不把第 1 關的核准意見當最終結果
    expect(row.decision_comment).toBeNull()
    expect(row.decided_at).toBeNull()
  })

  it("approved 多關：decision_comment／decided_at 取最後一關核准的", () => {
    const steps = [
      step({ step_order: 1, approver_emp_id: MGR, decision: "approved", comment: "first", acted_at: "2026-09-01T01:00:00.000Z" }),
      step({ step_order: 2, approver_emp_id: HR, decision: "approved", comment: "final", acted_at: "2026-09-02T02:00:00.000Z" }),
    ]
    const [row] = mergeEnrichment(
      [{ ...baseRow, status: "approved", current_step: 2 }],
      lookups({ stepsByRequest: new Map([["req-1", steps]]) }),
    )
    expect(row.decision_comment).toBe("final")
    expect(row.decided_at).toBe("2026-09-02T02:00:00.000Z")
    expect(row.current_approver_emp_id).toBe(HR)
    expect(row.total_steps).toBe(2)
  })

  it("rejected 在第 1 關（共 2 關）：取駁回那關的理由與時間", () => {
    const steps = [
      step({ step_order: 1, approver_emp_id: MGR, decision: "rejected", comment: "資料不齊", acted_at: "2026-09-03T03:00:00.000Z" }),
      step({ step_order: 2, approver_emp_id: HR }),
    ]
    const [row] = mergeEnrichment(
      [{ ...baseRow, status: "rejected", current_step: 1 }],
      lookups({ stepsByRequest: new Map([["req-1", steps]]) }),
    )
    expect(row.decision_comment).toBe("資料不齊")
    expect(row.decided_at).toBe("2026-09-03T03:00:00.000Z")
    expect(row.total_steps).toBe(2)
    expect(row.current_approver_name).toBe("Mona Manager")
  })

  it("approved 但簽核者沒填意見：decision_comment null、decided_at 仍有值", () => {
    const steps = [step({ step_order: 1, approver_emp_id: MGR, decision: "approved", comment: null, acted_at: "2026-09-04T04:00:00.000Z" })]
    const [row] = mergeEnrichment([{ ...baseRow, status: "approved" }], lookups({ stepsByRequest: new Map([["req-1", steps]]) }))
    expect(row.decision_comment).toBeNull()
    expect(row.decided_at).toBe("2026-09-04T04:00:00.000Z")
  })

  it("無假別（加班單）：leave_type_name null、requires_attachment false", () => {
    const [row] = mergeEnrichment(
      [{ ...baseRow, id: "req-ot", kind: "ot", leave_type_id: null }],
      lookups({ stepsByRequest: new Map([["req-ot", [step({ step_order: 1, approver_emp_id: MGR })]]]) }),
    )
    expect(row.leave_type_name).toBeNull()
    expect(row.requires_attachment).toBe(false)
  })

  it("必附憑證假別＋附件數：requires_attachment true、attachment_count 3", () => {
    const [row] = mergeEnrichment(
      [{ ...baseRow, leave_type_id: SICK }],
      lookups({
        attachmentCountByRequest: new Map([["req-1", 3]]),
        stepsByRequest: new Map([["req-1", [step({ step_order: 1, approver_emp_id: MGR })]]]),
      }),
    )
    expect(row.leave_type_name).toBe("病假")
    expect(row.requires_attachment).toBe(true)
    expect(row.attachment_count).toBe(3)
  })

  it("空 lookups 退化：名稱 null／0／false，total_steps 退回 current_step，不丟例外", () => {
    const [row] = mergeEnrichment([{ ...baseRow, current_step: 2 }], emptyLookups())
    expect(row.employee_name).toBeNull()
    expect(row.leave_type_name).toBeNull()
    expect(row.requires_attachment).toBe(false)
    expect(row.attachment_count).toBe(0)
    expect(row.total_steps).toBe(2)
    expect(row.current_approver_emp_id).toBeNull()
    expect(row.current_approver_name).toBeNull()
    expect(row.decision_comment).toBeNull()
    expect(row.decided_at).toBeNull()
    expect(row.id).toBe("req-1")
  })

  it("cancelled：決定欄位 null；簽核者不在 employees 對照表時只有 name 為 null，id 仍給", () => {
    const steps = [step({ step_order: 1, approver_emp_id: "emp-gone" })]
    const [row] = mergeEnrichment(
      [{ ...baseRow, status: "cancelled", employee_id: "emp-unknown" }],
      lookups({ stepsByRequest: new Map([["req-1", steps]]) }),
    )
    expect(row.employee_name).toBeNull()
    expect(row.current_approver_emp_id).toBe("emp-gone")
    expect(row.current_approver_name).toBeNull()
    expect(row.decision_comment).toBeNull()
    expect(row.decided_at).toBeNull()
  })

  it("多列各自對照，不互相汙染", () => {
    const rows = [
      { ...baseRow, id: "a" },
      { ...baseRow, id: "b", status: "rejected", leave_type_id: SICK },
    ]
    const out = mergeEnrichment(
      rows,
      lookups({
        attachmentCountByRequest: new Map([["b", 1]]),
        stepsByRequest: new Map([
          ["a", [step({ step_order: 1, approver_emp_id: MGR })]],
          ["b", [step({ step_order: 1, approver_emp_id: HR, decision: "rejected", comment: "no", acted_at: "2026-09-05T05:00:00.000Z" })]],
        ]),
      }),
    )
    expect(out.map((r) => r.id)).toEqual(["a", "b"])
    expect(out[0].attachment_count).toBe(0)
    expect(out[0].decision_comment).toBeNull()
    expect(out[0].current_approver_name).toBe("Mona Manager")
    expect(out[1].attachment_count).toBe(1)
    expect(out[1].decision_comment).toBe("no")
    expect(out[1].leave_type_name).toBe("病假")
    expect(out[1].current_approver_name).toBe("HR Admin")
  })
})
