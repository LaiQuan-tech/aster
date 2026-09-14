"use client";

import { useState } from "react";
import { inputCls, labelCls, PrimaryButton, ErrorText } from "@/components/admin-ui";
import type { Vendor } from "@/lib/company-api";
import type { Company } from "@/lib/projects-ext-api";
import {
  DISBURSEMENT_METHOD_LABELS,
  PAYEE_KIND_LABELS,
  type AllocationInput,
  type DisbursementInput,
  type DisbursementMethod,
  type Payable,
  type PayeeKind,
} from "@/lib/disbursements-api";

export type ProjectOption = { id: string; code: string | null; name: string };

/** 表單內部用的分攤列草稿；amount/withheldAmount 用字串裝著方便輸入框控制。 */
export interface AllocRowDraft {
  key: string;
  projectId: string;
  subcontractId?: string | null;
  subcontractPaymentId?: string | null;
  installmentNo?: number | null;
  vendorName?: string | null;
  amount: string;
  withheldAmount: string;
  note: string;
  /** true = 從應付清單帶入（專案／期款鎖定，只能改金額與備註）；false = 手動：專案＋金額。 */
  fromPayable: boolean;
}

export interface DisbursementFormInitial {
  id?: string;
  payeeKind: PayeeKind;
  vendorId?: string | null;
  payeeName?: string;
  payeeBankName?: string | null;
  payeeBankAccount?: string | null;
  payeeBankCode?: string | null;
  payingCompanyId?: string | null;
  method?: DisbursementMethod;
  paidOn?: string | null;
  amount?: number;
  withheldAmount?: number;
  receiptIssuerCompanyId?: string | null;
  receiptRef?: string | null;
  /** 是否已取得發票／收據；已匯款後仍可補改。 */
  hasInvoice?: boolean;
  invoiceNo?: string | null;
  purpose?: string | null;
  note?: string | null;
  status?: "draft" | "paid";
  allocations?: AllocRowDraft[];
}

let rowSeq = 0;
const newRowKey = () => `row-${Date.now()}-${rowSeq++}`;

function toNum(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function fmtMoney(n: number): string {
  return n.toLocaleString();
}

/** 從一筆應付清單期款帶出一個分攤列草稿（金額＝毛額、代扣＝該期代扣，比照規劃 §二「金額自動帶」）。 */
export function allocRowFromPayable(p: Payable): AllocRowDraft {
  return {
    key: newRowKey(),
    projectId: p.projectId,
    subcontractId: p.subcontractId,
    subcontractPaymentId: p.subcontractPaymentId,
    installmentNo: p.installmentNo,
    vendorName: p.vendorName,
    amount: String(p.grossAmount),
    withheldAmount: String(p.withheldAmount),
    note: "",
    fromPayable: true,
  };
}

function emptyAllocRow(projectId = ""): AllocRowDraft {
  return { key: newRowKey(), projectId, amount: "0", withheldAmount: "0", note: "", fromPayable: false };
}

function initFromDisbursement(d?: DisbursementFormInitial): {
  payeeKind: PayeeKind;
  vendorId: string;
  payeeName: string;
  payeeBankName: string;
  payeeBankAccount: string;
  payeeBankCode: string;
  payingCompanyId: string;
  method: DisbursementMethod;
  paidOn: string;
  amount: string;
  withheldAmount: string;
  grossAmount: string;
  receiptIssuerCompanyId: string;
  receiptRef: string;
  hasInvoice: boolean;
  invoiceNo: string;
  purpose: string;
  note: string;
  status: "draft" | "paid";
  allocations: AllocRowDraft[];
} {
  const amount = d?.amount ?? 0;
  const withheld = d?.withheldAmount ?? 0;
  return {
    payeeKind: d?.payeeKind ?? "vendor",
    vendorId: d?.vendorId ?? "",
    payeeName: d?.payeeName ?? "",
    payeeBankName: d?.payeeBankName ?? "",
    payeeBankAccount: d?.payeeBankAccount ?? "",
    payeeBankCode: d?.payeeBankCode ?? "",
    payingCompanyId: d?.payingCompanyId ?? "",
    method: d?.method ?? "transfer",
    paidOn: d?.paidOn ?? "",
    amount: String(amount),
    withheldAmount: String(withheld),
    grossAmount: String(amount + withheld),
    receiptIssuerCompanyId: d?.receiptIssuerCompanyId ?? "",
    receiptRef: d?.receiptRef ?? "",
    hasInvoice: d?.hasInvoice ?? false,
    invoiceNo: d?.invoiceNo ?? "",
    purpose: d?.purpose ?? "",
    note: d?.note ?? "",
    status: d?.status ?? "draft",
    allocations: d?.allocations ?? [],
  };
}

/**
 * 放款單表單：新增／編輯（draft 全欄；paid 只開放 note／receiptRef／purpose，見
 * `restrictedFields`）。分攤列支援「從應付清單帶入」與「手動：專案＋金額」兩種；
 * 實付／代扣／毛額三欄互算；分攤合計 vs 毛額即時檢核，不符時鎖住儲存鈕
 * （payeeKind='other' 且無分攤列可以直接存，例如印刷／快遞等非專案支出）。
 */
export default function DisbursementForm({
  vendors,
  companies,
  projects,
  payables,
  initial,
  restrictedFields = false,
  submitLabel = "儲存",
  busy = false,
  error,
  onSubmit,
  onCancel,
}: {
  vendors: Vendor[];
  companies: Company[];
  projects: ProjectOption[];
  payables: Payable[];
  initial?: DisbursementFormInitial;
  /** 已匯款（paid）的編輯限制：只能改 note / receiptRef / purpose。 */
  restrictedFields?: boolean;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (body: DisbursementInput) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [state, setState] = useState(() => initFromDisbursement(initial));
  const [pickProjectId, setPickProjectId] = useState("");
  const [pickPaymentId, setPickPaymentId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const set = <K extends keyof typeof state>(k: K, v: (typeof state)[K]) => setState((s) => ({ ...s, [k]: v }));

  function handleAmountChange(v: string) {
    setState((s) => ({ ...s, amount: v, grossAmount: String(toNum(v) + toNum(s.withheldAmount)) }));
  }
  function handleWithheldChange(v: string) {
    setState((s) => ({ ...s, withheldAmount: v, grossAmount: String(toNum(s.amount) + toNum(v)) }));
  }
  function handleGrossChange(v: string) {
    setState((s) => ({ ...s, grossAmount: v, amount: String(toNum(v) - toNum(s.withheldAmount)) }));
  }

  function handleVendorSelect(vendorId: string) {
    const v = vendors.find((x) => x.id === vendorId);
    setState((s) => ({
      ...s,
      vendorId,
      payeeName: v ? v.name : s.payeeName,
      payeeBankName: v?.bankName ?? s.payeeBankName,
      payeeBankAccount: v?.bankAccount ?? s.payeeBankAccount,
      payeeBankCode: v?.bankCode ?? s.payeeBankCode,
    }));
  }

  function patchRow(key: string, patch: Partial<AllocRowDraft>) {
    setState((s) => ({ ...s, allocations: s.allocations.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  }
  function removeRow(key: string) {
    setState((s) => ({ ...s, allocations: s.allocations.filter((r) => r.key !== key) }));
  }
  function addManualRow() {
    setState((s) => ({ ...s, allocations: [...s.allocations, emptyAllocRow()] }));
  }
  function addPickedPayable() {
    const p = availablePayablesForProject.find((x) => x.subcontractPaymentId === pickPaymentId);
    if (!p) return;
    setState((s) => ({ ...s, allocations: [...s.allocations, allocRowFromPayable(p)] }));
    setPickPaymentId("");
  }

  const pickableProjects = Array.from(
    new Map(
      payables
        .filter((p) => state.payeeKind !== "vendor" || !state.vendorId || p.vendorId === state.vendorId)
        .map((p) => [p.projectId, { id: p.projectId, code: p.projectCode, name: p.projectName }]),
    ).values(),
  );
  const availablePayablesForProject = payables.filter(
    (p) => p.projectId === pickProjectId && !state.allocations.some((a) => a.subcontractPaymentId === p.subcontractPaymentId),
  );

  const allocSum = state.allocations.reduce((sum, r) => sum + toNum(r.amount), 0);
  const allocWithheldSum = state.allocations.reduce((sum, r) => sum + toNum(r.withheldAmount), 0);
  const grossNum = toNum(state.grossAmount);
  const withheldNum = toNum(state.withheldAmount);
  const allowsZeroAlloc = state.payeeKind === "other" && state.allocations.length === 0;
  const centsEqual = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);
  // 後端 checkAllocationTotals 分開驗證毛額與代扣兩個合計，兩個都要對，光是毛額
  // 合計相符但代扣沒分攤，一樣會被後端 400 allocation_mismatch 打回票。
  const grossSumMatches = centsEqual(allocSum, grossNum);
  const withheldSumMatches = centsEqual(allocWithheldSum, withheldNum);
  // 後端 checkAllocationShape 要求每一列 amount > 0；0 元列不會影響總和比對，
  // 所以要獨立擋，否則使用者手動加一列忘記填金額也能送出。
  const hasNonPositiveRow = state.allocations.some((r) => !(toNum(r.amount) > 0));
  const allocMatches = allowsZeroAlloc || (grossSumMatches && withheldSumMatches && !hasNonPositiveRow);

  const requiredOk =
    !!state.payingCompanyId &&
    !!state.method &&
    (state.payeeKind === "vendor" ? !!state.vendorId : !!state.payeeName.trim()) &&
    (state.status !== "paid" || !!state.paidOn);

  const canSubmit = restrictedFields || (requiredOk && allocMatches);

  function buildBody(): DisbursementInput {
    const allocations: AllocationInput[] = state.allocations.map((r) => ({
      projectId: r.projectId,
      subcontractId: r.subcontractId ?? undefined,
      subcontractPaymentId: r.subcontractPaymentId ?? undefined,
      amount: toNum(r.amount),
      withheldAmount: toNum(r.withheldAmount),
      note: r.note.trim() || undefined,
    }));
    return {
      payeeKind: state.payeeKind,
      vendorId: state.payeeKind === "vendor" ? state.vendorId || null : null,
      payeeName: state.payeeName.trim(),
      payeeBankName: state.payeeBankName.trim() || null,
      payeeBankAccount: state.payeeBankAccount.trim() || null,
      payeeBankCode: state.payeeBankCode.trim() || null,
      payingCompanyId: state.payingCompanyId,
      method: state.method,
      paidOn: state.paidOn || null,
      amount: toNum(state.amount),
      withheldAmount: toNum(state.withheldAmount),
      receiptIssuerCompanyId: state.receiptIssuerCompanyId || null,
      receiptRef: state.receiptRef.trim() || null,
      hasInvoice: state.hasInvoice,
      invoiceNo: state.invoiceNo.trim() || null,
      purpose: state.purpose.trim() || null,
      note: state.note.trim() || null,
      status: state.status,
      allocations,
    };
  }

  function handleSubmit() {
    setLocalError(null);
    if (restrictedFields) {
      void onSubmit({
        ...buildBody(),
        // paid 限縮：其餘欄位後端本來就會忽略，這裡仍整包送，方便呼叫端沿用同一支 patch。
      });
      return;
    }
    if (!requiredOk) {
      setLocalError("請確認收款方、付款公司、方式（與放款日，若標記為已匯款）都已填。");
      return;
    }
    if (!allocMatches) {
      setLocalError("分攤合計與毛額不符，請調整。");
      return;
    }
    void onSubmit(buildBody());
  }

  if (restrictedFields) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-400">已匯款的單只能改收據抬頭以外的備註欄位；其餘欄位維持原樣。</p>
        <div>
          <label className={labelCls}>收據編號</label>
          <input className={inputCls} value={state.receiptRef} onChange={(e) => set("receiptRef", e.target.value)} />
        </div>
        <div>
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={state.hasInvoice} onChange={(e) => set("hasInvoice", e.target.checked)} />
            已取得發票／收據
          </label>
        </div>
        <div>
          <label className={labelCls}>發票號碼</label>
          <input className={inputCls} value={state.invoiceNo} onChange={(e) => set("invoiceNo", e.target.value)} placeholder="例：AB12345678" />
        </div>
        <div>
          <label className={labelCls}>用途</label>
          <input className={inputCls} value={state.purpose} onChange={(e) => set("purpose", e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>備註</label>
          <textarea className={`${inputCls} min-h-[72px]`} value={state.note} onChange={(e) => set("note", e.target.value)} />
        </div>
        <ErrorText>{error ?? localError}</ErrorText>
        <div className="flex items-center gap-3">
          <PrimaryButton onClick={handleSubmit} disabled={busy}>{busy ? "處理中…" : submitLabel}</PrimaryButton>
          {onCancel && <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:underline">取消</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>收款方</label>
          <div className="flex gap-3 py-1.5">
            {(Object.keys(PAYEE_KIND_LABELS) as PayeeKind[]).map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-sm text-gray-700">
                <input type="radio" name="payeeKind" checked={state.payeeKind === k} onChange={() => set("payeeKind", k)} />
                {PAYEE_KIND_LABELS[k]}
              </label>
            ))}
          </div>
        </div>
        <div />

        {state.payeeKind === "vendor" ? (
          <div>
            <label className={labelCls}>廠商</label>
            <select className={inputCls} value={state.vendorId} onChange={(e) => handleVendorSelect(e.target.value)}>
              <option value="">選擇廠商…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className={labelCls}>收款方名稱 *</label>
            <input className={inputCls} value={state.payeeName} onChange={(e) => set("payeeName", e.target.value)} placeholder="例：中華郵政、印刷廠…" />
          </div>
        )}
        <div>
          <label className={labelCls}>收款戶名</label>
          <input className={inputCls} value={state.payeeName} onChange={(e) => set("payeeName", e.target.value)} placeholder="選了廠商會自動帶入，可覆寫" />
        </div>
        <div>
          <label className={labelCls}>收款銀行</label>
          <input className={inputCls} value={state.payeeBankName} onChange={(e) => set("payeeBankName", e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>收款銀行代碼</label>
          <input className={inputCls} value={state.payeeBankCode} onChange={(e) => set("payeeBankCode", e.target.value)} placeholder="選了廠商會自動帶入，可覆寫" />
        </div>
        <div>
          <label className={labelCls}>收款帳號</label>
          <input className={inputCls} value={state.payeeBankAccount} onChange={(e) => set("payeeBankAccount", e.target.value)} />
        </div>

        <div>
          <label className={labelCls}>付款公司 *</label>
          <select className={inputCls} value={state.payingCompanyId} onChange={(e) => set("payingCompanyId", e.target.value)}>
            <option value="">選擇付款公司…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.isDefault ? "（預設）" : ""}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>方式</label>
          <select className={inputCls} value={state.method} onChange={(e) => set("method", e.target.value as DisbursementMethod)}>
            {(Object.keys(DISBURSEMENT_METHOD_LABELS) as DisbursementMethod[]).map((m) => (
              <option key={m} value={m}>{DISBURSEMENT_METHOD_LABELS[m]}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls}>匯款日{state.status === "paid" ? " *" : ""}</label>
          <input className={inputCls} type="date" value={state.paidOn} onChange={(e) => set("paidOn", e.target.value)} />
        </div>
        {!initial?.id && (
          <div>
            <label className={labelCls}>狀態</label>
            <div className="flex gap-3 py-1.5">
              <label className="flex items-center gap-1.5 text-sm text-gray-700">
                <input type="radio" name="status" checked={state.status === "draft"} onChange={() => set("status", "draft")} />
                草稿
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-700">
                <input type="radio" name="status" checked={state.status === "paid"} onChange={() => set("status", "paid")} />
                已匯款
              </label>
            </div>
          </div>
        )}

        <div>
          <label className={labelCls}>實付</label>
          <input className={`${inputCls} text-right`} type="number" min="0" value={state.amount} onChange={(e) => handleAmountChange(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>代扣</label>
          <input className={`${inputCls} text-right`} type="number" min="0" value={state.withheldAmount} onChange={(e) => handleWithheldChange(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>毛額</label>
          <input className={`${inputCls} text-right`} type="number" min="0" value={state.grossAmount} onChange={(e) => handleGrossChange(e.target.value)} />
          <p className="mt-1 text-xs text-gray-400">毛額＝實付＋代扣；改毛額時實付＝毛額－代扣。</p>
        </div>

        <div>
          <label className={labelCls}>收據抬頭</label>
          <select className={inputCls} value={state.receiptIssuerCompanyId} onChange={(e) => set("receiptIssuerCompanyId", e.target.value)}>
            <option value="">—</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>收據編號</label>
          <input className={inputCls} value={state.receiptRef} onChange={(e) => set("receiptRef", e.target.value)} />
        </div>
        <div>
          <label className="flex items-center gap-1.5 py-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={state.hasInvoice} onChange={(e) => set("hasInvoice", e.target.checked)} />
            已取得發票／收據
          </label>
        </div>
        <div>
          <label className={labelCls}>發票號碼</label>
          <input className={inputCls} value={state.invoiceNo} onChange={(e) => set("invoiceNo", e.target.value)} placeholder="例：AB12345678" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>用途</label>
          <input className={inputCls} value={state.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder="例：廣修三期款、印刷費…" />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>備註</label>
          <textarea className={`${inputCls} min-h-[72px]`} value={state.note} onChange={(e) => set("note", e.target.value)} />
        </div>
      </div>

      <div className="border-t pt-3">
        <h3 className="mb-2 text-sm font-semibold text-gray-700">分攤（對應到哪些專案／期款）</h3>
        {state.allocations.length === 0 ? (
          <p className="mb-2 text-sm text-gray-400">尚無分攤列。{state.payeeKind === "other" && "「其他」收款方可以不分攤直接存檔。"}</p>
        ) : (
          <div className="mb-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-1.5 pr-2">專案</th>
                  <th className="py-1.5 pr-2">期別／廠商</th>
                  <th className="py-1.5 pr-2 text-right">毛額</th>
                  <th className="py-1.5 pr-2 text-right">代扣</th>
                  <th className="py-1.5 pr-2">備註</th>
                  <th className="py-1.5 pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {state.allocations.map((r) => {
                  const proj = projects.find((p) => p.id === r.projectId);
                  return (
                    <tr key={r.key} className="border-b last:border-0 align-top">
                      <td className="py-1.5 pr-2">
                        {r.fromPayable ? (
                          <span className="text-gray-700">{proj ? `${proj.code ?? ""} ${proj.name}` : r.projectId}</span>
                        ) : (
                          <select className={`${inputCls} text-xs`} value={r.projectId} onChange={(e) => patchRow(r.key, { projectId: e.target.value })}>
                            <option value="">選擇專案…</option>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>{p.code ? `${p.code} ` : ""}{p.name}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-xs text-gray-500">
                        {r.fromPayable ? `第 ${r.installmentNo} 期${r.vendorName ? `・${r.vendorName}` : ""}` : "手動"}
                      </td>
                      <td className="py-1.5 pr-2">
                        <input className={`${inputCls} text-right text-xs`} type="number" min="0" value={r.amount} onChange={(e) => patchRow(r.key, { amount: e.target.value })} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input className={`${inputCls} text-right text-xs`} type="number" min="0" value={r.withheldAmount} onChange={(e) => patchRow(r.key, { withheldAmount: e.target.value })} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <input className={`${inputCls} text-xs`} value={r.note} onChange={(e) => patchRow(r.key, { note: e.target.value })} />
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => removeRow(r.key)}>移除</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-gray-200 p-3">
          <div>
            <label className={labelCls}>從應付清單帶入 · 專案</label>
            <select className={`${inputCls} text-xs`} value={pickProjectId} onChange={(e) => { setPickProjectId(e.target.value); setPickPaymentId(""); }}>
              <option value="">選擇專案…</option>
              {pickableProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.code ? `${p.code} ` : ""}{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>期款</label>
            <select className={`${inputCls} text-xs`} value={pickPaymentId} onChange={(e) => setPickPaymentId(e.target.value)} disabled={!pickProjectId}>
              <option value="">選擇期款…</option>
              {availablePayablesForProject.map((p) => (
                <option key={p.subcontractPaymentId} value={p.subcontractPaymentId}>
                  第 {p.installmentNo} 期・{p.vendorName ?? "—"}・淨額 {fmtMoney(p.netAmount)}
                </option>
              ))}
            </select>
          </div>
          <button type="button" onClick={addPickedPayable} disabled={!pickPaymentId} className="rounded-md border border-gray-300 px-3 py-2 text-xs text-gray-700 disabled:opacity-50">
            ＋ 加入這筆期款
          </button>
          <span className="mx-1 text-xs text-gray-300">｜</span>
          <button type="button" onClick={addManualRow} className="rounded-md border border-gray-300 px-3 py-2 text-xs text-gray-700">
            ＋ 手動加一列（專案＋金額）
          </button>
        </div>

        <div className={`mt-2 space-y-0.5 rounded-md px-3 py-2 text-xs ${allocMatches ? "bg-gray-50 text-gray-500" : "bg-red-50 text-red-700"}`}>
          <div>
            分攤合計 {fmtMoney(allocSum)}　毛額 {fmtMoney(grossNum)}
            {!grossSumMatches && `　差額 ${fmtMoney(grossNum - allocSum)}`}
          </div>
          {!allowsZeroAlloc && !withheldSumMatches && (
            <div>分攤代扣合計 {fmtMoney(allocWithheldSum)}　與代扣 {fmtMoney(withheldNum)} 不符，差額 {fmtMoney(withheldNum - allocWithheldSum)}（後端也會分開驗這個合計）</div>
          )}
          {hasNonPositiveRow && <div>有分攤列金額是 0 或空白，請填金額或移除該列。</div>}
        </div>
      </div>

      <ErrorText>{error ?? localError}</ErrorText>
      <div className="flex items-center gap-3">
        <PrimaryButton onClick={handleSubmit} disabled={busy || !canSubmit}>{busy ? "處理中…" : submitLabel}</PrimaryButton>
        {onCancel && <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:underline">取消</button>}
      </div>
    </div>
  );
}
