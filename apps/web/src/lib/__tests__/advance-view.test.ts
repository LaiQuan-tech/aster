import { describe, expect, it } from "vitest";
import {
  EXPENSE_ERROR_MESSAGES,
  NETWORK_FAILURE_MESSAGE,
  RECEIPT_AUTO_CANCEL_REASON,
  advanceDate,
  advanceOptionLabel,
  advanceStatusLabel,
  advanceSubject,
  apiErrorCode,
  bindableAdvances,
  claimStatusLabel,
  describeBalance,
  expenseErrorMessage,
  isNetworkFailure,
  isUnsettledAdvance,
  isValidPeriod,
  receiptUploadFailedMessage,
  settlementWarnings,
  type AdvanceLike,
  type PreviewClaim,
} from "../advance-view";

/**
 * 預支綁定與核銷預覽的顯示用純函式（2026-10-11）。
 *   • ESS 報銷頁「這筆是哪次預支的花費？」：只列自己尚未核銷（requested／paid）的預支，
 *     選項寫出出差或零用金的日期、地點或事由、預支金額、狀態。
 *   • 後台核銷前預覽：差額一句話、漏綁／缺憑證的提醒。
 * ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
 */

const TZ = "Asia/Taipei";

const TRIP: AdvanceLike = {
  id: "adv-trip",
  kind: "trip",
  amount: "3000",
  status: "paid",
  paid_at: "2026-10-09T02:00:00.000Z",
  created_at: "2026-10-08T02:00:00.000Z",
  // 台北 10/10 00:00 出發（UTC 是 10/09 16:00——不能用 UTC 切片當日期）
  request: {
    kind: "business_trip",
    start_at: "2026-10-09T16:00:00.000Z",
    end_at: "2026-10-11T15:59:00.000Z",
    location: "台中客戶公司",
    reason: "客戶拜訪",
    trip_type: "business_trip",
    trip_scope: "domestic_intercity",
  },
};

const PETTY: AdvanceLike = {
  id: "adv-petty",
  kind: "petty_cash",
  amount: 1500.5,
  status: "requested",
  created_at: "2026-10-05T02:00:00.000Z",
  request: {
    kind: "petty_cash",
    start_at: "2026-10-05T02:00:00.000Z",
    end_at: "2026-10-05T02:00:00.000Z",
    location: null,
    reason: "採買活動物資",
    trip_type: null,
    trip_scope: null,
  },
};

describe("可綁的預支（尚未核銷）", () => {
  it("requested／paid 才可綁；settled、cancelled 不可", () => {
    expect(isUnsettledAdvance({ status: "requested" })).toBe(true);
    expect(isUnsettledAdvance({ status: "paid" })).toBe(true);
    expect(isUnsettledAdvance({ status: "settled" })).toBe(false);
    expect(isUnsettledAdvance({ status: "cancelled" })).toBe(false);
  });

  it("bindableAdvances：濾掉已核銷／已取消，新的在前（依申請單起日）", () => {
    const settled: AdvanceLike = { ...TRIP, id: "adv-settled", status: "settled" };
    const older: AdvanceLike = { ...TRIP, id: "adv-older", request: { ...TRIP.request!, start_at: "2026-09-01T00:00:00.000Z" } };
    const list = bindableAdvances([older, settled, PETTY, TRIP]);
    expect(list.map((a) => a.id)).toEqual(["adv-trip", "adv-petty", "adv-older"]);
  });

  it("沒有預支 → 空陣列（畫面不顯示這個欄位）", () => {
    expect(bindableAdvances([])).toEqual([]);
  });
});

describe("預支的選項文字", () => {
  it("出差：「10/10 出差・台中客戶公司｜預支 NT$ 3,000（已撥款）」；日期依時區換算，不是 UTC 切片", () => {
    expect(advanceDate(TRIP, TZ)).toBe("10/10");
    expect(advanceSubject(TRIP)).toBe("出差・台中客戶公司");
    expect(advanceOptionLabel(TRIP, TZ)).toBe("10/10 出差・台中客戶公司｜預支 NT$ 3,000（已撥款）");
  });

  it("零用金：用事由；尚未撥款標明「尚未撥款」；金額有小數照顯示", () => {
    expect(advanceOptionLabel(PETTY, TZ)).toBe("10/05 零用金・採買活動物資｜預支 NT$ 1,500.5（尚未撥款）");
  });

  it("公出（outing）寫「公出」；沒有地點就用事由；都沒有就只寫種類；過長的事由截斷", () => {
    const outing: AdvanceLike = { ...TRIP, request: { ...TRIP.request!, trip_type: "outing", location: "市政府" } };
    expect(advanceSubject(outing)).toBe("公出・市政府");
    const noPlace: AdvanceLike = { ...TRIP, request: { ...TRIP.request!, location: null, reason: "客戶拜訪" } };
    expect(advanceSubject(noPlace)).toBe("出差・客戶拜訪");
    const nothing: AdvanceLike = { ...TRIP, request: { ...TRIP.request!, location: null, reason: null } };
    expect(advanceSubject(nothing)).toBe("出差");
    const longReason: AdvanceLike = { ...PETTY, request: { ...PETTY.request!, reason: "採買活動物資與年度尾牙佈置所需的全部耗材" } };
    expect(advanceSubject(longReason)).toBe("零用金・採買活動物資與年度尾牙佈置所…"); // 取前 14 字
  });

  it("沒有申請單摘要（舊 API／查不到）：日期退回撥款日、建立日；主旨只寫種類", () => {
    const bare: AdvanceLike = { id: "x", kind: "trip", amount: 100, status: "paid", paid_at: "2026-10-09T02:00:00.000Z" };
    expect(advanceDate(bare, TZ)).toBe("10/09");
    expect(advanceSubject(bare)).toBe("出差");
    expect(advanceSubject({ ...bare, kind: "petty_cash" })).toBe("零用金");
    expect(advanceDate({ id: "y", kind: "trip", amount: 1, status: "paid" }, TZ)).toBe("—");
  });

  it("狀態文案", () => {
    expect(advanceStatusLabel("requested")).toBe("已核准，尚未撥款");
    expect(advanceStatusLabel("paid")).toBe("已撥款，待核銷");
    expect(advanceStatusLabel("settled")).toBe("已核銷");
    expect(advanceStatusLabel("cancelled")).toBe("已取消");
    expect(advanceStatusLabel("weird")).toBe("weird");
  });
});

describe("報銷頁的錯誤訊息", () => {
  const apiError = (status: number, code: string) => Object.assign(new Error(`[${status}] ${code}`), { status, code });

  it("invalid_advance／invalid_trip_request 等已知錯誤碼 → 中文說明（從 .code 或 `[status] code` 取）", () => {
    expect(expenseErrorMessage(apiError(400, "invalid_advance"), "x")).toBe(EXPENSE_ERROR_MESSAGES.invalid_advance);
    expect(expenseErrorMessage(new Error("[400] invalid_trip_request"), "x")).toBe(EXPENSE_ERROR_MESSAGES.invalid_trip_request);
    expect(EXPENSE_ERROR_MESSAGES.invalid_advance).toContain("預支");
    expect(apiErrorCode(new Error("[409] period_settled"))).toBe("period_settled");
    expect(apiErrorCode("boom")).toBeNull();
  });

  it("預支核銷後綁定憑證鎖定（409 advance_settled）、月份已鎖定（period_settled）也有中文說明", () => {
    expect(expenseErrorMessage(apiError(409, "advance_settled"), "x")).toBe(EXPENSE_ERROR_MESSAGES.advance_settled);
    expect(EXPENSE_ERROR_MESSAGES.advance_settled).toContain("預支核銷");
    expect(expenseErrorMessage(apiError(409, "period_settled"), "x")).toBe(EXPENSE_ERROR_MESSAGES.period_settled);
  });

  it("不認得的錯誤碼 → 原訊息；不是 Error → fallback", () => {
    expect(expenseErrorMessage(new Error("[500] kaboom"), "送出失敗")).toBe("[500] kaboom");
    expect(expenseErrorMessage("boom", "送出失敗")).toBe("送出失敗");
  });

  it("憑證太大（413 file_too_large）→ 中文，講 3 MB（API 收 5 MB，但經 Vercel 實際只傳得動約 3 MB）", () => {
    expect(expenseErrorMessage(apiError(413, "file_too_large"), "x")).toBe(EXPENSE_ERROR_MESSAGES.file_too_large);
    expect(EXPENSE_ERROR_MESSAGES.file_too_large).toContain("3 MB");
  });

  it("連線本身失敗（Chrome／Safari／Firefox 三種說法）→「可能是檔案太大或網路不穩」；一般錯誤不算", () => {
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(isNetworkFailure(new TypeError(message))).toBe(true);
      expect(expenseErrorMessage(new TypeError(message), "送出失敗")).toBe(NETWORK_FAILURE_MESSAGE);
    }
    expect(NETWORK_FAILURE_MESSAGE).toContain("檔案太大");
    expect(NETWORK_FAILURE_MESSAGE).toContain("網路不穩");
    expect(isNetworkFailure(new Error("[500] kaboom"))).toBe(false);
    expect(isNetworkFailure("Failed to fetch")).toBe(false);
  });

  it("前端準備階段的中文錯誤（沒有錯誤碼）原樣顯示", () => {
    expect(expenseErrorMessage(new Error("檔案超過 3 MB，請縮小或改傳照片／截圖"), "送出失敗")).toBe(
      "檔案超過 3 MB，請縮小或改傳照片／截圖",
    );
  });

  it("憑證上傳失敗（單已建好）：自動撤回成功 → 請重新送出；撤回也失敗 → 請在列表撤回後重送；括號附原因", () => {
    const err = new TypeError("Failed to fetch");
    expect(receiptUploadFailedMessage(err, true)).toBe(
      `憑證上傳失敗，這筆報銷已自動撤回，請重新送出。（${NETWORK_FAILURE_MESSAGE}）`,
    );
    expect(receiptUploadFailedMessage(apiError(413, "file_too_large"), false)).toBe(
      `憑證上傳失敗，請在下方列表撤回這筆後再重新送出。（${EXPENSE_ERROR_MESSAGES.file_too_large}）`,
    );
    expect(receiptUploadFailedMessage("boom", true)).toContain("（上傳失敗）");
    // 寫進 status_reason：API 要求 1–250 字。
    expect(RECEIPT_AUTO_CANCEL_REASON.length).toBeGreaterThan(0);
    expect(RECEIPT_AUTO_CANCEL_REASON.length).toBeLessThanOrEqual(250);
  });
});

describe("核銷前預覽", () => {
  it("差額一句話：正＝公司補給員工、負＝員工應退、0＝剛好結清；金額寫法可換", () => {
    expect(describeBalance(500)).toEqual({ text: "公司補給員工 NT$ 500", tone: "green" });
    expect(describeBalance(-1000)).toEqual({ text: "員工應退 NT$ 1,000", tone: "amber" });
    expect(describeBalance(0)).toEqual({ text: "剛好結清", tone: "gray" });
    expect(describeBalance(-1000, (n) => `${n} 元`).text).toBe("員工應退 1000 元");
  });

  const claim = (over: Partial<PreviewClaim>): PreviewClaim => ({
    id: "c",
    amount: 100,
    incurredOn: "2026-10-10",
    period: "2026-10",
    status: "submitted",
    counted: true,
    categoryId: null,
    categoryName: null,
    nature: "reimbursement",
    note: null,
    tripRequestId: null,
    receiptCount: 1,
    ...over,
  });

  it("沒有任何憑證 → 提醒「整筆算員工應退」（最常見的漏綁）", () => {
    const warnings = settlementWarnings({ claims: [], countedCount: 0, amount: 3000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("沒有綁定任何憑證");
    expect(warnings[0]).toContain("NT$ 3,000");
    expect(warnings[0]).toContain("員工應退");
  });

  it("計入的憑證缺單據、另有已撤回／退件不計入 → 各一行提醒；全都正常 → 空陣列", () => {
    const warnings = settlementWarnings({
      claims: [
        claim({ id: "a" }),
        claim({ id: "b", receiptCount: 0 }),
        claim({ id: "c", status: "cancelled", counted: false, receiptCount: 0 }), // 不計入的缺單據不提醒
        claim({ id: "d", status: "rejected", counted: false }),
      ],
      countedCount: 2,
      amount: 3000,
    });
    expect(warnings).toEqual(["有 1 筆憑證沒有附單據檔案。", "另有 2 筆已撤回或退件的單，不計入實支。"]);
    expect(settlementWarnings({ claims: [claim({ id: "a" })], countedCount: 1, amount: 3000 })).toEqual([]);
  });

  it("憑證狀態文案：計入實支的都寫「已送出」（綁預支的憑證不走月結付款，不寫待月結／已月結）", () => {
    expect(claimStatusLabel("submitted")).toBe("已送出");
    expect(claimStatusLabel("settled")).toBe("已送出");
    expect(claimStatusLabel("cancelled")).toBe("已撤回");
    expect(claimStatusLabel("rejected")).toBe("已退件");
    expect(claimStatusLabel("other")).toBe("other");
  });

  it("薪資期別格式 YYYY-MM（月份 01–12）", () => {
    expect(isValidPeriod("2026-10")).toBe(true);
    expect(isValidPeriod(" 2026-01 ")).toBe(true);
    expect(isValidPeriod("2026-13")).toBe(false);
    expect(isValidPeriod("2026-00")).toBe(false);
    expect(isValidPeriod("2026-1")).toBe(false);
    expect(isValidPeriod("")).toBe(false);
  });
});
