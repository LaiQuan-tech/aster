import { describe, expect, it } from "vitest";
import type { CreateRequestBody, LeaveRequest } from "../ess-api";
import {
  BOSS_APPROVAL_HINT,
  EXPENSE_METHOD_FIELD_LABEL,
  PETTY_EXPENSE_METHOD_LABEL,
  REASON_MAX,
  TRIP_EXPENSE_METHOD_LABEL,
  advanceFieldValue,
  approvalChainSummary,
  approvalStepName,
  buildCreateBody,
  describeBody,
  describeRequest,
  isBuildError,
  type PettyCashFormValues,
  type TripFormValues,
} from "../request-forms";

/**
 * 費用方式二選一（2026-10-11，出差／公出／零用金共用）：
 *   ○ 先預支（出發前撥款，回來核銷）　○ 自行墊付，回來報銷
 * 先預支才送 advanceRequested（金額預設帶預估花費、可改）；自行墊付不送（後端核准時不開預支）。
 * 零用金的自行墊付：金額改記 estimatedCost（簽核者要核的金額）、remark 註明費用方式。
 * （既有的出差／零用金 body 測試仍在 request-forms.test.ts，這裡只加費用方式的部分。）
 */

function ok(result: ReturnType<typeof buildCreateBody>): CreateRequestBody {
  if (isBuildError(result)) throw new Error(`預期成功卻得到 error：${result.error}`);
  return result;
}

const NOW = new Date("2026-10-11T03:00:00.000Z");

const TRIP: TripFormValues = {
  tripType: "business_trip",
  date: "",
  startTime: "",
  endTime: "",
  startDate: "2026-10-14",
  endDate: "2026-10-15",
  tripScope: "domestic_intercity",
  location: "台中客戶公司",
  estimatedCost: "5000",
  advanceWanted: false,
  advanceRequested: "",
  reason: "客戶拜訪",
};

describe("費用方式的畫面文字", () => {
  it("欄位名與兩個選項的文字（出差／公出）", () => {
    expect(EXPENSE_METHOD_FIELD_LABEL).toBe("費用方式");
    expect(TRIP_EXPENSE_METHOD_LABEL).toEqual({
      advance: "先預支（出發前撥款，回來核銷）",
      self_paid: "自行墊付，回來報銷",
    });
  });

  it("零用金的選項文字（沒有「出發」，同樣的精神）", () => {
    expect(PETTY_EXPENSE_METHOD_LABEL).toEqual({
      advance: "先預支（核准後撥款，用完憑單據核銷）",
      self_paid: "自行墊付，之後憑單據報銷",
    });
  });

  it("簽核提示：出差、公出與零用金都送主管與老闆", () => {
    expect(BOSS_APPROVAL_HINT).toBe("出差、公出都會送主管與老闆簽核");
  });
});

describe("出差／公出：費用方式 → advanceRequested", () => {
  it("自行墊付（advanceWanted=false）：不送 advanceRequested（即使預支欄還留著字），預估花費照送", () => {
    const body = ok(buildCreateBody("business_trip", { ...TRIP, advanceWanted: false, advanceRequested: "999" }));
    expect(body).not.toHaveProperty("advanceRequested");
    expect(body.estimatedCost).toBe(5000);
    expect(body.tripScope).toBe("domestic_intercity");
  });

  it("先預支（advanceWanted=true）：送 advanceRequested；金額必填且需大於 0", () => {
    expect(ok(buildCreateBody("business_trip", { ...TRIP, advanceWanted: true, advanceRequested: "5,000" })).advanceRequested).toBe(5000);
    expect(buildCreateBody("business_trip", { ...TRIP, advanceWanted: true, advanceRequested: "" })).toEqual({ error: "請填寫預支金額" });
    expect(buildCreateBody("business_trip", { ...TRIP, advanceWanted: true, advanceRequested: "0" })).toEqual({ error: "請填寫預支金額" });
  });

  it("公出（outing）也一樣：自行墊付不送、先預支才送", () => {
    const outing: TripFormValues = { ...TRIP, tripType: "outing", date: "2026-10-14", startTime: "09:00", endTime: "12:00", tripScope: "local" };
    expect(ok(buildCreateBody("business_trip", { ...outing, advanceWanted: false }))).not.toHaveProperty("advanceRequested");
    expect(ok(buildCreateBody("business_trip", { ...outing, advanceWanted: true, advanceRequested: "300" })).advanceRequested).toBe(300);
  });
});

describe("advanceFieldValue — 預支金額預設帶預估花費、可改", () => {
  it("沒動過 → 顯示預估花費（預估花費改了，預支金額跟著走）", () => {
    expect(advanceFieldValue(false, "", "5000")).toBe("5000");
    expect(advanceFieldValue(false, "", "6000")).toBe("6000");
    expect(advanceFieldValue(false, "", "")).toBe("");
  });

  it("員工改過（含清空）→ 就是員工填的，不再跟著預估花費", () => {
    expect(advanceFieldValue(true, "3000", "5000")).toBe("3000");
    expect(advanceFieldValue(true, "", "5000")).toBe("");
  });

  it("接上 buildCreateBody：預設帶預估花費送出；改過就送員工填的", () => {
    const withDefault = ok(
      buildCreateBody("business_trip", { ...TRIP, advanceWanted: true, advanceRequested: advanceFieldValue(false, "", TRIP.estimatedCost as string) }),
    );
    expect(withDefault.advanceRequested).toBe(5000);
    const edited = ok(
      buildCreateBody("business_trip", { ...TRIP, advanceWanted: true, advanceRequested: advanceFieldValue(true, "3000", TRIP.estimatedCost as string) }),
    );
    expect(edited.advanceRequested).toBe(3000);
  });
});

describe("零用金：費用方式 → body", () => {
  const PETTY: PettyCashFormValues = { amount: "3,000", reason: "採買活動物資" };

  it("沒帶 method（舊行為）或 method=advance：預支金額送 advanceRequested，不帶 estimatedCost／remark", () => {
    for (const form of [PETTY, { ...PETTY, method: "advance" as const }]) {
      const body = ok(buildCreateBody("petty_cash", form, { now: NOW }));
      expect(body).toMatchObject({ kind: "petty_cash", advanceRequested: 3000, reason: "採買活動物資" });
      expect(body).not.toHaveProperty("estimatedCost");
      expect(body).not.toHaveProperty("remark");
      expect(body.startAt).toBe(NOW.toISOString());
      expect(body.endAt).toBe(NOW.toISOString());
    }
  });

  it("method=self_paid：不送 advanceRequested（不預支）；金額記 estimatedCost，remark 註明費用方式給簽核者看", () => {
    const body = ok(buildCreateBody("petty_cash", { ...PETTY, method: "self_paid" }, { now: NOW }));
    expect(body).not.toHaveProperty("advanceRequested");
    expect(body).toMatchObject({
      kind: "petty_cash",
      reason: "採買活動物資",
      estimatedCost: 3000,
      remark: "費用方式：自行墊付，回來報銷（預估 NT$ 3,000）",
    });
  });

  it("自行墊付的金額必填、用途必填：錯誤文字依方式不同（預估金額／預支金額）", () => {
    expect(buildCreateBody("petty_cash", { amount: "", reason: "x", method: "self_paid" })).toEqual({ error: "請填寫預估金額" });
    expect(buildCreateBody("petty_cash", { amount: "0", reason: "x", method: "self_paid" })).toEqual({ error: "請填寫預估金額" });
    expect(buildCreateBody("petty_cash", { amount: "", reason: "x", method: "advance" })).toEqual({ error: "請填寫預支金額" });
    expect(buildCreateBody("petty_cash", { amount: "500", reason: " ", method: "self_paid" })).toEqual({ error: "請填寫用途" });
    expect(buildCreateBody("petty_cash", { amount: "500", reason: "x".repeat(REASON_MAX + 1), method: "self_paid" })).toEqual({
      error: `事由請在 ${REASON_MAX} 字以內`,
    });
  });
});

describe("零用金清單／成功畫面的金額文案（自行墊付顯示預估金額）", () => {
  const row = (over: Partial<LeaveRequest>): LeaveRequest =>
    ({
      id: "r1",
      tenant_id: "t1",
      employee_id: "e1",
      kind: "petty_cash",
      leave_type_id: null,
      start_at: "2026-10-11T03:00:00.000Z",
      end_at: "2026-10-11T03:00:00.000Z",
      hours: null,
      reason: "採買活動物資",
      status: "pending",
      current_step: 1,
      created_at: "2026-10-11T03:00:00.000Z",
      ...over,
    }) as LeaveRequest;

  it("先預支：「NT$ 3,000」（與以前相同）；自行墊付：「自行墊付 · 預估 NT$ 3,000」；兩者都沒有 → —", () => {
    expect(describeRequest(row({ advance_requested: "3000" }))).toBe("NT$ 3,000");
    expect(describeRequest(row({ advance_requested: null, estimated_cost: "3000" }))).toBe("自行墊付 · 預估 NT$ 3,000");
    expect(describeRequest(row({ advance_requested: 0, estimated_cost: 1500.5 }))).toBe("自行墊付 · 預估 NT$ 1,500.5");
    expect(describeRequest(row({}))).toBe("—");
  });

  it("describeBody：先預支 → 「NT$ 3,000」；自行墊付 → 「自行墊付 · 預估 NT$ 3,000」", () => {
    const advance = ok(buildCreateBody("petty_cash", { amount: "3000", reason: "x" }, { now: NOW }));
    expect(describeBody(advance)).toBe("NT$ 3,000");
    const selfPaid = ok(buildCreateBody("petty_cash", { amount: "3000", reason: "x", method: "self_paid" }, { now: NOW }));
    expect(describeBody(selfPaid)).toBe("自行墊付 · 預估 NT$ 3,000");
  });
});

describe("送出成功畫面的簽核關卡（零用金與出差／公出一律主管 → 老闆，兩關）", () => {
  it("兩關：「簽核關卡：主管老王 → 老闆大頭（共 2 關）」；同一關多位候選用「／」串", () => {
    expect(
      approvalChainSummary([
        { candidateNames: ["主管老王"], approverName: "主管老王" },
        { candidateNames: ["老闆大頭"], approverName: "老闆大頭" },
      ]),
    ).toBe("簽核關卡：主管老王 → 老闆大頭（共 2 關）");
    expect(approvalChainSummary([{ candidateNames: ["甲", "乙"] }, { approverName: "老闆大頭" }])).toBe("簽核關卡：甲／乙 → 老闆大頭（共 2 關）");
  });

  it("三關（兩層主管＋老闆）依序列出", () => {
    expect(approvalChainSummary([{ approverName: "小主管" }, { approverName: "大主管" }, { approverName: "老闆" }])).toBe(
      "簽核關卡：小主管 → 大主管 → 老闆（共 3 關）",
    );
  });

  it("沒有部門主管只剩老闆一關、請假／加班／補卡也是單關 → 空字串（成功畫面維持原樣）；沒有姓名只寫關數", () => {
    expect(approvalChainSummary([])).toBe("");
    expect(approvalChainSummary([{ approverName: "老闆大頭" }])).toBe("");
    expect(approvalChainSummary([{ approverName: null }, { candidateNames: [] }])).toBe("簽核關卡：共 2 關");
  });

  it("approvalStepName：候選姓名優先，沒有就退回 approverName，都沒有 → 空字串", () => {
    expect(approvalStepName({ candidateNames: [" 甲 ", "", "乙"], approverName: "丙" })).toBe("甲／乙");
    expect(approvalStepName({ approverName: " 丙 " })).toBe("丙");
    expect(approvalStepName({})).toBe("");
  });
});
