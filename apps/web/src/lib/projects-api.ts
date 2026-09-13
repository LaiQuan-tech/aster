/**
 * 專案 / 獎金分潤 / 知識庫文件的 typed API 呼叫。後端見
 * apps/api/src/routes/{projects,project-documents}.ts。admin 與 ess 頁面共用。
 * 分潤可見性由後端依角色分流（GET /projects/:id/members 的 canManage）；前端
 * 只是照後端回傳渲染，不自行 gate。
 */
import { apiFetch } from "./api-client"

export type ShareMode = "pool_pct" | "fixed_amount"

/**
 * 案情狀態（模組四第 2 條）。與「封存」是兩軸——封存是可見性，
 * 混進同一欄會弄丟「這案子是解約收場」這件事。
 */
export type ProjectStatus = "active" | "suspended" | "closed" | "terminated"

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "進行中",
  suspended: "暫停",
  closed: "結案",
  terminated: "已解約",
}

export const PROJECT_STATUS_ORDER: ProjectStatus[] = [
  "active",
  "suspended",
  "closed",
  "terminated",
]

/** 終止狀態：案子已結束（正常完工或中途解約）。 */
export function isTerminalStatus(s: string): boolean {
  return s === "closed" || s === "terminated"
}

export function statusLabel(s: string | null): string {
  return s && s in PROJECT_STATUS_LABELS
    ? PROJECT_STATUS_LABELS[s as ProjectStatus]
    : (s ?? "—")
}

export interface Project {
  id: string
  name: string
  /** 專案編號（識別碼，建立後不可變更）。 */
  code: string | null
  /** 歸屬年度（分析維度，可調整）。 */
  fiscalYear: number | null
  description: string | null
  /** 案情。 */
  status: string
  /** 這次狀態變更的理由（任何變更都必填）。 */
  statusReason: string | null
  /** 法律生效日（解約日／結案日），≠ 輸入時點。 */
  statusEffectiveOn: string | null
  /** 輸入時點。 */
  statusChangedAt: string | null
  /** 可見性：非 null 即已封存。 */
  archivedAt: string | null
  /** 人工解除封存的時點；自動封存看這一欄放過該筆。 */
  unarchivedAt?: string | null
  /** 衍生（模組四第 3 條）：有已簽訂的合約 = 成案；只有報價單 = 還沒。 */
  hasSignedContract?: boolean
  deptId: string | null
  leadEmpId: string | null
  shareMode: ShareMode
  bonusPool: number | null
  createdAt: string
}

export interface ProjectMember {
  id: string
  employeeId: string
  name: string | null
  empNo: string | null
  roleInProject: "member" | "lead"
  sharePct: number | null
  shareAmount: number | null
  computedAmount: number | null
}

export interface MembersResponse {
  canManage: boolean
  shareMode: ShareMode
  bonusPool: number | null
  members: ProjectMember[]
}

export interface ShareAdjustment {
  id: string
  employeeId: string | null
  name: string | null
  field: "pct" | "amount" | "pool"
  oldValue: number | null
  newValue: number | null
  reason: string | null
  createdAt: string
}

export interface ProjectDocument {
  id: string
  /** 有值 = 合約掃描檔（掛在該合約上）；null = 專案層級文件。 */
  contractId: string | null
  fileName: string
  sizeBytes: number
  contentType: string | null
  createdAt: string
  url: string | null
}

export interface MyProjectShare {
  memberId: string
  projectId: string
  projectName: string | null
  status: string | null
  roleInProject: "member" | "lead"
  shareMode: ShareMode | null
  sharePct: number | null
  shareAmount: number | null
  computedAmount: number | null
}

export interface ProjectSettings {
  autoArchiveEnabled: boolean
  /** 終止狀態滿這麼多個月自動封存。暫停不在此列。 */
  autoArchiveMonths: number
  /** 新建合約時的預設印花稅率；實際費率凍結在合約列上。 */
  stampDutyRate: number
  /** 印花稅清單回溯年數。預設 7——未申報的核課期間是 7 年。 */
  stampDutyLookbackYears: number
}

/* -------------------------------------------------------------- contracts -- */

export type DocType = "contract" | "quotation" | "change_order"
export type OurRole = "contractor" | "client"
export type StampDutyFlag = "auto" | "yes" | "no"

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  contract: "合約",
  quotation: "報價單",
  change_order: "追加減帳",
}

export const OUR_ROLE_LABELS: Record<OurRole, string> = {
  contractor: "我方承攬（我方貼花）",
  client: "我方定作（對方貼花）",
}

export interface Contract {
  id: string
  projectId: string
  docType: DocType
  ourRole: OurRole
  title: string
  counterparty: string | null
  amount: number | null
  signedOn: string | null
  version: number
  supersedesId: string | null
  copies: number
  stampDutyRequired: StampDutyFlag
  stampDutyRate: number | null
  stampDutyAmount: number | null
  stampDutyPaidOn: string | null
  stampDutyNote: string | null
  createdAt: string
  /** 衍生：最終是否應由我方貼花。 */
  dutiable: boolean
}

export interface StampDutySummary {
  dutiableCount: number
  dutiableTotal: number
  paidCount: number
  paidTotal: number
  unpaidCount: number
  unpaidTotal: number
  /** 應貼花卻沒填金額，算不出稅額。不併進「未貼 0 元」。 */
  missingAmountCount: number
  /** 應貼花卻沒有簽訂日，不在期間查詢裡但最該被追。 */
  missingSignedOn: number
}

export interface StampDutyItem {
  id: string
  projectId: string
  projectName: string | null
  projectCode: string | null
  docType: DocType
  ourRole: OurRole
  title: string
  counterparty: string | null
  amount: number | null
  signedOn: string | null
  copies: number
  dutiable: boolean
  stampDutyRate: number | null
  stampDutyAmount: number | null
  stampDutyPaidOn: string | null
  stampDutyNote: string | null
}

export function getContracts(projectId: string) {
  return apiFetch<{ contracts: Contract[] }>(`/projects/${projectId}/contracts`)
}

export function createContract(
  projectId: string,
  body: {
    docType: DocType
    ourRole?: OurRole
    title: string
    counterparty?: string | null
    amount?: number | null
    signedOn?: string | null
    copies?: number
    supersedesId?: string | null
    stampDutyRequired?: StampDutyFlag
    /** 補登舊約時指定當年度費率。 */
    stampDutyRate?: number | null
    stampDutyPaidOn?: string | null
    stampDutyNote?: string | null
  },
) {
  return apiFetch<{ contract: Contract }>(`/projects/${projectId}/contracts`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** docType / ourRole 不在參數裡：兩者決定課不課稅，要改請作廢後重立。 */
export function updateContract(
  id: string,
  body: {
    title?: string
    counterparty?: string | null
    amount?: number | null
    signedOn?: string | null
    copies?: number
    stampDutyRequired?: StampDutyFlag
    stampDutyRate?: number | null
    stampDutyPaidOn?: string | null
    stampDutyNote?: string | null
  },
) {
  return apiFetch<{ contract: Contract }>(`/contracts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

export function deleteContract(id: string, reason: string) {
  return apiFetch<{ id: string }>(`/contracts/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ reason }),
  })
}

/* --------------------------------------------------------------- billings -- */

export interface Installment {
  id: string
  installmentNo: number
  percentage: number | null
  milestone: string | null
  plannedOn: string | null
  /** 系統試算。已請款或已覆寫的期別為 null。 */
  calculatedAmount: number | null
  /** 本期吸收的尾差。非 0 要明示，別讓人以為系統算錯。 */
  residueApplied: number
  overrideAmount: number | null
  overrideReason: string | null
  billedOn: string | null
  billedAmount: number | null
  note: string | null
  /** 有效金額 = 已請款 ?? 人工覆寫 ?? 試算。 */
  effectiveAmount: number | null
}

export interface BillingSchedule {
  /** 分母的組成攤開顯示——看不到組成就會有人去試算表對帳。 */
  contract: { total: number | null; base: number; changeOrders: number }
  installments: Installment[]
  summary: {
    percentageTotal: number
    effectiveTotal: number
    /** 非 0 代表所有期別都已請款或已覆寫，尾差沒地方放。 */
    unallocatedResidue: number
    billedTotal: number
    unbilledTotal: number
  }
}

export interface InstallmentInput {
  id?: string
  installmentNo: number
  percentage?: number | null
  milestone?: string | null
  plannedOn?: string | null
  /** 有覆寫金額就必須有理由，否則後端回 400。 */
  overrideAmount?: number | null
  overrideReason?: string | null
  note?: string | null
}

export function getBillings(projectId: string) {
  return apiFetch<BillingSchedule>(`/projects/${projectId}/billings`)
}

/** 整批存：改一期的百分比會牽動尾差落點，逐筆存會出現假的中間狀態。 */
export function saveBillings(projectId: string, installments: InstallmentInput[]) {
  return apiFetch<BillingSchedule>(`/projects/${projectId}/billings`, {
    method: "PUT",
    body: JSON.stringify({ installments }),
  })
}

export function billInstallment(
  id: string,
  body: { billedOn?: string; billedAmount?: number | null } = {},
) {
  return apiFetch<BillingSchedule>(`/billings/${id}/bill`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function unbillInstallment(id: string, reason: string) {
  return apiFetch<BillingSchedule>(`/billings/${id}/unbill`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function getStampDutyReport(params?: {
  from?: string
  to?: string
  unpaidOnly?: boolean
}) {
  const q = new URLSearchParams()
  if (params?.from) q.set("from", params.from)
  if (params?.to) q.set("to", params.to)
  if (params?.unpaidOnly) q.set("unpaidOnly", "1")
  const qs = q.toString()
  return apiFetch<{
    range: { from: string; to: string; lookbackYears: number }
    summary: StampDutySummary
    items: StampDutyItem[]
    disclaimer: string
  }>(`/reports/stamp-duty${qs ? `?${qs}` : ""}`)
}

/* --------------------------------------------------------------- settings -- */

export function getProjectSettings() {
  return apiFetch<{ settings: ProjectSettings }>("/project-settings")
}

export function updateProjectSettings(body: Partial<ProjectSettings>) {
  return apiFetch<{ settings: ProjectSettings }>("/project-settings", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/* --------------------------------------------------------------- projects -- */

/** 預設不回已封存的專案——封存的目的就是從列表收起來。 */
export function listProjects(includeArchived = false) {
  return apiFetch<{ projects: Project[] }>(
    includeArchived ? "/projects?includeArchived=1" : "/projects",
  )
}

export function getProject(id: string) {
  return apiFetch<{ project: Project }>(`/projects/${id}`)
}

export function createProject(body: {
  name: string
  /** 省略＝系統產號（`P{建立年}-{流水號}`）；填了就是人工指定，撞號回 409。 */
  code?: string | null
  /** 省略＝同編號的年度（建立年）。 */
  fiscalYear?: number | null
  description?: string | null
  deptId?: string | null
  leadEmpId?: string | null
  shareMode?: ShareMode
  bonusPool?: number | null
}) {
  return apiFetch<{ id: string; code: string | null }>("/projects", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/**
 * 編輯專案。**`code` 不在參數裡**——編號是識別碼，已印在合約與請款單上，
 * 不可變更；後端帶了 code 會回 409。要調歸屬年度請用 `fiscalYear`。
 */
export function updateProject(
  id: string,
  body: {
    name?: string
    fiscalYear?: number | null
    description?: string | null
    /** 改狀態一律要一併給 statusReason，否則後端回 400。 */
    status?: ProjectStatus
    statusReason?: string
    /** 法律生效日；未給時後端取今天。 */
    statusEffectiveOn?: string | null
    /** 可見性，與 status 互不干涉。封存「進行中」的專案會被擋（400）。 */
    archived?: boolean
    deptId?: string | null
    leadEmpId?: string | null
    shareMode?: ShareMode
    bonusPool?: number | null
  },
) {
  return apiFetch<{ id: string }>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

/* ---------------------------------------------------------------- members -- */

export function getProjectMembers(projectId: string) {
  return apiFetch<MembersResponse>(`/projects/${projectId}/members`)
}

export function addProjectMember(
  projectId: string,
  body: {
    employeeId: string
    roleInProject?: "member" | "lead"
    sharePct?: number | null
    shareAmount?: number | null
  },
) {
  return apiFetch<{ id: string }>(`/projects/${projectId}/members`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function updateProjectMember(
  projectId: string,
  memberId: string,
  body: {
    roleInProject?: "member" | "lead"
    sharePct?: number | null
    shareAmount?: number | null
    reason?: string
  },
) {
  return apiFetch<{ id: string }>(`/projects/${projectId}/members/${memberId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

export function removeProjectMember(projectId: string, memberId: string) {
  return apiFetch<{ id: string }>(`/projects/${projectId}/members/${memberId}`, {
    method: "DELETE",
  })
}

export function getProjectAdjustments(projectId: string) {
  return apiFetch<{ adjustments: ShareAdjustment[] }>(`/projects/${projectId}/adjustments`)
}

export function getMyProjectShares() {
  return apiFetch<{ shares: MyProjectShare[] }>("/my/project-shares")
}

/* -------------------------------------------------------------- documents -- */

export function getProjectDocuments(projectId: string) {
  return apiFetch<{ documents: ProjectDocument[] }>(`/projects/${projectId}/documents`)
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** 帶 contractId 就是合約掃描檔；後端會驗合約屬於此專案且未作廢，授權比照合約（HR / lead / 部門主管）。 */
export async function uploadProjectDocument(projectId: string, file: File, contractId?: string) {
  const dataBase64 = await fileToBase64(file)
  return apiFetch<{ id: string; sizeBytes: number }>(`/projects/${projectId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      dataBase64,
      ...(contractId ? { contractId } : {}),
    }),
  })
}

export function deleteProjectDocument(projectId: string, docId: string) {
  return apiFetch<{ id: string }>(`/projects/${projectId}/documents/${docId}`, {
    method: "DELETE",
  })
}
