import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf, isHrRole, managedDeptIds } from "../middleware/scope.js"
import {
  DOC_TYPES,
  OUR_ROLES,
  STAMP_DUTY_FLAGS,
  DEFAULT_STAMP_DUTY_RATE,
  DEFAULT_LOOKBACK_YEARS,
  computeStampDuty,
  resolveStampDutyRequired,
  summarizeStampDuty,
  lookbackFrom,
  type StampDutyRow,
} from "../services/stamp-duty.js"
import { taipeiToday } from "../services/project-status.js"
import { recomputeBillings } from "../services/billing-store.js"

export const contractsRouter = Router()

// ⚠️ 單一字串常值，不可用 + 相接——supabase-js 從字串常值推列型別。
const CONTRACT_COLS =
  "id, tenant_id, project_id, doc_type, our_role, title, counterparty, amount, signed_on, version, supersedes_id, copies, stamp_duty_required, stamp_duty_rate, stamp_duty_amount, stamp_duty_paid_on, stamp_duty_note, created_by_emp_id, created_at, deleted_at"

type ContractRow = {
  id: string
  project_id: string
  doc_type: string
  our_role: string
  title: string
  counterparty: string | null
  amount: string | null
  signed_on: string | null
  version: number
  supersedes_id: string | null
  copies: number
  stamp_duty_required: string
  stamp_duty_rate: string | null
  stamp_duty_amount: string | null
  stamp_duty_paid_on: string | null
  stamp_duty_note: string | null
  created_at: string
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const createSchema = z.object({
  docType: z.enum(DOC_TYPES),
  ourRole: z.enum(OUR_ROLES).optional(),
  title: z.string().trim().min(1).max(200),
  counterparty: z.string().trim().max(200).nullish(),
  /** 追加減帳可以是負數（減帳）。 */
  amount: z.number().nullish(),
  signedOn: z.string().regex(dateRe).nullish(),
  copies: z.number().int().min(1).max(50).optional(),
  supersedesId: z.string().uuid().nullish(),
  stampDutyRequired: z.enum(STAMP_DUTY_FLAGS).optional(),
  /** 補登舊約時指定當年度費率——費率凍結在列上，不查當下設定。 */
  stampDutyRate: z.number().min(0).max(1).nullish(),
  stampDutyPaidOn: z.string().regex(dateRe).nullish(),
  stampDutyNote: z.string().trim().max(2000).nullish(),
})

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    counterparty: z.string().trim().max(200).nullable().optional(),
    amount: z.number().nullable().optional(),
    signedOn: z.string().regex(dateRe).nullable().optional(),
    copies: z.number().int().min(1).max(50).optional(),
    // B1：貼花方式（我方貼／對方貼／各自貼）常常是簽約後才確認，開放可改；
    // 下面 touchesDuty 會連同稅額一起重算，不會留下舊結論。
    ourRole: z.enum(OUR_ROLES).optional(),
    stampDutyRequired: z.enum(STAMP_DUTY_FLAGS).optional(),
    stampDutyRate: z.number().min(0).max(1).nullable().optional(),
    stampDutyPaidOn: z.string().regex(dateRe).nullable().optional(),
    stampDutyNote: z.string().trim().max(2000).nullable().optional(),
    // docType 刻意不可改：決定課不課稅的文件分類（契據／報價單），改了等於
    // 把契據冒充報價單（或反過來）。要改請作廢後重立一件。
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const deleteSchema = z.object({
  reason: z.string().trim().min(1).max(500),
})

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function serialize(row: ContractRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    docType: row.doc_type,
    ourRole: row.our_role,
    title: row.title,
    counterparty: row.counterparty,
    amount: num(row.amount),
    signedOn: row.signed_on,
    version: row.version,
    supersedesId: row.supersedes_id,
    copies: row.copies,
    stampDutyRequired: row.stamp_duty_required,
    stampDutyRate: num(row.stamp_duty_rate),
    stampDutyAmount: num(row.stamp_duty_amount),
    stampDutyPaidOn: row.stamp_duty_paid_on,
    stampDutyNote: row.stamp_duty_note,
    createdAt: row.created_at,
    /** 衍生：依 docType + ourRole + 人工覆寫判定的最終結論。 */
    dutiable: resolveStampDutyRequired({
      docType: row.doc_type,
      ourRole: row.our_role,
      flag: row.stamp_duty_required,
    }),
  }
}

/** 專案存在與否 + 管理權（比照 projects.ts 的 canManage）。 */
async function loadProjectScope(tenantId: string, userId: string, projectId: string) {
  const self = await resolveSelf(tenantId, userId)
  if (!self) return { ok: false as const, status: 403, error: "forbidden" }

  const { data: proj, error } = await supabaseAdmin
    .from("projects")
    .select("id, dept_id, lead_emp_id")
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`contracts loadProjectScope: ${error.message}`)
  if (!proj) return { ok: false as const, status: 404, error: "not_found" }

  let canManage = isHrRole(self.role) || proj.lead_emp_id === self.id
  if (!canManage && proj.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(proj.dept_id)) canManage = true
  }
  return { ok: true as const, self, canManage }
}

/** 租戶的印花稅預設值（新建合約時用）。沒有設定列就回內建預設。 */
async function tenantStampDutyDefaults(tenantId: string) {
  const { data, error } = await supabaseAdmin
    .from("project_settings")
    .select("stamp_duty_rate, stamp_duty_lookback_years")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`tenantStampDutyDefaults: ${error.message}`)
  return {
    rate: data ? Number(data.stamp_duty_rate) : DEFAULT_STAMP_DUTY_RATE,
    lookbackYears: data ? Number(data.stamp_duty_lookback_years) : DEFAULT_LOOKBACK_YEARS,
  }
}

// ── GET /projects/:id/contracts ───────────────────────────────────────
contractsRouter.get(
  "/projects/:id/contracts",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("contracts")
        .select(CONTRACT_COLS)
        .eq("tenant_id", tenantId)
        .eq("project_id", req.params.id as string)
        .is("deleted_at", null)
        .order("signed_on", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /projects/${req.params.id}/contracts: ${error.message}`))
        return
      }
      res.status(200).json({ contracts: (data ?? []).map((r) => serialize(r as ContractRow)) })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects/:id/contracts ──────────────────────────────────────
contractsRouter.post(
  "/projects/:id/contracts",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = createSchema.safeParse(req.body)
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
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const b = parsed.data
      const ourRole = b.ourRole ?? "contractor"
      const flag = b.stampDutyRequired ?? "auto"
      const dutiable = resolveStampDutyRequired({ docType: b.docType, ourRole, flag })

      // 費率凍結：取 body 指定值（補登舊約），否則取租戶當下設定。
      const defaults = await tenantStampDutyDefaults(tenantId)
      const rate = b.stampDutyRate ?? defaults.rate
      const copies = b.copies ?? 1
      const duty = dutiable ? computeStampDuty({ amount: b.amount ?? null, rate, copies }) : null

      const { data, error } = await supabaseAdmin
        .from("contracts")
        .insert({
          tenant_id: tenantId,
          project_id: req.params.id,
          doc_type: b.docType,
          our_role: ourRole,
          title: b.title,
          counterparty: b.counterparty ?? null,
          amount: b.amount ?? null,
          signed_on: b.signedOn ?? null,
          copies,
          supersedes_id: b.supersedesId ?? null,
          // 改版：新列的 version = 被取代那列 + 1。
          version: b.supersedesId ? await nextVersion(tenantId, b.supersedesId) : 1,
          stamp_duty_required: flag,
          // 不應貼花就不存費率，免得清單誤以為算過。
          stamp_duty_rate: dutiable ? rate : null,
          stamp_duty_amount: duty,
          stamp_duty_paid_on: b.stampDutyPaidOn ?? null,
          stamp_duty_note: b.stampDutyNote ?? null,
          created_by_emp_id: scope.self.id,
        })
        .select(CONTRACT_COLS)
        .single()
      if (error || !data) {
        next(new Error(`POST /projects/${req.params.id}/contracts: ${error?.message}`))
        return
      }
      // 合約金額是分期請款的分母（模組四第 4 條）。新增／追加後期程就過時了，
      // 這裡重算，否則使用者要自己回去按一次存檔才會更新。
      await recomputeBillings(tenantId, req.params.id as string)
      res.status(201).json({ contract: serialize(data as ContractRow) })
    } catch (err) {
      next(err)
    }
  },
)

async function nextVersion(tenantId: string, supersedesId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("contracts")
    .select("version")
    .eq("tenant_id", tenantId)
    .eq("id", supersedesId)
    .maybeSingle()
  return data ? Number(data.version) + 1 : 1
}

// ── PATCH /contracts/:id ──────────────────────────────────────────────
contractsRouter.patch(
  "/contracts/:id",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const { data: current, error: loadError } = await supabaseAdmin
        .from("contracts")
        .select(CONTRACT_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id as string)
        .is("deleted_at", null)
        .maybeSingle()
      if (loadError) {
        next(new Error(`PATCH /contracts/${req.params.id}: ${loadError.message}`))
        return
      }
      if (!current) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const row = current as ContractRow
      const scope = await loadProjectScope(tenantId, userId, row.project_id)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const b = parsed.data
      const patch: Record<string, unknown> = {}
      if (b.title !== undefined) patch.title = b.title
      if (b.counterparty !== undefined) patch.counterparty = b.counterparty
      if (b.amount !== undefined) patch.amount = b.amount
      if (b.signedOn !== undefined) patch.signed_on = b.signedOn
      if (b.copies !== undefined) patch.copies = b.copies
      if (b.ourRole !== undefined) patch.our_role = b.ourRole
      if (b.stampDutyRequired !== undefined) patch.stamp_duty_required = b.stampDutyRequired
      if (b.stampDutyRate !== undefined) patch.stamp_duty_rate = b.stampDutyRate
      if (b.stampDutyPaidOn !== undefined) patch.stamp_duty_paid_on = b.stampDutyPaidOn
      if (b.stampDutyNote !== undefined) patch.stamp_duty_note = b.stampDutyNote

      // 金額／份數／費率／應貼花旗標／我方角色任一改動，稅額就要重算——
      // 否則清單會拿舊的凍結值，跟合約上的金額或貼花方式對不起來。
      const touchesDuty =
        b.amount !== undefined ||
        b.copies !== undefined ||
        b.stampDutyRate !== undefined ||
        b.stampDutyRequired !== undefined ||
        b.ourRole !== undefined
      if (touchesDuty) {
        const flag = b.stampDutyRequired ?? row.stamp_duty_required
        const ourRole = b.ourRole ?? row.our_role
        const dutiable = resolveStampDutyRequired({
          docType: row.doc_type,
          ourRole,
          flag,
        })
        // 重算用**列上凍結的費率**，不抓當下設定：本件適用的是簽約當年度
        // 的費率，不是今天的。要改費率就明確帶 stampDutyRate。
        const rate = b.stampDutyRate ?? num(row.stamp_duty_rate) ?? DEFAULT_STAMP_DUTY_RATE
        const amount = b.amount !== undefined ? b.amount : num(row.amount)
        const copies = b.copies ?? row.copies
        patch.stamp_duty_rate = dutiable ? rate : null
        patch.stamp_duty_amount = dutiable ? computeStampDuty({ amount, rate, copies }) : null
      }

      const { data, error } = await supabaseAdmin
        .from("contracts")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
        .select(CONTRACT_COLS)
        .single()
      if (error || !data) {
        next(new Error(`PATCH /contracts/${req.params.id}: ${error?.message}`))
        return
      }
      if (b.amount !== undefined) await recomputeBillings(tenantId, row.project_id)
      res.status(200).json({ contract: serialize(data as ContractRow) })
    } catch (err) {
      next(err)
    }
  },
)

// ── DELETE /contracts/:id — 軟刪除，必填理由 ─────────────────────────
contractsRouter.delete(
  "/contracts/:id",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = deleteSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required" })
      return
    }
    try {
      const { data: current } = await supabaseAdmin
        .from("contracts")
        .select("id, project_id, deleted_at")
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id as string)
        .maybeSingle()
      if (!current) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (current.deleted_at) {
        res.status(409).json({ error: "already_deleted" })
        return
      }
      const scope = await loadProjectScope(tenantId, userId, current.project_id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      // 金額憑證不實體刪除（sql/0018 同一套理由）——已貼花的合約更是如此，
      // 刪掉等於把「這筆稅貼過了」的證據一起刪掉。
      const { error } = await supabaseAdmin
        .from("contracts")
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_emp_id: scope.self.id,
          delete_reason: parsed.data.reason,
        })
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
      if (error) {
        next(new Error(`DELETE /contracts/${req.params.id}: ${error.message}`))
        return
      }
      await recomputeBillings(tenantId, current.project_id as string)
      res.status(200).json({ id: req.params.id })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /reports/stamp-duty — 印花稅計算與申報備查清單 ────────────────
const reportSchema = z.object({
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
  /** 只看未貼花的。清單真正的用途。 */
  unpaidOnly: z.enum(["0", "1"]).optional(),
})

contractsRouter.get(
  "/reports/stamp-duty",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = reportSchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    try {
      const defaults = await tenantStampDutyDefaults(tenantId)
      const today = taipeiToday()
      const from = parsed.data.from ?? lookbackFrom(today, defaults.lookbackYears)
      const to = parsed.data.to ?? today

      // 未簽訂日期的列不進清單：沒有簽訂日就不成立「書立憑證」的時點，
      // 也就無從判斷落在哪個核課期間內。它們另外用 missingSignedOn 回報。
      const { data, error } = await supabaseAdmin
        .from("contracts")
        .select(
          "id, project_id, doc_type, our_role, title, counterparty, amount, signed_on, copies, stamp_duty_required, stamp_duty_rate, stamp_duty_amount, stamp_duty_paid_on, stamp_duty_note, projects(name, code)",
        )
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .gte("signed_on", from)
        .lte("signed_on", to)
        .order("signed_on", { ascending: false })
      if (error) {
        next(new Error(`GET /reports/stamp-duty: ${error.message}`))
        return
      }

      const raw = (data ?? []) as unknown as Array<Record<string, unknown>>
      const summary = summarizeStampDuty(raw as unknown as StampDutyRow[])

      let items = raw.map((r) => {
        const proj = r.projects as { name?: string; code?: string } | null
        const dutiable = resolveStampDutyRequired({
          docType: r.doc_type as string,
          ourRole: r.our_role as string,
          flag: r.stamp_duty_required as string,
        })
        return {
          id: r.id as string,
          projectId: r.project_id as string,
          projectName: proj?.name ?? null,
          projectCode: proj?.code ?? null,
          docType: r.doc_type as string,
          ourRole: r.our_role as string,
          title: r.title as string,
          counterparty: (r.counterparty as string | null) ?? null,
          amount: num(r.amount as string | null),
          signedOn: r.signed_on as string | null,
          copies: Number(r.copies ?? 1),
          dutiable,
          stampDutyRate: num(r.stamp_duty_rate as string | null),
          stampDutyAmount: num(r.stamp_duty_amount as string | null),
          stampDutyPaidOn: (r.stamp_duty_paid_on as string | null) ?? null,
          stampDutyNote: (r.stamp_duty_note as string | null) ?? null,
        }
      })
      if (parsed.data.unpaidOnly === "1") {
        items = items.filter((i) => i.dutiable && !i.stampDutyPaidOn)
      }

      // 應貼花卻沒有簽訂日的合約：它們不在期間查詢裡，但正是最該被追的。
      // our_role 包含 both——雙重身分我方仍須貼，漏掉會讓這格靜默低估。
      const { count: missingSignedOn } = await supabaseAdmin
        .from("contracts")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .is("signed_on", null)
        .in("our_role", ["contractor", "both"])
        .in("doc_type", ["contract", "change_order"])

      res.status(200).json({
        range: { from, to, lookbackYears: defaults.lookbackYears },
        summary: { ...summary, missingSignedOn: missingSignedOn ?? 0 },
        items,
        // 系統不報稅：這是試算與清單，不是申報值。
        disclaimer:
          "本清單為系統試算，非申報值。承攬契據認定、單價契約金額、繕寫份數、彙總繳納與免稅憑證請會計師確認。",
      })
    } catch (err) {
      next(err)
    }
  },
)
