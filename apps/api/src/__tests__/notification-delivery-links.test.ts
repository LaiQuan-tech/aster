import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn(async (_input: unknown) => ({ id: "fake" })) }))
vi.mock("../lib/resend.js", () => ({ sendMail, isMailConfigured: () => true }))

import {
  composeNotificationMessage,
  sendNotificationEmail,
  sendNotificationLine,
} from "../services/notification-delivery"

const BASE = "https://hr.example.test"

describe("composeNotificationMessage — Email／LINE 附連結（2026-11-09）", () => {
  it("待簽核：純文字結尾「前往處理：<完整網址>」、HTML 有按鈕與備援網址、LINE 也附網址", () => {
    const row = { type: "approval", title: "待簽核：王小明 的請假申請", body: "期間 11/10", payload: { requestId: "r-1", event: "submitted" } }
    const msg = composeNotificationMessage(row, BASE)
    expect(msg.url).toBe("https://hr.example.test/ess/approvals?id=r-1")
    expect(msg.text).toBe("待簽核：王小明 的請假申請\n\n期間 11/10\n\n前往處理：https://hr.example.test/ess/approvals?id=r-1")
    expect(msg.html).toContain('<a href="https://hr.example.test/ess/approvals?id=r-1"')
    expect(msg.html).toContain("前往處理</a>")
    expect(msg.html).toContain("按鈕無法點擊時")
    expect(msg.lineText.endsWith("前往處理：https://hr.example.test/ess/approvals?id=r-1")).toBe(true)
  })

  it("HR 覆核關 → 後台簽核頁", () => {
    const msg = composeNotificationMessage({ type: "approval", title: "t", body: null, payload: { requestId: "r-2", event: "advanced", stepKind: "hr" } }, BASE)
    expect(msg.text).toBe("t\n\n前往處理：https://hr.example.test/admin/approvals?status=pending&id=r-2")
  })

  it("結果通知（非待辦）用「查看：」", () => {
    const msg = composeNotificationMessage({ type: "approval", title: "你的請假申請已核准", body: "x", payload: { requestId: "r-3", event: "approved" } }, BASE)
    expect(msg.text.endsWith("查看：https://hr.example.test/ess/requests?id=r-3")).toBe(true)
  })

  it("沒有可用連結 → 退回 /ess/notifications", () => {
    const msg = composeNotificationMessage({ type: "something_new", title: "t", body: "b", payload: null }, BASE)
    expect(msg.url).toBe("https://hr.example.test/ess/notifications")
    expect(msg.text.endsWith("查看：https://hr.example.test/ess/notifications")).toBe(true)
    expect(msg.lineText.endsWith("https://hr.example.test/ess/notifications")).toBe(true)
  })

  it("HTML 會跳脫內文；LINE 超過 5000 字時截內文但保留網址", () => {
    const msg = composeNotificationMessage({ type: "late_report", title: "<b>x</b>", body: "a\nb<script>", payload: {} }, BASE)
    expect(msg.html).toContain("&lt;b&gt;x&lt;/b&gt;")
    expect(msg.html).toContain("a<br>b&lt;script&gt;")
    const long = composeNotificationMessage({ type: "late_report", title: "t", body: "字".repeat(6000), payload: {} }, BASE)
    expect(long.lineText.length).toBeLessThanOrEqual(5000)
    expect(long.lineText.endsWith("前往處理：https://hr.example.test/ess/approvals")).toBe(true)
  })
})

describe("sendNotificationEmail／sendNotificationLine — 實際送出的內容", () => {
  const prevWeb = process.env.WEB_URL
  const prevLine = process.env.LINE_CHANNEL_ACCESS_TOKEN
  beforeEach(() => {
    process.env.WEB_URL = "https://hr.example.test/"
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "fake-token"
    sendMail.mockClear()
  })
  afterEach(() => {
    process.env.WEB_URL = prevWeb
    process.env.LINE_CHANNEL_ACCESS_TOKEN = prevLine
    vi.unstubAllGlobals()
  })

  it("Email：text 含完整網址，且有 html", async () => {
    await sendNotificationEmail("someone@example.test", {
      type: "attendance_sheet",
      title: "出勤月表待核准（2026-10）",
      body: "請 HR 核准。",
      payload: { sheetId: "s-1", action: "manager_reviewed", recipientRole: "hr" },
    })
    expect(sendMail).toHaveBeenCalledTimes(1)
    const arg = (sendMail.mock.calls[0] as unknown as [{ to: string; subject: string; text: string; html: string }])[0]
    expect(arg.subject).toBe("出勤月表待核准（2026-10）")
    expect(arg.text).toContain("前往處理：https://hr.example.test/admin/attendance-sheets/s-1")
    expect(arg.html).toContain('href="https://hr.example.test/admin/attendance-sheets/s-1"')
  })

  it("LINE：訊息含網址", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await sendNotificationLine("U123", { type: "missing_punch", title: "忘打卡提醒", body: null, payload: { date: "2026-11-03" } })
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)) as {
      messages: Array<{ text: string }>
    }
    expect(body.messages[0].text).toBe("忘打卡提醒\n\n前往處理：https://hr.example.test/ess/requests?kind=fix_punch&date=2026-11-03")
  })
})
