"use client";

/**
 * 員工端用車紀錄 `/ess/vehicles/trips/[id]`（取車後進來；也可由預約卡進入）。
 *   - 未還車：還車表單——還車里程（即時顯示行駛公里數、小於出車里程即擋）、用途／目的地（預填）、
 *     車況 正常／有問題（有問題必填說明）、還車照片、費用行（類型、金額、員工代墊／公司支付、日期、備註）。
 *   - 已還車：費用區顯示每行請款狀態；未請款的行可修改（PUT /vehicle-trips/:id/costs）。
 *     「轉報銷」只有用車人本人看得到（業主拍板；API 也只允許本人）→ 逐行結果；成功的行可「上傳收據」
 *     （沿用既有 POST /expenses/:id/attachments），報銷後續照既有流程（送出即成立、財務月結審）。
 *   - 照片：取車／還車縮圖；可補傳（每趟最多 12 張）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, Card, EmptyState, Field, InlineError, Input, Pill, Segmented, Skeleton, Textarea, useToast } from "@/components/ess-ui";
import {
  CostList,
  CostRowsEditor,
  PhotoGrid,
  PhotoPicker,
  costToDraft,
  draftsToCosts,
  type CostDraft,
} from "@/components/vehicle-ui";
import { useEssState } from "@/lib/ess-state";
import { fmtDateTime, localDateKey, todayKey } from "@/lib/ess-format";
import { uploadExpenseReceipt } from "@/lib/ess-api";
import {
  CONDITION_LABEL,
  canShowClaimButton,
  claimResultSummary,
  claimableCosts,
  distanceOf,
  fmtKm,
  validateReturn,
  vehicleErrorMessage,
  type ReturnField,
} from "@/lib/vehicle-view";
import {
  createTripExpenseClaims,
  getVehicleTrip,
  returnVehicle,
  saveTripCosts,
  uploadTripPhoto,
  type ConditionStatus,
  type TripCost,
  type VehicleTrip,
} from "@/lib/vehicles-api";

export default function EssVehicleTripPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
  const toast = useToast();
  const state = useEssState();
  const myId = state.me?.id ?? null;

  const [trip, setTrip] = useState<VehicleTrip | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 還車表單
  const [ret, setRet] = useState({ endOdometer: "", purpose: "", destination: "", conditionNote: "", note: "" });
  const [condition, setCondition] = useState<ConditionStatus>("ok");
  const [retCosts, setRetCosts] = useState<CostDraft[]>([]);
  const [retPhotos, setRetPhotos] = useState<File[]>([]);
  const [retError, setRetError] = useState<{ field?: ReturnField; message: string } | null>(null);
  const [retBusy, setRetBusy] = useState(false);
  const prefilled = useRef(false);

  // 已還車：費用修改
  const [editingCosts, setEditingCosts] = useState<CostDraft[] | null>(null);
  const [costBusy, setCostBusy] = useState(false);
  const [costError, setCostError] = useState<string | null>(null);

  // 轉報銷
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimMsg, setClaimMsg] = useState<string | null>(null);
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null);
  const [receiptDone, setReceiptDone] = useState<Record<string, number>>({});

  // 補傳照片
  const [morePhotos, setMorePhotos] = useState<File[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      const res = await getVehicleTrip(id);
      setTrip(res.trip);
      if (!prefilled.current) {
        prefilled.current = true;
        setRet((r) => ({ ...r, purpose: res.trip.purpose ?? "", destination: res.trip.destination ?? "" }));
      }
    } catch (err) {
      setLoadError(vehicleErrorMessage(err, "載入失敗"));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = todayKey();
  const distance = trip ? distanceOf(trip.startOdometer, ret.endOdometer) : null;
  const isOwner = !!trip && !!myId && trip.employeeId === myId;
  const showClaim = trip ? canShowClaimButton(trip, myId) : false;
  const claimables = trip ? claimableCosts(trip.costs) : [];
  const editableCosts = useMemo(() => (trip ? trip.costs.filter((c) => c.claimState === "none") : []), [trip]);
  const lockedCosts = useMemo(() => (trip ? trip.costs.filter((c) => c.claimState !== "none") : []), [trip]);
  const photoCount = trip?.photos?.length ?? 0;

  async function uploadAll(tripId: string, phase: "checkout" | "return", files: File[]): Promise<number> {
    let failed = 0;
    for (const file of files) {
      try {
        await uploadTripPhoto(tripId, phase, file);
      } catch (err) {
        failed += 1;
        toast.show(`${file.name}：${vehicleErrorMessage(err, "照片上傳失敗")}`, "error");
      }
    }
    return failed;
  }

  async function submitReturn() {
    if (!trip) return;
    setRetError(null);
    const v = validateReturn({
      startOdometer: trip.startOdometer,
      endOdometer: ret.endOdometer,
      conditionStatus: condition,
      conditionNote: ret.conditionNote,
    });
    if (!v.ok) return setRetError({ field: v.field, message: v.message });
    const costs = draftsToCosts(retCosts);
    if (!costs.ok) return setRetError({ message: costs.message });
    setRetBusy(true);
    try {
      const res = await returnVehicle(trip.id, {
        endOdometer: Number(ret.endOdometer.replace(/,/g, "")),
        conditionStatus: condition,
        ...(ret.purpose.trim() ? { purpose: ret.purpose.trim() } : {}),
        ...(ret.destination.trim() ? { destination: ret.destination.trim() } : {}),
        ...(condition === "issue" ? { conditionNote: ret.conditionNote.trim() } : {}),
        ...(ret.note.trim() ? { note: ret.note.trim() } : {}),
        ...(costs.costs.length > 0 ? { costs: costs.costs.map(({ id: _id, ...rest }) => rest) } : {}),
      });
      const failed = await uploadAll(trip.id, "return", retPhotos);
      setRetPhotos([]);
      setTrip(res.trip);
      toast.show(failed ? `已還車；${failed} 張照片沒傳成功，可在下方補傳` : "已還車，謝謝", failed ? "info" : "success");
      void load();
    } catch (err) {
      setRetError({ message: vehicleErrorMessage(err, "還車失敗") });
    } finally {
      setRetBusy(false);
    }
  }

  async function saveCosts() {
    if (!trip || !editingCosts) return;
    setCostError(null);
    const costs = draftsToCosts(editingCosts);
    if (!costs.ok) return setCostError(costs.message);
    setCostBusy(true);
    try {
      const res = await saveTripCosts(trip.id, costs.costs);
      setTrip({ ...res.trip, photos: res.trip.photos ?? trip.photos });
      setEditingCosts(null);
      toast.show("費用已儲存", "success");
    } catch (err) {
      setCostError(vehicleErrorMessage(err, "儲存失敗"));
    } finally {
      setCostBusy(false);
    }
  }

  async function claim() {
    if (!trip) return;
    setClaimBusy(true);
    setClaimMsg(null);
    try {
      const res = await createTripExpenseClaims(trip.id);
      setTrip({ ...res.trip, photos: res.trip.photos ?? trip.photos });
      const summary = claimResultSummary(res.results);
      setClaimMsg(summary);
      toast.show(summary, res.results.some((r) => !r.ok) ? "info" : "success");
    } catch (err) {
      setClaimMsg(vehicleErrorMessage(err, "轉報銷失敗"));
    } finally {
      setClaimBusy(false);
    }
  }

  async function uploadReceipt(cost: TripCost, file: File) {
    if (!cost.expenseClaimId) return;
    setReceiptBusy(cost.id);
    try {
      await uploadExpenseReceipt(cost.expenseClaimId, file);
      setReceiptDone((m) => ({ ...m, [cost.id]: (m[cost.id] ?? 0) + 1 }));
      toast.show("收據已上傳", "success");
    } catch (err) {
      toast.show(vehicleErrorMessage(err, "收據上傳失敗"), "error");
    } finally {
      setReceiptBusy(null);
    }
  }

  async function uploadMore() {
    if (!trip || morePhotos.length === 0) return;
    setPhotoBusy(true);
    const failed = await uploadAll(trip.id, trip.returnedAt ? "return" : "checkout", morePhotos);
    setMorePhotos([]);
    setPhotoBusy(false);
    if (!failed) toast.show("照片已上傳", "success");
    void load();
  }

  if (loadError) {
    return (
      <Card>
        <InlineError>{loadError}</InlineError>
        <Link href="/ess/vehicles" className="mt-3 inline-block text-sm underline">
          回公務車
        </Link>
      </Card>
    );
  }
  if (!trip) return <Skeleton lines={6} />;

  const receiptSlot = (cost: TripCost) =>
    isOwner && cost.claimState === "claimed" && cost.expenseClaimId ? (
      <label className="inline-flex cursor-pointer items-center rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700">
        {receiptBusy === cost.id ? "上傳中…" : receiptDone[cost.id] ? `收據 ✓${receiptDone[cost.id]}` : "上傳收據"}
        <input
          type="file"
          accept="image/*,application/pdf"
          className="sr-only"
          disabled={receiptBusy !== null}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void uploadReceipt(cost, f);
          }}
        />
      </label>
    ) : null;

  return (
    <div className="space-y-4">
      <Card title={`${trip.plateNo} · ${trip.model}`} action={<Pill tone={trip.returnedAt ? "blue" : "amber"}>{trip.returnedAt ? "已還車" : "使用中"}</Pill>}>
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1.5 text-sm text-gray-700">
          <dt className="text-gray-400">用車人</dt>
          <dd>{trip.employeeName}</dd>
          <dt className="text-gray-400">取車</dt>
          <dd className="tabular-nums">
            {fmtDateTime(trip.checkedOutAt)} · {fmtKm(trip.startOdometer)}
          </dd>
          {trip.odometerOverrideReason && (
            <>
              <dt className="text-gray-400">里程說明</dt>
              <dd className="break-words">{trip.odometerOverrideReason}</dd>
            </>
          )}
          {trip.returnedAt && (
            <>
              <dt className="text-gray-400">還車</dt>
              <dd className="tabular-nums">
                {fmtDateTime(trip.returnedAt)} · {fmtKm(trip.endOdometer)}
              </dd>
              <dt className="text-gray-400">行駛</dt>
              <dd>{fmtKm(trip.distanceKm ?? distanceOf(trip.startOdometer, trip.endOdometer))}</dd>
              <dt className="text-gray-400">車況</dt>
              <dd>
                {trip.conditionStatus ? CONDITION_LABEL[trip.conditionStatus] : "—"}
                {trip.conditionNote ? `：${trip.conditionNote}` : ""}
              </dd>
            </>
          )}
          {(trip.purpose || trip.destination) && (
            <>
              <dt className="text-gray-400">用途／目的地</dt>
              <dd className="break-words">{[trip.purpose, trip.destination].filter(Boolean).join(" · ")}</dd>
            </>
          )}
          {trip.note && (
            <>
              <dt className="text-gray-400">備註</dt>
              <dd className="whitespace-pre-wrap break-words">{trip.note}</dd>
            </>
          )}
        </dl>
      </Card>

      {!trip.returnedAt && trip.canReturn && (
        <Card title="還車">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitReturn();
            }}
          >
            <Field
              label="還車里程（km）"
              required
              htmlFor="rt-odo"
              error={retError?.field === "endOdometer" ? retError.message : undefined}
              hint={`出車里程 ${fmtKm(trip.startOdometer)}`}
            >
              <Input
                id="rt-odo"
                inputMode="numeric"
                value={ret.endOdometer}
                aria-invalid={retError?.field === "endOdometer" || (distance !== null && distance < 0) ? true : undefined}
                onChange={(e) => setRet({ ...ret, endOdometer: e.target.value })}
              />
            </Field>
            {distance !== null && (
              <p className={`text-sm ${distance < 0 ? "text-red-600" : "text-gray-700"}`}>
                {distance < 0 ? "還車里程小於出車里程" : `本趟行駛 ${fmtKm(distance)}`}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="用途" htmlFor="rt-purpose">
                <Input id="rt-purpose" value={ret.purpose} maxLength={200} onChange={(e) => setRet({ ...ret, purpose: e.target.value })} />
              </Field>
              <Field label="目的地" htmlFor="rt-dest">
                <Input id="rt-dest" value={ret.destination} maxLength={200} onChange={(e) => setRet({ ...ret, destination: e.target.value })} />
              </Field>
            </div>
            <Field label="車況" required>
              <Segmented
                aria-label="車況"
                options={[
                  { value: "ok", label: "正常" },
                  { value: "issue", label: "有問題" },
                ]}
                value={condition}
                onChange={(v) => setCondition(v as ConditionStatus)}
              />
            </Field>
            {condition === "issue" && (
              <Field
                label="狀況說明"
                required
                htmlFor="rt-cnote"
                error={retError?.field === "conditionNote" ? retError.message : undefined}
                hint="會通知 HR 處理"
              >
                <Textarea id="rt-cnote" value={ret.conditionNote} maxLength={1000} onChange={(e) => setRet({ ...ret, conditionNote: e.target.value })} className="min-h-16" />
              </Field>
            )}
            <Field label="還車照片（選填）">
              <PhotoPicker
                files={retPhotos}
                onChange={setRetPhotos}
                onError={(m) => toast.show(m, "error")}
                disabled={retBusy}
                max={Math.max(0, 12 - photoCount)}
                label="拍照／選照片"
              />
            </Field>
            <Field label="費用（油資、過路費、停車費…）">
              <CostRowsEditor drafts={retCosts} onChange={setRetCosts} defaultDate={today} disabled={retBusy} />
            </Field>
            <Field label="備註" htmlFor="rt-note">
              <Input id="rt-note" value={ret.note} maxLength={500} onChange={(e) => setRet({ ...ret, note: e.target.value })} />
            </Field>
            {retError && !retError.field && <InlineError>{retError.message}</InlineError>}
            <Button type="submit" block size="lg" loading={retBusy}>
              確認還車
            </Button>
          </form>
        </Card>
      )}

      {trip.returnedAt && (
        <Card
          title="費用"
          action={
            editingCosts === null && isOwner ? (
              <button
                type="button"
                className="text-sm underline"
                style={{ color: "var(--brand)" }}
                onClick={() => {
                  setCostError(null);
                  setEditingCosts(editableCosts.map(costToDraft));
                }}
              >
                {editableCosts.length > 0 ? "修改未請款費用" : "新增費用"}
              </button>
            ) : undefined
          }
        >
          {editingCosts !== null ? (
            <div className="space-y-3">
              {lockedCosts.length > 0 && (
                <div>
                  <p className="mb-1 text-xs text-gray-500">已轉報銷的費用不能修改：</p>
                  <CostList costs={lockedCosts} />
                </div>
              )}
              <CostRowsEditor drafts={editingCosts} onChange={setEditingCosts} defaultDate={trip.returnedAt ? localDateKey(trip.returnedAt) : today} disabled={costBusy} />
              {costError && <InlineError>{costError}</InlineError>}
              <div className="flex gap-2">
                <Button onClick={() => void saveCosts()} loading={costBusy}>
                  儲存費用
                </Button>
                <Button variant="secondary" onClick={() => setEditingCosts(null)} disabled={costBusy}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <>
              <CostList costs={trip.costs} receiptSlot={receiptSlot} />
              {showClaim && (
                <div className="mt-3 space-y-2 rounded-xl bg-gray-50 p-3">
                  <p className="text-sm text-gray-700">
                    你代墊的 {claimables.length} 筆費用尚未請款。轉報銷後會建立報銷單（送出即成立，由財務月結審核），再上傳收據即可。
                  </p>
                  <Button onClick={() => void claim()} loading={claimBusy}>
                    轉報銷
                  </Button>
                </div>
              )}
              {claimMsg && <p className="mt-2 text-sm text-gray-700">{claimMsg}</p>}
              {isOwner && trip.costs.some((c) => c.claimState === "claimed") && (
                <p className="mt-2 text-sm">
                  <Link href="/ess/expenses" className="underline" style={{ color: "var(--brand)" }}>
                    到「費用報銷」查看報銷單
                  </Link>
                </p>
              )}
            </>
          )}
        </Card>
      )}

      <Card title={`車況照片（${photoCount}／12）`}>
        {trip.photos === undefined ? <EmptyState title="照片載入中" /> : <PhotoGrid photos={trip.photos} />}
        {photoCount < 12 && (trip.canReturn || isOwner) && (
          <div className="mt-3 space-y-2">
            <PhotoPicker
              files={morePhotos}
              onChange={setMorePhotos}
              onError={(m) => toast.show(m, "error")}
              disabled={photoBusy}
              max={12 - photoCount}
              label={trip.returnedAt ? "補傳還車照片" : "補傳取車照片"}
            />
            {morePhotos.length > 0 && (
              <Button size="sm" onClick={() => void uploadMore()} loading={photoBusy}>
                上傳 {morePhotos.length} 張
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
