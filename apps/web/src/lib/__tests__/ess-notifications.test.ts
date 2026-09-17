import { describe, it, expect } from "vitest";
import type { LeaveSegment, NotificationItem } from "../ess-api";
import { TYPE_LABEL, isUnread, notificationLink, summarizeSegment, summarizeSegments, typeLabel } from "../ess-notifications";

function notif(type: string, payload: Record<string, unknown> | null): Pick<NotificationItem, "type" | "payload"> {
  return { type, payload };
}

function seg(date: string, startTime = "09:00", endTime = "18:00", hours = 8, type?: LeaveSegment["type"]): LeaveSegment {
  return type ? { date, startTime, endTime, hours, type } : { date, startTime, endTime, hours };
}

describe("isUnread（三態）", () => {
  it("payload.read === true → 已讀", () => {
    expect(isUnread({ payload: { read: true } })).toBe(false);
  });

  it("payload.read === false → 未讀", () => {
    expect(isUnread({ payload: { read: false, foo: 1 } })).toBe(true);
  });

  it("payload null／沒有 read 欄位 → 未讀", () => {
    expect(isUnread({ payload: null })).toBe(true);
    expect(isUnread({ payload: {} })).toBe(true);
    expect(isUnread({ payload: { read: "true" } })).toBe(true);
  });
});

describe("notificationLink", () => {
  it("approval submitted／advanced → /ess/approvals", () => {
    expect(notificationLink(notif("approval", { requestId: "r1", event: "submitted", currentStep: 1 }))).toBe(
      "/ess/approvals",
    );
    expect(notificationLink(notif("approval", { requestId: "r1", event: "advanced", currentStep: 2 }))).toBe(
      "/ess/approvals",
    );
  });

  it("approval approved／rejected → /ess/requests?id=<requestId>", () => {
    expect(notificationLink(notif("approval", { requestId: "abc-123", event: "approved" }))).toBe(
      "/ess/requests?id=abc-123",
    );
    expect(notificationLink(notif("approval", { requestId: "abc-123", event: "rejected" }))).toBe(
      "/ess/requests?id=abc-123",
    );
  });

  it("approval approved 缺 requestId → 退回 /ess/requests；未知 event → null", () => {
    expect(notificationLink(notif("approval", { event: "approved" }))).toBe("/ess/requests");
    expect(notificationLink(notif("approval", { requestId: "r1", event: "cancelled" }))).toBeNull();
    expect(notificationLink(notif("approval", { requestId: "r1" }))).toBeNull();
  });

  it("missing_punch → /ess/requests?kind=fix_punch&date=<date>", () => {
    expect(notificationLink(notif("missing_punch", { date: "2026-09-16", issue: "no_in" }))).toBe(
      "/ess/requests?kind=fix_punch&date=2026-09-16",
    );
    expect(notificationLink(notif("missing_punch", { issue: "no_in" }))).toBe("/ess/requests?kind=fix_punch");
  });

  it("attendance_sheet → /ess/attendance-sheet/<sheetId>；缺 sheetId → null", () => {
    expect(notificationLink(notif("attendance_sheet", { sheetId: "s-9", period: "2026-08" }))).toBe(
      "/ess/attendance-sheet/s-9",
    );
    expect(notificationLink(notif("attendance_sheet", { period: "2026-08" }))).toBeNull();
  });

  it("anomaly → /ess/punches?from=&to=", () => {
    expect(
      notificationLink(notif("anomaly", { anomalyType: "late", from: "2026-09-01", to: "2026-09-15", detail: "x" })),
    ).toBe("/ess/punches?from=2026-09-01&to=2026-09-15");
    expect(notificationLink(notif("anomaly", { anomalyType: "late" }))).toBe("/ess/punches");
  });

  it("缺 payload／未知 type → null", () => {
    expect(notificationLink(notif("approval", null))).toBeNull();
    expect(notificationLink(notif("missing_punch", null))).toBeNull();
    expect(notificationLink(notif("announcement", { id: "a1" }))).toBeNull();
    expect(notificationLink(notif("report", { period: "2026-08" }))).toBeNull();
  });

  it("id 會做 URL 編碼", () => {
    expect(notificationLink(notif("approval", { requestId: "a b/c", event: "approved" }))).toBe(
      "/ess/requests?id=a%20b%2Fc",
    );
    expect(notificationLink(notif("attendance_sheet", { sheetId: "x/y" }))).toBe("/ess/attendance-sheet/x%2Fy");
  });
});

describe("TYPE_LABEL／typeLabel", () => {
  it("已知類型有中文；其他退化成「通知」", () => {
    expect(TYPE_LABEL.approval).toBe("簽核");
    expect(TYPE_LABEL.missing_punch).toBe("忘打卡");
    expect(TYPE_LABEL.attendance_sheet).toBe("出勤月表");
    expect(TYPE_LABEL.anomaly).toBe("出勤異常");
    expect(TYPE_LABEL.announcement).toBe("公告");
    expect(typeLabel("report")).toBe("通知");
    expect(typeLabel(undefined)).toBe("通知");
    expect(typeLabel("")).toBe("通知");
  });
});

describe("summarizeSegments", () => {
  it("0 段 → 空字串", () => {
    expect(summarizeSegments([])).toBe("");
    expect(summarizeSegments(null)).toBe("");
    expect(summarizeSegments(undefined)).toBe("");
  });

  it("≤3 段逐行（換行分隔），每行 MM/DD HH:mm–HH:mm · N 小時", () => {
    const text = summarizeSegments([seg("2026-09-18"), seg("2026-09-19", "09:00", "13:00", 4), seg("2026-09-21", "14:00", "15:30", 1.5)]);
    expect(text.split("\n")).toEqual(["09/18 09:00–18:00 · 8 小時", "09/19 09:00–13:00 · 4 小時", "09/21 14:00–15:30 · 1.5 小時"]);
  });

  it(">3 段且時段相同、≥8 小時 → 「09/18–09/25 全天 ×6 · 48 小時」", () => {
    const segs = ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"].map((d) => seg(d));
    expect(summarizeSegments(segs)).toBe("09/18–09/25 全天 ×6 · 48 小時");
  });

  it(">3 段時段相同但不足 8 小時 → 顯示時段；時段不一致 → 不標時段；日期會排序", () => {
    const half = ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"].map((d) => seg(d, "09:00", "13:00", 4));
    expect(summarizeSegments(half)).toBe("09/18–09/21 09:00–13:00 ×4 · 16 小時");

    const mixed = [
      seg("2026-09-21", "09:00", "13:00", 4),
      seg("2026-09-18"),
      seg("2026-09-19"),
      seg("2026-09-20", "14:00", "18:00", 4),
    ];
    expect(summarizeSegments(mixed)).toBe("09/18–09/21 ×4 · 24 小時");
  });

  it("補卡段（type in/out）顯示補哪一種卡", () => {
    expect(summarizeSegment(seg("2026-09-18", "09:02", "09:02", 0, "in"))).toBe("09/18 09:02 · 補上班卡");
    expect(summarizeSegment(seg("2026-09-18", "18:10", "18:10", 0, "out"))).toBe("09/18 18:10 · 補下班卡");
    // 0 小時不顯示「· 0 小時」
    expect(summarizeSegment(seg("2026-09-18", "09:00", "09:00", 0))).toBe("09/18 09:00–09:00");
  });
});
