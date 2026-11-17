"use client";

/**
 * 員工內頁「休假」分頁（2026-11-17 業主：管理員可為這位員工設定每一種假的天數與時數）。
 *
 * 一個假別一列：額度（天＋時輸入，依每日工時換算存成小時）｜已用｜簽核中｜剩餘｜調整原因。
 * 沒有額度的假別顯示「不限額／依法」，也可直接設定額度。邏輯（列表組裝、儲存計畫、特休提示）在
 * lib/employee-leave-quota.ts（有測試）；這裡只負責載入、編輯狀態與送出。
 *
 * 權限：只有 HR／平台管理員看得到這個分頁（員工內頁依 isHrRole 決定）；API 端 GET 內頁與調整
 * 也只放行 HR（canAdjust）。離職員工唯讀。資料與 /admin/leave-balances 完全同源（同一組 API／表）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Card, Empty, ErrorText, Pill, inputCls } from "@/components/admin-ui";
import { getLeaveTypes, getRequests, type LeaveRequest, type LeaveType } from "@/lib/admin-api";
import { apiErrorMessage } from "@/lib/api-client";
import { todayKey } from "@/lib/ess-format";
import { formatLeaveDuration, formatLeaveRemaining } from "@/lib/leave-duration";
import { balanceSourceLabel, putLeaveBalance, runAnnualGrant, type AnnualGrantResult } from "@/lib/leave-balances-api";
import { adjustLeaveBalance, getEmployeeLeaveDetail, leaveDetailHref, type EmployeeLeaveDetail } from "@/lib/leave-overview-api";
import {
  QUOTA_REASON_MAX,
  annualLeaveHint,
  approxDays,
  buildQuotaRows,
  hoursToDaysHours,
  planQuotaSave,
  quotaEditDirty,
  quotaInputToHours,
  unlimitedLabel,
  type QuotaEdit,
  type QuotaRow,
} from "@/lib/employee-leave-quota";

const TZ = "Asia/Taipei";

export function EmployeeLeavePanel({ employeeId }: { employeeId: string }) {
  const today = todayKey(TZ);
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [detail, setDetail] = useState<EmployeeLeaveDetail | null>(null);
  const [typeMeta, setTypeMeta] = useState<LeaveType[]>([]);
  const [pending, setPending] = useState<LeaveRequest[]>([]);
  const [grant, setGrant] = useState<AnnualGrantResult | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, QuotaEdit>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, types, reqs] = await Promise.all([
        getEmployeeLeaveDetail(employeeId, year),
        getLeaveTypes().catch(() => ({ leaveTypes: [] as LeaveType[] })),
        getRequests({ kind: "leave", status: "pending", employeeId }).catch(() => ({ requests: [] as LeaveRequest[] })),
      ]);
      setDetail(d);
      setTypeMeta(types.leaveTypes);
      setPending(reqs.requests.filter((r) => r.employee_id === employeeId));
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "載入假別額度失敗"));
    } finally {
      setLoading(false);
    }
  }, [employeeId, year]);

  useEffect(() => {
    void load();
  }, [load]);

  // 特休來源提示：只預覽（dryRun，不寫入）；讀不到（規則未設、欄位未套）就不顯示提示。
  useEffect(() => {
    let active = true;
    runAnnualGrant({ employeeId, dryRun: true })
      .then((r) => active && setGrant(r))
      .catch(() => active && setGrant(null));
    return () => {
      active = false;
    };
  }, [employeeId]);

  const perDay = detail?.dailyRegularHours;
  const rows = useMemo(
    () =>
      detail
        ? buildQuotaRows({
            year,
            today,
            leaveTypes: detail.leaveTypes,
            leaveTypeMeta: typeMeta,
            balances: detail.balances,
            requests: pending,
            selectedBucket,
          })
        : [],
    [detail, typeMeta, pending, selectedBucket, today, year],
  );

  const inactive = !!detail?.employee.status && detail.employee.status !== "active";
  const editable = !!detail?.canAdjust && !inactive;

  const editOf = (row: QuotaRow): QuotaEdit => edits[row.leaveType.id] ?? { ...hoursToDaysHours(row.entitled, perDay), reason: "" };
  const setEdit = (row: QuotaRow, patch: Partial<QuotaEdit>) => {
    setMessage(null);
    setRowErrors((prev) => ({ ...prev, [row.leaveType.id]: "" }));
    setEdits((prev) => ({ ...prev, [row.leaveType.id]: { ...editOf(row), ...patch } }));
  };
  const dirtyRows = rows.filter((r) => quotaEditDirty(r, edits[r.leaveType.id], perDay));

  /** 送出一列；成功回 true。剩餘會變負數時先確認、再帶 allowNegative。 */
  async function saveRow(row: QuotaRow): Promise<boolean> {
    const plan = planQuotaSave(row, editOf(row), { employeeId, year, hoursPerDay: perDay });
    if (plan.kind === "error") {
      setRowErrors((prev) => ({ ...prev, [row.leaveType.id]: plan.error }));
      return false;
    }
    try {
      if (plan.kind === "adjust") {
        const after = plan.newEntitled + row.deferred - row.used;
        let allowNegative = false;
        if (after < 0) {
          if (!window.confirm(`${row.leaveType.name}已用 ${formatLeaveDuration(row.used, perDay)}，額度改成 ${formatLeaveDuration(plan.newEntitled, perDay)} 後剩餘會變成負數（超用）。仍要儲存嗎？`)) {
            return false;
          }
          allowNegative = true;
        }
        await adjustLeaveBalance({ ...plan.body, allowNegative: allowNegative || undefined });
      } else {
        await putLeaveBalance(plan.body);
      }
      return true;
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [row.leaveType.id]: apiErrorMessage(err, "儲存失敗") }));
      return false;
    }
  }

  async function save(targets: QuotaRow[]) {
    if (saving || targets.length === 0) return;
    setSaving(true);
    setMessage(null);
    let ok = 0;
    const done: string[] = [];
    for (const row of targets) {
      if (await saveRow(row)) {
        ok += 1;
        done.push(row.leaveType.id);
      }
    }
    setEdits((prev) => {
      const next = { ...prev };
      for (const id of done) delete next[id];
      return next;
    });
    if (ok > 0) {
      setMessage(`已儲存 ${ok} 個假別的額度${ok < targets.length ? `，${targets.length - ok} 個未儲存（見該列訊息）` : ""}`);
      await load();
    }
    setSaving(false);
  }

  const yearOptions = [thisYear - 2, thisYear - 1, thisYear, thisYear + 1];

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900">休假額度</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            每個假別的本期給假額度（以 1 天 = {perDay ?? 8} 小時換算存成小時）。已用＝已核准、簽核中不扣；剩餘＝額度＋遞延−已用。
            修改後員工的「我的假別額度」、請假送單與簽核畫面同步生效。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label htmlFor="leave-quota-year" className="text-sm text-gray-600">
            年度
          </label>
          <select
            id="leave-quota-year"
            className={`${inputCls} w-28`}
            value={year}
            onChange={(e) => {
              setYear(Number(e.target.value));
              setEdits({});
              setRowErrors({});
              setSelectedBucket({});
              setMessage(null);
            }}
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y} 年
              </option>
            ))}
          </select>
        </div>
      </div>

      {inactive && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">這位員工已非在職，額度僅供查看、不可修改。</p>
      )}
      {detail && !detail.canAdjust && (
        <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">只有 HR 與平台管理員可以修改假別額度。</p>
      )}

      {loadError && (
        <div className="mt-3">
          <ErrorText>{loadError}</ErrorText>
        </div>
      )}
      {loading && !detail ? (
        <p className="mt-4 text-sm text-gray-400">載入中…</p>
      ) : rows.length === 0 ? (
        <div className="mt-4">
          <Empty>這個租戶還沒有設定任何假別</Empty>
        </div>
      ) : (
        <div className="mt-4 -mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                <th className="py-2 pr-3 font-medium">假別</th>
                <th className="py-2 pr-3 font-medium">額度（天＋時）</th>
                <th className="py-2 pr-3 font-medium">已用</th>
                <th className="py-2 pr-3 font-medium">簽核中</th>
                <th className="py-2 pr-3 font-medium">剩餘</th>
                <th className="py-2 pr-3 font-medium">調整原因</th>
                {editable && <th className="py-2 font-medium" aria-label="動作" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = row.leaveType.id;
                const edit = editOf(row);
                const dirty = quotaEditDirty(row, edits[id], perDay);
                const preview = quotaInputToHours(edit.days, edit.hours, perDay);
                const hint = annualLeaveHint(grant, id, perDay);
                const err = rowErrors[id];
                return (
                  <tr key={id} className="border-b border-gray-100 align-top" data-testid={`leave-quota-row-${row.leaveType.code}`}>
                    <td className="py-3 pr-3">
                      <div className="font-medium text-gray-900">{row.leaveType.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {row.hasQuota ? (
                          row.bucket?.source ? <Pill tone={row.bucket.source === "auto" ? "green" : "gray"}>{row.bucket.source === "auto" ? "系統自動給假" : balanceSourceLabel(row.bucket.source)}</Pill> : null
                        ) : (
                          <Pill tone="blue">{unlimitedLabel(row.leaveType)}</Pill>
                        )}
                      </div>
                      {row.bucketOptions.length > 1 ? (
                        <select
                          aria-label={`${row.leaveType.name}期間`}
                          className="mt-1 rounded border border-gray-200 px-1 py-0.5 text-xs text-gray-600"
                          value={row.bucket?.id ?? ""}
                          onChange={(e) => {
                            setSelectedBucket((prev) => ({ ...prev, [id]: e.target.value }));
                            setEdits((prev) => {
                              const next = { ...prev };
                              delete next[id];
                              return next;
                            });
                          }}
                        >
                          {row.bucketOptions.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="mt-1 text-xs text-gray-400">
                          {row.bucket ? `期間 ${row.periodStart} ～ ${row.periodEnd}` : `尚未設定（儲存後為 ${year} 年度 1/1～12/31）`}
                        </div>
                      )}
                      {hint && <p className="mt-1 max-w-xs text-xs text-emerald-700">{hint}</p>}
                    </td>
                    <td className="py-3 pr-3">
                      {editable ? (
                        <>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              aria-label={`${row.leaveType.name}天數`}
                              className={`${inputCls} w-20`}
                              value={edit.days}
                              onChange={(e) => setEdit(row, { days: e.target.value })}
                            />
                            <span className="text-gray-500">天</span>
                            <input
                              type="number"
                              min="0"
                              step="0.5"
                              inputMode="decimal"
                              aria-label={`${row.leaveType.name}時數`}
                              className={`${inputCls} w-20`}
                              value={edit.hours}
                              onChange={(e) => setEdit(row, { hours: e.target.value })}
                            />
                            <span className="text-gray-500">時</span>
                          </div>
                          <p className="mt-1 text-xs text-gray-400">
                            {preview === null ? "請輸入不小於 0 的數字" : `= ${preview} 小時${preview === 0 ? "（0＝不限額）" : ""}`}
                            {row.deferred > 0 ? `・另有遞延 ${formatLeaveDuration(row.deferred, perDay)}` : ""}
                          </p>
                        </>
                      ) : (
                        <span>
                          {row.hasQuota ? formatLeaveDuration(row.entitled, perDay) : "—"}
                          {row.deferred > 0 ? `（遞延 ${formatLeaveDuration(row.deferred, perDay)}）` : ""}
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-3 whitespace-nowrap">{formatLeaveDuration(row.used, perDay)}</td>
                    <td className="py-3 pr-3 whitespace-nowrap">{row.pending > 0 ? formatLeaveDuration(row.pending, perDay) : "—"}</td>
                    <td className="py-3 pr-3 whitespace-nowrap">
                      {row.hasQuota ? (
                        <>
                          <div className={row.remaining < 0 ? "font-medium text-red-600" : "text-gray-900"}>{formatLeaveRemaining(row.remaining, perDay)}</div>
                          <div className="text-xs text-gray-400">
                            {row.remaining} 小時・約 {approxDays(row.remaining, perDay)} 天
                          </div>
                        </>
                      ) : (
                        <span className="text-gray-400">不限額</span>
                      )}
                    </td>
                    <td className="py-3 pr-3">
                      {editable ? (
                        <input
                          type="text"
                          maxLength={QUOTA_REASON_MAX}
                          aria-label={`${row.leaveType.name}調整原因`}
                          placeholder={dirty ? "必填，例如：依年資補給" : "修改額度時必填"}
                          className={`${inputCls} w-full min-w-[10rem]`}
                          value={edit.reason}
                          onChange={(e) => setEdit(row, { reason: e.target.value })}
                        />
                      ) : (
                        <span className="text-xs text-gray-500">{row.bucket?.note ?? "—"}</span>
                      )}
                      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
                    </td>
                    {editable && (
                      <td className="py-3 whitespace-nowrap">
                        <Button variant="secondary" size="sm" disabled={!dirty || saving} onClick={() => void save([row])}>
                          儲存
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Link href={leaveDetailHref(employeeId, year)} className="text-sm text-gray-600 hover:underline">
          查看調整歷程與餘額桶明細 →
        </Link>
        {editable && (
          <div className="flex items-center gap-2">
            {message && <span className="text-sm text-green-600">{message}</span>}
            <Button variant="primary" loading={saving} disabled={dirtyRows.length === 0} onClick={() => void save(dirtyRows)}>
              全部儲存{dirtyRows.length > 0 ? `（${dirtyRows.length}）` : ""}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
