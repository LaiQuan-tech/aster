"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, Empty, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import type { Employee } from "@/lib/admin-api";
import { PROJECT_MEMBER_ROLE_LABELS, PROJECT_MEMBER_ROLE_ORDER, memberRoleLabel, saveProjectShareRevision, type ProjectMember, type ProjectMemberRole } from "@/lib/projects-api";
import { humanizeBonusEditError } from "@/lib/projects-ext-api";
import { calculateProjectShares, defaultPctForRole, hydrateShareDraft, orderShareMembers, pctAfterRoleChange, type ShareDraftMember } from "@/lib/project-share-calculation";
import { fmtMoney, type Setter } from "./shared";

/** 員工下拉只需要這三個欄位（ESS 老闆頁沒有完整員工名冊，用成員名單湊）。 */
type EmployeeOption = Pick<Employee, "id" | "name" | "emp_no">;

interface MembersCardProps {
  projectId: string;
  members: ProjectMember[];
  emps: EmployeeOption[];
  canBonus: boolean;
  /** 分潤改版 #6：只有老闆（或 platform_admin）能改獎金比例與趴數；其他看得到的人只能維護名單。 */
  canEditBonus?: boolean;
  bossConfigured?: boolean;
  /** 本案各角色分潤趴數（申請單；本案未設定時呼叫端退回租戶的新專案起始值，見 effectiveRoleSharePct）；新增成員／改角色時帶入（仍需老闆存檔）。 */
  defaultSharePctByRole?: Partial<Record<ProjectMemberRole, number>>;
  contractAmount: number | null;
  receivedAmount: number;
  /** 目前累計毛利（估算服務）；有值時獎金總額＝max(0,毛利)×比例（毛利制）。 */
  grossProfit?: number | null;
  bonusRatePct: number | null;
  /**
   * 專案毛利只有老闆／platform_admin／授權 HR 看得到（業主 2026-10-26）。true＝呼叫者看不到毛利（未授權 HR、經理／主辦／部門主管）：
   * 不在本機推算獎金總額（會反推出毛利），每人金額改顯示後端估算值。
   */
  profitHidden?: boolean;
  /** false＝不能換人／加人／移除（ESS 老闆頁沒有員工名冊，只調比例與角色）。預設 true。 */
  allowRosterEdit?: boolean;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

function columnTitle(member: ShareDraftMember, members: ShareDraftMember[]): string {
  if (member.roleInProject === "member") {
    const position = members.filter((item) => item.roleInProject === "member").findIndex((item) => item.employeeId === member.employeeId);
    return `組員 ${position + 1}`;
  }
  return PROJECT_MEMBER_ROLE_LABELS[member.roleInProject];
}

/** Excel 橫向專案分潤編輯器：全部變更先留在本機，最後以一個 revision 原子儲存。 */
export function MembersCard({
  projectId, members, emps, canBonus, canEditBonus = false, bossConfigured = true, defaultSharePctByRole,
  contractAmount, receivedAmount, grossProfit, bonusRatePct, profitHidden = false, allowRosterEdit = true, setError, load,
}: MembersCardProps) {
  const [draft, setDraft] = useState(() => hydrateShareDraft(members, bonusRatePct));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [newEmployeeId, setNewEmployeeId] = useState("");
  const pctLocked = !canEditBonus;

  useEffect(() => setDraft(hydrateShareDraft(members, bonusRatePct)), [members, bonusRatePct]);

  const orderedMembers = useMemo(() => orderShareMembers(draft.members), [draft.members]);
  const availableEmployees = useMemo(() => emps.filter((emp) => !draft.members.some((member) => member.employeeId === emp.id)), [draft.members, emps]);
  const calculation = useMemo(
    () => calculateProjectShares({ contractAmount: profitHidden ? null : contractAmount, bonusRatePct: draft.bonusRatePct, members: orderedMembers, grossProfit: profitHidden ? null : grossProfit }),
    [contractAmount, draft.bonusRatePct, orderedMembers, grossProfit, profitHidden],
  );
  const paidByEmployee = useMemo(() => new Map(members.map((m) => [m.employeeId, m.paidAmount ?? null])), [members]);
  const serverAmountByEmployee = useMemo(() => new Map(members.map((m) => [m.employeeId, m.estimatedAmount ?? m.computedAmount ?? null])), [members]);
  /** 伺服器上趴數或金額 > 0 的成員：移除＝改分潤，只有老闆（業主 2026-10-26）。 */
  const hasShareOnServer = useMemo(
    () => new Set(members.filter((m) => (m.sharePct ?? 0) > 0 || (m.shareAmount ?? 0) > 0).map((m) => m.employeeId)),
    [members],
  );

  function patchMember(employeeId: string, patch: Partial<ShareDraftMember>) {
    setDraft((current) => ({ ...current, members: current.members.map((member) => member.employeeId === employeeId ? { ...member, ...patch } : member) }));
  }

  function changeRole(member: ShareDraftMember, role: ProjectMemberRole) {
    // 老闆：趴數仍是原角色預設值（沒手動改過）就跟著換成新角色的預設；非老闆只換角色、趴數不動。
    const sharePct = canEditBonus ? pctAfterRoleChange(member.sharePct, member.roleInProject, role, defaultSharePctByRole) : member.sharePct;
    patchMember(member.employeeId, { roleInProject: role, sharePct });
  }

  function addMember() {
    if (!newEmployeeId) return setError(availableEmployees.length === 0 ? "沒有其他可加入的在職員工" : "請先選擇公司人員");
    const employee = availableEmployees.find((emp) => emp.id === newEmployeeId);
    if (!employee) return setError("選擇的人員已在本專案中");
    // 新成員預設角色＝組員；老闆帶入組員預設趴數，其他人一律 0（由老闆另行設定）。
    const sharePct = canEditBonus ? defaultPctForRole(defaultSharePctByRole, "member") : 0;
    setDraft((current) => ({
      ...current,
      members: [...current.members, { employeeId: employee.id, name: employee.name, empNo: employee.emp_no, roleInProject: "member", sharePct }],
    }));
    setNewEmployeeId("");
    setError(null);
  }

  async function saveRevision() {
    const trimmedReason = reason.trim();
    if (!trimmedReason) return setError(canEditBonus ? "請填寫本次分潤調整原因" : "請填寫本次成員異動原因");
    if (!calculation.isValid) return setError(calculation.sharePctTotal > 100 ? "分潤比例合計不可超過 100%" : "分潤比例不可小於 0");
    if (draft.bonusRatePct != null && (draft.bonusRatePct < 0 || draft.bonusRatePct > 100)) return setError("專案獎金比例必須介於 0% 與 100% 之間");

    setSaving(true);
    setError(null);
    try {
      await saveProjectShareRevision(projectId, {
        // 看不到獎金比例的人（profitHidden）不送這個鍵＝後端沿用目前比例。
        ...(profitHidden ? {} : { bonusRatePct: draft.bonusRatePct }),
        members: draft.members.map((member) => ({
          ...(member.memberId ? { memberId: member.memberId } : {}), employeeId: member.employeeId, roleInProject: member.roleInProject, sharePct: member.sharePct,
        })),
        reason: trimmedReason,
      });
      setReason("");
      await load();
    } catch (err) {
      setError(humanizeBonusEditError(err instanceof Error ? err.message : "儲存分潤版本失敗"));
    } finally {
      setSaving(false);
    }
  }

  if (!canBonus) {
    return <Card>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-gray-700">專案成員</h2><span className="text-xs text-gray-400">分潤趴數與金額不在您的權限範圍內</span></div>
      {members.length === 0 ? <Empty>尚無成員</Empty> : <div className="flex flex-wrap gap-2">{members.map((member) => <span key={member.id} className="rounded-full bg-gray-100 px-3 py-1 text-sm">{member.name ?? member.employeeId} · {memberRoleLabel(member.roleInProject)}</span>)}</div>}
    </Card>;
  }

  const lockedHint = bossConfigured ? "分潤比例僅老闆可修改" : "尚未指定老闆：分潤比例僅老闆可修改，請先到公司設定指定老闆";
  const showProfit = grossProfit != null && !profitHidden;
  const headers = ["合約金額", "已收款", ...(showProfit ? ["目前毛利"] : []), "獎金比例", "獎金總額"];

  return <Card>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-gray-700">專案獎金與分潤</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          {profitHidden ? "專案毛利、獎金比例與總額僅老闆與經授權人員可見（一般成員只看得到自己的預估應得）。" : showProfit ? "獎金總額＝目前毛利 × 獎金比例（隨入帳與成本累計變動）。" : "修改比例後金額即時連動。"}已發放歷史不變，差額會在下一次撥款調整。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {pctLocked && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800">{lockedHint}</span>}
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${calculation.isValid ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>比例合計 {calculation.sharePctTotal}%</span>
      </div>
    </div>

    <div className="overflow-x-auto rounded-lg border border-black">
      <table className="min-w-max border-collapse text-center text-xs">
        <thead className="bg-gray-100 font-semibold text-gray-800"><tr>
          {headers.map((title) => <th key={title} className="border border-black px-3 py-2">{title}</th>)}
          {calculation.members.map((member) => <th key={member.employeeId} className="border border-black px-3 py-2">{columnTitle(member, orderedMembers)}</th>)}
          <th className="border border-black px-3 py-2">尚未分配</th>
        </tr></thead>
        <tbody><tr>
          <td className="border border-black px-3 py-3 text-right text-sm">{fmtMoney(contractAmount)}</td>
          <td className="border border-black px-3 py-3 text-right text-sm">{fmtMoney(receivedAmount)}</td>
          {showProfit && <td className="border border-black px-3 py-3 text-right text-sm">{fmtMoney(grossProfit)}</td>}
          <td className="border border-black p-2">{profitHidden ? <div className="text-sm text-gray-400" title="獎金比例僅老闆與經授權人員可見">—</div> : <div className="flex items-center justify-center gap-1"><input aria-label="專案獎金比例" className="w-20 rounded border border-gray-300 px-2 py-1 text-right disabled:bg-gray-50 disabled:text-gray-500" type="number" min="0" max="100" step="0.01" disabled={pctLocked} title={pctLocked ? lockedHint : undefined} value={draft.bonusRatePct ?? ""} onChange={(event) => setDraft((current) => ({ ...current, bonusRatePct: event.target.value === "" ? null : Number(event.target.value) }))} />%</div>}</td>
          <td className="border border-black px-3 py-3 text-right text-sm font-semibold">{fmtMoney(calculation.bonusTotal)}</td>
          {calculation.members.map((member) => {
            const paid = paidByEmployee.get(member.employeeId);
            return <td key={member.employeeId} className="min-w-44 border border-black p-2 align-top">
              {allowRosterEdit ? (
                <select aria-label={`${columnTitle(member, orderedMembers)}員工`} className="w-full rounded border border-gray-300 px-2 py-1" value={member.employeeId} onChange={(event) => patchMember(member.employeeId, { employeeId: event.target.value, name: emps.find((emp) => emp.id === event.target.value)?.name ?? null })}>
                  {emps.filter((emp) => emp.id === member.employeeId || !draft.members.some((item) => item.employeeId === emp.id)).map((emp) => <option key={emp.id} value={emp.id}>{emp.name}{emp.emp_no ? `（${emp.emp_no}）` : ""}</option>)}
                </select>
              ) : (
                <p className="px-2 py-1 text-sm font-medium">{member.name ?? member.employeeId}</p>
              )}
              <select aria-label={`${member.name ?? member.employeeId}角色`} className="mt-1 w-full rounded border border-gray-300 px-2 py-1" value={member.roleInProject} onChange={(event) => changeRole(member, event.target.value as ProjectMemberRole)}>
                {PROJECT_MEMBER_ROLE_ORDER.map((role) => <option key={role} value={role}>{PROJECT_MEMBER_ROLE_LABELS[role]}</option>)}
              </select>
              <div className="mt-1 flex items-center justify-center gap-1"><input aria-label={`${member.name ?? member.employeeId}分潤比例`} className="w-20 rounded border border-gray-300 px-2 py-1 text-right disabled:bg-gray-50 disabled:text-gray-500" type="number" min="0" max="100" step="0.01" disabled={pctLocked} title={pctLocked ? lockedHint : undefined} value={member.sharePct} onChange={(event) => patchMember(member.employeeId, { sharePct: Number(event.target.value) })} />%</div>
              <p className="mt-1 text-right text-sm font-medium">{fmtMoney(member.amount ?? (profitHidden ? serverAmountByEmployee.get(member.employeeId) ?? null : null))}</p>
              {paid != null && <p className="text-right text-[11px] text-gray-500">已發 {fmtMoney(paid)}</p>}
              {allowRosterEdit && !(pctLocked && hasShareOnServer.has(member.employeeId)) && <button type="button" className="mt-1 text-[11px] text-red-600 hover:underline" onClick={() => setDraft((current) => ({ ...current, members: current.members.filter((item) => item.employeeId !== member.employeeId) }))}>移除</button>}
            </td>;
          })}
          <td className={`border border-black px-3 py-3 text-right text-sm font-semibold ${calculation.unallocatedPct < 0 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}><div>{calculation.unallocatedPct}%</div><div>{fmtMoney(calculation.unallocatedAmount)}</div></td>
        </tr></tbody>
      </table>
    </div>

    <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
      {allowRosterEdit && <>
        <div className="min-w-60"><label className={labelCls}>選擇公司人員</label><select className={inputCls} value={newEmployeeId} onChange={(event) => setNewEmployeeId(event.target.value)} disabled={availableEmployees.length === 0}><option value="">{availableEmployees.length === 0 ? "沒有其他可加入人員" : "請選擇員工"}</option>{availableEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.emp_no ? `（${employee.emp_no}）` : ""}</option>)}</select></div>
        <button type="button" className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" onClick={addMember} disabled={availableEmployees.length === 0}>＋ 加入本專案</button>
      </>}
      <div className="min-w-64 flex-1"><label className={labelCls}>變更原因（必填）</label><input className={inputCls} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={canEditBonus ? "例：本期改由王員主辦，調整後續分潤" : "例：新增組員，趴數待老闆設定"} /></div>
      <PrimaryButton onClick={saveRevision} disabled={saving || !calculation.isValid}>{saving ? "儲存中…" : canEditBonus ? "整批儲存分潤" : "儲存成員名單"}</PrimaryButton>
    </div>
    {pctLocked && allowRosterEdit && <p className="mt-2 text-xs text-gray-500">您可以加入成員、調整角色，並移除趴數為 0 的成員；新成員趴數為 0，由老闆設定分潤比例。移除有趴數的成員須由老闆操作。</p>}
  </Card>;
}
