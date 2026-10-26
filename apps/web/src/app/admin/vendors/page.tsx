"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Empty, ErrorText, Pill, PrimaryButton, inputCls, labelCls, useToast } from "@/components/admin-ui";
import { buildRemittanceText, copyText } from "@/lib/remittance";
import { getMeCached, peekMeCached } from "@/lib/ess-state";
import { isHrRole } from "@/lib/roles";
import { humanizeAffiliateError } from "@/lib/affiliate";
import {
  listVendors, createVendor, updateVendor, deleteVendor, getVendorCardUrl, scanVendorCard,
  type Vendor, type VendorInput, type VendorRosterKind,
} from "@/lib/company-api";
import {
  VENDOR_EXCEL_COLUMNS, VENDOR_ROSTER_KINDS, VENDOR_ROSTER_KIND_LABELS,
  countVendorsByKind, filterVendorsByKind, vendorCellText, vendorRosterKind,
} from "@/lib/roster-columns";
import { emptyVendorForm, vendorFormFrom, vendorFormToInput, type VendorForm, type VendorTextKey } from "@/lib/roster-forms";

/**
 * 廠商名冊 · 名片建檔。
 * 名片流程：選影像 → API 存檔並送 Gemini 抽欄位 → 帶進表單 → 人確認後才「新增廠商」。
 * 辨識只給建議值，永遠不會自己建檔；沒設 AI 金鑰時名片按鈕會說明，手動建檔照常。
 *
 * M15（2026-09-23）：每列一個「複製帳號」——戶名／銀行（代號）／帳號三行，貼進網銀
 * 轉帳頁剛好對應欄位。戶名優先用 accountHolder（帳戶開戶名），沒填才退回廠商名稱；
 * 文字組裝與剪貼簿三段式退路共用 lib/remittance.ts（與放款單明細頁同一份）。
 *
 * 關係企業（2026-10-11）：表單可勾「關係企業（集團內姊妹公司）」，列表名稱旁顯示徽章。集團總覽的集團合計
 * 會剔除付給這類廠商的放款（各公司自己的數字照常包含）。這個標記會改變老闆看的集團數字，所以只有
 * HR／平台管理員能設定（API 對其他角色回 403 affiliate_hr_only）；其他人看得到但勾選框是停用的，
 * 存檔時也只在旗標有變動才送出，免得改別的欄位被擋。
 *
 * 欄位對齊 Excel（2026-10-27）：列表欄位與順序＝業主的「客供商基本資料」（lib/roster-columns.ts），
 * 可橫向捲動、第一欄（簡稱）凍結；三個工作表（供應商／技師／送審相關單位）用上方頁籤篩選。
 * Excel 沒有的欄位（職稱、銀行帳戶、關係企業、名片）只在編輯表單的「其他」區。
 */
export default function VendorsPage() {
  const toast = useToast();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<VendorRosterKind | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Vendor | "new" | null>(null);
  const [form, setForm] = useState<VendorForm>(emptyVendorForm());
  const [cardPath, setCardPath] = useState<string | null>(null);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // 只有 HR／平台管理員能設定關係企業（其他角色 API 會 403）；取不到角色就當不能。
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
    setEditing("new"); setForm(emptyVendorForm(kind === "all" ? "supplier" : kind)); setCardPath(null); setCardPreview(null); setScanMsg(null); setError(null);
  }
  async function startEdit(v: Vendor) {
    setEditing(v); setForm(vendorFormFrom(v)); setCardPath(null); setScanMsg(null); setCardPreview(null); setError(null);
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
    const parsed = vendorFormToInput(form, editing === "new" ? null : editing);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: VendorInput = { ...parsed.input, ...(cardPath ? { cardStoragePath: cardPath, source: "card_ocr" as const } : {}) };
      if (editing === "new") await createVendor(body);
      else await updateVendor(editing.id, body);
      setEditing(null);
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "儲存失敗";
      setError(msg.includes("migration_required") ? "資料庫尚未更新（名冊新欄位），請先套用 migration 0076 再存這些欄位。" : humanizeAffiliateError(msg));
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

  const counts = useMemo(() => countVendorsByKind(vendors), [vendors]);
  const shown = useMemo(() => filterVendorsByKind(vendors, kind), [vendors, kind]);

  const F = (k: VendorTextKey, label: string, opts: { ph?: string; maxLength?: number; multiline?: boolean; wide?: boolean } = {}) => (
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
  const stickyCell = "sticky left-0 z-10 bg-white";

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="名冊類別">
          {(["all", ...VENDOR_ROSTER_KINDS] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={`rounded-full border px-3 py-1 text-sm ${kind === k ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-700 hover:bg-gray-50"}`}
            >
              {k === "all" ? "全部" : VENDOR_ROSTER_KIND_LABELS[k]}
              <span className={`ml-1 text-xs ${kind === k ? "text-gray-200" : "text-gray-400"}`}>{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input className={`${inputCls} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱 / 簡稱 / 窗口 / 統編 / 電話 / 類別 / 細目" />
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onPickCard(e.target.files?.[0])} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50">
            📷 拍名片建檔
          </button>
          <PrimaryButton type="button" onClick={startNew}>手動新增</PrimaryButton>
          <span className="text-sm text-gray-500">{shown.length} 家{kind !== "all" ? `（共 ${vendors.length} 家）` : ""}</span>
        </div>
        {shown.length === 0 ? (
          <Empty>{q || kind !== "all" ? "沒有符合的廠商" : "尚無廠商。拍張名片或手動新增。"}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-max min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  {VENDOR_EXCEL_COLUMNS.map((col, i) => (
                    <th key={col.key} scope="col" className={`whitespace-nowrap py-2 pr-3 ${i === 0 ? `${stickyCell} pl-1` : ""}`}>{col.header}</th>
                  ))}
                  <th scope="col" className="sticky right-0 z-10 bg-white py-2 pl-3"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => (
                  <tr key={v.id} className="border-b align-top last:border-0">
                    {VENDOR_EXCEL_COLUMNS.map((col, i) => {
                      const value = vendorCellText(v, col.key);
                      if (i === 0) {
                        return (
                          <th key={col.key} scope="row" className={`${stickyCell} whitespace-nowrap py-2 pl-1 pr-3 text-left font-medium text-gray-900`}>
                            {value || <span className="font-normal text-gray-400" title="未填簡稱，顯示公司名稱">{v.name}</span>}
                          </th>
                        );
                      }
                      if (col.key === "name") {
                        return (
                          <td key={col.key} className="min-w-[10rem] py-2 pr-3 text-gray-900">
                            {value}
                            {v.hasCard && <span className="ml-1 text-xs text-gray-400" title="有名片影像">🪪</span>}
                            {v.isAffiliate === true && <Pill tone="blue" className="ml-1.5 align-middle">關係企業</Pill>}
                            {kind === "all" && vendorRosterKind(v) !== "supplier" && (
                              <Pill tone="gray" className="ml-1.5 align-middle">{VENDOR_ROSTER_KIND_LABELS[vendorRosterKind(v)]}</Pill>
                            )}
                          </td>
                        );
                      }
                      if (col.key === "taxId") {
                        return (
                          <td key={col.key} className="whitespace-nowrap py-2 pr-3 text-gray-600">
                            {value || "—"}
                            {v.taxIdValid === false && <span className="ml-1 text-xs text-amber-700" title="統一編號檢查碼不符">⚠</span>}
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
                    <td className="sticky right-0 z-10 whitespace-nowrap bg-white py-2 pl-3 text-right">
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
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls}>名冊類別</label>
                  <select
                    className={inputCls}
                    value={form.rosterKind}
                    onChange={(e) => setForm((f) => ({ ...f, rosterKind: e.target.value as VendorRosterKind }))}
                  >
                    {VENDOR_ROSTER_KINDS.map((k) => (
                      <option key={k} value={k}>{VENDOR_ROSTER_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                </div>
                {F("shortName", "簡稱", { ph: "選填，最長 40 字", maxLength: 40 })}
                {F("seq", "序", { ph: "整數" })}
                {F("category", "類別", { ph: "例：廠商、空調、電力", maxLength: 60 })}
                {F("subCategory", "細目", { ph: "例：電線電纜、消防", maxLength: 60 })}
                {F("code", "編號", { maxLength: 40 })}
                {F("name", "公司名稱 *", { maxLength: 120, wide: true })}
                {F("phone", "TEL", { multiline: true, maxLength: 200 })}
                {F("fax", "FAX", { multiline: true, maxLength: 200 })}
                {F("contactName", "承辦窗口", { multiline: true, maxLength: 300 })}
                {F("mobile", "Mobil", { multiline: true, maxLength: 200 })}
                {F("email", "E-mail", { multiline: true, maxLength: 500 })}
                {F("address", "公司地址", { maxLength: 300 })}
                {F("taxId", "統編", { ph: "8 碼" })}
                {F("paymentTerms", "付款方式", { ph: "例：現金、月結", maxLength: 100 })}
                {F("website", "網址", { maxLength: 200 })}
                {F("note", "備註", { multiline: true, maxLength: 2000, wide: true })}
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold text-gray-500">其他（Excel 沒有的欄位）</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {F("title", "職稱", { maxLength: 60 })}
                  {F("bankName", "銀行", { ph: "例：兆豐銀行" })}
                  {F("bankCode", "銀行代碼", { ph: "例：017" })}
                  {F("bankAccount", "帳號")}
                  {F("accountHolder", "戶名", { ph: "帳戶開戶姓名／公司名，供放款核對用" })}
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
                          勾選後，付給這家廠商的放款在「集團總覽」的集團合計中會被剔除（各公司自己的數字照常包含）。
                          {canSetAffiliate ? "" : "只有 HR 管理員可以設定。"}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
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
            <Button type="button" variant="secondary" className="md:min-h-10" onClick={() => setEditing(null)}>取消</Button>
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy || !form.name.trim()}>{busy ? "處理中…" : editing === "new" ? "新增廠商" : "儲存"}</PrimaryButton>
          </div>
        </Card>
      )}
    </>
  );
}
