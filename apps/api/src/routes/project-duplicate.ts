import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { loadProjectScope } from "../services/project-scope.js"
import { writeAuditLog } from "../services/audit.js"
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
 * 權限：對該案有 finance 權限的人（HR／會計／該案 lead 或 manager／所屬部門主管，
 * services/project-scope.ts）——複製會建合約與期程，跟能新增合約的是同一群人。
 * 變更歷史（lineage）全員可讀，但合約總額只給 finance。
 *
 * M23（2026-09-23）：封存原案**不再限 HR**。原本非 HR 會被強制改成不封存並回
 * `warnings:['archive_requires_hr']`，留下「原案與新案同時有效」的縫——年度總帳
 * 會把同一份合約採計兩次，而真正會去複製的就是專案負責人。現在 finance 使用者
 * 一律照 `archiveOriginal`（預設 true）執行，並另寫一筆 audit 記下是誰封的。
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
      // M23：封存原案不再限 HR——有 finance 權限就能複製，也就該能把被取代的原案收起來。
      // `warnings` 保留在回應裡（型別不變，前端不必改），只是現在永遠是空陣列。
      const archiveOriginal = b.archiveOriginal ?? true
      const warnings: string[] = []
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
      // 誰在什麼時候把原案封掉：duplicateProject 內部已對 projects 寫一筆 UPDATE 稽核，
      // 這裡再記一筆「這個動作是由誰、用什麼理由觸發的」——非 HR 也能封存之後，
      // 「原案為什麼不見了」要查得到人。
      if (result.archived) {
        await writeAuditLog({
          tenantId,
          tableName: "projects",
          recordId: result.archived.id,
          action: "UPDATE",
          newRow: {
            archived_by_duplicate: result.project.id,
            replaced_by_code: result.project.code,
            reason: b.reason,
            actor_role: scope.self.role,
          },
          actorEmpId: scope.self.id,
          context: "POST /projects/:id/duplicate (archive original)",
        })
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
