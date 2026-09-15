import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { loadProjectScope } from "../services/project-scope.js"
import { isHrRole } from "../middleware/scope.js"
import {
  duplicateProject,
  loadLineage,
  DUPLICATE_KINDS,
  DEFAULT_COPY_OPTIONS,
} from "../services/project-duplicate.js"

export const projectDuplicateRouter = Router()

/**
 * C2 複製專案（追加減／加做）＋變更歷史。邏輯全在 services/project-duplicate.ts，
 * 這裡只做驗證、權限與搬運。
 *
 * 權限：HR，或對該案有 finance 權限的人（該案 lead／所屬部門主管，
 * services/project-scope.ts）——複製會建合約與期程，跟能新增合約的是同一群人。
 * 變更歷史（lineage）全員可讀，但合約總額只給 finance。
 */

const copySchema = z.object({
  engineers: z.boolean().optional(),
  subcontracts: z.boolean().optional(),
  billings: z.boolean().optional(),
  members: z.boolean().optional(),
})

const duplicateSchema = z.object({
  kind: z.enum(DUPLICATE_KINDS),
  /** 新案的合約金額（未稅）。追加減帳可以是 0（純結構變更），但不收負數——減帳請直接在原案開負數 change_order。 */
  amount: z.number().nonnegative().max(1e12),
  reason: z.string().trim().min(1).max(2000),
  /** 預設封存原案；demo／保留舊案時帶 false。 */
  archiveOriginal: z.boolean().optional(),
  copy: copySchema.optional(),
})

// ── POST /projects/:id/duplicate ─────────────────────────────────────
projectDuplicateRouter.post(
  "/projects/:id/duplicate",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = duplicateSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadProjectScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.finance) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const b = parsed.data
      const tz = await getTenantTimezone(tenantId)
      // 封存原案只有 HR 能做（C2 驗收）：封存會讓原案從列表消失，finance lead／部門主管
      // 只該有「複製」的權限，不該順手把原案藏起來。非 HR 一律強制不封存並回 warnings，
      // 讓前端提示「原案未封存，請 HR 處理」；預設值（HR）仍是封存。
      const wantsArchive = b.archiveOriginal ?? true
      const canArchive = isHrRole(scope.self.role)
      const archiveOriginal = wantsArchive && canArchive
      const warnings: string[] = []
      if (wantsArchive && !canArchive) warnings.push("archive_requires_hr")
      const result = await duplicateProject({
        tenantId,
        sourceProjectId: scope.project.id,
        actorEmpId: scope.self.id,
        kind: b.kind,
        amount: b.amount,
        reason: b.reason,
        archiveOriginal,
        copy: { ...DEFAULT_COPY_OPTIONS, ...(b.copy ?? {}) },
        openedOn: todayKey(tz),
      })
      if (!result.ok) {
        res.status(result.status).json({ error: result.error })
        return
      }
      res.status(201).json({ project: result.project, archived: result.archived, warnings })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /projects/:id/lineage — 根案＋所有同源後代，依編號排 ─────────
projectDuplicateRouter.get(
  "/projects/:id/lineage",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const scope = await loadProjectScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      const lineage = await loadLineage(tenantId, scope.project.id, { finance: scope.finance })
      if (!lineage) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({
        projectId: scope.project.id,
        rootId: lineage.rootId,
        finance: scope.finance,
        projects: lineage.projects,
      })
    } catch (err) {
      next(err)
    }
  },
)
