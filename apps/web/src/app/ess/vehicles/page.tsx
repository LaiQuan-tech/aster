"use client";

/**
 * 員工端公務車 `/ess/vehicles`（2026-11-05）。
 *   上：可預約的車（車牌、車型、座位、狀態）。
 *   中：時段檢視——選日期看每台車當天被佔用的時段（簽核中／已核准；業主拍板顯示預約者姓名，自己的標「我的」）。
 *   「預約」BottomSheet：車、起訖、用途（必填）、目的地、乘客數 → POST /requests（kind vehicle_booking，走既有簽核）；
 *     409 vehicle_booking_conflict 顯示衝突時段並刷新；成功顯示「等待 ○○○ 簽核」。
 *   下：我的預約（scope=mine），依伺服器的 canCheckout／canCancel 顯示「取車」「取消」；已取車的進用車紀錄頁還車。
 * 模組未開時 EssShell 直接顯示 GatePanel（lib/ess-tabs.ts isEssTabModuleEnabled），API 也會回 403 module_disabled。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BottomSheet,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  InlineError,
  Input,
  Pill,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ess-ui";
import { PhotoPicker } from "@/components/vehicle-ui";
import { addDays, fmtDateTime, fmtDateWithWeekday, fmtHm, todayKey } from "@/lib/ess-format";
import { approvalStepName } from "@/lib/request-forms";
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  VEHICLE_STATUS_LABEL,
  VEHICLE_STATUS_TONE,
  bookingActions,
  bookingRangeError,
  checkoutOdometerError,
  conflictSlotsOf,
  BOOKING_MAX_DAYS_AHEAD,
  bookingMaxInput,
  dateToLocalInput,
  fmtKm,
  localInputToIso,
  nextHalfHour,
  overlaps,
  vehicleErrorMessage,
} from "@/lib/vehicle-view";
import {
  cancelVehicleBooking,
  checkoutVehicle,
  createVehicleBooking,
  getAvailability,
  getVehicleSettings,
  listVehicleBookings,
  listVehicles,
  uploadTripPhoto,
  type BusySlot,
  type Vehicle,
  type VehicleBooking,
  type VehicleSettings,
} from "@/lib/vehicles-api";

function dayRangeIso(dateKey: string): { from: string; to: string } {
  return { from: localInputToIso(`${dateKey}T00:00`), to: localInputToIso(`${addDays(dateKey, 1)}T00:00`) };
}

function slotText(slot: Pick<BusySlot, "startAt" | "endAt">, dateKey: string): string {
  const s = fmtDateTime(slot.startAt);
  const e = fmtDateTime(slot.endAt);
  const sameDayStart = s.slice(0, 5) === fmtDateWithWeekday(dateKey).slice(0, 5);
  const sameDayEnd = e.slice(0, 5) === fmtDateWithWeekday(dateKey).slice(0, 5);
  return `${sameDayStart ? fmtHm(slot.startAt) : s}–${sameDayEnd ? fmtHm(slot.endAt) : e}`;
}

function bookingPeriod(b: Pick<VehicleBooking, "startAt" | "endAt">): string {
  const s = fmtDateTime(b.startAt);
  const e = fmtDateTime(b.endAt);
  return s.slice(0, 5) === e.slice(0, 5) ? `${s}–${e.slice(6)}` : `${s} → ${e}`;
}

export default function EssVehiclesPage() {
  const toast = useToast();
  const router = useRouter();

  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [settings, setSettings] = useState<VehicleSettings | null>(null);
  const [bookings, setBookings] = useState<VehicleBooking[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [day, setDay] = useState<string>(() => todayKey());
  const [slots, setSlots] = useState<BusySlot[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  // 預約表單
  const [bookOpen, setBookOpen] = useState(false);
  const [form, setForm] = useState({ vehicleId: "", start: "", end: "", purpose: "", destination: "", passengers: "", remark: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<BusySlot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [doneText, setDoneText] = useState<string | null>(null);

  // 取消
  const [cancelling, setCancelling] = useState<VehicleBooking | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  // 取車
  const [checkoutOf, setCheckoutOf] = useState<VehicleBooking | null>(null);
  const [co, setCo] = useState({ startOdometer: "", reason: "", note: "" });
  const [coPhotos, setCoPhotos] = useState<File[]>([]);
  const [coError, setCoError] = useState<string | null>(null);
  const [coBusy, setCoBusy] = useState(false);

  const loadBase = useCallback(async () => {
    setLoadError(null);
    try {
      const [v, s, b] = await Promise.all([
        listVehicles(),
        getVehicleSettings().catch(() => null),
        listVehicleBookings({ scope: "mine" }),
      ]);
      setVehicles(v.vehicles);
      setSettings(s?.settings ?? null);
      setBookings(b.bookings);
    } catch (err) {
      setLoadError(vehicleErrorMessage(err, "載入失敗"));
      setVehicles((prev) => prev ?? []);
      setBookings((prev) => prev ?? []);
    }
  }, []);

  const loadSlots = useCallback(async (dateKey: string) => {
    setSlotsError(null);
    try {
      const res = await getAvailability(dayRangeIso(dateKey));
      setSlots(res.slots);
    } catch (err) {
      setSlots([]);
      setSlotsError(vehicleErrorMessage(err, "載入時段失敗"));
    }
  }, []);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  useEffect(() => {
    void loadSlots(day);
  }, [day, loadSlots]);

  const bookable = useMemo(() => (vehicles ?? []).filter((v) => v.status === "available"), [vehicles]);
  const vehicleById = useMemo(() => new Map((vehicles ?? []).map((v) => [v.id, v] as const)), [vehicles]);

  // 依開始時間排：進行中／未來在前（取車、還車要先看到），結束的在後。
  const sortedBookings = useMemo(() => {
    const list = [...(bookings ?? [])];
    const active = (b: VehicleBooking) => b.status === "pending" || b.status === "approved";
    list.sort((a, b) => {
      if (active(a) !== active(b)) return active(a) ? -1 : 1;
      return active(a) ? a.startAt.localeCompare(b.startAt) : b.startAt.localeCompare(a.startAt);
    });
    return list;
  }, [bookings]);

  function openBook(vehicleId?: string) {
    const start = nextHalfHour();
    const end = new Date(start.getTime() + 2 * 3_600_000);
    setForm({
      vehicleId: vehicleId ?? bookable[0]?.id ?? "",
      start: dateToLocalInput(start),
      end: dateToLocalInput(end),
      purpose: "",
      destination: "",
      passengers: "",
      remark: "",
    });
    setFormError(null);
    setConflicts([]);
    setDoneText(null);
    setBookOpen(true);
  }

  async function submitBooking() {
    setFormError(null);
    setConflicts([]);
    if (!form.vehicleId) return setFormError("請選擇車輛");
    const startIso = localInputToIso(form.start);
    const endIso = localInputToIso(form.end);
    const rangeErr = bookingRangeError(startIso, endIso, settings?.maxBookingHours, { maxDaysAhead });
    if (rangeErr) return setFormError(rangeErr);
    if (!form.purpose.trim()) return setFormError("請填寫用途");
    // API：passengers 為 1–60 的整數（省略＝沒填）；填 0 視同沒填。
    const paxRaw = form.passengers.trim() ? Number(form.passengers) : undefined;
    if (paxRaw !== undefined && (!Number.isInteger(paxRaw) || paxRaw < 0 || paxRaw > 60)) return setFormError("乘客數請填 0–60 的整數");
    const passengers = paxRaw ? paxRaw : undefined;
    // 前端預檢（當天時段有載入時）；最終以 API 409 為準。
    const local = overlaps(slots ?? [], startIso, endIso, { vehicleId: form.vehicleId });
    if (local.length > 0) {
      setConflicts(local);
      return setFormError("這個時段已經有人預約了，請改選其他時段或車輛");
    }
    setSubmitting(true);
    try {
      const res = await createVehicleBooking({
        vehicleId: form.vehicleId,
        startAt: startIso,
        endAt: endIso,
        reason: form.purpose.trim(),
        ...(form.destination.trim() ? { location: form.destination.trim() } : {}),
        ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
        ...(passengers !== undefined ? { passengers } : {}),
      });
      const first = res.steps?.[0];
      const name = first ? approvalStepName(first) : "";
      setDoneText(name ? `已送出，等待 ${name} 簽核` : "已送出，等待簽核");
      toast.show("預約已送出", "success");
      void loadBase();
      void loadSlots(day);
    } catch (err) {
      const c = conflictSlotsOf(err);
      if (c.length > 0) {
        setConflicts(c);
        void loadSlots(day);
      }
      setFormError(vehicleErrorMessage(err, "預約失敗"));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await cancelVehicleBooking(cancelling.id);
      toast.show("已取消預約", "success");
      setCancelling(null);
      void loadBase();
      void loadSlots(day);
    } catch (err) {
      toast.show(vehicleErrorMessage(err, "取消失敗"), "error");
    } finally {
      setCancelBusy(false);
    }
  }

  function openCheckout(b: VehicleBooking) {
    const v = vehicleById.get(b.vehicleId);
    setCo({ startOdometer: v ? String(v.currentOdometer) : "", reason: "", note: "" });
    setCoPhotos([]);
    setCoError(null);
    setCheckoutOf(b);
  }

  const coVehicle = checkoutOf ? vehicleById.get(checkoutOf.vehicleId) : undefined;
  const coBelow = coVehicle && co.startOdometer.trim() !== "" && Number(co.startOdometer) < coVehicle.currentOdometer;

  async function submitCheckout() {
    if (!checkoutOf) return;
    setCoError(null);
    const err = checkoutOdometerError({
      startOdometer: co.startOdometer,
      currentOdometer: coVehicle?.currentOdometer ?? 0,
      overrideReason: co.reason,
    });
    if (err) return setCoError(err);
    setCoBusy(true);
    try {
      const { trip } = await checkoutVehicle(checkoutOf.id, {
        startOdometer: Number(co.startOdometer),
        ...(coBelow && co.reason.trim() ? { odometerOverrideReason: co.reason.trim() } : {}),
        ...(co.note.trim() ? { note: co.note.trim() } : {}),
      });
      // 取車已成立；照片逐張上傳，失敗不回滾（到用車紀錄頁可補傳）。
      let failed = 0;
      for (const file of coPhotos) {
        try {
          await uploadTripPhoto(trip.id, "checkout", file);
        } catch (e) {
          failed += 1;
          toast.show(`${file.name}：${vehicleErrorMessage(e, "照片上傳失敗")}`, "error");
        }
      }
      toast.show(failed ? `已取車；${failed} 張照片沒傳成功，可在紀錄頁補傳` : "已取車，行車平安", failed ? "info" : "success");
      setCheckoutOf(null);
      router.push(`/ess/vehicles/trips/${trip.id}`);
    } catch (e) {
      setCoError(vehicleErrorMessage(e, "取車失敗"));
    } finally {
      setCoBusy(false);
    }
  }

  const slotsByVehicle = useMemo(() => {
    const map = new Map<string, BusySlot[]>();
    for (const s of slots ?? []) {
      const list = map.get(s.vehicleId) ?? [];
      list.push(s);
      map.set(s.vehicleId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return map;
  }, [slots]);

  const loading = vehicles === null || bookings === null;
  // 可預約天數：讀公務車設定（1–365），讀不到用 90。
  const maxDaysAhead = settings?.maxDaysAhead && settings.maxDaysAhead > 0 ? settings.maxDaysAhead : BOOKING_MAX_DAYS_AHEAD;

  return (
    <div className="space-y-4">
      {loadError && <InlineError>{loadError}</InlineError>}

      <Card
        title="公務車"
        action={
          <Button size="sm" onClick={() => openBook()} disabled={bookable.length === 0}>
            預約用車
          </Button>
        }
      >
        {loading ? (
          <Skeleton lines={2} />
        ) : (vehicles ?? []).length === 0 ? (
          <EmptyState title="目前沒有登記公務車" hint="請洽 HR 在後台新增車輛" />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {(vehicles ?? []).map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 p-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-gray-900">{v.plateNo}</p>
                  <p className="truncate text-sm text-gray-500">
                    {v.model}
                    {v.seats ? ` · ${v.seats} 人座` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Pill tone={VEHICLE_STATUS_TONE[v.status]}>{VEHICLE_STATUS_LABEL[v.status]}</Pill>
                  {v.status === "available" && (
                    <button type="button" className="text-sm font-medium underline" style={{ color: "var(--brand)" }} onClick={() => openBook(v.id)}>
                      預約
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="預約時段">
        <div className="mb-3 flex items-center gap-2">
          <Button variant="secondary" size="sm" aria-label="前一天" onClick={() => setDay((d) => addDays(d, -1))}>
            ‹
          </Button>
          <Input type="date" aria-label="查看日期" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="flex-1" />
          <Button variant="secondary" size="sm" aria-label="後一天" onClick={() => setDay((d) => addDays(d, 1))}>
            ›
          </Button>
        </div>
        <p className="mb-2 text-sm text-gray-500">{fmtDateWithWeekday(day)} 已被預約的時段（含簽核中）</p>
        {slotsError && <InlineError>{slotsError}</InlineError>}
        {slots === null ? (
          <Skeleton lines={2} />
        ) : bookable.length === 0 && slots.length === 0 ? (
          <p className="text-sm text-gray-400">沒有可預約的車。</p>
        ) : (
          <ul className="space-y-3">
            {(vehicles ?? [])
              .filter((v) => v.status !== "retired")
              .map((v) => {
                const list = slotsByVehicle.get(v.id) ?? [];
                return (
                  <li key={v.id}>
                    <p className="text-sm font-medium text-gray-800">
                      {v.plateNo} <span className="font-normal text-gray-500">{v.model}</span>
                    </p>
                    {list.length === 0 ? (
                      <p className="mt-1 text-sm text-green-700">整天都可預約</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {list.map((s) => (
                          <li key={s.bookingId} className="flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 px-2.5 py-1.5 text-sm">
                            <span className="font-medium tabular-nums text-gray-800">{slotText(s, day)}</span>
                            <span className="text-gray-600">{s.employeeName}</span>
                            {s.mine && <Pill tone="brand">我的</Pill>}
                            <Pill tone={s.status === "approved" ? "green" : "amber"}>{BOOKING_STATUS_LABEL[s.status]}</Pill>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </Card>

      <Card title="我的預約">
        {loading ? (
          <Skeleton lines={3} />
        ) : sortedBookings.length === 0 ? (
          <EmptyState title="還沒有預約" hint="按上方「預約用車」送出，主管核准後即可取車" />
        ) : (
          <ul className="space-y-2">
            {sortedBookings.map((b) => {
              const actions = bookingActions(b);
              return (
                <li key={b.id} className="rounded-xl border border-gray-100 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900">
                        {b.plateNo} <span className="font-normal text-gray-500">{b.model}</span>
                      </p>
                      <p className="mt-0.5 text-sm tabular-nums text-gray-700">{bookingPeriod(b)}</p>
                      <p className="mt-0.5 break-words text-sm text-gray-500">
                        {b.purpose}
                        {b.destination ? ` · ${b.destination}` : ""}
                      </p>
                      {b.cancelReason && <p className="mt-0.5 text-xs text-gray-400">取消原因：{b.cancelReason}</p>}
                    </div>
                    <Pill tone={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Pill>
                  </div>
                  {(actions.checkout || actions.cancel || actions.openTrip || actions.waiting) && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {actions.checkout && (
                        <Button size="sm" onClick={() => openCheckout(b)}>
                          取車
                        </Button>
                      )}
                      {actions.openTrip && b.tripId && (
                        <Link
                          href={`/ess/vehicles/trips/${b.tripId}`}
                          className="inline-flex min-h-9 items-center rounded-xl border border-gray-300 px-3 text-sm font-medium text-gray-700"
                        >
                          {b.status === "completed" ? "用車紀錄" : "還車／用車紀錄"}
                        </Link>
                      )}
                      {actions.waiting && <span className="text-xs text-gray-500">開始前才可取車</span>}
                      {actions.cancel && (
                        <Button size="sm" variant="ghost" onClick={() => setCancelling(b)}>
                          取消預約
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* 預約 */}
      <BottomSheet open={bookOpen} onClose={() => !submitting && setBookOpen(false)} title="預約公務車">
        {doneText ? (
          <div className="space-y-4 py-2">
            <p className="text-base text-gray-800">{doneText}</p>
            <p className="text-sm text-gray-500">核准後會通知你，屆時在「我的預約」按「取車」。</p>
            <Button block size="lg" onClick={() => setBookOpen(false)}>
              好
            </Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitBooking();
            }}
          >
            <Field label="車輛" required htmlFor="vb-vehicle">
              <Select id="vb-vehicle" value={form.vehicleId} onChange={(e) => setForm({ ...form, vehicleId: e.target.value })}>
                {bookable.length === 0 && <option value="">（沒有可預約的車）</option>}
                {bookable.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.plateNo} · {v.model}
                    {v.seats ? `（${v.seats} 人座）` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="開始" required htmlFor="vb-start">
                <Input id="vb-start" type="datetime-local" min={dateToLocalInput(new Date())} max={bookingMaxInput(new Date(), maxDaysAhead)} value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
              </Field>
              <Field label="結束" required htmlFor="vb-end" hint={settings?.maxBookingHours ? `單次最長 ${settings.maxBookingHours} 小時` : undefined}>
                <Input id="vb-end" type="datetime-local" min={form.start || undefined} value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
              </Field>
            </div>
            <Field label="用途" required htmlFor="vb-purpose">
              <Input id="vb-purpose" value={form.purpose} maxLength={250} placeholder="例：拜訪客戶、送件" onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
            </Field>
            <Field label="目的地" htmlFor="vb-dest">
              <Input id="vb-dest" value={form.destination} maxLength={250} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
            </Field>
            <Field label="乘客數（不含駕駛）" htmlFor="vb-pax">
              <Input id="vb-pax" inputMode="numeric" value={form.passengers} onChange={(e) => setForm({ ...form, passengers: e.target.value })} />
            </Field>
            <Field label="備註" htmlFor="vb-remark">
              <Textarea id="vb-remark" value={form.remark} maxLength={250} onChange={(e) => setForm({ ...form, remark: e.target.value })} className="min-h-16" />
            </Field>
            {formError && <InlineError>{formError}</InlineError>}
            {conflicts.length > 0 && (
              <ul className="space-y-1 rounded-xl bg-red-50 p-2.5 text-sm text-red-800">
                {conflicts.map((c) => (
                  <li key={c.bookingId}>
                    {bookingPeriod(c)} · {c.mine ? "你" : c.employeeName}（{BOOKING_STATUS_LABEL[c.status]}）
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-gray-500">送出後走簽核流程（預設直屬主管），核准前時段即保留給你。</p>
            <Button type="submit" block size="lg" loading={submitting} disabled={bookable.length === 0}>
              送出預約
            </Button>
          </form>
        )}
      </BottomSheet>

      {/* 取車 */}
      <BottomSheet open={!!checkoutOf} onClose={() => !coBusy && setCheckoutOf(null)} title="取車">
        {checkoutOf && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCheckout();
            }}
          >
            <p className="text-sm text-gray-700">
              {checkoutOf.plateNo} · {checkoutOf.model} · {bookingPeriod(checkoutOf)}
            </p>
            <Field
              label="出車里程（km）"
              required
              htmlFor="co-odo"
              hint={coVehicle ? `車輛目前里程 ${fmtKm(coVehicle.currentOdometer)}，請以儀表板為準` : undefined}
            >
              <Input id="co-odo" inputMode="numeric" value={co.startOdometer} onChange={(e) => setCo({ ...co, startOdometer: e.target.value })} />
            </Field>
            {coBelow && (
              <Field label="低於目前里程的原因" required htmlFor="co-reason">
                <Input id="co-reason" value={co.reason} maxLength={200} onChange={(e) => setCo({ ...co, reason: e.target.value })} />
              </Field>
            )}
            <Field label="備註" htmlFor="co-note">
              <Input id="co-note" value={co.note} maxLength={500} onChange={(e) => setCo({ ...co, note: e.target.value })} />
            </Field>
            <Field label="出車車況照片（選填）">
              <PhotoPicker files={coPhotos} onChange={setCoPhotos} onError={(m) => toast.show(m, "error")} disabled={coBusy} label="拍照／選照片" />
            </Field>
            {coError && <InlineError>{coError}</InlineError>}
            <Button type="submit" block size="lg" loading={coBusy}>
              確認取車
            </Button>
          </form>
        )}
      </BottomSheet>

      <ConfirmDialog
        open={!!cancelling}
        title="取消這筆預約？"
        message={cancelling ? `${cancelling.plateNo} · ${bookingPeriod(cancelling)}\n取消後時段會釋出給其他人。` : undefined}
        confirmLabel="取消預約"
        danger
        busy={cancelBusy}
        onConfirm={() => void confirmCancel()}
        onCancel={() => setCancelling(null)}
      />
    </div>
  );
}
