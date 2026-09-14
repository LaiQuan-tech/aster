"use client";

import { Card, PrimaryButton, Empty, inputCls, labelCls } from "@/components/admin-ui";
import type { Employee } from "@/lib/admin-api";
import { addProjectMember, updateProjectMember, removeProjectMember, type ProjectMember } from "@/lib/projects-api";
import { fmtMoney, type Setter } from "./shared";

interface MembersCardProps {
  projectId: string;
  members: ProjectMember[];
  emps: Employee[];
  isPool: boolean;
  /** pool 模式的 % 加總（提示是否超過 100）。 */
  pctTotal: number;
  newEmp: string;
  setNewEmp: Setter<string>;
  newRole: "member" | "lead";
  setNewRole: Setter<"member" | "lead">;
  newValue: string;
  setNewValue: Setter<string>;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/** 成員分潤：成員列表（角色切換／分潤即存／移除）＋新增成員表單。 */
export function MembersCard({
  projectId,
  members,
  emps,
  isPool,
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
      await addProjectMember(projectId, {
        employeeId: newEmp,
        roleInProject: newRole,
        sharePct: isPool ? val : null,
        shareAmount: isPool ? null : val,
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

  async function toggleLead(m: ProjectMember) {
    setError(null);
    try {
      await updateProjectMember(projectId, m.id, {
        roleInProject: m.roleInProject === "lead" ? "member" : "lead",
      });
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
        <h2 className="text-sm font-semibold text-gray-700">成員分潤</h2>
        {isPool && (
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
                <th className="py-2 pr-3">{isPool ? "分潤 %" : "分潤金額"}</th>
                <th className="py-2 pr-3">實得金額</th>
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
                    <button
                      onClick={() => toggleLead(m)}
                      className={`rounded-full px-2 py-0.5 text-xs ${m.roleInProject === "lead" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-500"}`}
                      title="點擊切換 負責人／組員"
                    >
                      {m.roleInProject === "lead" ? "負責人" : "組員"}
                    </button>
                  </td>
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
                  <td className="py-2 pr-3 text-gray-700">{fmtMoney(m.computedAmount)}</td>
                  <td className="py-2 pr-3">
                    <button onClick={() => removeMember(m)} className="text-xs text-red-600 hover:underline">移除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* add member */}
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
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
          <select className={inputCls} value={newRole} onChange={(e) => setNewRole(e.target.value as "member" | "lead")}>
            <option value="member">組員</option>
            <option value="lead">負責人</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>{isPool ? "分潤 %" : "分潤金額"}</label>
          <input className={inputCls} type="number" min="0" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
        </div>
        <PrimaryButton onClick={addMember}>新增</PrimaryButton>
      </div>
    </Card>
  );
}
