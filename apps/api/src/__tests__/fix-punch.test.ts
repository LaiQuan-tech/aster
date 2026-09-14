import { describe, it, expect } from "vitest"
import { fixPunchCandidates, type ApprovedRequest } from "../services/ledger.js"

// Pure — the punch-type inference an approved 補卡 (fix_punch) request goes
// through before ledger.materializeFixPunch writes punch_records.
const TPE = "Asia/Taipei"
const base: ApprovedRequest = {
  id: "req-1",
  employee_id: "emp-1",
  kind: "fix_punch",
  leave_type_id: null,
  hours: null,
  start_at: "2026-06-01T01:00:00.000Z", // 09:00 Taipei
  end_at: "2026-06-01T10:00:00.000Z", // 18:00 Taipei
}

describe("fixPunchCandidates — 補卡型別推斷", () => {
  it("start_at → 'in'，end_at 晚於 start_at → 'out'", () => {
    expect(fixPunchCandidates(base, TPE)).toEqual([
      { type: "in", punchAt: "2026-06-01T01:00:00.000Z" },
      { type: "out", punchAt: "2026-06-01T10:00:00.000Z" },
    ])
  })

  it("end_at 等於 start_at → 只補一個 'in'", () => {
    expect(fixPunchCandidates({ ...base, end_at: base.start_at }, TPE)).toEqual([
      { type: "in", punchAt: "2026-06-01T01:00:00.000Z" },
    ])
  })

  it("end_at 早於 start_at（壞資料）→ 只補 'in'，不產生倒退的 'out'", () => {
    expect(fixPunchCandidates({ ...base, end_at: "2026-05-31T10:00:00.000Z" }, TPE)).toEqual([
      { type: "in", punchAt: "2026-06-01T01:00:00.000Z" },
    ])
  })

  it("segments 帶 type + date + startTime（台北時間）→ 逐段指定，忽略 start_at/end_at", () => {
    const req: ApprovedRequest = {
      ...base,
      segments: [
        { date: "2026-06-01", startTime: "18:30", endTime: "18:30", hours: 0, type: "out" },
        { date: "2026-06-02", startTime: "22:30", endTime: "22:30", hours: 0, type: "in" },
        { date: "2026-06-02", startTime: "12:00", hours: 0 }, // no type → ignored
      ],
    }
    expect(fixPunchCandidates(req, TPE)).toEqual([
      { type: "out", punchAt: "2026-06-01T10:30:00.000Z" },
      { type: "in", punchAt: "2026-06-02T14:30:00.000Z" },
    ])
  })

  it("segments 沒有任何一段帶合法 type → 退回 start_at/end_at 推斷", () => {
    const req: ApprovedRequest = {
      ...base,
      segments: [{ date: "2026-06-01", startTime: "09:00", endTime: "18:00", hours: 8 }],
    }
    expect(fixPunchCandidates(req, TPE).map((c) => c.type)).toEqual(["in", "out"])
  })

  it("start_at 無法解析 → 不補任何卡", () => {
    expect(fixPunchCandidates({ ...base, start_at: "garbage" }, TPE)).toEqual([])
  })
})
