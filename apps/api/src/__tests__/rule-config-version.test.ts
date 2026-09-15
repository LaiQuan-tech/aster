import { describe, it, expect } from "vitest"
import {
  insertRuleConfigVersion,
  RULE_CONFIG_VERSION_RETRIES,
  UNIQUE_VIOLATION,
  type RuleConfigVersionDeps,
} from "../services/rule-config-version"

/**
 * C4 驗收修正：rule_configs (tenant_id, version) 唯一索引（migration 0046）之後，
 * PUT /rule-config 撞 23505 要「重取 max＋1」重試 3 次。DB 以假函式注入，
 * 這裡驗的是重試流程本身（純函式，不連 DB）：
 *   • 沒撞號 → 1 次就好，version = max+1
 *   • 撞號後別人已把 max 推高 → 重讀後拿到新號，不沿用舊號
 *   • 3 次重試都撞 → conflict_exhausted、共 4 次嘗試
 *   • 非 23505 的錯 → 不重試，第 1 次就回 insert_failed
 */

type Row = { id: string; version: number }
type Current = { id: string; version: number }

function deps(opts: {
  maxSequence: Array<number | null>
  insertOutcomes: Array<"ok" | "conflict" | "other">
}): RuleConfigVersionDeps<Row, Current> & { versionsTried: number[]; reads: number } {
  let reads = 0
  let inserts = 0
  const versionsTried: number[] = []
  const d = {
    reads: 0,
    versionsTried,
    async readCurrent() {
      const v = opts.maxSequence[Math.min(reads, opts.maxSequence.length - 1)]
      reads += 1
      d.reads = reads
      return v === null ? null : { id: `row-${v}`, version: v }
    },
    async insertVersion(version: number) {
      versionsTried.push(version)
      const outcome = opts.insertOutcomes[Math.min(inserts, opts.insertOutcomes.length - 1)]
      inserts += 1
      if (outcome === "ok") return { data: { id: `new-${version}`, version }, error: null }
      if (outcome === "conflict") return { data: null, error: { code: UNIQUE_VIOLATION, message: "duplicate key value violates unique constraint \"rule_configs_tenant_version_uq\"" } }
      return { data: null, error: { code: "42703", message: "column does not exist" } }
    },
  }
  return d
}

describe("insertRuleConfigVersion — 撞 23505 重取 max+1 重試", () => {
  it("沒撞號：1 次就成功，version = max+1，回傳 current 供稽核 oldRow 用", async () => {
    const d = deps({ maxSequence: [3], insertOutcomes: ["ok"] })
    const r = await insertRuleConfigVersion(d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.version).toBe(4)
    expect(r.attempts).toBe(1)
    expect(r.current).toEqual({ id: "row-3", version: 3 })
    expect(d.versionsTried).toEqual([4])
  })

  it("沒有任何版本（max null）→ version 1", async () => {
    const d = deps({ maxSequence: [null], insertOutcomes: ["ok"] })
    const r = await insertRuleConfigVersion(d)
    expect(r.ok && r.version).toBe(1)
    expect(r.ok && r.current).toBeNull()
  })

  it("第 1 次撞號（別人剛寫了 v4）→ 重讀 max=4 → 第 2 次用 v5 成功；不沿用舊號", async () => {
    const d = deps({ maxSequence: [3, 4], insertOutcomes: ["conflict", "ok"] })
    const r = await insertRuleConfigVersion(d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.version).toBe(5)
    expect(r.attempts).toBe(2)
    expect(d.versionsTried).toEqual([4, 5])
    expect(d.reads).toBe(2)
  })

  it("連撞 3 次後第 4 次成功（首次＋3 次重試的上限內）", async () => {
    const d = deps({ maxSequence: [3, 4, 5, 6], insertOutcomes: ["conflict", "conflict", "conflict", "ok"] })
    const r = await insertRuleConfigVersion(d)
    expect(r.ok && r.version).toBe(7)
    expect(r.ok && r.attempts).toBe(1 + RULE_CONFIG_VERSION_RETRIES)
    expect(d.versionsTried).toEqual([4, 5, 6, 7])
  })

  it("重試用完仍撞 → conflict_exhausted，共 4 次嘗試，帶最後一次的 23505", async () => {
    const d = deps({ maxSequence: [3], insertOutcomes: ["conflict"] })
    const r = await insertRuleConfigVersion(d)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("conflict_exhausted")
    expect(r.attempts).toBe(4)
    expect(r.error?.code).toBe(UNIQUE_VIOLATION)
    expect(d.versionsTried).toEqual([4, 4, 4, 4]) // max 沒變就一直是 4（真實世界 max 會被搶走的人推高）
  })

  it("非 23505 的錯（欄位不存在等）→ 不重試，第 1 次就 insert_failed", async () => {
    const d = deps({ maxSequence: [3], insertOutcomes: ["other"] })
    const r = await insertRuleConfigVersion(d)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe("insert_failed")
    expect(r.attempts).toBe(1)
    expect(r.error?.code).toBe("42703")
    expect(d.versionsTried).toEqual([4])
  })

  it("retries=0 → 只試一次，撞號即 conflict_exhausted", async () => {
    const d = deps({ maxSequence: [3], insertOutcomes: ["conflict"] })
    const r = await insertRuleConfigVersion(d, 0)
    expect(!r.ok && r.reason).toBe("conflict_exhausted")
    expect(!r.ok && r.attempts).toBe(1)
  })
})
