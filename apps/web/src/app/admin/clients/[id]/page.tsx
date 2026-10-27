"use client";

/**
 * 客戶內頁 /admin/clients/[id]（2026-10-27 業主：列表按「編輯」直接進內頁編輯，比照員工內頁）。
 * /admin/clients/new 是同一頁的新增模式。
 *
 * 欄位、順序、驗證與原列表下方的編輯表單完全相同（lib/roster-forms.ts：clientFormFrom／clientFormToInput），
 * 沒有新 API：
 *   - 讀：GET /clients（列表同一支，取這一筆；API 沒有單筆 GET）＋客戶分類選項清單
 *   - 寫：新增 POST /clients、修改 PATCH /clients/:id；統編與其他客戶相同只提示（clientSaveWarningText）不擋
 * 權限（沿用原列表）：關係企業標記只有 HR／平台管理員能勾（API 對會計回 403 affiliate_hr_only；旗標沒變就不送），
 * 刪除只有 HR／平台管理員看得到（API requireHrAdmin）。
 * 存檔：修改後留在內頁並顯示「已儲存」（比照員工內頁）；新增成功後換到這家客戶的內頁。
 * 未儲存就離開（側欄、返回鍵、上一頁、關分頁）會先問（components/useUnsavedChangesGuard.ts）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, Card, Empty, ErrorText, Pill, inputCls, labelCls, useToast } from "@/components/admin-ui";
import { RosterDetailHeader, RosterSaveBar, RosterSection, useRosterRoles } from "@/components/roster-detail";
import { useUnsavedChangesGuard } from "@/components/useUnsavedChangesGuard";
import {
  listClients, createClient, updateClient, deleteClient, humanizeClientError, clientSaveWarningText,
  INVOICE_TYPE_LABELS, PAYMENT_METHOD_LABELS,
  type Client, type InvoiceType, type PaymentMethod, type ClientCategory,
} from "@/lib/projects-ext-api";
import { optionChoices, optionLabel, useOptionList } from "@/lib/option-lists-api";
import { humanizeAffiliateError } from "@/lib/affiliate";
import {
  NEW_ROSTER_ID, clientFormFrom, clientFormToInput, emptyClientForm, rosterDetailHref, rosterFormDirty,
  type ClientForm, type ClientTextKey,
} from "@/lib/roster-forms";

const LIST_HREF = "/admin/clients";
const UNSAVED_PROMPT = "這家客戶的資料還沒儲存，確定要離開嗎？";

export default function ClientDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? decodeURIComponent(params.id) : "";
  const isNew = id === NEW_ROSTER_ID;
  const toast = useToast();
  const categories = useOptionList("client_category");
  const { isHr: canSetAffiliate } = useRosterRoles();
  const canDelete = canSetAffiliate;

  const [client, setClient] = useState<Client | null>(null);
  const [baseline, setBaseline] = useState<ClientForm>(emptyClientForm());
  const [form, setForm] = useState<ClientForm>(emptyClientForm());
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchClient = useCallback(async () => {
    const r = await listClients();
    const found = r.clients.find((c) => c.id === id) ?? null;
    setClient(found);
    setNotFound(!found);
    if (found) {
      const f = clientFormFrom(found);
      setBaseline(f);
      setForm(f);
    }
  }, [id]);

  useEffect(() => {
    if (isNew) return;
    let active = true;
    setLoading(true);
    fetchClient()
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : "載入失敗");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchClient, isNew]);

  const dirty = useMemo(() => rosterFormDirty(form, baseline), [form, baseline]);
  const { leave } = useUnsavedChangesGuard(dirty, UNSAVED_PROMPT);

  function cancel() {
    if (saving) return;
    if (dirty && !window.confirm("放棄這次的修改？")) return;
    if (isNew) {
      leave(LIST_HREF);
      return;
    }
    setForm(baseline);
    setSaveError(null);
  }

  async function save() {
    if (saving || !form.name.trim()) return;
    const parsed = clientFormToInput(form, client);
    if (!parsed.ok) {
      setSaveError(parsed.error);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = isNew ? await createClient(parsed.input) : await updateClient(id, parsed.input);
      const warning = clientSaveWarningText(res);
      if (isNew) {
        toast.show(warning ?? "已新增客戶", warning ? "info" : "success");
        leave(rosterDetailHref("clients", res.client.id));
        return;
      }
      toast.show(warning ?? "已儲存", warning ? "info" : "success");
      try {
        await fetchClient();
      } catch (err) {
        setSaveError(err instanceof Error ? `已儲存，但重新載入失敗：${err.message}` : "已儲存，但重新載入失敗");
      }
    } catch (err) {
      const msg = humanizeAffiliateError(humanizeClientError(err, "儲存失敗"));
      setSaveError(msg.includes("migration_required") ? "資料庫尚未更新（名冊新欄位），請先套用 migration 0076 再存這些欄位。" : msg);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!client || !canDelete) return;
    if (!confirm(`刪除客戶「${client.name}」？（軟刪除，往來紀錄仍保留）`)) return;
    try {
      await deleteClient(client.id);
      toast.show("已刪除客戶", "success");
      leave(LIST_HREF);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  const F = (k: ClientTextKey, label: string, opts: { ph?: string; maxLength?: number; multiline?: boolean; wide?: boolean } = {}) => (
    <div className={opts.wide ? "sm:col-span-2" : undefined}>
      <label className={labelCls} htmlFor={`client-${k}`}>{label}</label>
      {opts.multiline ? (
        <textarea
          id={`client-${k}`}
          className={`${inputCls} min-h-[60px]`}
          value={form[k]}
          onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
          placeholder={opts.ph}
          maxLength={opts.maxLength}
        />
      ) : (
        <input id={`client-${k}`} className={inputCls} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={opts.ph} maxLength={opts.maxLength} />
      )}
    </div>
  );

  if (!isNew && loading && !client) return <Empty>載入中…</Empty>;
  if (!isNew && loadError && !client) {
    return (
      <Card>
        <ErrorText>{loadError}</ErrorText>
        <Link href={LIST_HREF} className="mt-3 inline-block text-sm text-gray-600 hover:underline">← 返回客戶列表</Link>
      </Card>
    );
  }
  if (!isNew && (notFound || !client)) {
    return (
      <Card>
        <Empty>找不到這家客戶（可能已被刪除，或不在這個公司）。</Empty>
        <Link href={LIST_HREF} className="mt-3 inline-block text-sm text-gray-600 hover:underline">← 返回客戶列表</Link>
      </Card>
    );
  }

  const title = isNew ? "新增客戶" : client!.name;
  const subtitle = isNew
    ? "填好欄位後按「新增客戶」建檔；建案時就能在客戶下拉選到。"
    : [client!.shortName && `簡稱 ${client!.shortName}`, client!.region, client!.taxId && `統編 ${client!.taxId}`].filter(Boolean).join("・") || undefined;

  return (
    <>
      <RosterDetailHeader
        backHref={LIST_HREF}
        backLabel="返回客戶列表"
        title={title}
        subtitle={subtitle}
        badges={
          !isNew && (client!.isAffiliate === true || client!.category) ? (
            <>
              {client!.isAffiliate === true && <Pill tone="blue">關係企業</Pill>}
              {client!.category && <Pill tone="gray">{categories.loading ? "…" : optionLabel(categories.items, client!.category)}</Pill>}
            </>
          ) : undefined
        }
        actions={
          !isNew && canDelete ? (
            <Button variant="danger" size="sm" onClick={() => void remove()} disabled={saving}>刪除客戶</Button>
          ) : undefined
        }
      />

      <RosterSection title="基本資料" hint="欄位順序＝業主 Excel「客戶資料」。" disabled={saving}>
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
          <label className={labelCls} htmlFor="client-paymentMethod">收款方式</label>
          <select id="client-paymentMethod" className={inputCls} value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value as PaymentMethod | "" }))}>
            <option value="">未指定</option>
            {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((v) => (
              <option key={v} value={v}>{PAYMENT_METHOD_LABELS[v]}</option>
            ))}
          </select>
        </div>
        {F("note", "備註", { multiline: true, maxLength: 2000, wide: true })}
      </RosterSection>

      <RosterSection title="其他" hint="Excel 沒有的欄位。" disabled={saving}>
        <div>
          <label className={labelCls} htmlFor="client-category">分類</label>
          <select
            id="client-category"
            className={inputCls}
            value={form.category}
            onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ClientCategory | "" }))}
          >
            <option value="">未分類</option>
            {optionChoices(categories.items, form.category).map((choice) => (
              <option key={choice.code} value={choice.code}>{choice.label}</option>
            ))}
          </select>
          {categories.error && (
            <button type="button" onClick={categories.reload} className="mt-1 text-xs text-red-600 underline">分類載入失敗，點此重試</button>
          )}
        </div>
        <div>
          <label className={labelCls} htmlFor="client-invoiceType">發票聯式</label>
          <select id="client-invoiceType" className={inputCls} value={form.invoiceType} onChange={(e) => setForm((f) => ({ ...f, invoiceType: e.target.value as InvoiceType | "" }))}>
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
      </RosterSection>

      <RosterSaveBar
        dirty={dirty}
        saving={saving}
        error={saveError}
        isNew={isNew}
        canSave={!!form.name.trim()}
        saveLabel={isNew ? "新增客戶" : "儲存"}
        onCancel={cancel}
        onSave={() => void save()}
      />
    </>
  );
}
