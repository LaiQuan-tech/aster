import { describe, it, expect } from "vitest"
import {
  DEFAULT_PUNCH_COOLDOWN_SECONDS,
  checkPunchCooldown,
  cooldownSeconds,
  statusFromRecords,
} from "../services/punch-guard.js"

// Pure — no DB, no process.env: every case passes its own env object.

const NOW = new Date("2026-09-17T09:00:00.000Z")
const secondsAgo = (s: number) => ({ punch_at: new Date(NOW.getTime() - s * 1000).toISOString() })

describe("cooldownSeconds — PUNCH_COOLDOWN_SECONDS parsing", () => {
  it("unset → default 60", () => {
    expect(cooldownSeconds({})).toBe(60)
    expect(DEFAULT_PUNCH_COOLDOWN_SECONDS).toBe(60)
  })

  it("blank / non-numeric / non-finite → default 60", () => {
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "" })).toBe(60)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "   " })).toBe(60)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "abc" })).toBe(60)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "60s" })).toBe(60)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "Infinity" })).toBe(60)
    expect(cooldownSeconds({ PUNCH_COOLDOWN_SECONDS: "NaN" })).toBe(60)
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
