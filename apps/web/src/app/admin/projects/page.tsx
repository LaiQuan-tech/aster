"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import { ClientCombo } from "@/components/ClientCombo";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import {
  getProjectSettings,
  updateProjectSettings,
  statusLabel,
  PROJECT_STATUS_ORDER,
  PROJECT_STATUS_LABELS,
  PROJECT_SORT_LABELS,
  type ShareMode,
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
  humanizeClientError,
  humanizeProjectExtError,
  clientNameOf,
  PROJECT_KIND_LABELS,
  PROJECT_KIND_ORDER,
  CLIENT_CATEGORY_LABELS,
  CLIENT_CATEGORY_ORDER,
  type ProjectListItem,
  type ProjectKind,
  type Client,
  type ClientCategory,
} from "@/lib/projects-ext-api";

/** 瀏覽器當地日期 'YYYY-MM-DD'——開案日期表單欄位的預設值（今天）。 */
function todayLocalKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const STATUS_BADGE: Record<ProjectStatus, string> = {
  active: "bg-green-50 text-green-700",
  suspended: "bg-amber-50 text-amber-700",
  closed: "bg-gray-100 text-gray-600",
  terminated: "bg-red-50 text-red-700",
};

export default function AdminProjectsPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [emps, setEmps] = useState<Employee[]>([]);
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

  // create form
  const [name, setName] = useState("");
  // 編號留空＝系統產號（P{建立年}-{流水號}）。填了就是人工指定，撞號後端回 409。
  const [code, setCode] = useState("");
  const [fiscalYear, setFiscalYear] = useState("");
  // 開案日期（A5）：預設今天，事後補 K 單的案子可以改成實際開案那天。
  const [openedOn, setOpenedOn] = useState(todayLocalKey());
  const [description, setDescription] = useState("");
  const [deptId, setDeptId] = useState("");
  const [leadEmpId, setLeadEmpId] = useState("");
  const [shareMode, setShareMode] = useState<ShareMode>("pool_pct");
  const [bonusPool, setBonusPool] = useState("");
  const [clientId, setClientId] = useState("");
  const [kind, setKind] = useState<ProjectKind>("main");
  const [parentProjectId, setParentProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  /** 建立成功後回報系統產生的編號——使用者要知道拿到的是哪一個號。 */
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  // 就地新增客戶（模組五）
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientTaxId, setNewClientTaxId] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientCategory, setNewClientCategory] = useState<ClientCategory | "">("");
  const [creatingClient, setCreatingClient] = useState(false);

  // 預先取號（模組五）
  const [reserveCount, setReserveCount] = useState("1");
  const [reserving, setReserving] = useState(false);
  const [reservedCodes, setReservedCodes] = useState<string[] | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [p, cl, d, e, st] = await Promise.all([
        listProjectsExt({ includeArchived, includeReserved, sort, dir, year: yearFilter ? Number(yearFilter) : null }),
        listClients(),
        // 同 [id]/page.tsx：GET /departments 還是 HR 限定，會計拿不到就給空清單，
        // 不要讓整個專案列表因為一個下拉選單掛掉。
        getDepartments().catch(() => ({ departments: [] as Department[] })),
        getEmployees(),
        getProjectSettings(),
      ]);
      setSettings(st.settings);
      setProjects(p.projects);
      setClients(cl.clients);
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
  }, [includeArchived, includeReserved, sort, dir, yearFilter]);

  const mainProjects = projects.filter((p) => (p.kind ?? "main") === "main");

  async function submit() {
    if (!name.trim()) {
      setError("請輸入專案名稱");
      return;
    }
    if (kind !== "main" && !parentProjectId) {
      setError("變更設計／追加／代墊必須選擇母案");
      return;
    }
    setSaving(true);
    setError(null);
    setCreatedCode(null);
    try {
      const created = await createProjectExt({
        name: name.trim(),
        code: code.trim() || null,
        fiscalYear: fiscalYear ? Number(fiscalYear) : null,
        openedOn: openedOn || null,
        description: description.trim() || null,
        deptId: deptId || null,
        leadEmpId: leadEmpId || null,
        shareMode,
        bonusPool: shareMode === "pool_pct" && bonusPool ? Number(bonusPool) : null,
        clientId: clientId || null,
        kind,
        parentProjectId: kind === "main" ? null : parentProjectId,
      });
      setCreatedCode(created.code);
      setName("");
      setCode("");
      setFiscalYear("");
      setOpenedOn(todayLocalKey());
      setDescription("");
      setDeptId("");
      setLeadEmpId("");
      setBonusPool("");
      setShareMode("pool_pct");
      setClientId("");
      setKind("main");
      setParentProjectId("");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "建立失敗";
      setError(
        msg.includes("code_taken")
          ? `編號 ${code.trim()} 已被使用。請換一個，或清空讓系統自動產號。`
          : msg.includes("code_generation_failed")
            ? "系統產號連續碰撞，請稍候再試一次。"
            : humanizeProjectExtError(err, msg),
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitNewClient() {
    if (!newClientName.trim()) return;
    setCreatingClient(true);
    setError(null);
    try {
      const res = await createClient({
        name: newClientName.trim(),
        category: newClientCategory || null,
        taxId: newClientTaxId.trim() || null,
        phone: newClientPhone.trim() || null,
      });
      setClients((cs) => [...cs, res.client]);
      setClientId(res.client.id);
      setShowNewClient(false);
      setNewClientName("");
      setNewClientTaxId("");
      setNewClientPhone("");
      setNewClientCategory("");
    } catch (err) {
      setError(humanizeClientError(err, "新增客戶失敗"));
    } finally {
      setCreatingClient(false);
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
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">建立專案</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>專案名稱 *</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：官網改版" />
          </div>
          <div>
            <label className={labelCls}>開案日期</label>
            <input className={inputCls} type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} />
            <p className="mt-1 text-xs text-gray-400">預設今天；事後補登的案子請改成實際開案那天，不要用建立日或補單當天。</p>
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

          <div className="sm:col-span-2">
            <label className={labelCls}>客戶</label>
            <div className="flex flex-wrap items-center gap-2">
              <ClientCombo clients={clients} clientId={clientId || null} onChange={(id) => setClientId(id ?? "")} />
              <button
                type="button"
                onClick={() => setShowNewClient((v) => !v)}
                className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700"
              >
                {showNewClient ? "取消新增客戶" : "＋ 新增客戶"}
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-400">打字可過濾既有客戶；打不到符合的名字，用右邊「＋ 新增客戶」建檔。</p>
            {showNewClient && (
              <div className="mt-2 grid grid-cols-1 gap-2 rounded-lg border border-dashed border-gray-300 p-3 sm:grid-cols-5">
                <input className={inputCls} value={newClientName} onChange={(e) => setNewClientName(e.target.value)} placeholder="客戶名稱 *" />
                <select
                  className={inputCls}
                  value={newClientCategory}
                  onChange={(e) => setNewClientCategory(e.target.value as ClientCategory | "")}
                >
                  <option value="">分類（選填）</option>
                  {CLIENT_CATEGORY_ORDER.map((v) => (
                    <option key={v} value={v}>{CLIENT_CATEGORY_LABELS[v]}</option>
                  ))}
                </select>
                <input className={inputCls} value={newClientTaxId} onChange={(e) => setNewClientTaxId(e.target.value)} placeholder="統編（選填）" />
                <input className={inputCls} value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)} placeholder="電話（選填）" />
                <PrimaryButton type="button" onClick={submitNewClient} disabled={creatingClient || !newClientName.trim()}>
                  {creatingClient ? "建立中…" : "建立並選用"}
                </PrimaryButton>
              </div>
            )}
          </div>

          <div>
            <label className={labelCls}>案件類型</label>
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as ProjectKind)}>
              {PROJECT_KIND_ORDER.map((k) => (
                <option key={k} value={k}>{PROJECT_KIND_LABELS[k]}</option>
              ))}
            </select>
          </div>
          {kind !== "main" && (
            <div>
              <label className={labelCls}>母案 *</label>
              <select className={inputCls} value={parentProjectId} onChange={(e) => setParentProjectId(e.target.value)}>
                <option value="">請選擇母案</option>
                {mainProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.code ? `${p.code}　` : ""}{p.name}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">變更設計／追加／代墊都要掛回一個主案。</p>
            </div>
          )}

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
