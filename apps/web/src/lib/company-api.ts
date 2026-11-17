/**
 * 公司資訊頁、專屬 Email 配發、廠商名冊的 typed API 呼叫。
 * 後端見 apps/api/src/routes/{company-pages,employee-mailboxes,vendors}.ts。
 */
import { apiFetch } from "./api-client"

/* ------------------------------------------------------------ 公司資訊頁 -- */
export interface CompanyPage {
  slug: string
  defaultTitle: string
  title: string
  body: string
  updatedAt: string | null
  updatedByEmpId: string | null
  exists: boolean
}
export function getCompanyPages() {
  return apiFetch<{ pages: CompanyPage[] }>("/company-pages")
}
export function putCompanyPage(slug: string, body: { title: string; body: string }) {
  return apiFetch<{ page: { slug: string; title: string; body: string; updatedAt: string } }>(`/company-pages/${slug}`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/* ----------------------------------------------------------- Email 配發 -- */
export type MailboxStatus = "planned" | "active" | "suspended"
export interface Mailbox {
  id: string
  employeeId: string
  address: string
  status: MailboxStatus
  provider: string | null
  activatedOn: string | null
  suspendedOn: string | null
  note: string | null
  updatedAt: string
}
export const MAILBOX_STATUS_LABEL: Record<MailboxStatus, string> = {
  planned: "待建立",
  active: "使用中",
  suspended: "已停用",
}
export function getMailboxes() {
  return apiFetch<{ mailboxes: Mailbox[] }>("/employee-mailboxes")
}
export function putMailbox(
  employeeId: string,
  body: { address: string; status?: MailboxStatus; provider?: string | null; activatedOn?: string | null; suspendedOn?: string | null; note?: string | null },
) {
  return apiFetch<{ mailbox: Mailbox }>(`/employee-mailboxes/${employeeId}`, { method: "PUT", body: JSON.stringify(body) })
}

/* ------------------------------------------------------------- 廠商名冊 -- */
/** 名冊類別＝Excel「客供商基本資料」的工作表（0076）。 */
export type VendorRosterKind = "supplier" | "engineer" | "review_unit"
export interface Vendor {
  id: string
  name: string
  /** 簡稱：列表、下拉與搜尋用，可空（最長 40 字）。選填欄位：web 先於 API 部署時舊回應沒有這個鍵。 */
  shortName?: string | null
  /** 關係企業（集團內姊妹公司）：集團總覽的集團合計會剔除付給這家廠商的放款。選填：舊回應沒有這個鍵。 */
  isAffiliate?: boolean
  /** 名冊類別＝Excel 工作表（0076）：supplier 供應商資料 | engineer 技師資料 | review_unit 送審相關單位。選填：舊回應沒有這個鍵（當 supplier）。 */
  rosterKind?: VendorRosterKind
  /** Excel「序」（0076）。 */
  seq?: number | null
  /** Excel「類別」。 */
  category: string | null
  /** Excel「細目」（0076）。 */
  subCategory?: string | null
  /** Excel「編號」（0076）。 */
  code?: string | null
  /** Excel「承辦窗口」（原格整段文字，可能含多位窗口）。 */
  contactName: string | null
  title: string | null
  phone: string | null
  /** Excel「FAX」（0076）。 */
  fax?: string | null
  mobile: string | null
  email: string | null
  address: string | null
  taxId: string | null
  taxIdValid: boolean | null
  website: string | null
  /** Excel「付款方式」（0076），自由文字。 */
  paymentTerms?: string | null
  note: string | null
  /** 收款帳戶（放款專區用）。 */
  bankName: string | null
  bankCode: string | null
  bankAccount: string | null
  accountHolder: string | null
  /** 收款帳戶是否經老闆／HR 確認（0104）；只有 listVendors(…, { bankVerified: true }) 才帶。 */
  bankVerified?: boolean
  hasCard: boolean
  source: "manual" | "card_ocr"
  createdAt: string
  updatedAt: string
}
export type VendorInput = Partial<Omit<Vendor, "id" | "taxIdValid" | "hasCard" | "createdAt" | "updatedAt">> & {
  name: string
  cardStoragePath?: string | null
}
/**
 * 廠商下拉選項的顯示字：有簡稱顯示「簡稱（全名）」，沒有（或簡稱與全名相同）只顯示全名。
 * 只影響顯示——選下去存的、帶進表單的仍是全名（payeeName／vendorName 等）。
 */
export function vendorOptionLabel(v: Pick<Vendor, "name" | "shortName">): string {
  return v.shortName && v.shortName !== v.name ? `${v.shortName}（${v.name}）` : v.name
}
export function listVendors(q?: string, opts: { bankVerified?: boolean } = {}) {
  const qs = new URLSearchParams()
  if (q) qs.set("q", q)
  if (opts.bankVerified) qs.set("bankVerified", "1")
  const s = qs.toString()
  return apiFetch<{ vendors: Vendor[] }>(`/vendors${s ? `?${s}` : ""}`)
}
/** `confirmDistinctReason`：名稱與名冊廠商相近（409 vendor_name_similar）但確為不同公司的說明（第八輪，寫嚴格稽核）。 */
export function createVendor(body: VendorInput & { confirmDistinctReason?: string }) {
  // 2026-11-17：帶收款帳戶新建 → 廠商照建，帳戶送老闆／HR 覆核（bankChangeRequested）。
  return apiFetch<{ vendor: Vendor; bankChangeRequested?: boolean; bankChangeError?: string; message?: string }>("/vendors", { method: "POST", body: JSON.stringify(body) })
}
/** `changeReason`：只有未付期款時改收款帳戶必填（後端寫稽核，2026-11-16 R2）。 */
export function updateVendor(id: string, body: Partial<VendorInput> & { changeReason?: string; confirmDistinctReason?: string }) {
  // 2026-11-17：改收款帳戶一律 202＋bankChangeRequested（送老闆／HR 覆核，帳戶尚未生效；其他欄位已存）。
  return apiFetch<{ vendor: Vendor; bankChangeRequested?: boolean; bankChangeRequest?: { id: string; status: string }; message?: string }>(
    `/vendors/${id}`,
    { method: "PATCH", body: JSON.stringify(body) },
  )
}

/* -------------------------------------------- 廠商收款帳戶變更雙人覆核 -- */
export type VendorBankChangeStatus = "pending" | "approved" | "rejected" | "cancelled"
export interface VendorBankFields {
  bankCode: string | null
  bankName: string | null
  bankAccount: string | null
  accountHolder: string | null
}
export interface VendorBankChangeRequest {
  id: string
  vendorId: string
  vendorName: string | null
  status: VendorBankChangeStatus
  reason: string | null
  requestedByEmpId: string | null
  requestedByName: string | null
  decidedByEmpId: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  createdAt: string
  old: VendorBankFields
  new: VendorBankFields
  canDecide: boolean
  canCancel: boolean
}
/** 覆核者（老闆／平台管理員／HR）與財務角色可讀；其他人 403。 */
export function listVendorBankChanges(params: { status?: VendorBankChangeStatus | "all"; vendorId?: string } = {}) {
  const qs = new URLSearchParams()
  if (params.status) qs.set("status", params.status)
  if (params.vendorId) qs.set("vendorId", params.vendorId)
  const q = qs.toString()
  return apiFetch<{ requests: VendorBankChangeRequest[]; isReviewer: boolean }>(`/vendor-bank-changes${q ? `?${q}` : ""}`)
}
export function decideVendorBankChange(id: string, action: "approve" | "reject" | "cancel", note?: string) {
  return apiFetch<{ id: string; vendorId: string; status: VendorBankChangeStatus }>(
    `/vendor-bank-changes/${id}/${action}`,
    { method: "POST", body: JSON.stringify(note ? { note } : {}) },
  )
}
export function deleteVendor(id: string) {
  return apiFetch<{ id: string }>(`/vendors/${id}`, { method: "DELETE" })
}
export function getVendorCardUrl(id: string) {
  return apiFetch<{ url: string }>(`/vendors/${id}/card`)
}

export interface CardScanResult {
  cardStoragePath: string
  model: string | null
  warning?: string
  fields: {
    name: string | null
    contactName: string | null
    title: string | null
    phone: string | null
    mobile: string | null
    email: string | null
    address: string | null
    taxId: string | null
    taxIdValid: boolean | null
    website: string | null
    category: string | null
  } | Record<string, never>
}
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
export async function scanVendorCard(file: File) {
  const dataBase64 = await fileToBase64(file)
  return apiFetch<CardScanResult>("/vendors/card-scan", {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, contentType: file.type || "image/jpeg", dataBase64 }),
  })
}
