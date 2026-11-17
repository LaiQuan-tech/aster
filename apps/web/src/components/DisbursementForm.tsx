"use client";

import { splitAccountSnapshot } from "@/lib/payee-account";
import { useState } from "react";
import { formatMoney } from "@/lib/money";
import { MoneyInput } from "@/components/MoneyInput";
import { Button, inputCls, labelCls, PrimaryButton, ErrorText } from "@/components/admin-ui";
import { vendorOptionLabel, type Vendor } from "@/lib/company-api";
import { companyOptions } from "@/lib/company-options";
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
  /** 這列期款所屬副委託的登錄廠商（null＝非登錄廠商；undefined＝不知道，例如編輯舊單載入的列）。付錯人檢查用。 */
  vendorId?: string | null;
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
  /** 0106 分欄；payeeAccountSplit＝分欄是否實存（false／缺席 → 解析 payeeBankAccount 舊快照）。 */
  payeeBankAccountNumber?: string | null;
  payeeAccountHolder?: string | null;
  payeeAccountSplit?: boolean;
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
  return formatMoney(n, { maximumFractionDigits: 3 });
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
    vendorId: p.vendorId,
    amount: String(p.grossAmount),
    withheldAmount: String(p.withheldAmount),
    note: "",
    fromPayable: true,
  };
}

const normBank = (v: string | null | undefined) => (v ?? "").trim();
const normAcct = (v: string | null | undefined) => normBank(v).replace(/[\s\-－‐–—]/g, "");

/**
 * 單上的銀行快照是否與名冊不同（B3，2026-11-16）：接受名冊原始值，或系統快照格式（「銀行名（代碼）」「帳號 戶名」）。
 * 只用來提示，後端 payee_bank_mismatch 為準。
 */
export function bankSnapshotDiffersFromVendor(
  snap: { payeeBankName: string; payeeBankAccount: string; payeeBankCode: string; payeeAccountHolder?: string },
  v: Pick<Vendor, "bankName" | "bankCode" | "bankAccount" | "accountHolder">,
): boolean {
  const vName = normBank(v.bankName);
  const vCode = normBank(v.bankCode);
  const snapName = vName ? (vCode ? `${vName}（${vCode}）` : vName) : vCode;
  const snapAcct = [v.bankAccount, v.accountHolder].filter(Boolean).join(" ");
  const nameOk = [vName, snapName].includes(normBank(snap.payeeBankName));
  const codeOk = normBank(snap.payeeBankCode) === vCode;
  const acctOk = [normAcct(v.bankAccount), normAcct(snapAcct)].includes(normAcct(snap.payeeBankAccount));
  // 驗收第五輪：表單帳號與戶名分欄——戶名有值時要等於名冊戶名（空＝舊單沒有戶名段，不算不同）。
  const holderOk = !normBank(snap.payeeAccountHolder) || normBank(snap.payeeAccountHolder) === normBank(v.accountHolder);
  return !(nameOk && codeOk && acctOk && holderOk);
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
  /** 手動（其他）收款的帳戶戶名（分欄，驗收第三輪）。 */
  payeeAccountHolder: string;
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
    // 驗收第五輪：帳號與戶名分欄（廠商單與其他單都是）——依後端 payeeAccountSplit（分欄是否實存）決定：
    // 實存 → 直接用分欄；否則（舊單、名冊帳號含非數字的廠商單）解析舊快照「帳號 戶名」。
    payeeBankAccount: d?.payeeAccountSplit ? (d.payeeBankAccountNumber ?? "") : splitAccountSnapshot(d?.payeeBankAccount).account,
    payeeAccountHolder: d?.payeeAccountSplit ? (d.payeeAccountHolder ?? "") : (splitAccountSnapshot(d?.payeeBankAccount).holder ?? ""),
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
 * 放款單表單：新增／編輯（draft 全欄；paid／approved 只開放 note／receiptRef／purpose，
 * 見 `restrictedFields`）。分攤列支援「從應付清單帶入」與「手動：專案＋金額」兩種；
 * 實付／代扣／毛額三欄互算；分攤合計 vs 毛額即時檢核，不符時鎖住儲存鈕
 * （payeeKind='other' 且無分攤列可以直接存，例如印刷／快遞等非專案支出）。
 *
 * M5（2026-09-23）：後端對「分攤到未驗收期款」回 409 `acceptance_required`。
 * 呼叫端把 `acceptanceBlocked` 打開，這裡就列出本單分攤到的期別並提示去專案頁
 * 按「驗收確認」；`canForceAcceptance`（HR）時另給一個「未驗收仍要放款」勾選＋
 * 理由欄，勾了才會把 `forceAcceptance` / `forceReason` 一起送出（後端寫稽核）。
 */
export default function DisbursementForm({
  vendors,
  companies,
  projects,
  payables,
  initial,
  restrictedFields = false,
  acceptanceBlocked = false,
  canForceAcceptance = false,
  submitLabel = "儲存",
  busy = false,
  error,
  onSubmit,
  onCancel,
}: {
  vendors: Vendor[];
  /** 全部公司（含已停用）；下拉只列啟用的，加上這張單目前已選的（見 lib/company-options.ts）。 */
  companies: Company[];
  projects: ProjectOption[];
  payables: Payable[];
  initial?: DisbursementFormInitial;
  /** 已匯款（paid）／已核准（approved）的編輯限制：只能改 note / receiptRef / purpose。 */
  restrictedFields?: boolean;
  /** M5：上一次送出被 409 acceptance_required 擋下（顯示期別提示與 HR 強制選項）。 */
  acceptanceBlocked?: boolean;
  /** M5：HR 才看得到「未驗收仍要放款」勾選。 */
  canForceAcceptance?: boolean;
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
  // M5：HR 勾「未驗收仍要放款」＋理由（只在被 acceptance_required 擋下來時出現）。
  const [forceAcceptance, setForceAcceptance] = useState(false);
  const [forceReason, setForceReason] = useState("");
  // 第五輪第 5 項：登錄廠商零分攤、廠商仍有未付期款 → 勾選「確定為非期款支出」才送（後端 409 vendor_has_unpaid_installments 為準）。
  const [confirmNonInstallment, setConfirmNonInstallment] = useState(false);

  const set = <K extends keyof typeof state>(k: K, v: (typeof state)[K]) => setState((s) => ({ ...s, [k]: v }));
  /** 手動收款的帳號／戶名有沒有被改過（沒改就原樣回送既有快照，驗收第三輪）。 */
  const [manualAccountDirty, setManualAccountDirty] = useState(false);

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
      // 銀行欄位一律照名冊帶（名冊空就清空，不沿用前一家廠商的帳戶；後端 400 payee_bank_mismatch 為準）。
      payeeName: v ? v.name : s.payeeName,
      payeeBankName: v ? (v.bankName ?? "") : s.payeeBankName,
      payeeBankAccount: v ? (v.bankAccount ?? "") : s.payeeBankAccount,
      payeeAccountHolder: v ? (v.accountHolder ?? "") : s.payeeAccountHolder,
      payeeBankCode: v ? (v.bankCode ?? "") : s.payeeBankCode,
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
  // 付錯人防線（2026-11-16，後端 400 allocation_vendor_mismatch 為準）：收款方是登錄廠商時，
  // 分攤到的期款必須屬於同一家廠商——從乙的應付開單後把廠商改成甲，這裡就標紅並鎖住儲存。
  const selectedVendor = state.payeeKind === "vendor" ? vendors.find((v) => v.id === state.vendorId) : undefined;
  // 收款方「其他」（非登錄）時，不能分攤到登錄廠商的期款（分攤到非登錄副委託維持原行為）。
  const vendorMismatchKeys = new Set(
    state.payeeKind === "vendor"
      ? state.vendorId
        ? state.allocations
            .filter((r) => r.vendorId !== undefined && (r.vendorId ?? "").toLowerCase() !== state.vendorId.toLowerCase())
            .map((r) => r.key)
        : []
      : state.allocations.filter((r) => typeof r.vendorId === "string" && r.vendorId !== "").map((r) => r.key),
  );
  const hasVendorMismatch = vendorMismatchKeys.size > 0;
  // 登錄廠商的收款戶名只能是名冊名稱或名冊上的帳戶戶名（唯讀，後端 400 payee_name_mismatch 為準）。
  const payeeNameChoices = selectedVendor
    ? Array.from(new Set([selectedVendor.name, selectedVendor.accountHolder ?? ""].map((x) => x.trim()).filter(Boolean)))
    : [];
  // B3：編輯舊草稿時，單上的銀行快照與名冊不同 → 提示並提供「重新帶入名冊帳戶」。
  const bankDiffersFromRoster = !!initial?.id && !!selectedVendor && bankSnapshotDiffersFromVendor(state, selectedVendor);
  function reloadBankFromRoster() {
    if (!selectedVendor) return;
    setState((s) => ({
      ...s,
      payeeBankName: selectedVendor.bankName ?? "",
      payeeBankAccount: selectedVendor.bankAccount ?? "",
      payeeAccountHolder: selectedVendor.accountHolder ?? "",
      payeeBankCode: selectedVendor.bankCode ?? "",
    }));
  }
  // 零分攤＝非專案支出：「其他」直接可存；登錄廠商要填用途（後端 400 purpose_required，2026-11-16）。
  const zeroAllocVendorHasUnpaid =
    !restrictedFields &&
    state.payeeKind === "vendor" &&
    !!state.vendorId &&
    state.allocations.length === 0 &&
    (payables.some((p) => (p.vendorId ?? "").toLowerCase() === state.vendorId.toLowerCase()) ||
      !!error?.includes("此廠商仍有未付期款"));
  const allowsZeroAlloc =
    state.allocations.length === 0 && (state.payeeKind === "other" || (state.payeeKind === "vendor" && !!state.purpose.trim()));
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

  const canSubmit = restrictedFields || (requiredOk && allocMatches && !hasVendorMismatch);

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
      ...(state.payeeKind === "other"
        ? initial?.id && !manualAccountDirty && initial.payeeKind === "other"
          ? {} // 沒動帳號／戶名 → 不送（後端沿用 DB 現值）
          : { payeeBankAccountNumber: state.payeeBankAccount.trim() || null, payeeAccountHolder: state.payeeAccountHolder.trim() || null }
        : { payeeBankAccount: state.payeeBankAccount.trim() || null }),
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
      ...(forceAcceptance ? { forceAcceptance: true, forceReason: forceReason.trim() } : {}),
      ...(zeroAllocVendorHasUnpaid && confirmNonInstallment ? { confirmNonInstallment: true } : {}),
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
    if (hasVendorMismatch) {
      setLocalError("分攤的副委託廠商與收款廠商不同，請確認收款對象（移除標紅的分攤列或改回原廠商）。");
      return;
    }
    if (forceAcceptance && !forceReason.trim()) {
      setLocalError("勾選「未驗收仍要放款」時必須填理由（會寫進稽核紀錄）。");
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
          {onCancel && <Button type="button" variant="secondary" className="md:min-h-10" onClick={onCancel}>取消</Button>}
          <PrimaryButton onClick={handleSubmit} disabled={busy}>{busy ? "處理中…" : submitLabel}</PrimaryButton>
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
                <input
                  type="radio"
                  name="payeeKind"
                  checked={state.payeeKind === k}
                  onChange={() => {
                    if (k === "other") setManualAccountDirty(true); // 驗收第五輪：切到「其他」＝帳戶要重填，存檔一定送兩欄（空＝null）
                    setState((s) => {
                      // 切回「廠商」時戶名重新帶名冊名稱（避免沿用「其他」時手打的名稱）。
                      const v = k === "vendor" ? vendors.find((x) => x.id === s.vendorId) : undefined;
                      return v
                        ? {
                            ...s,
                            payeeKind: k,
                            payeeName: v.name,
                            payeeBankName: v.bankName ?? "",
                            payeeBankAccount: v.bankAccount ?? "",
                            payeeAccountHolder: v.accountHolder ?? "",
                            payeeBankCode: v.bankCode ?? "",
                          }
                        : k === "other" && s.payeeKind === "vendor"
                          // 廠商 → 其他：名冊帶來的帳戶不沿用（兩欄清空，由使用者重填）；存檔明確送 null（manualAccountDirty）。
                          ? { ...s, payeeKind: k, payeeBankName: "", payeeBankCode: "", payeeBankAccount: "", payeeAccountHolder: "" }
                          : { ...s, payeeKind: k };
                    });
                  }}
                />
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
                <option key={v.id} value={v.id}>{vendorOptionLabel(v)}</option>
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
          {state.payeeKind === "vendor" ? (
            payeeNameChoices.length > 1 ? (
              <select className={inputCls} value={state.payeeName} onChange={(e) => set("payeeName", e.target.value)}>
                {!payeeNameChoices.includes(state.payeeName.trim()) && <option value={state.payeeName}>{state.payeeName}</option>}
                {payeeNameChoices.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            ) : (
              <input className={`${inputCls} bg-gray-50`} value={state.payeeName} readOnly placeholder="選了廠商會自動帶入名冊名稱" />
            )
          ) : (
            <input className={inputCls} value={state.payeeName} onChange={(e) => set("payeeName", e.target.value)} />
          )}
          {state.payeeKind === "vendor" && (
            <p className="mt-1 text-xs text-gray-400">登錄廠商的戶名與收款帳戶一律照名冊；帳戶變更請先到廠商名冊更新（需財務權限），要付給其他對象請改選「其他」。</p>
          )}
        </div>
        <div>
          <label className={labelCls}>收款銀行</label>
          <input className={`${inputCls} ${state.payeeKind === "vendor" ? "bg-gray-50" : ""}`} value={state.payeeBankName} onChange={(e) => set("payeeBankName", e.target.value)} readOnly={state.payeeKind === "vendor"} />
        </div>
        <div>
          <label className={labelCls}>收款銀行代碼</label>
          <input className={`${inputCls} ${state.payeeKind === "vendor" ? "bg-gray-50" : ""}`} value={state.payeeBankCode} onChange={(e) => set("payeeBankCode", e.target.value)} readOnly={state.payeeKind === "vendor"} placeholder="選了廠商會自動帶入名冊帳戶" />
        </div>
        <div>
          <label className={labelCls}>收款帳號</label>
          <input className={`${inputCls} ${state.payeeKind === "vendor" ? "bg-gray-50" : ""}`} value={state.payeeBankAccount} onChange={(e) => { setManualAccountDirty(true); set("payeeBankAccount", e.target.value); }} readOnly={state.payeeKind === "vendor"} />
        </div>
        <div>
          <label className={labelCls}>帳戶戶名</label>
          <input
            className={`${inputCls} ${state.payeeKind === "vendor" ? "bg-gray-50" : ""}`}
            value={state.payeeAccountHolder}
            onChange={(e) => { setManualAccountDirty(true); set("payeeAccountHolder", e.target.value); }}
            readOnly={state.payeeKind === "vendor"}
            placeholder={state.payeeKind === "vendor" ? "照名冊帶入" : "存摺上的戶名（與帳號分開填）"}
          />
        </div>
        {/* 2026-11-17：名冊帳戶尚未經老闆／平台管理員 確認（或變更待覆核）→ 可以存草稿，但送審／核准／付款會被擋。 */}
        {selectedVendor && selectedVendor.bankChangePending === true && (
          <div className="col-span-full rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
            此廠商帳戶變更待覆核中，無法送審（老闆／平台管理員覆核完成後才能送審、核准或付款）。
          </div>
        )}
        {selectedVendor && selectedVendor.bankChangePending !== true && selectedVendor.bankVerified === false &&
          !(state.method !== "transfer" && !selectedVendor.bankAccount && !state.payeeBankAccount.trim()) && (
          <div className="col-span-full rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
            此廠商帳戶尚待確認，無法送審（需老闆／平台管理員在廠商名冊核准收款帳戶後才能送審、核准或付款；現金／支票且沒有帳號則不受影響）。
          </div>
        )}
        {bankDiffersFromRoster && (
          <div className="col-span-full rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
            <p>這張單上的收款帳戶與廠商名冊目前的帳戶不同（可能是開單後名冊有更新）。</p>
            <Button type="button" variant="secondary" className="mt-2" onClick={reloadBankFromRoster}>重新帶入名冊帳戶</Button>
          </div>
        )}

        <div>
          <label className={labelCls}>付款公司 *</label>
          <select className={inputCls} value={state.payingCompanyId} onChange={(e) => set("payingCompanyId", e.target.value)}>
            <option value="">選擇付款公司…</option>
            {companyOptions(companies, state.payingCompanyId, { markDefault: true }).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
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
          <MoneyInput className={`${inputCls} text-right`} value={state.amount} onValueChange={(v) => handleAmountChange(v)} />
        </div>
        <div>
          <label className={labelCls}>代扣</label>
          <MoneyInput className={`${inputCls} text-right`} value={state.withheldAmount} onValueChange={(v) => handleWithheldChange(v)} />
        </div>
        <div>
          <label className={labelCls}>毛額</label>
          <MoneyInput className={`${inputCls} text-right`} value={state.grossAmount} onValueChange={(v) => handleGrossChange(v)} />
          <p className="mt-1 text-xs text-gray-400">毛額＝實付＋代扣；改毛額時實付＝毛額－代扣。</p>
        </div>

        <div>
          <label className={labelCls}>收據抬頭</label>
          <select className={inputCls} value={state.receiptIssuerCompanyId} onChange={(e) => set("receiptIssuerCompanyId", e.target.value)}>
            <option value="">—</option>
            {companyOptions(companies, state.receiptIssuerCompanyId).map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
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
          <>
            <p className="mb-2 text-sm text-gray-400">尚無分攤列。{state.payeeKind === "other" ? "「其他」收款方可以不分攤直接存檔。" : "登錄廠商的非專案支出（例如印刷費）可以不分攤，但必須填寫用途。"}</p>
            {zeroAllocVendorHasUnpaid && (
              <label className="mb-2 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirmNonInstallment}
                  onChange={(e) => setConfirmNonInstallment(e.target.checked)}
                />
                <span>此廠商仍有未付期款，若要付期款請改用分攤。確定這筆是非期款支出（例如印刷費），請勾選確認（會留下稽核紀錄）。</span>
              </label>
            )}
          </>
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
                  const mismatched = vendorMismatchKeys.has(r.key);
                  return (
                    <tr key={r.key} className={`border-b last:border-0 align-top ${mismatched ? "bg-red-50" : ""}`}>
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
                        {mismatched && <div className="text-red-700">與收款廠商不同</div>}
                      </td>
                      <td className="py-1.5 pr-2">
                        <MoneyInput className={`${inputCls} text-right text-xs`} value={r.amount} onValueChange={(v) => patchRow(r.key, { amount: v })} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <MoneyInput className={`${inputCls} text-right text-xs`} value={r.withheldAmount} onValueChange={(v) => patchRow(r.key, { withheldAmount: v })} />
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
        {hasVendorMismatch && (
          <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            分攤的副委託廠商與收款廠商不同，請確認收款對象：移除標紅的分攤列，或把收款廠商改回原廠商。
          </p>
        )}
      </div>

      {acceptanceBlocked && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">複委託期款尚未驗收確認，暫時不能放款。</p>
          <p className="mt-1">
            本單分攤到的期別：
            {state.allocations.filter((r) => r.installmentNo != null).map((r) => `第 ${r.installmentNo} 期`).join("、") || "（無期款分攤）"}
            。請到專案頁的「副委託與協力技師 → 期款」按「驗收確認」後再送出。
          </p>
          {canForceAcceptance && (
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={forceAcceptance} onChange={(e) => setForceAcceptance(e.target.checked)} />
                未驗收仍要放款（HR 專用，會寫進稽核紀錄）
              </label>
              {forceAcceptance && (
                <input
                  className={inputCls}
                  value={forceReason}
                  onChange={(e) => setForceReason(e.target.value)}
                  placeholder="強制放行的理由（必填）"
                  maxLength={500}
                />
              )}
            </div>
          )}
        </div>
      )}

      <ErrorText>{error ?? localError}</ErrorText>
      <div className="flex items-center gap-3">
        {onCancel && <Button type="button" variant="secondary" className="md:min-h-10" onClick={onCancel}>取消</Button>}
        <PrimaryButton onClick={handleSubmit} disabled={busy || !canSubmit}>{busy ? "處理中…" : submitLabel}</PrimaryButton>
      </div>
    </div>
  );
}
