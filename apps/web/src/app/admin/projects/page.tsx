"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import {
  listProjects,
  createProject,
  statusLabel,
  PROJECT_STATUS_ORDER,
  PROJECT_STATUS_LABELS,
  type Project,
  type ShareMode,
  type ProjectStatus,
} from "@/lib/projects-api";

const STATUS_BADGE: Record<ProjectStatus, string> = {
  active: "bg-green-50 text-green-700",
  suspended: "bg-amber-50 text-amber-700",
  closed: "bg-gray-100 text-gray-600",
  terminated: "bg-red-50 text-red-700",
};

export default function AdminProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 檢視選項：封存要向後端要（預設不回），案情篩選在前端做就好。
  const [includeArchived, setIncludeArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "">("");

  // create form
  const [name, setName] = useState("");
  // 編號留空＝系統產號（P{建立年}-{流水號}）。填了就是人工指定，撞號後端回 409。
  const [code, setCode] = useState("");
  const [fiscalYear, setFiscalYear] = useState("");
  const [description, setDescription] = useState("");
  const [deptId, setDeptId] = useState("");
  const [leadEmpId, setLeadEmpId] = useState("");
  const [shareMode, setShareMode] = useState<ShareMode>("pool_pct");
  const [bonusPool, setBonusPool] = useState("");
  const [saving, setSaving] = useState(false);
  /** 建立成功後回報系統產生的編號——使用者要知道拿到的是哪一個號。 */
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [p, d, e] = await Promise.all([
        listProjects(includeArchived),
        getDepartments(),
        getEmployees(),
      ]);
      setProjects(p.projects);
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
  }, [includeArchived]);

  async function submit() {
    if (!name.trim()) {
      setError("請輸入專案名稱");
      return;
    }
    setSaving(true);
    setError(null);
    setCreatedCode(null);
    try {
      const created = await createProject({
        name: name.trim(),
        code: code.trim() || null,
        fiscalYear: fiscalYear ? Number(fiscalYear) : null,
        description: description.trim() || null,
        deptId: deptId || null,
        leadEmpId: leadEmpId || null,
        shareMode,
        bonusPool: shareMode === "pool_pct" && bonusPool ? Number(bonusPool) : null,
      });
      setCreatedCode(created.code);
      setName("");
      setCode("");
      setFiscalYear("");
      setDescription("");
      setDeptId("");
      setLeadEmpId("");
      setBonusPool("");
      setShareMode("pool_pct");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "建立失敗";
      setError(
        msg.includes("code_taken")
          ? `編號 ${code.trim()} 已被使用。請換一個，或清空讓系統自動產號。`
          : msg.includes("code_generation_failed")
            ? "系統產號連續碰撞，請稍候再試一次。"
            : msg,
      );
    } finally {
      setSaving(false);
    }
  }

  const shown = statusFilter ? projects.filter((p) => p.status === statusFilter) : projects;

  const deptName = (id: string | null) => depts.find((d) => d.id === id)?.name ?? "—";
  const empName = (id: string | null) => emps.find((e) => e.id === id)?.name ?? "—";

  return (
    <>
      <PageHeader title="專案獎金分潤" desc="建立專案、指派成員與分潤比例／金額，並上傳專案文件。組員彼此看不到分潤，負責人與部門主管可見全部。" />

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">建立專案</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>專案名稱 *</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：官網改版" />
          </div>
          <div>
            <label className={labelCls}>歸屬年度</label>
            <input className={inputCls} type="number" min="2000" max="2100" value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} placeholder={`留空＝${new Date().getFullYear()}`} />
            <p className="mt-1 text-xs text-gray-400">報表與獎金歸在哪一年。12 月談成、1 月才立案的案子可設回前一年。</p>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>專案編號</label>
            <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder={`留空＝自動產生 P${new Date().getFullYear()}-001`} />
            <p className="mt-1 text-xs text-gray-400">
              只有匯入舊案才需要手填。編號會印在合約與請款單上，<span className="font-medium text-gray-500">建立後不可變更</span>；要改歸屬請改上面的歸屬年度。
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>說明</label>
            <textarea className={inputCls} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="選填" />
          </div>
          <div>
            <label className={labelCls}>所屬部門（驅動部門主管可見分潤）</label>
            <select className={inputCls} value={deptId} onChange={(e) => setDeptId(e.target.value)}>
              <option value="">不指定</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>專案負責人（可見／可調整全部分潤）</label>
            <select className={inputCls} value={leadEmpId} onChange={(e) => setLeadEmpId(e.target.value)}>
              <option value="">不指定</option>
              {emps.map((e) => (
                <option key={e.id} value={e.id}>{e.name}{e.emp_no ? `（${e.emp_no}）` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>分潤模式</label>
            <select className={inputCls} value={shareMode} onChange={(e) => setShareMode(e.target.value as ShareMode)}>
              <option value="pool_pct">獎金池 × 百分比</option>
              <option value="fixed_amount">直接填每人金額</option>
            </select>
          </div>
          {shareMode === "pool_pct" && (
            <div>
              <label className={labelCls}>獎金池總額</label>
              <input className={inputCls} type="number" min="0" value={bonusPool} onChange={(e) => setBonusPool(e.target.value)} placeholder="例如：100000" />
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <PrimaryButton onClick={submit} disabled={saving}>{saving ? "建立中…" : "建立專案"}</PrimaryButton>
          {createdCode && <span className="text-sm text-green-700">已建立，編號 <span className="font-mono font-medium">{createdCode}</span></span>}
          <ErrorText>{error}</ErrorText>
        </div>
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-700">所有專案</h2>
          <select
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ProjectStatus | "")}
          >
            <option value="">全部案情</option>
            {PROJECT_STATUS_ORDER.map((v) => (
              <option key={v} value={v}>{PROJECT_STATUS_LABELS[v]}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            顯示已封存
          </label>
        </div>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : shown.length === 0 ? (
          <Empty>{projects.length === 0 ? "尚無專案" : "沒有符合條件的專案"}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">編號</th>
                  <th className="py-2 pr-3">專案</th>
                  <th className="py-2 pr-3">歸屬年度</th>
                  <th className="py-2 pr-3">部門</th>
                  <th className="py-2 pr-3">負責人</th>
                  <th className="py-2 pr-3">分潤模式</th>
                  <th className="py-2 pr-3">獎金池</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-gray-500">{p.code ?? "—"}</td>
                    <td className="py-2 pr-3 font-medium text-gray-900">{p.name}</td>
                    <td className="py-2 pr-3 text-gray-600">{p.fiscalYear ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{deptName(p.deptId)}</td>
                    <td className="py-2 pr-3 text-gray-600">{empName(p.leadEmpId)}</td>
                    <td className="py-2 pr-3 text-gray-600">{p.shareMode === "pool_pct" ? "池×%" : "固定金額"}</td>
                    <td className="py-2 pr-3 text-gray-600">{p.bonusPool != null ? p.bonusPool.toLocaleString() : "—"}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          STATUS_BADGE[p.status as ProjectStatus] ?? "bg-gray-100 text-gray-500"
                        }`}
                        title={p.statusReason ?? undefined}
                      >
                        {statusLabel(p.status)}
                      </span>
                      {p.archivedAt && (
                        <span className="ml-1 text-xs text-gray-400">已封存</span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Link href={`/admin/projects/${p.id}`} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                        管理 →
                      </Link>
                    </td>
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
