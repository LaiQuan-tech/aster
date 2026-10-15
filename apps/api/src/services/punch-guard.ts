/**
 * Punch guard — pure functions, no IO. Two small rules the punch routes lean on:
 *
 *   • Cooldown（連按防呆）：the employee front page sends an explicit `type`
 *     and optimistically renders the returned record; a double tap must NOT
 *     produce two rows. `POST /punch` looks up the employee's most recent
 *     punch (any type, any day) and refuses with 409 `punch_too_soon` while
 *     `0 <= now − last < cooldownSeconds`. HR back-fills (`/punch/manual*`)
 *     are exempt — they carry an explicit timestamp and are not a double tap.
 *
 *   • Work status（上班中／已下班）：only work `in` / `out` punches flip the
 *     state. `break_*` / `outing_*` are deductions inside a work segment and
 *     must not make `GET /punch/today` report "off" while someone is on a
 *     break — the front page would otherwise offer "上班打卡" mid-shift.
 *
 * `PUNCH_COOLDOWN_SECONDS` tunes the window (default 1); the API test setup
 * pins it to 0 so live suites can punch in → out back-to-back.
 */

export const DEFAULT_PUNCH_COOLDOWN_SECONDS = 1

/**
 * Cooldown window in seconds from `PUNCH_COOLDOWN_SECONDS`.
 * Unset / blank / not a finite number → 1. Negative → 0 (disabled).
 */
export function cooldownSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PUNCH_COOLDOWN_SECONDS
  if (raw === undefined || raw.trim() === "") return DEFAULT_PUNCH_COOLDOWN_SECONDS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_PUNCH_COOLDOWN_SECONDS
  return n < 0 ? 0 : n
}

export type PunchCooldownCheck = { ok: true } | { ok: false; retryAfterSeconds: number }

/**
 * Block only while `0 <= now − last.punch_at < seconds`.
 *
 *   • no previous punch, or `seconds <= 0` (disabled) → ok
 *   • `last` in the future (clock skew, or an HR back-fill dated ahead) → ok —
 *     a future timestamp is never evidence of a double tap
 *   • elapsed exactly equal to `seconds` → ok (window is half-open)
 *   • unparseable `punch_at` → ok (never lock someone out over bad data)
 *
 * `retryAfterSeconds` is a whole number ≥ 1 (ceil of the remaining window),
 * so a client can show "請 N 秒後再試" and never sees 0.
 */
export function checkPunchCooldown(
  last: { punch_at: string } | null,
  now: Date,
  seconds: number,
): PunchCooldownCheck {
  if (!last || !(seconds > 0)) return { ok: true }
  const lastMs = Date.parse(last.punch_at)
  if (!Number.isFinite(lastMs)) return { ok: true }
  const elapsed = (now.getTime() - lastMs) / 1000
  if (elapsed < 0 || elapsed >= seconds) return { ok: true }
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(seconds - elapsed)) }
}

export type WorkStatus = "working" | "off"

/**
 * Derive 上班中／已下班 from a chronological punch list (oldest first, as
 * `GET /punch/today` returns them). Only `in` / `out` count: the most recent
 * of those decides — `in` → "working", `out` or none → "off". `break_*` and
 * `outing_*` are skipped, so a break taken after clocking in still reads as
 * "working".
 */
export function statusFromRecords(records: Array<{ type: string }>): WorkStatus {
  for (let i = records.length - 1; i >= 0; i--) {
    const t = records[i].type
    if (t === "in") return "working"
    if (t === "out") return "off"
  }
  return "off"
}

/**
 * 跨午夜仍在上班中的「前一天上班卡」最多往回認多久（2026-10-15）——最外層上限，實際還要過
 * services/punch-carry-over.ts 的班別／06:00 截止判斷。跟前端 lib/punch-state.ts 的 STALE_WORKING_MS 同一個數字：
 * 正常工時連同延長工時一天最多 12 小時（勞基法第 32 條）加休息與收尾餘裕取 16 小時。
 */
export const CARRY_OVER_MAX_MS = 16 * 60 * 60_000

/**
 * 純函式：今天（租戶日曆日）開始前最後一張 in／out（`lastBeforeToday`，呼叫端只撈 in／out）若是 in、
 * 距 `now` 不超過 CARRY_OVER_MAX_MS、而且 `now` 早於 `cutoffMs`（班別結束＋6 小時，或沒班別時今天 06:00）
 * → 回傳它（員工跨午夜仍在上班中）；否則 null。
 * 時間解析不了、在今天開始之後、或在 `now` 之後（時鐘誤差）→ null（寧可照舊當成新的一天）。
 */
export function carryOverOpenIn<T extends { type: string; punch_at: string }>(
  lastBeforeToday: T | null | undefined,
  todayStartIso: string,
  now: Date,
  cutoffMs: number,
): T | null {
  if (!lastBeforeToday || lastBeforeToday.type !== "in") return null
  const inMs = Date.parse(lastBeforeToday.punch_at)
  const startMs = Date.parse(todayStartIso)
  if (!Number.isFinite(inMs) || !Number.isFinite(startMs) || Number.isNaN(cutoffMs)) return null
  if (inMs >= startMs) return null
  const elapsed = now.getTime() - inMs
  if (elapsed < 0 || elapsed > CARRY_OVER_MAX_MS) return null
  if (now.getTime() >= cutoffMs) return null
  return lastBeforeToday
}
