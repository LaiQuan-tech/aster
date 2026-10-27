"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Empty, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import type { Employee } from "@/lib/admin-api";
import {
  PROJECT_MEMBER_ROLE_LABELS,
  PROJECT_MEMBER_ROLE_ORDER,
  memberRoleLabel,
  saveProjectShareRevision,
  type ProjectBonusEstimateSummary,
  type ProjectMember,
  type ProjectMemberRole,
  type ShareMode,
} from "@/lib/projects-api";
import { humanizeBonusEditError } from "@/lib/projects-ext-api";
import {
  newShareRow,
  orderShareMembers,
  shareBonusTotalOf,
  shareModeConversionNotice,
  shareRevisionBodyOf,
  shareRowAfterEmployeeChange,
  shareRowAfterRoleChange,
  shareRowAmount,
  shareRowTotals,
  shareRowsOf,
  validateShareRevisionInput,
  validateShareRows,
  type ShareRow,
} from "@/lib/project-share-calculation";
import { fmtMoney, type Setter } from "./shared";

/** 員工下拉只需要這三個欄位（ESS 老闆頁沒有完整員工名冊，用成員名單湊）。 */
type EmployeeOption = Pick<Employee, "id" | "name" | "emp_no">;

interface BonusShareCardProps {
  projectId: string;
  /** 專案目前的分潤模式；fixed_amount＝舊的「指定金額」專案，老闆儲存後轉成百分比。 */
  shareMode: ShareMode | string;
  members: ProjectMember[];
  emps: EmployeeOption[];
  /** 看得到分潤（access.bonus）；false＝只顯示唯讀成員名單（角色＋姓名），不顯示％與金額。 */
  canBonus: boolean;
  /** 只有老闆／platform_admin 能改獎金比例與％（bonusEditAccessOf）；其他看得到的人只能維護名單。 */
  canEditBonus: boolean;
  bossConfigured: boolean;
  /** 本案各角色預設％（share_pct_by_role；未設定退回租戶起始值）。只在新增一列／改角色時帶入。 */
  defaultSharePctByRole: Partial<Record<ProjectMemberRole, number>>;
  /** 未稅合約額（申請單同一個數字）；Excel 含稅入帳制的獎金總額基礎。 */
  contractAmount: number | null;
  /** GET /projects/:id/members 的 bonusEstimate（只給看得到毛利的人）。 */
  estimate: ProjectBonusEstimateSummary | null;
  bonusRatePct: number | null;
  /** 舊制手填獎金池（看得到毛利才有）；只用來提示。 */
  legacyBonusPool: number | null;
  /** 看不到毛利／獎金比例（經理、主辦、未授權 HR）：不在本機推算獎金總額，每人金額顯示後端估算。 */
  profitHidden: boolean;
  /** 本案已有核准／發放過的獎金紀錄 → 變更原因必填。 */
  reasonRequired: boolean;
  /** false＝不能換人／加列／移除（ESS 老闆頁沒有員工名冊，只調比例與角色）。 */
  allowRosterEdit?: boolean;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

const cell = "border-b border-gray-200 px-2 py-2";

/**
 * 專案獎金分潤（2026-10-27 業主要求簡化：原「分潤模式」「各角色分潤趴數」「專案獎金與分潤」三張卡合一）。
 * 頂部獎金比例＋獎金總額；表格每列＝角色｜員工｜％｜試算金額｜移除；「儲存」一次送出比例＋全部成員。
 * 存的％就是 project_members.share_pct，獎金引擎拆給每個人用的就是這個值。
 */
export function BonusShareCard({
  projectId, shareMode, members, emps, canBonus, canEditBonus, bossConfigured, defaultSharePctByRole,
  contractAmount, estimate, bonusRatePct, legacyBonusPool, profitHidden, reasonRequired, allowRosterEdit = true, setError, load,
}: BonusShareCardProps) {
  const [rows, setRows] = useState<ShareRow[]>(() => shareRowsOf(members));
  const [rate, setRate] = useState<number | null>(bonusRatePct);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => setRows(shareRowsOf(members)), [members]);
  useEffect(() => setRate(bonusRatePct), [bonusRatePct]);

  const isFixed = shareMode !== "pool_pct";
  const convertToPool = isFixed && canEditBonus;
  const pctLocked = !canEditBonus;
  const byMemberId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const byEmployee = useMemo(() => new Map(members.map((m) => [m.employeeId, m])), [members]);
  /** 伺服器上％或金額 > 0 的成員：移除或換人＝改分潤，只有老闆。 */
  const hasShareOnServer = (row: ShareRow) => {
    const m = row.memberId ? byMemberId.get(row.memberId) : undefined;
    return !!m && ((m.sharePct ?? 0) > 0 || (m.shareAmount ?? 0) > 0);
  };

  const total = useMemo(
    () => shareBonusTotalOf({ estimate: profitHidden ? null : estimate, contractUntaxed: contractAmount, bonusRatePct: rate }),
    [estimate, contractAmount, rate, profitHidden],
  );
  const totals = shareRowTotals(rows, total.bonusTotal);
  const rowError = validateShareRows(rows);

  if (!canBonus) {
    // 沒有分潤權限（例如會計）：唯讀名單，只顯示角色＋姓名。
    return <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-gray-700">專案成員</h2><span className="text-xs text-gray-400">分潤比例與金額不在您的權限範圍內</span></div>
      {members.length === 0 ? <Empty>尚無成員</Empty> : <div className="flex flex-wrap gap-2">{orderShareMembers(members).map((m) => <span key={m.id} className="rounded-full bg-gray-100 px-3 py-1 text-sm">{memberRoleLabel(m.roleInProject)} · {m.name ?? m.employeeId}</span>)}</div>}
    </Card>;
  }

  function patchRow(key: string, next: (row: ShareRow) => ShareRow) {
    setRows((current) => current.map((r) => (r.key === key ? next(r) : r)));
  }

  function addRow() {
    seq.current += 1;
    setRows((current) => [...current, newShareRow(`new-${seq.current}`, defaultSharePctByRole, canEditBonus)]);
  }

  async function save() {
    const err = rowError ?? validateShareRevisionInput({ bonusRatePct: profitHidden ? null : rate, convertToPool, reasonRequired, reason });
    if (err) return setError(err);
    setSaving(true);
    setError(null);
    try {
      const res = await saveProjectShareRevision(projectId, shareRevisionBodyOf({ rows, bonusRatePct: rate, includeRate: !profitHidden, reason, convertToPool }));
      setReason("");
      await load();
      // load() 會清掉頁面錯誤並讓本卡重掛，所以轉換沒完成的提示放在 load 之後、用頁面層的 setError。
      const notice = shareModeConversionNotice(res);
      if (notice) setError(notice);
    } catch (e) {
      setError(humanizeBonusEditError(e instanceof Error ? e.message : "儲存分潤失敗"));
    } finally {
      setSaving(false);
    }
  }

  const lockedHint = bossConfigured ? "獎金比例與各成員％僅老闆可修改" : "尚未指定老闆：獎金比例與各成員％僅老闆可修改，請先到公司設定指定老闆";
  const basisHint = total.basis === "gross_profit"
    ? `獎金總額＝目前累計毛利${total.base != null ? ` ${fmtMoney(total.base)}` : ""} × 獎金比例。`
    : `獎金總額＝含稅合約額${total.base != null ? ` ${fmtMoney(total.base)}` : ""} × 獎金比例。`;

  return <Card>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-gray-700">獎金分潤</h2>
      <div className="flex flex-wrap items-center gap-2">
        {pctLocked && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800">{lockedHint}</span>}
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${totals.sharePctTotal <= 100 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>比例合計 {totals.sharePctTotal}%</span>
      </div>
    </div>

    {isFixed && (
      <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="fixed-amount-notice">
        此專案原為「指定金額」模式（指定金額已停用）。請設定獎金比例與各成員％，{canEditBonus ? "儲存後改為百分比模式。" : "由老闆儲存後改為百分比模式。"}
        已發放的獎金不會變動，下一次撥款會以「新的累計應得 − 已發放」計算差額。
      </p>
    )}
    {!isFixed && bonusRatePct == null && legacyBonusPool != null && !profitHidden && (
      <p className="mb-3 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">此專案目前為舊制（手填獎金池 {fmtMoney(legacyBonusPool)}）；設定獎金比例並儲存後改以比例計算。</p>
    )}

    {/* 頂部：獎金比例＋獎金總額（合約金額、已收款看申請單與金額卡，這裡不重複） */}
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <label className={labelCls} htmlFor={`${projectId}-bonus-rate`}>獎金比例</label>
        {profitHidden ? (
          <p className="py-2 text-sm text-gray-400" title="獎金比例僅老闆與經授權人員可見">—</p>
        ) : (
          <div className="flex items-center gap-1">
            <input id={`${projectId}-bonus-rate`} className="w-24 rounded border border-gray-300 px-2 py-1.5 text-right disabled:bg-gray-50 disabled:text-gray-500" type="number" min="0" max="100" step="0.01" disabled={pctLocked} title={pctLocked ? lockedHint : undefined} value={rate ?? ""} onChange={(e) => setRate(e.target.value === "" ? null : Number(e.target.value))} />
            <span className="text-sm text-gray-600">%</span>
          </div>
        )}
      </div>
      <div>
        <p className={labelCls}>獎金總額</p>
        <p className="py-1.5 text-lg font-semibold text-gray-900" data-testid="bonus-total">{fmtMoney(total.bonusTotal)}</p>
      </div>
    </div>
    <p className="mt-1 text-xs text-gray-500">
      {profitHidden ? "獎金比例與總額僅老闆與經授權人員可見；下方金額為系統估算的累計應得。" : `${basisHint}試算金額＝獎金總額 × 該成員％；實際依入帳進度分次撥款，已發放不變，差額在下一次撥款調整。`}
    </p>

    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead><tr className="border-b border-gray-300 text-left text-xs text-gray-500">
          <th className="px-2 py-2 font-medium">角色</th>
          <th className="px-2 py-2 font-medium">員工</th>
          <th className="px-2 py-2 text-right font-medium">％</th>
          <th className="px-2 py-2 text-right font-medium">試算金額</th>
          <th className="w-14 px-2 py-2" aria-label="操作" />
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-sm text-gray-400">尚無成員，按下方「＋ 新增一列」加入</td></tr>}
          {rows.map((row) => {
            const server = byEmployee.get(row.employeeId);
            const original = row.memberId ? byMemberId.get(row.memberId) : undefined;
            const originalOf = members.find((m) => m.id === row.key);
            const lockedPerson = !allowRosterEdit || (pctLocked && hasShareOnServer(row));
            const label = row.name ?? (row.employeeId || "這一列");
            const amount = profitHidden ? (row.memberId ? server?.estimatedAmount ?? server?.computedAmount ?? null : null) : shareRowAmount(total.bonusTotal, row.sharePct);
            const paid = row.memberId ? server?.paidAmount ?? null : null;
            return <tr key={row.key} className="align-top">
              <td className={cell}>
                <select aria-label={`${label}角色`} className="w-24 rounded border border-gray-300 px-2 py-1.5" value={row.roleInProject} onChange={(e) => patchRow(row.key, (r) => shareRowAfterRoleChange(r, e.target.value as ProjectMemberRole, defaultSharePctByRole, canEditBonus))}>
                  {PROJECT_MEMBER_ROLE_ORDER.map((role) => <option key={role} value={role}>{PROJECT_MEMBER_ROLE_LABELS[role]}</option>)}
                </select>
              </td>
              <td className={cell}>
                {lockedPerson ? (
                  <p className="px-1 py-1.5 font-medium">{row.name ?? row.employeeId}{row.empNo ? <span className="ml-1 text-xs text-gray-400">{row.empNo}</span> : null}</p>
                ) : (
                  <select aria-label={`${PROJECT_MEMBER_ROLE_LABELS[row.roleInProject]}員工`} className="w-full min-w-36 rounded border border-gray-300 px-2 py-1.5" value={row.employeeId} onChange={(e) => {
                    const emp = emps.find((x) => x.id === e.target.value) ?? null;
                    patchRow(row.key, (r) => shareRowAfterEmployeeChange(r, emp, originalOf ? { memberId: originalOf.id, employeeId: originalOf.employeeId } : undefined));
                  }}>
                    <option value="">請選擇員工</option>
                    {emps.filter((emp) => emp.id === row.employeeId || !rows.some((r) => r.employeeId === emp.id)).map((emp) => <option key={emp.id} value={emp.id}>{emp.name}{emp.emp_no ? `（${emp.emp_no}）` : ""}</option>)}
                  </select>
                )}
                {isFixed && original?.shareAmount != null && <p className="px-1 text-[11px] text-gray-500">原指定金額 {fmtMoney(original.shareAmount)}</p>}
              </td>
              <td className={`${cell} text-right`}>
                <div className="flex items-center justify-end gap-1">
                  <input aria-label={`${label}分潤比例`} className="w-20 rounded border border-gray-300 px-2 py-1.5 text-right disabled:bg-gray-50 disabled:text-gray-500" type="number" min="0" max="100" step="0.01" disabled={pctLocked} title={pctLocked ? lockedHint : undefined} value={Number.isFinite(row.sharePct) ? row.sharePct : ""} onChange={(e) => patchRow(row.key, (r) => ({ ...r, sharePct: e.target.value === "" ? 0 : Number(e.target.value) }))} />
                  <span className="text-gray-500">%</span>
                </div>
              </td>
              <td className={`${cell} text-right`}>
                <p className="py-1.5 font-medium">{fmtMoney(amount)}</p>
                {paid != null && paid > 0 && <p className="text-[11px] text-gray-500">已發 {fmtMoney(paid)}</p>}
              </td>
              <td className={`${cell} text-right`}>
                {allowRosterEdit && !(pctLocked && hasShareOnServer(row)) && <button type="button" className="py-1.5 text-xs text-red-600 hover:underline" onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}>移除</button>}
              </td>
            </tr>;
          })}
        </tbody>
        <tfoot className="text-sm">
          <tr className="border-t border-gray-300">
            <td className="px-2 py-2 font-medium text-gray-700" colSpan={2}>合計</td>
            <td className={`px-2 py-2 text-right font-semibold ${totals.sharePctTotal > 100 ? "text-red-700" : "text-gray-900"}`}>{totals.sharePctTotal}%</td>
            <td className="px-2 py-2 text-right font-semibold">{profitHidden ? "—" : fmtMoney(total.bonusTotal == null ? null : total.bonusTotal - (totals.unallocatedAmount ?? 0))}</td>
            <td />
          </tr>
          <tr>
            <td className="px-2 py-1 text-gray-500" colSpan={2}>尚未分配</td>
            <td className={`px-2 py-1 text-right ${totals.unallocatedPct < 0 ? "text-red-700" : "text-amber-700"}`}>{totals.unallocatedPct}%</td>
            <td className="px-2 py-1 text-right text-amber-700">{profitHidden ? "—" : fmtMoney(totals.unallocatedAmount)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
    {allowRosterEdit && <button type="button" className="mt-2 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50" onClick={addRow}>＋ 新增一列</button>}

    <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
      <div className="min-w-64 flex-1">
        <label className={labelCls} htmlFor={`${projectId}-share-reason`}>變更原因（{reasonRequired ? "必填：本案已有核准／發放過的獎金" : "選填"}）</label>
        <input id={`${projectId}-share-reason`} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonRequired ? "例：本期改由王員主辦，調整後續分潤" : "未填會記錄為「初次設定」"} />
      </div>
      <PrimaryButton onClick={save} disabled={saving || totals.sharePctTotal > 100}>{saving ? "儲存中…" : "儲存"}</PrimaryButton>
    </div>
    {rowError && rows.length > 0 && rowError.includes("請選擇員工") && <p className="mt-2 text-xs text-amber-700">{rowError}</p>}
    {pctLocked && allowRosterEdit && <p className="mt-2 text-xs text-gray-500">您可以新增成員、調整角色，並移除比例為 0 的成員；新成員比例為 0，由老闆設定。移除有比例的成員須由老闆操作。</p>}
  </Card>;
}
