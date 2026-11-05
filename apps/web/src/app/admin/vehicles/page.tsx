"use client";

/**
 * 後台公務車 · 車輛 `/admin/vehicles`（2026-11-05）：車輛表（車牌、車型、狀態、目前里程、下次保養、保險到期、牌照稅、
 * 到期提醒 紅＝已過期／黃＝將到期）＋新增。改狀態成維修中／停用若回 affectedBookings → 列出受影響預約（不自動取消）。
 * 手機寬度：表格包在 overflow-x-auto 裡橫捲，卡片不撐破。
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, InlineError, Pill, Skeleton, useToast } from "@/components/admin-ui";
import { VEHICLE_STATUS_LABEL, VEHICLE_STATUS_TONE, alertText, alertTone, fmtKm, vehicleErrorMessage } from "@/lib/vehicle-view";
import { listVehicles, type Vehicle, type VehicleBooking } from "@/lib/vehicles-api";
import { AffectedBookingsSheet, VehicleFormSheet } from "./_components";

export default function AdminVehiclesPage() {
  const toast = useToast();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [includeRetired, setIncludeRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [affected, setAffected] = useState<VehicleBooking[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listVehicles({ includeRetired });
      setVehicles(res.vehicles);
    } catch (err) {
      setVehicles([]);
      setError(vehicleErrorMessage(err, "載入失敗"));
    }
  }, [includeRetired]);

  useEffect(() => {
    void load();
  }, [load]);

  const alertCount = (vehicles ?? []).reduce((n, v) => n + v.alerts.length, 0);

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-gray-600">
            共 {vehicles?.length ?? 0} 台{alertCount > 0 && <span className="ml-2 text-red-600">· {alertCount} 項到期提醒</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-gray-600">
              <input type="checkbox" checked={includeRetired} onChange={(e) => setIncludeRetired(e.target.checked)} />
              含已停用
            </label>
            <Button size="sm" onClick={() => setFormOpen(true)}>
              ＋ 新增車輛
            </Button>
          </div>
        </div>
        {error && <InlineError>{error}</InlineError>}
        {vehicles === null ? (
          <Skeleton lines={4} />
        ) : vehicles.length === 0 ? (
          <EmptyState title="還沒有車輛" hint="按「新增車輛」登記第一台公務車" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2 pr-2">車牌</th>
                  <th className="py-2 pr-2">車型</th>
                  <th className="py-2 pr-2">狀態</th>
                  <th className="py-2 pr-2 text-right">目前里程</th>
                  <th className="py-2 pr-2">下次保養</th>
                  <th className="py-2 pr-2">保險到期</th>
                  <th className="py-2 pr-2">牌照稅</th>
                  <th className="py-2">提醒</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-2 font-medium">
                      <Link href={`/admin/vehicles/${v.id}`} className="underline" style={{ color: "var(--brand)" }}>
                        {v.plateNo}
                      </Link>
                    </td>
                    <td className="py-2 pr-2">
                      {v.model}
                      {v.seats ? <span className="text-xs text-gray-400"> · {v.seats} 人座</span> : null}
                    </td>
                    <td className="py-2 pr-2">
                      <Pill tone={VEHICLE_STATUS_TONE[v.status]}>{VEHICLE_STATUS_LABEL[v.status]}</Pill>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{fmtKm(v.currentOdometer)}</td>
                    <td className="py-2 pr-2 text-xs">
                      {v.nextMaintenanceOn ?? "—"}
                      {v.nextMaintenanceOdometer != null && <div className="text-gray-500">{fmtKm(v.nextMaintenanceOdometer)}</div>}
                    </td>
                    <td className="py-2 pr-2 text-xs">{v.insuranceExpiresOn ?? "—"}</td>
                    <td className="py-2 pr-2 text-xs">{v.licenseTaxDueOn ?? "—"}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {v.alerts.length === 0 ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : (
                          v.alerts.map((a, i) => (
                            <Pill key={`${a.kind}-${i}`} tone={alertTone(a)}>
                              {alertText(a)}
                            </Pill>
                          ))
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

      <VehicleFormSheet
        open={formOpen}
        vehicle={null}
        onClose={() => setFormOpen(false)}
        onSaved={(v, aff) => {
          setFormOpen(false);
          toast.show(`已新增 ${v.plateNo}`, "success");
          setAffected(aff);
          void load();
        }}
      />
      <AffectedBookingsSheet bookings={affected} onClose={() => setAffected([])} />
    </div>
  );
}
