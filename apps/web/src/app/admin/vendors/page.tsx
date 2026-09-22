"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls, useToast } from "@/components/admin-ui";
import { buildRemittanceText, copyText } from "@/lib/remittance";
import {
  listVendors, createVendor, updateVendor, deleteVendor, getVendorCardUrl, scanVendorCard,
  type Vendor, type VendorInput,
} from "@/lib/company-api";

/**
 * 廠商名冊 · 名片建檔。
 * 名片流程：選影像 → API 存檔並送 Gemini 抽欄位 → 帶進表單 → 人確認後才「新增廠商」。
 * 辨識只給建議值，永遠不會自己建檔；沒設 AI 金鑰時名片按鈕會說明，手動建檔照常。
 *
 * M15（2026-09-23）：每列一個「複製帳號」——戶名／銀行（代號）／帳號三行，貼進網銀
 * 轉帳頁剛好對應欄位。戶名優先用 accountHolder（帳戶開戶名），沒填才退回廠商名稱；
 * 文字組裝與剪貼簿三段式退路共用 lib/remittance.ts（與放款單明細頁同一份）。
 */
type Form = {
  name: string; category: string; contactName: string; title: string; phone: string; mobile: string;
  email: string; address: string; taxId: string; website: string; note: string;
  bankName: string; bankCode: string; bankAccount: string; accountHolder: string;
};
const emptyForm = (): Form => ({
  name: "", category: "", contactName: "", title: "", phone: "", mobile: "", email: "", address: "", taxId: "", website: "", note: "",
  bankName: "", bankCode: "", bankAccount: "", accountHolder: "",
});
const fromVendor = (v: Vendor): Form => ({
  name: v.name, category: v.category ?? "", contactName: v.contactName ?? "", title: v.title ?? "", phone: v.phone ?? "", mobile: v.mobile ?? "",
  email: v.email ?? "", address: v.address ?? "", taxId: v.taxId ?? "", website: v.website ?? "", note: v.note ?? "",
  bankName: v.bankName ?? "", bankCode: v.bankCode ?? "", bankAccount: v.bankAccount ?? "", accountHolder: v.accountHolder ?? "",
});
const toInput = (f: Form): VendorInput => ({
  name: f.name.trim(),
  category: f.category.trim() || null, contactName: f.contactName.trim() || null, title: f.title.trim() || null,
  phone: f.phone.trim() || null, mobile: f.mobile.trim() || null, email: f.email.trim() || null, address: f.address.trim() || null,
  taxId: f.taxId.trim() || null, website: f.website.trim() || null, note: f.note.trim() || null,
  bankName: f.bankName.trim() || null, bankCode: f.bankCode.trim() || null, bankAccount: f.bankAccount.trim() || null, accountHolder: f.accountHolder.trim() || null,
});

export default function VendorsPage() {
  const toast = useToast();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Vendor | "new" | null>(null);
  const [form, setForm] = useState<Form>(emptyForm());
  const [cardPath, setCardPath] = useState<string | null>(null);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await listVendors(q.trim() || undefined);
      setVendors(r.vendors);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  function startNew() {
    setEditing("new"); setForm(emptyForm()); setCardPath(null); setCardPreview(null); setScanMsg(null);
  }
  async function startEdit(v: Vendor) {
    setEditing(v); setForm(fromVendor(v)); setCardPath(null); setScanMsg(null); setCardPreview(null);
    if (v.hasCard) {
      try { setCardPreview((await getVendorCardUrl(v.id)).url); } catch { /* 沒圖就沒圖 */ }
    }
  }

  async function onPickCard(file: File | undefined) {
    if (!file) return;
    setScanMsg("辨識中…");
    setBusy(true);
    try {
      setCardPreview(URL.createObjectURL(file));
      const r = await scanVendorCard(file);
      setCardPath(r.cardStoragePath);
      const f = r.fields as Record<string, string | boolean | null>;
      if (Object.keys(f).length === 0) {
        setScanMsg(`影像已存，但辨識失敗（${r.warning ?? "未知原因"}），請手填。`);
      } else {
        setForm((cur) => ({
          ...cur,
          name: (f.name as string) || cur.name,
          contactName: (f.contactName as string) || cur.contactName,
          title: (f.title as string) || cur.title,
          phone: (f.phone as string) || cur.phone,
          mobile: (f.mobile as string) || cur.mobile,
          email: (f.email as string) || cur.email,
          address: (f.address as string) || cur.address,
          taxId: (f.taxId as string) || cur.taxId,
          website: (f.website as string) || cur.website,
          category: (f.category as string) || cur.category,
        }));
        setScanMsg(`已帶入辨識結果（${r.model}），請逐欄核對再儲存。${f.taxIdValid === false ? " ⚠️ 統編檢查碼不符，可能辨識錯字。" : ""}`);
      }
      if (editing === null) setEditing("new");
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : "辨識失敗");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    if (!form.name.trim() || editing === null) return;
    setBusy(true);
    setError(null);
    try {
      const body: VendorInput = { ...toInput(form), ...(cardPath ? { cardStoragePath: cardPath, source: "card_ocr" as const } : {}) };
      if (editing === "new") await createVendor(body);
      else await updateVendor(editing.id, body);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  /** M15：把該廠商的匯款資訊放進剪貼簿。沒有帳號就不給按，免得貼出三行破折號。 */
  async function copyRemittance(v: Vendor) {
    const text = buildRemittanceText({
      payeeName: v.accountHolder ?? v.name,
      payeeBankName: v.bankName,
      payeeBankCode: v.bankCode,
      payeeBankAccount: v.bankAccount,
    });
    const ok = await copyText(text);
    if (ok) toast.show("已複製匯款資訊", "success");
  }

  async function remove(v: Vendor) {
    if (!confirm(`刪除廠商「${v.name}」？（軟刪除，紀錄仍保留）`)) return;
    try { await deleteVendor(v.id); await load(); } catch (err) { setError(err instanceof Error ? err.message : "刪除失敗"); }
  }

  const F = (k: keyof Form, label: string, ph?: string) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={inputCls} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={ph} />
    </div>
  );

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input className={`${inputCls} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱 / 窗口 / 統編 / 電話 / 類別" />
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onPickCard(e.target.files?.[0])} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50">
            📷 拍名片建檔
          </button>
          <PrimaryButton type="button" onClick={startNew}>手動新增</PrimaryButton>
          <span className="text-sm text-gray-500">{vendors.length} 家</span>
        </div>
        {vendors.length === 0 ? (
          <Empty>{q ? "沒有符合的廠商" : "尚無廠商。拍張名片或手動新增。"}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-3">廠商</th>
                  <th className="py-2 pr-3">類別</th>
                  <th className="py-2 pr-3">窗口</th>
                  <th className="py-2 pr-3">電話 / 手機</th>
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2 pr-3">統編</th>
                  <th className="py-2 pr-3">銀行</th>
                  <th className="py-2 pr-3">代碼</th>
                  <th className="py-2 pr-3">帳號</th>
                  <th className="py-2 pr-3">戶名</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => (
                  <tr key={v.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium text-gray-900">
                      {v.name}
                      {v.hasCard && <span className="ml-1 text-xs text-gray-400" title="有名片影像">🪪</span>}
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{v.category ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{v.contactName ?? "—"}{v.title ? <span className="text-xs text-gray-400">・{v.title}</span> : null}</td>
                    <td className="py-2 pr-3 text-gray-600">{[v.phone, v.mobile].filter(Boolean).join(" / ") || "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{v.email ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">
                      {v.taxId ?? "—"}
                      {v.taxIdValid === false && <span className="ml-1 text-xs text-amber-700" title="統一編號檢查碼不符">⚠</span>}
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{v.bankName ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{v.bankCode ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{v.bankAccount ?? "—"}</td>
                    <td className="py-2 pr-3 text-gray-600">{v.accountHolder ?? "—"}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => void copyRemittance(v)}
                        disabled={!v.bankAccount}
                        title={v.bankAccount ? "複製戶名／銀行／帳號" : "這家廠商還沒填帳號"}
                        className="mr-3 text-xs text-gray-600 hover:underline disabled:cursor-not-allowed disabled:text-gray-300 disabled:no-underline"
                      >
                        複製帳號
                      </button>
                      <button type="button" onClick={() => void startEdit(v)} className="mr-3 text-xs text-gray-600 hover:underline">編輯</button>
                      <button type="button" onClick={() => void remove(v)} className="text-xs text-gray-400 hover:text-red-600">刪除</button>
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
          <h2 className="mb-3 text-sm font-semibold text-gray-700">{editing === "new" ? "新增廠商" : `編輯：${editing.name}`}</h2>
          {scanMsg && <p className="mb-3 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800">{scanMsg}</p>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_260px]">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {F("name", "廠商 / 公司名稱 *")}
              {F("category", "類別", "例：印刷、建材、顧問")}
              {F("contactName", "窗口姓名")}
              {F("title", "職稱")}
              {F("phone", "電話")}
              {F("mobile", "手機")}
              {F("email", "Email")}
              {F("website", "網站")}
              {F("taxId", "統一編號", "8 碼")}
              {F("bankName", "銀行", "例：兆豐銀行")}
              {F("bankCode", "銀行代碼", "例：017")}
              {F("bankAccount", "帳號")}
              {F("accountHolder", "戶名", "帳戶開戶姓名／公司名，供放款核對用")}
              <div className="sm:col-span-2">{F("address", "地址")}</div>
              <div className="sm:col-span-2">
                <label className={labelCls}>備註</label>
                <textarea className={`${inputCls} min-h-[72px]`} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className={labelCls}>名片影像</label>
              {cardPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cardPreview} alt="名片" className="w-full rounded-md border border-gray-200 object-contain" />
              ) : (
                <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-gray-300 text-xs text-gray-400">尚無影像</div>
              )}
              <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="mt-2 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-50">
                {cardPreview ? "換一張並重新辨識" : "上傳名片並辨識"}
              </button>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy || !form.name.trim()}>{busy ? "處理中…" : editing === "new" ? "新增廠商" : "儲存"}</PrimaryButton>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-gray-500 hover:underline">取消</button>
          </div>
        </Card>
      )}
    </>
  );
}
