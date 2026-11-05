"use client";

/**
 * 後台公務車頁共用：車輛表單（新增／編輯；含保養、保險、牌照稅欄位）與「受影響的預約」面板
 * （車輛改成維修中／停用時 API 回 affectedBookings，不自動取消；HR 逐筆「取消並通知」→ B4，理由必填）。
 */
import { useState } from "react";
import { BottomSheet, Button, Field, InlineError, Input, Pill, Select, Textarea, useToast } from "@/components/admin-ui";
import { fmtDateTime } from "@/lib/ess-format";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE, VEHICLE_STATUS_LABEL, vehicleErrorMessage } from "@/lib/vehicle-view";
import {
  cancelVehicleBooking,
  createVehicle,
  updateVehicle,
  type Vehicle,
  type VehicleBooking,
  type VehicleInput,
  type VehiclePatch,
  type VehicleStatus,
} from "@/lib/vehicles-api";

interface Draft {
  plateNo: string;
  model: string;
  seats: string;
  status: VehicleStatus;
  currentOdometer: string;
  maintenanceIntervalKm: string;
  maintenanceIntervalMonths: string;
  lastMaintenanceOn: string;
  lastMaintenanceOdometer: string;
  nextMaintenanceOn: string;
  nextMaintenanceOdometer: string;
  insuranceExpiresOn: string;
  licenseTaxDueOn: string;
  note: string;
  odometerReason: string;
}

const str = (v: number | string | null | undefined) => (v === null || v === undefined ? "" : String(v));

function draftOf(v: Vehicle | null): Draft {
  return {
    plateNo: v?.plateNo ?? "",
    model: v?.model ?? "",
    seats: str(v?.seats),
    status: v?.status ?? "available",
    currentOdometer: str(v?.currentOdometer ?? 0),
    maintenanceIntervalKm: str(v?.maintenanceIntervalKm),
    maintenanceIntervalMonths: str(v?.maintenanceIntervalMonths),
    lastMaintenanceOn: v?.lastMaintenanceOn ?? "",
    lastMaintenanceOdometer: str(v?.lastMaintenanceOdometer),
    nextMaintenanceOn: v?.nextMaintenanceOn ?? "",
    nextMaintenanceOdometer: str(v?.nextMaintenanceOdometer),
    insuranceExpiresOn: v?.insuranceExpiresOn ?? "",
    licenseTaxDueOn: v?.licenseTaxDueOn ?? "",
    note: v?.note ?? "",
    odometerReason: "",
  };
}

/** 空字串 → null；非負整數 → number；其他 → NaN（呼叫端擋）。 */
function intOrNull(s: string): number | null {
  const t = s.replace(/,/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN;
}

function toInput(d: Draft): { ok: true; body: VehicleInput } | { ok: false; message: string } {
  if (!d.plateNo.trim()) return { ok: false, message: "請填車牌" };
  if (!d.model.trim()) return { ok: false, message: "請填車型" };
  const nums = {
    seats: intOrNull(d.seats),
    currentOdometer: intOrNull(d.currentOdometer),
    maintenanceIntervalKm: intOrNull(d.maintenanceIntervalKm),
    maintenanceIntervalMonths: intOrNull(d.maintenanceIntervalMonths),
    lastMaintenanceOdometer: intOrNull(d.lastMaintenanceOdometer),
    nextMaintenanceOdometer: intOrNull(d.nextMaintenanceOdometer),
  };
  for (const [k, v] of Object.entries(nums)) if (Number.isNaN(v)) return { ok: false, message: `${FIELD_LABEL[k] ?? k}請填非負整數` };
  return {
    ok: true,
    body: {
      plateNo: d.plateNo.trim().toUpperCase(),
      model: d.model.trim(),
      seats: nums.seats,
      status: d.status,
      currentOdometer: nums.currentOdometer ?? 0,
      maintenanceIntervalKm: nums.maintenanceIntervalKm,
      maintenanceIntervalMonths: nums.maintenanceIntervalMonths,
      lastMaintenanceOn: d.lastMaintenanceOn || null,
      lastMaintenanceOdometer: nums.lastMaintenanceOdometer,
      nextMaintenanceOn: d.nextMaintenanceOn || null,
      nextMaintenanceOdometer: nums.nextMaintenanceOdometer,
      insuranceExpiresOn: d.insuranceExpiresOn || null,
      licenseTaxDueOn: d.licenseTaxDueOn || null,
      note: d.note.trim() || null,
    },
  };
}

const FIELD_LABEL: Record<string, string> = {
  seats: "座位數",
  currentOdometer: "目前里程",
  maintenanceIntervalKm: "保養間隔（公里）",
  maintenanceIntervalMonths: "保養間隔（月）",
  lastMaintenanceOdometer: "上次保養里程",
  nextMaintenanceOdometer: "下次保養里程",
};

/** 新增（vehicle=null）或編輯車輛。存檔成功回 onSaved(vehicle, affectedBookings)。 */
export function VehicleFormSheet({
  open,
  vehicle,
  onClose,
  onSaved,
}: {
  open: boolean;
  vehicle: Vehicle | null;
  onClose: () => void;
  onSaved: (vehicle: Vehicle, affected: VehicleBooking[]) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(vehicle));
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 開啟／換車時重設草稿（render 期間依 key 比對，不用 effect）。
  const key = open ? (vehicle?.id ?? "new") : null;
  if (key !== lastKey) {
    setLastKey(key);
    setDraft(draftOf(vehicle));
    setError(null);
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const decreasing = !!vehicle && intOrNull(draft.currentOdometer) !== null && (intOrNull(draft.currentOdometer) as number) < vehicle.currentOdometer;

  async function save() {
    setError(null);
    const parsed = toInput(draft);
    if (!parsed.ok) return setError(parsed.message);
    if (decreasing && !draft.odometerReason.trim()) return setError("目前里程調小時請填寫原因");
    setBusy(true);
    try {
      if (vehicle) {
        const body: VehiclePatch = { ...parsed.body, ...(decreasing ? { odometerReason: draft.odometerReason.trim() } : {}) };
        const res = await updateVehicle(vehicle.id, body);
        onSaved(res.vehicle, res.affectedBookings ?? []);
      } else {
        const res = await createVehicle(parsed.body);
        onSaved(res.vehicle, []);
      }
    } catch (err) {
      setError(vehicleErrorMessage(err, "儲存失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={() => !busy && onClose()} title={vehicle ? `編輯 ${vehicle.plateNo}` : "新增車輛"}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="車牌" required htmlFor="vf-plate">
            <Input id="vf-plate" value={draft.plateNo} maxLength={20} placeholder="ABC-1234" onChange={(e) => set({ plateNo: e.target.value })} />
          </Field>
          <Field label="車型" required htmlFor="vf-model">
            <Input id="vf-model" value={draft.model} maxLength={60} onChange={(e) => set({ model: e.target.value })} />
          </Field>
          <Field label="座位數" htmlFor="vf-seats">
            <Input id="vf-seats" inputMode="numeric" value={draft.seats} onChange={(e) => set({ seats: e.target.value })} />
          </Field>
          <Field label="狀態" htmlFor="vf-status">
            <Select id="vf-status" value={draft.status} onChange={(e) => set({ status: e.target.value as VehicleStatus })}>
              {(Object.keys(VEHICLE_STATUS_LABEL) as VehicleStatus[]).map((s) => (
                <option key={s} value={s}>
                  {VEHICLE_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="目前里程（km）" htmlFor="vf-odo">
            <Input id="vf-odo" inputMode="numeric" value={draft.currentOdometer} onChange={(e) => set({ currentOdometer: e.target.value })} />
          </Field>
        </div>
        {decreasing && (
          <Field label="里程調小的原因" required htmlFor="vf-odo-reason">
            <Input id="vf-odo-reason" value={draft.odometerReason} maxLength={200} onChange={(e) => set({ odometerReason: e.target.value })} />
          </Field>
        )}
        <fieldset className="space-y-3 rounded-xl border border-gray-200 p-3">
          <legend className="px-1 text-sm font-medium text-gray-700">保養</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label="間隔（公里）" htmlFor="vf-mkm">
              <Input id="vf-mkm" inputMode="numeric" value={draft.maintenanceIntervalKm} placeholder="5000" onChange={(e) => set({ maintenanceIntervalKm: e.target.value })} />
            </Field>
            <Field label="間隔（月）" htmlFor="vf-mmon">
              <Input id="vf-mmon" inputMode="numeric" value={draft.maintenanceIntervalMonths} placeholder="6" onChange={(e) => set({ maintenanceIntervalMonths: e.target.value })} />
            </Field>
            <Field label="上次保養日" htmlFor="vf-lmon">
              <Input id="vf-lmon" type="date" value={draft.lastMaintenanceOn} onChange={(e) => set({ lastMaintenanceOn: e.target.value })} />
            </Field>
            <Field label="上次保養里程" htmlFor="vf-lmodo">
              <Input id="vf-lmodo" inputMode="numeric" value={draft.lastMaintenanceOdometer} onChange={(e) => set({ lastMaintenanceOdometer: e.target.value })} />
            </Field>
            <Field label="下次保養日" htmlFor="vf-nmon" hint="留空＝依間隔自動推算">
              <Input id="vf-nmon" type="date" value={draft.nextMaintenanceOn} onChange={(e) => set({ nextMaintenanceOn: e.target.value })} />
            </Field>
            <Field label="下次保養里程" htmlFor="vf-nmodo">
              <Input id="vf-nmodo" inputMode="numeric" value={draft.nextMaintenanceOdometer} onChange={(e) => set({ nextMaintenanceOdometer: e.target.value })} />
            </Field>
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="保險到期日" htmlFor="vf-ins">
            <Input id="vf-ins" type="date" value={draft.insuranceExpiresOn} onChange={(e) => set({ insuranceExpiresOn: e.target.value })} />
          </Field>
          <Field label="牌照稅繳納期限" htmlFor="vf-tax">
            <Input id="vf-tax" type="date" value={draft.licenseTaxDueOn} onChange={(e) => set({ licenseTaxDueOn: e.target.value })} />
          </Field>
        </div>
        <Field label="備註" htmlFor="vf-note">
          <Textarea id="vf-note" value={draft.note} maxLength={1000} onChange={(e) => set({ note: e.target.value })} className="min-h-16" />
        </Field>
        {error && <InlineError>{error}</InlineError>}
        <Button type="submit" block size="lg" loading={busy}>
          {vehicle ? "儲存" : "新增"}
        </Button>
      </form>
    </BottomSheet>
  );
}

/** 車輛改成維修中／停用後，列出未來的 pending/approved 預約；HR 可逐筆「取消並通知」（理由必填）。 */
export function AffectedBookingsSheet({
  bookings,
  onClose,
  onCancelled,
}: {
  bookings: VehicleBooking[];
  onClose: () => void;
  onCancelled?: (booking: VehicleBooking) => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("車輛送修／停用，無法出車");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  async function cancel(b: VehicleBooking) {
    if (!reason.trim()) {
      toast.show("請填寫取消原因", "error");
      return;
    }
    setBusyId(b.id);
    try {
      const res = await cancelVehicleBooking(b.id, reason.trim());
      setDone((s) => new Set(s).add(b.id));
      onCancelled?.(res.booking);
      toast.show(`已取消 ${b.employeeName} 的預約並通知本人`, "success");
    } catch (err) {
      toast.show(vehicleErrorMessage(err, "取消失敗"), "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <BottomSheet open={bookings.length > 0} onClose={onClose} title={`有 ${bookings.length} 筆預約受影響`}>
      <p className="text-sm text-gray-600">系統不會自動取消。請逐筆決定是否取消並通知預約人（或請對方改預約其他車）。</p>
      <div className="mt-3">
        <Field label="取消原因（會通知預約人）" required htmlFor="ab-reason">
          <Input id="ab-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <ul className="mt-3 space-y-2">
        {bookings.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-100 p-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium text-gray-800">
                {b.employeeName} · {b.plateNo}
              </p>
              <p className="tabular-nums text-gray-500">
                {fmtDateTime(b.startAt)} → {fmtDateTime(b.endAt)}
              </p>
            </div>
            {done.has(b.id) ? (
              <Pill tone="gray">已取消</Pill>
            ) : (
              <div className="flex items-center gap-2">
                <Pill tone={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Pill>
                <Button size="sm" variant="danger" loading={busyId === b.id} disabled={busyId !== null} onClick={() => void cancel(b)}>
                  取消並通知
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Button className="mt-4" block variant="secondary" onClick={onClose}>
        完成
      </Button>
    </BottomSheet>
  );
}
