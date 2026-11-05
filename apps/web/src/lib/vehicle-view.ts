/**
 * 公務車管理的純函式（不碰 React／瀏覽器 API；全部有 vitest：__tests__/vehicle-view.test.ts）。
 *
 *   - 狀態／費用類型／付款方／請款狀態／提醒種類的中文標籤與 Pill 色。
 *   - `distanceOf`：還車里程 − 出車里程（即時顯示行駛公里數）。
 *   - `validateReturn`：還車表單前端先擋（還車里程 < 出車里程、車況有問題沒寫說明）；最終以 API 為準。
 *   - `overlaps`：送預約前的時段預檢（半開區間 [start, end)，相接不算重疊）；最終以 API 409 為準。
 *   - `bookingActions`：預約卡要顯示哪些按鈕（伺服器的 canCheckout／canCancel 為主，前端只補「看紀錄」「還車」）。
 *   - `vehicleErrorMessage`：§3.2 所有錯誤碼 → 中文（附帶欄位如 maxHours／currentOdometer／earliestAt 會帶進句子）。
 *   - `photoPickError`：車況照片挑檔時的檔案類型／原檔大小判斷（壓縮與 3 MiB 上限在 lib/upload-prep.ts）。
 *   - datetime-local ↔ ISO（帶本地時區位移）。
 */
import type {
  AlertKind,
  BookingStatus,
  BusySlot,
  ClaimState,
  CostType,
  PaidBy,
  TripCost,
  VehicleAlert,
  VehicleBooking,
  VehicleStatus,
  VehicleTrip,
} from "./vehicles-api";
import { describePeriodClosed } from "./period-closed";
import { IMAGE_SOURCE_MAX_BYTES } from "./upload-prep";

export type Tone = "gray" | "green" | "amber" | "red" | "blue" | "brand";

/* ------------------------------------------------------------ 標籤 --- */

export const VEHICLE_STATUS_LABEL: Record<VehicleStatus, string> = {
  available: "可預約",
  maintenance: "維修中",
  retired: "已停用",
};

export const VEHICLE_STATUS_TONE: Record<VehicleStatus, Tone> = {
  available: "green",
  maintenance: "amber",
  retired: "gray",
};

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  pending: "簽核中",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已取消",
  completed: "已完成",
};

export const BOOKING_STATUS_TONE: Record<BookingStatus, Tone> = {
  pending: "amber",
  approved: "green",
  rejected: "red",
  cancelled: "gray",
  completed: "blue",
};

export const COST_TYPE_LABEL: Record<CostType, string> = {
  fuel: "油資",
  toll: "過路費",
  parking: "停車費",
  other: "其他",
};

export const COST_TYPES: readonly CostType[] = ["fuel", "toll", "parking", "other"];

export const PAID_BY_LABEL: Record<PaidBy, string> = {
  employee: "員工代墊",
  company: "公司支付",
};

export const CLAIM_STATE_LABEL: Record<ClaimState, string> = {
  none: "未請款",
  creating: "建單中",
  claimed: "已轉報銷",
};

export const EXPENSE_CLAIM_STATUS_LABEL: Record<NonNullable<TripCost["expenseClaimStatus"]>, string> = {
  submitted: "已送出",
  settled: "已核銷",
  cancelled: "已撤回",
  rejected: "已退回",
};

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  maintenance_date: "保養到期",
  maintenance_odometer: "保養里程",
  insurance: "保險到期",
  license_tax: "牌照稅",
  overdue_return: "逾時未還",
};

export const CONDITION_LABEL: Record<"ok" | "issue", string> = { ok: "正常", issue: "有問題" };

/** 已過期／逾時 → 紅；即將到期 → 黃。 */
export function alertTone(alert: Pick<VehicleAlert, "overdue">): Tone {
  return alert.overdue ? "red" : "amber";
}

/** 提醒的顯示文字：API 給的 label 優先，沒有就用種類標籤＋到期日／里程。 */
export function alertText(alert: VehicleAlert): string {
  if (alert.label && alert.label.trim()) return alert.label;
  const base = ALERT_KIND_LABEL[alert.kind] ?? alert.kind;
  if (alert.dueOn) return `${base} ${alert.dueOn}`;
  if (alert.dueOdometer != null) return `${base} ${alert.dueOdometer.toLocaleString("en-US")} km`;
  return base;
}

/* ------------------------------------------------------------ 里程 --- */

function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 行駛公里數＝還車 − 出車；任一缺／非數字 → null；負數照實回（呼叫端拿來顯示錯誤）。 */
export function distanceOf(start: number | string | null | undefined, end: number | string | null | undefined): number | null {
  const s = toInt(start);
  const e = toInt(end);
  if (s === null || e === null) return null;
  return e - s;
}

export function fmtKm(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return "—";
  return `${km.toLocaleString("en-US")} km`;
}

export type ReturnField = "endOdometer" | "conditionNote";

export type ReturnValidation = { ok: true } | { ok: false; field: ReturnField; message: string };

/** 還車表單前端檢查：里程必填、非負整數、不可小於出車里程；車況有問題必填說明。 */
export function validateReturn(input: {
  startOdometer: number;
  endOdometer: number | string | null | undefined;
  conditionStatus: "ok" | "issue";
  conditionNote?: string | null;
}): ReturnValidation {
  const raw = input.endOdometer;
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { ok: false, field: "endOdometer", message: "請填還車里程" };
  }
  const end = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(end) || !Number.isInteger(end) || end < 0) {
    return { ok: false, field: "endOdometer", message: "還車里程請填整數公里" };
  }
  if (end < input.startOdometer) {
    return {
      ok: false,
      field: "endOdometer",
      message: `還車里程不可小於出車里程（${input.startOdometer.toLocaleString("en-US")} km）`,
    };
  }
  if (input.conditionStatus === "issue" && !(input.conditionNote ?? "").trim()) {
    return { ok: false, field: "conditionNote", message: "車況有問題時請說明狀況" };
  }
  return { ok: true };
}

/** 出車里程檢查：必填非負整數；低於車輛目前里程時要填理由（overrideReason）。回 null＝通過。 */
export function checkoutOdometerError(input: {
  startOdometer: number | string | null | undefined;
  currentOdometer: number;
  overrideReason?: string | null;
}): string | null {
  const raw = input.startOdometer;
  if (raw === null || raw === undefined || String(raw).trim() === "") return "請填出車里程";
  const n = Number(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return "出車里程請填整數公里";
  if (n < input.currentOdometer && !(input.overrideReason ?? "").trim()) {
    return `低於車輛目前里程（${input.currentOdometer.toLocaleString("en-US")} km），請填寫原因`;
  }
  return null;
}

/* ------------------------------------------------------------ 時段 --- */

function ms(iso: string | Date): number {
  return iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
}

/**
 * 與 [start, end) 重疊的佔用時段（半開區間：前一筆 12:00 結束、下一筆 12:00 開始不算重疊）。
 * `vehicleId` 有給就只看那台車；`excludeBookingId` 排除自己（改期時用）。時間無效 → []。
 */
export function overlaps(
  slots: readonly BusySlot[],
  start: string | Date,
  end: string | Date,
  opts: { vehicleId?: string; excludeBookingId?: string } = {},
): BusySlot[] {
  const s = ms(start);
  const e = ms(end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];
  return slots.filter((slot) => {
    if (opts.vehicleId && slot.vehicleId !== opts.vehicleId) return false;
    if (opts.excludeBookingId && slot.bookingId === opts.excludeBookingId) return false;
    const ss = ms(slot.startAt);
    const se = ms(slot.endAt);
    return ss < e && s < se;
  });
}

/**
 * 預約起訖檢查（送單前）：缺、結束不晚於開始、超過上限時數、開始晚於「現在＋maxDaysAhead×24 小時」（預設 90；
 * 與 API services/vehicle-booking.ts 同一條式子，日期選擇器的 max 只是放寬到該日方便選，最終以此為準）。
 * 回 null＝通過。`now` 可注入（測試）。
 */
export function bookingRangeError(
  start: string,
  end: string,
  maxHours?: number | null,
  opts: { now?: Date; maxDaysAhead?: number } = {},
): string | null {
  if (!start || !end) return "請選擇開始與結束時間";
  const s = ms(start);
  const e = ms(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return "時間格式不正確";
  if (e <= s) return "結束時間要晚於開始時間";
  const maxDays = opts.maxDaysAhead ?? 90;
  const now = opts.now ?? new Date();
  const limit = now.getTime() + maxDays * 86_400_000;
  if (s > limit) return `最多只能預約 ${maxDays} 天內的時段`;
  if (maxHours && maxHours > 0 && e - s > maxHours * 3_600_000) return `單次預約最長 ${maxHours} 小時`;
  return null;
}

/* ------------------------------------------------------ 預約卡按鈕 --- */

export interface BookingActions {
  /** 取車（伺服器 canCheckout）。 */
  checkout: boolean;
  /** 取消（伺服器 canCancel）。 */
  cancel: boolean;
  /** 已取車：進用車紀錄頁（還車／費用／照片）。 */
  openTrip: boolean;
  /** 已核准但還沒到可取車時間（顯示「MM/DD HH:mm 起可取車」）。 */
  waiting: boolean;
}

/**
 * 預約卡的動作。取車／取消以伺服器算好的 canCheckout／canCancel 為準（前端不重算規則）；
 * 有 tripId 就給「用車紀錄」；已核准、還沒取車、也還沒結束、但伺服器說還不能取車 → waiting。
 */
export function bookingActions(
  booking: Pick<VehicleBooking, "status" | "tripId" | "canCheckout" | "canCancel" | "endAt">,
  now: Date | number = Date.now(),
): BookingActions {
  const t = typeof now === "number" ? now : now.getTime();
  const notEnded = ms(booking.endAt) > t;
  return {
    checkout: booking.canCheckout && !booking.tripId,
    cancel: booking.canCancel,
    openTrip: !!booking.tripId,
    waiting: booking.status === "approved" && !booking.tripId && !booking.canCheckout && notEnded,
  };
}

/** 可轉報銷的費用行：員工代墊且尚未請款。 */
export function claimableCosts(costs: readonly TripCost[]): TripCost[] {
  return costs.filter((c) => c.paidBy === "employee" && c.claimState === "none");
}

/** 「轉報銷」按鈕只給用車人本人（業主拍板），且已還車、伺服器 canClaim、有可轉的行。 */
export function canShowClaimButton(trip: Pick<VehicleTrip, "employeeId" | "returnedAt" | "canClaim" | "costs">, myEmployeeId: string | null | undefined): boolean {
  if (!myEmployeeId || trip.employeeId !== myEmployeeId) return false;
  if (!trip.returnedAt || !trip.canClaim) return false;
  return claimableCosts(trip.costs).length > 0;
}

/* ------------------------------------------------------------ 時間 --- */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `<input type="datetime-local">` 的值（`YYYY-MM-DDTHH:mm`，當地時間）→ **UTC** ISO（`toISOString()`，
 * 例：台北 `2026-11-05T09:00` → `2026-11-05T01:00:00.000Z`）。2026-11-05 驗收：曾送 `+08:00` 位移格式被 API 400，
 * 一律改送 UTC（API 端也會放寬接受位移，雙保險）。格式不對 → ""。
 * `offsetMinutes`（當地相對 UTC 的分鐘數，台北 480）可注入（測試）；省略＝瀏覽器時區。
 */
export function localInputToIso(value: string, offsetMinutes?: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return "";
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date =
    offsetMinutes === undefined
      ? new Date(y, mo - 1, d, h, mi)
      : new Date(Date.UTC(y, mo - 1, d, h, mi) - offsetMinutes * 60_000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

/** 預約開始時間最多可選到今天＋幾天（業主：90 天；API 另有 booking_too_far 以租戶設定為準）。 */
export const BOOKING_MAX_DAYS_AHEAD = 90;

/** datetime-local 的 max 屬性：今天＋maxDays 的 23:59（當地）。 */
export function bookingMaxInput(now: Date = new Date(), maxDays = BOOKING_MAX_DAYS_AHEAD): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + maxDays, 23, 59);
  return dateToLocalInput(d);
}

/** Date → datetime-local 值（當地時間）。 */
export function dateToLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 下一個整點／半點（預約表單預設開始時間）。 */
export function nextHalfHour(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  d.setMinutes(m < 30 ? 30 : 60);
  return d;
}

/* ---------------------------------------------------------- 照片 --- */

const PHOTO_EXT = /\.(jpe?g|png|heic|heif|webp)$/i;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]);

/** 車況照片挑檔檢查：只收 jpg/jpeg/png/heic/heif/webp；空檔、原檔超過 25 MB 擋下。回 null＝通過（之後壓縮、> 3 MiB 再擋）。 */
export function photoPickError(file: { name: string; type?: string | null; size: number }): string | null {
  const typeOk = file.type ? PHOTO_TYPES.has(file.type.toLowerCase()) : false;
  if (!typeOk && !PHOTO_EXT.test(file.name)) return "只收 JPG、PNG、HEIC、WebP 照片";
  if (file.size <= 0) return "檔案是空的，請重新選擇";
  if (file.size > IMAGE_SOURCE_MAX_BYTES) return "照片超過 25 MB，請改傳較小的照片";
  return null;
}

/* ------------------------------------------------------------ 錯誤 --- */

/** §3.2 錯誤碼 → 中文（固定句；需要附帶數字的在 vehicleErrorMessage 組）。 */
export const VEHICLE_ERROR_TEXT: Record<string, string> = {
  module_disabled: "公務車功能尚未開啟，請洽 HR 到「設定 → 進階功能」開啟",
  migration_required: "系統尚未完成公務車功能的資料庫更新，請洽管理者",
  invalid_body: "填寫內容有誤，請檢查後再送出",
  invalid_query: "查詢條件有誤",
  not_an_employee: "你的帳號沒有對應的在職員工資料",
  forbidden: "你沒有權限執行這個動作",
  not_found: "找不到這筆資料，可能已被刪除或你沒有權限",
  plate_exists: "這個車牌已經登記過了",
  odometer_decrease: "目前里程調小時請填寫原因",
  range_too_long: "查詢區間最長 31 天",
  vehicle_required: "請選擇車輛",
  purpose_required: "請填寫用途",
  invalid_vehicle: "找不到這台車，請重新整理",
  booking_too_long: "超過單次預約上限時數",
  booking_in_past: "開始時間已經過去，請重新選擇",
  vehicle_unavailable: "這台車目前不可預約（維修中或已停用）",
  vehicle_booking_conflict: "這個時段已經有人預約了，請改選其他時段或車輛",
  no_approver_available: "找不到可簽核的主管，請洽 HR 設定簽核流程",
  period_closed: "該月份已結算，請洽管理者",
  already_checked_out: "這筆預約已經取車了",
  not_cancellable: "這筆預約已結束或已取消，不能再取消",
  reason_required: "請填寫原因（代為取消預約、修改他人費用都需要理由）",
  booking_not_approved: "預約尚未核准，還不能取車",
  checkout_too_early: "還沒到可取車的時間",
  booking_expired: "預約時段已過，不能取車；請重新預約",
  vehicle_in_use: "這台車還沒被還回來（前一位使用者尚未還車），請聯絡 HR",
  odometer_below_current: "出車里程低於車輛目前里程，請填寫原因",
  odometer_less_than_start: "還車里程不可小於出車里程",
  condition_note_required: "車況有問題時請說明狀況",
  already_returned: "這趟已經還車了，請重新整理",
  cost_already_claimed: "部分費用已轉報銷，不能修改或刪除",
  unsupported_file_type: "只接受 JPG、PNG、WebP、HEIC 照片（檔案內容與格式不符也會被拒），請重新拍照或改傳其他照片",
  file_too_large: "照片超過 3 MB，請改傳較小的照片",
  too_many_photos: "每趟最多 12 張照片",
  trip_not_returned: "這趟尚未還車，還車後才能轉報銷或更正還車資料",
  invalid_range: "結束時間要晚於開始時間",
  distance_too_large: "單趟里程超過上限，請確認還車里程是否輸入錯誤",
  booking_too_far: "預約開始時間超過可預約的天數",
  odometer_jump_too_large: "取車里程比車輛目前里程多太多，請確認輸入是否正確，或請管理員調整車輛里程",
  amount_too_large: "單筆費用金額過高，請確認是否輸入錯誤",
  odometer_out_of_sequence: "更正後的里程與前後趟的里程順序衝突，請確認",
  invalid_photo: "照片檔案無法辨識（格式與內容不符），請改傳 JPG、PNG 或重新拍照",
  invalid_base64: "照片檔案讀取失敗，請重新選擇照片",
  already_claimed: "這筆費用已經轉報銷過了",
  not_claimable: "公司支付的費用不需報銷",
  claim_failed: "建立報銷單失敗，請稍後再試",
  vehicle_settings_incomplete: "這個費用類型沒有對應的報銷類別，請管理員到「公務車 → 設定」補上",
  invalid_category: "報銷類別不存在或已停用",
  trip_request_required: "這個報銷類別需要綁出差單，不能用於用車費用",
  period_settled: "該月份報銷已月結，不能再送出",
  not_trip_owner: "只有用車人本人可以轉報銷",
  category_requires_trip: "需要綁出差單的報銷類別不能用於用車費用",
  invalid_employee: "提醒對象中有不屬於本公司的員工",
};

type ErrLike = { code?: string; status?: number; message?: string; body?: unknown; serverMessage?: string };

function bodyOf(err: unknown): Record<string, unknown> {
  const body = (err as ErrLike | null)?.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** 從 ApiError 取錯誤碼：err.code 優先，否則從 message `[409] code` 解析。純字串直接當碼。 */
export function vehicleErrorCode(err: unknown): string | null {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return null;
  const e = err as ErrLike;
  if (typeof e.code === "string" && e.code) return e.code;
  const m = /^\[\d{3}\]\s*([a-z_]+)$/.exec(e.message ?? "");
  return m ? (m[1] ?? null) : null;
}

function fmtWhen(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const COST_TYPE_SET = new Set<string>(COST_TYPES);

/** PUT /vehicle-settings 的 400 invalid_category 附 field（哪個欄位的類別有問題）。 */
const CATEGORY_FIELD_LABEL: Record<string, string> = {
  fuelCategoryId: COST_TYPE_LABEL.fuel,
  tollCategoryId: COST_TYPE_LABEL.toll,
  parkingCategoryId: COST_TYPE_LABEL.parking,
  otherCategoryId: COST_TYPE_LABEL.other,
};

/**
 * 錯誤（ApiError、錯誤碼字串、一般 Error）→ 給人看的中文。認得的碼用 VEHICLE_ERROR_TEXT，附帶欄位補進句子：
 * booking_too_long（maxHours）、odometer_below_current（currentOdometer）、odometer_less_than_start（startOdometer）、
 * checkout_too_early（earliestAt）、file_too_large（maxBytes）、vehicle_settings_incomplete（costTypes）、
 * vehicle_booking_conflict（conflicts 第一筆的預約者與時段）、period_closed 走既有 describePeriodClosed。
 * 不認得的碼：伺服器 message 原文 → Error.message → fallback。
 */
export function vehicleErrorMessage(err: unknown, fallback = "操作失敗，請稍後再試"): string {
  const code = vehicleErrorCode(err);
  const body = bodyOf(err);
  if (code === "period_closed") {
    const closed = describePeriodClosed(err);
    if (closed) return closed;
  }
  if (code === "booking_too_long" && typeof body.maxHours === "number") return `單次預約最長 ${body.maxHours} 小時`;
  if (code === "odometer_below_current" && typeof body.currentOdometer === "number") {
    return `出車里程低於車輛目前里程（${body.currentOdometer.toLocaleString("en-US")} km），請填寫原因`;
  }
  if (code === "odometer_less_than_start" && typeof body.startOdometer === "number") {
    return `還車里程不可小於出車里程（${body.startOdometer.toLocaleString("en-US")} km）`;
  }
  if (code === "checkout_too_early") {
    const when = fmtWhen(body.earliestAt);
    if (when) return `還沒到可取車的時間，${when} 起可取車`;
  }
  if (code === "file_too_large" && typeof body.maxBytes === "number") {
    return `照片超過 ${Math.round((body.maxBytes / 1024 / 1024) * 10) / 10} MB，請改傳較小的照片`;
  }
  if (code === "vehicle_settings_incomplete" && Array.isArray(body.costTypes)) {
    const names = body.costTypes.filter((t): t is string => typeof t === "string").map((t) => (COST_TYPE_SET.has(t) ? COST_TYPE_LABEL[t as CostType] : t));
    if (names.length > 0) return `HR 尚未設定「${names.join("、")}」對應的報銷類別，暫時無法轉報銷`;
  }
  if (code === "vehicle_booking_conflict" && Array.isArray(body.conflicts) && body.conflicts.length > 0) {
    const first = body.conflicts[0] as Partial<BusySlot>;
    const s = fmtWhen(first.startAt);
    const e = fmtWhen(first.endAt);
    if (s && e) {
      const who = first.mine ? "你" : first.employeeName || "其他同仁";
      return `這個時段已被${who}預約（${s}–${e.slice(6)}），請改選其他時段或車輛`;
    }
  }
  if (code === "vehicle_unavailable" && typeof body.status === "string") {
    const label = VEHICLE_STATUS_LABEL[body.status as VehicleStatus];
    if (label) return `這台車目前${label}，不可預約`;
  }
  if (code === "distance_too_large" && typeof body.maxKm === "number") {
    return `單趟里程超過上限（${body.maxKm.toLocaleString("en-US")} km），請確認里程是否輸入錯誤`;
  }
  if (code === "odometer_jump_too_large" && typeof body.maxKm === "number") {
    if (typeof body.currentOdometer === "number") {
      return `取車里程比車輛目前里程（${body.currentOdometer.toLocaleString("en-US")} km）多超過 ${body.maxKm.toLocaleString("en-US")} km，請確認輸入是否正確，或請管理員調整車輛里程`;
    }
    return `取車里程比車輛目前里程多超過 ${body.maxKm.toLocaleString("en-US")} km，請確認輸入是否正確，或請管理員調整車輛里程`;
  }
  if (code === "odometer_out_of_sequence") {
    const fmt = (v: unknown) => (typeof v === "number" ? `${v.toLocaleString("en-US")} km` : null);
    const parts = [
      fmt(body.prevEnd) ? `前一趟還車里程 ${fmt(body.prevEnd)}` : null,
      fmt(body.nextStart) ? `下一趟出車里程 ${fmt(body.nextStart)}` : null,
    ].filter(Boolean);
    if (parts.length > 0) return `更正後的里程與前後趟順序衝突（${parts.join("、")}），請確認`;
  }
  if (code === "amount_too_large" && typeof body.maxAmount === "number") {
    return `單筆費用不可超過 NT$ ${body.maxAmount.toLocaleString("en-US")}，請確認是否輸入錯誤`;
  }
  if (code === "booking_too_far" && typeof body.maxDaysAhead === "number") return `最多只能預約 ${body.maxDaysAhead} 天內的時段`;
  if (code === "too_many_photos" && typeof body.max === "number") return `每趟最多 ${body.max} 張照片`;
  if (code === "range_too_long" && typeof body.maxDays === "number") return `查詢區間最長 ${body.maxDays} 天`;
  if (code === "invalid_category" && typeof body.field === "string") {
    const label = CATEGORY_FIELD_LABEL[body.field];
    if (label) return `「${label}」選的報銷類別不存在或已停用`;
  }
  if ((code === "not_cancellable" || code === "booking_not_approved") && typeof body.status === "string") {
    const label = BOOKING_STATUS_LABEL[body.status as BookingStatus];
    if (label) return code === "not_cancellable" ? `這筆預約${label}，不能再取消` : `預約目前${label}，核准後才能取車`;
  }
  if (code && VEHICLE_ERROR_TEXT[code]) return VEHICLE_ERROR_TEXT[code];
  if (err && typeof err === "object") {
    const server = (err as ErrLike).serverMessage;
    if (server && server.trim()) return server;
    const msg = (err as ErrLike).message;
    if (msg && msg.trim()) return msg;
  }
  return fallback;
}

/** 409 vehicle_booking_conflict 附的衝突時段（顯示並刷新用）；沒有 → []。 */
export function conflictSlotsOf(err: unknown): BusySlot[] {
  if (vehicleErrorCode(err) !== "vehicle_booking_conflict") return [];
  const raw = bodyOf(err).conflicts;
  return Array.isArray(raw) ? (raw as BusySlot[]) : [];
}

/** 轉報銷逐行結果的摘要：「2 筆已轉報銷、1 筆失敗：該月份報銷已月結…」。 */
export function claimResultSummary(results: ReadonlyArray<{ ok: boolean; error?: string; message?: string }>): string {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (results.length === 0) return "沒有可轉報銷的費用";
  if (failed.length === 0) return `${ok} 筆已轉報銷`;
  const reasons = [...new Set(failed.map((r) => (r.error && VEHICLE_ERROR_TEXT[r.error]) || r.message || r.error || "失敗"))];
  return `${ok} 筆已轉報銷、${failed.length} 筆失敗：${reasons.join("；")}`;
}
