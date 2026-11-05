"use client";

/**
 * 後台公務車 · 用車紀錄 `/admin/vehicles/trips`：篩選車／人／日期／未還車；點列進明細（照片、費用與報銷狀態、更正）。
 * 「人」的篩選在前端做（API 沒有 employeeId 參數）。`?vehicleId=` 預選車輛。
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, EmptyState, Field, InlineError, Input, Pill, Select, Skeleton } from "@/components/admin-ui";
import { addDays, fmtDateTime, fmtMoney, todayKey } from "@/lib/ess-format";
import { fmtKm, localInputToIso, vehicleErrorMessage } from "@/lib/vehicle-view";
import { listVehicleTrips, listVehicles, type Vehicle, type VehicleTrip } from "@/lib/vehicles-api";

function TripsInner() {
  const search = useSearchParams();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState<string>(() => search?.get("vehicleId") ?? "");
  const [employeeId, setEmployeeId] = useState("");
  const [from, setFrom] = useState(() => addDays(todayKey(), -30));
  const [to, setTo] = useState(() => todayKey());
  const [openOnly, setOpenOnly] = useState(false);
  const [trips, setTrips] = useState<VehicleTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVehicles({ includeRetired: true })
      .then((r) => setVehicles(r.vehicles))
      .catch(() => setVehicles([]));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listVehicleTrips({
        scope: "all",
        ...(vehicleId ? { vehicleId } : {}),
        // 未還車：不限日期（逾時未還的舊單也要看到）。
        ...(openOnly ? { open: true } : { from: localInputToIso(`${from}T00:00`), to: localInputToIso(`${addDays(to, 1)}T00:00`) }),
      });
      setTrips(res.trips);
    } catch (err) {
      setTrips([]);
      setError(vehicleErrorMessage(err, "載入失敗"));
    }
  }, [vehicleId, from, to, openOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const people = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of trips ?? []) map.set(t.employeeId, t.employeeName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-Hant"));
  }, [trips]);

  const rows = useMemo(
    () => (trips ?? []).filter((t) => !employeeId || t.employeeId === employeeId).sort((a, b) => b.checkedOutAt.localeCompare(a.checkedOutAt)),
    [trips, employeeId],
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label="車輛" htmlFor="tp-vehicle">
            <Select id="tp-vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">全部</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plateNo} · {v.model}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="用車人" htmlFor="tp-emp">
            <Select id="tp-emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">全部</option>
              {people.map(([pid, name]) => (
                <option key={pid} value={pid}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="起" htmlFor="tp-from">
            <Input id="tp-from" type="date" value={from} disabled={openOnly} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="迄" htmlFor="tp-to">
            <Input id="tp-to" type="date" value={to} disabled={openOnly} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <label className="col-span-2 flex items-center gap-2 self-end pb-2 text-sm text-gray-700 sm:col-span-1">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
            只看未還車
          </label>
        </div>
      </Card>

      <Card>
        {error && <InlineError>{error}</InlineError>}
        {trips === null ? (
          <Skeleton lines={4} />
        ) : rows.length === 0 ? (
          <EmptyState title="沒有符合的用車紀錄" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2 pr-2">取車</th>
                  <th className="py-2 pr-2">還車</th>
                  <th className="py-2 pr-2">車輛</th>
                  <th className="py-2 pr-2">用車人</th>
                  <th className="py-2 pr-2 text-right">里程</th>
                  <th className="py-2 pr-2 text-right">費用</th>
                  <th className="py-2">車況</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const total = t.costs.reduce((s, c) => s + c.amount, 0);
                  return (
                    <tr key={t.id} className="border-b border-gray-100 align-top">
                      <td className="py-2 pr-2 tabular-nums">
                        <Link href={`/admin/vehicles/trips/${t.id}`} className="underline" style={{ color: "var(--brand)" }}>
                          {fmtDateTime(t.checkedOutAt)}
                        </Link>
                      </td>
                      <td className="py-2 pr-2 tabular-nums">{t.returnedAt ? fmtDateTime(t.returnedAt) : <Pill tone="amber">未還車</Pill>}</td>
                      <td className="py-2 pr-2">{t.plateNo}</td>
                      <td className="py-2 pr-2">{t.employeeName}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">
                        {t.returnedAt ? fmtKm(t.distanceKm) : "—"}
                        <div className="text-xs text-gray-400">
                          {t.startOdometer.toLocaleString("en-US")}–{t.endOdometer != null ? t.endOdometer.toLocaleString("en-US") : "?"}
                        </div>
                      </td>
                      <td className="py-2 pr-2 text-right">{t.costs.length ? fmtMoney(total) : "—"}</td>
                      <td className="py-2">
                        {t.conditionStatus === "issue" ? <Pill tone="red">有問題</Pill> : t.conditionStatus === "ok" ? <Pill tone="green">正常</Pill> : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AdminVehicleTripsPage() {
  return (
    <Suspense fallback={<Skeleton lines={4} />}>
      <TripsInner />
    </Suspense>
  );
}
