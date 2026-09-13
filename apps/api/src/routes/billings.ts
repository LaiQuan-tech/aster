import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf, isHrRole, managedDeptIds } from "../middleware/scope.js"
import { computeInstallments } from "../services/billing-schedule.js"
import {
  BILLING_COLS,
  contractTotal,
  loadBillings,
  recomputeBillings,
  toInput,
  num,
  type BillingRow,
} from "../services/billing-store.js"
import { taipeiToday } from "../services/project-status.js"

export const billingsRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const installmentSchema = z.object({
  /** 既有期別帶 id；新增的不帶。 */
  id: z.string().uuid().optional(),
  installmentNo: z.number().int().min(1).max(999),
  percentage: z.number().min(0).max(100).nullish(),
  milestone: z.string().trim().max(200).nullish(),
  plannedOn: z.string().regex(dateRe).nullish(),
  overrideAmount: z.number().nullish(),
  overrideReason: z.string().trim().max(1000).nullish(),
  note: z.string().trim().max(1000).nullish(),
})

const saveSchema = z.object({
  installments: z.array(installmentSchema).max(100),
})

const billSchema = z.object({
  billedOn: z.string().regex(dateRe).optional(),
  /** 省略時取試算／覆寫金額。實際請款金額與試算不同時要明確帶。 */
  billedAmount: z.number().nullish(),
})

const unbillSchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

async function loadScope(tenantId: string, userId: string, projectId: string) {
  const self = await resolveSelf(tenantId, userId)
  if (!self) return { ok: false as const, status: 403, error: "forbidden" }
  const { data: proj, error } = await supabaseAdmin
    .from("projects")
    .select("id, dept_id, lead_emp_id")
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`billings loadScope: ${error.message}`)
  if (!proj) return { ok: false as const, status: 404, error: "not_found" }

  let canManage = isHrRole(self.role) || proj.lead_emp_id === self.id
  if (!canManage && proj.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(proj.dept_id)) canManage = true
  }
  return { ok: true as const, self, canManage }
}

function serialize(row: BillingRow) {
  return {
    id: row.id,
    installmentNo: row.installment_no,
    percentage: num(row.percentage),
    milestone: row.milestone,
    plannedOn: row.planned_on,
    calculatedAmount: num(row.calculated_amount),
    residueApplied: num(row.residue_applied) ?? 0,
    overrideAmount: num(row.override_amount),
    overrideReason: row.override_reason,
    billedOn: row.billed_on,
    billedAmount: num(row.billed_amount),
    note: row.note,
    /** 有效金額 = 已請款 ?? 人工覆寫 ?? 試算。UI 顯示這個。 */
    effectiveAmount:
      row.billed_on !== null
        ? num(row.billed_amount)
        : (num(row.override_amount) ?? num(row.calculated_amount)),
  }
}

async function respondSchedule(
  tenantId: string,
  projectId: string,
  res: Response,
  status = 200,
) {
  const [{ total, base, changeOrders }, rows] = await Promise.all([
    contractTotal(tenantId, projectId),
    loadBillings(tenantId, projectId),
  ])
  const result = computeInstallments(rows.map(toInput), total)
  const installments = rows.map(serialize)
  const billedTotal = installments.reduce((s, r) => s + (r.billedAmount ?? 0), 0)

  res.status(status).json({
    // 分母的組成攤開顯示，不藏起來——看不到組成就會有人去試算表對帳。
    contract: { total, base, changeOrders },
    installments,
    summary: {
      percentageTotal: result.percentageTotal,
      effectiveTotal: result.effectiveTotal,
      /** 尾差沒地方放時的餘額。非 0 代表所有期別都已請款或已覆寫。 */
      unallocatedResidue: result.unallocatedResidue,
      billedTotal,
      /** 尚未請款的有效金額合計。 */
      unbilledTotal: result.effectiveTotal - billedTotal,
    },
  })
}

// ── GET /projects/:id/billings ────────────────────────────────────────
billingsRouter.get(
  "/projects/:id/billings",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      await respondSchedule(tenantId, req.params.id as string, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /projects/:id/billings — 整批存期程 ───────────────────────────
/**
 * 整批存而不是逐筆 CRUD：改一期的百分比會牽動尾差落點，逐筆存會讓
 * 中間狀態出現「合計不等於合約金額」的假象。整批存一次算完。
 *
 * 語意：
 *   • 有 id → 更新
 *   • 無 id → 新增
 *   • 既有列不在 payload 裡 → 軟刪除；**已請款的不可移除**（409）
 */
billingsRouter.put(
  "/projects/:id/billings",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const projectId = req.params.id as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = saveSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadScope(tenantId, userId, projectId)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const payload = parsed.data.installments
      const seen = new Set<number>()
      for (const item of payload) {
        if (seen.has(item.installmentNo)) {
          res.status(400).json({ error: "duplicate_installment_no", installmentNo: item.installmentNo })
          return
        }
        seen.add(item.installmentNo)
        // 人工覆寫必須說明理由——偏離期程的金額是談出來的，要留得下痕跡。
        if (item.overrideAmount !== null && item.overrideAmount !== undefined && !item.overrideReason) {
          res.status(400).json({ error: "override_reason_required", installmentNo: item.installmentNo })
          return
        }
      }

      const existing = await loadBillings(tenantId, projectId)
      const keepIds = new Set(payload.map((p) => p.id).filter(Boolean) as string[])

      // 已請款的期別不可移除：帳已經出去了，移掉等於讓那筆請款憑空消失。
      const removing = existing.filter((r) => !keepIds.has(r.id))
      const billedRemoval = removing.find((r) => r.billed_on !== null)
      if (billedRemoval) {
        res.status(409).json({
          error: "billed_installment_not_removable",
          installmentNo: billedRemoval.installment_no,
        })
        return
      }

      // 先軟刪除要移除的，避免期別編號與新增的相撞。
      for (const row of removing) {
        await supabaseAdmin
          .from("project_billings")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by_emp_id: scope.self.id,
            delete_reason: "期程調整",
          })
          .eq("tenant_id", tenantId)
          .eq("id", row.id)
      }

      for (const item of payload) {
        const fields = {
          percentage: item.percentage ?? null,
          milestone: item.milestone ?? null,
          planned_on: item.plannedOn ?? null,
          override_amount: item.overrideAmount ?? null,
          override_reason: item.overrideReason ?? null,
          note: item.note ?? null,
        }
        if (item.id) {
          await supabaseAdmin
            .from("project_billings")
            .update({ ...fields, installment_no: item.installmentNo })
            .eq("tenant_id", tenantId)
            .eq("id", item.id)
        } else {
          const { error } = await supabaseAdmin.from("project_billings").insert({
            tenant_id: tenantId,
            project_id: projectId,
            installment_no: item.installmentNo,
            ...fields,
            created_by_emp_id: scope.self.id,
          })
          if (error) {
            if (error.code === "23505") {
              res.status(409).json({ error: "installment_no_taken", installmentNo: item.installmentNo })
              return
            }
            next(new Error(`PUT /projects/${projectId}/billings: ${error.message}`))
            return
          }
        }
      }

      await recomputeBillings(tenantId, projectId)
      await respondSchedule(tenantId, projectId, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /billings/:id/bill — 標記已請款（金額凍結） ──────────────────
billingsRouter.post(
  "/billings/:id/bill",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = billSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const { data: current } = await supabaseAdmin
        .from("project_billings")
        .select(BILLING_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id as string)
        .is("deleted_at", null)
        .maybeSingle()
      if (!current) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const row = current as BillingRow
      if (row.billed_on) {
        res.status(409).json({ error: "already_billed" })
        return
      }
      const scope = await loadScope(tenantId, userId, row.project_id)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      // 沒帶金額就用目前的有效金額（覆寫 ?? 試算）。**凍結在這一刻**——
      // 之後追加減帳改變分母，這一期不再跟著變。
      const fallback = num(row.override_amount) ?? num(row.calculated_amount)
      const billedAmount = parsed.data.billedAmount ?? fallback
      if (billedAmount === null) {
        // 沒有合約就算不出金額，硬記一筆 0 元請款是錯的。
        res.status(400).json({ error: "amount_unknown" })
        return
      }

      const { error } = await supabaseAdmin
        .from("project_billings")
        .update({
          billed_on: parsed.data.billedOn ?? taipeiToday(),
          billed_amount: billedAmount,
        })
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/bill: ${error.message}`))
        return
      }
      // 這一期凍結後，尾差要改落到下一個未請款的期別。
      await recomputeBillings(tenantId, row.project_id)
      await respondSchedule(tenantId, row.project_id, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /billings/:id/unbill — 取消請款標記，必填理由 ────────────────
billingsRouter.post(
  "/billings/:id/unbill",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = unbillSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required" })
      return
    }
    try {
      const { data: current } = await supabaseAdmin
        .from("project_billings")
        .select(BILLING_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id as string)
        .is("deleted_at", null)
        .maybeSingle()
      if (!current) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const row = current as BillingRow
      if (!row.billed_on) {
        res.status(409).json({ error: "not_billed" })
        return
      }
      const scope = await loadScope(tenantId, userId, row.project_id)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      // 取消請款是在撤銷一個金流事件，理由附在備註後面——
      // 欄位本身被清掉，稽核 trigger 留得住舊值，但人要看得到原因。
      const note = [row.note, `取消請款（原 ${row.billed_on}）：${parsed.data.reason}`]
        .filter(Boolean)
        .join("\n")

      const { error } = await supabaseAdmin
        .from("project_billings")
        .update({ billed_on: null, billed_amount: null, note })
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`POST /billings/${req.params.id}/unbill: ${error.message}`))
        return
      }
      await recomputeBillings(tenantId, row.project_id)
      await respondSchedule(tenantId, row.project_id, res)
    } catch (err) {
      next(err)
    }
  },
)
