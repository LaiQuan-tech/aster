import { describe, expect, it } from "vitest";
import {
  ALERT_KIND_LABEL,
  BOOKING_STATUS_LABEL,
  COST_TYPE_LABEL,
  VEHICLE_ERROR_TEXT,
  VEHICLE_STATUS_LABEL,
  alertText,
  alertTone,
  bookingActions,
  bookingMaxInput,
  bookingRangeError,
  canShowClaimButton,
  checkoutOdometerError,
  claimResultSummary,
  claimableCosts,
  conflictSlotsOf,
  distanceOf,
  localInputToIso,
  overlaps,
  photoPickError,
  validateReturn,
  vehicleErrorCode,
  vehicleErrorMessage,
} from "../vehicle-view";
import type { BusySlot, TripCost, VehicleBooking } from "../vehicles-api";

/** 模擬 apiFetch 丟出的 ApiError。 */
function apiErr(status: number, code: string, extra: Record<string, unknown> = {}) {
  const err = new Error(`[${status}] ${code}`) as Error & { status: number; code: string; body: unknown };
  err.status = status;
  err.code = code;
  err.body = { error: code, ...extra };
  return err;
}

const slot = (id: string, vehicleId: string, startAt: string, endAt: string, extra: Partial<BusySlot> = {}): BusySlot => ({
  bookingId: id,
  vehicleId,
  startAt,
  endAt,
  status: "approved",
  employeeName: "測試員工",
  mine: false,
  ...extra,
});

describe("標籤", () => {
  it("狀態／費用類型／提醒種類都有中文", () => {
    expect(VEHICLE_STATUS_LABEL).toEqual({ available: "可預約", maintenance: "維修中", retired: "已停用" });
    for (const k of ["pending", "approved", "rejected", "cancelled", "completed"] as const) expect(BOOKING_STATUS_LABEL[k]).toBeTruthy();
    expect(COST_TYPE_LABEL).toEqual({ fuel: "油資", toll: "過路費", parking: "停車費", other: "其他" });
    for (const k of ["maintenance_date", "maintenance_odometer", "insurance", "license_tax", "overdue_return"] as const)
      expect(ALERT_KIND_LABEL[k]).toBeTruthy();
  });

  it("alertTone：過期紅、將到期黃；alertText：API label 優先，否則種類＋日期／里程", () => {
    expect(alertTone({ overdue: true })).toBe("red");
    expect(alertTone({ overdue: false })).toBe("amber");
    expect(alertText({ kind: "insurance", dueOn: "2026-12-01", dueOdometer: null, overdue: false, label: "保險 12/01 到期" })).toBe("保險 12/01 到期");
    expect(alertText({ kind: "insurance", dueOn: "2026-12-01", dueOdometer: null, overdue: false, label: "" })).toBe("保險到期 2026-12-01");
    expect(alertText({ kind: "maintenance_odometer", dueOn: null, dueOdometer: 15000, overdue: true, label: "" })).toBe("保養里程 15,000 km");
  });
});

describe("distanceOf／validateReturn／checkoutOdometerError", () => {
  it("distanceOf：還車 − 出車；缺值 null；負數照實回；接受逗號字串", () => {
    expect(distanceOf(1000, 1250)).toBe(250);
    expect(distanceOf(1000, "1,250")).toBe(250);
    expect(distanceOf(1000, "")).toBeNull();
    expect(distanceOf(null, 1)).toBeNull();
    expect(distanceOf(1000, "abc")).toBeNull();
    expect(distanceOf(1000, 900)).toBe(-100);
  });

  it("validateReturn：end < start 擋；相等可；空白、非整數擋；issue 無說明擋", () => {
    const base = { startOdometer: 1000, conditionStatus: "ok" as const };
    expect(validateReturn({ ...base, endOdometer: 999 })).toMatchObject({ ok: false, field: "endOdometer" });
    expect(validateReturn({ ...base, endOdometer: 999 })).toMatchObject({ message: expect.stringContaining("1,000") });
    expect(validateReturn({ ...base, endOdometer: 1000 })).toEqual({ ok: true });
    expect(validateReturn({ ...base, endOdometer: "1,200" })).toEqual({ ok: true });
    expect(validateReturn({ ...base, endOdometer: "" })).toMatchObject({ ok: false, field: "endOdometer" });
    expect(validateReturn({ ...base, endOdometer: "12.5" })).toMatchObject({ ok: false, field: "endOdometer" });
    expect(validateReturn({ ...base, endOdometer: 1100, conditionStatus: "issue", conditionNote: "  " })).toMatchObject({
      ok: false,
      field: "conditionNote",
    });
    expect(validateReturn({ ...base, endOdometer: 1100, conditionStatus: "issue", conditionNote: "左後照鏡刮傷" })).toEqual({ ok: true });
  });

  it("checkoutOdometerError：低於目前里程要理由；有理由放行", () => {
    expect(checkoutOdometerError({ startOdometer: "", currentOdometer: 100 })).toBe("請填出車里程");
    expect(checkoutOdometerError({ startOdometer: "-1", currentOdometer: 100 })).toBe("出車里程請填整數公里");
    expect(checkoutOdometerError({ startOdometer: 90, currentOdometer: 100 })).toContain("請填寫原因");
    expect(checkoutOdometerError({ startOdometer: 90, currentOdometer: 100, overrideReason: "上次登錄錯誤" })).toBeNull();
    expect(checkoutOdometerError({ startOdometer: 100, currentOdometer: 100 })).toBeNull();
  });
});

describe("overlaps（半開區間）／bookingRangeError", () => {
  const slots = [
    slot("a", "v1", "2026-11-05T01:00:00Z", "2026-11-05T03:00:00Z"),
    slot("b", "v2", "2026-11-05T02:00:00Z", "2026-11-05T05:00:00Z"),
  ];
  it("相接不算重疊；包含／部分重疊算", () => {
    expect(overlaps(slots, "2026-11-05T03:00:00Z", "2026-11-05T04:00:00Z", { vehicleId: "v1" })).toEqual([]);
    expect(overlaps(slots, "2026-11-05T00:00:00Z", "2026-11-05T01:00:00Z", { vehicleId: "v1" })).toEqual([]);
    expect(overlaps(slots, "2026-11-05T02:59:00Z", "2026-11-05T04:00:00Z", { vehicleId: "v1" }).map((s) => s.bookingId)).toEqual(["a"]);
    expect(overlaps(slots, "2026-11-05T00:00:00Z", "2026-11-05T06:00:00Z").map((s) => s.bookingId)).toEqual(["a", "b"]);
    expect(overlaps(slots, "2026-11-05T01:30:00Z", "2026-11-05T02:30:00Z", { vehicleId: "v1" }).map((s) => s.bookingId)).toEqual(["a"]);
  });
  it("排除自己、無效或倒置區間 → []", () => {
    expect(overlaps(slots, "2026-11-05T01:30:00Z", "2026-11-05T02:30:00Z", { vehicleId: "v1", excludeBookingId: "a" })).toEqual([]);
    expect(overlaps(slots, "bad", "2026-11-05T02:30:00Z")).toEqual([]);
    expect(overlaps(slots, "2026-11-05T03:00:00Z", "2026-11-05T01:00:00Z")).toEqual([]);
  });
  it("bookingRangeError：缺、倒置、超過上限", () => {
    expect(bookingRangeError("", "x")).toBe("請選擇開始與結束時間");
    expect(bookingRangeError("2026-11-05T03:00:00Z", "2026-11-05T03:00:00Z")).toBe("結束時間要晚於開始時間");
    expect(bookingRangeError("2026-11-05T00:00:00Z", "2026-11-05T09:00:00Z", 8)).toBe("單次預約最長 8 小時");
    expect(bookingRangeError("2026-11-05T00:00:00Z", "2026-11-05T08:00:00Z", 8)).toBeNull();
    expect(bookingRangeError("2026-11-05T00:00:00Z", "2026-11-06T08:00:00Z", null, { now: new Date("2026-11-05T00:00:00Z") })).toBeNull();
  });
  it("bookingRangeError：以「現在＋N×24h」為界（與 API 一致），可調", () => {
    const now = new Date("2026-11-05T02:00:00Z");
    const limit = now.getTime() + 90 * 86_400_000;
    const iso = (t: number) => new Date(t).toISOString();
    expect(bookingRangeError(iso(limit), iso(limit + 3_600_000), null, { now })).toBeNull();
    // 同一天稍晚（舊版算到 23:59 會放行）→ 擋
    expect(bookingRangeError(iso(limit + 60_000), iso(limit + 3_600_000), null, { now })).toBe("最多只能預約 90 天內的時段");
    expect(bookingRangeError(iso(limit + 60_000), iso(limit + 3_600_000), null, { now, maxDaysAhead: 120 })).toBeNull();
  });
});

describe("bookingActions（各狀態 × 時間）", () => {
  const now = Date.parse("2026-11-05T02:00:00Z");
  const b = (over: Partial<VehicleBooking>) =>
    ({ status: "approved", tripId: null, canCheckout: false, canCancel: false, endAt: "2026-11-05T05:00:00Z", ...over }) as VehicleBooking;
  it("pending：只能取消", () => {
    expect(bookingActions(b({ status: "pending", canCancel: true }), now)).toEqual({ checkout: false, cancel: true, openTrip: false, waiting: false });
  });
  it("approved 且到時間：取車＋取消", () => {
    expect(bookingActions(b({ canCheckout: true, canCancel: true }), now)).toEqual({ checkout: true, cancel: true, openTrip: false, waiting: false });
  });
  it("approved 但還沒到可取車時間：waiting", () => {
    expect(bookingActions(b({ canCancel: true }), now)).toMatchObject({ checkout: false, waiting: true });
  });
  it("approved 已過結束時間未取車：不 waiting", () => {
    expect(bookingActions(b({ endAt: "2026-11-05T01:00:00Z" }), now)).toMatchObject({ waiting: false, checkout: false });
  });
  it("已取車：只給用車紀錄（就算伺服器誤給 canCheckout 也不再顯示取車）", () => {
    expect(bookingActions(b({ tripId: "t1", canCheckout: true }), now)).toEqual({ checkout: false, cancel: false, openTrip: true, waiting: false });
  });
  it("completed／rejected／cancelled：沒有取車與等待", () => {
    for (const status of ["completed", "rejected", "cancelled"] as const) {
      expect(bookingActions(b({ status }), now)).toMatchObject({ checkout: false, cancel: false, waiting: false });
    }
  });
});

describe("轉報銷按鈕（只有用車人本人）", () => {
  const cost = (over: Partial<TripCost>): TripCost => ({
    id: "c",
    costType: "fuel",
    amount: 500,
    paidBy: "employee",
    incurredOn: "2026-11-05",
    note: null,
    claimState: "none",
    expenseClaimId: null,
    expenseClaimStatus: null,
    ...over,
  });
  const trip = {
    employeeId: "e1",
    returnedAt: "2026-11-05T05:00:00Z",
    canClaim: true,
    costs: [cost({ id: "a" }), cost({ id: "b", paidBy: "company" }), cost({ id: "c", claimState: "claimed" })],
  };
  it("claimableCosts：員工代墊且未請款", () => {
    expect(claimableCosts(trip.costs).map((c) => c.id)).toEqual(["a"]);
  });
  it("本人、已還車、canClaim、有可轉的行才顯示；HR／他人不顯示", () => {
    expect(canShowClaimButton(trip, "e1")).toBe(true);
    expect(canShowClaimButton(trip, "hr-1")).toBe(false);
    expect(canShowClaimButton(trip, null)).toBe(false);
    expect(canShowClaimButton({ ...trip, returnedAt: null }, "e1")).toBe(false);
    expect(canShowClaimButton({ ...trip, canClaim: false }, "e1")).toBe(false);
    expect(canShowClaimButton({ ...trip, costs: [cost({ claimState: "claimed" })] }, "e1")).toBe(false);
  });
  it("claimResultSummary：全成功／部分失敗／空", () => {
    expect(claimResultSummary([{ ok: true }, { ok: true }])).toBe("2 筆已轉報銷");
    expect(claimResultSummary([{ ok: true }, { ok: false, error: "period_settled" }])).toBe("1 筆已轉報銷、1 筆失敗：該月份報銷已月結，不能再送出");
    expect(claimResultSummary([])).toBe("沒有可轉報銷的費用");
  });
});

describe("vehicleErrorMessage：§3.2 全部錯誤碼都有中文", () => {
  const ALL_CODES = [
    "module_disabled",
    "migration_required",
    "invalid_body",
    "invalid_query",
    "not_an_employee",
    "forbidden",
    "not_found",
    "plate_exists",
    "odometer_decrease",
    "range_too_long",
    "vehicle_required",
    "purpose_required",
    "invalid_vehicle",
    "booking_too_long",
    "booking_in_past",
    "vehicle_unavailable",
    "vehicle_booking_conflict",
    "no_approver_available",
    "period_closed",
    "already_checked_out",
    "not_cancellable",
    "reason_required",
    "booking_not_approved",
    "checkout_too_early",
    "booking_expired",
    "vehicle_in_use",
    "odometer_below_current",
    "odometer_less_than_start",
    "condition_note_required",
    "already_returned",
    "cost_already_claimed",
    "unsupported_file_type",
    "file_too_large",
    "too_many_photos",
    "trip_not_returned",
    "vehicle_settings_incomplete",
    "invalid_category",
    "trip_request_required",
    "period_settled",
    "not_trip_owner",
    "category_requires_trip",
    "invalid_employee",
    // veh-api 實作新增（2026-11-05）
    "invalid_range",
    "invalid_base64",
    "already_claimed",
    "not_claimable",
    "claim_failed",
    "distance_too_large",
    "booking_too_far",
    "odometer_jump_too_large",
    "amount_too_large",
    "invalid_photo",
    "odometer_out_of_sequence",
  ];
  it("每個碼都有對照，且訊息含中文、不是碼本身", () => {
    for (const code of ALL_CODES) {
      expect(VEHICLE_ERROR_TEXT[code], code).toBeTruthy();
      const msg = vehicleErrorMessage(apiErr(400, code));
      expect(msg, code).toMatch(/[一-鿿]/);
      expect(msg, code).not.toContain(code);
    }
  });
  it("409 時段衝突：帶出預約者與時段；403 module_disabled；里程錯誤帶數字", () => {
    const conflict = apiErr(409, "vehicle_booking_conflict", {
      conflicts: [slot("x", "v1", "2026-11-05T01:00:00Z", "2026-11-05T03:00:00Z", { employeeName: "王測試" })],
    });
    expect(vehicleErrorMessage(conflict)).toContain("王測試");
    expect(conflictSlotsOf(conflict).map((s) => s.bookingId)).toEqual(["x"]);
    expect(vehicleErrorMessage(apiErr(409, "vehicle_booking_conflict"))).toBe(VEHICLE_ERROR_TEXT.vehicle_booking_conflict);
    expect(vehicleErrorMessage(apiErr(403, "module_disabled", { module: "vehicles" }))).toContain("尚未開啟");
    expect(vehicleErrorMessage(apiErr(400, "odometer_less_than_start", { startOdometer: 12345 }))).toBe("還車里程不可小於出車里程（12,345 km）");
    expect(vehicleErrorMessage(apiErr(400, "odometer_below_current", { currentOdometer: 500 }))).toContain("500 km");
    expect(vehicleErrorMessage(apiErr(400, "booking_too_long", { maxHours: 12 }))).toBe("單次預約最長 12 小時");
    expect(vehicleErrorMessage(apiErr(409, "vehicle_settings_incomplete", { costTypes: ["fuel", "toll"] }))).toContain("油資、過路費");
    expect(vehicleErrorMessage(apiErr(409, "vehicle_unavailable", { status: "maintenance" }))).toBe("這台車目前維修中，不可預約");
    expect(vehicleErrorMessage(apiErr(413, "file_too_large", { maxBytes: 3 * 1024 * 1024 }))).toContain("3 MB");
  });
  it("不認得的碼：伺服器 message → Error.message → fallback；錯誤碼可從 message 解析", () => {
    const e = apiErr(500, "weird") as Error & { serverMessage?: string };
    e.serverMessage = "伺服器說明";
    expect(vehicleErrorMessage(e)).toBe("伺服器說明");
    expect(vehicleErrorMessage(new Error("網路錯誤"))).toBe("網路錯誤");
    expect(vehicleErrorMessage(null, "預設")).toBe("預設");
    expect(vehicleErrorCode(new Error("[409] already_returned"))).toBe("already_returned");
    expect(vehicleErrorMessage("plate_exists")).toBe(VEHICLE_ERROR_TEXT.plate_exists);
  });
});

describe("localInputToIso／photoPickError", () => {
  it("datetime-local → UTC ISO（toISOString，不送 +08:00 位移）；格式不對 → 空字串", () => {
    expect(localInputToIso("2026-11-05T09:00", 480)).toBe("2026-11-05T01:00:00.000Z");
    expect(localInputToIso("2026-11-05T05:00", 480)).toBe("2026-11-04T21:00:00.000Z");
    expect(localInputToIso("2026-11-05T09:00", -330)).toBe("2026-11-05T14:30:00.000Z");
    expect(localInputToIso("2026-11-05T09:00", 0)).toBe("2026-11-05T09:00:00.000Z");
    expect(localInputToIso("2026/11/05 09:00")).toBe("");
    const browser = localInputToIso("2026-11-05T09:00");
    expect(browser.endsWith("Z")).toBe(true);
    expect(browser).not.toMatch(/[+-]\d{2}:\d{2}$/);
    expect(new Date(browser).getHours()).toBe(9);
  });
  it("bookingMaxInput：今天＋90 天 23:59", () => {
    expect(bookingMaxInput(new Date(2026, 10, 5, 10, 0))).toBe("2027-02-03T23:59");
    expect(bookingMaxInput(new Date(2026, 10, 5), 1)).toBe("2026-11-06T23:59");
  });
  it("photoPickError：只收 jpg/png/heic/heif/webp；空檔、超過 25MB 擋", () => {
    expect(photoPickError({ name: "a.jpg", type: "image/jpeg", size: 1000 })).toBeNull();
    expect(photoPickError({ name: "IMG_0001.HEIC", type: "", size: 1000 })).toBeNull();
    expect(photoPickError({ name: "a.webp", type: "image/webp", size: 1000 })).toBeNull();
    expect(photoPickError({ name: "a.pdf", type: "application/pdf", size: 1000 })).toContain("只收");
    expect(photoPickError({ name: "a.gif", type: "image/gif", size: 1000 })).toContain("只收");
    expect(photoPickError({ name: "a.jpg", type: "image/jpeg", size: 0 })).toContain("空");
    expect(photoPickError({ name: "a.jpg", type: "image/jpeg", size: 26 * 1024 * 1024 })).toContain("25 MB");
  });
});

describe("veh-api 實作新增的錯誤碼與附帶欄位", () => {
  it("附帶欄位帶進訊息：too_many_photos.max、range_too_long.maxDays、invalid_category.field、not_cancellable／booking_not_approved.status", () => {
    expect(vehicleErrorMessage(apiErr(409, "too_many_photos", { max: 12 }))).toBe("每趟最多 12 張照片");
    expect(vehicleErrorMessage(apiErr(400, "range_too_long", { maxDays: 31 }))).toBe("查詢區間最長 31 天");
    expect(vehicleErrorMessage(apiErr(400, "invalid_category", { field: "tollCategoryId" }))).toBe("「過路費」選的報銷類別不存在或已停用");
    expect(vehicleErrorMessage(apiErr(409, "not_cancellable", { status: "completed" }))).toBe("這筆預約已完成，不能再取消");
    expect(vehicleErrorMessage(apiErr(409, "booking_not_approved", { status: "pending" }))).toBe("預約目前簽核中，核准後才能取車");
    expect(vehicleErrorMessage(apiErr(400, "invalid_range"))).toBe("結束時間要晚於開始時間");
    expect(vehicleErrorMessage(apiErr(400, "distance_too_large", { maxKm: 2000 }))).toBe("單趟里程超過上限（2,000 km），請確認里程是否輸入錯誤");
    expect(vehicleErrorMessage(apiErr(400, "odometer_jump_too_large", { maxKm: 5000 }))).toContain("5,000 km");
    expect(vehicleErrorMessage(apiErr(400, "odometer_jump_too_large", { maxKm: 5000, currentOdometer: 12000 }))).toContain("（12,000 km）多超過 5,000 km");
    expect(vehicleErrorMessage(apiErr(400, "odometer_out_of_sequence", { prevEnd: 1200, nextStart: 1500 }))).toBe(
      "更正後的里程與前後趟順序衝突（前一趟還車里程 1,200 km、下一趟出車里程 1,500 km），請確認",
    );
    expect(vehicleErrorMessage(apiErr(400, "odometer_out_of_sequence", { prevEnd: null, nextStart: 1500 }))).toContain("下一趟出車里程 1,500 km");
    expect(vehicleErrorMessage(apiErr(400, "odometer_out_of_sequence", { prevEnd: null, nextStart: null }))).toBe(VEHICLE_ERROR_TEXT.odometer_out_of_sequence);
    expect(vehicleErrorMessage(apiErr(400, "amount_too_large", { maxAmount: 100000 }))).toBe("單筆費用不可超過 NT$ 100,000，請確認是否輸入錯誤");
    expect(vehicleErrorMessage(apiErr(400, "unsupported_file_type"))).toContain("只接受 JPG、PNG、WebP、HEIC");
    expect(vehicleErrorMessage(apiErr(400, "booking_too_far", { maxDaysAhead: 90 }))).toBe("最多只能預約 90 天內的時段");
    expect(vehicleErrorMessage(apiErr(409, "trip_not_returned"))).toContain("尚未還車");
  });
  it("轉報銷逐行錯誤：already_claimed／not_claimable／not_found／claim_failed／period_closed 都是中文", () => {
    const summary = claimResultSummary([
      { ok: false, error: "already_claimed" },
      { ok: false, error: "not_claimable" },
      { ok: false, error: "not_found" },
      { ok: false, error: "claim_failed" },
      { ok: false, error: "period_closed" },
    ]);
    expect(summary).toMatch(/^0 筆已轉報銷、5 筆失敗：/);
    expect(claimResultSummary([{ ok: false, error: "vehicle_settings_incomplete" }])).toContain("公務車 → 設定");
    expect(vehicleErrorMessage(apiErr(400, "reason_required"))).toContain("理由");
    expect(summary).not.toMatch(/[a-z]_[a-z]/);
  });
});
