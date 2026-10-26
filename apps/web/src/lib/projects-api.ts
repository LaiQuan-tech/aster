/**
 * 專案 / 獎金分潤 / 知識庫文件的 typed API 呼叫。後端見
 * apps/api/src/routes/{projects,project-documents}.ts。admin 與 ess 頁面共用。
 * 分潤可見性由後端依角色分流（GET /projects/:id/members 的 canManage）；前端
 * 只是照後端回傳渲染，不自行 gate。
 */
import { apiFetch, type ApiError } from "./api-client"
import { getSupabaseBrowser } from "./supabase-browser"

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

/** B4：`GET /projects` 列表排序。未帶＝ created desc（後端預設）。 */
export type ProjectSort = "created" | "opened" | "name" | "code" | "status"
export type SortDir = "asc" | "desc"

export const PROJECT_SORT_LABELS: Record<ProjectSort, string> = {
  created: "建立日期",
  opened: "開案日期",
  name: "名稱",
  code: "編號",
  status: "狀態",
}

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
  /** 預定起訖日（甘特圖／示警）；可空。 */
  startsOn?: string | null
  endsOn?: string | null
  /** 開案日期（A5）。事後補 K 單的案子不用建立日／K 單日，用這欄真正開案那天。 */
  openedOn: string | null
  /** 人工解除封存的時點；自動封存看這一欄放過該筆。 */
  unarchivedAt?: string | null
  /** 衍生（模組四第 3 條）：有已簽訂的合約 = 成案；只有報價單 = 還沒。 */
  hasSignedContract?: boolean
  deptId: string | null
  leadEmpId: string | null
  shareMode: ShareMode
  bonusPool: number | null
  /** 合約未稅金額的專案獎金比例；有值時獎金池由後端依合約額連動計算。 */
  bonusRatePct?: number | null
  createdAt: string
}

/**
 * W3（2026-09-23）：專案成員四角色。manager 經理／lead 主辦屬「負責人層」
 * （看得到全案分潤、對該案有 finance 權限）；support 支援／member 組員只看自己那筆。
 * 每個角色可在專案設定裡預設一組分潤趴數（ProjectSettings.defaultSharePctByRole）。
 */
export type ProjectMemberRole = "manager" | "lead" | "support" | "member"

export const PROJECT_MEMBER_ROLE_LABELS: Record<ProjectMemberRole, string> = {
  manager: "經理",
  lead: "主辦",
  support: "支援",
  member: "組員",
}
/** 下拉選單順序：由高到低。 */
export const PROJECT_MEMBER_ROLE_ORDER: ProjectMemberRole[] = ["manager", "lead", "support", "member"]

export function memberRoleLabel(role: string): string {
  return PROJECT_MEMBER_ROLE_LABELS[role as ProjectMemberRole] ?? role
}

export interface ProjectMember {
  id: string
  employeeId: string
  name: string | null
  empNo: string | null
  roleInProject: ProjectMemberRole
  /**
   * 分潤數字。⚠️ 執行期可能**整個鍵不存在**：後端對「看得到全名單但沒有分潤權限」的
   * 呼叫者（會計，W4）省略這三個欄位。型別上維持 `number | null` 讓既有讀點不必全改
   * ——所有讀點都用 `!= null` ／ `?? "—"` 判斷，undefined 與 null 表現一致。
   * 本人那一列永遠帶得到自己的數字（ESS 專案頁靠這個顯示「我的分潤」）。
   */
  sharePct: number | null
  shareAmount: number | null
  /** 截至今天的累計應得（後端估算服務；估算不可用時為舊算法）。 */
  computedAmount: number | null
  /** 分潤改版 #1：估算服務的累計應得／已發放／待發（下限 0）。估算不可用時 null。 */
  estimatedAmount?: number | null
  paidAmount?: number | null
  pendingAmount?: number | null
}

export type BonusBasis = "gross_profit" | "legacy_pool" | "fixed_amount"

/** 專案層的估算數字（GET /projects/:id/members 的 bonusEstimate，只給看得到分潤的人）。 */
export interface ProjectBonusEstimateSummary {
  basis: BonusBasis
  pool: number | null
  contractTotal: number | null
  revenue: number
  cost: number
  grossProfit: number
  overContractPct: number | null
  skipped: "no_contract" | "no_pool" | null
}

export interface MembersResponse {
  canManage: boolean
  /** W4：分潤區（趴數／金額／獎金池）的可見性；舊版後端沒有這個鍵時視為與 canManage 相同。 */
  canSeeBonus?: boolean
  /** 分潤改版 #6：能不能改分潤（只有老闆／platform_admin）。 */
  canEditBonus?: boolean
  /** 租戶是否已指定老闆（沒有 → 提示先到公司設定指定）。 */
  bossConfigured?: boolean
  shareMode: ShareMode
  /** 累計獎金池（毛利制＝max(0,毛利)×比例；舊制＝手填獎金池）。 */
  bonusPool: number | null
  bonusRatePct?: number | null
  bonusEstimate?: ProjectBonusEstimateSummary | null
  members: ProjectMember[]
}

export interface ShareAdjustment {
  id: string
  employeeId: string | null
  name: string | null
  field: "pct" | "amount" | "pool" | "bonus_rate" | "role" | "member_added" | "member_removed" | string
  oldValue: number | string | null
  newValue: number | string | null
  reason: string | null
  createdAt: string
  /** 同一次整批儲存共用；舊資料可能沒有。 */
  changeSetId?: string | null
  changedByName?: string | null
}

export interface ProjectShareRevisionMemberInput {
  memberId?: string
  employeeId: string
  roleInProject: ProjectMemberRole
  sharePct: number
}

export interface ProjectShareRevisionResponse {
  changeSetId?: string
  revision?: { changeSetId?: string; adjustments?: ShareAdjustment[] }
  calculation?: {
    bonusTotal?: number | null
    sharePctTotal?: number
    unallocatedPct?: number
    unallocatedAmount?: number | null
  }
  members?: ProjectMember[]
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

/**
 * `GET /projects/:id/documents` 的回應。合約掃描檔只給 HR／該案 lead／該案經理與主辦成員：
 * 其他人的 `documents` 裡根本沒有合約掃描檔（連檔名都不給），`canSeeContractDocs` 是 false——
 * 前端靠這個旗標決定要不要顯示合約掃描的徽章與上傳／刪除按鈕與合約內容欄位。
 * 舊版後端沒有這個欄位時一律當 false（寧可少顯示，授權本來就在後端）。
 */
export interface ProjectDocumentsResponse {
  documents: ProjectDocument[]
  canSeeContractDocs: boolean
}

export interface MyProjectShare {
  memberId: string
  projectId: string
  projectName: string | null
  status: string | null
  roleInProject: ProjectMemberRole
  shareMode: ShareMode | null
  sharePct: number | null
  shareAmount: number | null
  computedAmount: number | null
  /** 分潤改版 #1（估算服務）：預估應得（累計）／已發／待發；估算不可用時 null。 */
  estimatedAmount?: number | null
  paidAmount?: number | null
  pendingAmount?: number | null
  basis?: BonusBasis | null
  /** 舊制（手填獎金池、未設獎金比例）。 */
  legacy?: boolean | null
  /** 目前累計毛利（入帳未稅－已發生成本）。 */
  grossProfit?: number | null
}

export interface ProjectSettings {
  autoArchiveEnabled: boolean
  /** 終止狀態滿這麼多個月自動封存。暫停不在此列。 */
  autoArchiveMonths: number
  /** 新建合約時的預設印花稅率；實際費率凍結在合約列上。 */
  stampDutyRate: number
  /** 印花稅清單回溯年數。預設 7——未申報的核課期間是 7 年。 */
  stampDutyLookbackYears: number
  /**
   * W3：四個專案角色的預設分潤趴數（0–100）。沒設定的角色不出現在這個物件裡。
   * 整鍵覆蓋：PUT 要送完整的四鍵，少帶等於清掉。後端 migration 0050 之前一律 {}。
   */
  defaultSharePctByRole?: Partial<Record<ProjectMemberRole, number>>
}

/* -------------------------------------------------------------- contracts -- */

export type DocType = "contract" | "quotation" | "change_order"
export type OurRole = "contractor" | "client" | "both"
export type StampDutyFlag = "auto" | "yes" | "no"

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  contract: "合約",
  quotation: "報價單",
  change_order: "追加減帳",
}

export const OUR_ROLE_LABELS: Record<OurRole, string> = {
  contractor: "我方承攬（我方貼花）",
  client: "我方定作（對方貼花）",
  both: "雙重身分（各自貼花，我方仍需貼）",
}

/** 精簡標籤：表格／徽章等窄空間用（合約卡三選一、印花稅備查清單）。 */
export const OUR_ROLE_SHORT_LABELS: Record<OurRole, string> = {
  contractor: "我方貼",
  client: "對方貼",
  both: "各自貼",
}

/**
 * 這張合約／報價單算不算我方承攬。both（各自貼）我方仍是承攬方，一樣算；
 * 只有 client（我方是定作人，對方才是承攬人）不算。跟 API 端
 * apps/api/src/lib/contract-role.ts 的 isOurContract 同一條規則——前台要判斷
 * 「這是我方的合約嗎」（例如訂單類型沿用合約）時用這個，不要重新寫
 * `=== "contractor"`。
 */
export function isOurContract(ourRole: OurRole | string): boolean {
  return ourRole !== "client"
}

export interface Contract {
  id: string
  projectId: string
  docType: DocType
  ourRole: OurRole
  title: string
  counterparty: string | null
  amount: number | null
  isPrimary: boolean
  signedOn: string | null
  version: number
  supersedesId: string | null
  copies: number
  stampDutyRequired: StampDutyFlag
  stampDutyRate: number | null
  stampDutyAmount: number | null
  stampDutyPaidOn: string | null
  stampDutyNote: string | null
  /**
   * 合約內容／說明（多行文字）。只有 HR／該案 lead／經理與主辦成員讀得到；其他人（含有 finance 的
   * 會計與部門主管）永遠收到 null——分不出「沒填」與「看不到」時看 `ProjectDocumentsResponse.canSeeContractDocs`。
   */
  contentNote?: string | null
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
    /** 合約內容／說明（最長 2000 字）。只有 canSeeContractDocs 的人能帶，否則 403 forbidden_contract_content。 */
    contentNote?: string | null
  },
) {
  return apiFetch<{ contract: Contract }>(`/projects/${projectId}/contracts`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/**
 * docType 不在參數裡：決定課不課稅的文件分類，要改請作廢後重立一件。
 * ourRole 可改——貼花方式（我方貼／對方貼／各自貼）常常簽約後才確認，
 * 後端會連同稅額一起重算，不會留下舊結論。
 */
export function updateContract(
  id: string,
  body: {
    title?: string
    counterparty?: string | null
    amount?: number | null
    signedOn?: string | null
    copies?: number
    ourRole?: OurRole
    stampDutyRequired?: StampDutyFlag
    stampDutyRate?: number | null
    stampDutyPaidOn?: string | null
    stampDutyNote?: string | null
    /** 合約內容／說明；null 或空字串＝清空。權限同 createContract。 */
    contentNote?: string | null
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

/**
 * `canEditBonus`／`bossConfigured`（分潤改版 #6）：角色預設趴數與建案分潤欄位只有老闆能改。
 * 舊版後端沒有這兩個鍵。
 */
export interface ProjectSettingsResponse {
  settings: ProjectSettings
  canEditBonus?: boolean
  bossConfigured?: boolean
}

export function getProjectSettings() {
  return apiFetch<ProjectSettingsResponse>("/project-settings")
}

export function updateProjectSettings(body: Partial<ProjectSettings>) {
  return apiFetch<ProjectSettingsResponse>("/project-settings", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/* --------------------------------------------------------------- projects -- */

/**
 * 預設不回已封存的專案——封存的目的就是從列表收起來。
 * B4：第二參數可選排序（欄位／方向），省略＝後端預設 created desc。
 */
export function listProjects(includeArchived = false, opts?: { sort?: ProjectSort; dir?: SortDir }) {
  const q = new URLSearchParams()
  if (includeArchived) q.set("includeArchived", "1")
  if (opts?.sort) q.set("sort", opts.sort)
  if (opts?.dir) q.set("dir", opts.dir)
  const qs = q.toString()
  return apiFetch<{ projects: Project[] }>(`/projects${qs ? `?${qs}` : ""}`)
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
  startsOn?: string | null
  endsOn?: string | null
  /** 開案日期（A5）。省略／null＝伺服器補租戶今天。 */
  openedOn?: string | null
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
    startsOn?: string | null
    endsOn?: string | null
    /** 開案日期（A5）。省略＝不動；帶 null 會清空。 */
    openedOn?: string | null
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
    roleInProject?: ProjectMemberRole
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
    roleInProject?: ProjectMemberRole
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

/** 一次儲存獎金比例與完整成員分配，後端在同一交易內寫入一組歷程。 */
export function saveProjectShareRevision(
  projectId: string,
  body: { bonusRatePct: number | null; members: ProjectShareRevisionMemberInput[]; reason: string },
) {
  return apiFetch<ProjectShareRevisionResponse>(`/projects/${projectId}/share-revision`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export function getMyProjectShares() {
  return apiFetch<{ shares: MyProjectShare[] }>("/my/project-shares")
}

/* -------------------------------------------------------------- documents -- */

export async function getProjectDocuments(projectId: string): Promise<ProjectDocumentsResponse> {
  const res = await apiFetch<{ documents: ProjectDocument[]; canSeeContractDocs?: boolean }>(`/projects/${projectId}/documents`)
  return { documents: res.documents, canSeeContractDocs: res.canSeeContractDocs === true }
}

/**
 * 上傳的兩條路（見 apps/api/src/routes/project-documents.ts）：
 *   • ≤ 3 MiB：檔案轉 base64 隨 JSON 送給 API。API 跑在 Vercel serverless，request body 上限約 4.5 MB，
 *     base64 又膨脹 4/3，所以經 API 實際只傳得動 3 MB 多；超過平台直接回 413（沒有 CORS 標頭，
 *     瀏覽器只看到「Failed to fetch」），所以大檔不能走這條。
 *   • 3 MiB～10 MiB：先向 API 要簽名上傳網址，瀏覽器把檔案直接傳進 Supabase Storage（不經 API），
 *     再呼叫 API 登記（API 用 Storage 回報的實際大小與類型再驗一次）。
 * 兩個常數與後端的 BASE64_MAX_BYTES／MAX_BYTES 同步。
 */
export const BASE64_UPLOAD_MAX_BYTES = 3 * 1024 * 1024
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

/**
 * 合約掃描檔只收 PDF 與圖片（後端 CONTRACT_SCAN_* 同一份名單）。一般專案文件不受這條限制。
 * `CONTRACT_SCAN_ACCEPT` 給 `<input type="file" accept>` 用——只是選檔時的提示，真正的把關在後端。
 */
export const CONTRACT_SCAN_EXTENSIONS: readonly string[] = [".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"]
export const CONTRACT_SCAN_ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp"
export const CONTRACT_SCAN_TYPE_MESSAGE = "合約掃描檔只收 PDF 與圖片（JPG、PNG、HEIC、WebP）。"

/**
 * 一般專案文件不收的類型：**執行檔與腳本**（2026-10-11；後端 apps/api/src/lib/blocked-upload-types.ts 同一份名單，
 * web 與 api 是各自的 build 邊界，各抄一份，`__tests__/project-documents-upload.test.ts` 直接 import 後端那份逐項比對）。
 * 合約掃描檔另有只收 PDF／圖片的白名單，不看這份。這裡只是上傳前的友善檢查（免得大檔傳完才被拒）；真正的把關在後端。
 */
export const BLOCKED_DOCUMENT_EXTENSIONS: readonly string[] = [
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1", ".vbs", ".vbe",
  ".js", ".jse", ".wsf", ".jar", ".apk", ".dmg", ".pkg", ".sh", ".app",
]
export const BLOCKED_DOCUMENT_CONTENT_TYPES: readonly string[] = [
  "application/x-msdownload", "application/x-msdos-program", "application/x-dosexec", "application/x-ms-dos-executable",
  "application/vnd.microsoft.portable-executable", "application/x-bat", "application/bat", "application/x-msi",
  "application/x-executable", "application/x-mach-binary", "application/x-elf",
  "application/x-sh", "application/x-shellscript", "application/x-csh", "text/x-shellscript", "text/x-sh",
  "application/javascript", "application/x-javascript", "text/javascript",
  "application/x-vbscript", "text/vbscript", "application/x-powershell", "text/x-powershell",
  "application/java-archive", "application/vnd.android.package-archive", "application/x-apple-diskimage",
]
export const BLOCKED_FILE_TYPE_MESSAGE =
  "專案文件不收執行檔與腳本（例如 .exe、.bat、.msi、.ps1、.js、.sh、.apk、.dmg）。請改傳文件、圖檔、表格或圖面等檔案；如果真的需要分享這類檔案，請洽管理員。"

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".webp": "image/webp",
}

function extOf(fileName: string): string {
  return (fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase()
}

/** 結尾多打的點／空白先去掉（Windows 會自動拿掉：`setup.exe.` 其實就是 `setup.exe`），再取最後一段副檔名。 */
function blockedCheckExtOf(fileName: string): string {
  return extOf(fileName.trim().replace(/[.\s]+$/u, ""))
}

/** 這個檔案是不是一般專案文件不收的類型（執行檔／腳本）：副檔名在名單內，或瀏覽器標的 MIME 在名單內。 */
export function isBlockedDocumentFile(file: { name: string; type?: string | null }): boolean {
  if (BLOCKED_DOCUMENT_EXTENSIONS.includes(blockedCheckExtOf(file.name))) return true
  const type = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  return BLOCKED_DOCUMENT_CONTENT_TYPES.includes(type)
}

/** 合約掃描檔的副檔名是否在名單內（上傳前的友善檢查；後端還會驗 MIME）。 */
export function isContractScanFile(file: { name: string }): boolean {
  return CONTRACT_SCAN_EXTENSIONS.includes(extOf(file.name))
}

/**
 * 上傳時帶的 MIME。瀏覽器對沒註冊的副檔名會給空字串（例如 Windows 上的 .heic）、
 * 或給 application/octet-stream；這時依副檔名補上正確的類型，免得合格的檔被後端的 MIME 檢查擋掉。
 * 瀏覽器自己有給明確類型就照用（`image/jpg` 這種非標準寫法改成 `image/jpeg`）。
 */
export function uploadContentType(file: { name: string; type: string }): string {
  const type = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  if (type && type !== "application/octet-stream") return type === "image/jpg" || type === "image/pjpeg" ? "image/jpeg" : type
  return CONTENT_TYPE_BY_EXT[extOf(file.name)] ?? "application/octet-stream"
}

const DOCUMENT_ERRORS: Record<string, string> = {
  forbidden: "沒有上傳權限（專案文件只有該案成員、負責人、所屬部門主管與 HR／會計能上傳）。",
  // unsupported_file_type 依上傳的是什麼而不同（合約掃描：只收 PDF／圖片；一般文件：不收執行檔），見 humanizeDocumentError。
  file_too_large: `檔案太大：單檔上限 ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB，請壓縮或拆檔後再上傳。`,
  contract_not_in_project: "這份合約不屬於這個專案、或已經作廢。",
  upload_not_found: "檔案沒有傳完整，請重新上傳。",
  invalid_storage_path: "上傳憑證不合法，請重新上傳。",
  already_registered: "這個檔案已經上傳過了。",
}

/** 合約掃描檔的 403：授權比一般專案文件窄（只有該案經理、承辦與 HR），訊息要講對。 */
const CONTRACT_SCAN_FORBIDDEN_MESSAGE = "沒有上傳權限（合約掃描檔只有該案經理、承辦與 HR 能上傳）。"

/**
 * 上傳／登記失敗的訊息翻成中文；不是 API 的錯誤（例如直傳 Storage 本身失敗）原樣顯示。
 * `contract`＝這次是合約掃描檔（403 的原因不同：授權比一般專案文件窄）。
 */
export function humanizeDocumentError(err: unknown, opts: { fallback?: string; contract?: boolean } = {}): string {
  if (!(err instanceof Error)) return opts.fallback ?? "上傳失敗"
  // apiFetch 丟出的錯誤帶 `.code`；沒有時（例如測試／別處手組的 Error）從「[403] forbidden」格式的訊息裡取。
  const code = (err as ApiError).code ?? err.message.match(/^\[\d{3}\]\s+(\w+)$/)?.[1]
  if (code === "forbidden" && opts.contract) return CONTRACT_SCAN_FORBIDDEN_MESSAGE
  // 同一個錯誤碼兩種意思：合約掃描 → 只收 PDF／圖片；一般專案文件 → 不收執行檔與腳本。
  if (code === "unsupported_file_type") return opts.contract ? CONTRACT_SCAN_TYPE_MESSAGE : BLOCKED_FILE_TYPE_MESSAGE
  if (code && DOCUMENT_ERRORS[code]) return DOCUMENT_ERRORS[code]
  return err.message || (opts.fallback ?? "上傳失敗")
}

/**
 * 頁面實際要顯示的文件：沒有權限的人一律不顯示合約掃描檔。後端本來就不會回給無權者
 * （GET /projects/:id/documents），這裡再濾一次讓前端與後端對應——萬一混進來也不會顯示徽章與連結。
 */
export function visibleProjectDocuments(documents: readonly ProjectDocument[], canSeeContractDocs: boolean): ProjectDocument[] {
  return documents.filter((doc) => !doc.contractId || canSeeContractDocs)
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  // 分段轉字串：一次 String.fromCharCode(...大陣列) 會爆呼叫堆疊，逐字元相加又太慢。
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

/**
 * 帶 contractId 就是合約掃描檔；後端會驗合約屬於此專案且未作廢，授權＝該案 lead／經理與主辦成員／HR
 * （部門主管與會計不行），檔案類型只收 PDF 與圖片。失敗一律丟 `Error`，message 已翻成中文。
 */
export async function uploadProjectDocument(projectId: string, file: File, contractId?: string) {
  if (contractId && !isContractScanFile(file)) throw new Error(CONTRACT_SCAN_TYPE_MESSAGE)
  // 一般專案文件不收執行檔與腳本：選到就直接說，不必傳完才被後端拒（後端仍會再驗）。
  if (!contractId && isBlockedDocumentFile(file)) throw new Error(BLOCKED_FILE_TYPE_MESSAGE)
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(DOCUMENT_ERRORS.file_too_large)
  const contentType = uploadContentType(file)
  try {
    if (file.size <= BASE64_UPLOAD_MAX_BYTES) {
      return await apiFetch<{ id: string; sizeBytes: number }>(`/projects/${projectId}/documents`, {
        method: "POST",
        body: JSON.stringify({
          fileName: file.name,
          contentType,
          dataBase64: await fileToBase64(file),
          ...(contractId ? { contractId } : {}),
        }),
      })
    }
    // 大檔：要簽名上傳網址 → 直傳 Storage → 登記。
    const slot = await apiFetch<{ bucket: string; path: string; token: string; maxBytes: number }>(
      `/projects/${projectId}/documents/upload-url`,
      {
        method: "POST",
        body: JSON.stringify({
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          ...(contractId ? { contractId } : {}),
        }),
      },
    )
    // supabase-js 對 Blob／File 一律以 FormData 送、MIME 取 blob.type（fileOptions.contentType 不管用），
    // 所以重包一個帶正確 type 的 File（內容不複製、只是參照）。
    const body = new File([file], file.name, { type: contentType })
    const { error } = await getSupabaseBrowser().storage.from(slot.bucket).uploadToSignedUrl(slot.path, slot.token, body, { contentType })
    if (error) throw new Error(`檔案傳到儲存空間失敗：${error.message}`)
    return await apiFetch<{ id: string; sizeBytes: number }>(`/projects/${projectId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        contentType,
        storagePath: slot.path,
        ...(contractId ? { contractId } : {}),
      }),
    })
  } catch (err) {
    throw new Error(humanizeDocumentError(err, { contract: !!contractId }))
  }
}

export function deleteProjectDocument(projectId: string, docId: string) {
  return apiFetch<{ id: string }>(`/projects/${projectId}/documents/${docId}`, {
    method: "DELETE",
  })
}

/* ------------------------------------------------- 專案總覽與進度示警 -- */

export interface OverviewMilestone {
  installmentNo: number
  plannedOn: string | null
  billedOn: string | null
  amount: number | null
}
export interface OverviewProject {
  id: string
  name: string
  code: string | null
  status: ProjectStatus
  startsOn: string | null
  endsOn: string | null
  createdAt: string
  leadEmpId: string | null
  leadName: string | null
  hasContract: boolean
  contractTotal: number | null
  billedTotal: number
  scheduledTotal: number
  milestones: OverviewMilestone[]
  lastActivity: string | null
  alerts: { high: number; medium: number; low: number }
}
export function getProjectOverview() {
  return apiFetch<{ today: string; projects: OverviewProject[] }>("/projects/overview")
}

export type AlertSeverity = "high" | "medium" | "low"
export interface ProjectAlert {
  key: string
  rule: string
  severity: AlertSeverity
  projectId: string
  projectName: string
  projectCode: string | null
  leadEmpId: string | null
  message: string
  dueOn?: string
  amount?: number
  installmentNo?: number
  daysOverdue?: number
}
export function getProjectAlerts() {
  return apiFetch<{ today: string; alerts: ProjectAlert[]; ruleLabels: Record<string, string>; aiAvailable: boolean }>("/projects/alerts")
}
export function getProjectAlertDigest() {
  return apiFetch<{ digest: string; model: string | null; alerts: number }>("/projects/alerts/digest", { method: "POST" })
}
