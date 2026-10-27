"use client";

/**
 * 廠商內頁 /admin/vendors/[id]（2026-10-27 業主：列表按「編輯」直接進內頁編輯，比照員工內頁）。
 * /admin/vendors/new 是同一頁的新增模式（列表的「拍名片建檔」「手動新增」都導到這裡；?kind= 預選名冊類別）。
 *
 * 欄位、順序、驗證與原列表下方的編輯表單完全相同（lib/roster-forms.ts：vendorFormFrom／vendorFormToInput），
 * 沒有新 API：
 *   - 讀：GET /vendors（列表同一支，取這一筆；API 沒有單筆 GET）、名片影像 GET /vendors/:id/card
 *   - 寫：新增 POST /vendors、修改 PATCH /vendors/:id；名片辨識 POST /vendors/scan-card（只帶入建議值，人確認後才存）
 * 權限（沿用原列表，2026-10-27 業主決定）：新增／修改／名片辨識限會計與 HR（API requireFinance），其他角色整頁唯讀；
 * 收款帳戶（銀行四欄）只有會計與 HR 看得到（API 對其他人回 null，這裡整區不畫）；
 * 關係企業標記只有 HR／平台管理員能勾；刪除只有 HR／平台管理員看得到（API requireHrAdmin）。
 * 存檔：修改後留在內頁並顯示「已儲存」（比照員工內頁）；新增成功後換到這家廠商的內頁。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, Card, Empty, ErrorText, Pill, inputCls, labelCls, useToast } from "@/components/admin-ui";
import { RosterDetailHeader, RosterSaveBar, RosterSection, useRosterRoles } from "@/components/roster-detail";
import { useUnsavedChangesGuard } from "@/components/useUnsavedChangesGuard";
import { humanizeAffiliateError } from "@/lib/affiliate";
import {
  listVendors, createVendor, updateVendor, deleteVendor, getVendorCardUrl, scanVendorCard,
  type Vendor, type VendorInput, type VendorRosterKind,
} from "@/lib/company-api";
import { VENDOR_ROSTER_KINDS, VENDOR_ROSTER_KIND_LABELS, vendorRosterKind } from "@/lib/roster-columns";
import {
  NEW_ROSTER_ID, emptyVendorForm, rosterDetailHref, rosterFormDirty, vendorFormFrom, vendorFormToInput,
  type VendorForm, type VendorTextKey,
} from "@/lib/roster-forms";

const LIST_HREF = "/admin/vendors";
const UNSAVED_PROMPT = "這家廠商的資料還沒儲存，確定要離開嗎？";

function kindFromLocation(): VendorRosterKind {
  if (typeof window === "undefined") return "supplier";
  const k = new URLSearchParams(window.location.search).get("kind");
  return (VENDOR_ROSTER_KINDS as readonly string[]).includes(k ?? "") ? (k as VendorRosterKind) : "supplier";
}

export default function VendorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
  const isNew = id === NEW_ROSTER_ID;
  const toast = useToast();
  const { isHr, isAdmin } = useRosterRoles();
  const canSetAffiliate = isHr;
  const canDelete = isHr;
  const canEdit = isAdmin;
  /** 收款帳戶只給會計與 HR——與新增／修改同一組角色。 */
  const canSeeBank = canEdit;

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [baseline, setBaseline] = useState<VendorForm>(emptyVendorForm());
  const [form, setForm] = useState<VendorForm>(emptyVendorForm());
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [cardPath, setCardPath] = useState<string | null>(null);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 新增頁：依網址 ?kind= 預選名冊類別（列表在「技師」頁籤按新增就預設技師）。
  useEffect(() => {
    if (!isNew) return;
    const f = emptyVendorForm(kindFromLocation());
    setBaseline(f);
    setForm(f);
  }, [isNew]);

  const fetchVendor = useCallback(async () => {
    const r = await listVendors();
    const found = r.vendors.find((v) => v.id === id) ?? null;
    setVendor(found);
    setNotFound(!found);
    if (found) {
      const f = vendorFormFrom(found);
      setBaseline(f);
      setForm(f);
      setCardPath(null);
      if (found.hasCard) {
        try {
          setCardPreview((await getVendorCardUrl(found.id)).url);
        } catch {
          /* 沒圖就沒圖 */
        }
      }
    }
  }, [id]);

  useEffect(() => {
    if (isNew) return;
    let active = true;
    setLoading(true);
    fetchVendor()
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : "載入失敗");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchVendor, isNew]);

  const dirty = useMemo(() => canEdit && (rosterFormDirty(form, baseline) || cardPath !== null), [canEdit, form, baseline, cardPath]);
  const { leave } = useUnsavedChangesGuard(dirty, UNSAVED_PROMPT);

  async function onPickCard(file: File | undefined) {
    if (!file || !canEdit) return;
    setScanMsg("辨識中…");
    setScanning(true);
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
    } catch (err) {
      setScanMsg(err instanceof Error ? err.message : "辨識失敗");
    } finally {
      setScanning(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function cancel() {
    if (saving) return;
    if (dirty && !window.confirm("放棄這次的修改？")) return;
    if (isNew) {
      leave(LIST_HREF);
      return;
    }
    setForm(baseline);
    setCardPath(null);
    setScanMsg(null);
    setSaveError(null);
    if (vendor && !vendor.hasCard) setCardPreview(null);
    else if (vendor?.hasCard) void getVendorCardUrl(vendor.id).then((r) => setCardPreview(r.url)).catch(() => undefined);
  }

  async function save() {
    if (saving || !canEdit || !form.name.trim()) return;
    const parsed = vendorFormToInput(form, vendor);
    if (!parsed.ok) {
      setSaveError(parsed.error);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const body: VendorInput = { ...parsed.input, ...(cardPath ? { cardStoragePath: cardPath, source: "card_ocr" as const } : {}) };
      if (isNew) {
        const r = await createVendor(body);
        toast.show("已新增廠商", "success");
        leave(rosterDetailHref("vendors", r.vendor.id));
        return;
      }
      await updateVendor(id, body);
      toast.show("已儲存", "success");
      setScanMsg(null);
      try {
        await fetchVendor();
      } catch (err) {
        setSaveError(err instanceof Error ? `已儲存，但重新載入失敗：${err.message}` : "已儲存，但重新載入失敗");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "儲存失敗";
      setSaveError(msg.includes("migration_required") ? "資料庫尚未更新（名冊新欄位），請先套用 migration 0076 再存這些欄位。" : humanizeAffiliateError(msg));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!vendor || !canDelete) return;
    if (!confirm(`刪除廠商「${vendor.name}」？（軟刪除，紀錄仍保留）`)) return;
    try {
      await deleteVendor(vendor.id);
      toast.show("已刪除廠商", "success");
      leave(LIST_HREF);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  const F = (k: VendorTextKey, label: string, opts: { ph?: string; maxLength?: number; multiline?: boolean; wide?: boolean } = {}) => (
    <div className={opts.wide ? "sm:col-span-2" : undefined}>
      <label className={labelCls} htmlFor={`vendor-${k}`}>{label}</label>
      {opts.multiline ? (
        <textarea
          id={`vendor-${k}`}
          className={`${inputCls} min-h-[60px]`}
          value={form[k]}
          onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
          placeholder={opts.ph}
          maxLength={opts.maxLength}
        />
      ) : (
        <input id={`vendor-${k}`} className={inputCls} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={opts.ph} maxLength={opts.maxLength} />
      )}
    </div>
  );

  const backLink = <Link href={LIST_HREF} className="mt-3 inline-block text-sm text-gray-600 hover:underline">← 返回廠商列表</Link>;
  if (!isNew && loading && !vendor) return <Empty>載入中…</Empty>;
  if (!isNew && loadError && !vendor) {
    return (
      <Card>
        <ErrorText>{loadError}</ErrorText>
        {backLink}
      </Card>
    );
  }
  if (!isNew && (notFound || !vendor)) {
    return (
      <Card>
        <Empty>找不到這家廠商（可能已被刪除，或不在這個公司）。</Empty>
        {backLink}
      </Card>
    );
  }
  if (isNew && !canEdit) {
    return (
      <Card>
        <Empty>只有會計與 HR 可以新增廠商。</Empty>
        {backLink}
      </Card>
    );
  }

  const readOnly = !canEdit;
  const locked = readOnly || saving;
  const title = isNew ? "新增廠商" : vendor!.name;
  const subtitle = isNew
    ? "拍名片自動帶入欄位，或直接手填；核對後按「新增廠商」建檔。"
    : [vendor!.shortName && `簡稱 ${vendor!.shortName}`, vendor!.category, vendor!.taxId && `統編 ${vendor!.taxId}`].filter(Boolean).join("・") || undefined;

  return (
    <>
      <RosterDetailHeader
        backHref={LIST_HREF}
        backLabel="返回廠商列表"
        title={title}
        subtitle={subtitle}
        badges={
          isNew ? undefined : (
            <>
              <Pill tone="gray">{VENDOR_ROSTER_KIND_LABELS[vendorRosterKind(vendor!)]}</Pill>
              {vendor!.isAffiliate === true && <Pill tone="blue">關係企業</Pill>}
              {vendor!.taxIdValid === false && <Pill tone="amber">統編檢查碼不符</Pill>}
              {readOnly && <Pill tone="blue">唯讀</Pill>}
            </>
          )
        }
        actions={
          !isNew && canDelete ? (
            <Button variant="danger" size="sm" onClick={() => void remove()} disabled={saving}>刪除廠商</Button>
          ) : undefined
        }
      />

      {scanMsg && <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800" aria-live="polite">{scanMsg}</p>}

      <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-4 md:space-y-6">
          <RosterSection title="基本資料" hint="欄位順序＝業主 Excel「客供商基本資料」。" disabled={locked}>
            <div>
              <label className={labelCls} htmlFor="vendor-rosterKind">名冊類別</label>
              <select
                id="vendor-rosterKind"
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
          </RosterSection>

          <RosterSection title="其他" hint="Excel 沒有的欄位。" disabled={locked}>
            {F("title", "職稱", { maxLength: 60 })}
            {canSeeBank && (
              <>
                {F("bankName", "銀行", { ph: "例：兆豐銀行" })}
                {F("bankCode", "銀行代碼", { ph: "例：017" })}
                {F("bankAccount", "帳號")}
                {F("accountHolder", "戶名", { ph: "帳戶開戶姓名／公司名，供放款核對用" })}
              </>
            )}
            <div className="sm:col-span-2">
              <label className={`flex items-start gap-2 text-sm ${canSetAffiliate && !readOnly ? "cursor-pointer text-gray-700" : "text-gray-400"}`}>
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
                    {canSetAffiliate ? "" : "只有 HR 可以設定。"}
                  </span>
                </span>
              </label>
            </div>
          </RosterSection>
        </div>

        <div className="lg:self-start">
        <Card>
          <h2 className="text-base font-semibold text-gray-900">名片影像</h2>
          <p className="mt-0.5 text-xs text-gray-500">{canEdit ? "拍照或上傳名片，AI 帶入欄位建議值，核對後再儲存。" : "建檔時上傳的名片。"}</p>
          <div className="mt-4">
            {cardPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cardPreview} alt="名片" className="w-full rounded-md border border-gray-200 object-contain" />
            ) : (
              <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-gray-300 text-xs text-gray-400">尚無影像</div>
            )}
            {canEdit && (
              <>
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onPickCard(e.target.files?.[0])} />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={scanning || saving}
                  className="mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:opacity-50"
                >
                  {scanning ? "辨識中…" : cardPreview ? "換一張並重新辨識" : "📷 拍名片／上傳名片並辨識"}
                </button>
              </>
            )}
          </div>
        </Card>
        </div>
      </div>

      {canEdit && (
        <RosterSaveBar
          dirty={dirty}
          saving={saving}
          error={saveError}
          isNew={isNew}
          canSave={!!form.name.trim() && !scanning}
          saveLabel={isNew ? "新增廠商" : "儲存"}
          onCancel={cancel}
          onSave={() => void save()}
        />
      )}
      {!canEdit && saveError && <ErrorText>{saveError}</ErrorText>}
    </>
  );
}
