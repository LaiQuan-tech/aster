import { describe, it, expect } from "vitest"
import { pickDisbursementChain, type ChainCandidates } from "../services/approval-chain"
import {
  buildStepRows,
  currentStepOf,
  serializeApprovalStep,
  type DisbursementStepRow,
} from "../services/disbursement-approval"
import { assertForcePayAllowed, DisbursementError, type Actor } from "../services/disbursements"

/**
 * M4 放款簽核鏈的純函式（不碰 DB）：
 *   pickDisbursementChain → buildStepRows   送出時要寫進 disbursement_approval_steps 的列
 *   currentStepOf                            「現在輪到誰」＝(round, step_order) 那一列
 *   serializeApprovalStep                    簽核軌跡回前端的形狀
 *   assertForcePayAllowed                    跳過簽核直接付款＝HR ＋ 理由
 * IO 路徑（送簽／核准／駁回／撤回）在 disbursement-approval-live.test.ts。
 */

const TENANT = "00000000-0000-4000-8000-0000000000a1"
const DISB = "00000000-0000-4000-8000-00000000d001"
const EMP = "00000000-0000-4000-8000-00000000e001"
const MGR = "00000000-0000-4000-8000-00000000a001"
const BOSS = "00000000-0000-4000-8000-00000000b001"
const HR1 = "00000000-0000-4000-8000-00000000c001"
const ACC1 = "00000000-0000-4000-8000-00000000f001"
const ACC2 = "00000000-0000-4000-8000-00000000f002"

function candidates(over: Partial<ChainCandidates> = {}): ChainCandidates {
  return {
    employeeId: EMP,
    flow: null,
    managerEmpIds: [],
    fallbackApproverEmpId: null,
    hrAdminEmpIds: [],
    accountantEmpIds: [],
    ...over,
  }
}

function rowsFor(c: ChainCandidates, round = 1) {
  const chain = pickDisbursementChain(c)
  if (!chain.ok) throw new Error(`chain failed: ${chain.error}`)
  return buildStepRows(TENANT, DISB, round, chain.steps)
}

describe("送簽：pickDisbursementChain → buildStepRows", () => {
  it("主管×1＋會計×2＋老闆 → 3 關；第 2 關候選 2 人、approver_emp_id 取第一候選", () => {
    const rows = rowsFor(
      candidates({ managerEmpIds: [MGR], accountantEmpIds: [ACC1, ACC2], fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] }),
    )
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => [r.step_order, r.step_kind, r.approver_emp_id])).toEqual([
      [1, "manager", MGR],
      [2, "accountant", ACC1],
      [3, "fallback", BOSS],
    ])
    expect(rows[1].candidate_emp_ids).toEqual([ACC1, ACC2])
    expect(rows.every((r) => r.decision === "pending" && r.round === 1 && r.disbursement_id === DISB && r.tenant_id === TENANT)).toBe(true)
  })

  it("建單人是老闆 → 老闆關跳過（只剩主管＋會計兩關）", () => {
    const rows = rowsFor(
      candidates({ employeeId: BOSS, managerEmpIds: [MGR], accountantEmpIds: [ACC1, ACC2], fallbackApproverEmpId: BOSS }),
    )
    expect(rows.map((r) => r.step_kind)).toEqual(["manager", "accountant"])
    expect(rows.some((r) => r.approver_emp_id === BOSS)).toBe(false)
  })

  it("駁回後重送：round 遞增，step_order 從 1 重新編（舊輪留著當軌跡）", () => {
    const c = candidates({ managerEmpIds: [MGR], accountantEmpIds: [ACC1], fallbackApproverEmpId: BOSS })
    expect(rowsFor(c, 2).map((r) => [r.round, r.step_order])).toEqual([
      [2, 1],
      [2, 2],
      [2, 3],
    ])
  })

  it("誰都沒有 → no_approver_available（送簽被擋，不會留下沒人能簽的單）", () => {
    expect(pickDisbursementChain(candidates())).toEqual({ ok: false, error: "no_approver_available" })
  })
})

function step(over: Partial<DisbursementStepRow> = {}): DisbursementStepRow {
  return {
    id: "step-1",
    tenant_id: TENANT,
    disbursement_id: DISB,
    round: 1,
    step_order: 1,
    approver_emp_id: MGR,
    candidate_emp_ids: [MGR],
    step_kind: "manager",
    decision: "pending",
    comment: null,
    acted_at: null,
    acted_by_emp_id: null,
    created_at: "2026-09-23T00:00:00.000Z",
    ...over,
  }
}

describe("currentStepOf — 現在輪到哪一關", () => {
  const rows = [
    step({ id: "r1s1", round: 1, step_order: 1, decision: "pending" }),
    step({ id: "r1s2", round: 1, step_order: 2, decision: "pending" }),
    step({ id: "r2s1", round: 2, step_order: 1, decision: "approved" }),
    step({ id: "r2s2", round: 2, step_order: 2, decision: "pending" }),
  ]

  it("只認 (approval_round, current_step)——撤回留下的第 1 輪待簽列不會被誤認", () => {
    expect(currentStepOf({ approval_round: 2, current_step: 2 }, rows)?.id).toBe("r2s2")
    expect(currentStepOf({ approval_round: 1, current_step: 1 }, rows)?.id).toBe("r1s1")
  })

  it("current_step 為 null（草稿／已核准）→ 沒有現行關卡", () => {
    expect(currentStepOf({ approval_round: 2, current_step: null }, rows)).toBeNull()
    expect(currentStepOf({ approval_round: 3, current_step: 1 }, rows)).toBeNull()
  })
})

describe("serializeApprovalStep — 簽核軌跡形狀", () => {
  it("候選含 approver_emp_id、姓名查得到就帶、代簽時 actedBy 與 approver 不同人", () => {
    const names = new Map([
      [ACC1, "會計甲"],
      [ACC2, "會計乙"],
      [HR1, "人資"],
    ])
    const out = serializeApprovalStep(
      step({
        step_order: 2,
        step_kind: "accountant",
        approver_emp_id: ACC1,
        candidate_emp_ids: [ACC1, ACC2],
        decision: "approved",
        comment: "OK",
        acted_at: "2026-09-23T02:00:00.000Z",
        acted_by_emp_id: HR1,
      }),
      names,
    )
    expect(out.candidateEmpIds).toEqual([ACC1, ACC2])
    expect(out.candidateNames).toEqual(["會計甲", "會計乙"])
    expect(out.approverName).toBe("會計甲")
    expect(out.actedByName).toBe("人資")
    expect(out.decision).toBe("approved")
  })

  it("candidate_emp_ids 是 null（舊列）→ 候選只有 approver_emp_id 一人", () => {
    const out = serializeApprovalStep(step({ candidate_emp_ids: null }), new Map())
    expect(out.candidateEmpIds).toEqual([MGR])
    expect(out.approverName).toBeNull()
    expect(out.actedByName).toBeNull()
  })
})

describe("assertForcePayAllowed — 跳過簽核直接付款", () => {
  const hr: Actor = { empId: HR1, role: "hr_admin" }

  it("HR ＋ 理由 → 通過並回 trim 後的理由", () => {
    expect(assertForcePayAllowed(hr, "  廠商急件，老闆口頭核准  ")).toBe("廠商急件，老闆口頭核准")
  })

  it("HR 沒填理由 → 400 force_reason_required", () => {
    for (const reason of [undefined, null, "", "   "]) {
      expect(() => assertForcePayAllowed(hr, reason)).toThrowError(
        expect.objectContaining({ httpStatus: 400, code: "force_reason_required" }) as unknown as Error,
      )
    }
  })

  it("會計／一般員工即使填了理由也不行 → 409 approval_required", () => {
    for (const role of ["accountant", "employee", "manager", null]) {
      try {
        assertForcePayAllowed({ empId: EMP, role }, "理由")
        throw new Error("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(DisbursementError)
        expect((err as DisbursementError).httpStatus).toBe(409)
        expect((err as DisbursementError).code).toBe("approval_required")
      }
    }
  })
})
