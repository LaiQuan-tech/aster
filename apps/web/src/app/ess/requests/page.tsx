"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AuthGate } from "@/components/AuthGate";
import { EssHeader } from "@/components/EssHeader";
import { getEmployees, type Employee } from "@/lib/admin-api";
import {
  getBranding,
  getRequests,
  createRequest,
  cancelRequest,
  getLeaveTypes,
  getLeaveBalances,
  getMe,
  isAdminRole,
  uploadAttachment,
  type LeaveBalance,
  type LeaveSegment,
  type Branding,
  type LeaveRequest,
  type LeaveType,
  type RequestKind,
  type RequestStatus,
  getExpenseSettingsForMe,
} from "@/lib/ess-api";

const KIND_LABEL: Record<RequestKind, string> = {
  leave: "請假",
  ot: "加班",
  fix_punch: "補卡",
  business_trip: "公出/出差",
  petty_cash: "零用金預支",
};

const STATUS_STYLE: Record<RequestStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "待簽核",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已取消",
};

const PAYOUT_LABEL: Record<"pay" | "comp_time", string> = {
  pay: "加班費",
  comp_time: "補休",
};

type RequestWithApolloExtras = LeaveRequest & {
  payout?: "pay" | "comp_time" | null;
  remark?: string | null;
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Convert a <input type="datetime-local"> value to an ISO string the API accepts. */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

function fmtLocal(local: string): string {
  if (!local) return "尚未填寫";
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return local.replace("T", " ");
  return date.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hoursBetweenLocal(start: string, end: string): number | null {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;
  return Math.round(((endMs - startMs) / 3_600_000) * 100) / 100;
}

function fmtDecimalHours(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function RequestsView() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // form state
  const [kind, setKind] = useState<RequestKind>("leave");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  // Apollo form-parity extras
  const [agentName, setAgentName] = useState("");
  const [payout, setPayout] = useState<"pay" | "comp_time">("pay");
  const [otBreakMinutes, setOtBreakMinutes] = useState("0");
  const [otHoursTouched, setOtHoursTouched] = useState(false);
  const [tripType, setTripType] = useState<"outing" | "business_trip">("outing");
  const [location, setLocation] = useState("");
  // 出差申請（模組三第 2 條）
  const [tripScope, setTripScope] = useState<"local" | "domestic_intercity" | "overseas">("local");
  const [estimatedCost, setEstimatedCost] = useState("");
  const [advanceRequested, setAdvanceRequested] = useState("");
  /** 建議提出預支申請的金額門檻（伺服器設定，不在前端寫死）。 */
  const [advanceThreshold, setAdvanceThreshold] = useState<number | null>(null);
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 代申請 (HR only)
  const [proxy, setProxy] = useState(false);
  const [proxyEmpId, setProxyEmpId] = useState("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  // 即時餘額
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  // 多段日期
  const [segments, setSegments] = useState<LeaveSegment[]>([]);
  // 附件 (≤3 × ≤3MB)
  const [files, setFiles] = useState<File[]>([]);

  const loadRequests = useCallback(async () => {
    const res = await getRequests();
    setRequests(res.requests);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      // Leave types are HR-only on the API; treat failure as "no list".
      const [brandRes, ltRes, meRes, cfgRes] = await Promise.allSettled([
        getBranding(),
        getLeaveTypes(),
        getMe(),
        getExpenseSettingsForMe(),
      ]);
      if (!active) return;
      if (cfgRes.status === "fulfilled") {
        setAdvanceThreshold(cfgRes.value.settings.advanceThreshold);
      }
      if (brandRes.status === "fulfilled") setBranding(brandRes.value.branding);
      if (ltRes.status === "fulfilled") setLeaveTypes(ltRes.value.leaveTypes);
      if (meRes.status === "fulfilled") {
        const admin = isAdminRole(meRes.value.role);
        setIsAdmin(admin);
        if (admin) getEmployees().then((r) => setEmployees(r.employees)).catch(() => null);
      }
      getLeaveBalances().then((r) => setBalances(r.balances)).catch(() => null);
      try {
        await loadRequests();
      } catch (err) {
        if (active) setListError(err instanceof Error ? err.message : "載入申請失敗");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadRequests]);

  // 剩餘 X 時 X 分 for the currently selected leave type (across years).
  function remainingFor(typeId: string): number | null {
    const rows = balances.filter((b) => b.leave_type_id === typeId);
    if (rows.length === 0) return null;
    return rows.reduce(
      (sum, b) => sum + Number(b.entitled) + Number(b.deferred) - Number(b.used),
      0,
    );
  }
  const fmtHours = (h: number) => `${Math.floor(h)} 時 ${Math.round((h - Math.floor(h)) * 60)} 分`;

  // 目前選取的假別（用來判斷是否須附憑證，例如病假）。
  const selectedLeaveType = leaveTypes.find((lt) => lt.id === leaveTypeId);

  const segHours = (a: string, b: string) => {
    const [ah, am] = a.split(":").map(Number);
    const [bh, bm] = b.split(":").map(Number);
    return Math.max(0, Math.round(((bh * 60 + bm - ah * 60 - am) / 60) * 100) / 100);
  };

  function addSegment() {
    setSegments((p) => [...p, { date: "", startTime: "09:00", endTime: "18:00", hours: 8 }]);
  }
  function updateSegment(i: number, patch: Partial<LeaveSegment>) {
    setSegments((p) =>
      p.map((seg, idx) => {
        if (idx !== i) return seg;
        const merged = { ...seg, ...patch };
        merged.hours = segHours(merged.startTime, merged.endTime);
        return merged;
      }),
    );
  }
  const segmentsTotal = segments.reduce((s, x) => s + x.hours, 0);
  const otGrossHours = hoursBetweenLocal(startAt, endAt);
  const otBreakMinutesValue = Math.max(0, Number(otBreakMinutes) || 0);
  const otNetHours =
    otGrossHours == null
      ? null
      : Math.max(0, Math.round((otGrossHours - otBreakMinutesValue / 60) * 100) / 100);

  useEffect(() => {
    if (kind !== "ot" || otHoursTouched || otNetHours == null) return;
    setHours(fmtDecimalHours(otNetHours));
  }, [kind, otHoursTouched, otNetHours]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const segMode = kind === "leave" && segments.length > 0;
    if (segMode && segments.some((x) => !x.date)) {
      setFormError("請填寫每個日期段的日期");
      return;
    }
    if (!segMode && (!startAt || !endAt)) {
      setFormError("請填寫起訖時間");
      return;
    }
    if (files.length > 3) {
      setFormError("附件最多 3 個");
      return;
    }
    if (files.some((f) => f.size > 3 * 1024 * 1024)) {
      setFormError("附件單檔限 3 MB");
      return;
    }
    setSubmitting(true);
    try {
      const useSegs = kind === "leave" && segments.length > 0 && segments.every((x) => x.date);
      const created = await createRequest({
        kind,
        leaveTypeId: kind === "leave" && leaveTypeId ? leaveTypeId : undefined,
        onBehalfOfEmployeeId: proxy && proxyEmpId ? proxyEmpId : undefined,
        segments: useSegs ? segments : undefined,
        startAt: useSegs
          ? new Date(`${segments[0].date}T${segments[0].startTime}:00`).toISOString()
          : toIso(startAt),
        endAt: useSegs
          ? new Date(`${segments[segments.length - 1].date}T${segments[segments.length - 1].endTime}:00`).toISOString()
          : toIso(endAt),
        hours: useSegs ? segmentsTotal : hours ? Number(hours) : undefined,
        reason:
          kind === "ot"
            ? [
                reason.trim(),
                `休息扣除：${otBreakMinutesValue} 分鐘`,
                `給付方式：${PAYOUT_LABEL[payout]}`,
              ]
                .filter(Boolean)
                .join("｜")
            : reason.trim() || undefined,
        agentName: agentName.trim() || undefined,
        payout: kind === "ot" ? payout : undefined,
        tripType: kind === "business_trip" ? tripType : undefined,
        location: kind === "business_trip" ? location.trim() || undefined : undefined,
        remark: kind === "business_trip" ? remark.trim() || undefined : undefined,
        tripScope: kind === "business_trip" ? tripScope : undefined,
        estimatedCost:
          kind === "business_trip" && estimatedCost.trim() ? Number(estimatedCost) : undefined,
        advanceRequested:
          (kind === "business_trip" || kind === "petty_cash") && advanceRequested.trim()
            ? Number(advanceRequested)
            : undefined,
      });
      for (const f of files) {
        await uploadAttachment(created.requestId, f);
      }
      setFiles([]);
      // reset + refresh
      setLeaveTypeId("");
      setStartAt("");
      setEndAt("");
      setHours("");
      setReason("");
      setAgentName("");
      setSegments([]);
      setProxy(false);
      setProxyEmpId("");
      setPayout("pay");
      setTripType("outing");
      setLocation("");
      setRemark("");
      setTripScope("local");
      setEstimatedCost("");
      setAdvanceRequested("");
      await loadRequests();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "送出失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancel(id: string) {
    try {
      await cancelRequest(id);
      await loadRequests();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "取消失敗");
    }
  }

  const inputCls =
    "w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]";

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader
        appName={branding?.appName}
        primaryColor={branding?.primaryColor}
        active="requests"
        isAdmin={isAdmin}
      />
      <main className="mx-auto max-w-2xl space-y-6 px-3 pb-6 pt-4 sm:px-4">
        {/* New request form */}
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">新增申請</h2>
          <form onSubmit={onSubmit} className="space-y-4">
            {isAdmin && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">申請人</label>
                <div className="grid grid-cols-2 gap-3 text-sm text-gray-700 sm:flex sm:items-center sm:gap-6">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="proxy" checked={!proxy} onChange={() => setProxy(false)} />
                    本人
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="proxy" checked={proxy} onChange={() => setProxy(true)} />
                    代申請
                  </label>
                  {proxy && (
                    <select value={proxyEmpId} onChange={(e) => setProxyEmpId(e.target.value)} className={`${inputCls} col-span-2`}>
                      <option value="">請選擇員工</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>{emp.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">類型</label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as RequestKind)}
                className={inputCls}
              >
                <option value="leave">請假</option>
                <option value="ot">加班</option>
                <option value="fix_punch">補卡</option>
                <option value="business_trip">公出/出差</option>
                <option value="petty_cash">零用金預支</option>
              </select>
            </div>

            {kind === "leave" && leaveTypes.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">假別</label>
                <select
                  value={leaveTypeId}
                  onChange={(e) => setLeaveTypeId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">（不指定）</option>
                  {leaveTypes.map((lt) => (
                    <option key={lt.id} value={lt.id}>
                      {lt.name}
                    </option>
                  ))}
                </select>
                {leaveTypeId && !proxy && (
                  <p className="mt-1 text-xs text-gray-500">
                    {remainingFor(leaveTypeId) == null
                      ? "剩餘：－（尚未設定額度）"
                      : `剩餘：${fmtHours(Math.max(0, remainingFor(leaveTypeId) ?? 0))}`}
                    {(() => {
                      const rem = remainingFor(leaveTypeId);
                      const req = segments.length > 0 ? segmentsTotal : Number(hours) || 0;
                      return rem != null && req > rem ? (
                        <span className="ml-2 font-medium text-red-600">申請時數超過剩餘額度</span>
                      ) : null;
                    })()}
                  </p>
                )}
              </div>
            )}

            {kind === "leave" && (
              <div>
                <div className="mb-1 flex items-center justify-between gap-3">
                  <label className="block text-sm font-medium text-gray-700">日期段（多段請假）</label>
                  <button type="button" onClick={addSegment} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                    ＋ 新增
                  </button>
                </div>
                {segments.length === 0 ? (
                  <p className="text-xs text-gray-400">未新增日期段時，使用下方單一起訖時間。</p>
                ) : (
                  <div className="space-y-2">
                    {segments.map((seg, i) => (
                      <div key={i} className="grid grid-cols-2 items-center gap-2 rounded-xl bg-gray-50 p-3 text-sm sm:flex sm:flex-wrap">
                        <input type="date" value={seg.date} onChange={(e) => updateSegment(i, { date: e.target.value })} className="col-span-2 rounded-md border border-gray-300 px-2 py-2 sm:col-span-1" />
                        <input type="time" value={seg.startTime} onChange={(e) => updateSegment(i, { startTime: e.target.value })} className="rounded-md border border-gray-300 px-2 py-2" />
                        <input type="time" value={seg.endTime} onChange={(e) => updateSegment(i, { endTime: e.target.value })} className="rounded-md border border-gray-300 px-2 py-2" />
                        <span className="text-xs text-gray-500">{seg.hours} 小時</span>
                        <button type="button" onClick={() => setSegments((pv) => pv.filter((_, idx) => idx !== i))} className="text-xs text-red-600 hover:underline">
                          移除
                        </button>
                      </div>
                    ))}
                    <p className="text-xs text-gray-600">總計：{segmentsTotal} 小時</p>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">開始時間</label>
                <input
                  type="datetime-local"
                  required
                  value={startAt}
                  onChange={(e) => {
                    setStartAt(e.target.value);
                    if (kind === "ot") setOtHoursTouched(false);
                  }}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">結束時間</label>
                <input
                  type="datetime-local"
                  required
                  value={endAt}
                  onChange={(e) => {
                    setEndAt(e.target.value);
                    if (kind === "ot") setOtHoursTouched(false);
                  }}
                  className={inputCls}
                />
              </div>
            </div>

            {kind === "ot" && (
              <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-medium text-blue-900">加班申請資訊</h3>
                    <p className="mt-1 text-sm text-blue-700">請確認加班區間、休息扣除與給付方式；送出後會進入簽核流程。</p>
                  </div>
                  <a href="/ess/punches" className="text-sm font-medium text-blue-700 hover:underline">
                    查看打卡參考
                  </a>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-white/80 p-3">
                    <p className="text-xs text-blue-600">加班區間</p>
                    <p className="mt-1 text-sm font-medium text-blue-950">{fmtLocal(startAt)} → {fmtLocal(endAt)}</p>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-blue-700">休息扣除（分鐘）</label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={otBreakMinutes}
                      onChange={(event) => {
                        setOtBreakMinutes(event.target.value);
                        setOtHoursTouched(false);
                      }}
                      className={inputCls}
                    />
                  </div>
                  <div className="rounded-lg bg-white/80 p-3">
                    <p className="text-xs text-blue-600">淨加班時數</p>
                    <p className="mt-1 text-lg font-semibold text-blue-950">
                      {otNetHours == null ? "—" : `${fmtDecimalHours(otNetHours)} 小時`}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-blue-700">
                  打卡參考目前提供跳轉查閱；若實際打卡缺漏，請改選「補卡」或先完成忘打卡申請。
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {kind === "ot" ? "加班時數" : "時數（選填）"}
              </label>
              <input
                type="number"
                min="0"
                step="0.5"
                value={hours}
                onChange={(e) => {
                  setHours(e.target.value);
                  if (kind === "ot") setOtHoursTouched(true);
                }}
                className={inputCls}
              />
              {kind === "ot" && (
                <p className="mt-1 text-xs text-gray-500">
                  預設由起訖時間扣除休息分鐘自動計算，可手動覆寫。
                </p>
              )}
            </div>

            {kind === "ot" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">給付方式</label>
                <div className="grid grid-cols-2 gap-3 text-sm text-gray-700 sm:flex sm:gap-6">
                  <label className="flex items-center gap-2">
                    <input type="radio" name="payout" checked={payout === "pay"} onChange={() => setPayout("pay")} />
                    加班費
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="payout" checked={payout === "comp_time"} onChange={() => setPayout("comp_time")} />
                    補休
                  </label>
                </div>
              </div>
            )}

            {kind === "petty_cash" && (
              <div className="space-y-4">
                <div>
                  <label
                    className="block text-sm font-medium text-gray-700 mb-1"
                    htmlFor="pc-amount"
                  >
                    預支金額
                  </label>
                  <input
                    id="pc-amount"
                    type="number"
                    min="0"
                    value={advanceRequested}
                    onChange={(e) => setAdvanceRequested(e.target.value)}
                    required
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                  />
                  {/* 門檻是提示不是閘門：低於門檻仍可送出，由簽核者判斷。 */}
                  {advanceThreshold !== null &&
                    advanceRequested.trim() !== "" &&
                    Number(advanceRequested) < advanceThreshold && (
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        此金額低於建議門檻 {advanceThreshold.toLocaleString("zh-TW")} 元。
                        仍可送出，但會在簽核時標示——請在用途說明原因。
                      </p>
                    )}
                  <p className="mt-1 text-xs text-gray-400">
                    核准後由公司先撥款給你；之後請憑單據報銷沖抵，多退少補。
                    <strong>未核銷的預支會列為未結款項。</strong>
                  </p>
                </div>
              </div>
            )}

            {kind === "business_trip" && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">類型</label>
                  <div className="grid grid-cols-1 gap-3 text-sm text-gray-700 sm:flex sm:gap-6">
                    <label className="flex items-center gap-2">
                      <input type="radio" name="tripType" checked={tripType === "outing"} onChange={() => setTripType("outing")} />
                      公出（一天以內）
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="tripType" checked={tripType === "business_trip"} onChange={() => setTripType("business_trip")} />
                      出差（一天以上）
                    </label>
                  </div>
                </div>

                <div>
                  <label
                    className="block text-sm font-medium text-gray-700 mb-1"
                    htmlFor="trip-scope"
                  >
                    出差範圍
                  </label>
                  <select
                    id="trip-scope"
                    value={tripScope}
                    onChange={(e) =>
                      setTripScope(
                        e.target.value as "local" | "domestic_intercity" | "overseas",
                      )
                    }
                    className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                  >
                    <option value="local">市內</option>
                    <option value="domestic_intercity">跨縣市</option>
                    <option value="overseas">海外</option>
                  </select>
                  {tripScope !== "local" && (
                    <p className="mt-1 text-xs text-gray-500">
                      跨縣市以上的長途出差需經簽核同意後才成立。
                    </p>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label
                      className="block text-sm font-medium text-gray-700 mb-1"
                      htmlFor="trip-cost"
                    >
                      預估總花費（選填）
                    </label>
                    <input
                      id="trip-cost"
                      type="number"
                      min="0"
                      value={estimatedCost}
                      onChange={(e) => setEstimatedCost(e.target.value)}
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-400">供簽核者判斷，不是申請金額。</p>
                  </div>
                  <div>
                    <label
                      className="block text-sm font-medium text-gray-700 mb-1"
                      htmlFor="trip-advance"
                    >
                      申請預支（選填）
                    </label>
                    <input
                      id="trip-advance"
                      type="number"
                      min="0"
                      value={advanceRequested}
                      onChange={(e) => setAdvanceRequested(e.target.value)}
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                    />
                    <p className="mt-1 text-xs text-gray-400">
                      核准後由公司先撥款給你帶著去；回程再以實際報銷沖抵，多退少補。
                    </p>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">地點</label>
                  <input maxLength={250} value={location} onChange={(e) => setLocation(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">備註（選填）</label>
                  <input maxLength={250} value={remark} onChange={(e) => setRemark(e.target.value)} className={inputCls} />
                </div>
              </>
            )}

            {(kind === "leave" || kind === "business_trip") && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">代理人（工號或姓名，選填）</label>
                <input value={agentName} onChange={(e) => setAgentName(e.target.value)} className={inputCls} />
              </div>
            )}

            {(kind === "leave" || kind === "business_trip") && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  附件（最多 3 個，單檔 3 MB）
                  {kind === "leave" && selectedLeaveType?.requiresAttachment && (
                    <span className="ml-1 text-red-600">＊必附憑證</span>
                  )}
                </label>
                {kind === "leave" && selectedLeaveType?.requiresAttachment && (
                  <p className="mb-1 text-xs font-medium text-red-600">此假別核准前需附憑證（診所收據）</p>
                )}
                <input
                  type="file"
                  multiple
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 3))}
                  className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm"
                />
                {files.length > 0 && (
                  <p className="mt-1 text-xs text-gray-500">{files.map((f) => f.name).join("、")}</p>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">原因（選填）</label>
              <textarea
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={inputCls}
              />
            </div>

            {formError && (
              <p className="text-sm text-red-600" role="alert">
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl px-5 py-3 font-medium text-white disabled:opacity-60 sm:w-auto sm:rounded-md sm:py-2.5"
              style={{ backgroundColor: "var(--brand)" }}
            >
              {submitting ? "送出中…" : "送出申請"}
            </button>
          </form>
        </section>

        {/* My requests */}
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">我的申請</h2>
          {listError && (
            <p className="text-sm text-red-600 mb-3" role="alert">
              {listError}
            </p>
          )}
          {loading ? (
            <p className="text-sm text-gray-400">載入中…</p>
          ) : requests.length === 0 ? (
            <p className="text-sm text-gray-400">尚無申請紀錄</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {requests.map((r) => (
                <li key={r.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-800">
                        {KIND_LABEL[r.kind]}
                      </span>
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[r.status]}`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </div>
                    {r.status === "pending" && (
                      <button
                        onClick={() => onCancel(r.id)}
                        className="text-sm text-red-600 hover:underline"
                      >
                        取消
                      </button>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-gray-500">
                    {fmt(r.start_at)} → {fmt(r.end_at)}
                    {r.hours != null ? ` · ${r.hours} 小時` : ""}
                  </p>
                  {r.kind === "ot" && (
                    <p className="mt-1 text-xs text-gray-500">
                      給付方式：{PAYOUT_LABEL[(r as RequestWithApolloExtras).payout ?? "pay"]}；打卡參考請至打卡紀錄查詢
                    </p>
                  )}
                  {r.reason && (
                    <p className="mt-1 text-sm text-gray-600">{r.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export default function RequestsPage() {
  return (
    <AuthGate>
      <RequestsView />
    </AuthGate>
  );
}
