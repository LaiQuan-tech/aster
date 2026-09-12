/**
 * 專案 / 獎金分潤 / 知識庫文件的 typed API 呼叫。後端見
 * apps/api/src/routes/{projects,project-documents}.ts。admin 與 ess 頁面共用。
 * 分潤可見性由後端依角色分流（GET /projects/:id/members 的 canManage）；前端
 * 只是照後端回傳渲染，不自行 gate。
 */
import { apiFetch } from "./api-client"

export type ShareMode = "pool_pct" | "fixed_amount"

export interface Project {
  id: string
  name: string
  /** 專案編號（識別碼，建立後不可變更）。 */
  code: string | null
  /** 歸屬年度（分析維度，可調整）。 */
  fiscalYear: number | null
  description: string | null
  status: string
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

/* --------------------------------------------------------------- projects -- */

export function listProjects() {
  return apiFetch<{ projects: Project[] }>("/projects")
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
    status?: "active" | "archived"
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

export async function uploadProjectDocument(projectId: string, file: File) {
  const dataBase64 = await fileToBase64(file)
  return apiFetch<{ id: string; sizeBytes: number }>(`/projects/${projectId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      dataBase64,
    }),
  })
}

export function deleteProjectDocument(projectId: string, docId: string) {
  return apiFetch<{ id: string }>(`/projects/${projectId}/documents/${docId}`, {
    method: "DELETE",
  })
}
