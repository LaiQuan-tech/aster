import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { loadProjectScope, resolveBonusEditAccess } from "../services/project-scope.js"
import { recomputeDraftRunsAfterWrite } from "../services/project-bonus-recompute.js"
import { estimateProjectBonus } from "../services/bonus-estimate.js"
import { isHrRole } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
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
  /** 原案還有未發放的獎金時仍要複製並封存——只有老闆（或 platform_admin）可以帶，會寫稽核。 */
  force: z.boolean().optional(),
})

export type UnpaidBonusMember = {
  employeeId: string
  name: string | null
  estimatedAmount: number
  paidAmount: number
  unpaidAmount: number
}

/**
 * 驗收 #8（2026-10-26）：原案「累計應得 > 已發」的成員（估算服務判斷）。原案一封存，封存規則可能
 * 讓它不再進批次，這筆錢就發不出去——所以複製並封存前要先擋下。
 * 估算失敗回 null（呼叫端：要封存原案就 409 bonus_check_unavailable，不封存照常），並記 log。
 */
export async function unpaidBonusOf(
  tenantId: string,
  projectId: string,
): Promise<{ total: number; members: UnpaidBonusMember[] } | null> {
  let est
  try {
    est = (await estimateProjectBonus(tenantId, [projectId]))[0]
  } catch (err) {
    console.warn(`[duplicate] 估算原案 ${projectId} 未發獎金失敗`, err)
    return null
  }
  if (!est) return { total: 0, members: [] }
  const owed = est.members
    .map((m) => ({ ...m, unpaidAmount: Math.max(0, Math.round(m.estimatedAmount - m.paidAmount)) }))
    .filter((m) => m.unpaidAmount > 0)
  if (owed.length === 0) return { total: 0, members: [] }
  const { data: emps } = await supabaseAdmin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", owed.map((m) => m.employeeId))
  const nameOf = new Map((emps ?? []).map((e) => [e.id as string, (e.name as string | null) ?? null]))
  const members = owed.map((m) => ({
    employeeId: m.employeeId,
    name: nameOf.get(m.employeeId) ?? null,
    estimatedAmount: m.estimatedAmount,
    paidAmount: m.paidAmount,
    unpaidAmount: m.unpaidAmount,
  }))
  return { total: members.reduce((sum, m) => sum + m.unpaidAmount, 0), members }
}

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
      const bonusEdit = await resolveBonusEditAccess(tenantId, scope.self)

      // 驗收 #8：原案還有「累計應得 > 已發」→ 封存前擋下（409），提示先發放原案獎金；老闆可 force。
      let forcedUnpaid: { total: number; members: UnpaidBonusMember[] } | null = null
      let forcedUnchecked = false
      if (archiveOriginal) {
        const unpaid = await unpaidBonusOf(tenantId, scope.project.id)
        if (!unpaid) {
          // 估算失敗＝無法確認原案獎金已發清：要封存就擋下（驗收 2026-10-26），老闆可 force。
          if (!b.force) {
            res.status(409).json({
              error: "bonus_check_unavailable",
              hint: "暫時無法確認原案獎金是否已發清。請改選「不封存原案」，或由老闆強制複製並封存。",
              canForce: bonusEdit.canEdit,
            })
            return
          }
          if (bonusEdit.denial) {
            res.status(bonusEdit.denial.status).json({ error: bonusEdit.denial.error })
            return
          }
          forcedUnchecked = true
        } else if (unpaid.total > 0) {
          if (!b.force) {
            // 金額明細是分潤資料：只給老闆與 HR；其他 finance 使用者（會計、負責人）只看到有幾位未發。
            const canSeeAmounts = bonusEdit.canEdit || isHrRole(scope.self.role)
            res.status(409).json({
              error: "original_has_unpaid_bonus",
              hint: "原案還有未發放的獎金，請先發放原案獎金再複製並封存；或改為不封存原案。",
              unpaidCount: unpaid.members.length,
              ...(canSeeAmounts ? { unpaidTotal: unpaid.total, unpaid: unpaid.members } : {}),
              canForce: bonusEdit.canEdit,
            })
            return
          }
          if (bonusEdit.denial) {
            res.status(bonusEdit.denial.status).json({ error: bonusEdit.denial.error })
            return
          }
          forcedUnpaid = unpaid
        }
      }
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
        // 分潤改版 #6：只有老闆（或 platform_admin）複製時才照抄成員趴數，其他人複製 → 趴數 0。
        copyMemberSharePct: bonusEdit.canEdit,
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
      if (forcedUnchecked) {
        await writeAuditLog({
          tenantId,
          tableName: "projects",
          recordId: scope.project.id,
          action: "UPDATE",
          newRow: {
            forced_duplicate_without_bonus_check: true,
            new_project_id: result.project.id,
            new_project_code: result.project.code,
            reason: b.reason,
          },
          actorEmpId: scope.self.id,
          context: "POST /projects/:id/duplicate (force: bonus check unavailable)",
        })
      }
      if (forcedUnpaid) {
        await writeAuditLog({
          tenantId,
          tableName: "projects",
          recordId: scope.project.id,
          action: "UPDATE",
          newRow: {
            forced_duplicate_with_unpaid_bonus: true,
            new_project_id: result.project.id,
            new_project_code: result.project.code,
            unpaid_total: forcedUnpaid.total,
            unpaid: forcedUnpaid.members.map((m) => ({ employee_id: m.employeeId, unpaid_amount: m.unpaidAmount })),
            reason: b.reason,
          },
          actorEmpId: scope.self.id,
          context: "POST /projects/:id/duplicate (force: original has unpaid bonus)",
        })
      }
      // 分潤改版 #3：追加減／加做成立 → 新案與原案（及其母案）的草稿獎金批次重算。
      await recomputeDraftRunsAfterWrite(
        tenantId,
        [result.project.id, scope.project.id, result.project.parentProjectId],
        "POST /projects/:id/duplicate",
      )
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
