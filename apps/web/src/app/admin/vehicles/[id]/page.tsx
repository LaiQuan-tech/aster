"use client";

/**
 * 後台車輛資料 `/admin/vehicles/[id]`：車輛資料（含保養／保險／牌照稅）編輯、保養紀錄＋「登記保養」、
 * 該車近期預約與用車紀錄。改成維修中／停用時列出受影響的預約（AffectedBookingsSheet）。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  BottomSheet,
  Button,
  Card,
  DetailHeading,
  EmptyState,
  Field,
  InlineError,
  Input,
  Pill,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/admin-ui";
import { fmtDateTime, fmtMoney, todayKey } from "@/lib/ess-format";
import {
  BOOKING_STATUS_LABEL,
  BOOKING_STATUS_TONE,
  VEHICLE_STATUS_LABEL,
  VEHICLE_STATUS_TONE,
  alertText,
  alertTone,
  fmtKm,
  vehicleErrorMessage,
} from "@/lib/vehicle-view";
import {
  getVehicle,
  listMaintenance,
  listVehicleBookings,
  listVehicleTrips,
  recordMaintenance,
  type MaintenanceLog,
  type Vehicle,
  type VehicleBooking,
  type VehicleTrip,
} from "@/lib/vehicles-api";
import { AffectedBookingsSheet, VehicleFormSheet } from "../_components";

export default function AdminVehicleDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
  const toast = useToast();

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [logs, setLogs] = useState<MaintenanceLog[] | null>(null);
  const [bookings, setBookings] = useState<VehicleBooking[] | null>(null);
  const [trips, setTrips] = useState<VehicleTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [affected, setAffected] = useState<VehicleBooking[]>([]);

  const [mOpen, setMOpen] = useState(false);
  const [m, setM] = useState({ servicedOn: todayKey(), odometer: "", cost: "", note: "" });
  const [mError, setMError] = useState<string | null>(null);
  const [mBusy, setMBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
      const [v, l, b, t] = await Promise.all([
        getVehicle(id),
        listMaintenance(id).catch(() => ({ logs: [] as MaintenanceLog[] })),
        listVehicleBookings({ scope: "all", vehicleId: id, from }).catch(() => ({ bookings: [] as VehicleBooking[] })),
        listVehicleTrips({ scope: "all", vehicleId: id, from }).catch(() => ({ trips: [] as VehicleTrip[] })),
      ]);
      setVehicle(v.vehicle);
      setLogs(l.logs);
      setBookings(b.bookings);
      setTrips(t.trips);
    } catch (err) {
      setError(vehicleErrorMessage(err, "載入失敗"));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveMaintenance() {
    if (!vehicle) return;
    setMError(null);
    const odometer = Number(m.odometer.replace(/,/g, ""));
    if (!m.servicedOn) return setMError("請填保養日期");
    if (!m.odometer.trim() || !Number.isInteger(odometer) || odometer < 0) return setMError("保養里程請填整數公里");
    const cost = m.cost.trim() ? Number(m.cost.replace(/,/g, "")) : undefined;
    if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) return setMError("費用請填數字");
    setMBusy(true);
    try {
      const res = await recordMaintenance(vehicle.id, {
        servicedOn: m.servicedOn,
        odometer,
        ...(cost !== undefined ? { cost } : {}),
        ...(m.note.trim() ? { note: m.note.trim() } : {}),
      });
      setVehicle(res.vehicle);
      setLogs((prev) => [res.log, ...(prev ?? [])]);
      setMOpen(false);
      toast.show("已登記保養，下次保養已重算", "success");
    } catch (err) {
      setMError(vehicleErrorMessage(err, "登記失敗"));
    } finally {
      setMBusy(false);
    }
  }

  if (error) return <InlineError>{error}</InlineError>;
  if (!vehicle) return <Skeleton lines={6} />;

  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-gray-400">{label}</dt>
      <dd>{value}</dd>
    </>
  );

  return (
    <div className="space-y-4">
      <DetailHeading title={`${vehicle.plateNo} · ${vehicle.model}`} desc={vehicle.note ?? undefined}>
        <Pill tone={VEHICLE_STATUS_TONE[vehicle.status]}>{VEHICLE_STATUS_LABEL[vehicle.status]}</Pill>
        <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
          編輯
        </Button>
      </DetailHeading>

      {vehicle.alerts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {vehicle.alerts.map((a, i) => (
            <Pill key={`${a.kind}-${i}`} tone={alertTone(a)}>
              {alertText(a)}
            </Pill>
          ))}
        </div>
      )}

      <Card title="車輛資料">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm text-gray-700 sm:grid-cols-[7rem_1fr_7rem_1fr]">
          {row("座位數", vehicle.seats ? `${vehicle.seats} 人` : "—")}
          {row("目前里程", fmtKm(vehicle.currentOdometer))}
          {row("保養間隔", [vehicle.maintenanceIntervalKm ? fmtKm(vehicle.maintenanceIntervalKm) : null, vehicle.maintenanceIntervalMonths ? `${vehicle.maintenanceIntervalMonths} 個月` : null].filter(Boolean).join(" / ") || "—")}
          {row("上次保養", [vehicle.lastMaintenanceOn, vehicle.lastMaintenanceOdometer != null ? fmtKm(vehicle.lastMaintenanceOdometer) : null].filter(Boolean).join(" · ") || "—")}
          {row("下次保養", [vehicle.nextMaintenanceOn, vehicle.nextMaintenanceOdometer != null ? fmtKm(vehicle.nextMaintenanceOdometer) : null].filter(Boolean).join(" · ") || "—")}
          {row("保險到期", vehicle.insuranceExpiresOn ?? "—")}
          {row("牌照稅", vehicle.licenseTaxDueOn ?? "—")}
        </dl>
      </Card>

      <Card
        title="保養紀錄"
        action={
          <Button
            size="sm"
            onClick={() => {
              setM({ servicedOn: todayKey(), odometer: String(vehicle.currentOdometer), cost: "", note: "" });
              setMError(null);
              setMOpen(true);
            }}
          >
            登記保養
          </Button>
        }
      >
        {logs === null ? (
          <Skeleton lines={2} />
        ) : logs.length === 0 ? (
          <EmptyState title="還沒有保養紀錄" />
        ) : (
          <ul className="divide-y divide-gray-100">
            {logs.map((l) => (
              <li key={l.id} className="py-2 text-sm">
                <p className="font-medium text-gray-800">
                  {l.servicedOn} · {fmtKm(l.odometer)}
                  {l.cost != null && <span className="font-normal text-gray-500"> · {fmtMoney(l.cost)}</span>}
                </p>
                <p className="text-xs text-gray-500">
                  {[l.note, l.createdByName ? `登記：${l.createdByName}` : null].filter(Boolean).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="近 90 天預約" action={<Link href={`/admin/vehicles/bookings?vehicleId=${vehicle.id}`} className="underline">全部</Link>}>
        {bookings === null ? (
          <Skeleton lines={2} />
        ) : bookings.length === 0 ? (
          <p className="text-sm text-gray-400">沒有預約。</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {bookings.slice(0, 20).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="tabular-nums">{fmtDateTime(b.startAt)} → {fmtDateTime(b.endAt)}</span>
                  <span className="text-gray-500"> · {b.employeeName} · {b.purpose}</span>
                </span>
                <Pill tone={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="近 90 天用車紀錄" action={<Link href={`/admin/vehicles/trips?vehicleId=${vehicle.id}`} className="underline">全部</Link>}>
        {trips === null ? (
          <Skeleton lines={2} />
        ) : trips.length === 0 ? (
          <p className="text-sm text-gray-400">沒有用車紀錄。</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {trips.slice(0, 20).map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/admin/vehicles/trips/${t.id}`} className="min-w-0 underline-offset-2 hover:underline">
                  <span className="tabular-nums">{fmtDateTime(t.checkedOutAt)}</span>
                  <span className="text-gray-500"> · {t.employeeName} · {t.returnedAt ? fmtKm(t.distanceKm) : "使用中"}</span>
                </Link>
                {t.conditionStatus === "issue" && <Pill tone="red">車況有問題</Pill>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <VehicleFormSheet
        open={editOpen}
        vehicle={vehicle}
        onClose={() => setEditOpen(false)}
        onSaved={(v, aff) => {
          setEditOpen(false);
          setVehicle(v);
          setAffected(aff);
          toast.show("已儲存", "success");
        }}
      />
      <AffectedBookingsSheet bookings={affected} onClose={() => { setAffected([]); void load(); }} />

      <BottomSheet open={mOpen} onClose={() => !mBusy && setMOpen(false)} title={`登記保養 · ${vehicle.plateNo}`}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveMaintenance();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="保養日期" required htmlFor="mt-date">
              <Input id="mt-date" type="date" value={m.servicedOn} onChange={(e) => setM({ ...m, servicedOn: e.target.value })} />
            </Field>
            <Field label="保養里程（km）" required htmlFor="mt-odo">
              <Input id="mt-odo" inputMode="numeric" value={m.odometer} onChange={(e) => setM({ ...m, odometer: e.target.value })} />
            </Field>
            <Field label="費用（元）" htmlFor="mt-cost">
              <Input id="mt-cost" inputMode="decimal" value={m.cost} onChange={(e) => setM({ ...m, cost: e.target.value })} />
            </Field>
          </div>
          <Field label="內容／備註" htmlFor="mt-note">
            <Textarea id="mt-note" value={m.note} maxLength={500} onChange={(e) => setM({ ...m, note: e.target.value })} className="min-h-16" />
          </Field>
          <p className="text-xs text-gray-500">儲存後依保養間隔重算下次保養日／里程；里程大於目前里程時一併更新。</p>
          {mError && <InlineError>{mError}</InlineError>}
          <Button type="submit" block size="lg" loading={mBusy}>
            儲存
          </Button>
        </form>
      </BottomSheet>
    </div>
  );
}
