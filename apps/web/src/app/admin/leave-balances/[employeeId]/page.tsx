"use client";

/**
 * 員工假別內頁 /admin/leave-balances/[employeeId]（2026-10-27 業主：「點進內頁後可以手動增減假的時數」）。
 * 導覽歸在「假別餘額」底下（admin-nav balances.detail），返回鍵回總覽。
 *
 *   - 上方：每個假別一張卡（剩餘／已用／總額、期間、到期日；30 天內到期掛標籤）。
 *   - 手動調整（只有 HR／平台管理員看得到表單；API requireHrAdmin）：選假別（與餘額桶）、增加／減少、
 *     天＋時（依 1 天＝N 小時換算）、原因必填。減少會讓剩餘變負時先提示，勾「仍要調整」才送 allowNegative。
 *   - 下方：各期間餘額桶、調整歷程（時間、操作者、增減、原因）、該年度的請假紀錄。
 * 資料：GET /leave-balances/employees/:id、POST /leave-balances/adjustments、GET /requests（kind=leave）。
 */
import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Card, DetailHeading, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { getRequests, type LeaveRequest } from "@/lib/admin-api";
import { apiErrorMessage } from "@/lib/api-client";
import { fmtHm, localDateKey } from "@/lib/ess-format";
import { balancePeriodLabel, balanceSourceClass, balanceSourceLabel } from "@/lib/leave-balances-api";
import { formatLeaveDuration, formatLeaveRemaining } from "@/lib/leave-duration";
import {
  adjustLeaveBalance,
  daysHoursToHours,
  expiringLabel,
  getEmployeeLeaveDetail,
  remainingAfter,
  signedDelta,
  validateAdjustForm,
  type AdjustDirection,
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
  const [direction, setDirection] = useState<AdjustDirection>("add");
  const [days, setDays] = useState("");
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  const [allowNegative, setAllowNegative] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
  // 調整對象的「目前剩餘」：指定桶＝該桶；沒指定＝該假別目前有效桶的加總（API 會挑期間包含今天的桶）。
  const currentRemaining = selectedBucket
    ? Number(selectedBucket.entitled) + Number(selectedBucket.deferred) - Number(selectedBucket.used)
    : (selectedCard?.remaining ?? 0);
  const previewHours = daysHoursToHours(days, hours, perDay ?? 8);
  const previewDelta = previewHours === null ? null : direction === "subtract" ? -previewHours : previewHours;
  const after = previewDelta === null ? null : remainingAfter(currentRemaining, previewDelta);
  const wouldBeNegative = after !== null && after < 0;

  function pickType(id: string) {
    setLeaveTypeId(id);
    const card = detail?.cards.find((c) => c.leaveType.id === id);
    setBalanceId(card?.balanceIds.length === 1 ? card.balanceIds[0]! : "");
    setAllowNegative(false);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setMessage(null);
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
                  {card.periodStart && card.periodEnd ? `${card.periodStart} ～ ${card.periodEnd}` : `${detail.year} 年`}
                </p>
              </button>
            );
          })}
        </div>
      )}

      {detail.canAdjust ? (
        <Card>
          <h2 className="mb-1 text-sm font-medium text-gray-700">手動調整</h2>
          <p className="mb-4 text-xs text-gray-400">
            增減會直接加減在餘額桶的「本期給假」並留下調整紀錄；原因必填。可點上方假別卡片快速選假別。
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
                <option value="">{bucketsOfType.length === 0 ? "（目前沒有，增加時自動新開本年度）" : "自動（期間包含今天的那一筆）"}</option>
                {bucketsOfType.map((b) => (
                  <option key={b.id} value={b.id}>
                    {balancePeriodLabel(b)} · {balanceSourceLabel(b.source)} · 剩 {formatLeaveRemaining(Number(b.entitled) + Number(b.deferred) - Number(b.used), perDay)}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>增加／減少</label>
              <div className="flex gap-2">
                {(["add", "subtract"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDirection(d)}
                    className={`flex-1 rounded-xl border px-3 py-2 text-sm ${
                      direction === d
                        ? d === "add"
                          ? "border-green-600 bg-green-50 text-green-700"
                          : "border-red-500 bg-red-50 text-red-600"
                        : "border-gray-200 text-gray-600"
                    }`}
                  >
                    {d === "add" ? "＋ 增加" : "− 減少"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={labelCls}>天</label>
              <input type="number" min="0" step="1" className={inputCls} value={days} onChange={(event) => setDays(event.target.value)} />
            </div>
            <div>
              <label className={labelCls}>小時</label>
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
              {leaveTypeId && previewHours !== null && previewHours > 0 ? (
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
