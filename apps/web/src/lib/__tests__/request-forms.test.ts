import { describe, it, expect } from "vitest";
import type { CreateRequestBody, LeaveRequest, RequestStepRow } from "../ess-api";
import {
  KIND_LABEL,
  KIND_ORDER,
  KIND_SHORT,
  REQUEST_ERROR_MESSAGES,
  allDayPeriodText,
  approvalComments,
  approvalLine,
  approvalPeriodText,
  approvalWhenText,
  attachmentLimitOf,
  attachmentTooLargeText,
  attachmentUploadWarning,
  balanceBucketFor,
  buildCreateBody,
  describeBody,
  describeLeaveDay,
  describeRequest,
  fmtAttachmentLimit,
  isAllDayRequest,
  isBuildError,
  isRequestKind,
  needsAttachment,
  overtimeHours,
  remainingHours,
  requestErrorCode,
  requestErrorText,
  requestTitle,
  type FixPunchFormValues,
  type LeaveFormValues,
  type OvertimeFormValues,
  type PettyCashFormValues,
  type TripFormValues,
  type WfhFormValues,
} from "../request-forms";
import { computeLeaveSegments } from "../leave-hours";

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

const WFH: WfhFormValues = { startDate: "2026-09-18", endDate: "2026-09-19", hours: "", reason: "  在家趕結案  " };

describe("KIND_LABEL／KIND_SHORT／KIND_ORDER（2026-09-23 起含 wfh）", () => {
  it("六種 kind 都有中文標籤與短標；切換列六種、在家排在加班之後", () => {
    for (const k of ["leave", "fix_punch", "ot", "business_trip", "petty_cash", "wfh"] as const) {
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_SHORT[k]).toBeTruthy();
    }
    expect(KIND_LABEL.wfh).toBe("在家工作");
    expect(KIND_SHORT.wfh).toBe("在家");
    // 2026-10-12 起員工端不再提供獨立的「預支」表單（零用金改在公出單選「先預支」）。
    expect(KIND_ORDER).toEqual(["leave", "fix_punch", "ot", "wfh", "business_trip"]);
    expect(KIND_ORDER).not.toContain("petty_cash");
    expect(isRequestKind("wfh")).toBe(true);
    expect(requestTitle(row({ kind: "wfh" }))).toBe("在家工作");
  });
});

describe("buildCreateBody（六種 kind）", () => {
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

  it("請假：沒有假別清單時省略 leaveTypeId；空事由省略；夜班跨日 endAt 落隔日", () => {
    const body = ok(
      buildCreateBody("leave", {
        leaveTypeId: "",
        segments: [{ date: "2026-09-18", startTime: "22:00", endTime: "06:00", hours: 7 }],
        hours: 7,
        reason: "   ",
      }),
    );
    expect(body).not.toHaveProperty("leaveTypeId");
    expect(body).not.toHaveProperty("reason");
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

  it("在家工作：起日 00:00 到迄日 23:59、時數留空就不帶、事由 trim", () => {
    const body = ok(buildCreateBody("wfh", WFH));
    expect(body.kind).toBe("wfh");
    expect(at(body.startAt)).toBe(local("2026-09-18T00:00:00"));
    expect(at(body.endAt)).toBe(local("2026-09-19T23:59:00"));
    expect(body).not.toHaveProperty("hours");
    expect(body.reason).toBe("在家趕結案");
    expect(body).not.toHaveProperty("onBehalfOfEmployeeId");
  });

  it("在家工作：填了時數就帶（四捨五入 2 位）；空事由省略", () => {
    const body = ok(
      buildCreateBody("wfh", {
        ...WFH,
        hours: "6.755",
        reason: "",
      }),
    );
    expect(body.hours).toBe(6.76);
    expect(body).not.toHaveProperty("reason");
  });

  it("在家工作：日期不合法／迄早於起／時數 0 或負數 → error", () => {
    expect(buildCreateBody("wfh", { ...WFH, startDate: "" })).toEqual({ error: "請選擇起迄日期" });
    expect(buildCreateBody("wfh", { ...WFH, endDate: "2026-09-17" })).toEqual({ error: "結束日期不可早於開始日期" });
    expect(buildCreateBody("wfh", { ...WFH, hours: "0" })).toEqual({ error: "時數請填正數，或留空依正常工時計算" });
    expect(buildCreateBody("wfh", { ...WFH, hours: "-3" })).toEqual({ error: "時數請填正數，或留空依正常工時計算" });
    expect(buildCreateBody("wfh", { ...WFH, reason: "很".repeat(251) })).toEqual({ error: "事由請在 250 字以內" });
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
  it("請假單日：對得上班別 → 全天（不附時數）／上午／下午；自訂顯示時間；多日只留請假時數", () => {
    const full = row({ segments: [{ date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 }] });
    expect(describeRequest(full, { shift: DAY_SHIFT })).toBe("09/18（五）全天");
    // 上午／下午以午休 12:00–13:00 為界（2026-10-11 業主採 B）→ 上午 09:00–12:00 3 時、下午 13:00–18:00 5 時。
    const am = row({ hours: 3, segments: [{ date: "2026-09-18", startTime: "09:00", endTime: "12:00", hours: 3 }] });
    expect(describeRequest(am, { shift: DAY_SHIFT })).toBe("09/18（五）上午 · 3 時");
    const pm = row({ hours: 5, segments: [{ date: "2026-09-18", startTime: "13:00", endTime: "18:00", hours: 5 }] });
    expect(describeRequest(pm, { shift: DAY_SHIFT })).toBe("09/18（五）下午 · 5 時");
    const custom = row({ hours: 3, segments: [{ date: "2026-09-18", startTime: "13:30", endTime: "17:00", hours: 3 }] });
    expect(describeRequest(custom, { shift: DAY_SHIFT })).toBe("09/18（五）13:30–17:00 · 3 時");
    const multi = row({
      hours: 24,
      segments: [
        { date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 },
        { date: "2026-09-21", startTime: "09:00", endTime: "18:00", hours: 8 },
        { date: "2026-09-22", startTime: "09:00", endTime: "18:00", hours: 8 },
      ],
    });
    // 24 小時 ＝ 3 天；不再另附日曆天數（日期範圍已經看得出橫跨幾天，避免兩個「天」並排）。
    expect(describeRequest(multi)).toBe("09/18–09/22 · 3 天");
  });

  it("請假沒有 segments（舊資料）→ 退化成 start_at／end_at；hours 為 null 就不顯示時數", () => {
    const legacy = row({ hours: null, segments: null });
    expect(describeRequest(legacy, { tz: TZ })).toBe("09/18（五）09:00–18:00");
    const legacyRange = row({ start_at: "2026-09-18T01:00:00Z", end_at: "2026-09-20T10:00:00Z", hours: 16 });
    expect(describeRequest(legacyRange, { tz: TZ })).toBe("09/18–09/20 · 2 天");
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

  it("在家工作：單日「09/18（五）全天」、跨日「09/18–09/19」；有時數才加時數", () => {
    const oneDay = row({
      kind: "wfh",
      hours: null,
      start_at: "2026-09-17T16:00:00Z", // 台北 09/18 00:00
      end_at: "2026-09-18T15:59:00Z", // 台北 09/18 23:59
    });
    expect(describeRequest(oneDay, { tz: TZ })).toBe("09/18（五）全天");
    const span = row({
      kind: "wfh",
      hours: 12,
      start_at: "2026-09-17T16:00:00Z",
      end_at: "2026-09-19T15:59:00Z",
    });
    expect(describeRequest(span, { tz: TZ })).toBe("09/18–09/19 · 12 小時");
  });

  it("describeBody：剛送出的 body 反推同款摘要（成功畫面用）", () => {
    const body = ok(buildCreateBody("ot", OT));
    expect(describeBody(body)).toBe("09/18（五）18:00–20:30 · 2 小時 · 補休");
    const leave = ok(buildCreateBody("leave", LEAVE));
    expect(describeBody(leave, { shift: DAY_SHIFT })).toBe("09/18–09/21 · 2 天");
    const wfh = ok(buildCreateBody("wfh", WFH));
    expect(describeBody(wfh)).toBe("09/18–09/19");
  });
});

describe("requestTitle / approvalLine / needsAttachment / remainingHours", () => {
  it("requestTitle：請假帶假別名；公出／出差看 trip_type；其餘用種類名", () => {
    expect(requestTitle(row({ leave_type_name: "特休" }))).toBe("請假 · 特休");
    expect(requestTitle(row({}))).toBe("請假");
    expect(requestTitle(row({ kind: "business_trip", trip_type: "outing" }))).toBe("公出");
    expect(requestTitle(row({ kind: "business_trip" }))).toBe("公出／出差");
    expect(requestTitle(row({ kind: "petty_cash" }))).toBe("零用金預支");
    expect(requestTitle(row({ kind: "wfh" }))).toBe("在家工作");
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

  it("remainingHours（週年制，W1）：兩個桶只取含申請起日那一個，不再全部加總", () => {
    // 到職 05-10：2025-05-10～2026-05-09 舊期（已用完）、2026-05-10～2027-05-09 新期
    const balances = [
      {
        leave_type_id: "a",
        entitled: "56",
        used: "56",
        deferred: "0",
        year: 2025,
        period_start: "2025-05-10",
        period_end: "2026-05-09",
      },
      {
        leave_type_id: "a",
        entitled: 120,
        used: 8,
        deferred: 8,
        year: 2026,
        period_start: "2026-05-10",
        period_end: "2027-05-09",
      },
    ];
    expect(remainingHours(balances, "a", "2026-09-22")).toBe(120); // 新期：120 + 8 − 8
    expect(remainingHours(balances, "a", "2026-01-10")).toBe(0); // 舊期：56 + 0 − 56
    // 兩個期間都沒涵蓋（還沒發放）→ null，畫面顯示「尚未設定額度」而不是錯的數字
    expect(remainingHours(balances, "a", "2027-06-01")).toBeNull();
    expect(remainingHours(balances, "zzz", "2026-09-22")).toBeNull();
  });

  it("remainingHours：沒有 period 欄的舊列退回用 year 對申請起日的年份", () => {
    const legacy = [
      { leave_type_id: "a", entitled: "56", used: "8", deferred: "0", year: 2025 },
      { leave_type_id: "a", entitled: 16, used: 0, deferred: 8, year: 2026 },
      { leave_type_id: "b", entitled: 30, used: 30, deferred: 0, year: 2026 },
    ];
    expect(remainingHours(legacy, "a", "2026-09-22")).toBe(24); // 16 + 8 − 0
    expect(remainingHours(legacy, "a", "2025-12-31")).toBe(48); // 56 + 0 − 8
    expect(remainingHours(legacy, "b", "2026-03-01")).toBe(0);
    expect(remainingHours(legacy, "a", "2024-01-01")).toBeNull();
  });

  it("balanceBucketFor：有期間的列優先；都沒中才退回 year；同假別無列 → null", () => {
    const mixed = [
      { leave_type_id: "a", entitled: 8, used: 0, deferred: 0, year: 2026 },
      {
        leave_type_id: "a",
        entitled: 80,
        used: 0,
        deferred: 0,
        year: 2026,
        period_start: "2026-05-10",
        period_end: "2027-05-09",
      },
    ];
    expect(balanceBucketFor(mixed, "a", "2026-09-22")?.entitled).toBe(80);
    // 期間外 → 退回沒有 period 欄的曆年列（year 2026）
    expect(balanceBucketFor(mixed, "a", "2026-01-05")?.entitled).toBe(8);
    expect(balanceBucketFor(mixed, "b", "2026-09-22")).toBeNull();
  });

  it("requestErrorCode 剝掉 [status] 前綴", () => {
    expect(requestErrorCode(new Error("[409] no_approver_available"))).toBe("no_approver_available");
    expect(requestErrorCode(new Error("送出失敗"))).toBe("送出失敗");
    expect(requestErrorCode("x")).toBeNull();
  });
});

describe("代申請已移除（申請人一律是登入者本人）", () => {
  // 代申請欄位已不在表單值型別裡；這裡用 spread 硬塞，模擬呼叫端（舊程式碼）還傳進來。
  const STALE_PROXY = { onBehalfOfEmployeeId: "22222222-2222-2222-2222-222222222222" };

  it("六種申請：就算呼叫端硬塞 onBehalfOfEmployeeId，送出的 body 也不會帶這個欄位", () => {
    const bodies = [
      ok(buildCreateBody("leave", { ...LEAVE, ...STALE_PROXY })),
      ok(buildCreateBody("fix_punch", { ...FIX, ...STALE_PROXY })),
      ok(buildCreateBody("ot", { ...OT, ...STALE_PROXY })),
      ok(buildCreateBody("business_trip", { ...TRIP, ...STALE_PROXY })),
      ok(buildCreateBody("petty_cash", { ...PETTY, ...STALE_PROXY })),
      ok(buildCreateBody("wfh", { ...WFH, ...STALE_PROXY })),
    ];
    expect(bodies.map((body) => body.kind)).toEqual(["leave", "fix_punch", "ot", "business_trip", "petty_cash", "wfh"]);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("onBehalfOfEmployeeId");
      expect(JSON.stringify(body)).not.toContain(STALE_PROXY.onBehalfOfEmployeeId);
    }
  });

  it("API 的 filing_on_behalf_removed 有中文保底訊息；舊的兩個代申請錯誤碼已拿掉", () => {
    expect(REQUEST_ERROR_MESSAGES.filing_on_behalf_removed).toContain("代為申請功能已移除");
    expect(REQUEST_ERROR_MESSAGES).not.toHaveProperty("proxy_filing_requires_hr");
    expect(REQUEST_ERROR_MESSAGES).not.toHaveProperty("target_employee_not_found");
  });
});

/* ------------------------------------------------------------------------
 * 請假單位精細到小時（2026-10-11）：多日首尾部分天的 body 與顯示文案。
 * 同一組資料（10/13 14:00–18:00 4h、10/14 全天 8h、10/15 09:00–12:00 3h ＝ 15 小時）
 * 也用在 apps/api 的 leave-partial-days.test.ts，前後端數字對得上。
 * ---------------------------------------------------------------------- */

const PARTIAL_SEGMENTS = [
  { date: "2026-10-13", startTime: "14:00", endTime: "18:00", hours: 4 },
  { date: "2026-10-14", startTime: "09:00", endTime: "18:00", hours: 8 },
  { date: "2026-10-15", startTime: "09:00", endTime: "12:00", hours: 3 },
];

describe("請假精細到小時：body 與顯示", () => {
  it("buildCreateBody：多日首尾部分天 → startAt＝首日開始時間、endAt＝末日結束時間、hours 15、segments 原樣", () => {
    const body = ok(
      buildCreateBody("leave", { leaveTypeId: LEAVE.leaveTypeId, segments: PARTIAL_SEGMENTS, hours: 15, reason: "" }),
    );
    expect(body.kind).toBe("leave");
    expect(at(body.startAt)).toBe(local("2026-10-13T14:00:00"));
    expect(at(body.endAt)).toBe(local("2026-10-15T12:00:00"));
    expect(body.hours).toBe(15);
    expect(body.segments).toEqual(PARTIAL_SEGMENTS);
  });

  it("describeLeaveDay：逐日一行「10/13（二）14:00–18:00 4 時」；整天（對得上班別）只寫「全天」", () => {
    expect(describeLeaveDay(PARTIAL_SEGMENTS[0], DAY_SHIFT)).toBe("10/13（二）14:00–18:00 4 時");
    expect(describeLeaveDay(PARTIAL_SEGMENTS[1], DAY_SHIFT)).toBe("10/14（三）全天");
    expect(describeLeaveDay(PARTIAL_SEGMENTS[2], DAY_SHIFT)).toBe("10/15（四）09:00–12:00 3 時");
    // 沒有班別可比 → 不敢說全天，照實寫時間與（天＋時）時數
    expect(describeLeaveDay(PARTIAL_SEGMENTS[1], undefined)).toBe("10/14（三）09:00–18:00 1 天");
    // 班別不同（夜班）→ 同樣的時段不算全天
    expect(describeLeaveDay(PARTIAL_SEGMENTS[1], { start_time: "22:00", end_time: "06:00" })).toBe("10/14（三）09:00–18:00 1 天");
  });

  it("describeLeaveDay：每日工時不是 8（規則 payroll.dailyRegularHours）→ 照該值換算；整天仍只寫「全天」", () => {
    const eightHours = { date: "2026-10-14", startTime: "09:00", endTime: "17:30", hours: 8 };
    expect(describeLeaveDay(eightHours, undefined, 7.5)).toBe("10/14（三）09:00–17:30 1 天 30 分");
    expect(describeLeaveDay(eightHours, undefined)).toBe("10/14（三）09:00–17:30 1 天");
    expect(describeLeaveDay(PARTIAL_SEGMENTS[1], DAY_SHIFT, 7.5)).toBe("10/14（三）全天");
  });

  it("describeRequest：多日首日從中途開始／末日請到中途 → 「10/13 14:00 – 10/15 12:00 · 1 天 7 時」（只留請假時數，不附日曆天數）", () => {
    const partial = row({ hours: 15, segments: PARTIAL_SEGMENTS });
    expect(describeRequest(partial, { shift: DAY_SHIFT })).toBe("10/13 14:00 – 10/15 12:00 · 1 天 7 時");
    // 沒傳班別 → 退回預設班別 09:00–18:00，結果相同
    expect(describeRequest(partial)).toBe("10/13 14:00 – 10/15 12:00 · 1 天 7 時");
    // 不會同時出現日曆天數（橫跨 3 日）與請假天數兩個「天」
    expect(describeRequest(partial)).not.toMatch(/3 天/);
  });

  it("describeRequest／describeBody：每日工時不是 8 → 請假照該值換算；加班、在家工作永遠是小時", () => {
    const partial = row({ hours: 15, segments: PARTIAL_SEGMENTS });
    expect(describeRequest(partial, { shift: DAY_SHIFT, hoursPerDay: 7.5 })).toBe("10/13 14:00 – 10/15 12:00 · 2 天");
    const body = ok(buildCreateBody("leave", { leaveTypeId: LEAVE.leaveTypeId, segments: PARTIAL_SEGMENTS, hours: 15, reason: "" }));
    expect(describeBody(body, { shift: DAY_SHIFT, hoursPerDay: 7.5 })).toBe("10/13 14:00 – 10/15 12:00 · 2 天");
    expect(describeBody(body, { shift: DAY_SHIFT })).toBe("10/13 14:00 – 10/15 12:00 · 1 天 7 時");

    // 加班 8 小時、在家工作 8 小時：不是請假，不能被換成「1 天」（也不受每日工時影響）。
    const ot = row({ kind: "ot", start_at: "2026-10-13T00:00:00Z", end_at: "2026-10-13T08:00:00Z", hours: 8, payout: "pay" });
    expect(describeRequest(ot, { tz: TZ })).toBe("10/13（二）08:00–16:00 · 8 小時 · 加班費");
    expect(describeRequest(ot, { tz: TZ, hoursPerDay: 7.5 })).toBe("10/13（二）08:00–16:00 · 8 小時 · 加班費");
    const wfh = row({ kind: "wfh", hours: 8, start_at: "2026-10-12T16:00:00Z", end_at: "2026-10-13T15:59:00Z" });
    expect(describeRequest(wfh, { tz: TZ })).toBe("10/13（二）全天 · 8 小時");
    expect(describeRequest(wfh, { tz: TZ, hoursPerDay: 7.5 })).toBe("10/13（二）全天 · 8 小時");
  });

  it("describeRequest：只有首日從中途開始、或只有末日請到中途，也把起訖時間寫出來；兩端整天是「10/13–10/15 · 3 天」", () => {
    const startOnly = row({
      hours: 20,
      segments: [PARTIAL_SEGMENTS[0], PARTIAL_SEGMENTS[1], { date: "2026-10-15", startTime: "09:00", endTime: "18:00", hours: 8 }],
    });
    expect(describeRequest(startOnly, { shift: DAY_SHIFT })).toBe("10/13 14:00 – 10/15 18:00 · 2 天 4 時");
    const endOnly = row({
      hours: 19,
      segments: [{ date: "2026-10-13", startTime: "09:00", endTime: "18:00", hours: 8 }, PARTIAL_SEGMENTS[1], PARTIAL_SEGMENTS[2]],
    });
    expect(describeRequest(endOnly, { shift: DAY_SHIFT })).toBe("10/13 09:00 – 10/15 12:00 · 2 天 3 時");
    const whole = row({
      hours: 24,
      segments: PARTIAL_SEGMENTS.map((seg) => ({ ...seg, startTime: "09:00", endTime: "18:00", hours: 8 })),
    });
    expect(describeRequest(whole, { shift: DAY_SHIFT })).toBe("10/13–10/15 · 3 天");
  });

  it("describeRequest：單日指定時數 → 時段顯示起訖；剛好是上午／下午就用字", () => {
    const three = row({ hours: 3, segments: [{ date: "2026-10-13", startTime: "10:00", endTime: "13:00", hours: 3 }] });
    expect(describeRequest(three, { shift: DAY_SHIFT })).toBe("10/13（二）10:00–13:00 · 3 時");
    const across = row({ hours: 3, segments: [{ date: "2026-10-13", startTime: "11:00", endTime: "15:00", hours: 3 }] });
    expect(describeRequest(across, { shift: DAY_SHIFT })).toBe("10/13（二）11:00–15:00 · 3 時");
    const am = row({ hours: 3, segments: [{ date: "2026-10-13", startTime: "09:00", endTime: "12:00", hours: 3 }] });
    expect(describeRequest(am, { shift: DAY_SHIFT })).toBe("10/13（二）上午 · 3 時");
    // 已送出的舊半天假不回溯改資料：對不上新的上午／下午 → 照實顯示起訖與當時的時數。
    //   午休改到 12:00–13:00 之前的舊上午單（09:00–13:00）、各 4 小時版的上午／下午單（09:00–14:00／14:00–18:00）。
    const oldAm = row({ hours: 4, segments: [{ date: "2026-10-13", startTime: "09:00", endTime: "13:00", hours: 4 }] });
    expect(describeRequest(oldAm, { shift: DAY_SHIFT })).toBe("10/13（二）09:00–13:00 · 4 時");
    const fourHourAm = row({ hours: 4, segments: [{ date: "2026-10-13", startTime: "09:00", endTime: "14:00", hours: 4 }] });
    expect(describeRequest(fourHourAm, { shift: DAY_SHIFT })).toBe("10/13（二）09:00–14:00 · 4 時");
    const fourHourPm = row({ hours: 4, segments: [{ date: "2026-10-13", startTime: "14:00", endTime: "18:00", hours: 4 }] });
    expect(describeRequest(fourHourPm, { shift: DAY_SHIFT })).toBe("10/13（二）14:00–18:00 · 4 時");
  });

  it("表單到成功畫面一條龍：computeLeaveSegments → buildCreateBody → describeBody（含午休與週末）", () => {
    const calc = computeLeaveSegments({
      startDate: "2026-10-16", // 週五
      endDate: "2026-10-19", // 下週一
      period: "full",
      startTime: "14:00",
      endTime: "12:00",
      shiftByDate: {},
      defaultShift: DAY_SHIFT,
      dayTypeByDate: {},
    });
    expect(calc.error).toBeUndefined();
    expect(calc.totalHours).toBe(7); // 週五 14–18 ＝ 4、週末不計、週一 09–12 ＝ 3
    const body = ok(
      buildCreateBody("leave", { leaveTypeId: LEAVE.leaveTypeId, segments: calc.segments, hours: calc.totalHours, reason: "" }),
    );
    expect(body.hours).toBe(7);
    expect(at(body.startAt)).toBe(local("2026-10-16T14:00:00"));
    expect(at(body.endAt)).toBe(local("2026-10-19T12:00:00"));
    expect(describeBody(body, { shift: DAY_SHIFT })).toBe("10/16 14:00 – 10/19 12:00 · 7 時");
  });
});

/* ----------------------------------------------------------------------
 * 2026-10-12 教育訓練驗收：
 *   • 整天型申請（出差、在家工作）web 表單存成「起日 00:00～迄日 23:59」→ 簽核卡與我的申請只顯示日期，不印時刻；公出保留時刻。
 *   • 兩關以上的單，第一關主管加註的意見申請人看不到 → 我的申請要列出各關簽核意見。
 * ---------------------------------------------------------------------- */

// 台北 09/18 00:00 ～ 23:59（瀏覽器時區的整天）
const DAY_START = "2026-09-17T16:00:00Z";
const DAY_END = "2026-09-18T15:59:00Z";

/** 一張出差單（預設：整天、單日、跨縣市）。 */
function tripRow(over: Partial<LeaveRequest> = {}): LeaveRequest {
  return row({
    kind: "business_trip",
    hours: null,
    start_at: DAY_START,
    end_at: DAY_END,
    trip_type: "business_trip",
    trip_scope: "domestic_intercity",
    location: "台中",
    ...over,
  });
}

/** 一張公出單（有起訖時刻）。 */
function outingRow(over: Partial<LeaveRequest> = {}): LeaveRequest {
  return tripRow({
    trip_type: "outing",
    trip_scope: "local",
    location: "台北",
    hours: 3,
    start_at: "2026-09-18T01:00:00Z", // 台北 09:00
    end_at: "2026-09-18T04:00:00Z", // 台北 12:00
    ...over,
  });
}

describe("isAllDayRequest / allDayPeriodText（整天型＝出差與在家工作，看 kind／trip_type）", () => {
  it("isAllDayRequest：出差、在家工作 → true；公出、舊列 trip_type 缺席、其他種類 → false", () => {
    expect(isAllDayRequest(tripRow())).toBe(true);
    expect(isAllDayRequest(row({ kind: "wfh" }))).toBe(true);
    expect(isAllDayRequest(outingRow())).toBe(false);
    expect(isAllDayRequest(tripRow({ trip_type: null }))).toBe(false);
    expect(isAllDayRequest(tripRow({ trip_type: undefined }))).toBe(false);
    for (const kind of ["leave", "ot", "fix_punch", "petty_cash"] as const) {
      // 就算資料裡誤帶 trip_type，非出差／在家工作的種類也不算整天型
      expect(isAllDayRequest(row({ kind, trip_type: "business_trip" }))).toBe(false);
    }
  });

  it("allDayPeriodText：出差單日「09/18（五）」、多日「09/18（五）～ 09/19（六）」、跨年「12/31（四）～ 01/02（六）」", () => {
    expect(allDayPeriodText(tripRow(), TZ)).toBe("09/18（五）");
    expect(allDayPeriodText(tripRow({ end_at: "2026-09-19T15:59:00Z" }), TZ)).toBe("09/18（五）～ 09/19（六）");
    expect(allDayPeriodText(tripRow({ start_at: "2026-12-30T16:00:00Z", end_at: "2027-01-02T15:59:00Z" }), TZ)).toBe(
      "12/31（四）～ 01/02（六）",
    );
  });

  it("allDayPeriodText：在家工作與我的申請同一份文案（單日「09/18（五）全天」、跨日「09/18–09/19」）", () => {
    const one = row({ kind: "wfh", hours: null, start_at: DAY_START, end_at: DAY_END });
    expect(allDayPeriodText(one, TZ)).toBe("09/18（五）全天");
    const span = row({ kind: "wfh", hours: null, start_at: DAY_START, end_at: "2026-09-19T15:59:00Z" });
    expect(allDayPeriodText(span, TZ)).toBe("09/18–09/19");
    // 沒有時數時，兩邊的期間文字逐字相同（describeRequest 的 wfh 分支沒有別的東西）
    expect(allDayPeriodText(one, TZ)).toBe(describeRequest(one, { tz: TZ }));
    expect(allDayPeriodText(span, TZ)).toBe(describeRequest(span, { tz: TZ }));
  });

  it("allDayPeriodText：公出、舊列 trip_type 缺席、其他種類 → null（呼叫端走原本的起訖時刻）；日期無效也是 null", () => {
    expect(allDayPeriodText(outingRow(), TZ)).toBeNull();
    expect(allDayPeriodText(tripRow({ trip_type: null }), TZ)).toBeNull();
    expect(allDayPeriodText(row({ kind: "ot" }), TZ)).toBeNull();
    expect(allDayPeriodText(row({ kind: "leave" }), TZ)).toBeNull();
    expect(allDayPeriodText(tripRow({ start_at: "not-a-date" }), TZ)).toBeNull();
    expect(allDayPeriodText(row({ kind: "wfh", start_at: "not-a-date" }), TZ)).toBeNull();
  });
});

describe("整天出差只顯示日期：我的申請 describeRequest", () => {
  it("單日出差「09/18（五） · 台中 · 出差（跨縣市）」，不再印 00:00–23:59", () => {
    const text = describeRequest(tripRow(), { tz: TZ });
    expect(text).toBe("09/18（五） · 台中 · 出差（跨縣市）");
    expect(text).not.toMatch(/00:00|23:59/);
  });

  it("多日、跨年的出差維持「起–迄」日期（本來就沒有時刻）", () => {
    expect(describeRequest(tripRow({ end_at: "2026-09-19T15:59:00Z" }), { tz: TZ })).toBe("09/18–09/19 · 台中 · 出差（跨縣市）");
    expect(describeRequest(tripRow({ start_at: "2026-12-30T16:00:00Z", end_at: "2027-01-02T15:59:00Z" }), { tz: TZ })).toBe(
      "12/31–01/02 · 台中 · 出差（跨縣市）",
    );
  });

  it("公出保留起訖時刻；就算剛好填 00:00–23:59 也不被誤當整天（判斷看 trip_type，不看時刻）", () => {
    expect(describeRequest(outingRow(), { tz: TZ })).toBe("09/18（五）09:00–12:00 · 台北 · 公出");
    expect(describeRequest(outingRow({ start_at: DAY_START, end_at: DAY_END }), { tz: TZ })).toBe(
      "09/18（五）00:00–23:59 · 台北 · 公出",
    );
  });

  it("舊列 trip_type 缺席的出差分辨不出整天 → 維持顯示時刻（不靠 00:00／23:59 猜）", () => {
    expect(describeRequest(tripRow({ trip_type: null, trip_scope: null }), { tz: TZ })).toBe(
      "09/18（五）00:00–23:59 · 台中 · 公出／出差",
    );
  });

  it("在家工作維持原樣（單日「全天」、跨日只有日期）；表單送出後的成功畫面（describeBody）出差單日也只有日期", () => {
    const wfh = row({ kind: "wfh", hours: null, start_at: DAY_START, end_at: DAY_END });
    expect(describeRequest(wfh, { tz: TZ })).toBe("09/18（五）全天");
    const body = ok(buildCreateBody("business_trip", { ...TRIP, startDate: "2026-09-18", endDate: "2026-09-18" }));
    expect(describeBody(body)).toBe("09/18（五） · 台中 · 出差（跨縣市）");
    const multi = ok(buildCreateBody("business_trip", TRIP)); // 09/18–09/19
    expect(describeBody(multi)).toBe("09/18–09/19 · 台中 · 出差（跨縣市）");
  });
});

describe("整天出差只顯示日期：主管簽核卡 approvalPeriodText", () => {
  it("出差單日「09/18（五）」、多日「09/18（五）～ 09/19（六）」、跨年「12/31（四）～ 01/02（六）」，不印 00:00／23:59", () => {
    expect(approvalPeriodText(tripRow(), { tz: TZ })).toBe("09/18（五）");
    expect(approvalPeriodText(tripRow({ end_at: "2026-09-19T15:59:00Z" }), { tz: TZ })).toBe("09/18（五）～ 09/19（六）");
    expect(
      approvalPeriodText(tripRow({ start_at: "2026-12-30T16:00:00Z", end_at: "2027-01-02T15:59:00Z" }), { tz: TZ }),
    ).toBe("12/31（四）～ 01/02（六）");
    expect(approvalPeriodText(tripRow({ end_at: "2026-09-19T15:59:00Z" }), { tz: TZ })).not.toMatch(/00:00|23:59/);
  });

  it("出差若帶了時數（舊資料）仍接在日期後面", () => {
    expect(approvalPeriodText(tripRow({ hours: 16 }), { tz: TZ })).toBe("09/18（五） · 16 小時");
  });

  it("在家工作只顯示日期，與我的申請同一份文案（含時數）", () => {
    const one = row({ kind: "wfh", hours: 8, start_at: DAY_START, end_at: DAY_END });
    expect(approvalPeriodText(one, { tz: TZ })).toBe("09/18（五）全天 · 8 小時");
    expect(approvalPeriodText(one, { tz: TZ })).toBe(describeRequest(one, { tz: TZ }));
    const span = row({ kind: "wfh", hours: 16, start_at: DAY_START, end_at: "2026-09-19T15:59:00Z" });
    expect(approvalPeriodText(span, { tz: TZ })).toBe("09/18–09/19 · 16 小時");
    expect(approvalPeriodText(span, { tz: TZ })).toBe(describeRequest(span, { tz: TZ }));
    const noHours = row({ kind: "wfh", hours: null, start_at: DAY_START, end_at: "2026-09-19T15:59:00Z" });
    expect(approvalPeriodText(noHours, { tz: TZ })).toBe("09/18–09/19");
  });

  it("公出保留起訖時刻；舊列 trip_type 缺席也照舊顯示時刻（就算剛好是 00:00–23:59）", () => {
    expect(approvalPeriodText(outingRow(), { tz: TZ })).toBe("09/18 09:00 ～ 09/18 12:00 · 3 小時");
    expect(approvalPeriodText(outingRow({ hours: null, start_at: DAY_START, end_at: DAY_END }), { tz: TZ })).toBe(
      "09/18 00:00 ～ 09/18 23:59",
    );
    expect(approvalPeriodText(tripRow({ trip_type: null }), { tz: TZ })).toBe("09/18 00:00 ～ 09/18 23:59");
  });

  it("其他種類格式不變：加班「起 ～ 迄 · 小時」、補卡（起訖同一分鐘）只有起始、請假走分段摘要", () => {
    const ot = row({ kind: "ot", start_at: "2026-09-18T10:00:00Z", end_at: "2026-09-18T12:00:00Z", hours: 2, payout: "comp_time" });
    expect(approvalPeriodText(ot, { tz: TZ })).toBe("09/18 18:00 ～ 09/18 20:00 · 2 小時");
    const fix = row({ kind: "fix_punch", hours: null, start_at: "2026-09-18T10:05:00Z", end_at: "2026-09-18T10:05:00Z" });
    expect(approvalPeriodText(fix, { tz: TZ })).toBe("09/18 18:05");
    const leave = row({ segments: [{ date: "2026-09-18", startTime: "09:00", endTime: "18:00", hours: 8 }] });
    expect(approvalPeriodText(leave, { tz: TZ })).toBe("09/18 09:00–18:00 · 1 天");
    // 結束時間缺席 → 只顯示起始，不印「～ —」
    expect(approvalPeriodText(row({ kind: "ot", hours: null, end_at: "" }), { tz: TZ })).toBe("09/18 09:00");
  });
});

/** 一關（GET /requests 列上的 steps[]，snake_case）；預設＝王小明（主管）核准、台北 10/12 14:05、沒填意見。 */
function step(over: Partial<RequestStepRow> = {}): RequestStepRow {
  return {
    step_order: 1,
    approver_emp_id: "emp-mgr",
    approver_name: "王小明",
    candidate_emp_ids: ["emp-mgr"],
    candidate_names: ["王小明"],
    kind: "manager",
    decision: "approved",
    comment: null,
    acted_at: "2026-10-12T06:05:00Z",
    ...over,
  };
}

/** 第 2 關＝老闆（fallback），預設 10/12 15:30 核准。 */
function bossStep(over: Partial<RequestStepRow> = {}): RequestStepRow {
  return step({
    step_order: 2,
    approver_emp_id: "emp-boss",
    approver_name: "陳老闆",
    candidate_emp_ids: ["emp-boss"],
    candidate_names: ["陳老闆"],
    kind: "fallback",
    acted_at: "2026-10-12T07:30:00Z",
    ...over,
  });
}

describe("approvalComments（我的申請的各關簽核意見）", () => {
  it("兩關都有意見 → 依關卡順序各一行：「第 1 關・王小明 已核准 10/12 14:05：…」", () => {
    const r = row({
      status: "approved",
      current_step: 2,
      total_steps: 2,
      steps: [step({ comment: "先放行，注意交接" }), bossStep({ comment: "同意" })],
    });
    expect(approvalComments(r, { tz: TZ })).toEqual([
      "第 1 關・王小明 已核准 10/12 14:05：先放行，注意交接",
      "第 2 關・陳老闆 已核准 10/12 15:30：同意",
    ]);
  });

  it("只有第一關有意見、第二關還在待簽 → 第一關主管的意見看得到（驗收抓到的洞），簽核狀態行不變", () => {
    const r = row({
      status: "pending",
      current_step: 2,
      total_steps: 2,
      current_approver_name: "陳老闆",
      steps: [step({ comment: "預算已確認" }), bossStep({ decision: "pending", comment: null, acted_at: null })],
    });
    expect(approvalComments(r, { tz: TZ })).toEqual(["第 1 關・王小明 已核准 10/12 14:05：預算已確認"]);
    expect(approvalLine(r, { tz: TZ })).toBe("等待 陳老闆 簽核（第 2／2 關）");
  });

  it("第二關駁回 → 駁回理由已在 approvalLine，不重複；第一關的意見照列", () => {
    const r = row({
      status: "rejected",
      current_step: 2,
      total_steps: 2,
      decision_comment: "日期與專案衝突",
      decided_at: "2026-10-12T07:30:00Z",
      steps: [step({ comment: "我這關沒問題" }), bossStep({ decision: "rejected", comment: "日期與專案衝突" })],
    });
    expect(approvalLine(r, { tz: TZ })).toBe("駁回理由：日期與專案衝突");
    expect(approvalComments(r, { tz: TZ })).toEqual(["第 1 關・王小明 已核准 10/12 14:05：我這關沒問題"]);
  });

  it("第一關就駁回（第二關從沒輪到）→ 沒有額外的行；單據不是已駁回卻有已駁回的關（資料異常）→ 照列「已駁回」", () => {
    const first = row({
      status: "rejected",
      current_step: 1,
      total_steps: 2,
      decision_comment: "資料不齊",
      steps: [step({ decision: "rejected", comment: "資料不齊" }), bossStep({ decision: "pending", acted_at: null })],
    });
    expect(approvalComments(first, { tz: TZ })).toEqual([]);
    const odd = row({ status: "pending", steps: [step({ decision: "rejected", comment: "再補一份附件" })] });
    expect(approvalComments(odd, { tz: TZ })).toEqual(["王小明 已駁回 10/12 14:05：再補一份附件"]);
  });

  it("待簽（還沒人簽）→ 沒有意見行；待簽的關就算帶了字串也不列", () => {
    const r = row({
      status: "pending",
      steps: [
        step({ decision: "pending", comment: null, acted_at: null }),
        bossStep({ decision: "pending", comment: "不該出現", acted_at: null }),
      ],
    });
    expect(approvalComments(r, { tz: TZ })).toEqual([]);
  });

  it("單關核准有意見 → 不寫「第 N 關」：「王小明 已核准 10/12 14:05：沒問題」", () => {
    const r = row({ status: "approved", total_steps: 1, steps: [step({ comment: "沒問題" })] });
    expect(approvalComments(r, { tz: TZ })).toEqual(["王小明 已核准 10/12 14:05：沒問題"]);
  });

  it("沒填意見（含只有空白）的核准關不列、不佔行；意見前後空白會修掉", () => {
    const r = row({
      status: "approved",
      steps: [step({ comment: null }), bossStep({ comment: "  OK  " }), step({ step_order: 3, comment: "   " })],
    });
    expect(approvalComments(r, { tz: TZ })).toEqual(["第 2 關・陳老闆 已核准 10/12 15:30：OK"]);
    // 每一關都沒意見 → 空陣列（畫面上不出現這一塊）
    expect(approvalComments(row({ status: "approved", steps: [step(), bossStep()] }), { tz: TZ })).toEqual([]);
  });

  it("steps 缺漏或 null（舊 API）→ 空陣列，不炸", () => {
    expect(approvalComments(row({}))).toEqual([]);
    expect(approvalComments(row({ steps: null }))).toEqual([]);
    expect(approvalComments(row({ steps: undefined }))).toEqual([]);
    expect(approvalComments(row({ steps: [] }))).toEqual([]);
  });

  it("亂序的 steps 依 step_order 排列且不改動傳入的陣列；HR 覆核關加註、姓名退回候選、沒有時間就不印時間", () => {
    const steps = [
      step({ step_order: 2, kind: "hr", approver_name: null, candidate_names: ["李小華", "周小美"], comment: "資料齊全", acted_at: null }),
      step({ step_order: 1, comment: "同意" }),
    ];
    const r = row({ status: "approved", steps });
    expect(approvalComments(r, { tz: TZ })).toEqual([
      "第 1 關・王小明 已核准 10/12 14:05：同意",
      "第 2 關・李小華／周小美（HR 覆核）已核准：資料齊全",
    ]);
    expect(steps.map((s) => s.step_order)).toEqual([2, 1]);
  });

  it("所有申請種類一致：只看 status 與 steps，與 kind 無關", () => {
    const steps = [step({ comment: "先放行" }), bossStep({ decision: "pending", acted_at: null })];
    for (const kind of KIND_ORDER) {
      expect(approvalComments(row({ kind, status: "pending", current_step: 2, total_steps: 2, steps }), { tz: TZ })).toEqual([
        "第 1 關・王小明 已核准 10/12 14:05：先放行",
      ]);
    }
  });
});

describe("approvalWhenText（簽核頁批次結果、勾選框 aria-label 認「哪一張」用的時間）", () => {
  it("整天出差只有日期（單日、多日、跨年），不再是「09/18 00:00」", () => {
    expect(approvalWhenText(tripRow(), { tz: TZ })).toBe("09/18（五）");
    expect(approvalWhenText(tripRow({ end_at: "2026-09-19T15:59:00Z" }), { tz: TZ })).toBe("09/18（五）～ 09/19（六）");
    expect(
      approvalWhenText(tripRow({ start_at: "2026-12-30T16:00:00Z", end_at: "2027-01-02T15:59:00Z" }), { tz: TZ }),
    ).toBe("12/31（四）～ 01/02（六）");
    expect(approvalWhenText(tripRow(), { tz: TZ })).not.toMatch(/00:00/);
  });

  it("在家工作與簽核卡的期間同一份日期文案", () => {
    const wfh = row({ kind: "wfh", hours: 8, start_at: DAY_START, end_at: DAY_END });
    expect(approvalWhenText(wfh, { tz: TZ })).toBe("09/18（五）全天");
    expect(approvalWhenText(wfh, { tz: TZ })).toBe(allDayPeriodText(wfh, TZ));
  });

  it("公出、舊列 trip_type 缺席的出差、其他種類維持起始時刻 MM/DD HH:mm", () => {
    expect(approvalWhenText(outingRow(), { tz: TZ })).toBe("09/18 09:00");
    expect(approvalWhenText(tripRow({ trip_type: null }), { tz: TZ })).toBe("09/18 00:00");
    expect(approvalWhenText(row({ kind: "leave" }), { tz: TZ })).toBe("09/18 09:00");
    expect(approvalWhenText(row({ kind: "ot", start_at: "2026-09-18T10:00:00Z" }), { tz: TZ })).toBe("09/18 18:00");
  });

  it("起始時間無效 → '—'，不炸", () => {
    expect(approvalWhenText(tripRow({ start_at: "not-a-date" }), { tz: TZ })).toBe("—");
    expect(approvalWhenText(row({ start_at: "not-a-date" }), { tz: TZ })).toBe("—");
  });
});

describe("附件太大的錯誤碼：API 的 file_too_large 與舊碼 payload_too_large", () => {
  /** 與 apiFetch 丟出的錯誤同形：message 是「[status] code」，另掛 status／code／body（整包回應）。 */
  const apiError = (status: number, code: string, body?: Record<string, unknown>) =>
    Object.assign(new Error(`[${status}] ${code}`), { status, code, body: body ?? { error: code } });
  const MiB = 1024 * 1024;

  it("回應帶了上限（maxBytes，依租戶設定）→ 照它寫數字，不寫死 3 MB", () => {
    expect(attachmentTooLargeText(apiError(413, "file_too_large", { error: "file_too_large", maxBytes: 1 * MiB }))).toBe(
      "附件太大，單檔限 1 MB",
    );
    expect(attachmentTooLargeText(apiError(413, "file_too_large", { error: "file_too_large", maxBytes: 500 * 1024 }))).toBe(
      "附件太大，單檔限 500 KB",
    );
    expect(attachmentTooLargeText(apiError(413, "file_too_large", { error: "file_too_large", maxBytes: 3 * MiB }))).toBe(
      "附件太大，單檔限 3 MB",
    );
  });

  it("沒帶上限（舊 API、舊碼 payload_too_large）→ 不寫數字的通用說法；兩個碼同一句；不露出「[413] file_too_large」", () => {
    const generic = attachmentTooLargeText(apiError(413, "file_too_large"));
    expect(generic).toBe("附件超過公司設定的大小上限，請縮小後再傳");
    expect(generic).not.toMatch(/\d|file_too_large|\[413\]/);
    expect(attachmentTooLargeText(apiError(413, "payload_too_large"))).toBe(generic);
    expect(attachmentTooLargeText(new Error("[413] file_too_large"))).toBe(generic);
    // 查表（requestErrorText）是同一句保底，不再寫死 3 MB
    expect(requestErrorText(apiError(413, "file_too_large"))).toBe(generic);
    expect(REQUEST_ERROR_MESSAGES.file_too_large).toBe(REQUEST_ERROR_MESSAGES.payload_too_large);
  });

  it("別的錯誤不歸它管（回 null，交給 requestErrorText／friendlyError）", () => {
    expect(attachmentTooLargeText(new Error("[413] something_else"))).toBeNull();
    expect(attachmentTooLargeText(apiError(409, "max_files_reached", { error: "max_files_reached", max: 3 }))).toBeNull();
    expect(attachmentTooLargeText("file_too_large")).toBeNull();
    expect(requestErrorText(new Error("[413] something_else"))).toBeNull();
  });

  it("maxBytes 不合理（0、負數、字串）→ 當作沒帶", () => {
    for (const maxBytes of [0, -1, "1048576", Number.NaN]) {
      expect(attachmentLimitOf(apiError(413, "file_too_large", { error: "file_too_large", maxBytes }))).toBeNull();
    }
    expect(attachmentLimitOf(apiError(413, "file_too_large", { error: "file_too_large", maxBytes: 2048 }))).toBe(2048);
    expect(attachmentLimitOf(null)).toBeNull();
  });

  it("上限的寫法：整數 MB、捨去到 0.1 MB、不滿 1 MB 寫 KB；寫出來的數字不會比實際上限大", () => {
    expect(fmtAttachmentLimit(3 * MiB)).toBe("3 MB");
    expect(fmtAttachmentLimit(1.5 * MiB)).toBe("1.5 MB");
    expect(fmtAttachmentLimit(2000 * 1024)).toBe("1.9 MB"); // 1.95 MB 不寫成 2 MB
    expect(fmtAttachmentLimit(500 * 1024)).toBe("500 KB");
    expect(fmtAttachmentLimit(100)).toBe("1 KB");
  });
});

describe("請假附件上傳失敗的提醒（單已建立）", () => {
  const NET = "連線失敗，請確認網路連線後再試";

  it("全部沒傳上 → 列出檔名、原因寫一次，請到「我的申請」按「上傳憑證」補傳", () => {
    expect(attachmentUploadWarning([{ name: "診斷證明.jpg", reason: NET }], 1)).toBe(
      `申請已送出，但附件「診斷證明.jpg」上傳失敗（${NET}）。請在下方「我的申請」按「上傳憑證」補傳。`,
    );
    expect(
      attachmentUploadWarning(
        [
          { name: "a.jpg", reason: NET },
          { name: "b.pdf", reason: NET },
        ],
        2,
      ),
    ).toBe(`申請已送出，但附件「a.jpg」「b.pdf」上傳失敗（${NET}）。請在下方「我的申請」按「上傳憑證」補傳。`);
  });

  it("只有部分沒傳上 → 說其餘已上傳（列表不會再給「上傳憑證」）；原因不同就各寫各的", () => {
    expect(attachmentUploadWarning([{ name: "b.jpg", reason: NET }], 3)).toBe(
      `申請已送出，但附件「b.jpg」上傳失敗（${NET}）；其餘 2 個已上傳。缺的附件若必要，請撤回這張申請後重新申請。`,
    );
    expect(
      attachmentUploadWarning(
        [
          { name: "a.jpg", reason: NET },
          { name: "b.pdf", reason: "附件太大，單檔限 1 MB" },
        ],
        3,
      ),
    ).toBe(
      `申請已送出，但附件「a.jpg」（${NET}）、「b.pdf」（附件太大，單檔限 1 MB）上傳失敗；其餘 1 個已上傳。缺的附件若必要，請撤回這張申請後重新申請。`,
    );
  });

  it("都傳上了 → null（成功畫面不多一行）", () => {
    expect(attachmentUploadWarning([], 2)).toBeNull();
  });
});
