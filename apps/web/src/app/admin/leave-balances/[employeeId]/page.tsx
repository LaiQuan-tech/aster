"use client";

/**
 * 員工假別內頁 /admin/leave-balances/[employeeId]（2026-10-27 業主：「點進內頁後可以手動增減假的時數」）。
 * 導覽歸在「假別餘額」底下（admin-nav balances.detail），返回鍵回總覽。
 *
 *   - 上方：每個假別一張卡（剩餘／已用／總額、期間、到期日；30 天內到期掛標籤）。
 *   - 手動調整（只有 HR／平台管理員看得到表單；API requireHrAdmin）：選假別（與餘額桶）、增加／減少／
 *     直接設定剩餘為（2026-11-12），天＋時（依 1 天＝N 小時換算）、原因必填。減少會讓剩餘變負時先提示，
 *     勾「仍要調整」才送 allowNegative。「直接設定」畫面先預覽差額，送出帶 targetHours，由伺服器依當下餘額算差額。
 *     網址 `?leaveType=<id>&mode=set`（總覽點格子）會直接帶入假別並選好「直接設定」。
 *   - 「依到職日重新計算特休」（只 HR）：POST /leave-balances/annual-grant { employeeId, dryRun } 先預覽再執行，冪等。
 *   - 下方：各期間餘額桶、調整歷程（時間、操作者、增減、原因）、該年度的請假紀錄。
 * 資料：GET /leave-balances/employees/:id、POST /leave-balances/adjustments、GET /requests（kind=leave）。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Card, DetailHeading, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { getRequests, type LeaveRequest } from "@/lib/admin-api";
import { apiErrorMessage } from "@/lib/api-client";
import { fmtHm, localDateKey } from "@/lib/ess-format";
import {
  ANNUAL_GRANT_SKIP_REASONS,
  balancePeriodLabel,
  balanceSourceClass,
  balanceSourceLabel,
  runAnnualGrant,
  type AnnualGrantResult,
} from "@/lib/leave-balances-api";
import { formatLeaveDuration, formatLeaveRemaining } from "@/lib/leave-duration";
import {
  adjustLeaveBalance,
  daysHoursToHours,
  defaultBucketId,
  expiringLabel,
  getEmployeeLeaveDetail,
  remainingAfter,
  signedDelta,
  validateAdjustForm,
  validateSetRemainingForm,
  deltaToTarget,
  type AdjustMode,
  type EmployeeLeaveDetail,
} from "@/lib/leave-overview-api";

const STATUS_LABEL: Record<string, string> = {
  pending: "簽核中",
  approved: "已核准",
  rejected: "已駁回",
  cancelled: "已取消",
  void: "已註銷",
};

export default function EmployeeLeaveDetailPage() {
  return (
    <Suspense fallback={<Empty>載入中…</Empty>}>
      <EmployeeLeaveDetailContent />
    </Suspense>
  );
}

function EmployeeLeaveDetailContent() {
  const params = useParams<{ employeeId: string }>();
  const searchParams = useSearchParams();
  const employeeId = typeof params?.employeeId === "string" ? decodeURIComponent(params.employeeId) : "";
  const [year, setYear] = useState(() => {
    const y = Number(searchParams?.get("year"));
    return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : new Date().getFullYear();
  });
  const [detail, setDetail] = useState<EmployeeLeaveDetail | null>(null);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 調整表單
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [balanceId, setBalanceId] = useState("");
  const [direction, setDirection] = useState<AdjustMode>("add");
  const [days, setDays] = useState("");
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  const [allowNegative, setAllowNegative] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  /** 網址帶的 leaveType／mode 只在第一次載入時套用一次。 */
  const appliedQuery = useRef(false);

  // 依到職日重新計算特休（只 HR）：先預覽、再執行。
  const [grantPreview, setGrantPreview] = useState<AnnualGrantResult | null>(null);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantMessage, setGrantMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, r] = await Promise.all([
        getEmployeeLeaveDetail(employeeId, year),
        getRequests({ kind: "leave", employeeId, from: `${year}-01-01`, to: `${year}-12-31` }).catch(() => ({ requests: [] as LeaveRequest[] })),
      ]);
      setDetail(d);
      setRequests(r.requests);
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "載入員工假別失敗"));
    } finally {
      setLoading(false);
    }
  }, [employeeId, year]);

  useEffect(() => {
    if (employeeId) void load();
  }, [employeeId, load]);

  const perDay = detail?.dailyRegularHours;
  const typeName = useMemo(() => new Map((detail?.leaveTypes ?? []).map((t) => [t.id, t.name])), [detail]);
  const bucketsOfType = useMemo(
    () => (detail?.balances ?? []).filter((b) => b.leave_type_id === leaveTypeId),
    [detail, leaveTypeId],
  );
  const selectedCard = detail?.cards.find((c) => c.leaveType.id === leaveTypeId);
  const selectedBucket = bucketsOfType.find((b) => b.id === balanceId);
  // 調整對象的「目前剩餘」以所選桶為準；該假別還沒有桶＝0（增加時新開）；有桶但還沒選＝不預判。
  const currentRemaining: number | null = selectedBucket
    ? Number(selectedBucket.entitled) + Number(selectedBucket.deferred) - Number(selectedBucket.used)
    : bucketsOfType.length === 0
      ? 0
      : null;
  const mustPickBucket = bucketsOfType.length > 1;
  const isSet = direction === "set";
  const previewHours = daysHoursToHours(days, hours, perDay ?? 8);
  const hasInput = days.trim() !== "" || hours.trim() !== "";
  // 「直接設定」的預覽差額＝目標 − 目前剩餘；增減模式＝±輸入值。
  const previewDelta =
    previewHours === null
      ? null
      : isSet
        ? currentRemaining === null || !hasInput
          ? null
          : deltaToTarget(currentRemaining, previewHours)
        : direction === "subtract"
          ? -previewHours
          : previewHours;
  const after = isSet
    ? previewDelta === null ? null : previewHours
    : previewDelta === null || currentRemaining === null ? null : remainingAfter(currentRemaining, previewDelta);
  const wouldBeNegative = !isSet && after !== null && after < 0;

  function pickType(id: string, list = detail?.balances ?? []) {
    setLeaveTypeId(id);
    // 有桶就預設選期間包含今天的那一個（多桶時強制選，不給「自動」）。
    const buckets = list.filter((b) => b.leave_type_id === id);
    setBalanceId(defaultBucketId(buckets, localDateKey(new Date().toISOString())));
    setAllowNegative(false);
  }

  // 總覽點格子進來（?leaveType=…&mode=set）：帶入假別並選好「直接設定剩餘為」，捲到調整表單。
  useEffect(() => {
    if (!detail || appliedQuery.current) return;
    appliedQuery.current = true;
    if (!detail.canAdjust) return;
    const qType = searchParams?.get("leaveType");
    const qMode = searchParams?.get("mode");
    if (qType && detail.leaveTypes.some((t) => t.id === qType)) {
      pickType(qType, detail.balances);
      if (qMode === "set") setDirection("set");
      requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在第一次拿到 detail 時套用網址參數
  }, [detail]);

  async function previewGrant() {
    setGrantError(null);
    setGrantMessage(null);
    setGranting(true);
    try {
      setGrantPreview(await runAnnualGrant({ employeeId, dryRun: true }));
    } catch (err) {
      setGrantError(apiErrorMessage(err, "預覽特休失敗"));
    } finally {
      setGranting(false);
    }
  }

  async function executeGrant() {
    setGrantError(null);
    setGranting(true);
    try {
      const res = await runAnnualGrant({ employeeId });
      const g = res.granted[0];
      setGrantMessage(
        g
          ? `已發放特休 ${g.days} 日（${formatLeaveDuration(g.entitledHours, perDay)}），期間 ${g.periodStart} ～ ${g.periodEnd}`
          : "沒有需要發放的特休（本期已發過或不符資格）",
      );
      setGrantPreview(null);
      await load();
    } catch (err) {
      setGrantError(apiErrorMessage(err, "發放特休失敗"));
    } finally {
      setGranting(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setMessage(null);
    if (mustPickBucket && !balanceId) {
      setFormError("這個假別有多個期間，請選擇要調整的期間（餘額桶）");
      return;
    }
    if (direction === "set") {
      const sv = validateSetRemainingForm({ days, hours, reason, leaveTypeId }, currentRemaining, perDay ?? 8);
      if (sv.error !== undefined) {
        setFormError(sv.error);
        return;
      }
      setSaving(true);
      try {
        const res = await adjustLeaveBalance({
          employeeId,
          leaveTypeId,
          balanceId: balanceId || undefined,
          mode: "set_remaining",
          targetHours: sv.targetHours,
          reason: reason.trim(),
        });
        setMessage(
          `${typeName.get(leaveTypeId) ?? ""}剩餘已設為 ${formatLeaveRemaining(res.balance.remaining, perDay)}` +
            `（原 ${formatLeaveRemaining(res.remainingBefore, perDay)}，${signedDelta(res.deltaHours, (h) => formatLeaveDuration(h, perDay))}）`,
        );
        setDays("");
        setHours("");
        setReason("");
        await load();
      } catch (err) {
        setFormError(apiErrorMessage(err, "調整失敗"));
      } finally {
        setSaving(false);
      }
      return;
    }
    const v = validateAdjustForm({ direction, days, hours, reason, leaveTypeId }, perDay ?? 8);
    if (v.error !== undefined) {
      setFormError(v.error);
      return;
    }
    if (wouldBeNegative && !allowNegative) {
      setFormError("減少後剩餘會變成負數；確定要調整請勾選「仍要調整（允許負數）」");
      return;
    }
    setSaving(true);
    try {
      const res = await adjustLeaveBalance({
        employeeId,
        leaveTypeId,
        balanceId: balanceId || undefined,
        deltaHours: v.deltaHours,
        reason: reason.trim(),
        allowNegative: allowNegative || undefined,
      });
      setMessage(
        `已${v.deltaHours > 0 ? "增加" : "減少"} ${formatLeaveDuration(Math.abs(v.deltaHours), perDay)}，` +
          `${typeName.get(leaveTypeId) ?? ""}剩餘 ${formatLeaveRemaining(res.balance.remaining, perDay)}`,
      );
      setDays("");
      setHours("");
      setReason("");
      setAllowNegative(false);
      await load();
    } catch (err) {
      setFormError(apiErrorMessage(err, "調整失敗"));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !detail) return <Empty>載入中…</Empty>;
  if (loadError && !detail) return <ErrorText>{loadError}</ErrorText>;
  if (!detail) return <Empty>查無員工資料</Empty>;

  const emp = detail.employee;

  return (
    <>
      <DetailHeading
        title={`${emp.emp_no ? `${emp.emp_no} · ` : ""}${emp.name}`}
        desc={`${emp.dept_name ?? "未分單位"}　到職日：${emp.hire_date || "未填"}　1 天＝${perDay ?? 8} 小時　基準日 ${detail.asOf}`}
      >
        {detail.canAdjust && (
          <button
            type="button"
            className="rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-700 disabled:opacity-40"
            disabled={granting}
            onClick={() => void previewGrant()}
            title="依到職日與年資表，補發本週年期間的特休（已發過就不重複發）"
          >
            {granting && !grantPreview ? "計算中…" : "依到職日重新計算特休"}
          </button>
        )}
        <label className="flex items-center gap-2 text-sm text-gray-600">
          年度
          <input
            type="number"
            className={`${inputCls} w-24`}
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          />
        </label>
      </DetailHeading>

      {loadError && <ErrorText>{loadError}</ErrorText>}

      {detail.canAdjust && (grantPreview || grantError || grantMessage) && (
        <Card>
          <h2 className="mb-2 text-sm font-medium text-gray-700">依到職日重新計算特休</h2>
          {grantPreview && <GrantPreview result={grantPreview} perDay={perDay} />}
          {grantMessage && <p className="text-sm text-green-600">{grantMessage}</p>}
          {grantError && <div className="mt-2"><ErrorText>{grantError}</ErrorText></div>}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600"
              onClick={() => {
                setGrantPreview(null);
                setGrantError(null);
                setGrantMessage(null);
              }}
            >
              關閉
            </button>
            {grantPreview && grantPreview.granted.length > 0 && (
              <PrimaryButton type="button" disabled={granting} onClick={() => void executeGrant()}>
                {granting ? "發放中…" : "確認發放"}
              </PrimaryButton>
            )}
          </div>
        </Card>
      )}

      {detail.cards.length === 0 ? (
        <Card>
          <Empty>這個年度還沒有任何假別餘額{detail.canAdjust ? "，可在下方手動增加" : ""}</Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {detail.cards.map((card) => {
            const exp = expiringLabel(card.expiring);
            return (
              <button
                key={card.leaveType.id}
                type="button"
                onClick={() => detail.canAdjust && pickType(card.leaveType.id)}
                className={`rounded-xl border bg-white p-4 text-left shadow-sm transition ${
                  leaveTypeId === card.leaveType.id ? "border-[var(--brand)] ring-1 ring-[var(--brand)]" : "border-gray-200"
                } ${detail.canAdjust ? "hover:border-gray-300" : "cursor-default"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-700">{card.leaveType.name}</p>
                  {exp && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{exp}</span>}
                </div>
                <p className={`mt-2 text-2xl font-semibold tabular-nums ${card.remaining < 0 ? "text-red-600" : card.remaining === 0 ? "text-gray-400" : "text-gray-900"}`}>
                  {formatLeaveRemaining(card.remaining, perDay)}
                </p>
                <p className="mt-1 text-xs tabular-nums text-gray-500">
                  已用 {formatLeaveDuration(card.used, perDay)}／總額 {formatLeaveDuration(card.total, perDay)}
                </p>
                <p className="mt-1 text-[11px] text-gray-400">
                  {card.noActivePeriod
                    ? "無有效期間"
                    : card.periodStart && card.periodEnd
                      ? `${card.periodStart} ～ ${card.periodEnd}`
                      : `${detail.year} 年`}
                </p>
                {(card.overlapCount ?? 0) > 0 && (
                  <p className="mt-0.5 text-[10px] text-amber-600">另有重疊期間（請假扣起日最新的那一個）</p>
                )}
              </button>
            );
          })}
        </div>
      )}

      {detail.canAdjust ? (
        <div ref={formRef} className="scroll-mt-4">
        <Card>
          <h2 className="mb-1 text-sm font-medium text-gray-700">手動調整</h2>
          <p className="mb-4 text-xs text-gray-400">
            增減會直接加減在餘額桶的「本期給假」並留下調整紀錄；原因必填。「直接設定剩餘為」填目標剩餘即可，系統依當下餘額自動算差額。可點上方假別卡片快速選假別。
          </p>
          {!detail.adjustmentsAvailable && (
            <div className="mb-3">
              <ErrorText>調整紀錄表尚未啟用（需先套用 docs/套用-2026-10-29-假別時數調整歷程.sql），暫時無法調整。</ErrorText>
            </div>
          )}
          <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <div className="sm:col-span-2">
              <label className={labelCls}>假別</label>
              <select className={inputCls} value={leaveTypeId} onChange={(event) => pickType(event.target.value)}>
                <option value="">請選擇</option>
                {detail.leaveTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>期間（餘額桶）</label>
              <select className={inputCls} value={balanceId} onChange={(event) => setBalanceId(event.target.value)} disabled={!leaveTypeId}>
                {bucketsOfType.length === 0 ? (
                  <option value="">（目前沒有，增加時自動新開本年度）</option>
                ) : (
                  (mustPickBucket || !balanceId) && <option value="">請選擇期間</option>
                )}
                {bucketsOfType.map((b) => (
                  <option key={b.id} value={b.id}>
                    {balancePeriodLabel(b)} · {balanceSourceLabel(b.source)} · 剩 {formatLeaveRemaining(Number(b.entitled) + Number(b.deferred) - Number(b.used), perDay)}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>方式</label>
              <div className="flex gap-2">
                {(["add", "subtract", "set"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setDirection(d);
                      setAllowNegative(false);
                    }}
                    aria-pressed={direction === d}
                    className={`flex-1 whitespace-nowrap rounded-xl border px-2 py-2 text-sm ${
                      direction === d
                        ? d === "add"
                          ? "border-green-600 bg-green-50 text-green-700"
                          : d === "subtract"
                            ? "border-red-500 bg-red-50 text-red-600"
                            : "border-[var(--brand)] bg-slate-50 text-gray-900"
                        : "border-gray-200 text-gray-600"
                    }`}
                  >
                    {d === "add" ? "＋ 增加" : d === "subtract" ? "− 減少" : "＝ 直接設定剩餘為"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={labelCls}>{isSet ? "目標剩餘（天）" : "天"}</label>
              <input type="number" min="0" step="1" className={inputCls} value={days} onChange={(event) => setDays(event.target.value)} />
            </div>
            <div>
              <label className={labelCls}>{isSet ? "目標剩餘（小時）" : "小時"}</label>
              <input type="number" min="0" step="0.5" className={inputCls} value={hours} onChange={(event) => setHours(event.target.value)} />
            </div>
            <div className="sm:col-span-4">
              <label className={labelCls}>原因（必填）</label>
              <input
                type="text"
                maxLength={500}
                className={inputCls}
                placeholder="例如：補登漏給特休、加班換補休、誤給更正"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="text-sm text-gray-600 sm:col-span-4">
              {isSet ? (
                leaveTypeId && currentRemaining !== null && previewDelta !== null && previewHours !== null ? (
                  <p>
                    目前剩 {formatLeaveRemaining(currentRemaining, perDay)} →{" "}
                    <span className="font-semibold text-gray-900">{formatLeaveRemaining(previewHours, perDay)}</span>
                    ：{previewDelta === 0 ? (
                      <span className="text-amber-600">與目前相同，不需調整</span>
                    ) : (
                      <span className={previewDelta > 0 ? "font-semibold text-green-700" : "font-semibold text-red-600"}>
                        將調整 {signedDelta(previewDelta, (h) => formatLeaveDuration(h, perDay))}（{previewDelta > 0 ? "+" : ""}{previewDelta} 小時）
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="text-gray-400">
                    {leaveTypeId && currentRemaining === null
                      ? "這個假別有多個期間，請先選擇要調整的期間。"
                      : leaveTypeId && currentRemaining !== null
                        ? `目前剩 ${formatLeaveRemaining(currentRemaining, perDay)}；輸入目標剩餘（全部歸零填 0），這裡會顯示將調整多少。`
                        : "選假別、輸入目標剩餘後，這裡會顯示將調整多少。"}
                  </p>
                )
              ) : leaveTypeId && previewHours !== null && previewHours > 0 && currentRemaining !== null ? (
                <p>
                  {direction === "add" ? "增加" : "減少"} {formatLeaveDuration(previewHours, perDay)}（{previewHours} 小時）：
                  剩餘 {formatLeaveRemaining(currentRemaining, perDay)} →{" "}
                  <span className={wouldBeNegative ? "font-semibold text-red-600" : "font-semibold text-gray-900"}>
                    {formatLeaveRemaining(after ?? 0, perDay)}
                  </span>
                </p>
              ) : (
                <p className="text-gray-400">選假別、輸入天／小時後，這裡會顯示調整後剩餘。</p>
              )}
              {wouldBeNegative && (
                <label className="mt-2 flex items-center gap-2 text-red-600">
                  <input type="checkbox" checked={allowNegative} onChange={(event) => setAllowNegative(event.target.checked)} />
                  減少後剩餘為負數（超用），仍要調整（允許負數）
                </label>
              )}
            </div>
            <div className="flex items-end justify-end sm:col-span-2">
              <PrimaryButton type="submit" disabled={saving || !detail.adjustmentsAvailable}>
                {saving ? "儲存中…" : "儲存調整"}
              </PrimaryButton>
            </div>
          </form>
          {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
          {formError && <div className="mt-3"><ErrorText>{formError}</ErrorText></div>}
        </Card>
        </div>
      ) : (
        <p className="text-xs text-gray-400">唯讀：只有人資與老闆可以手動調整假別時數。</p>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-medium text-gray-700">調整紀錄</h2>
        {!detail.adjustmentsAvailable ? (
          <Empty>調整紀錄表尚未啟用</Empty>
        ) : detail.adjustments.length === 0 ? (
          <Empty>尚無手動調整</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">時間</th>
                  <th className="py-2 pr-4">操作者</th>
                  <th className="py-2 pr-4">假別</th>
                  <th className="py-2 pr-4">增減</th>
                  <th className="py-2 pr-4">本期給假</th>
                  <th className="py-2">原因</th>
                </tr>
              </thead>
              <tbody>
                {detail.adjustments.map((a) => (
                  <tr key={a.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 whitespace-nowrap">{localDateKey(a.created_at)} {fmtHm(a.created_at)}</td>
                    <td className="py-2 pr-4">{a.created_by_name ?? "—"}</td>
                    <td className="py-2 pr-4">{typeName.get(a.leave_type_id) ?? "—"}</td>
                    <td className={`py-2 pr-4 whitespace-nowrap font-medium ${Number(a.delta_hours) > 0 ? "text-green-700" : "text-red-600"}`}>
                      {signedDelta(a.delta_hours, (h) => formatLeaveDuration(h, perDay))}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-gray-500">
                      {formatLeaveDuration(Number(a.entitled_before), perDay)} → {formatLeaveDuration(Number(a.entitled_after), perDay)}
                    </td>
                    <td className="py-2">{a.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-medium text-gray-700">各期間餘額</h2>
        {detail.balances.length === 0 ? (
          <Empty>查無餘額桶</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">假別</th>
                  <th className="py-2 pr-4">期間</th>
                  <th className="py-2 pr-4">來源</th>
                  <th className="py-2 pr-4">本期給假</th>
                  <th className="py-2 pr-4">遞延</th>
                  <th className="py-2 pr-4">已用</th>
                  <th className="py-2">剩餘</th>
                </tr>
              </thead>
              <tbody>
                {detail.balances.map((b) => (
                  <tr key={b.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4">{typeName.get(b.leave_type_id) ?? "—"}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{balancePeriodLabel(b)}</td>
                    <td className="py-2 pr-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${balanceSourceClass(b.source)}`} title={b.note ?? undefined}>
                        {balanceSourceLabel(b.source)}
                      </span>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatLeaveDuration(Number(b.entitled), perDay)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatLeaveDuration(Number(b.deferred), perDay)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatLeaveDuration(Number(b.used), perDay)}</td>
                    <td className="py-2 whitespace-nowrap">
                      {formatLeaveRemaining(Number(b.entitled) + Number(b.deferred) - Number(b.used), perDay)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-medium text-gray-700">{detail.year} 年請假紀錄</h2>
        {requests.length === 0 ? (
          <Empty>這一年沒有請假紀錄</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">假別</th>
                  <th className="py-2 pr-4">期間</th>
                  <th className="py-2 pr-4">時數</th>
                  <th className="py-2 pr-4">原因</th>
                  <th className="py-2">狀態</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4">{r.leave_type_id ? (typeName.get(r.leave_type_id) ?? "—") : "未指定"}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {localDateKey(r.start_at)} {fmtHm(r.start_at)} → {localDateKey(r.end_at)} {fmtHm(r.end_at)}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatLeaveDuration(r.hours, perDay)}</td>
                    <td className="py-2 pr-4">{r.reason ?? "—"}</td>
                    <td className="py-2">{STATUS_LABEL[r.status] ?? r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/** 單一員工年度給假預覽：要發的（期間、年資、天數）或跳過的原因。 */
function GrantPreview({ result, perDay }: { result: AnnualGrantResult; perDay?: number }) {
  if (result.ineligible) {
    return <p className="text-sm text-gray-500">這位員工非在職或未填到職日，無法依到職日計算特休。</p>;
  }
  const g = result.granted[0];
  const skip = result.skipped[0];
  if (g) {
    return (
      <p className="text-sm text-gray-700">
        預覽（基準日 {result.asOf}）：將發放 <span className="font-semibold">{g.days} 日</span>（{formatLeaveDuration(g.entitledHours, perDay)}），
        期間 {g.periodStart} ～ {g.periodEnd}，年資 {g.seniorityMonths} 個月。確認後才會寫入。
      </p>
    );
  }
  if (skip) {
    const why = ANNUAL_GRANT_SKIP_REASONS[skip.reason ?? ""] ?? skip.reason ?? "不符資格";
    return (
      <p className="text-sm text-gray-500">
        不需發放：{why}
        {skip.periodStart ? `（本期 ${skip.periodStart} ～ ${skip.periodEnd}，依年資應為 ${skip.days} 日）` : ""}。
        {skip.reason === "already_granted" ? "若數字不對，請用下方「直接設定剩餘為」更正。" : ""}
      </p>
    );
  }
  return <p className="text-sm text-gray-500">沒有需要發放的特休。</p>;
}
