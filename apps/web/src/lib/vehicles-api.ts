/**
 * 公務車管理（2026-11-05）的 API client。型別照實作計畫 §3.1 原樣宣告（欄位名是與 API 的契約，**不要改名**）；
 * 每個端點一個函式（§3.2）。
 *
 *   - 所有 `/vehicle*` 端點在模組未開（tenants.features.adminModules.vehicles !== true）時回
 *     403 `{ error:"module_disabled", module:"vehicles" }`；錯誤碼 → 中文見 lib/vehicle-view.ts 的 vehicleErrorMessage。
 *   - 建立預約不是獨立端點：走既有 `POST /requests`（kind `vehicle_booking`），簽核鏈、待我簽核、通知全部沿用。
 *   - 車況照片上傳走 JSON base64（同報銷憑證）；送出前先經 lib/upload-prep.ts 的 prepareUploadFile
 *     （照片壓到長邊約 2000px、超過 3 MiB 前端擋下，不送請求）。
 *   - 轉報銷後的收據上傳沿用既有 `uploadExpenseReceipt`（lib/ess-api.ts，POST /expenses/:id/attachments），這裡不重寫。
 */
import { apiFetch } from "./api-client";
import { fileToBase64 } from "./files";
import { prepareUploadFile } from "./upload-prep";

/* ------------------------------------------------------------ 型別 --- */

export type VehicleStatus = "available" | "maintenance" | "retired";
export type BookingStatus = "pending" | "approved" | "rejected" | "cancelled" | "completed";
export type CostType = "fuel" | "toll" | "parking" | "other";
export type PaidBy = "employee" | "company";
export type ClaimState = "none" | "creating" | "claimed";
export type AlertKind = "maintenance_date" | "maintenance_odometer" | "insurance" | "license_tax" | "overdue_return";
export type TripPhotoPhase = "checkout" | "return";
export type ConditionStatus = "ok" | "issue";

export interface VehicleAlert {
  kind: AlertKind;
  dueOn: string | null;
  dueOdometer: number | null;
  overdue: boolean;
  label: string;
}

export interface Vehicle {
  id: string;
  plateNo: string;
  model: string;
  seats: number | null;
  status: VehicleStatus;
  currentOdometer: number;
  // 以下 HR 才有值，一般員工回 null
  maintenanceIntervalKm: number | null;
  maintenanceIntervalMonths: number | null;
  lastMaintenanceOn: string | null;
  lastMaintenanceOdometer: number | null;
  nextMaintenanceOn: string | null;
  nextMaintenanceOdometer: number | null;
  insuranceExpiresOn: string | null;
  licenseTaxDueOn: string | null;
  note: string | null;
  /** HR 才有；員工 []。 */
  alerts: VehicleAlert[];
  createdAt: string;
  updatedAt: string;
}

export interface BusySlot {
  bookingId: string;
  vehicleId: string;
  startAt: string;
  endAt: string;
  status: "pending" | "approved";
  employeeName: string;
  mine: boolean;
}

export interface VehicleBooking {
  id: string;
  vehicleId: string;
  plateNo: string;
  model: string;
  employeeId: string;
  employeeName: string;
  requestId: string | null;
  startAt: string;
  endAt: string;
  purpose: string;
  destination: string | null;
  passengers: number | null;
  status: BookingStatus;
  decidedAt: string | null;
  cancelReason: string | null;
  /** 已取車才有。 */
  tripId: string | null;
  /** 伺服器依時間／狀態／身分算好。 */
  canCheckout: boolean;
  canCancel: boolean;
  createdAt: string;
}

export interface TripCost {
  id: string;
  costType: CostType;
  amount: number;
  paidBy: PaidBy;
  incurredOn: string;
  note: string | null;
  claimState: ClaimState;
  expenseClaimId: string | null;
  /** 從 expense_claims 帶回。 */
  expenseClaimStatus: "submitted" | "settled" | "cancelled" | "rejected" | null;
}

export interface TripPhoto {
  id: string;
  phase: TripPhotoPhase;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url: string | null;
  createdAt: string;
}

export interface VehicleTrip {
  id: string;
  bookingId: string;
  vehicleId: string;
  plateNo: string;
  model: string;
  employeeId: string;
  employeeName: string;
  checkedOutAt: string;
  startOdometer: number;
  odometerOverrideReason: string | null;
  returnedAt: string | null;
  endOdometer: number | null;
  distanceKm: number | null;
  purpose: string | null;
  destination: string | null;
  conditionStatus: ConditionStatus | null;
  conditionNote: string | null;
  note: string | null;
  costs: TripCost[];
  /** 只在單筆 GET 回。 */
  photos?: TripPhoto[];
  canReturn: boolean;
  canClaim: boolean;
}

export interface VehicleSettings {
  fuelCategoryId: string | null;
  tollCategoryId: string | null;
  parkingCategoryId: string | null;
  otherCategoryId: string | null;
  reminderLeadDays: number;
  maintenanceLeadKm: number;
  reminderEmpIds: string[];
  maxBookingHours: number;
  checkoutEarlyMinutes: number;
}

export interface MaintenanceLog {
  id: string;
  servicedOn: string;
  odometer: number;
  cost: number | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

/* -------------------------------------------------------- 請求 body --- */

export interface VehicleInput {
  plateNo: string;
  model: string;
  seats?: number | null;
  status?: VehicleStatus;
  currentOdometer?: number;
  maintenanceIntervalKm?: number | null;
  maintenanceIntervalMonths?: number | null;
  lastMaintenanceOn?: string | null;
  lastMaintenanceOdometer?: number | null;
  nextMaintenanceOn?: string | null;
  nextMaintenanceOdometer?: number | null;
  insuranceExpiresOn?: string | null;
  licenseTaxDueOn?: string | null;
  note?: string | null;
}

/** PATCH：V3 任意子集；currentOdometer 調小時須帶 odometerReason（否則 400 odometer_decrease）。 */
export type VehiclePatch = Partial<VehicleInput> & { odometerReason?: string };

export interface CreateVehicleBookingBody {
  vehicleId: string;
  startAt: string;
  endAt: string;
  /** 用途（必填）。 */
  reason: string;
  /** 目的地。 */
  location?: string;
  remark?: string;
  passengers?: number;
}

/** POST /requests（kind vehicle_booking）的 201 回應：既有欄位＋vehicleBookingId。 */
export interface CreateVehicleBookingResponse {
  requestId: string;
  approvalSource?: string;
  notified?: boolean;
  beyondCap?: null;
  /** 同既有 CreateRequestResult.steps：每關候選姓名（candidateNames，舊 API 退回 approverName）。 */
  steps?: Array<{
    stepOrder?: number;
    approverEmpId?: string;
    approverName?: string | null;
    candidateEmpIds?: string[];
    candidateNames?: string[];
    kind?: string;
  }>;
  vehicleBookingId: string;
}

export interface TripCostInput {
  id?: string;
  costType: CostType;
  amount: number;
  paidBy: PaidBy;
  incurredOn?: string;
  note?: string;
}

export interface ReturnVehicleBody {
  endOdometer: number;
  purpose?: string;
  destination?: string;
  conditionStatus: ConditionStatus;
  conditionNote?: string;
  note?: string;
  costs?: TripCostInput[];
}

export interface TripPatch {
  startOdometer?: number;
  endOdometer?: number;
  purpose?: string;
  destination?: string;
  conditionStatus?: ConditionStatus;
  conditionNote?: string;
  note?: string;
  /** 更正理由（必填）。 */
  reason: string;
}

export type ExpenseClaimResult =
  | { costId: string; ok: true; expenseClaimId: string; period: string }
  | { costId: string; ok: false; error: string; message?: string };

/* ------------------------------------------------------------ 工具 --- */

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, value === true ? "1" : String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

const json = (body: unknown) => JSON.stringify(body);

/* ----------------------------------------------------------- 車輛 --- */

export function listVehicles(params: { includeRetired?: boolean; status?: VehicleStatus } = {}) {
  return apiFetch<{ vehicles: Vehicle[] }>(`/vehicles${qs({ includeRetired: params.includeRetired, status: params.status })}`);
}

export function getVehicle(id: string) {
  return apiFetch<{ vehicle: Vehicle }>(`/vehicles/${encodeURIComponent(id)}`);
}

export function createVehicle(body: VehicleInput) {
  return apiFetch<{ vehicle: Vehicle }>("/vehicles", { method: "POST", body: json(body) });
}

export function updateVehicle(id: string, body: VehiclePatch) {
  return apiFetch<{ vehicle: Vehicle; affectedBookings: VehicleBooking[] }>(`/vehicles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: json(body),
  });
}

export function recordMaintenance(id: string, body: { servicedOn: string; odometer: number; cost?: number; note?: string }) {
  return apiFetch<{ log: MaintenanceLog; vehicle: Vehicle }>(`/vehicles/${encodeURIComponent(id)}/maintenance`, {
    method: "POST",
    body: json(body),
  });
}

export function listMaintenance(id: string) {
  return apiFetch<{ logs: MaintenanceLog[] }>(`/vehicles/${encodeURIComponent(id)}/maintenance`);
}

/** 佔用時段（只回 pending/approved）；from／to 是 ISO，跨度 ≤ 31 天（否則 400 range_too_long）。 */
export function getAvailability(params: { from: string; to: string; vehicleId?: string }) {
  return apiFetch<{ slots: BusySlot[] }>(`/vehicles/availability${qs(params)}`);
}

/* ----------------------------------------------------------- 預約 --- */

/** 建立預約＝送一張 kind `vehicle_booking` 的申請單（既有簽核流程）。 */
export function createVehicleBooking(body: CreateVehicleBookingBody) {
  return apiFetch<CreateVehicleBookingResponse>("/requests", {
    method: "POST",
    body: json({ kind: "vehicle_booking", ...body }),
  });
}

export function listVehicleBookings(
  params: { scope?: "mine" | "all"; vehicleId?: string; status?: BookingStatus; from?: string; to?: string } = {},
) {
  return apiFetch<{ bookings: VehicleBooking[] }>(`/vehicle-bookings${qs(params)}`);
}

export function getVehicleBooking(id: string) {
  return apiFetch<{ booking: VehicleBooking }>(`/vehicle-bookings/${encodeURIComponent(id)}`);
}

export function cancelVehicleBooking(id: string, reason?: string) {
  return apiFetch<{ booking: VehicleBooking }>(`/vehicle-bookings/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: json(reason ? { reason } : {}),
  });
}

/* --------------------------------------------------------- 取還車 --- */

export function checkoutVehicle(bookingId: string, body: { startOdometer: number; odometerOverrideReason?: string; note?: string }) {
  return apiFetch<{ trip: VehicleTrip }>(`/vehicle-bookings/${encodeURIComponent(bookingId)}/checkout`, {
    method: "POST",
    body: json(body),
  });
}

export function returnVehicle(tripId: string, body: ReturnVehicleBody) {
  return apiFetch<{ trip: VehicleTrip }>(`/vehicle-trips/${encodeURIComponent(tripId)}/return`, {
    method: "POST",
    body: json(body),
  });
}

export function listVehicleTrips(
  params: { scope?: "mine" | "all"; vehicleId?: string; from?: string; to?: string; open?: boolean } = {},
) {
  return apiFetch<{ trips: VehicleTrip[] }>(`/vehicle-trips${qs(params)}`);
}

export function getVehicleTrip(id: string) {
  return apiFetch<{ trip: VehicleTrip }>(`/vehicle-trips/${encodeURIComponent(id)}`);
}

export function updateVehicleTrip(id: string, body: TripPatch) {
  return apiFetch<{ trip: VehicleTrip }>(`/vehicle-trips/${encodeURIComponent(id)}`, { method: "PATCH", body: json(body) });
}

/** 整批覆寫未請款（claimState none）的費用行；已請款的行不可改不可刪（409 cost_already_claimed）。 */
export function saveTripCosts(id: string, costs: TripCostInput[]) {
  return apiFetch<{ trip: VehicleTrip }>(`/vehicle-trips/${encodeURIComponent(id)}/costs`, {
    method: "PUT",
    body: json({ costs }),
  });
}

/** 車況照片：先壓縮（長邊約 2000px、> 3 MiB 前端擋下丟 UploadPrepError），再 base64 上傳。 */
export async function uploadTripPhoto(tripId: string, phase: TripPhotoPhase, file: File) {
  const upload = await prepareUploadFile(file);
  return apiFetch<{ photo: TripPhoto }>(`/vehicle-trips/${encodeURIComponent(tripId)}/photos`, {
    method: "POST",
    body: json({
      phase,
      fileName: upload.name,
      contentType: upload.type || "application/octet-stream",
      dataBase64: await fileToBase64(upload),
    }),
  });
}

export function listTripPhotos(tripId: string) {
  return apiFetch<{ photos: TripPhoto[] }>(`/vehicle-trips/${encodeURIComponent(tripId)}/photos`);
}

/** 轉報銷（只有用車人本人）；省略 costIds＝全部 paidBy=employee 且未請款的行。逐行成敗，整批 HTTP 200。 */
export function createTripExpenseClaims(tripId: string, costIds?: string[]) {
  return apiFetch<{ results: ExpenseClaimResult[]; trip: VehicleTrip }>(
    `/vehicle-trips/${encodeURIComponent(tripId)}/expense-claims`,
    { method: "POST", body: json(costIds ? { costIds } : {}) },
  );
}

/* ----------------------------------------------------------- 設定 --- */

export function getVehicleSettings() {
  return apiFetch<{ settings: VehicleSettings }>("/vehicle-settings");
}

export function saveVehicleSettings(body: Partial<VehicleSettings>) {
  return apiFetch<{ settings: VehicleSettings }>("/vehicle-settings", { method: "PUT", body: json(body) });
}
