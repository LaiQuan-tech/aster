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
  downloadProjectRegisterXlsx,
  type ProjectListItem,
  type Client,
  type ClientInput,
  type Company,
  type CreateProjectExtBody,
} from "@/lib/projects-ext-api";
import {
  MASKED,
  REGISTER_FROZEN_COLUMNS,
  SHOW_HIDDEN_STORAGE_KEY,
  excelWidthToPx,
  isTextSelected,
  registerRowCells,
  visibleRegisterColumns,
} from "@/lib/project-register";
import { ProjectApplicationForm } from "./_components/ProjectApplicationForm";
import { createAndOpenProject } from "./_components/project-application-form";

export default function AdminProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  // 總表的科別發包欄（Q 欄起；租戶設定順序，後端已依權限推好）。
  const [registerDisciplines, setRegisterDisciplines] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  // 原檔 I:N（已收帳款…發包）預設隱藏；使用者打開後記在自己的瀏覽器。
  const [showHiddenColumns, setShowHiddenColumns] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) === "1") setShowHiddenColumns(true);
    } catch {
      // 讀不到就用預設（隱藏）。
    }
  }, []);
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
  // 分潤改版 #6：分潤寫入只有老闆（後端 /project-settings 回 canEditBonus）。看得到（HR）≠ 改得了。
  const [canEditBonus, setCanEditBonus] = useState(false);
  const [bossConfigured, setBossConfigured] = useState(false);
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
        listProjectsExt({ includeArchived, sort, dir, year: yearFilter ? Number(yearFilter) : null, view: "register" }),
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
      setRegisterDisciplines(p.registerDisciplines ?? []);
      setClients(cl.clients);
      setCompanies(comp.companies);
      setDepts(d.departments);
      setEmps(e.employees.filter((x) => x.status === "active"));
      setVendors(ven.vendors);
      setDisciplines(engineerDisciplinesOf(p3?.settings.disciplines));
      setVatRate(p3?.settings.vatRate ?? 0.05);
      setCanFinance(["hr_admin", "platform_admin", "accountant"].includes(me.role));
      setCanBonus(["hr_admin", "platform_admin"].includes(me.role));
      setCanEditBonus(st.canEditBonus === true);
      setBossConfigured(st.bossConfigured === true);
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

  const columns = visibleRegisterColumns(registerDisciplines, showHiddenColumns);
  // 凍結欄（A:E）的 left 位移：前面各欄寬的累加。
  const frozenLeft = columns.slice(0, REGISTER_FROZEN_COLUMNS).reduce<number[]>((acc, c, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + excelWidthToPx(columns[i - 1].width));
    return acc;
  }, []);
  const registerTableWidth = columns.reduce((sum, c) => sum + excelWidthToPx(c.width), 0);

  function toggleHiddenColumns(next: boolean) {
    setShowHiddenColumns(next);
    try {
      localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // 無痕模式／封鎖儲存：只是這次有效，不影響畫面。
    }
  }

  /** 下載 Excel：與原「專案申請單總表」一模一樣（layout=register），依歸屬年度；全部年度時由後端依租戶時區取今年。 */
  async function exportXlsx() {
    setExporting(true);
    setError(null);
    try {
      await downloadProjectRegisterXlsx({ year: yearFilter ? Number(yearFilter) : null, includeArchived });
    } catch (err) {
      setError(err instanceof Error ? err.message : "匯出失敗");
    } finally {
      setExporting(false);
    }
  }

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
          // 建案的分潤模式／獎金池欄位只給老闆；HR 建案時不送，由後端帶預設（pool_pct、無獎金池）。
          canBonus={canEditBonus}
          // 2026-10-27：各角色分潤趴數改在每個專案的申請單各自設定（原本列表頁的全公司共用卡已移除）；
          // 預填「設定 → 進階功能」的新專案起始值，HR 看得到但唯讀、不送出（後端複製起始值）。
          canSeeBonus={canBonus || canEditBonus}
          bossConfigured={bossConfigured}
          roleShareDefaults={settings?.defaultSharePctByRole ?? null}
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
          {canFinance ? (
            <button
              type="button"
              onClick={() => void exportXlsx()}
              disabled={exporting}
              title={
                yearFilter
                  ? `匯出 ${yearFilter} 歸屬年度的專案申請單總表（版面同原 Excel）`
                  : "匯出今年度的專案申請單總表（版面同原 Excel）；要其他年度請先選年度"
              }
              className="rounded-lg border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting ? "匯出中…" : "下載 Excel"}
            </button>
          ) : null}
          {/* 右上：顯示隱藏欄＋自動封存設定。 */}
          <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-gray-600" title="原 Excel 預設隱藏 I:N 欄">
            <input type="checkbox" checked={showHiddenColumns} onChange={(e) => toggleHiddenColumns(e.target.checked)} />
            顯示隱藏欄（已收帳款…發包）
          </label>

          {settings && (
            <div className="flex items-center gap-2 text-sm text-gray-500">
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
        </div>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : shown.length === 0 ? (
          <Empty>{projects.length === 0 ? "尚無專案" : "沒有符合條件的專案"}</Empty>
        ) : (
          /* 欄位＝「專案申請單總表」Excel（A:P＋科別）；凍結 A:E 與表頭，同原檔凍結窗格 F5。
             縱向也在這個框裡捲，表頭才黏得住（overflow-x 會讓 sticky top 失效於整頁捲動）。 */
          <div className="max-h-[75vh] overflow-auto rounded border border-gray-200">
            <table
              aria-label="所有專案"
              // table-fixed＋總寬＝各欄寬加總：凍結欄的 left 位移才會跟實際欄寬對得上。
              className="table-fixed border-separate border-spacing-0 text-sm text-gray-800"
              style={{ width: registerTableWidth }}
            >
              <colgroup>
                {columns.map((c) => <col key={c.header} style={{ width: excelWidthToPx(c.width) }} />)}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th
                      key={c.header}
                      scope="col"
                      className={`sticky top-0 whitespace-nowrap border-b border-r border-gray-300 bg-gray-100 px-2 py-2 text-center font-medium text-gray-700 ${i < REGISTER_FROZEN_COLUMNS ? "z-30" : "z-20"}`}
                      style={i < REGISTER_FROZEN_COLUMNS ? { left: frozenLeft[i] } : undefined}
                    >
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((p, index) => {
                  const cells = registerRowCells(
                    { seq: index + 1, code: p.code, clientName: p.clientName ?? null, name: p.name || "（未命名）", register: p.register },
                    registerDisciplines,
                  );
                  const href = `/admin/projects/${p.id}`;
                  return (
                    <tr
                      key={p.id}
                      className="group cursor-pointer"
                      title={p.archivedAt ? "已封存" : undefined}
                      // 整列可點進明細；點到列內的連結／按鈕／表單元件時交給它自己處理。
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("a,button,input,select,textarea,label")) return;
                        // 在格子裡拖曳選字（要複製）放開時不導頁。
                        if (isTextSelected(window.getSelection())) return;
                        if (e.metaKey || e.ctrlKey) window.open(href, "_blank");
                        else router.push(href);
                      }}
                      // 中鍵點整列＝開新分頁（同一般連結）。
                      onAuxClick={(e) => {
                        if (e.button !== 1) return;
                        if ((e.target as HTMLElement).closest("a,button,input,select,textarea,label")) return;
                        e.preventDefault();
                        window.open(href, "_blank");
                      }}
                    >
                      {columns.map((c, i) => {
                        const frozen = i < REGISTER_FROZEN_COLUMNS;
                        const text = cells[c.index];
                        return (
                          <td
                            key={c.header}
                            // 已封存（勾「顯示已封存」才會出現）用淡灰底區分；凍結欄也要有底色才蓋得住捲過去的欄。
                            className={`border-b border-r border-gray-200 px-2 py-1.5 group-hover:bg-cyan-50 ${
                              p.archivedAt ? "bg-gray-100 text-gray-500" : "bg-white"
                            } ${
                              frozen ? "sticky z-10" : ""
                            } ${c.align === "right" ? "whitespace-nowrap text-right tabular-nums" : c.align === "left" ? "break-words text-left" : "break-words text-center"} ${
                              text === MASKED ? "text-gray-300" : ""
                            }`}
                            style={frozen ? { left: frozenLeft[i] } : undefined}
                            title={text === MASKED ? "無權限檢視此案金額" : undefined}
                          >
                            {c.index === 1 ? (
                              <Link
                                href={href}
                                className="font-mono text-xs font-medium hover:underline"
                                style={{ color: "var(--brand)" }}
                              >
                                {text || "—"}
                              </Link>
                            ) : (
                              text
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
