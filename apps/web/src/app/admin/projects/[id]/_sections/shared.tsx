/**
 * 專案詳情頁（/admin/projects/[id]）各 section 共用的型別與純函式。
 * B0 拆檔時自 page.tsx 原封搬出，內容不變。
 */
import type { Dispatch, SetStateAction } from "react";
import {
  ENGINEER_DISCIPLINES,
  type ProjectDetail,
  type DesignScopeItem,
  type InvoiceType,
  type PaymentMethod,
  type EngineerDiscipline,
  type Subcontract,
  type SubcontractsResponse,
  type BillingScheduleExt,
} from "@/lib/projects-ext-api";

/** useState 的 setter 型別，各 section 以 props 接收 page.tsx 的共用 state。 */
export type Setter<T> = Dispatch<SetStateAction<T>>;

/** 後端的錯誤碼翻成人看得懂的話（既有：合約／狀態／成員這些流程用）。 */
export const STATUS_ERRORS: Record<string, string> = {
  status_reason_required: "變更案情狀態必須填理由。",
  archive_requires_non_active: "「進行中」的專案不能封存。要收起來請先改成暫停、結案或已解約。",
  invalid_status: "狀態值不合法。",
  override_reason_required: "人工指定金額必須填理由——偏離期程的金額是談出來的，要留得下痕跡。",
  billed_installment_not_removable: "已請款的期別不能移除。帳已經出去了，移掉那筆應收會憑空消失。",
  duplicate_installment_no: "期別編號重複。",
  installment_no_taken: "期別編號已存在。",
  amount_unknown: "算不出金額（還沒有合約，或這期沒有百分比也沒有人工金額）。",
  already_billed: "這期已經標記請款過了。",
  not_billed: "這期還沒標記請款。",
};

export function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}
export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export type EngineerFormValue = { vendorId: string | null; name: string | null };
export type EngineersForm = Record<EngineerDiscipline, EngineerFormValue>;

export function emptyEngineersForm(): EngineersForm {
  return {
    electrical: { vendorId: null, name: null },
    hvac: { vendorId: null, name: null },
    fire: { vendorId: null, name: null },
  };
}

export interface AppForm {
  siteAddress: string;
  siteAreaM2: string;
  designScope: DesignScopeItem[];
  invoiceType: InvoiceType | "";
  paymentMethod: PaymentMethod | "";
  closingDay: string;
  paymentDay: string;
  otherExpenses: string;
  engineers: EngineersForm;
}

export function appFormFrom(p: ProjectDetail): AppForm {
  const engineers = emptyEngineersForm();
  for (const d of ENGINEER_DISCIPLINES) {
    const a = p.engineers?.[d];
    if (a) engineers[d] = { vendorId: a.vendorId ?? null, name: a.name ?? null };
  }
  return {
    siteAddress: p.siteAddress ?? "",
    siteAreaM2: p.siteAreaM2 != null ? String(p.siteAreaM2) : "",
    designScope: p.designScope ?? [],
    invoiceType: (p.invoiceType as InvoiceType) ?? "",
    paymentMethod: (p.paymentMethod as PaymentMethod) ?? "",
    closingDay: p.closingDay ?? "",
    paymentDay: p.paymentDay ?? "",
    otherExpenses: p.otherExpenses != null ? String(p.otherExpenses) : "",
    engineers,
  };
}

export type SubRow = Subcontract & { _key: string };
let subSeq = 0;
export const newSubKey = () => `newsub-${Date.now()}-${subSeq++}`;
export function toSubRows(list: Subcontract[]): SubRow[] {
  return list.map((s) => ({ ...s, _key: s.id ?? newSubKey() }));
}
export function emptySubcontractsResponse(): SubcontractsResponse {
  return { subcontracts: [], summary: { subcontractTotal: 0, technicianTotal: 0, total: 0, paidTotal: 0, withheldTotal: 0 } };
}
export function emptyBillingSchedule(): BillingScheduleExt {
  return {
    contract: { total: null, base: 0, changeOrders: 0 },
    installments: [],
    summary: {
      percentageTotal: 0, effectiveTotal: 0, unallocatedResidue: 0, guildAdvanceTotal: 0,
      billedTotal: 0, unbilledTotal: 0, invoicedTotal: 0, receivedTotal: 0, unreceivedTotal: 0,
    },
    warnings: [],
  };
}

export function humanError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback;
  for (const [code, text] of Object.entries(STATUS_ERRORS)) {
    if (msg.includes(code)) return text;
  }
  if (msg.includes("code_immutable")) return "專案編號不可變更。";
  return msg;
}
