import { describe, it, expect } from "vitest"
import { pickApproverChain, type ChainCandidates } from "../services/approval-chain"
import { buildNotificationRows } from "../services/notify"

/**
 * 簽核鏈純函式（services/approval-chain.ts pickApproverChain）：
 * 固定名單 → 直屬主管 → 老闆（fallback）→ 第一位 hr_admin → no_approver_available。
 * 不碰 DB。
 */

const EMP = "00000000-0000-4000-8000-00000000e001"
const MGR = "00000000-0000-4000-8000-00000000a001"
const BOSS = "00000000-0000-4000-8000-00000000b001"
const HR1 = "00000000-0000-4000-8000-00000000c001"
const HR2 = "00000000-0000-4000-8000-00000000c002"
const L1 = "00000000-0000-4000-8000-00000000d001"
const L2 = "00000000-0000-4000-8000-00000000d002"

function base(over: Partial<ChainCandidates> = {}): ChainCandidates {
  return {
    employeeId: EMP,
    flow: null,
    managerEmpId: null,
    fallbackApproverEmpId: null,
    hrAdminEmpIds: [],
    ...over,
  }
}

describe("pickApproverChain — 四種分支", () => {
  it("① flow mode=list 且名單非空 → 名單依序多關（去重），其他來源全部忽略", () => {
    const r = pickApproverChain(
      base({
        flow: { mode: "list", approverEmpIds: [L1, L2, L1] },
        managerEmpId: MGR,
        fallbackApproverEmpId: BOSS,
        hrAdminEmpIds: [HR1],
      }),
    )
    expect(r).toEqual({ ok: true, approverEmpIds: [L1, L2], source: "list" })
  })

  it("② 無 flow → 直屬主管單關", () => {
    const r = pickApproverChain(base({ managerEmpId: MGR, fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] }))
    expect(r).toEqual({ ok: true, approverEmpIds: [MGR], source: "manager" })
  })

  it("②' flow mode=manager 即使有名單也走直屬主管；mode=list 但名單空也走直屬主管", () => {
    expect(
      pickApproverChain(base({ flow: { mode: "manager", approverEmpIds: [L1] }, managerEmpId: MGR })),
    ).toEqual({ ok: true, approverEmpIds: [MGR], source: "manager" })
    expect(
      pickApproverChain(base({ flow: { mode: "list", approverEmpIds: [] }, managerEmpId: MGR })),
    ).toEqual({ ok: true, approverEmpIds: [MGR], source: "manager" })
  })

  it("③ 無主管 → 老闆（fallback）；老闆就是申請人本人時跳過", () => {
    expect(pickApproverChain(base({ fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] }))).toEqual({
      ok: true,
      approverEmpIds: [BOSS],
      source: "fallback",
    })
    expect(
      pickApproverChain(base({ employeeId: BOSS, fallbackApproverEmpId: BOSS, hrAdminEmpIds: [HR1] })),
    ).toEqual({ ok: true, approverEmpIds: [HR1], source: "hr_admin" })
  })

  it("④ 主管與老闆都沒有 → 第一位 hr_admin；HR 自己請假且有第二位 HR 時避開本人", () => {
    expect(pickApproverChain(base({ hrAdminEmpIds: [HR1, HR2] }))).toEqual({
      ok: true,
      approverEmpIds: [HR1],
      source: "hr_admin",
    })
    expect(pickApproverChain(base({ employeeId: HR1, hrAdminEmpIds: [HR1, HR2] }))).toEqual({
      ok: true,
      approverEmpIds: [HR2],
      source: "hr_admin",
    })
    // 只有一位 HR 而 HR 自己請假：沒別人能簽，仍讓單能走。
    expect(pickApproverChain(base({ employeeId: HR1, hrAdminEmpIds: [HR1] }))).toEqual({
      ok: true,
      approverEmpIds: [HR1],
      source: "hr_admin",
    })
  })

  it("⑤ 四層都空 → no_approver_available", () => {
    expect(pickApproverChain(base())).toEqual({ ok: false, error: "no_approver_available" })
    // 主管欄位剛好是申請人本人（資料異常）也不算主管
    expect(pickApproverChain(base({ managerEmpId: EMP }))).toEqual({ ok: false, error: "no_approver_available" })
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
