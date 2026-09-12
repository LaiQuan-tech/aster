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
  type ProjectStatus,
  PROJECT_STATUS_ORDER,
  PROJECT_STATUS_LABELS,
  statusLabel,
  getContracts,
  createContract,
  updateContract,
  deleteContract,
  DOC_TYPE_LABELS,
  OUR_ROLE_LABELS,
  type Contract,
  type DocType,
  type OurRole,
} from "@/lib/projects-api";

/** 後端的錯誤碼翻成人看得懂的話。 */
const STATUS_ERRORS: Record<string, string> = {
  status_reason_required: "變更案情狀態必須填理由。",
  archive_requires_non_active: "「進行中」的專案不能封存。要收起來請先改成暫停、結案或已解約。",
  invalid_status: "狀態值不合法。",
};

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
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 合約／報價單（模組四第 3 條）
  const [cDocType, setCDocType] = useState<DocType>("quotation");
  const [cOurRole, setCOurRole] = useState<OurRole>("contractor");
  const [cTitle, setCTitle] = useState("");
  const [cCounterparty, setCCounterparty] = useState("");
  const [cAmount, setCAmount] = useState("");
  const [cSignedOn, setCSignedOn] = useState("");
  const [cCopies, setCCopies] = useState("1");
  const [savingContract, setSavingContract] = useState(false);

  // 案情狀態變更（模組四第 2 條）。改狀態要理由，所以不能是即存下拉。
  const [newStatus, setNewStatus] = useState<ProjectStatus | "">("");
  const [statusReason, setStatusReason] = useState("");
  const [statusEffectiveOn, setStatusEffectiveOn] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  // add-member form
  const [newEmp, setNewEmp] = useState("");
  const [newRole, setNewRole] = useState<"member" | "lead">("member");
  const [newValue, setNewValue] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [p, m, adj, docs, cs, d, e] = await Promise.all([
        getProject(projectId),
        getProjectMembers(projectId),
        getProjectAdjustments(projectId),
        getProjectDocuments(projectId),
        getContracts(projectId),
        getDepartments(),
        getEmployees(),
      ]);
      setContracts(cs.contracts);
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

  function humanError(err: unknown, fallback: string): string {
    const msg = err instanceof Error ? err.message : fallback;
    for (const [code, text] of Object.entries(STATUS_ERRORS)) {
      if (msg.includes(code)) return text;
    }
    if (msg.includes("code_immutable")) return "專案編號不可變更。";
    return msg;
  }

  async function saveProjectField(patch: Parameters<typeof updateProject>[1]) {
    if (!project) return;
    setError(null);
    try {
      await updateProject(project.id, patch);
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  async function addContract() {
    if (!cTitle.trim()) {
      setError("請輸入文件名稱");
      return;
    }
    setSavingContract(true);
    setError(null);
    try {
      await createContract(projectId, {
        docType: cDocType,
        ourRole: cOurRole,
        title: cTitle.trim(),
        counterparty: cCounterparty.trim() || null,
        amount: cAmount === "" ? null : Number(cAmount),
        signedOn: cSignedOn || null,
        copies: Number(cCopies) || 1,
      });
      setCTitle("");
      setCCounterparty("");
      setCAmount("");
      setCSignedOn("");
      setCCopies("1");
      await load();
    } catch (err) {
      setError(humanError(err, "新增文件失敗"));
    } finally {
      setSavingContract(false);
    }
  }

  async function markStamped(c: Contract, paidOn: string | null) {
    setError(null);
    try {
      await updateContract(c.id, { stampDutyPaidOn: paidOn });
      await load();
    } catch (err) {
      setError(humanError(err, "更新失敗"));
    }
  }

  async function removeContract(c: Contract) {
    // 金額憑證只做軟刪除，所以一定要有理由。
    const reason = window.prompt(`作廢「${c.title}」的理由？`);
    if (!reason?.trim()) return;
    setError(null);
    try {
      await deleteContract(c.id, reason.trim());
      await load();
    } catch (err) {
      setError(humanError(err, "作廢失敗"));
    }
  }

  async function changeStatus() {
    if (!project || !newStatus) return;
    if (!statusReason.trim()) {
      setError(STATUS_ERRORS.status_reason_required);
      return;
    }
    setSavingStatus(true);
    setError(null);
    try {
      await updateProject(project.id, {
        status: newStatus,
        statusReason: statusReason.trim(),
        statusEffectiveOn: statusEffectiveOn || null,
      });
      setNewStatus("");
      setStatusReason("");
      setStatusEffectiveOn("");
      await load();
    } catch (err) {
      setError(humanError(err, "變更狀態失敗"));
    } finally {
      setSavingStatus(false);
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
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {/* 合約與報價單（模組四第 3 條）。文件類型決定課不課印花稅。 */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-700">合約與報價單</h2>
          {project.hasSignedContract ? (
            <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">已簽約</span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">尚未簽約</span>
          )}
        </div>

        {contracts.length === 0 ? (
          <Empty>尚無文件</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">類型</th>
                  <th className="py-2 pr-3">名稱</th>
                  <th className="py-2 pr-3">對方</th>
                  <th className="py-2 pr-3 text-right">金額</th>
                  <th className="py-2 pr-3">簽訂日</th>
                  <th className="py-2 pr-3 text-right">印花稅</th>
                  <th className="py-2 pr-3">貼花</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${c.docType === "contract" ? "bg-blue-50 text-blue-700" : c.docType === "change_order" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600"}`}>
                        {DOC_TYPE_LABELS[c.docType]}
                      </span>
                      {c.version > 1 && <span className="ml-1 text-xs text-gray-400">v{c.version}</span>}
                    </td>
                    <td className="py-2 pr-3 font-medium text-gray-900">{c.title}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.counterparty ?? "—"}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">{fmtMoney(c.amount)}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.signedOn ?? "—"}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">
                      {!c.dutiable ? (
                        <span className="text-xs text-gray-400">不課</span>
                      ) : c.stampDutyAmount == null ? (
                        <span className="text-xs text-red-600" title="應貼花但沒有金額，算不出稅額">
                          缺金額
                        </span>
                      ) : (
                        fmtMoney(c.stampDutyAmount)
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {!c.dutiable ? (
                        "—"
                      ) : c.stampDutyPaidOn ? (
                        <button
                          type="button"
                          className="text-xs text-green-700 hover:underline"
                          onClick={() => markStamped(c, null)}
                          title="點一下取消標記"
                        >
                          已貼 {c.stampDutyPaidOn}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50"
                          onClick={() => markStamped(c, new Date().toISOString().slice(0, 10))}
                        >
                          標記已貼花
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <button
                        type="button"
                        className="text-xs text-gray-400 hover:text-red-600"
                        onClick={() => removeContract(c)}
                      >
                        作廢
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 border-t pt-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className={labelCls}>類型</label>
              <select className={inputCls} value={cDocType} onChange={(e) => setCDocType(e.target.value as DocType)}>
                {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((v) => (
                  <option key={v} value={v}>{DOC_TYPE_LABELS[v]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">報價單不是契據，不課印花稅。</p>
            </div>
            <div>
              <label className={labelCls}>我方角色</label>
              <select className={inputCls} value={cOurRole} onChange={(e) => setCOurRole(e.target.value as OurRole)}>
                {(Object.keys(OUR_ROLE_LABELS) as OurRole[]).map((v) => (
                  <option key={v} value={v}>{OUR_ROLE_LABELS[v]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">承攬契據由承攬人貼花，發包出去的由下包貼。</p>
            </div>
            <div>
              <label className={labelCls}>文件名稱 *</label>
              <input className={inputCls} value={cTitle} onChange={(e) => setCTitle(e.target.value)} placeholder="例如：官網改版承攬契約" />
            </div>
            <div>
              <label className={labelCls}>對方（業主／下包）</label>
              <input className={inputCls} value={cCounterparty} onChange={(e) => setCCounterparty(e.target.value)} placeholder="選填" />
            </div>
            <div>
              <label className={labelCls}>金額</label>
              <input className={inputCls} type="number" value={cAmount} onChange={(e) => setCAmount(e.target.value)} placeholder="追加減帳可填負數" />
            </div>
            <div>
              <label className={labelCls}>簽訂日</label>
              <input className={inputCls} type="date" value={cSignedOn} onChange={(e) => setCSignedOn(e.target.value)} />
              <p className="mt-1 text-xs text-gray-400">沒有簽訂日就不算已簽約，也不會進印花稅清單。</p>
            </div>
            <div>
              <label className={labelCls}>份數</label>
              <input className={inputCls} type="number" min="1" value={cCopies} onChange={(e) => setCCopies(e.target.value)} />
              <p className="mt-1 text-xs text-gray-400">同一憑證繕寫兩份以上，各份均應貼用。</p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <PrimaryButton onClick={addContract} disabled={savingContract}>
              {savingContract ? "新增中…" : "新增文件"}
            </PrimaryButton>
            <span className="text-xs text-gray-400">
              印花稅為系統試算，非申報值；承攬契據認定與免稅憑證請會計師確認。
            </span>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
      </Card>

      {/* 案情狀態（模組四第 2 條）。與封存是兩軸。 */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">案情狀態</h2>

        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              project.status === "active"
                ? "bg-green-50 text-green-700"
                : project.status === "suspended"
                  ? "bg-amber-50 text-amber-700"
                  : project.status === "terminated"
                    ? "bg-red-50 text-red-700"
                    : "bg-gray-100 text-gray-600"
            }`}
          >
            {statusLabel(project.status)}
          </span>
          {project.statusEffectiveOn && (
            <span className="text-gray-500">自 {project.statusEffectiveOn} 起</span>
          )}
          {project.archivedAt && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500">已封存</span>
          )}
        </div>
        {project.statusReason && (
          <p className="mb-4 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
            理由：{project.statusReason}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>變更為</label>
            <select
              className={inputCls}
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as ProjectStatus | "")}
            >
              <option value="">不變更</option>
              {PROJECT_STATUS_ORDER.filter((v) => v !== project.status).map((v) => (
                <option key={v} value={v}>{PROJECT_STATUS_LABELS[v]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>生效日</label>
            <input
              className={inputCls}
              type="date"
              value={statusEffectiveOn}
              onChange={(e) => setStatusEffectiveOn(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-400">
              解約通知書／結案文件上的那一天，不是今天。留空才用今天。
            </p>
          </div>
          <div>
            <label className={labelCls}>理由 *</label>
            <input
              className={inputCls}
              value={statusReason}
              onChange={(e) => setStatusReason(e.target.value)}
              placeholder="例如：業主資金斷鏈，依約第 12 條終止"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <PrimaryButton onClick={changeStatus} disabled={savingStatus || !newStatus}>
            {savingStatus ? "變更中…" : "變更狀態"}
          </PrimaryButton>
          <span className="text-xs text-gray-400">
            狀態變更不擋（結案後返工是真的），但一律留下理由與生效日。
          </span>
        </div>

        <div className="mt-5 border-t pt-4">
          <label className={labelCls}>封存（只影響列表是否顯示，與案情無關）</label>
          {project.status === "active" ? (
            <p className="text-sm text-gray-400">
              「進行中」的專案不能封存。要收起來請先改成暫停、結案或已解約。
            </p>
          ) : (
            <button
              type="button"
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
              onClick={() => saveProjectField({ archived: !project.archivedAt })}
            >
              {project.archivedAt ? "取消封存" : "封存此專案"}
            </button>
          )}
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
