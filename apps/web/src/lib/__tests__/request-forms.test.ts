import { describe, it, expect } from "vitest";
import type { CreateRequestBody, LeaveRequest } from "../ess-api";
import {
  KIND_LABEL,
  KIND_ORDER,
  KIND_SHORT,
  approvalLine,
  buildCreateBody,
  describeBody,
  describeRequest,
  isBuildError,
  isRequestKind,
  needsAttachment,
  overtimeHours,
  remainingHours,
  requestErrorCode,
  requestTitle,
  type FixPunchFormValues,
  type LeaveFormValues,
  type OvertimeFormValues,
  type PettyCashFormValues,
  type TripFormValues,
} from "../request-forms";

/** 本地時間字串 → epoch，讓斷言不依賴跑測試機器的時區。 */
const local = (s: string) => new Date(s).getTime();
const at = (iso: string) => new Date(iso).getTime();

function ok(result: ReturnType<typeof buildCreateBody>): CreateRequestBody {
  if (isBuildError(result)) throw new Error(`預期成功卻得到 error：${result.error}`);
  return result;
}

const LEAVE: LeaveFormValues = {
  leaveTypeId: "11111111-1111-1111-1111-111111111111",
  segments: [
    { date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 },
    { date: "2026-09-21", startTime: "09:00", endTime: "18:00", hours: 8 },
  ],
  hours: 16,
  reason: "  家中有事  ",
};

const FIX: FixPunchFormValues = { date: "2026-09-18", type: "out", time: "18:05", reason: "忘記打卡" };

const OT: OvertimeFormValues = {
  date: "2026-09-18",
  startTime: "18:00",
  endTime: "20:30",
  breakMinutes: "30",
  payout: "comp_time",
  reason: "趕結案",
};

const TRIP: TripFormValues = {
  tripType: "business_trip",
  date: "",
  startTime: "",
  endTime: "",
  startDate: "2026-09-18",
  endDate: "2026-09-19",
  tripScope: "domestic_intercity",
  location: "台中",
  estimatedCost: "3500",
  advanceWanted: true,
  advanceRequested: "2000",
  reason: "客戶拜訪",
};

const PETTY: PettyCashFormValues = { amount: "3,000", reason: "採買文具" };

describe("KIND_LABEL／KIND_SHORT／KIND_ORDER（2026-09-23 加 wfh 標籤，表單由 WP2 補）", () => {
  it("六種 kind 都有中文標籤與短標；切換列仍是五種（wfh 表單未補前不出現）", () => {
    for (const k of ["leave", "fix_punch", "ot", "business_trip", "petty_cash", "wfh"] as const) {
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_SHORT[k]).toBeTruthy();
    }
    expect(KIND_LABEL.wfh).toBe("在家工作");
    expect(KIND_SHORT.wfh).toBe("在家");
    expect(KIND_ORDER).toEqual(["leave", "fix_punch", "ot", "business_trip", "petty_cash"]);
    expect(isRequestKind("wfh")).toBe(false);
    expect(requestTitle(row({ kind: "wfh" }))).toBe("在家工作");
  });
});

describe("buildCreateBody（五種 kind）", () => {
  it("請假：segments＋startAt/endAt 取首尾段、hours 加總、reason trim、假別帶上", () => {
    const body = ok(buildCreateBody("leave", LEAVE));
    expect(body.kind).toBe("leave");
    expect(body.leaveTypeId).toBe(LEAVE.leaveTypeId);
    expect(body.segments).toEqual(LEAVE.segments);
    expect(body.hours).toBe(16);
    expect(body.reason).toBe("家中有事");
    expect(at(body.startAt)).toBe(local("2026-09-18T09:00:00"));
    expect(at(body.endAt)).toBe(local("2026-09-21T18:00:00"));
    expect(body).not.toHaveProperty("onBehalfOfEmployeeId");
    expect(body).not.toHaveProperty("payout");
  });

  it("請假：沒有假別清單時省略 leaveTypeId；空事由省略；HR 代申請帶 onBehalfOfEmployeeId；夜班跨日 endAt 落隔日", () => {
    const body = ok(
      buildCreateBody("leave", {
        leaveTypeId: "",
        segments: [{ date: "2026-09-18", startTime: "22:00", endTime: "06:00", hours: 7 }],
        hours: 7,
        reason: "   ",
        onBehalfOfEmployeeId: "22222222-2222-2222-2222-222222222222",
      }),
    );
    expect(body).not.toHaveProperty("leaveTypeId");
    expect(body).not.toHaveProperty("reason");
    expect(body.onBehalfOfEmployeeId).toBe("22222222-2222-2222-2222-222222222222");
    expect(at(body.endAt)).toBe(local("2026-09-19T06:00:00"));
  });

  it("補卡：segments[].type、startAt = endAt、hours 0、事由必填", () => {
    const body = ok(buildCreateBody("fix_punch", FIX));
    expect(body.kind).toBe("fix_punch");
    expect(body.segments).toEqual([{ date: "2026-09-18", startTime: "18:05", endTime: "18:05", hours: 0, type: "out" }]);
    expect(body.startAt).toBe(body.endAt);
    expect(at(body.startAt)).toBe(local("2026-09-18T18:05:00"));
    expect(body.reason).toBe("忘記打卡");
    expect(buildCreateBody("fix_punch", { ...FIX, reason: "" })).toEqual({ error: "請填寫補卡原因" });
    expect(buildCreateBody("fix_punch", { ...FIX, time: "" })).toEqual({ error: "請輸入時間" });
  });

  it("加班：hours = 差 − 休息（2.5h − 30 分 = 2）、payout、reason 後綴「休息扣除：N 分鐘｜給付方式：X」", () => {
    const body = ok(buildCreateBody("ot", OT));
    expect(body.kind).toBe("ot");
    expect(body.hours).toBe(2);
    expect(body.payout).toBe("comp_time");
    expect(body.reason).toBe("趕結案｜休息扣除：30 分鐘｜給付方式：補休");
    expect(at(body.startAt)).toBe(local("2026-09-18T18:00:00"));
    expect(at(body.endAt)).toBe(local("2026-09-18T20:30:00"));
    // 沒填事由：後綴仍在；休息空字串視為 0
    const bare = ok(buildCreateBody("ot", { ...OT, reason: "", breakMinutes: "", payout: "pay" }));
    expect(bare.reason).toBe("休息扣除：0 分鐘｜給付方式：加班費");
    expect(bare.hours).toBe(2.5);
    expect(overtimeHours("22:00", "01:00", 0)).toBe(3); // 跨日
    expect(buildCreateBody("ot", { ...OT, endTime: "18:20", breakMinutes: "30" })).toEqual({
      error: "加班時數需大於 0，請確認起訖時間與休息扣除",
    });
  });

  it("出差：起迄日期全天、tripScope／location／estimatedCost／advanceRequested 欄位名照舊", () => {
    const body = ok(buildCreateBody("business_trip", TRIP));
    expect(body.kind).toBe("business_trip");
    expect(body.tripType).toBe("business_trip");
    expect(body.tripScope).toBe("domestic_intercity");
    expect(body.location).toBe("台中");
    expect(body.estimatedCost).toBe(3500);
    expect(body.advanceRequested).toBe(2000);
    expect(body.reason).toBe("客戶拜訪");
    expect(at(body.startAt)).toBe(local("2026-09-18T00:00:00"));
    expect(at(body.endAt)).toBe(local("2026-09-19T23:59:00"));
    expect(body).not.toHaveProperty("hours");
  });

  it("公出：單日起訖時間、hours＝牆鐘差、tripScope 固定 local、不勾預支就不送 advanceRequested；地點必填", () => {
    const outing: TripFormValues = {
      ...TRIP,
      tripType: "outing",
      date: "2026-09-18",
      startTime: "09:00",
      endTime: "12:00",
      estimatedCost: "",
      advanceWanted: false,
      advanceRequested: "999",
    };
    const body = ok(buildCreateBody("business_trip", outing));
    expect(body.tripType).toBe("outing");
    expect(body.tripScope).toBe("local");
    expect(body.hours).toBe(3);
    expect(body).not.toHaveProperty("advanceRequested");
    expect(body).not.toHaveProperty("estimatedCost");
    expect(at(body.startAt)).toBe(local("2026-09-18T09:00:00"));
    expect(buildCreateBody("business_trip", { ...outing, location: " " })).toEqual({ error: "請填寫地點" });
    expect(buildCreateBody("business_trip", { ...outing, endTime: "08:00" })).toEqual({ error: "結束時間需晚於開始時間" });
    expect(buildCreateBody("business_trip", { ...TRIP, advanceRequested: "" })).toEqual({ error: "請填寫預支金額" });
  });

  it("零用金預支：金額（含千分位）必填、事由必填、startAt = endAt = now", () => {
    const now = new Date("2026-09-17T02:00:00Z");
    const body = ok(buildCreateBody("petty_cash", PETTY, { now }));
    expect(body.kind).toBe("petty_cash");
    expect(body.advanceRequested).toBe(3000);
    expect(body.reason).toBe("採買文具");
    expect(body.startAt).toBe("2026-09-17T02:00:00.000Z");
    expect(body.endAt).toBe(body.startAt);
    expect(buildCreateBody("petty_cash", { amount: "", reason: "x" })).toEqual({ error: "請填寫預支金額" });
    expect(buildCreateBody("petty_cash", { amount: "0", reason: "x" })).toEqual({ error: "請填寫預支金額" });
    expect(buildCreateBody("petty_cash", { amount: "500", reason: " " })).toEqual({ error: "請填寫用途" });
  });

  it("缺必填 → error：請假沒日期、事由超過 250 字、出差迄早於起", () => {
    expect(buildCreateBody("leave", { ...LEAVE, segments: [] })).toEqual({ error: "請選擇日期" });
    expect(buildCreateBody("leave", { ...LEAVE, reason: "很".repeat(251) })).toEqual({ error: "事由請在 250 字以內" });
    expect(buildCreateBody("business_trip", { ...TRIP, endDate: "2026-09-17" })).toEqual({
      error: "結束日期不可早於開始日期",
    });
    expect(isBuildError({ error: "x" })).toBe(true);
    expect(isBuildError(ok(buildCreateBody("petty_cash", PETTY)))).toBe(false);
  });
});

/** 建一列「我的申請」（新 API 欄位可選）。 */
function row(over: Partial<LeaveRequest>): LeaveRequest {
  return {
    id: "r1",
    tenant_id: "t",
    employee_id: "e",
    kind: "leave",
    leave_type_id: null,
    start_at: "2026-09-18T01:00:00Z",
    end_at: "2026-09-18T10:00:00Z",
    hours: 8,
    reason: null,
    status: "pending",
    current_step: 1,
    created_at: "2026-09-17T00:00:00Z",
    ...over,
  };
}

const TZ = "Asia/Taipei";
const DAY_SHIFT = { start_time: "09:00:00", end_time: "18:00:00", break_minutes: 60 };

describe("describeRequest（清單第 2 行，五種）", () => {
  it("請假單日：對得上班別 → 全天／上午／下午；自訂顯示時間；多日顯示天數", () => {
    const full = row({ segments: [{ date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 }] });
    expect(describeRequest(full, { shift: DAY_SHIFT })).toBe("09/18（五）全天 · 8 小時");
    const am = row({ hours: 4, segments: [{ date: "2026-09-18", startTime: "09:00", endTime: "13:00", hours: 4 }] });
    expect(describeRequest(am, { shift: DAY_SHIFT })).toBe("09/18（五）上午 · 4 小時");
    const custom = row({ hours: 3, segments: [{ date: "2026-09-18", startTime: "13:30", endTime: "17:00", hours: 3 }] });
    expect(describeRequest(custom, { shift: DAY_SHIFT })).toBe("09/18（五）13:30–17:00 · 3 小時");
    const multi = row({
      hours: 24,
      segments: [
        { date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 },
        { date: "2026-09-21", startTime: "09:00", endTime: "18:00", hours: 8 },
        { date: "2026-09-22", startTime: "09:00", endTime: "18:00", hours: 8 },
      ],
    });
    expect(describeRequest(multi)).toBe("09/18–09/22 · 3 天 · 24 小時");
  });

  it("請假沒有 segments（舊資料）→ 退化成 start_at／end_at；hours 為 null 就不顯示時數", () => {
    const legacy = row({ hours: null, segments: null });
    expect(describeRequest(legacy, { tz: TZ })).toBe("09/18（五）09:00–18:00");
    const legacyRange = row({ start_at: "2026-09-18T01:00:00Z", end_at: "2026-09-20T10:00:00Z", hours: 16 });
    expect(describeRequest(legacyRange, { tz: TZ })).toBe("09/18–09/20 · 16 小時");
  });

  it("加班：「09/18（五）18:00–20:00 · 2 小時 · 補休」", () => {
    const ot = row({
      kind: "ot",
      start_at: "2026-09-18T10:00:00Z",
      end_at: "2026-09-18T12:00:00Z",
      hours: 2,
      payout: "comp_time",
    });
    expect(describeRequest(ot, { tz: TZ })).toBe("09/18（五）18:00–20:00 · 2 小時 · 補休");
  });

  it("補卡：「09/18（五）下班 18:05」；沒有 segments 退化成日期時間", () => {
    const fix = row({
      kind: "fix_punch",
      hours: null,
      segments: [{ date: "2026-09-18", startTime: "18:05", endTime: "18:05", hours: 0, type: "out" }],
    });
    expect(describeRequest(fix)).toBe("09/18（五）下班 18:05");
    const legacy = row({ kind: "fix_punch", hours: null, start_at: "2026-09-18T10:05:00Z", end_at: "2026-09-18T10:05:00Z" });
    expect(describeRequest(legacy, { tz: TZ })).toBe("09/18 18:05");
  });

  it("公出／出差：「09/18–09/19 · 台中 · 出差（跨縣市）」／「09/18（五）09:00–12:00 · 台北 · 公出」", () => {
    const trip = row({
      kind: "business_trip",
      start_at: "2026-09-17T16:00:00Z",
      end_at: "2026-09-19T15:59:00Z",
      hours: null,
      trip_type: "business_trip",
      trip_scope: "domestic_intercity",
      location: "台中",
    });
    expect(describeRequest(trip, { tz: TZ })).toBe("09/18–09/19 · 台中 · 出差（跨縣市）");
    const outing = row({
      kind: "business_trip",
      start_at: "2026-09-18T01:00:00Z",
      end_at: "2026-09-18T04:00:00Z",
      hours: 3,
      trip_type: "outing",
      location: "台北",
    });
    expect(describeRequest(outing, { tz: TZ })).toBe("09/18（五）09:00–12:00 · 台北 · 公出");
  });

  it("零用金預支：「NT$ 3,000」；缺金額 → —", () => {
    expect(describeRequest(row({ kind: "petty_cash", advance_requested: "3000" }))).toBe("NT$ 3,000");
    expect(describeRequest(row({ kind: "petty_cash", advance_requested: 1500.5 }))).toBe("NT$ 1,500.5");
    expect(describeRequest(row({ kind: "petty_cash" }))).toBe("—");
  });

  it("describeBody：剛送出的 body 反推同款摘要（成功畫面用）", () => {
    const body = ok(buildCreateBody("ot", OT));
    expect(describeBody(body)).toBe("09/18（五）18:00–20:30 · 2 小時 · 補休");
    const leave = ok(buildCreateBody("leave", LEAVE));
    expect(describeBody(leave, { shift: DAY_SHIFT })).toBe("09/18–09/21 · 2 天 · 16 小時");
  });
});

describe("requestTitle / approvalLine / needsAttachment / remainingHours", () => {
  it("requestTitle：請假帶假別名；公出／出差看 trip_type；其餘用種類名", () => {
    expect(requestTitle(row({ leave_type_name: "特休" }))).toBe("請假 · 特休");
    expect(requestTitle(row({}))).toBe("請假");
    expect(requestTitle(row({ kind: "business_trip", trip_type: "outing" }))).toBe("公出");
    expect(requestTitle(row({ kind: "business_trip" }))).toBe("公出／出差");
    expect(requestTitle(row({ kind: "petty_cash" }))).toBe("零用金預支");
  });

  it("approvalLine 三態：pending 等待誰（第幾關）、rejected 駁回理由、approved 已核准時間", () => {
    expect(approvalLine(row({ current_approver_name: "王小明", current_step: 1, total_steps: 2 }))).toBe(
      "等待 王小明 簽核（第 1／2 關）",
    );
    expect(approvalLine(row({ current_approver_name: "王小明", total_steps: 1 }))).toBe("等待 王小明 簽核");
    expect(approvalLine(row({ status: "rejected", decision_comment: "日期與專案衝突" }))).toBe("駁回理由：日期與專案衝突");
    expect(approvalLine(row({ status: "approved", decided_at: "2026-09-17T02:21:00Z" }), { tz: TZ })).toBe(
      "已核准 · 09/17 10:21",
    );
    expect(approvalLine(row({ status: "cancelled" }))).toBeNull();
  });

  it("approvalLine 多級簽核：多位候選用「／」串、HR 覆核關加註；有 names 時不看舊的 current_approver_name", () => {
    expect(
      approvalLine(
        row({
          current_approver_name: "HR 覆核：王小明／李小華",
          current_approver_names: ["王小明", "李小華"],
          current_step_kind: "hr",
          current_step: 3,
          total_steps: 3,
        }),
      ),
    ).toBe("等待 王小明／李小華（HR 覆核）簽核（第 3／3 關）");
    expect(
      approvalLine(row({ current_approver_names: ["王小明"], current_step_kind: "manager", current_step: 1, total_steps: 3 })),
    ).toBe("等待 王小明 簽核（第 1／3 關）");
  });

  it("approvalLine 新欄位空陣列／空白 → 退回 current_approver_name；只有 kind=hr 沒名字 → 不加註", () => {
    expect(approvalLine(row({ current_approver_names: [], current_approver_name: "王小明", total_steps: 1 }))).toBe(
      "等待 王小明 簽核",
    );
    expect(approvalLine(row({ current_approver_names: ["  "], current_approver_name: "王小明", current_step_kind: "hr" }))).toBe(
      "等待 王小明（HR 覆核）簽核",
    );
    expect(approvalLine(row({ current_step_kind: "hr", current_step: 2, total_steps: 2 }))).toBe("等待簽核（第 2／2 關）");
  });

  it("approvalLine 缺欄位（舊 API）退化成 null；只有關數沒名字 → 等待簽核（第 N／M 關）", () => {
    expect(approvalLine(row({}))).toBeNull();
    expect(approvalLine(row({ status: "rejected" }))).toBeNull();
    expect(approvalLine(row({ status: "approved" }))).toBeNull();
    expect(approvalLine(row({ current_step: 2, total_steps: 3 }))).toBe("等待簽核（第 2／3 關）");
    expect(approvalLine(row({ status: "rejected", decided_at: "2026-09-17T02:21:00Z" }), { tz: TZ })).toBe(
      "已駁回 · 09/17 10:21",
    );
  });

  it("needsAttachment：pending 請假且需憑證且 0 附件才 true；欄位缺席 → false", () => {
    expect(needsAttachment(row({ requires_attachment: true, attachment_count: 0 }))).toBe(true);
    expect(needsAttachment(row({ requires_attachment: true, attachment_count: 1 }))).toBe(false);
    expect(needsAttachment(row({ requires_attachment: false, attachment_count: 0 }))).toBe(false);
    expect(needsAttachment(row({ status: "approved", requires_attachment: true, attachment_count: 0 }))).toBe(false);
    expect(needsAttachment(row({ kind: "ot", requires_attachment: true, attachment_count: 0 }))).toBe(false);
    expect(needsAttachment(row({}))).toBe(false);
  });

  it("remainingHours 跨年度加總 entitled + deferred − used；沒有列 → null", () => {
    const balances = [
      { leave_type_id: "a", entitled: "56", used: "8", deferred: "0" },
      { leave_type_id: "a", entitled: 16, used: 0, deferred: 8 },
      { leave_type_id: "b", entitled: 30, used: 30, deferred: 0 },
    ];
    expect(remainingHours(balances, "a")).toBe(72);
    expect(remainingHours(balances, "b")).toBe(0);
    expect(remainingHours(balances, "zzz")).toBeNull();
  });

  it("requestErrorCode 剝掉 [status] 前綴", () => {
    expect(requestErrorCode(new Error("[409] no_approver_available"))).toBe("no_approver_available");
    expect(requestErrorCode(new Error("送出失敗"))).toBe("送出失敗");
    expect(requestErrorCode("x")).toBeNull();
  });
});
