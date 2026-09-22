"use client";

import { Card, PrimaryButton, Empty, inputCls, labelCls } from "@/components/admin-ui";
import type { Employee } from "@/lib/admin-api";
import {
  addProjectMember,
  updateProjectMember,
  removeProjectMember,
  memberRoleLabel,
  PROJECT_MEMBER_ROLE_ORDER,
  PROJECT_MEMBER_ROLE_LABELS,
  type ProjectMember,
  type ProjectMemberRole,
} from "@/lib/projects-api";
import { fmtMoney, type Setter } from "./shared";

interface MembersCardProps {
  projectId: string;
  members: ProjectMember[];
  emps: Employee[];
  isPool: boolean;
  /** W4：分潤區可見性。false（會計）＝只看得到成員名單，看不到也改不了分潤。 */
  canBonus: boolean;
  /** pool 模式的 % 加總（提示是否超過 100）。 */
  pctTotal: number;
  newEmp: string;
  setNewEmp: Setter<string>;
  newRole: ProjectMemberRole;
  setNewRole: Setter<ProjectMemberRole>;
  newValue: string;
  setNewValue: Setter<string>;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/**
 * 成員分潤：成員列表（角色下拉／分潤即存／移除）＋新增成員表單。
 *
 * W3（2026-09-23）：角色四值——經理／主辦／支援／組員。經理與主辦屬「負責人層」，
 * 看得到全案分潤、也取得該案的財務權限；支援與組員只看得到自己那筆。新增成員時
 * 沒填趴數，後端會套專案設定裡該角色的預設趴數（見 ProjectSettingsCard）。
 *
 * W4：`canBonus=false`（會計）時整張卡變唯讀——分潤欄與新增成員表單都不畫，
 * 角色也不給改。API 端對這些動作一律 403，畫面先一致，免得按下去才吃閉門羹。
 */
export function MembersCard({
  projectId,
  members,
  emps,
  isPool,
  canBonus,
  pctTotal,
  newEmp,
  setNewEmp,
  newRole,
  setNewRole,
  newValue,
  setNewValue,
  setError,
  load,
}: MembersCardProps) {
  async function addMember() {
    if (!newEmp) {
      setError("請選擇員工");
      return;
    }
    setError(null);
    try {
      const val = newValue ? Number(newValue) : null;
      // 分潤欄留空時**不送這個鍵**，讓後端套該角色的預設趴數；送 null 會被當成
      // 「明確指定沒有分潤」，預設值就不會生效。
      await addProjectMember(projectId, {
        employeeId: newEmp,
        roleInProject: newRole,
        ...(isPool ? (val === null ? {} : { sharePct: val }) : { shareAmount: val }),
      });
      setNewEmp("");
      setNewRole("member");
      setNewValue("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增成員失敗");
    }
  }

  async function saveMemberShare(m: ProjectMember, raw: string) {
    const val = raw === "" ? null : Number(raw);
    setError(null);
    try {
      await updateProjectMember(projectId, m.id, isPool ? { sharePct: val } : { shareAmount: val });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "調整分潤失敗");
    }
  }

  async function changeRole(m: ProjectMember, role: ProjectMemberRole) {
    if (role === m.roleInProject) return;
    setError(null);
    try {
      await updateProjectMember(projectId, m.id, { roleInProject: role });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    }
  }

  async function removeMember(m: ProjectMember) {
    if (!confirm(`確定移除成員「${m.name ?? m.employeeId}」？`)) return;
    setError(null);
    try {
      await removeProjectMember(projectId, m.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "移除失敗");
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">{canBonus ? "成員分潤" : "專案成員"}</h2>
        {!canBonus && <span className="text-xs text-gray-400">分潤趴數與金額不在您的權限範圍內</span>}
        {isPool && canBonus && (
          <span className={`text-xs ${pctTotal > 100 ? "text-red-600" : "text-gray-500"}`}>
            百分比加總 {pctTotal}%{pctTotal > 100 ? "（超過 100%）" : ""}
          </span>
        )}
      </div>

      {members.length === 0 ? (
        <Empty>尚無成員</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-3">成員</th>
                <th className="py-2 pr-3">角色</th>
                {canBonus && <th className="py-2 pr-3">{isPool ? "分潤 %" : "分潤金額"}</th>}
                {canBonus && <th className="py-2 pr-3">實得金額</th>}
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium text-gray-900">
                    {m.name ?? m.employeeId}
                    {m.empNo && <span className="ml-1 text-xs text-gray-400">{m.empNo}</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {canBonus ? (
                      <select
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                        value={m.roleInProject}
                        onChange={(e) => changeRole(m, e.target.value as ProjectMemberRole)}
                        aria-label={`${m.name ?? m.employeeId} 的專案角色`}
                        title="經理／主辦看得到全案分潤，支援／組員只看得到自己那筆"
                      >
                        {PROJECT_MEMBER_ROLE_ORDER.map((role) => (
                          <option key={role} value={role}>{PROJECT_MEMBER_ROLE_LABELS[role]}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-gray-600">{memberRoleLabel(m.roleInProject)}</span>
                    )}
                  </td>
                  {canBonus && (
                    <td className="py-2 pr-3">
                      <input
                        className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm"
                        type="number"
                        min="0"
                        defaultValue={(isPool ? m.sharePct : m.shareAmount) ?? ""}
                        onBlur={(e) => {
                          const cur = isPool ? m.sharePct : m.shareAmount;
                          const v = e.target.value === "" ? null : Number(e.target.value);
                          if (v !== cur) saveMemberShare(m, e.target.value);
                        }}
                      />
                    </td>
                  )}
                  {canBonus && <td className="py-2 pr-3 text-gray-700">{fmtMoney(m.computedAmount)}</td>}
                  <td className="py-2 pr-3">
                    {canBonus && (
                      <button onClick={() => removeMember(m)} className="text-xs text-red-600 hover:underline">移除</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* add member（分潤是獎金區：沒有 bonus 權限就不給加人） */}
      <div className={`mt-4 flex flex-wrap items-end gap-3 border-t pt-4 ${canBonus ? "" : "hidden"}`}>
        <div>
          <label className={labelCls}>新增成員</label>
          <select className={inputCls} value={newEmp} onChange={(e) => setNewEmp(e.target.value)}>
            <option value="">選擇員工</option>
            {emps
              .filter((e) => !members.some((m) => m.employeeId === e.id))
              .map((e) => (
                <option key={e.id} value={e.id}>{e.name}{e.emp_no ? `（${e.emp_no}）` : ""}</option>
              ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>角色</label>
          <select className={inputCls} value={newRole} onChange={(e) => setNewRole(e.target.value as ProjectMemberRole)}>
            {PROJECT_MEMBER_ROLE_ORDER.map((role) => (
              <option key={role} value={role}>{PROJECT_MEMBER_ROLE_LABELS[role]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{isPool ? "分潤 %" : "分潤金額"}</label>
          <input className={inputCls} type="number" min="0" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder={isPool ? "留空＝用角色預設" : ""} />
        </div>
        <PrimaryButton onClick={addMember}>新增</PrimaryButton>
      </div>
    </Card>
  );
}
