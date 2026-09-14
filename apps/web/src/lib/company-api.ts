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
export interface Vendor {
  id: string
  name: string
  category: string | null
  contactName: string | null
  title: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  address: string | null
  taxId: string | null
  taxIdValid: boolean | null
  website: string | null
  note: string | null
  /** 收款帳戶（放款專區用）。 */
  bankName: string | null
  bankCode: string | null
  bankAccount: string | null
  accountHolder: string | null
  hasCard: boolean
  source: "manual" | "card_ocr"
  createdAt: string
  updatedAt: string
}
export type VendorInput = Partial<Omit<Vendor, "id" | "taxIdValid" | "hasCard" | "createdAt" | "updatedAt">> & {
  name: string
  cardStoragePath?: string | null
}
export function listVendors(q?: string) {
  return apiFetch<{ vendors: Vendor[] }>(`/vendors${q ? `?q=${encodeURIComponent(q)}` : ""}`)
}
export function createVendor(body: VendorInput) {
  return apiFetch<{ vendor: Vendor }>("/vendors", { method: "POST", body: JSON.stringify(body) })
}
export function updateVendor(id: string, body: Partial<VendorInput>) {
  return apiFetch<{ vendor: Vendor }>(`/vendors/${id}`, { method: "PATCH", body: JSON.stringify(body) })
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
