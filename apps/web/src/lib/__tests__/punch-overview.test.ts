import { describe, expect, it } from "vitest";
import {
  dateHeader,
  daySpan,
  fmtHours,
  locationIssue,
  punchDetail,
  punchOverviewPath,
  punchTimeLabel,
  punchWeekExportPath,
  rangeError,
  weekCellBadges,
  weekCellClass,
  weekOf,
  type OverviewDay,
  type PunchBrief,
} from "../punch-overview";

const TZ = "Asia/Taipei";
const brief = (extra: Partial<PunchBrief> = {}): PunchBrief => ({
  id: "p1",
  at: "2026-09-01T01:12:00.000Z",
  source: "web",
  lat: null,
  lng: null,
  geoStatus: null,
  ip: "203.0.113.10",
  wfh: false,
  ...extra,
});
const day = (extra: Partial<OverviewDay> = {}): OverviewDay => ({
  date: "2026-09-01",
  dayType: "workday",
  shift: { label: "09:00–18:00", source: "default", start: "09:00", end: "18:00", crossesMidnight: false },
  in: brief(),
  out: brief({ at: "2026-09-01T10:00:00.000Z" }),
  workedMinutes: 480,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
  leaveMinutes: 0,
  status: "done",
  statusLabel: "已下班",
  statusTone: "ok",
  tags: [],
  provisional: false,
  ...extra,
});

describe("punch-overview 日期工具", () => {
  it("weekOf：週一～週日（週日屬於前一週）", () => {
    expect(weekOf("2026-09-02")).toEqual({ from: "2026-08-31", to: "2026-09-06" });
    expect(weekOf("2026-09-06")).toEqual({ from: "2026-08-31", to: "2026-09-06" });
    expect(weekOf("2026-08-31")).toEqual({ from: "2026-08-31", to: "2026-09-06" });
  });

  it("rangeError：最多 31 天、起不能晚於迄", () => {
    expect(rangeError("2026-09-01", "2026-10-01")).toBeNull();
    expect(daySpan("2026-09-01", "2026-10-01")).toBe(31);
    expect(rangeError("2026-09-01", "2026-10-02")).toBe("區間最多 31 天");
    expect(rangeError("2026-09-02", "2026-09-01")).toBe("起日不能晚於迄日");
    expect(rangeError("", "2026-09-01")).toBe("請選擇起訖日期");
  });

  it("dateHeader", () => {
    expect(dateHeader("2026-09-01")).toBe("9/1（二）");
    expect(dateHeader("2026-09-06")).toBe("9/6（日）");
  });
});

describe("punch-overview 時間與定位", () => {
  it("跨夜班的下班卡（隔天）標 +1", () => {
    expect(punchTimeLabel("2026-09-01T14:00:00.000Z", "2026-09-01", TZ)).toBe("22:00");
    expect(punchTimeLabel("2026-09-01T22:10:00.000Z", "2026-09-01", TZ)).toBe("06:10 +1");
    expect(punchTimeLabel("2026-09-01T16:00:00.000Z", "2026-09-01", TZ)).toBe("00:00 +1");
  });

  it("fmtHours", () => {
    expect(fmtHours(0)).toBe("—");
    expect(fmtHours(510)).toBe("8.5h");
  });

  it("locationIssue：有座標、補登、LINE 不標；逾時另標", () => {
    expect(locationIssue(brief({ lat: 25.03, lng: 121.56 }))).toBeNull();
    expect(locationIssue(brief({ source: "manual" }))).toBeNull();
    expect(locationIssue(brief({ source: "line" }))).toBeNull();
    expect(locationIssue(brief({ geoStatus: "timeout" }))).toBe("timeout");
    expect(locationIssue(brief({ geoStatus: "denied" }))).toBe("none");
    expect(locationIssue(null)).toBeNull();
  });

  it("punchDetail：地點原因與 IP", () => {
    expect(punchDetail(brief({ geoStatus: "timeout" }))).toEqual({ source: "網頁打卡", location: "—（定位逾時）", ip: "203.0.113.10" });
    expect(punchDetail(brief({ lat: 25.033, lng: 121.5654, ip: null })).location).toBe("25.03300, 121.56540");
    expect(punchDetail(brief({ ip: null })).ip).toBe("—");
  });
});

describe("punch-overview 週表格子", () => {
  it("底色：缺卡／未打卡紅、遲到黃、休假灰", () => {
    expect(weekCellClass(day({ status: "missing_out" }))).toBe("bg-red-50");
    expect(weekCellClass(day({ status: "absent", in: null, out: null }))).toBe("bg-red-50");
    expect(weekCellClass(day({ lateMinutes: 5 }))).toBe("bg-amber-50");
    expect(weekCellClass(day({ status: "off" }))).toContain("bg-gray-50");
    expect(weekCellClass(day())).toBe("");
  });

  it("標籤：非已下班的狀態＋遲到／早退，最多兩個", () => {
    const d = day({
      status: "missing_out",
      statusLabel: "未打下班卡",
      statusTone: "danger",
      tags: [
        { code: "late", label: "遲到 12 分", tone: "warn" },
        { code: "early_leave", label: "早退 5 分", tone: "warn" },
        { code: "manual", label: "補登", tone: "muted" },
      ],
    });
    expect(weekCellBadges(d).map((t) => t.label)).toEqual(["未打下班卡", "遲到 12 分"]);
    expect(weekCellBadges(day())).toEqual([]);
  });
});

describe("punch-overview API 路徑", () => {
  it("帶篩選；空值不帶", () => {
    expect(punchOverviewPath({ date: "2026-09-01" }, { deptId: "d1" })).toBe("/attendance/punch-overview?date=2026-09-01&deptId=d1");
    expect(punchOverviewPath({})).toBe("/attendance/punch-overview");
    expect(punchWeekExportPath("2026-09-01", "2026-09-07", { employeeId: "e1" })).toBe(
      "/attendance/punch-overview/export.xlsx?from=2026-09-01&to=2026-09-07&employeeId=e1",
    );
  });
});
