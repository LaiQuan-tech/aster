import { describe, expect, it } from "vitest";
import type { LeaveBalance, LeaveRequest } from "./admin-api";
import type { AnnualGrantResult } from "./leave-balances-api";
import {
  annualLeaveHint,
  approxDays,
  buildQuotaRows,
  defaultQuotaBucket,
  hoursToDaysHours,
  planQuotaSave,
  quotaEditDirty,
  quotaInputToHours,
  unlimitedLabel,
} from "./employee-leave-quota";

const EMP = "11111111-1111-1111-1111-111111111111";
const ANNUAL = { id: "t-annual", code: "annual", name: "特休" };
const SICK = { id: "t-sick", code: "sick", name: "病假" };
const MENS = { id: "t-mens", code: "menstrual", name: "生理假" };
const PERSONAL = { id: "t-personal", code: "personal", name: "事假" };

function bal(p: Partial<LeaveBalance> & { id: string; leave_type_id: string }): LeaveBalance {
  return { employee_id: EMP, year: 2026, entitled: 0, used: 0, deferred: 0, ...p } as LeaveBalance;
}
function req(p: Partial<LeaveRequest>): Pick<LeaveRequest, "kind" | "status" | "leave_type_id" | "start_at" | "hours"> {
  return { kind: "leave", status: "pending", leave_type_id: ANNUAL.id, start_at: "2026-11-20T01:00:00Z", hours: 8, ...p };
}

describe("天＋時換算", () => {
  it("小時 → 天＋時（8 小時制）", () => {
    expect(hoursToDaysHours(56, 8)).toEqual({ days: "7", hours: "0" });
    expect(hoursToDaysHours(10.5, 8)).toEqual({ days: "1", hours: "2.5" });
    expect(hoursToDaysHours(0, 8)).toEqual({ days: "0", hours: "0" });
  });
  it("每日工時非 8 / 缺省 / 非法 → 依工時或退回 8", () => {
    expect(hoursToDaysHours(15, 7.5)).toEqual({ days: "2", hours: "0" });
    expect(hoursToDaysHours(16, undefined)).toEqual({ days: "2", hours: "0" });
    expect(hoursToDaysHours(16, 0)).toEqual({ days: "2", hours: "0" });
  });
  it("天＋時 → 小時；空白當 0、負數或非數字 → null", () => {
    expect(quotaInputToHours("7", "0", 8)).toBe(56);
    expect(quotaInputToHours("3", "4", 8)).toBe(28);
    expect(quotaInputToHours("", "", 8)).toBe(0);
    expect(quotaInputToHours("2", "", 7.5)).toBe(15);
    expect(quotaInputToHours("-1", "0", 8)).toBeNull();
    expect(quotaInputToHours("abc", "0", 8)).toBeNull();
  });
  it("約天數", () => {
    expect(approxDays(20, 8)).toBe(2.5);
  });
});

describe("defaultQuotaBucket", () => {
  const older = bal({ id: "b1", leave_type_id: ANNUAL.id, period_start: "2025-05-10", period_end: "2026-05-09" });
  const newer = bal({ id: "b2", leave_type_id: ANNUAL.id, period_start: "2026-05-10", period_end: "2027-05-09" });
  it("取期間包含參考日者", () => {
    expect(defaultQuotaBucket([older, newer], "2026-03-01")?.id).toBe("b1");
    expect(defaultQuotaBucket([older, newer], "2026-11-17")?.id).toBe("b2");
  });
  it("都不含 → 起日最新；沒有桶 → null", () => {
    expect(defaultQuotaBucket([older], "2026-12-31")?.id).toBe("b1");
    expect(defaultQuotaBucket([], "2026-01-01")).toBeNull();
  });
});

describe("buildQuotaRows", () => {
  const balances = [
    bal({ id: "a1", leave_type_id: ANNUAL.id, entitled: 56, deferred: 8, used: 16, period_start: "2026-05-10", period_end: "2027-05-09", source: "auto" }),
    bal({ id: "a0", leave_type_id: ANNUAL.id, entitled: 40, used: 40, period_start: "2025-05-10", period_end: "2026-05-09", source: "auto" }),
    bal({ id: "p1", leave_type_id: PERSONAL.id, entitled: 0, used: 8, period_start: "2026-01-01", period_end: "2026-12-31" }),
  ];
  const requests = [
    req({ hours: 8 }),
    req({ hours: 4, start_at: "2026-03-02T01:00:00Z" }), // 落在上一期 → 不算本期
    req({ hours: 2, status: "approved" }), // 已核准不算簽核中
    req({ hours: 3, leave_type_id: SICK.id }),
  ];
  const rows = buildQuotaRows({
    year: 2026,
    today: "2026-11-17",
    leaveTypes: [ANNUAL, SICK, MENS, PERSONAL],
    leaveTypeMeta: [{ id: MENS.id, statutoryKind: "menstrual" }, { id: SICK.id, statutoryKind: "sick" }],
    balances,
    requests,
  });

  it("每個假別一列（含沒有桶的），列序沿用 leaveTypes", () => {
    expect(rows.map((r) => r.leaveType.name)).toEqual(["特休", "病假", "生理假", "事假"]);
  });
  it("特休：預設本期桶；剩餘＝額度＋遞延−已用；簽核中只算本期", () => {
    const a = rows[0]!;
    expect(a.bucket?.id).toBe("a1");
    expect(a.bucketOptions.map((o) => o.id)).toEqual(["a1", "a0"]);
    expect([a.entitled, a.deferred, a.used, a.remaining, a.pending, a.hasQuota]).toEqual([56, 8, 16, 48, 8, true]);
  });
  it("沒有桶：不限額、簽核中依所選年度；statutoryKind 從 meta 補", () => {
    const s = rows[1]!;
    expect(s.bucket).toBeNull();
    expect(s.hasQuota).toBe(false);
    expect(s.pending).toBe(3);
    expect(s.leaveType.statutoryKind).toBe("sick");
    expect(rows[2]!.leaveType.statutoryKind).toBe("menstrual");
  });
  it("entitled=0 的記帳桶＝不限額", () => {
    expect(rows[3]!.hasQuota).toBe(false);
    expect(rows[3]!.used).toBe(8);
  });
  it("手動選上一期桶 → 數字與簽核中跟著換", () => {
    const r = buildQuotaRows({ year: 2026, today: "2026-11-17", leaveTypes: [ANNUAL], balances, requests, selectedBucket: { [ANNUAL.id]: "a0" } })[0]!;
    expect([r.bucket?.id, r.entitled, r.remaining, r.pending]).toEqual(["a0", 40, 0, 4]);
  });
});

describe("planQuotaSave", () => {
  const ctx = { employeeId: EMP, year: 2026, hoursPerDay: 8 };
  const withBucket = { leaveType: ANNUAL, bucket: bal({ id: "a1", leave_type_id: ANNUAL.id, entitled: 56 }), entitled: 56 };
  const noBucket = { leaveType: PERSONAL, bucket: null, entitled: 0 };

  it("有桶 → adjustments 差額＋原因字首", () => {
    const plan = planQuotaSave(withBucket, { days: "10", hours: "0", reason: " 依年資補給 " }, ctx);
    expect(plan).toEqual({
      kind: "adjust",
      newEntitled: 80,
      body: { employeeId: EMP, leaveTypeId: ANNUAL.id, balanceId: "a1", deltaHours: 24, reason: "設定額度為 80 小時（原 56）：依年資補給" },
    });
  });
  it("有桶、調低 → 負差額", () => {
    const plan = planQuotaSave(withBucket, { days: "3", hours: "4", reason: "更正" }, ctx);
    expect(plan.kind === "adjust" && plan.body.deltaHours).toBe(-28);
  });
  it("沒桶 → PUT 該年曆年桶，note 記原因", () => {
    expect(planQuotaSave(noBucket, { days: "7", hours: "0", reason: "公司加給" }, ctx)).toEqual({
      kind: "put",
      newEntitled: 56,
      body: { employeeId: EMP, leaveTypeId: PERSONAL.id, year: 2026, entitled: 56, note: "手動設定額度：公司加給" },
    });
  });
  it("驗證：原因必填、沒變更、非法數字、沒桶設 0", () => {
    expect(planQuotaSave(withBucket, { days: "8", hours: "0", reason: "" }, ctx)).toEqual({ kind: "error", error: "請填寫調整原因" });
    expect(planQuotaSave(withBucket, { days: "7", hours: "0", reason: "x" }, ctx)).toEqual({ kind: "error", error: "額度沒有變更" });
    expect(planQuotaSave(withBucket, { days: "-1", hours: "0", reason: "x" }, ctx).kind).toBe("error");
    expect(planQuotaSave(noBucket, { days: "0", hours: "0", reason: "x" }, ctx).kind).toBe("error");
    expect(planQuotaSave(noBucket, { days: "2000", hours: "0", reason: "x" }, ctx).kind).toBe("error");
  });
  it("quotaEditDirty", () => {
    expect(quotaEditDirty(withBucket, undefined, 8)).toBe(false);
    expect(quotaEditDirty(withBucket, { days: "7", hours: "0", reason: "" }, 8)).toBe(false);
    expect(quotaEditDirty(withBucket, { days: "7", hours: "1", reason: "" }, 8)).toBe(true);
    expect(quotaEditDirty(withBucket, { days: "x", hours: "0", reason: "" }, 8)).toBe(true);
  });
});

describe("提示文字", () => {
  it("不限額／依法", () => {
    expect(unlimitedLabel({ ...MENS, statutoryKind: "menstrual" })).toContain("每月 1 日");
    expect(unlimitedLabel({ ...SICK, statutoryKind: "sick" })).toContain("30 日");
    expect(unlimitedLabel({ code: "comp_time", name: "補休" })).toContain("補休帳");
    expect(unlimitedLabel(PERSONAL)).toBe("不限額");
  });

  const grantBase: AnnualGrantResult = {
    tenantId: "t",
    asOf: "2026-11-17",
    dryRun: true,
    migrate: false,
    basis: "anniversary",
    leaveTypeId: ANNUAL.id,
    leaveTypeCode: "annual",
    dailyRegularHours: 8,
    granted: [],
    migrated: [],
    skipped: [],
  };
  const entry = { employeeId: EMP, empNo: null, name: "A", hireDate: "2020-05-10", periodStart: "2026-05-10", periodEnd: "2027-05-09", seniorityMonths: 72, days: 14, entitledHours: 112, balanceId: null };

  it("特休：已發放 → 說明手動修改不會被覆蓋", () => {
    const h = annualLeaveHint({ ...grantBase, skipped: [{ ...entry, action: "skipped", reason: "already_granted" }] }, ANNUAL.id, 8);
    expect(h).toContain("應給 14 天");
    expect(h).toContain("不會覆蓋");
  });
  it("特休：尚未發放 → 將給；曆年制 → 不自動給；別的假別 → null", () => {
    expect(annualLeaveHint({ ...grantBase, granted: [{ ...entry, action: "granted" }] }, ANNUAL.id, 8)).toContain("將依年資");
    expect(annualLeaveHint({ ...grantBase, basis: "calendar" }, ANNUAL.id, 8)).toContain("曆年制");
    expect(annualLeaveHint(grantBase, PERSONAL.id, 8)).toBeNull();
    expect(annualLeaveHint(null, ANNUAL.id, 8)).toBeNull();
  });
});
