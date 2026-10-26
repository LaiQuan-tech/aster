import { beforeEach, describe, expect, it, vi } from "vitest"

/** 分潤改版 #3：寫入端的重算呼叫點——一次寫入只呼叫一次引擎、失敗只 log 不丟例外。 */

const engine = vi.hoisted(() => ({
  calls: [] as Array<{ tenantId: string; projectId: string }>,
  behavior: "ok" as "ok" | "throw" | "failed",
}))

vi.mock("../services/bonus-run-store.js", () => ({
  recomputeDraftRunsForProject: async (tenantId: string, projectId: string) => {
    engine.calls.push({ tenantId, projectId })
    if (engine.behavior === "throw") throw new Error("engine down")
    if (engine.behavior === "failed") return { projectId, recomputed: [], returnedToDraft: [], failed: [{ id: "run-1", error: "x" }] }
    return { projectId, recomputed: ["run-1"], returnedToDraft: [], failed: [] }
  },
}))

import { recomputeDraftRunsAfterWrite } from "../services/project-bonus-recompute.js"

const T = "11111111-1111-4111-8111-111111111111"

beforeEach(() => {
  engine.calls.length = 0
  engine.behavior = "ok"
})

describe("recomputeDraftRunsAfterWrite", () => {
  it("多個專案（含重複／null）只呼叫引擎一次（引擎是租戶層重算）", async () => {
    await recomputeDraftRunsAfterWrite(T, ["p1", null, "p2", "p1"], "test")
    expect(engine.calls).toEqual([{ tenantId: T, projectId: "p1" }])
  })

  it("沒有專案 → 不呼叫", async () => {
    await recomputeDraftRunsAfterWrite(T, [null, undefined], "test")
    expect(engine.calls).toHaveLength(0)
  })

  it("引擎丟例外 → 吞掉只 log", async () => {
    engine.behavior = "throw"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(recomputeDraftRunsAfterWrite(T, ["p1"], "test")).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("引擎回報部分批次失敗 → log", async () => {
    engine.behavior = "failed"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await recomputeDraftRunsAfterWrite(T, ["p1"], "test")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
