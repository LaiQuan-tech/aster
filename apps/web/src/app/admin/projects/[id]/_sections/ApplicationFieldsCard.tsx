"use client";

import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import { VendorCombo } from "@/components/VendorCombo";
import type { Vendor } from "@/lib/company-api";
import { DOC_TYPE_LABELS, isOurContract, type Contract } from "@/lib/projects-api";
import {
  updateProjectFields,
  humanizeProjectExtError,
  type ProjectDetail,
  type DesignScopeItem,
  type ProjectEngineers,
  ENGINEER_DISCIPLINE_LABELS,
  ENGINEER_DISCIPLINES,
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  type InvoiceType,
  type PaymentMethod,
  COMMON_DISCIPLINES,
} from "@/lib/projects-ext-api";
import { type AppForm, type Setter } from "./shared";

/** 「訂單類型（沿用合約）」：跟後端 summarizeContracts() 同一套邏輯——
 * 我方承攬、優先看合約（簽訂日新的優先，沒簽訂日的排後面），沒有合約才退用最新報價單。 */
function isNewerDoc(a: Contract, b: Contract): boolean {
  if (a.signedOn !== b.signedOn) {
    if (a.signedOn === null) return false;
    if (b.signedOn === null) return true;
    return a.signedOn > b.signedOn;
  }
  return a.createdAt > b.createdAt;
}
function latestDocumentOf(list: Contract[]): Contract | null {
  let latestContract: Contract | null = null;
  let latestQuotation: Contract | null = null;
  for (const c of list) {
    if (!isOurContract(c.ourRole)) continue;
    if (c.docType === "quotation") {
      if (!latestQuotation || isNewerDoc(c, latestQuotation)) latestQuotation = c;
    } else if (c.docType === "contract") {
      if (!latestContract || isNewerDoc(c, latestContract)) latestContract = c;
    }
  }
  return latestContract ?? latestQuotation;
}

interface ApplicationFieldsCardProps {
  project: ProjectDetail;
  appForm: AppForm;
  setAppForm: Setter<AppForm | null>;
  savingApp: boolean;
  setSavingApp: Setter<boolean>;
  appSavedAt: number | null;
  setAppSavedAt: Setter<number | null>;
  contracts: Contract[];
  vendors: Vendor[];
  canFinance: boolean;
  error: string | null;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/** 申請單資料（模組五）：地點／面積／發票／付款、科別與服務項目、協力技師。整批儲存。 */
export function ApplicationFieldsCard({
  project,
  appForm,
  setAppForm,
  savingApp,
  setSavingApp,
  appSavedAt,
  setAppSavedAt,
  contracts,
  vendors,
  canFinance,
  error,
  setError,
  load,
}: ApplicationFieldsCardProps) {
  function patchScopeRow(idx: number, patch: Partial<DesignScopeItem>) {
    setAppForm((f) => (f ? { ...f, designScope: f.designScope.map((r, i) => (i === idx ? { ...r, ...patch } : r)) } : f));
  }
  function addScopeRow() {
    setAppForm((f) => (f ? { ...f, designScope: [...f.designScope, { discipline: "", item: "", amount: null }] } : f));
  }
  function removeScopeRow(idx: number) {
    setAppForm((f) => (f ? { ...f, designScope: f.designScope.filter((_, i) => i !== idx) } : f));
  }

  async function saveApplication() {
    if (!appForm || !project) return;
    setSavingApp(true);
    setError(null);
    try {
      const engineers: ProjectEngineers = {};
      for (const d of ENGINEER_DISCIPLINES) {
        const v = appForm.engineers[d];
        engineers[d] = v.vendorId || (v.name && v.name.trim()) ? { vendorId: v.vendorId, name: v.name } : null;
      }
      await updateProjectFields(project.id, {
        siteAddress: appForm.siteAddress.trim() || null,
        siteAreaM2: appForm.siteAreaM2 === "" ? null : Number(appForm.siteAreaM2),
        designScope: appForm.designScope
          .filter((row) => row.discipline.trim())
          .map((row) => ({ discipline: row.discipline.trim(), item: row.item?.trim() || null, amount: row.amount })),
        invoiceType: appForm.invoiceType || null,
        paymentMethod: appForm.paymentMethod || null,
        closingDay: appForm.closingDay.trim() || null,
        paymentDay: appForm.paymentDay.trim() || null,
        otherExpenses: appForm.otherExpenses === "" ? null : Number(appForm.otherExpenses),
        engineers,
      });
      setAppSavedAt(Date.now());
      await load();
    } catch (err) {
      setError(humanizeProjectExtError(err, "儲存申請單資料失敗"));
    } finally {
      setSavingApp(false);
    }
  }

  const latestDoc = latestDocumentOf(contracts);

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">申請單資料</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>設計地點</label>
          <input className={inputCls} value={appForm.siteAddress} onChange={(e) => setAppForm((f) => f && { ...f, siteAddress: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>設計面積</label>
          <div className="flex items-center gap-2">
            <input className={inputCls} type="number" min="0" value={appForm.siteAreaM2} onChange={(e) => setAppForm((f) => f && { ...f, siteAreaM2: e.target.value })} />
            <span className="shrink-0 text-sm text-gray-400">m²</span>
          </div>
        </div>
        <div>
          <label className={labelCls}>發票聯式</label>
          <select className={inputCls} value={appForm.invoiceType} onChange={(e) => setAppForm((f) => f && { ...f, invoiceType: e.target.value as InvoiceType | "" })}>
            <option value="">未指定{project.client?.invoiceType ? `（客戶預設：${INVOICE_TYPE_LABELS[project.client.invoiceType]}）` : ""}</option>
            {(Object.keys(INVOICE_TYPE_LABELS) as InvoiceType[]).map((v) => (
              <option key={v} value={v}>{INVOICE_TYPE_LABELS[v]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>付款方式</label>
          <select className={inputCls} value={appForm.paymentMethod} onChange={(e) => setAppForm((f) => f && { ...f, paymentMethod: e.target.value as PaymentMethod | "" })}>
            <option value="">未指定{project.client?.paymentMethod ? `（客戶預設：${PAYMENT_METHOD_LABELS[project.client.paymentMethod]}）` : ""}</option>
            {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((v) => (
              <option key={v} value={v}>{PAYMENT_METHOD_LABELS[v]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>結帳日</label>
          <input className={inputCls} value={appForm.closingDay} onChange={(e) => setAppForm((f) => f && { ...f, closingDay: e.target.value })} placeholder={project.client?.closingDay ?? "例：每月 5 日"} />
        </div>
        <div>
          <label className={labelCls}>付款日</label>
          <input className={inputCls} value={appForm.paymentDay} onChange={(e) => setAppForm((f) => f && { ...f, paymentDay: e.target.value })} placeholder={project.client?.paymentDay ?? "例：次月 10 日"} />
        </div>
        <div>
          <label className={labelCls}>訂單類型（沿用合約）</label>
          <p className={`${inputCls} bg-gray-50 text-gray-500`}>
            {latestDoc ? DOC_TYPE_LABELS[latestDoc.docType] : "尚無合約或報價單"}
          </p>
        </div>
        {canFinance && (
          <div>
            <label className={labelCls}>其他支出（差旅、規費等，計入損益）</label>
            <input className={inputCls} type="number" min="0" value={appForm.otherExpenses} onChange={(e) => setAppForm((f) => f && { ...f, otherExpenses: e.target.value })} />
          </div>
        )}
      </div>

      <div className="mt-4 border-t pt-4">
        <div className="mb-2 flex items-center justify-between">
          <label className={labelCls}>科別與服務項目</label>
          <button type="button" className="text-xs text-gray-500 hover:underline" onClick={addScopeRow}>＋ 新增一列</button>
        </div>
        {appForm.designScope.length === 0 ? (
          <Empty>尚未填寫</Empty>
        ) : (
          <div className="space-y-2">
            {appForm.designScope.map((row, idx) => (
              <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_140px_auto] sm:items-center">
                <input className={inputCls} list="discipline-suggestions" value={row.discipline} placeholder="科別" onChange={(e) => patchScopeRow(idx, { discipline: e.target.value })} />
                <input className={inputCls} value={row.item ?? ""} placeholder="服務項目" onChange={(e) => patchScopeRow(idx, { item: e.target.value })} />
                {canFinance ? (
                  <input className={inputCls} type="number" min="0" value={row.amount ?? ""} placeholder="金額" onChange={(e) => patchScopeRow(idx, { amount: e.target.value === "" ? null : Number(e.target.value) })} />
                ) : <div />}
                <button type="button" className="justify-self-start text-xs text-gray-400 hover:text-red-600 sm:justify-self-center" onClick={() => removeScopeRow(idx)}>移除</button>
              </div>
            ))}
          </div>
        )}
        <datalist id="discipline-suggestions">
          {COMMON_DISCIPLINES.map((d) => <option key={d} value={d} />)}
        </datalist>
      </div>

      <div className="mt-4 border-t pt-4">
        <label className={labelCls}>協力技師</label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {ENGINEER_DISCIPLINES.map((d) => (
            <div key={d}>
              <p className="mb-1 text-xs text-gray-500">{ENGINEER_DISCIPLINE_LABELS[d]}</p>
              <VendorCombo
                vendors={vendors}
                vendorId={appForm.engineers[d].vendorId}
                name={appForm.engineers[d].name}
                onChange={(v) => setAppForm((f) => f && { ...f, engineers: { ...f.engineers, [d]: v } })}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <PrimaryButton onClick={saveApplication} disabled={savingApp}>{savingApp ? "儲存中…" : "儲存申請單資料"}</PrimaryButton>
        {appSavedAt && <span className="text-sm text-green-700">已儲存</span>}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
