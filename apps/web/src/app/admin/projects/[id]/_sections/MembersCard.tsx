"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, Empty, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import type { Employee } from "@/lib/admin-api";
import { PROJECT_MEMBER_ROLE_LABELS, PROJECT_MEMBER_ROLE_ORDER, memberRoleLabel, saveProjectShareRevision, type ProjectMember, type ProjectMemberRole } from "@/lib/projects-api";
import { calculateProjectShares, hydrateShareDraft, orderShareMembers, type ShareDraftMember } from "@/lib/project-share-calculation";
import { fmtMoney, type Setter } from "./shared";

interface MembersCardProps {
  projectId: string;
  members: ProjectMember[];
  emps: Employee[];
  canBonus: boolean;
  contractAmount: number | null;
  receivedAmount: number;
  bonusRatePct: number | null;
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
export function MembersCard({ projectId, members, emps, canBonus, contractAmount, receivedAmount, bonusRatePct, setError, load }: MembersCardProps) {
  const [draft, setDraft] = useState(() => hydrateShareDraft(members, bonusRatePct));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(hydrateShareDraft(members, bonusRatePct)), [members, bonusRatePct]);

  const orderedMembers = useMemo(() => orderShareMembers(draft.members), [draft.members]);
  const calculation = useMemo(() => calculateProjectShares({ contractAmount, bonusRatePct: draft.bonusRatePct, members: orderedMembers }), [contractAmount, draft.bonusRatePct, orderedMembers]);

  function patchMember(employeeId: string, patch: Partial<ShareDraftMember>) {
    setDraft((current) => ({ ...current, members: current.members.map((member) => member.employeeId === employeeId ? { ...member, ...patch } : member) }));
  }

  function addMember() {
    const employee = emps.find((emp) => !draft.members.some((member) => member.employeeId === emp.id));
    if (!employee) return setError("沒有其他可加入的在職員工");
    setDraft((current) => ({
      ...current,
      members: [...current.members, { employeeId: employee.id, name: employee.name, empNo: employee.emp_no, roleInProject: "member", sharePct: 0 }],
    }));
  }

  async function saveRevision() {
    const trimmedReason = reason.trim();
    if (!trimmedReason) return setError("請填寫本次分潤調整原因");
    if (!calculation.isValid) return setError(calculation.sharePctTotal > 100 ? "分潤比例合計不可超過 100%" : "分潤比例不可小於 0");
    if (draft.bonusRatePct != null && (draft.bonusRatePct < 0 || draft.bonusRatePct > 100)) return setError("專案獎金比例必須介於 0% 與 100% 之間");

    setSaving(true);
    setError(null);
    try {
      await saveProjectShareRevision(projectId, {
        bonusRatePct: draft.bonusRatePct,
        members: draft.members.map((member) => ({
          ...(member.memberId ? { memberId: member.memberId } : {}), employeeId: member.employeeId, roleInProject: member.roleInProject, sharePct: member.sharePct,
        })),
        reason: trimmedReason,
      });
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存分潤版本失敗");
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

  return <Card>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="text-sm font-semibold text-gray-700">專案獎金與分潤</h2><p className="mt-0.5 text-xs text-gray-500">修改比例後金額即時連動；已發放歷史不變，差額會在下一次撥款調整。</p></div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${calculation.isValid ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>比例合計 {calculation.sharePctTotal}%</span>
    </div>

    <div className="overflow-x-auto rounded-lg border border-black">
      <table className="min-w-max border-collapse text-center text-xs">
        <thead className="bg-gray-100 font-semibold text-gray-800"><tr>
          {['合約金額', '已收款', '獎金比例', '獎金總額'].map((title) => <th key={title} className="border border-black px-3 py-2">{title}</th>)}
          {calculation.members.map((member) => <th key={member.employeeId} className="border border-black px-3 py-2">{columnTitle(member, orderedMembers)}</th>)}
          <th className="border border-black px-3 py-2">尚未分配</th>
        </tr></thead>
        <tbody><tr>
          <td className="border border-black px-3 py-3 text-right text-sm">{fmtMoney(contractAmount)}</td>
          <td className="border border-black px-3 py-3 text-right text-sm">{fmtMoney(receivedAmount)}</td>
          <td className="border border-black p-2"><div className="flex items-center justify-center gap-1"><input aria-label="專案獎金比例" className="w-20 rounded border border-gray-300 px-2 py-1 text-right" type="number" min="0" max="100" step="0.01" value={draft.bonusRatePct ?? ""} onChange={(event) => setDraft((current) => ({ ...current, bonusRatePct: event.target.value === "" ? null : Number(event.target.value) }))} />%</div></td>
          <td className="border border-black px-3 py-3 text-right text-sm font-semibold">{fmtMoney(calculation.bonusTotal)}</td>
          {calculation.members.map((member) => <td key={member.employeeId} className="min-w-44 border border-black p-2 align-top">
            <select aria-label={`${columnTitle(member, orderedMembers)}員工`} className="w-full rounded border border-gray-300 px-2 py-1" value={member.employeeId} onChange={(event) => patchMember(member.employeeId, { employeeId: event.target.value, name: emps.find((emp) => emp.id === event.target.value)?.name ?? null })}>
              {emps.filter((emp) => emp.id === member.employeeId || !draft.members.some((item) => item.employeeId === emp.id)).map((emp) => <option key={emp.id} value={emp.id}>{emp.name}{emp.emp_no ? `（${emp.emp_no}）` : ""}</option>)}
            </select>
            <select aria-label={`${member.name ?? member.employeeId}角色`} className="mt-1 w-full rounded border border-gray-300 px-2 py-1" value={member.roleInProject} onChange={(event) => patchMember(member.employeeId, { roleInProject: event.target.value as ProjectMemberRole })}>
              {PROJECT_MEMBER_ROLE_ORDER.map((role) => <option key={role} value={role}>{PROJECT_MEMBER_ROLE_LABELS[role]}</option>)}
            </select>
            <div className="mt-1 flex items-center justify-center gap-1"><input aria-label={`${member.name ?? member.employeeId}分潤比例`} className="w-20 rounded border border-gray-300 px-2 py-1 text-right" type="number" min="0" max="100" step="0.01" value={member.sharePct} onChange={(event) => patchMember(member.employeeId, { sharePct: Number(event.target.value) })} />%</div>
            <p className="mt-1 text-right text-sm font-medium">{fmtMoney(member.amount)}</p>
            <button type="button" className="mt-1 text-[11px] text-red-600 hover:underline" onClick={() => setDraft((current) => ({ ...current, members: current.members.filter((item) => item.employeeId !== member.employeeId) }))}>移除</button>
          </td>)}
          <td className={`border border-black px-3 py-3 text-right text-sm font-semibold ${calculation.unallocatedPct < 0 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}><div>{calculation.unallocatedPct}%</div><div>{fmtMoney(calculation.unallocatedAmount)}</div></td>
        </tr></tbody>
      </table>
    </div>

    <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
      <button type="button" className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50" onClick={addMember}>＋ 新增成員</button>
      <div className="min-w-64 flex-1"><label className={labelCls}>變更原因（必填）</label><input className={inputCls} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例：本期改由王員主辦，調整後續分潤" /></div>
      <PrimaryButton onClick={saveRevision} disabled={saving || !calculation.isValid}>{saving ? "儲存中…" : "整批儲存分潤"}</PrimaryButton>
    </div>
  </Card>;
}
