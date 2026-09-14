"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import {
  listClients, createClient, updateClient, deleteClient, humanizeClientError,
  INVOICE_TYPE_LABELS, PAYMENT_METHOD_LABELS, CLIENT_CATEGORY_LABELS, CLIENT_CATEGORY_ORDER,
  type Client, type ClientInput, type InvoiceType, type PaymentMethod, type ClientCategory,
} from "@/lib/projects-ext-api";

/**
 * 客戶名冊（模組五）。建案表單的客戶下拉、專案申請單列印都吃這裡的資料。
 * 統編非必填（自然人業主或尚未取得統編的案子可以先建檔），比照廠商名冊
 * 的軟刪除慣例——刪除只是從列表收起來，往來紀錄不會消失。
 */
type Form = {
  name: string; category: ClientCategory | ""; taxId: string; phone: string; fax: string; invoiceAddress: string;
  contactName: string; contactPhone: string; email: string;
  invoiceType: InvoiceType | ""; paymentMethod: PaymentMethod | ""; closingDay: string; paymentDay: string;
  note: string;
};
const emptyForm = (): Form => ({
  name: "", category: "", taxId: "", phone: "", fax: "", invoiceAddress: "", contactName: "", contactPhone: "", email: "",
  invoiceType: "", paymentMethod: "", closingDay: "", paymentDay: "", note: "",
});
const fromClient = (c: Client): Form => ({
  name: c.name, category: c.category ?? "", taxId: c.taxId ?? "", phone: c.phone ?? "", fax: c.fax ?? "", invoiceAddress: c.invoiceAddress ?? "",
  contactName: c.contactName ?? "", contactPhone: c.contactPhone ?? "", email: c.email ?? "",
  invoiceType: c.invoiceType ?? "", paymentMethod: c.paymentMethod ?? "", closingDay: c.closingDay ?? "", paymentDay: c.paymentDay ?? "",
  note: c.note ?? "",
});
const toInput = (f: Form): ClientInput => ({
  name: f.name.trim(),
  category: f.category || null,
  taxId: f.taxId.trim() || null,
  phone: f.phone.trim() || null,
  fax: f.fax.trim() || null,
  invoiceAddress: f.invoiceAddress.trim() || null,
  contactName: f.contactName.trim() || null,
  contactPhone: f.contactPhone.trim() || null,
  email: f.email.trim() || null,
  invoiceType: f.invoiceType || null,
  paymentMethod: f.paymentMethod || null,
  closingDay: f.closingDay.trim() || null,
  paymentDay: f.paymentDay.trim() || null,
  note: f.note.trim() || null,
});

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ClientCategory | "">("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Client | "new" | null>(null);
  const [form, setForm] = useState<Form>(emptyForm());
  const [busy, setBusy] = useState(false);

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
    setForm(emptyForm());
    setError(null);
  }
  function startEdit(c: Client) {
    setEditing(c);
    setForm(fromClient(c));
    setError(null);
  }

  const shown = categoryFilter ? clients.filter((c) => c.category === categoryFilter) : clients;

  async function save() {
    if (!form.name.trim() || editing === null) return;
    setBusy(true);
    setError(null);
    try {
      const body = toInput(form);
      if (editing === "new") await createClient(body);
      else await updateClient(editing.id, body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(humanizeClientError(err, "儲存失敗"));
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

  const F = (k: keyof Form, label: string, ph?: string) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={inputCls} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={ph} />
    </div>
  );

  return (
    <>
      <PageHeader title="客戶名冊" desc="業主／開票對象；建案時可直接選用，發票聯式與付款方式會預填到新專案" />
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input className={`${inputCls} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱 / 統編 / 承辦" />
          <select
            className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as ClientCategory | "")}
          >
            <option value="">全部分類</option>
            {CLIENT_CATEGORY_ORDER.map((v) => (
              <option key={v} value={v}>{CLIENT_CATEGORY_LABELS[v]}</option>
            ))}
          </select>
          <PrimaryButton type="button" onClick={startNew}>新增客戶</PrimaryButton>
          <span className="text-sm text-gray-500">{shown.length} 家{categoryFilter ? `（共 ${clients.length} 家）` : ""}</span>
        </div>
        {shown.length === 0 ? (
          <Empty>{q || categoryFilter ? "沒有符合的客戶" : "尚無客戶，請先新增。"}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-3">客戶</th>
                  <th className="py-2 pr-3">分類</th>
                  <th className="py-2 pr-3">統編</th>
                  <th className="py-2 pr-3">採購承辦</th>
                  <th className="py-2 pr-3">電話</th>
                  <th className="py-2 pr-3">發票聯式</th>
                  <th className="py-2 pr-3">付款方式</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium text-gray-900">{c.name}</td>
                    <td className="py-2 pr-3 text-gray-600">
                      {c.category ? (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{CLIENT_CATEGORY_LABELS[c.category]}</span>
                      ) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{c.taxId ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.contactName ?? "—"}{c.contactPhone ? <span className="text-xs text-gray-400">・{c.contactPhone}</span> : null}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.phone ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.invoiceType ? INVOICE_TYPE_LABELS[c.invoiceType] : "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{c.paymentMethod ? PAYMENT_METHOD_LABELS[c.paymentMethod] : "—"}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button type="button" onClick={() => startEdit(c)} className="mr-3 text-xs text-gray-600 hover:underline">編輯</button>
                      <button type="button" onClick={() => void remove(c)} className="text-xs text-gray-400 hover:text-red-600">刪除</button>
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
            {F("name", "名稱 *")}
            <div>
              <label className={labelCls}>分類</label>
              <select
                className={inputCls}
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ClientCategory | "" }))}
              >
                <option value="">未分類</option>
                {CLIENT_CATEGORY_ORDER.map((v) => (
                  <option key={v} value={v}>{CLIENT_CATEGORY_LABELS[v]}</option>
                ))}
              </select>
            </div>
            {F("taxId", "統一編號", "8 碼")}
            {F("phone", "電話")}
            {F("fax", "傳真")}
            {F("contactName", "採購承辦")}
            {F("contactPhone", "承辦電話")}
            {F("email", "Email")}
            <div>
              <label className={labelCls}>發票聯式</label>
              <select className={inputCls} value={form.invoiceType} onChange={(e) => setForm((f) => ({ ...f, invoiceType: e.target.value as InvoiceType | "" }))}>
                <option value="">未指定</option>
                {(Object.keys(INVOICE_TYPE_LABELS) as InvoiceType[]).map((v) => (
                  <option key={v} value={v}>{INVOICE_TYPE_LABELS[v]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>付款方式</label>
              <select className={inputCls} value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value as PaymentMethod | "" }))}>
                <option value="">未指定</option>
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((v) => (
                  <option key={v} value={v}>{PAYMENT_METHOD_LABELS[v]}</option>
                ))}
              </select>
            </div>
            {F("closingDay", "結帳日", "例：每月 5 日")}
            {F("paymentDay", "付款日", "例：次月 10 日")}
            <div className="sm:col-span-2">{F("invoiceAddress", "發票地址")}</div>
            <div className="sm:col-span-2">
              <label className={labelCls}>備註</label>
              <textarea className={`${inputCls} min-h-[72px]`} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy || !form.name.trim()}>{busy ? "處理中…" : editing === "new" ? "新增客戶" : "儲存"}</PrimaryButton>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-gray-500 hover:underline">取消</button>
          </div>
        </Card>
      )}
    </>
  );
}
