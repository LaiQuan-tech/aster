"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Empty, inputCls, labelCls } from "@/components/admin-ui";
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
  reserveProjectCodes,
  listClients,
  createClient,
  getP3SettingsLite,
  engineerDisciplinesOf,
  humanizeClientError,
  humanizeProjectExtError,
  clientNameOf,
  type ProjectListItem,
  type Client,
  type ClientInput,
  type CreateProjectExtBody,
} from "@/lib/projects-ext-api";
import { ProjectApplicationForm } from "./_components/ProjectApplicationForm";

const STATUS_BADGE: Record<ProjectStatus, string> = {
  active: "bg-green-50 text-green-700",
  suspended: "bg-amber-50 text-amber-700",
  closed: "bg-gray-100 text-gray-600",
  terminated: "bg-red-50 text-red-700",
};

export default function AdminProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [disciplines, setDisciplines] = useState<string[]>(() => engineerDisciplinesOf(null));
  const [vatRate, setVatRate] = useState(0.05);
  const [canFinance, setCanFinance] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 檢視選項：封存／預先取號的號碼要向後端要（預設不回），案情篩選在前端做就好。
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeReserved, setIncludeReserved] = useState(false);
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

  // 預先取號（模組五）
  const [reserveCount, setReserveCount] = useState("1");
  const [reserving, setReserving] = useState(false);
  const [reservedCodes, setReservedCodes] = useState<string[] | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [p, cl, d, e, st, ven, p3, me] = await Promise.all([
        listProjectsExt({ includeArchived, includeReserved, sort, dir, year: yearFilter ? Number(yearFilter) : null }),
        listClients(),
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
      setDepts(d.departments);
      setEmps(e.employees.filter((x) => x.status === "active"));
      setVendors(ven.vendors);
      setDisciplines(engineerDisciplinesOf(p3?.settings.disciplines));
      setVatRate(p3?.settings.vatRate ?? 0.05);
      setCanFinance(["hr_admin", "platform_admin", "accountant"].includes(me.role));
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived, includeReserved, sort, dir, yearFilter]);

  const mainProjects = projects.filter((p) => (p.kind ?? "main") === "main");

  async function submit(body: CreateProjectExtBody) {
    setSaving(true);
    setError(null);
    try {
      const created = await createProjectExt(body);
      router.push(`/admin/projects/${created.id}`);
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

  async function submitReserve() {
    const n = Number(reserveCount);
    if (!Number.isInteger(n) || n < 1) {
      setError("預先取號筆數請填正整數");
      return;
    }
    setReserving(true);
    setError(null);
    try {
      const res = await reserveProjectCodes(n);
      setReservedCodes(res.projects.map((p) => p.code));
      setIncludeReserved(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "預先取號失敗");
    } finally {
      setReserving(false);
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
        <ProjectApplicationForm
          clients={clients}
          departments={depts}
          employees={emps}
          vendors={vendors}
          disciplines={disciplines}
          mainProjects={mainProjects}
          vatRate={vatRate}
          canFinance={canFinance}
          saving={saving}
          apiError={error}
          onSubmit={submit}
          onCreateClient={submitNewClient}
        />
        <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4">
          <div>
            <label className={labelCls}>預先取號</label>
            <input className={`${inputCls} w-24`} type="number" min="1" max="50" value={reserveCount} onChange={(e) => setReserveCount(e.target.value)} />
          </div>
          <button
            type="button"
            onClick={() => void submitReserve()}
            disabled={reserving}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
          >
            {reserving ? "取號中…" : `預先取號 ${reserveCount || "N"} 筆`}
          </button>
          {reservedCodes && (
            <span className="text-sm text-green-700">已取號：{reservedCodes.join("、")}</span>
          )}
          <span className="text-xs text-gray-400">立案前先掛號用；下方列表勾選「顯示預先取號」可見。</span>
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
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeReserved}
              onChange={(e) => setIncludeReserved(e.target.checked)}
            />
            顯示預先取號
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
                      {p.reservedAt && <span className="ml-1 rounded bg-blue-50 px-1 py-0.5 text-[10px] font-sans text-blue-700">預先取號</span>}
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
