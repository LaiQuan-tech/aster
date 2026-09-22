import { describe, it, expect } from "vitest"
import { pickApproverChain, normaliseMode, type ChainCandidates } from "../services/approval-chain"
import { managerChainFromDepartments } from "../middleware/scope"
import { stepCandidates, isStepCandidate } from "../services/approval-steps"
import { buildNotificationRows } from "../services/notify"

/**
 * 簽核鏈純函式（services/approval-chain.ts pickApproverChain）——多級簽核版：
 *   list       固定名單逐關
 *   manager    主管鏈第一位 → 老闆（fallback）→ 第一位 hr_admin → no_approver_available
 *   manager_hr 主管鏈全部逐關（沒有 → 老闆當主管關 → 沒有就不放）＋ HR 覆核關（全部 hr_admin）
 * 回傳形狀 { ok, steps: [{ candidateEmpIds, kind }], source }。不碰 DB。
 */

const EMP = "00000000-0000-4000-8000-00000000e001"
const MGR = "00000000-0000-4000-8000-00000000a001"
const MGR2 = "00000000-0000-4000-8000-00000000a002"
const MGR3 = "00000000-0000-4000-8000-00000000a003"
const BOSS = "00000000-0000-4000-8000-00000000b001"
const HR1 = "00000000-0000-4000-8000-00000000c001"
const HR2 = "00000000-0000-4000-8000-00000000c002"
const L1 = "00000000-0000-4000-8000-00000000d001"
const L2 = "00000000-0000-4000-8000-00000000d002"

function base(over: Partial<ChainCandidates> = {}): ChainCandidates {
  return {
    employeeId: EMP,
    flow: null,
    managerEmpIds: [],
    fallbackApproverEmpId: null,
    hrAdminEmpIds: [],
    ...over,
  }
}

const one = (id: string, kind: string) => ({ candidateEmpIds: [id], kind })

describe("pickApproverChain — list / manager", () => {
  it("① flow mode=list 且名單非空 → 名單依序多關（去重、kind=list），其他來源全部忽略", () => {
    const r = pickApproverChain(
      base({
        flow: { mode: "list", approverEmpIds: [L1, L2, L1] },
        managerEmpIds: [MGR, MGR2],
        fallbackApproverEmpId: BOSS,
        hrAdminEmpIds: [HR1],
      }),
    )
    expect(r).toEqual({ ok: true, steps: [one(L1, "list"), one(L2, "list")], source: "list" })
  })

  it("② 無 flow → 直屬主管單關＝主管鏈第一位（大主管不入鏈）", () => {
    const r = pickApproverChain(base({ managerEmpIds: [MGR, MGR2], fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] }))
    expect(r).toEqual({ ok: true, steps: [one(MGR, "manager")], source: "manager" })
  })

  it("②' flow mode=manager 即使有名單也走直屬主管；mode=list 但名單空也走直屬主管", () => {
    expect(
      pickApproverChain(base({ flow: { mode: "manager", approverEmpIds: [L1] }, managerEmpIds: [MGR] })),
    ).toEqual({ ok: true, steps: [one(MGR, "manager")], source: "manager" })
    expect(
      pickApproverChain(base({ flow: { mode: "list", approverEmpIds: [] }, managerEmpIds: [MGR] })),
    ).toEqual({ ok: true, steps: [one(MGR, "manager")], source: "manager" })
  })

  it("③ 無主管 → 老闆（fallback）；老闆就是申請人本人時跳過", () => {
    expect(pickApproverChain(base({ fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] }))).toEqual({
      ok: true,
      steps: [one(BOSS, "fallback")],
      source: "fallback",
    })
    expect(
      pickApproverChain(base({ employeeId: BOSS, fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] })),
    ).toEqual({ ok: true, steps: [one(HR1, "hr_admin")], source: "hr_admin" })
  })

  it("④ 主管與老闆都沒有 → 第一位 hr_admin；HR 自己請假且有第二位 HR 時避開本人", () => {
    expect(pickApproverChain(base({ hrAdminEmpIds: [HR1, HR2] }))).toEqual({
      ok: true,
      steps: [one(HR1, "hr_admin")],
      source: "hr_admin",
    })
    expect(pickApproverChain(base({ employeeId: HR1, hrAdminEmpIds: [HR1, HR2] }))).toEqual({
      ok: true,
      steps: [one(HR2, "hr_admin")],
      source: "hr_admin",
    })
    // 只有一位 HR 而 HR 自己請假：沒別人能簽，仍讓單能走。
    expect(pickApproverChain(base({ employeeId: HR1, hrAdminEmpIds: [HR1] }))).toEqual({
      ok: true,
      steps: [one(HR1, "hr_admin")],
      source: "hr_admin",
    })
  })

  it("⑤ 四層都空 → no_approver_available；主管鏈只有本人（資料異常）也不算主管", () => {
    expect(pickApproverChain(base())).toEqual({ ok: false, error: "no_approver_available" })
    expect(pickApproverChain(base({ managerEmpIds: [EMP] }))).toEqual({ ok: false, error: "no_approver_available" })
  })
})

describe("pickApproverChain — manager_hr（主管逐級 → HR 覆核）", () => {
  const flow = { mode: "manager_hr" as const, approverEmpIds: [] }

  it("三關：小主管、大主管各一關（kind=manager）＋ HR 群一關（kind=hr，含兩位 HR）；source=manager_hr", () => {
    const r = pickApproverChain(base({ flow, managerEmpIds: [MGR, MGR2], fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1, HR2] }))
    expect(r).toEqual({
      ok: true,
      steps: [one(MGR, "manager"), one(MGR2, "manager"), { candidateEmpIds: [HR1, HR2], kind: "hr" }],
      source: "manager_hr",
    })
  })

  it("主管鏈順序照給的順序（三層），名單（approverEmpIds）在此模式不生效", () => {
    const r = pickApproverChain(base({ flow: { ...flow, approverEmpIds: [L1] }, managerEmpIds: [MGR3, MGR, MGR2], hrAdminEmpIds: [HR1] }))
    expect(r.ok && r.steps.map((s) => s.candidateEmpIds[0])).toEqual([MGR3, MGR, MGR2, HR1])
  })

  it("HR 群排除申請人本人與前面關卡已出現的人（主管同時是 HR）", () => {
    // MGR 同時是 hr_admin → HR 關只剩 HR1、HR2
    const r = pickApproverChain(base({ flow, managerEmpIds: [MGR], hrAdminEmpIds: [MGR, HR1, HR2] }))
    expect(r).toEqual({ ok: true, steps: [one(MGR, "manager"), { candidateEmpIds: [HR1, HR2], kind: "hr" }], source: "manager_hr" })
    // 申請人自己是 HR → HR 關排除自己
    const self = pickApproverChain(base({ employeeId: HR1, flow, managerEmpIds: [MGR], hrAdminEmpIds: [HR1, HR2] }))
    expect(self).toEqual({ ok: true, steps: [one(MGR, "manager"), { candidateEmpIds: [HR2], kind: "hr" }], source: "manager_hr" })
  })

  it("排除後沒人 → 不排除（唯一的 HR 就是主管本人，仍讓單能走）", () => {
    const r = pickApproverChain(base({ flow, managerEmpIds: [MGR], hrAdminEmpIds: [MGR] }))
    expect(r).toEqual({ ok: true, steps: [one(MGR, "manager"), { candidateEmpIds: [MGR], kind: "hr" }], source: "manager_hr" })
    const onlySelf = pickApproverChain(base({ employeeId: HR1, flow, managerEmpIds: [], hrAdminEmpIds: [HR1] }))
    expect(onlySelf).toEqual({ ok: true, steps: [{ candidateEmpIds: [HR1], kind: "hr" }], source: "manager_hr" })
  })

  it("沒有主管 → 老闆當唯一主管關（kind=fallback）再 HR 覆核", () => {
    const r = pickApproverChain(base({ flow, managerEmpIds: [], fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1, HR2] }))
    expect(r).toEqual({ ok: true, steps: [one(BOSS, "fallback"), { candidateEmpIds: [HR1, HR2], kind: "hr" }], source: "manager_hr" })
    // 老闆就是申請人 → 跳過老闆，只剩 HR 關
    const bossSelf = pickApproverChain(base({ employeeId: BOSS, flow, fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] }))
    expect(bossSelf).toEqual({ ok: true, steps: [{ candidateEmpIds: [HR1], kind: "hr" }], source: "manager_hr" })
  })

  it("沒有老闆也沒主管 → 只剩 HR 關", () => {
    const r = pickApproverChain(base({ flow, hrAdminEmpIds: [HR1, HR2] }))
    expect(r).toEqual({ ok: true, steps: [{ candidateEmpIds: [HR1, HR2], kind: "hr" }], source: "manager_hr" })
  })

  it("hr_admin 為空 → 只有主管關（不放空的 HR 關）；主管鏈也空 → no_approver_available", () => {
    const r = pickApproverChain(base({ flow, managerEmpIds: [MGR, MGR2], hrAdminEmpIds: [] }))
    expect(r).toEqual({ ok: true, steps: [one(MGR, "manager"), one(MGR2, "manager")], source: "manager_hr" })
    expect(pickApproverChain(base({ flow }))).toEqual({ ok: false, error: "no_approver_available" })
  })

  it("主管鏈去重、跳過本人；候選 id 空字串被濾掉", () => {
    const r = pickApproverChain(base({ flow, managerEmpIds: [MGR, EMP, MGR, "", MGR2], hrAdminEmpIds: ["", HR1] }))
    expect(r.ok && r.steps).toEqual([one(MGR, "manager"), one(MGR2, "manager"), { candidateEmpIds: [HR1], kind: "hr" }])
  })

  it("mode=manager 對同一組資料只取第一位主管（單關）", () => {
    const r = pickApproverChain(base({ flow: { mode: "manager", approverEmpIds: [] }, managerEmpIds: [MGR, MGR2], hrAdminEmpIds: [HR1, HR2] }))
    expect(r).toEqual({ ok: true, steps: [one(MGR, "manager")], source: "manager" })
  })
})

describe("normaliseMode — DB 值 → 型別", () => {
  it("三個合法值原樣保留（manager_hr 不再被打回 list）；其餘（null／怪值）→ list", () => {
    expect(normaliseMode("manager")).toBe("manager")
    expect(normaliseMode("list")).toBe("list")
    expect(normaliseMode("manager_hr")).toBe("manager_hr")
    expect(normaliseMode(null)).toBe("list")
    expect(normaliseMode("bogus")).toBe("list")
  })
})

describe("managerChainFromDepartments — 部門有序多主管 → 主管鏈", () => {
  const ROOT = "dept-root"
  const A = "dept-a"
  const B = "dept-b"
  const depts = [
    { id: ROOT, parent_id: null, manager_emp_ids: [BOSS] },
    { id: A, parent_id: ROOT, manager_emp_ids: [MGR, MGR2] },
    { id: B, parent_id: A, manager_emp_ids: [MGR3, MGR] },
  ]

  it("本部門依序 → 母部門 → 根；跨層重複的人只算第一次", () => {
    expect(managerChainFromDepartments(depts, B, EMP)).toEqual([MGR3, MGR, MGR2, BOSS])
    expect(managerChainFromDepartments(depts, A, EMP)).toEqual([MGR, MGR2, BOSS])
  })

  it("跳過本人：小主管自己送單 → 從同部門下一位開始", () => {
    expect(managerChainFromDepartments(depts, A, MGR)).toEqual([MGR2, BOSS])
    expect(managerChainFromDepartments(depts, ROOT, BOSS)).toEqual([])
  })

  it("無部門／部門不在清單 → 空；parent_id 成環不會無窮迴圈", () => {
    expect(managerChainFromDepartments(depts, null, EMP)).toEqual([])
    expect(managerChainFromDepartments(depts, "dept-missing", EMP)).toEqual([])
    const cyclic = [
      { id: A, parent_id: B, manager_emp_ids: [MGR] },
      { id: B, parent_id: A, manager_emp_ids: [MGR2] },
    ]
    expect(managerChainFromDepartments(cyclic, A, EMP)).toEqual([MGR, MGR2])
  })
})

describe("approval-steps — 候選判斷", () => {
  it("candidate_emp_ids 空／null → 只有 approver；有陣列則整組（approver 不在陣列時排最前）", () => {
    expect(stepCandidates({ approver_emp_id: MGR })).toEqual([MGR])
    expect(stepCandidates({ approver_emp_id: MGR, candidate_emp_ids: null })).toEqual([MGR])
    expect(stepCandidates({ approver_emp_id: HR1, candidate_emp_ids: [HR1, HR2] })).toEqual([HR1, HR2])
    expect(stepCandidates({ approver_emp_id: HR2, candidate_emp_ids: [HR1, HR2, HR1] })).toEqual([HR1, HR2])
    expect(stepCandidates({ approver_emp_id: MGR, candidate_emp_ids: [HR1] })).toEqual([MGR, HR1])
  })

  it("isStepCandidate：approver 或候選內為 true，其餘 false", () => {
    const step = { approver_emp_id: HR1, candidate_emp_ids: [HR1, HR2] }
    expect(isStepCandidate(step, HR1)).toBe(true)
    expect(isStepCandidate(step, HR2)).toBe(true)
    expect(isStepCandidate(step, MGR)).toBe(false)
  })
})

describe("notify.buildNotificationRows — 入列列形狀", () => {
  it("channel=inapp、status=pending、收件人去重；env 沒設 NOTIFICATION_DEFAULT_CHANNELS 就不帶 payload.channels", () => {
    const prev = process.env.NOTIFICATION_DEFAULT_CHANNELS
    delete process.env.NOTIFICATION_DEFAULT_CHANNELS
    try {
      const rows = buildNotificationRows({
        tenantId: "t1",
        employeeIds: [MGR, MGR, ""],
        type: "approval",
        title: "待簽核",
        payload: { event: "submitted" },
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tenant_id: "t1",
        employee_id: MGR,
        type: "approval",
        title: "待簽核",
        body: null,
        channel: "inapp",
        status: "pending",
        payload: { event: "submitted" },
      })
      expect((rows[0].payload as Record<string, unknown>).channels).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env.NOTIFICATION_DEFAULT_CHANNELS = prev
    }
  })

  it("env NOTIFICATION_DEFAULT_CHANNELS=email, line → payload.channels 釘死；不合法值被濾掉", () => {
    const prev = process.env.NOTIFICATION_DEFAULT_CHANNELS
    process.env.NOTIFICATION_DEFAULT_CHANNELS = "Email, line ,sms"
    try {
      const rows = buildNotificationRows({ tenantId: "t1", employeeIds: [EMP], type: "approval", title: "x" })
      expect((rows[0].payload as Record<string, unknown>).channels).toEqual(["email", "line"])
    } finally {
      if (prev === undefined) delete process.env.NOTIFICATION_DEFAULT_CHANNELS
      else process.env.NOTIFICATION_DEFAULT_CHANNELS = prev
    }
  })
})
