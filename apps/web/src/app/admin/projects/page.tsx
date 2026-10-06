"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Empty, ErrorText } from "@/components/admin-ui";
import { getDepartments, getEmployees, getMe, type Department, type Employee } from "@/lib/admin-api";
import { listVendors, type Vendor } from "@/lib/company-api";
import {
  getProjectSettings,
  updateProjectSettings,
  statusLabel,
  PROJECT_STATUS_ORDER,
  PROJECT_STATUS_LABELS,
  PROJECT_SORT_LABELS,
  type ProjectStatus,
  type ProjectSettings,
  type ProjectSort,
  type SortDir,
} from "@/lib/projects-api";
import {
  listProjectsExt,
  createProjectExt,
  listClients,
  listCompanies,
  createClient,
  getP3SettingsLite,
  engineerDisciplinesOf,
  humanizeClientError,
  humanizeProjectExtError,
  clientNameOf,
  type ProjectListItem,
  type Client,
  type ClientInput,
  type Company,
  type CreateProjectExtBody,
} from "@/lib/projects-ext-api";
import { ProjectApplicationForm } from "./_components/ProjectApplicationForm";
import { createAndOpenProject } from "./_components/project-application-form";

const STATUS_BADGE: Record<ProjectStatus, string> = {
  active: "bg-green-50 text-green-700",
  suspended: "bg-amber-50 text-amber-700",
  closed: "bg-gray-100 text-gray-600",
  terminated: "bg-red-50 text-red-700",
};

export default function AdminProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  // 專案申請單整張可收放（業主 2026-10-07）：預設收起，點標題列展開、再點一下收起。
  // 收起只是 hidden，不卸載，填到一半的內容會保留。
  const [formOpen, setFormOpen] = useState(false);
  const [clients, setClients] = useState<Client[]>([]);
  // 名冊 → 公司主體：申請單左上角「承接公司」下拉的選項（預設選 isDefault 那間）。
  const [companies, setCompanies] = useState<Company[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [disciplines, setDisciplines] = useState<string[]>(() => engineerDisciplinesOf(null));
  const [vatRate, setVatRate] = useState(0.05);
  const [canFinance, setCanFinance] = useState(false);
  const [canBonus, setCanBonus] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 檢視選項：封存的要向後端要（預設不回），案情篩選在前端做就好。
  const [includeArchived, setIncludeArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | "">("");
  // B4：列表排序——欄位＋方向，換了就重打 GET /projects。
  const [sort, setSort] = useState<ProjectSort>("created");
  const [dir, setDir] = useState<SortDir>("desc");
  // M14：歸屬年度篩選（後端 ?year=），""＝全部年度（預設）。
  const [yearFilter, setYearFilter] = useState<string>("");

  // 自動封存設定（模組四第 2 條）
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [p, cl, comp, d, e, st, ven, p3, me] = await Promise.all([
        listProjectsExt({ includeArchived, sort, dir, year: yearFilter ? Number(yearFilter) : null }),
        listClients(),
        // 公司名冊拿不到不該讓整個專案列表掛掉：退成空陣列，下拉會顯示「尚未設定公司主體」。
        listCompanies().catch(() => ({ companies: [] as Company[] })),
        // 同 [id]/page.tsx：GET /departments 還是 HR 限定，會計拿不到就給空清單，
        // 不要讓整個專案列表因為一個下拉選單掛掉。
        getDepartments().catch(() => ({ departments: [] as Department[] })),
        getEmployees(),
        getProjectSettings(),
        listVendors(),
        getP3SettingsLite().catch(() => null),
        getMe(),
      ]);
      setSettings(st.settings);
      setProjects(p.projects);
      setClients(cl.clients);
      setCompanies(comp.companies);
      setDepts(d.departments);
      setEmps(e.employees.filter((x) => x.status === "active"));
      setVendors(ven.vendors);
      setDisciplines(engineerDisciplinesOf(p3?.settings.disciplines));
      setVatRate(p3?.settings.vatRate ?? 0.05);
      setCanFinance(["hr_admin", "platform_admin", "accountant"].includes(me.role));
      setCanBonus(["hr_admin", "platform_admin"].includes(me.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived, sort, dir, yearFilter]);

  const mainProjects = projects.filter((p) => (p.kind ?? "main") === "main");

  async function submit(body: CreateProjectExtBody) {
    setSaving(true);
    setError(null);
    try {
      await createAndOpenProject(body, createProjectExt, (href) => router.push(href));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "建立失敗";
      setError(
        msg.includes("code_taken")
          ? `編號 ${body.code ?? ""} 已被使用。請換一個，或清空讓系統自動產號。`
          : msg.includes("code_generation_failed")
            ? "系統產號連續碰撞，請稍候再試一次。"
            : humanizeProjectExtError(err, msg),
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitNewClient(body: ClientInput): Promise<Client> {
    setError(null);
    try {
      const res = await createClient(body);
      setClients((cs) => [...cs, res.client]);
      return res.client;
    } catch (err) {
      setError(humanizeClientError(err, "新增客戶失敗"));
      throw err;
    }
  }

  const shown = statusFilter ? projects.filter((p) => p.status === statusFilter) : projects;
  /**
   * 年度下拉的選項：目前列表上出現過的年度 ∪ 今年 ∪ 已選的年度（篩到只剩自己時
   * 才不會把選項弄不見），由新到舊。刻意不另外打 API——年度就是資料裡的維度。
   */
  const yearOptions = [
    ...new Set<number>([
      new Date().getFullYear(),
      ...(yearFilter ? [Number(yearFilter)] : []),
      ...projects.map((p) => p.fiscalYear).filter((y): y is number => typeof y === "number"),
    ]),
  ].sort((a, b) => b - a);

  async function saveSettings(patch: Partial<ProjectSettings>) {
    setSavingSettings(true);
    setError(null);
    try {
      const res = await updateProjectSettings(patch);
      setSettings(res.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存設定失敗");
    } finally {
      setSavingSettings(false);
    }
  }

  const deptName = (id: string | null) => depts.find((d) => d.id === id)?.name ?? "—";
  const empName = (id: string | null) => emps.find((e) => e.id === id)?.name ?? "—";

  return (
    <>
      {canFinance ? <Card>
        <button
          type="button"
          onClick={() => setFormOpen((open) => !open)}
          aria-expanded={formOpen}
          aria-controls="project-application-form"
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-cyan-200 bg-cyan-50 px-4 py-3 text-left hover:bg-cyan-100"
        >
          <span className="text-base font-bold tracking-[0.18em] text-slate-800">專案申請單</span>
          <span className="flex items-center gap-1 text-sm text-slate-600">
            {formOpen ? "收起" : "新增專案"}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-5 w-5 transition-transform ${formOpen ? "rotate-180" : ""}`}
            >
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </span>
        </button>
        {/* 錯誤（載入、儲存設定）原本只顯示在申請單裡；收起時改顯示在這裡，免得被藏住。 */}
        {!formOpen && error ? <div className="mt-3"><ErrorText>{error}</ErrorText></div> : null}
        <div id="project-application-form" hidden={!formOpen} className="mt-4">
        <ProjectApplicationForm
          clients={clients}
          companies={companies}
          departments={depts}
          employees={emps}
          vendors={vendors}
          disciplines={disciplines}
          mainProjects={mainProjects}
          vatRate={vatRate}
          canFinance={canFinance}
          canBonus={canBonus}
          saving={saving}
          apiError={error}
          onSubmit={submit}
          onCreateClient={submitNewClient}
        />
        </div>
      </Card> : null}

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
          {/* M14：年度篩選。用的是「歸屬年度」（fiscalYear），不是編號裡的建立年。 */}
          <select
            className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            aria-label="歸屬年度"
          >
            <option value="">全部年度</option>
            {yearOptions.map((y) => (
              <option key={y} value={y}>{y} 年</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            排序
            <select
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as ProjectSort)}
            >
              {(Object.keys(PROJECT_SORT_LABELS) as ProjectSort[]).map((v) => (
                <option key={v} value={v}>{PROJECT_SORT_LABELS[v]}</option>
              ))}
            </select>
            <select
              className="rounded-lg border border-gray-200 px-2 py-1 text-sm"
              value={dir}
              onChange={(e) => setDir(e.target.value as SortDir)}
            >
              <option value="desc">遞減</option>
              <option value="asc">遞增</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            顯示已封存
          </label>

          {settings && (
            <div className="ml-auto flex items-center gap-2 text-sm text-gray-500">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={settings.autoArchiveEnabled}
                  disabled={savingSettings}
                  onChange={(e) => saveSettings({ autoArchiveEnabled: e.target.checked })}
                />
                自動封存
              </label>
              <input
                className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-sm"
                type="number"
                min="0"
                max="120"
                disabled={savingSettings || !settings.autoArchiveEnabled}
                defaultValue={settings.autoArchiveMonths}
                key={settings.autoArchiveMonths}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isInteger(v) && v >= 0 && v !== settings.autoArchiveMonths) {
                    saveSettings({ autoArchiveMonths: v });
                  }
                }}
              />
              <span title="暫停的專案永遠不會自動封存——收起來就真的忘了">
                個月後收起結案／解約的案子
              </span>
            </div>
          )}
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
                  <th className="py-2 pr-3">客戶</th>
                  <th className="py-2 pr-3">文件</th>
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
                    <td className="py-2 pr-3 font-mono text-xs text-gray-500">
                      {p.code ?? "—"}
                    </td>
                    <td className="py-2 pr-3 font-medium text-gray-900">{p.name || "（未命名）"}</td>
                    <td className="py-2 pr-3 text-gray-600">{clientNameOf(p)}</td>
                    <td className="py-2 pr-3">
                      {p.hasSignedContract ? (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">合約</span>
                      ) : (
                        <span className="text-xs text-gray-400">報價單／未簽</span>
                      )}
                    </td>
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
