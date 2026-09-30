import { describe, it, expect } from "vitest"
import { allowedChannels, queueStatusFor } from "../services/notification-delivery"

/**
 * 員工自選通知通道（M13）。關鍵的取捨：**只有明示 false 才停送**——
 * `user_preferences` 沒有那一列（絕大多數人）時行為必須與加這個功能之前完全一樣，
 * 否則上線當天全公司同時收不到信。
 */
describe("allowedChannels — 通知通道偏好", () => {
  it("沒設過偏好 → 原樣送出（不是「全關」）", () => {
    expect(allowedChannels(["email", "line"], undefined)).toEqual(["email", "line"])
    expect(allowedChannels(["email"], {})).toEqual(["email"])
  })

  it("明示 email:false → 通道不含 email", () => {
    expect(allowedChannels(["email", "line"], { email: false })).toEqual(["line"])
  })

  it("明示 true 照送", () => {
    expect(allowedChannels(["email", "line"], { email: true, line: false })).toEqual(["email"])
  })

  it("兩個都關 → 空陣列（呼叫端會標成 opted_out，不再重試）", () => {
    expect(allowedChannels(["email", "line"], { email: false, line: false })).toEqual([])
  })

  it("偏好只提到沒在送的通道時不影響結果", () => {
    expect(allowedChannels(["email"], { line: false })).toEqual(["email"])
  })
})

describe("queueStatusFor — 處理過的通知一律離開 pending 佇列", () => {
  it("任一通道 sent → sent（含先前已寄過、本輪 already_delivered 的列）", () => {
    expect(queueStatusFor(["email"], { email: { status: "sent", at: "2026-09-22T15:55:02Z" } })).toBe("sent")
    expect(queueStatusFor(["email", "line"], { email: { status: "failed" }, line: { status: "sent" } })).toBe("sent")
  })
  it("沒有 sent、有 failed → failed", () => {
    expect(queueStatusFor(["email"], { email: { status: "failed", error: "x" } })).toBe("failed")
  })
  it("全部被收件人關掉 → skipped", () => {
    expect(queueStatusFor(["email"], { email: { status: "skipped", reason: "opt_out" } })).toBe("skipped")
  })
  it("這列沒有任何外部通道 → skipped（不能永遠留在 pending 佔住最舊那批）", () => {
    expect(queueStatusFor([], undefined)).toBe("skipped")
    expect(queueStatusFor([], {})).toBe("skipped")
  })
})
