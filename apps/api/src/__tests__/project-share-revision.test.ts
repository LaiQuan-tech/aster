import { describe, expect, it } from "vitest"
import { prepareProjectShareRevision } from "../services/project-share-revision"

const employeeA = "11111111-1111-4111-8111-111111111111"
const employeeB = "22222222-2222-4222-8222-222222222222"

describe("project share revision", () => {
  it("正規化原因與成員，並保留 null 獎金率", () => {
    expect(prepareProjectShareRevision({
      bonusRatePct: null,
      members: [{ employeeId: employeeA, roleInProject: "manager", sharePct: 25 }],
      reason: "  年度調整  ",
    })).toEqual({
      bonusRatePct: null,
      members: [{ memberId: null, employeeId: employeeA, roleInProject: "manager", sharePct: 25 }],
      reason: "年度調整",
    })
  })

  it("拒絕空白原因", () => {
    expect(() => prepareProjectShareRevision({ bonusRatePct: 2, members: [], reason: "   " }))
      .toThrowError("reason_required")
  })

  it("拒絕重複員工", () => {
    expect(() => prepareProjectShareRevision({
      bonusRatePct: 2,
      members: [
        { employeeId: employeeA, roleInProject: "lead", sharePct: 20 },
        { employeeId: employeeA, roleInProject: "member", sharePct: 30 },
      ],
      reason: "調整",
    })).toThrowError("duplicate_employee")
  })

  it("拒絕分潤比例合計超過 100", () => {
    expect(() => prepareProjectShareRevision({
      bonusRatePct: 2,
      members: [
        { employeeId: employeeA, roleInProject: "lead", sharePct: 60 },
        { employeeId: employeeB, roleInProject: "member", sharePct: 40.01 },
      ],
      reason: "調整",
    })).toThrowError("share_pct_exceeds_100")
  })
})
