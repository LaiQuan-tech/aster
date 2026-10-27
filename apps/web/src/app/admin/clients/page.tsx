"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, Empty, ErrorText, Pill, PrimaryButton, inputCls, labelCls, useToast } from "@/components/admin-ui";
import {
  listClients, createClient, updateClient, deleteClient, humanizeClientError, clientSaveWarningText,
  INVOICE_TYPE_LABELS, PAYMENT_METHOD_LABELS,
  type Client, type InvoiceType, type PaymentMethod, type ClientCategory,
} from "@/lib/projects-ext-api";
import { OPTION_INACTIVE_MARK, optionChoices, optionLabel, useOptionList } from "@/lib/option-lists-api";
import { getMeCached, peekMeCached } from "@/lib/ess-state";
import { isHrRole } from "@/lib/roles";
import { humanizeAffiliateError } from "@/lib/affiliate";
import { CLIENT_EXCEL_COLUMNS, clientCellText, sortClientsByRegion } from "@/lib/roster-columns";
import { clientFormFrom, clientFormToInput, emptyClientForm, type ClientForm, type ClientTextKey } from "@/lib/roster-forms";

/**
 * 客戶名冊（模組五）。建案表單的客戶下拉、專案申請單列印都吃這裡的資料。
 * 統編非必填（自然人業主或尚未取得統編的案子可以先建檔），比照廠商名冊
 * 的軟刪除慣例——刪除只是從列表收起來，往來紀錄不會消失。
 *
 * 關係企業（2026-10-11）：表單可勾「關係企業（集團內姊妹公司）」，列表名稱旁顯示徽章。集團總覽的集團合計
 * 會剔除這類客戶的專案收入（各公司自己的數字照常包含）。這個標記會改變老闆看的集團數字，所以只有
 * HR／平台管理員能設定（API 對會計回 403 affiliate_hr_only）；會計看得到但勾選框是停用的，
 * 存檔時也只在旗標有變動才送出，免得會計改別的欄位被擋。
 *
 * 分類（2026-10-10）：選項不再寫死，吃「設定 → 選項清單 → 客戶分類」（`useOptionList("client_category")`），
 * 管理員可自行新增。篩選下拉列出全部項目（含已停用的——舊客戶可能還用著）；表單下拉只列啟用的項目，
 * 外加這位客戶目前已選的停用項（標「（已停用）」，開舊客戶編輯時下拉不會悄悄換成「未分類」）。
 *
 * 欄位對齊 Excel（2026-10-27）：列表欄位與順序＝業主「客供商基本資料／客戶資料」（lib/roster-columns.ts），
 * 可橫向捲動、第一欄（簡稱）凍結。Excel 沒有的欄位（分類、發票聯式、結帳日、付款日、關係企業）只在編輯表單的「其他」區；
 * 分類仍可在上方篩選。刪除限 HR（API requireHrAdmin），會計看不到刪除鈕。
 */
export default function ClientsPage() {
  const toast = useToast();
  const categories = useOptionList("client_category");
  /** 分類 code → 名稱；清單載入中先顯示「…」，免得閃過原始代碼。 */
  const categoryText = (code: string) => (categories.loading ? "…" : optionLabel(categories.items, code));
  const [clients, setClients] = useState<Client[]>([]);
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ClientCategory | "">("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  const [form, setForm] = useState<ClientForm>(emptyClientForm());
  const [busy, setBusy] = useState(false);
  // 只有 HR／平台管理員能設定關係企業（會計 API 會 403）；取不到角色就當不能。
  const [canSetAffiliate, setCanSetAffiliate] = useState(() => isHrRole(peekMeCached()?.role));
  useEffect(() => {
    let active = true;
    getMeCached()
      .then((me) => {
        if (active) setCanSetAffiliate(isHrRole(me.role));
      })
      .catch(() => {
        if (active) setCanSetAffiliate(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await listClients(q.trim() || undefined);
      setClients(r.clients);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  function startNew() {
    setEditing("new");
    setForm(emptyClientForm());
    setError(null);
  }
  function startEdit(c: Client) {
    setEditing(c);
    setForm(clientFormFrom(c));
    setError(null);
  }

  const [regionSort, setRegionSort] = useState<"asc" | "desc" | null>(null);
  const filtered = categoryFilter ? clients.filter((c) => c.category === categoryFilter) : clients;
  const shown = regionSort ? sortClientsByRegion(filtered, regionSort) : filtered;

  async function save() {
    if (!form.name.trim() || editing === null) return;
    const parsed = clientFormToInput(form, editing === "new" ? null : editing);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = parsed.input;
      const res = editing === "new" ? await createClient(body) : await updateClient(editing.id, body);
      const warning = clientSaveWarningText(res);
      if (warning) toast.show(warning, "info");
      setEditing(null);
      await load();
    } catch (err) {
      const msg = humanizeAffiliateError(humanizeClientError(err, "儲存失敗"));
      setError(msg.includes("migration_required") ? "資料庫尚未更新（名冊新欄位），請先套用 migration 0076 再存這些欄位。" : msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: Client) {
    if (!confirm(`刪除客戶「${c.name}」？（軟刪除，往來紀錄仍保留）`)) return;
    try {
      await deleteClient(c.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  const F = (k: ClientTextKey, label: string, opts: { ph?: string; maxLength?: number; multiline?: boolean; wide?: boolean } = {}) => (
    <div className={opts.wide ? "sm:col-span-2" : undefined}>
      <label className={labelCls}>{label}</label>
      {opts.multiline ? (
        <textarea
          className={`${inputCls} min-h-[60px]`}
          value={form[k]}
          onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
          placeholder={opts.ph}
          maxLength={opts.maxLength}
        />
      ) : (
        <input className={inputCls} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={opts.ph} maxLength={opts.maxLength} />
      )}
    </div>
  );

  /** 第一欄（簡稱）凍結：沒填簡稱時以灰字帶出公司名稱，捲到右邊仍認得是哪一家。 */
  // 左側凍結兩欄：區域（固定寬）＋簡稱（接在區域右邊）。
  const stickyColClass = (key: string, bg: string) =>
    key === "region" ? `sticky left-0 z-10 w-20 min-w-20 max-w-20 pl-2 ${bg}` : key === "shortName" ? `sticky left-20 z-10 ${bg}` : "";

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input className={`${inputCls} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱 / 簡稱 / 統編 / 承辦 / 電話" />
          <select
            className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as ClientCategory | "")}
            aria-label="客戶分類篩選"
          >
            <option value="">全部分類</option>
            {categories.items.map((item) => (
              <option key={item.code} value={item.code}>{item.label}{item.isActive ? "" : OPTION_INACTIVE_MARK}</option>
            ))}
          </select>
          {categories.canManage && (
            <Link href="/admin/option-lists" className="text-xs text-gray-500 underline hover:text-gray-700">管理分類</Link>
          )}
          {categories.error && (
            <button type="button" onClick={categories.reload} className="text-xs text-red-600 underline">分類載入失敗，點此重試</button>
          )}
          <PrimaryButton type="button" onClick={startNew}>新增客戶</PrimaryButton>
          <span className="text-sm text-gray-500">{shown.length} 家{categoryFilter ? `（共 ${clients.length} 家）` : ""}</span>
        </div>
        {shown.length === 0 ? (
          <Empty>{q || categoryFilter ? "沒有符合的客戶" : "尚無客戶，請先新增。"}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-max min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium text-gray-600">
                  {CLIENT_EXCEL_COLUMNS.map((col) => (
                    <th key={col.key} scope="col" className={`whitespace-nowrap py-2 pr-3 ${stickyColClass(col.key, "bg-gray-50")}`} aria-sort={col.key === "region" && regionSort ? (regionSort === "asc" ? "ascending" : "descending") : undefined}>
                      {col.key === "region" ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-gray-900"
                          onClick={() => setRegionSort((s) => (s === null ? "asc" : s === "asc" ? "desc" : null))}
                          title="依區域排序（再按一次反向，第三次取消）"
                        >
                          {col.header}
                          <span aria-hidden className={regionSort ? "text-[var(--brand)]" : "text-gray-400"}>{regionSort === "asc" ? "▲" : regionSort === "desc" ? "▼" : "↕"}</span>
                        </button>
                      ) : (
                        col.header
                      )}
                    </th>
                  ))}
                  <th scope="col" className="sticky right-0 z-10 bg-gray-50 py-2 pl-3 pr-2"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className="group border-b border-gray-100 align-top last:border-0 hover:bg-gray-50">
                    {CLIENT_EXCEL_COLUMNS.map((col) => {
                      const value = clientCellText(c, col.key, PAYMENT_METHOD_LABELS);
                      if (col.key === "region") {
                        return (
                          <td key={col.key} className={`${stickyColClass(col.key, "bg-white group-hover:bg-gray-50")} whitespace-nowrap py-2 pr-3 text-gray-600`}>
                            {value || "—"}
                          </td>
                        );
                      }
                      if (col.key === "shortName") {
                        return (
                          <th key={col.key} scope="row" className={`${stickyColClass(col.key, "bg-white group-hover:bg-gray-50")} whitespace-nowrap py-2 pr-3 text-left font-medium text-gray-900`}>
                            {value || <span className="font-normal text-gray-400" title="未填簡稱，顯示公司名稱">{c.name}</span>}
                          </th>
                        );
                      }
                      if (col.key === "name") {
                        return (
                          <td key={col.key} className="min-w-[10rem] py-2 pr-3 text-gray-900">
                            {value}
                            {c.isAffiliate === true && <Pill tone="blue" className="ml-1.5 align-middle">關係企業</Pill>}
                            {c.category && (
                              <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 align-middle text-xs text-gray-600">{categoryText(c.category)}</span>
                            )}
                          </td>
                        );
                      }
                      return (
                        <td
                          key={col.key}
                          className={`py-2 pr-3 text-gray-600 ${col.multiline ? "min-w-[9rem] max-w-[18rem] whitespace-pre-line break-words" : "whitespace-nowrap"}`}
                        >
                          {value || "—"}
                        </td>
                      );
                    })}
                    <td className="sticky right-0 z-10 whitespace-nowrap bg-white py-2 pl-3 pr-2 text-right group-hover:bg-gray-50">
                      <button type="button" onClick={() => startEdit(c)} className="mr-3 text-xs text-gray-600 hover:underline">編輯</button>
                      {canSetAffiliate && (
                        <button type="button" onClick={() => void remove(c)} className="text-xs text-gray-400 hover:text-red-600">刪除</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing !== null && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-gray-700">{editing === "new" ? "新增客戶" : `編輯：${editing.name}`}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {F("shortName", "簡稱", { ph: "選填，最長 40 字", maxLength: 40 })}
            {F("region", "區域", { ph: "例：台北市", maxLength: 40 })}
            {F("code", "編號", { maxLength: 40 })}
            {F("name", "公司名稱 *", { maxLength: 200, wide: true })}
            {F("phone", "TEL", { multiline: true, maxLength: 200 })}
            {F("fax", "FAX", { multiline: true, maxLength: 200 })}
            {F("contactName", "承辦窗口", { multiline: true, maxLength: 300 })}
            {F("contactPhone", "Mobil", { multiline: true, maxLength: 200 })}
            {F("email", "e-mail", { multiline: true, maxLength: 500 })}
            {F("invoiceAddress", "公司地址", { ph: "也是開立發票用的地址", maxLength: 300 })}
            {F("taxId", "統編", { ph: "8 碼" })}
            <div>
              <label className={labelCls}>收款方式</label>
              <select className={inputCls} value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value as PaymentMethod | "" }))}>
                <option value="">未指定</option>
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((v) => (
                  <option key={v} value={v}>{PAYMENT_METHOD_LABELS[v]}</option>
                ))}
              </select>
            </div>
            {F("note", "備註", { multiline: true, maxLength: 2000, wide: true })}
          </div>
          <h3 className="mb-2 mt-4 text-xs font-semibold text-gray-500">其他（Excel 沒有的欄位）</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>分類</label>
              <select
                className={inputCls}
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ClientCategory | "" }))}
              >
                <option value="">未分類</option>
                {optionChoices(categories.items, form.category).map((choice) => (
                  <option key={choice.code} value={choice.code}>{choice.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>發票聯式</label>
              <select className={inputCls} value={form.invoiceType} onChange={(e) => setForm((f) => ({ ...f, invoiceType: e.target.value as InvoiceType | "" }))}>
                <option value="">未指定</option>
                {(Object.keys(INVOICE_TYPE_LABELS) as InvoiceType[]).map((v) => (
                  <option key={v} value={v}>{INVOICE_TYPE_LABELS[v]}</option>
                ))}
              </select>
            </div>
            {F("closingDay", "結帳日", { ph: "例：每月 5 日" })}
            {F("paymentDay", "付款日", { ph: "例：次月 10 日" })}
            <div className="sm:col-span-2">
              <label className={`flex items-start gap-2 text-sm ${canSetAffiliate ? "cursor-pointer text-gray-700" : "text-gray-400"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={form.isAffiliate}
                  disabled={!canSetAffiliate}
                  onChange={(e) => setForm((f) => ({ ...f, isAffiliate: e.target.checked }))}
                />
                <span>
                  關係企業（集團內姊妹公司）
                  <span className="block text-xs text-gray-400">
                    勾選後，這家客戶的專案收入在「集團總覽」的集團合計中會被剔除（各公司自己的數字照常包含）。
                    {canSetAffiliate ? "" : "只有 HR 可以設定。"}
                  </span>
                </span>
              </label>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button type="button" variant="secondary" className="md:min-h-10" onClick={() => setEditing(null)}>取消</Button>
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy || !form.name.trim()}>{busy ? "處理中…" : editing === "new" ? "新增客戶" : "儲存"}</PrimaryButton>
          </div>
        </Card>
      )}
    </>
  );
}
