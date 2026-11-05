"use client";

/**
 * 後台公務車 · 預約總覽 `/admin/vehicles/bookings`：全公司預約（scope=all），篩選車／狀態／日期；
 * HR 可代為取消（理由必填，API 會通知本人）。簽核本身仍在「假單與簽核」（種類篩「公務車預約」）。
 * `?vehicleId=` 預選車輛（車輛資料頁的「全部」連結）。
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BottomSheet, Button, Card, EmptyState, Field, InlineError, Input, Pill, Select, Skeleton, useToast } from "@/components/admin-ui";
import { addDays, fmtDateTime, todayKey } from "@/lib/ess-format";
import { BOOKING_STATUS_LABEL, BOOKING_STATUS_TONE, localInputToIso, vehicleErrorMessage } from "@/lib/vehicle-view";
import {
  cancelVehicleBooking,
  listVehicleBookings,
  listVehicles,
  type BookingStatus,
  type Vehicle,
  type VehicleBooking,
} from "@/lib/vehicles-api";

const STATUSES: BookingStatus[] = ["pending", "approved", "completed", "rejected", "cancelled"];

function BookingsInner() {
  const search = useSearchParams();
  const toast = useToast();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState<string>(() => search?.get("vehicleId") ?? "");
  const [status, setStatus] = useState<"" | BookingStatus>("");
  const [from, setFrom] = useState(() => addDays(todayKey(), -7));
  const [to, setTo] = useState(() => addDays(todayKey(), 30));
  const [bookings, setBookings] = useState<VehicleBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [cancelling, setCancelling] = useState<VehicleBooking | null>(null);
  const [reason, setReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listVehicles({ includeRetired: true })
      .then((r) => setVehicles(r.vehicles))
      .catch(() => setVehicles([]));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listVehicleBookings({
        scope: "all",
        ...(vehicleId ? { vehicleId } : {}),
        ...(status ? { status } : {}),
        ...(from ? { from: localInputToIso(`${from}T00:00`) } : {}),
        ...(to ? { to: localInputToIso(`${addDays(to, 1)}T00:00`) } : {}),
      });
      setBookings(res.bookings);
    } catch (err) {
      setBookings([]);
      setError(vehicleErrorMessage(err, "載入失敗"));
    }
  }, [vehicleId, status, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => [...(bookings ?? [])].sort((a, b) => a.startAt.localeCompare(b.startAt)), [bookings]);

  async function confirmCancel() {
    if (!cancelling) return;
    if (!reason.trim()) return setCancelError("請填寫取消原因（會通知預約人）");
    setBusy(true);
    setCancelError(null);
    try {
      await cancelVehicleBooking(cancelling.id, reason.trim());
      toast.show(`已取消 ${cancelling.employeeName} 的預約並通知本人`, "success");
      setCancelling(null);
      void load();
    } catch (err) {
      setCancelError(vehicleErrorMessage(err, "取消失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="車輛" htmlFor="bk-vehicle">
            <Select id="bk-vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">全部</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plateNo} · {v.model}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="狀態" htmlFor="bk-status">
            <Select id="bk-status" value={status} onChange={(e) => setStatus(e.target.value as "" | BookingStatus)}>
              <option value="">全部</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {BOOKING_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="起" htmlFor="bk-from">
            <Input id="bk-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="迄" htmlFor="bk-to">
            <Input id="bk-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          簽核在「
          <Link href="/admin/approvals" className="underline">
            假單與簽核
          </Link>
          」（種類選「公務車預約」）。
        </p>
      </Card>

      <Card>
        {error && <InlineError>{error}</InlineError>}
        {bookings === null ? (
          <Skeleton lines={4} />
        ) : sorted.length === 0 ? (
          <EmptyState title="這段期間沒有預約" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2 pr-2">時段</th>
                  <th className="py-2 pr-2">車輛</th>
                  <th className="py-2 pr-2">預約人</th>
                  <th className="py-2 pr-2">用途／目的地</th>
                  <th className="py-2 pr-2">狀態</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => (
                  <tr key={b.id} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-2 tabular-nums">
                      {fmtDateTime(b.startAt)}
                      <div className="text-xs text-gray-500">→ {fmtDateTime(b.endAt)}</div>
                    </td>
                    <td className="py-2 pr-2">
                      {b.plateNo}
                      <div className="text-xs text-gray-500">{b.model}</div>
                    </td>
                    <td className="py-2 pr-2">
                      {b.employeeName}
                      {b.passengers ? <div className="text-xs text-gray-500">乘客 {b.passengers} 人</div> : null}
                    </td>
                    <td className="py-2 pr-2 text-xs">
                      {b.purpose}
                      {b.destination && <div className="text-gray-500">{b.destination}</div>}
                      {b.cancelReason && <div className="text-gray-400">取消：{b.cancelReason}</div>}
                    </td>
                    <td className="py-2 pr-2">
                      <Pill tone={BOOKING_STATUS_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</Pill>
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex justify-end gap-2">
                        {b.tripId && (
                          <Link href={`/admin/vehicles/trips/${b.tripId}`} className="text-xs underline">
                            用車紀錄
                          </Link>
                        )}
                        {(b.status === "pending" || b.status === "approved") && !b.tripId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setReason("");
                              setCancelError(null);
                              setCancelling(b);
                            }}
                          >
                            取消
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <BottomSheet open={!!cancelling} onClose={() => !busy && setCancelling(null)} title="代為取消預約">
        {cancelling && (
          <div className="space-y-3">
            <p className="text-sm text-gray-700">
              {cancelling.employeeName} · {cancelling.plateNo} · {fmtDateTime(cancelling.startAt)} → {fmtDateTime(cancelling.endAt)}
            </p>
            <Field label="取消原因（會通知預約人）" required htmlFor="bk-reason">
              <Input id="bk-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </Field>
            {cancelError && <InlineError>{cancelError}</InlineError>}
            <Button block size="lg" variant="danger" loading={busy} onClick={() => void confirmCancel()}>
              取消並通知
            </Button>
          </div>
        )}
      </BottomSheet>
    </div>
  );
}

export default function AdminVehicleBookingsPage() {
  return (
    <Suspense fallback={<Skeleton lines={4} />}>
      <BookingsInner />
    </Suspense>
  );
}
