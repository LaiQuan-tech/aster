"use client";

/**
 * 公出／出差：「公出｜出差」切換（公出＝日期＋起訖時間；出差＝起迄日期全天＋出差範圍）
 * ＋ 地點（必填）＋ 預估花費（選填）＋「需要預支？」→ 金額 ＋ 事由（選填）。
 * body 欄位名沿用舊頁面：tripType / location / tripScope / estimatedCost / advanceRequested。
 */
import { useId, useState, type FormEvent } from "react";
import { Field, Input, Segmented, Select } from "@/components/ess-ui";
import { fmtMoney } from "@/lib/ess-format";
import { TRIP_SCOPE_LABEL, TRIP_TYPE_LABEL, buildCreateBody, describeBody, isBuildError } from "@/lib/request-forms";
import { ProxyPicker, ReasonField, SubmitBar, proxyTarget, type FormCommonProps } from "./form-shared";

type TripType = "outing" | "business_trip";
type TripScope = "local" | "domestic_intercity" | "overseas";

const TYPE_OPTIONS: { value: TripType; label: string }[] = [
  { value: "outing", label: `${TRIP_TYPE_LABEL.outing}（一天以內）` },
  { value: "business_trip", label: `${TRIP_TYPE_LABEL.business_trip}（一天以上）` },
];

const SCOPES: TripScope[] = ["local", "domestic_intercity", "overseas"];

export interface TripFormProps extends FormCommonProps {
  /** 建議提出預支的門檻（伺服器設定）；null＝沒設定就不提示。 */
  advanceThreshold: number | null;
}

export function TripForm({ advanceThreshold, initialDate, submitting, submitError, onSubmit, proxy }: TripFormProps) {
  const ids = { date: useId(), start: useId(), end: useId(), sDate: useId(), eDate: useId(), scope: useId(), loc: useId(), cost: useId(), adv: useId() };
  const [tripType, setTripType] = useState<TripType>("outing");
  const [date, setDate] = useState(initialDate);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("18:00");
  const [startDate, setStartDate] = useState(initialDate);
  const [endDate, setEndDate] = useState(initialDate);
  const [tripScope, setTripScope] = useState<TripScope>("domestic_intercity");
  const [location, setLocation] = useState("");
  const [estimatedCost, setEstimatedCost] = useState("");
  const [advanceWanted, setAdvanceWanted] = useState(false);
  const [advanceRequested, setAdvanceRequested] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const clear = () => setLocalError(null);
  const advanceAmount = Number(advanceRequested.replace(/,/g, ""));
  const belowThreshold =
    advanceWanted && advanceThreshold != null && advanceRequested.trim() !== "" && Number.isFinite(advanceAmount) && advanceAmount < advanceThreshold;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLocalError(null);
    const target = proxyTarget(proxy);
    if ("error" in target) return setLocalError(target.error);
    const body = buildCreateBody("business_trip", {
      tripType,
      date,
      startTime,
      endTime,
      startDate,
      endDate,
      tripScope,
      location,
      estimatedCost,
      advanceWanted,
      advanceRequested,
      reason,
      onBehalfOfEmployeeId: target.onBehalfOfEmployeeId,
    });
    if (isBuildError(body)) return setLocalError(body.error);
    await onSubmit(body, [], `${TRIP_TYPE_LABEL[tripType]} · ${describeBody(body)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <ProxyPicker proxy={proxy} />

      <Segmented<TripType>
        aria-label="公出或出差"
        options={TYPE_OPTIONS}
        value={tripType}
        onChange={(next) => {
          setTripType(next);
          clear();
        }}
      />

      {tripType === "outing" ? (
        <>
          <Field label="日期" required htmlFor={ids.date}>
            <Input
              id={ids.date}
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                clear();
              }}
              required
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="開始時間" required htmlFor={ids.start}>
              <Input
                id={ids.start}
                type="time"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  clear();
                }}
                required
              />
            </Field>
            <Field label="結束時間" required htmlFor={ids.end}>
              <Input
                id={ids.end}
                type="time"
                value={endTime}
                onChange={(e) => {
                  setEndTime(e.target.value);
                  clear();
                }}
                required
              />
            </Field>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="開始日期" required htmlFor={ids.sDate}>
              <Input
                id={ids.sDate}
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                  clear();
                }}
                required
              />
            </Field>
            <Field label="結束日期" required htmlFor={ids.eDate}>
              <Input
                id={ids.eDate}
                type="date"
                min={startDate}
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  clear();
                }}
                required
              />
            </Field>
          </div>
          <Field label="出差範圍" required htmlFor={ids.scope} hint={tripScope !== "local" ? "跨縣市以上的長途出差需經簽核同意後才成立" : undefined}>
            <Select
              id={ids.scope}
              value={tripScope}
              onChange={(e) => {
                setTripScope(e.target.value as TripScope);
                clear();
              }}
            >
              {SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {TRIP_SCOPE_LABEL[scope]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      <Field label="地點" required htmlFor={ids.loc}>
        <Input
          id={ids.loc}
          value={location}
          maxLength={250}
          placeholder="例如：台中客戶公司"
          onChange={(e) => {
            setLocation(e.target.value);
            clear();
          }}
          aria-invalid={localError === "請填寫地點" ? true : undefined}
          required
        />
      </Field>

      <Field label="預估花費（元）" htmlFor={ids.cost} hint="供簽核者判斷，不是申請金額">
        <Input
          id={ids.cost}
          type="number"
          inputMode="numeric"
          min={0}
          value={estimatedCost}
          placeholder="選填"
          onChange={(e) => {
            setEstimatedCost(e.target.value);
            clear();
          }}
        />
      </Field>

      <div className="rounded-xl border border-dashed border-gray-200 px-3 py-2">
        <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={advanceWanted}
            onChange={(e) => {
              setAdvanceWanted(e.target.checked);
              clear();
            }}
            className="h-4 w-4 accent-[var(--brand)]"
          />
          需要預支
        </label>
        {advanceWanted && (
          <div className="mt-2">
            <Field
              label="預支金額（元）"
              required
              htmlFor={ids.adv}
              hint={
                belowThreshold
                  ? `此金額低於建議門檻 ${fmtMoney(advanceThreshold)}，仍可送出，但會在簽核時標示——請在事由說明原因`
                  : "核准後由公司先撥款；回程再以實際報銷沖抵，多退少補"
              }
            >
              <Input
                id={ids.adv}
                type="number"
                inputMode="numeric"
                min={0}
                value={advanceRequested}
                onChange={(e) => {
                  setAdvanceRequested(e.target.value);
                  clear();
                }}
                aria-invalid={localError === "請填寫預支金額" ? true : undefined}
              />
            </Field>
          </div>
        )}
      </div>

      <ReasonField value={reason} onChange={setReason} placeholder="選填，例如：客戶拜訪、展會" />

      <SubmitBar submitting={submitting} error={localError ?? submitError} />
    </form>
  );
}
