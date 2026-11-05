"use client";

/**
 * 後台用車紀錄明細 `/admin/vehicles/trips/[id]`：照片縮圖、費用行與報銷單狀態、HR 更正里程／用途／車況（理由必填，
 * PATCH /vehicle-trips/:id）、HR 修改未請款費用（PUT costs）。「轉報銷」只給用車人本人（員工端），後台不提供。
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  BottomSheet,
  Button,
  Card,
  DetailHeading,
  Field,
  InlineError,
  Input,
  Pill,
  Select,
  Skeleton,
  useToast,
} from "@/components/admin-ui";
import { CostList, CostRowsEditor, PhotoGrid, costToDraft, draftsToCosts, type CostDraft } from "@/components/vehicle-ui";
import { fmtDateTime, localDateKey, todayKey } from "@/lib/ess-format";
import { CONDITION_LABEL, distanceOf, fmtKm, vehicleErrorMessage } from "@/lib/vehicle-view";
import { getVehicleTrip, saveTripCosts, updateVehicleTrip, type ConditionStatus, type VehicleTrip } from "@/lib/vehicles-api";

export default function AdminVehicleTripDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
  const toast = useToast();

  const [trip, setTrip] = useState<VehicleTrip | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [fixOpen, setFixOpen] = useState(false);
  const [fix, setFix] = useState({ startOdometer: "", endOdometer: "", purpose: "", destination: "", conditionStatus: "" as "" | ConditionStatus, conditionNote: "", note: "", reason: "" });
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixBusy, setFixBusy] = useState(false);

  const [costs, setCosts] = useState<CostDraft[] | null>(null);
  const [costError, setCostError] = useState<string | null>(null);
  const [costBusy, setCostBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const res = await getVehicleTrip(id);
      setTrip(res.trip);
    } catch (err) {
      setError(vehicleErrorMessage(err, "載入失敗"));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function openFix() {
    if (!trip) return;
    setFix({
      startOdometer: String(trip.startOdometer),
      endOdometer: trip.endOdometer != null ? String(trip.endOdometer) : "",
      purpose: trip.purpose ?? "",
      destination: trip.destination ?? "",
      conditionStatus: trip.conditionStatus ?? "",
      conditionNote: trip.conditionNote ?? "",
      note: trip.note ?? "",
      reason: "",
    });
    setFixError(null);
    setFixOpen(true);
  }

  async function saveFix() {
    if (!trip) return;
    setFixError(null);
    if (!fix.reason.trim()) return setFixError("請填寫更正理由");
    const start = Number(fix.startOdometer.replace(/,/g, ""));
    const end = fix.endOdometer.trim() ? Number(fix.endOdometer.replace(/,/g, "")) : null;
    if (!Number.isInteger(start) || start < 0) return setFixError("出車里程請填整數公里");
    if (end !== null && (!Number.isInteger(end) || end < 0)) return setFixError("還車里程請填整數公里");
    if (end !== null && end < start) return setFixError("還車里程不可小於出車里程");
    if (fix.conditionStatus === "issue" && !fix.conditionNote.trim()) return setFixError("車況有問題時請說明狀況");
    setFixBusy(true);
    try {
      const res = await updateVehicleTrip(trip.id, {
        reason: fix.reason.trim(),
        ...(start !== trip.startOdometer ? { startOdometer: start } : {}),
        ...(end !== null && end !== trip.endOdometer ? { endOdometer: end } : {}),
        ...(fix.purpose !== (trip.purpose ?? "") ? { purpose: fix.purpose.trim() } : {}),
        ...(fix.destination !== (trip.destination ?? "") ? { destination: fix.destination.trim() } : {}),
        ...(fix.conditionStatus && fix.conditionStatus !== trip.conditionStatus ? { conditionStatus: fix.conditionStatus } : {}),
        ...(fix.conditionNote !== (trip.conditionNote ?? "") ? { conditionNote: fix.conditionNote.trim() } : {}),
        ...(fix.note !== (trip.note ?? "") ? { note: fix.note.trim() } : {}),
      });
      setTrip({ ...res.trip, photos: res.trip.photos ?? trip.photos });
      setFixOpen(false);
      toast.show("已更正", "success");
    } catch (err) {
      setFixError(vehicleErrorMessage(err, "更正失敗"));
    } finally {
      setFixBusy(false);
    }
  }

  async function saveCosts() {
    if (!trip || !costs) return;
    setCostError(null);
    const parsed = draftsToCosts(costs);
    if (!parsed.ok) return setCostError(parsed.message);
    setCostBusy(true);
    try {
      const res = await saveTripCosts(trip.id, parsed.costs);
      setTrip({ ...res.trip, photos: res.trip.photos ?? trip.photos });
      setCosts(null);
      toast.show("費用已儲存", "success");
    } catch (err) {
      setCostError(vehicleErrorMessage(err, "儲存失敗"));
    } finally {
      setCostBusy(false);
    }
  }

  if (error) return <InlineError>{error}</InlineError>;
  if (!trip) return <Skeleton lines={6} />;

  const locked = trip.costs.filter((c) => c.claimState !== "none");
  const editable = trip.costs.filter((c) => c.claimState === "none");

  return (
    <div className="space-y-4">
      <DetailHeading title={`${trip.plateNo} · ${trip.employeeName}`} desc={`${fmtDateTime(trip.checkedOutAt)} 取車`}>
        <Pill tone={trip.returnedAt ? "blue" : "amber"}>{trip.returnedAt ? "已還車" : "未還車"}</Pill>
        <Button size="sm" variant="secondary" onClick={openFix}>
          更正
        </Button>
      </DetailHeading>

      <Card title="里程與車況">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm text-gray-700">
          <dt className="text-gray-400">車型</dt>
          <dd>{trip.model}</dd>
          <dt className="text-gray-400">出車</dt>
          <dd className="tabular-nums">
            {fmtDateTime(trip.checkedOutAt)} · {fmtKm(trip.startOdometer)}
            {trip.odometerOverrideReason && <span className="text-amber-700">（低於目前里程：{trip.odometerOverrideReason}）</span>}
          </dd>
          <dt className="text-gray-400">還車</dt>
          <dd className="tabular-nums">{trip.returnedAt ? `${fmtDateTime(trip.returnedAt)} · ${fmtKm(trip.endOdometer)}` : "—"}</dd>
          <dt className="text-gray-400">行駛</dt>
          <dd>{fmtKm(trip.distanceKm ?? distanceOf(trip.startOdometer, trip.endOdometer))}</dd>
          <dt className="text-gray-400">用途</dt>
          <dd className="break-words">{trip.purpose || "—"}</dd>
          <dt className="text-gray-400">目的地</dt>
          <dd className="break-words">{trip.destination || "—"}</dd>
          <dt className="text-gray-400">車況</dt>
          <dd>
            {trip.conditionStatus ? (
              <Pill tone={trip.conditionStatus === "issue" ? "red" : "green"}>{CONDITION_LABEL[trip.conditionStatus]}</Pill>
            ) : (
              "—"
            )}
            {trip.conditionNote && <span className="ml-2 break-words">{trip.conditionNote}</span>}
          </dd>
          <dt className="text-gray-400">備註</dt>
          <dd className="whitespace-pre-wrap break-words">{trip.note || "—"}</dd>
        </dl>
      </Card>

      <Card
        title="費用與報銷"
        action={
          costs === null ? (
            <button type="button" className="text-sm underline" style={{ color: "var(--brand)" }} onClick={() => { setCostError(null); setCosts(editable.map(costToDraft)); }}>
              修改未請款費用
            </button>
          ) : undefined
        }
      >
        {costs === null ? (
          <>
            <CostList costs={trip.costs} />
            <p className="mt-2 text-xs text-gray-500">轉報銷只能由用車人本人在員工端操作；報銷單由財務在「報銷」月結審核。</p>
          </>
        ) : (
          <div className="space-y-3">
            {locked.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-gray-500">已轉報銷的費用不能修改：</p>
                <CostList costs={locked} />
              </div>
            )}
            <CostRowsEditor drafts={costs} onChange={setCosts} defaultDate={trip.returnedAt ? localDateKey(trip.returnedAt) : todayKey()} disabled={costBusy} />
            {costError && <InlineError>{costError}</InlineError>}
            <div className="flex gap-2">
              <Button onClick={() => void saveCosts()} loading={costBusy}>
                儲存費用
              </Button>
              <Button variant="secondary" onClick={() => setCosts(null)} disabled={costBusy}>
                取消
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card title={`車況照片（${trip.photos?.length ?? 0}）`}>
        <PhotoGrid photos={trip.photos ?? []} />
      </Card>

      <BottomSheet open={fixOpen} onClose={() => !fixBusy && setFixOpen(false)} title="更正用車紀錄">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveFix();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="出車里程" htmlFor="fx-start">
              <Input id="fx-start" inputMode="numeric" value={fix.startOdometer} onChange={(e) => setFix({ ...fix, startOdometer: e.target.value })} />
            </Field>
            <Field label="還車里程" htmlFor="fx-end">
              <Input id="fx-end" inputMode="numeric" value={fix.endOdometer} disabled={!trip.returnedAt} onChange={(e) => setFix({ ...fix, endOdometer: e.target.value })} />
            </Field>
            <Field label="用途" htmlFor="fx-purpose">
              <Input id="fx-purpose" value={fix.purpose} onChange={(e) => setFix({ ...fix, purpose: e.target.value })} />
            </Field>
            <Field label="目的地" htmlFor="fx-dest">
              <Input id="fx-dest" value={fix.destination} onChange={(e) => setFix({ ...fix, destination: e.target.value })} />
            </Field>
            <Field label="車況" htmlFor="fx-cond">
              <Select id="fx-cond" value={fix.conditionStatus} onChange={(e) => setFix({ ...fix, conditionStatus: e.target.value as "" | ConditionStatus })}>
                <option value="">（未填）</option>
                <option value="ok">正常</option>
                <option value="issue">有問題</option>
              </Select>
            </Field>
            <Field label="車況說明" htmlFor="fx-cnote">
              <Input id="fx-cnote" value={fix.conditionNote} onChange={(e) => setFix({ ...fix, conditionNote: e.target.value })} />
            </Field>
          </div>
          <Field label="備註" htmlFor="fx-note">
            <Input id="fx-note" value={fix.note} onChange={(e) => setFix({ ...fix, note: e.target.value })} />
          </Field>
          <Field label="更正理由" required htmlFor="fx-reason" hint="會記在稽核紀錄">
            <Input id="fx-reason" value={fix.reason} maxLength={200} onChange={(e) => setFix({ ...fix, reason: e.target.value })} />
          </Field>
          {fixError && <InlineError>{fixError}</InlineError>}
          <Button type="submit" block size="lg" loading={fixBusy}>
            儲存更正
          </Button>
        </form>
      </BottomSheet>
    </div>
  );
}
