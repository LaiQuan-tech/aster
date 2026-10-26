import type { Vendor, VendorRosterKind } from "./company-api";
import type { Client, PaymentMethod } from "./projects-ext-api";

/**
 * 名冊（客戶／廠商）列表欄位＝業主的 Excel「客供商基本資料」欄位，順序與欄名照抄
 * （Excel 欄名裡為了對齊塞的全形／半形空白拿掉：「類    別」→「類別」、「公　司　名　稱」→「公司名稱」、「區　域」→「區域」）。
 * 廠商三個工作表（供應商資料／技師資料／送審相關單位）欄位相同，以「名冊類別」（vendors.roster_kind）區分；
 * 客戶是「客戶資料」工作表。Excel 沒有的系統欄位（銀行帳戶、關係企業、發票聯式…）只在編輯表單出現。
 */

export const VENDOR_ROSTER_KINDS: readonly VendorRosterKind[] = ["supplier", "engineer", "review_unit"];
/** 名冊類別的顯示字（對應 Excel 工作表名稱）。 */
export const VENDOR_ROSTER_KIND_LABELS: Record<VendorRosterKind, string> = {
  supplier: "供應商",
  engineer: "技師",
  review_unit: "送審相關單位",
};

export type VendorColumnKey =
  | "shortName" | "seq" | "category" | "subCategory" | "code" | "name" | "phone" | "fax" | "contactName"
  | "mobile" | "email" | "address" | "taxId" | "paymentTerms" | "note" | "website";
export type ClientColumnKey =
  | "shortName" | "seq" | "region" | "code" | "name" | "phone" | "fax" | "contactName"
  | "contactPhone" | "email" | "invoiceAddress" | "taxId" | "paymentMethod" | "note";

export interface RosterColumn<K extends string> {
  /** Excel 欄名（列表表頭、表單標籤都用這個字）。 */
  header: string;
  key: K;
  /** 長文字欄：列表換行顯示、表單用多行輸入框。 */
  multiline?: boolean;
}

/** Excel「供應商資料」「技師資料」「送審相關單位」的 16 欄（A:P）。 */
export const VENDOR_EXCEL_COLUMNS: ReadonlyArray<RosterColumn<VendorColumnKey>> = [
  { header: "簡稱", key: "shortName" },
  { header: "序", key: "seq" },
  { header: "類別", key: "category" },
  { header: "細目", key: "subCategory" },
  { header: "編號", key: "code" },
  { header: "公司名稱", key: "name" },
  { header: "TEL", key: "phone", multiline: true },
  { header: "FAX", key: "fax", multiline: true },
  { header: "承辦窗口", key: "contactName", multiline: true },
  { header: "Mobil", key: "mobile", multiline: true },
  { header: "E-mail", key: "email", multiline: true },
  { header: "公司地址", key: "address" },
  { header: "統編", key: "taxId" },
  { header: "付款方式", key: "paymentTerms" },
  { header: "備註", key: "note", multiline: true },
  { header: "網址", key: "website" },
];

/** Excel「客戶資料」的 14 欄（A:N）。「公司地址」存在 invoiceAddress、「Mobil」存在 contactPhone、「收款方式」存在 paymentMethod。 */
export const CLIENT_EXCEL_COLUMNS: ReadonlyArray<RosterColumn<ClientColumnKey>> = [
  { header: "簡稱", key: "shortName" },
  { header: "序", key: "seq" },
  { header: "區域", key: "region" },
  { header: "編號", key: "code" },
  { header: "公司名稱", key: "name" },
  { header: "TEL", key: "phone", multiline: true },
  { header: "FAX", key: "fax", multiline: true },
  { header: "承辦窗口", key: "contactName", multiline: true },
  { header: "Mobil", key: "contactPhone", multiline: true },
  { header: "e-mail", key: "email", multiline: true },
  { header: "公司地址", key: "invoiceAddress" },
  { header: "統編", key: "taxId" },
  { header: "收款方式", key: "paymentMethod" },
  { header: "備註", key: "note", multiline: true },
];

const text = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v).trim();
};

/** 廠商列表某欄的顯示字（沒填＝空字串，畫面自己決定顯示「—」）。 */
export function vendorCellText(v: Vendor, key: VendorColumnKey): string {
  return text(v[key]);
}

/** 客戶列表某欄的顯示字；收款方式顯示中文（匯款／支票）。 */
export function clientCellText(c: Client, key: ClientColumnKey, paymentLabels: Record<PaymentMethod, string>): string {
  if (key === "paymentMethod") return c.paymentMethod ? paymentLabels[c.paymentMethod] ?? c.paymentMethod : "";
  return text(c[key]);
}

/** 名冊類別：舊 API 回應沒有這個鍵、或值不認得，一律當「供應商」。 */
export function vendorRosterKind(v: Pick<Vendor, "rosterKind">): VendorRosterKind {
  return v.rosterKind && (VENDOR_ROSTER_KINDS as readonly string[]).includes(v.rosterKind) ? v.rosterKind : "supplier";
}

export function filterVendorsByKind<T extends Pick<Vendor, "rosterKind">>(vendors: T[], kind: VendorRosterKind | "all"): T[] {
  return kind === "all" ? vendors : vendors.filter((v) => vendorRosterKind(v) === kind);
}

export function countVendorsByKind(vendors: Array<Pick<Vendor, "rosterKind">>): Record<VendorRosterKind | "all", number> {
  const out: Record<VendorRosterKind | "all", number> = { all: vendors.length, supplier: 0, engineer: 0, review_unit: 0 };
  for (const v of vendors) out[vendorRosterKind(v)] += 1;
  return out;
}

/** 「類別／細目」合併字（發包選廠商的類別篩選用；兩者都空回 ""）。 */
export function vendorCategoryLabel(v: Pick<Vendor, "category" | "subCategory">): string {
  return [v.category, v.subCategory].map((s) => (s ?? "").trim()).filter(Boolean).join("／");
}

/** 「序」輸入框 → API 值：空白＝null；非 0–99999 的整數回 "invalid"（表單擋下不送）。 */
export function parseSeqInput(raw: string): number | null | "invalid" {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d{1,5}$/.test(s)) return "invalid";
  return Number(s);
}
