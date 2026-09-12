"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import {
  getProject,
  updateProject,
  getProjectMembers,
  addProjectMember,
  updateProjectMember,
  removeProjectMember,
  getProjectAdjustments,
  getProjectDocuments,
  uploadProjectDocument,
  deleteProjectDocument,
  type Project,
  type ProjectMember,
  type ShareAdjustment,
  type ProjectDocument,
  type ShareMode,
} from "@/lib/projects-api";

function fmtMoney(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

export default function AdminProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [adjustments, setAdjustments] = useState<ShareAdjustment[]>([]);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // add-member form
  const [newEmp, setNewEmp] = useState("");
  const [newRole, setNewRole] = useState<"member" | "lead">("member");
  const [newValue, setNewValue] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [p, m, adj, docs, d, e] = await Promise.all([
        getProject(projectId),
        getProjectMembers(projectId),
        getProjectAdjustments(projectId),
        getProjectDocuments(projectId),
        getDepartments(),
        getEmployees(),
      ]);
      setProject(p.project);
      setMembers(m.members);
      setAdjustments(adj.adjustments);
      setDocuments(docs.documents);
      setDepts(d.departments);
      setEmps(e.employees.filter((x) => x.status === "active"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const isPool = project?.shareMode === "pool_pct";

  // pool 模式的 % 加總（提示是否超過 100）。
  const pctTotal = members.reduce((s, m) => s + (m.sharePct ?? 0), 0);

  async function saveProjectField(patch: Parameters<typeof updateProject>[1]) {
    if (!project) return;
    setError(null);
    try {
      await updateProject(project.id, patch);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    }
  }

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

  async function onUpload(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      await uploadProjectDocument(projectId, file);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    }
  }

  async function removeDoc(doc: ProjectDocument) {
    if (!confirm(`確定刪除文件「${doc.fileName}」？`)) return;
    setError(null);
    try {
      await deleteProjectDocument(projectId, doc.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  if (loading) return <Empty>載入中…</Empty>;
  if (!project) return <ErrorText>{error ?? "找不到專案"}</ErrorText>;

  return (
    <>
      <div className="flex items-center justify-between">
        <PageHeader title={project.name} desc={project.code ? `編號 ${project.code}（不可變更）` : undefined} />
        <Link href="/admin/projects" className="text-sm text-gray-500 hover:underline">← 專案列表</Link>
      </div>

      {/* 專案設定 */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">專案設定</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>所屬部門</label>
            <select
              className={inputCls}
              value={project.deptId ?? ""}
              onChange={(e) => saveProjectField({ deptId: e.target.value || null })}
            >
              <option value="">不指定</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>專案負責人</label>
            <select
              className={inputCls}
              value={project.leadEmpId ?? ""}
              onChange={(e) => saveProjectField({ leadEmpId: e.target.value || null })}
            >
              <option value="">不指定</option>
              {emps.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>分潤模式</label>
            <select
              className={inputCls}
              value={project.shareMode}
              onChange={(e) => saveProjectField({ shareMode: e.target.value as ShareMode })}
            >
              <option value="pool_pct">獎金池 × 百分比</option>
              <option value="fixed_amount">直接填每人金額</option>
            </select>
          </div>
          {isPool && (
            <div>
              <label className={labelCls}>獎金池總額</label>
              <input
                className={inputCls}
                type="number"
                min="0"
                defaultValue={project.bonusPool ?? ""}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== project.bonusPool) saveProjectField({ bonusPool: v });
                }}
              />
            </div>
          )}
          <div>
            <label className={labelCls}>歸屬年度</label>
            <input
              className={inputCls}
              type="number"
              min="2000"
              max="2100"
              defaultValue={project.fiscalYear ?? ""}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                if (v !== project.fiscalYear) saveProjectField({ fiscalYear: v });
              }}
            />
            <p className="mt-1 text-xs text-gray-400">
              報表與獎金歸在哪一年。編號裡的年度是建立年，已印在合約上，不隨這裡改動。
            </p>
          </div>
          <div>
            <label className={labelCls}>狀態</label>
            <select
              className={inputCls}
              value={project.status}
              onChange={(e) => saveProjectField({ status: e.target.value as "active" | "archived" })}
            >
              <option value="active">進行中</option>
              <option value="archived">已封存</option>
            </select>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {/* 成員分潤 */}
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

      {/* 文件（知識庫） */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">專案文件（全公司可下載）</h2>
        <input
          ref={fileRef}
          type="file"
          className="mb-3 block text-sm"
          onChange={(e) => onUpload(e.target.files?.[0])}
        />
        {documents.length === 0 ? (
          <Empty>尚無文件</Empty>
        ) : (
          <ul className="divide-y">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between py-2 text-sm">
                <div className="min-w-0">
                  <a href={doc.url ?? "#"} target="_blank" rel="noreferrer" className="font-medium" style={{ color: "var(--brand)" }}>
                    {doc.fileName}
                  </a>
                  <span className="ml-2 text-xs text-gray-400">{Math.round(doc.sizeBytes / 1024)} KB</span>
                </div>
                <button onClick={() => removeDoc(doc)} className="text-xs text-red-600 hover:underline">刪除</button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 分潤異動史 */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">分潤異動紀錄</h2>
        {adjustments.length === 0 ? (
          <Empty>尚無異動</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">時間</th>
                  <th className="py-2 pr-3">對象</th>
                  <th className="py-2 pr-3">項目</th>
                  <th className="py-2 pr-3">變更</th>
                  <th className="py-2 pr-3">原因</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 text-gray-500">{new Date(a.createdAt).toLocaleString("zh-TW")}</td>
                    <td className="py-2 pr-3 text-gray-700">{a.name ?? (a.field === "pool" ? "獎金池" : "—")}</td>
                    <td className="py-2 pr-3 text-gray-600">{a.field === "pct" ? "百分比" : a.field === "amount" ? "金額" : "獎金池"}</td>
                    <td className="py-2 pr-3 text-gray-700">{fmtMoney(a.oldValue)} → {fmtMoney(a.newValue)}</td>
                    <td className="py-2 pr-3 text-gray-500">{a.reason ?? "—"}</td>
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
