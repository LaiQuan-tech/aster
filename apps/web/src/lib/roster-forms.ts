import type { Vendor, VendorInput, VendorRosterKind } from "./company-api";
import type { Client, ClientCategory, ClientInput, InvoiceType, PaymentMethod } from "./projects-ext-api";
import { affiliateInputField } from "./affiliate";
import { parseSeqInput, vendorRosterKind } from "./roster-columns";

/**
 * 名冊編輯表單 ⇄ API 的對應（純函式，給 admin/vendors、admin/clients 兩頁用，也方便單元測試）。
 * 表單一律存字串；送出時 trim、空字串轉 null，「序」轉整數（不合法回錯誤，不送）。
 * 關係企業旗標只在有變動時才送（見 lib/affiliate.ts），免得非 HR 改別的欄位被 403。
 */

export type VendorForm = {
  rosterKind: VendorRosterKind;
  shortName: string; seq: string; category: string; subCategory: string; code: string; name: string;
  phone: string; fax: string; contactName: string; mobile: string; email: string; address: string;
  taxId: string; paymentTerms: string; note: string; website: string;
  title: string; bankName: string; bankCode: string; bankAccount: string; accountHolder: string;
  isAffiliate: boolean;
};
export type VendorTextKey = Exclude<keyof VendorForm, "isAffiliate" | "rosterKind">;

export const emptyVendorForm = (rosterKind: VendorRosterKind = "supplier"): VendorForm => ({
  rosterKind,
  shortName: "", seq: "", category: "", subCategory: "", code: "", name: "",
  phone: "", fax: "", contactName: "", mobile: "", email: "", address: "",
  taxId: "", paymentTerms: "", note: "", website: "",
  title: "", bankName: "", bankCode: "", bankAccount: "", accountHolder: "",
  isAffiliate: false,
});

export function vendorFormFrom(v: Vendor): VendorForm {
  const s = (x: string | null | undefined) => x ?? "";
  return {
    rosterKind: vendorRosterKind(v),
    shortName: s(v.shortName), seq: v.seq == null ? "" : String(v.seq), category: s(v.category), subCategory: s(v.subCategory),
    code: s(v.code), name: v.name, phone: s(v.phone), fax: s(v.fax), contactName: s(v.contactName), mobile: s(v.mobile),
    email: s(v.email), address: s(v.address), taxId: s(v.taxId), paymentTerms: s(v.paymentTerms), note: s(v.note), website: s(v.website),
    title: s(v.title), bankName: s(v.bankName), bankCode: s(v.bankCode), bankAccount: s(v.bankAccount), accountHolder: s(v.accountHolder),
    isAffiliate: v.isAffiliate === true,
  };
}

export type FormResult<T> = { ok: true; input: T } | { ok: false; error: string };

const t = (x: string): string | null => x.trim() || null;

/** `original`＝正在編輯的廠商（新增時 null）。 */
export function vendorFormToInput(f: VendorForm, original: Vendor | null): FormResult<VendorInput> {
  const seq = parseSeqInput(f.seq);
  if (seq === "invalid") return { ok: false, error: "「序」請填 0–99999 的整數" };
  return {
    ok: true,
    input: {
      name: f.name.trim(),
      rosterKind: f.rosterKind,
      shortName: t(f.shortName), seq, category: t(f.category), subCategory: t(f.subCategory), code: t(f.code),
      phone: t(f.phone), fax: t(f.fax), contactName: t(f.contactName), mobile: t(f.mobile), email: t(f.email), address: t(f.address),
      taxId: t(f.taxId), paymentTerms: t(f.paymentTerms), note: t(f.note), website: t(f.website),
      title: t(f.title), bankName: t(f.bankName), bankCode: t(f.bankCode), bankAccount: t(f.bankAccount), accountHolder: t(f.accountHolder),
      ...affiliateInputField(f.isAffiliate, original),
    },
  };
}

export type ClientForm = {
  shortName: string; seq: string; region: string; code: string; name: string; phone: string; fax: string;
  contactName: string; contactPhone: string; email: string; invoiceAddress: string; taxId: string;
  paymentMethod: PaymentMethod | ""; note: string;
  category: ClientCategory | ""; invoiceType: InvoiceType | ""; closingDay: string; paymentDay: string;
  isAffiliate: boolean;
};
export type ClientTextKey = Exclude<keyof ClientForm, "isAffiliate" | "paymentMethod" | "category" | "invoiceType">;

export const emptyClientForm = (): ClientForm => ({
  shortName: "", seq: "", region: "", code: "", name: "", phone: "", fax: "",
  contactName: "", contactPhone: "", email: "", invoiceAddress: "", taxId: "",
  paymentMethod: "", note: "", category: "", invoiceType: "", closingDay: "", paymentDay: "",
  isAffiliate: false,
});

export function clientFormFrom(c: Client): ClientForm {
  const s = (x: string | null | undefined) => x ?? "";
  return {
    shortName: s(c.shortName), seq: c.seq == null ? "" : String(c.seq), region: s(c.region), code: s(c.code), name: c.name,
    phone: s(c.phone), fax: s(c.fax), contactName: s(c.contactName), contactPhone: s(c.contactPhone), email: s(c.email),
    invoiceAddress: s(c.invoiceAddress), taxId: s(c.taxId), paymentMethod: c.paymentMethod ?? "", note: s(c.note),
    category: c.category ?? "", invoiceType: c.invoiceType ?? "", closingDay: s(c.closingDay), paymentDay: s(c.paymentDay),
    isAffiliate: c.isAffiliate === true,
  };
}

/** `original`＝正在編輯的客戶（新增時 null）。 */
export function clientFormToInput(f: ClientForm, original: Client | null): FormResult<ClientInput> {
  const seq = parseSeqInput(f.seq);
  if (seq === "invalid") return { ok: false, error: "「序」請填 0–99999 的整數" };
  return {
    ok: true,
    input: {
      name: f.name.trim(),
      shortName: t(f.shortName), seq, region: t(f.region), code: t(f.code),
      phone: t(f.phone), fax: t(f.fax), contactName: t(f.contactName), contactPhone: t(f.contactPhone), email: t(f.email),
      invoiceAddress: t(f.invoiceAddress), taxId: t(f.taxId), paymentMethod: f.paymentMethod || null, note: t(f.note),
      category: f.category || null, invoiceType: f.invoiceType || null, closingDay: t(f.closingDay), paymentDay: t(f.paymentDay),
      ...affiliateInputField(f.isAffiliate, original),
    },
  };
}
