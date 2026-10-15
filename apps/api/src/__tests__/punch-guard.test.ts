import { describe, it, expect } from "vitest"
import {
  CARRY_OVER_MAX_MS,
  carryOverOpenIn,
  DEFAULT_PUNCH_COOLDOWN_SECONDS,
  checkPunchCooldown,
  cooldownSeconds,
  statusFromRecords,
} from "../services/punch-guard.js"

// Pure — no DB, no process.env: every case passes its own env object.

const NOW = new Date("2026-09-17T09:00:00.000Z")
const secondsAgo = (s: number) => ({ punch_at: new Date(NOW.getTime() - s * 1000).toISOString() })

describe("cooldownSeconds — PUNCH_COOLDOWN_SECONDS parsing", () => {
  it("unset → default 1", () => {
    expect(cooldownSeconds({})).toBe(1)
    expect(DEFAULT_PUNCH_COOLDOWN_SECONDS).toBe(1)
  })

  it("blank / non-numeric / non-finite → default 1", () => {
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "" })).toBe(1)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "   " })).toBe(1)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "abc" })).toBe(1)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "60s" })).toBe(1)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "Infinity" })).toBe(1)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "NaN" })).toBe(1)
  })

  it("negative → 0 (disabled)", () => {
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "-1" })).toBe(0)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "-99999" })).toBe(0)
  })

  it("numeric strings parse as given (0 disables, fractions allowed)", () => {
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "0" })).toBe(0)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "15" })).toBe(15)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: " 120 " })).toBe(120)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "2.5" })).toBe(2.5)
  })
})

describe("checkPunchCooldown — block only while 0 ≤ now − last < seconds", () => {
  it("no previous punch → ok", () => {
    expect(checkPunchCooldown(null, NOW, 60)).toEqual({ ok: true })
  })

  it("inside the window → blocked, retryAfterSeconds = ceil(remaining)", () => {
    expect(checkPunchCooldown(secondsAgo(10), NOW, 60)).toEqual({
      ok: false,
      retryAfterSeconds: 50,
    })
    // Same instant (elapsed 0) → the whole window remains.
    expect(checkPunchCooldown(secondsAgo(0), NOW, 60)).toEqual({
      ok: false,
      retryAfterSeconds: 60,
    })
    // Fractional remainder rounds UP, never down to 0.
    expect(checkPunchCooldown(secondsAgo(59.2), NOW, 60)).toEqual({
      ok: false,
      retryAfterSeconds: 1,
    })
    expect(checkPunchCooldown(secondsAgo(59.999), NOW, 60)).toEqual({
      ok: false,
      retryAfterSeconds: 1,
    })
  })

  it("elapsed exactly equal to the window → ok (half-open interval)", () => {
    expect(checkPunchCooldown(secondsAgo(60), NOW, 60)).toEqual({ ok: true })
  })

  it("default one-second boundary blocks 0.999s and accepts 1.000s", () => {
    expect(checkPunchCooldown(secondsAgo(0.999), NOW, 1)).toEqual({ ok: false, retryAfterSeconds: 1 })
    expect(checkPunchCooldown(secondsAgo(1), NOW, 1)).toEqual({ ok: true })
  })

  it("window already passed → ok", () => {
    expect(checkPunchCooldown(secondsAgo(61), NOW, 60)).toEqual({ ok: true })
    expect(checkPunchCooldown(secondsAgo(86_400), NOW, 60)).toEqual({ ok: true })
  })

  it("last punch in the future (clock skew / back-fill dated ahead) → ok", () => {
    expect(checkPunchCooldown(secondsAgo(-1), NOW, 60)).toEqual({ ok: true })
    expect(checkPunchCooldown(secondsAgo(-3600), NOW, 60)).toEqual({ ok: true })
  })

  it("seconds ≤ 0 (disabled) → ok even for a punch a moment ago", () => {
    expect(checkPunchCooldown(secondsAgo(0), NOW, 0)).toEqual({ ok: true })
    expect(checkPunchCooldown(secondsAgo(1), NOW, -5)).toEqual({ ok: true })
    expect(checkPunchCooldown(secondsAgo(1), NOW, Number.NaN)).toEqual({ ok: true })
  })

  it("unparseable punch_at → ok (bad data never locks anyone out)", () => {
    expect(checkPunchCooldown({ punch_at: "not-a-date" }, NOW, 60)).toEqual({ ok: true })
  })
})

describe("statusFromRecords — only in/out flip the state", () => {
  const rec = (...types: string[]) => types.map((type) => ({ type }))

  it("no punches → off", () => {
    expect(statusFromRecords([])).toBe("off")
  })

  it("last in/out decides: in → working, out → off", () => {
    expect(statusFromRecords(rec("in"))).toBe("working")
    expect(statusFromRecords(rec("in", "out"))).toBe("off")
    expect(statusFromRecords(rec("in", "out", "in"))).toBe("working")
  })

  it("break/outing punches after an 'in' do not turn the day off", () => {
    expect(statusFromRecords(rec("in", "break_in"))).toBe("working")
    expect(statusFromRecords(rec("in", "break_in", "break_out"))).toBe("working")
    expect(statusFromRecords(rec("in", "outing_in"))).toBe("working")
    expect(statusFromRecords(rec("in", "outing_in", "outing_out"))).toBe("working")
  })

  it("break/outing punches after an 'out' (or with no 'in' at all) stay off", () => {
    expect(statusFromRecords(rec("in", "out", "break_in"))).toBe("off")
    expect(statusFromRecords(rec("in", "out", "outing_in", "outing_out"))).toBe("off")
    expect(statusFromRecords(rec("break_in"))).toBe("off")
    expect(statusFromRecords(rec("outing_in", "outing_out"))).toBe("off")
  })
})

describe("carryOverOpenIn — 跨午夜仍在上班中（2026-10-15）", () => {
  // 台北 10/14 00:00 = 10/13T16:00Z。
  const todayStart = "2026-10-13T16:00:00.000Z"
  const in1410 = { type: "in", punch_at: "2026-10-13T06:10:00.000Z" } // 10/13 14:10 台北

  it("前一天 14:10 上班、10/14 01:28 還沒下班 → 認得這張上班卡（應推為下班）", () => {
    expect(carryOverOpenIn(in1410, todayStart, new Date("2026-10-13T17:28:41.000Z"))).toBe(in1410)
  })

  it("最後一張是 out（前一天已下班）→ null", () => {
    expect(carryOverOpenIn({ type: "out", punch_at: in1410.punch_at }, todayStart, new Date("2026-10-13T17:28:00Z"))).toBeNull()
  })

  it("沒有前一天的卡 → null", () => {
    expect(carryOverOpenIn(null, todayStart, new Date("2026-10-13T17:28:00Z"))).toBeNull()
  })

  it("超過 16 小時（昨天忘了打下班卡，隔天早上來）→ null；剛好 16 小時仍算", () => {
    const inMs = Date.parse(in1410.punch_at)
    expect(carryOverOpenIn(in1410, todayStart, new Date(inMs + CARRY_OVER_MAX_MS))).toBe(in1410)
    expect(carryOverOpenIn(in1410, todayStart, new Date(inMs + CARRY_OVER_MAX_MS + 1))).toBeNull()
  })

  it("上班卡在今天開始之後、在未來、或時間解析不了 → null", () => {
    expect(carryOverOpenIn({ type: "in", punch_at: "2026-10-13T16:30:00Z" }, todayStart, new Date("2026-10-13T17:00:00Z"))).toBeNull()
    expect(carryOverOpenIn(in1410, todayStart, new Date("2026-10-13T05:00:00Z"))).toBeNull()
    expect(carryOverOpenIn({ type: "in", punch_at: "garbage" }, todayStart, new Date("2026-10-13T17:00:00Z"))).toBeNull()
  })
})
