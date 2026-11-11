import { Router, type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { loadScope } from "./projects.js"
import { getVersion, listVersions, saveManualVersion } from "../services/application-versions.js"

/**
 * 專案申請單版本（2026-11-10，migration 0090）。建版邏輯與觸發點見 services/application-versions.ts。
 *
 *   GET  /projects/:id/application-versions          { available, currentVersionNo, versions: [meta…]（版號新→舊，不含 snapshot） }
 *   GET  /projects/:id/application-versions/:no      { version: { …meta, snapshot }, access }（snapshot ＝ /application 的 application 段）
 *   POST /projects/:id/application-versions          手動另存新版本 { note? } → 201 { version: { id, versionNo } }
 *
 * 權限：本案 finance（＝申請單檢視金額／編輯權限：HR／會計／老闆／本案經理、主辦／部門主管）；其他人 403。
 * 利潤／毛利率依讀者 profit 權限遮掉（同 GET /projects/:id）。tenant 隔離：別租戶的專案一律 404。
 * migration 未套用：列表 available=false、單版 404、手動另存 409 migration_required（不 500）。
 */
export const applicationVersionsRouter = Router()

const uuidSchema = z.string().uuid()
const createSchema = z.object({ note: z.string().trim().max(500).nullish() })

async function scopeOf(req: Request, res: Response) {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }
  const projectId = String(req.params.id)
  if (!uuidSchema.safeParse(projectId).success) {
    res.status(404).json({ error: "not_found" })
    return null
  }
  const scope = await loadScope(tenantId, userId, projectId)
  if (!scope.ok) {
    res.status(scope.status).json({ error: scope.error })
    return null
  }
  if (!scope.canManage) {
    res.status(403).json({ error: "forbidden" })
    return null
  }
  return { tenantId, projectId, scope }
}

applicationVersionsRouter.get(
  "/projects/:id/application-versions",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await scopeOf(req, res)
      if (!ctx) return
      const versions = await listVersions(ctx.tenantId, ctx.projectId)
      if (versions === null) {
        res.status(200).json({ available: false, currentVersionNo: null, versions: [] })
        return
      }
      res.status(200).json({ available: true, currentVersionNo: versions[0]?.versionNo ?? null, versions })
    } catch (err) {
      next(err)
    }
  },
)

applicationVersionsRouter.get(
  "/projects/:id/application-versions/:no",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = await scopeOf(req, res)
      if (!ctx) return
      const no = Number(req.params.no)
      if (!Number.isInteger(no) || no < 1) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const version = await getVersion(ctx.tenantId, ctx.projectId, no)
      if (!version) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const snapshot = version.snapshot
      const money =
        snapshot?.money && !ctx.scope.canSeeProfit ? { ...snapshot.money, profit: null, grossMarginPct: null } : (snapshot?.money ?? null)
      res.status(200).json({
        version: { ...version, snapshot: { ...snapshot, money } },
        access: { finance: true, profit: ctx.scope.canSeeProfit },
      })
    } catch (err) {
      next(err)
    }
  },
)

applicationVersionsRouter.post(
  "/projects/:id/application-versions",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const parsed = createSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const ctx = await scopeOf(req, res)
      if (!ctx) return
      const note = parsed.data.note?.trim() ? parsed.data.note.trim() : null
      const created = await saveManualVersion(ctx.tenantId, ctx.projectId, ctx.scope.self.id, note)
      if (created === null) {
        res.status(409).json({ error: "migration_required", table: "project_application_versions" })
        return
      }
      if (created === "not_found") {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(201).json({ version: created })
    } catch (err) {
      next(err)
    }
  },
)
