import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import {
  nextProjectCode,
  isUniqueViolation,
  MAX_CODE_ATTEMPTS,
} from "../services/project-code.js"
import { resolveSelf, isHrRole, managedDeptIds } from "../middleware/scope.js"

export const projectsRouter = Router()

const PROJECT_COLS =
  "id, tenant_id, name, code, fiscal_year, description, status, dept_id, lead_emp_id, share_mode, bonus_pool, created_at"

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * 人工指定編號（匯入舊案用）。**省略時由系統產生**，見 services/project-code.ts。
   * 指定重複的編號會回 409，不會自動改號——人工指定就代表有意義，不該被系統改掉。
   */
  code: z.string().trim().min(1).max(60).nullish(),
  /** 歸屬年度（分析維度）。省略時預設為編號的年度，即建立年。 */
  fiscalYear: z.number().int().min(2000).max(2100).nullish(),
  description: z.string().trim().max(4000).nullish(),
  deptId: z.string().uuid().nullish(),
  leadEmpId: z.string().uuid().nullish(),
  shareMode: z.enum(["pool_pct", "fixed_amount"]).optional(),
  bonusPool: z.number().nonnegative().nullish(),
})

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    // `code` 刻意**不可經此端點變更**：編號是識別碼，會被印在合約、請款單、
    // 發票與往來文件上。要調整歸屬請改 `fiscalYear`，那是分析維度。
    // 帶了 code 會回 409，不是靜默忽略——靜默忽略會讓人以為改成功了。
    code: z.string().trim().min(1).max(60).nullable().optional(),
    fiscalYear: z.number().int().min(2000).max(2100).nullable().optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
    deptId: z.string().uuid().nullable().optional(),
    leadEmpId: z.string().uuid().nullable().optional(),
    shareMode: z.enum(["pool_pct", "fixed_amount"]).optional(),
    bonusPool: z.number().nonnegative().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const memberCreateSchema = z.object({
  employeeId: z.string().uuid(),
  roleInProject: z.enum(["member", "lead"]).optional(),
  sharePct: z.number().min(0).max(100).nullish(),
  shareAmount: z.number().nonnegative().nullish(),
})

const memberUpdateSchema = z
  .object({
    roleInProject: z.enum(["member", "lead"]).optional(),
    sharePct: z.number().min(0).max(100).nullable().optional(),
    shareAmount: z.number().nonnegative().nullable().optional(),
    reason: z.string().trim().max(250).optional(),
  })
  .refine((b) => Object.keys(b).some((k) => k !== "reason"), { message: "no fields to update" })

type ProjectRow = {
  id: string
  tenant_id: string
  name: string
  code: string | null
  fiscal_year: number | null
  description: string | null
  status: string
  dept_id: string | null
  lead_emp_id: string | null
  share_mode: string
  bonus_pool: string | null
  created_at: string
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Supabase 巢狀關聯（foreign table）在 to-one 時 runtime 回單一物件，但型別會被
 * 推成陣列。統一取第一筆（或物件本身）並收斂型別。
 */
function rel1<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] as T) ?? null
  return (v as T) ?? null
}

/** 依模式計算某成員的分潤金額（pool_pct: pool×pct/100；fixed_amount: shareAmount）。 */
function computeAmount(project: ProjectRow, pct: number | null, amount: number | null): number | null {
  if (project.share_mode === "pool_pct") {
    const pool = num(project.bonus_pool)
    if (pool === null || pct === null) return null
    return Math.round(pool * (pct / 100) * 100) / 100
  }
  return amount
}

/**
 * 載入專案並判定呼叫者對「分潤」的可見/可管理範圍。
 * canManage（＝可見全部分潤）＝ HR / 該專案 lead(欄位或成員角色) / 該專案所屬部門主管。
 */
async function loadScope(
  tenantId: string,
  userId: string,
  projectId: string,
): Promise<
  | { ok: true; self: { id: string; role: string }; project: ProjectRow; canManage: boolean }
  | { ok: false; status: number; error: string }
> {
  const self = await resolveSelf(tenantId, userId)
  if (!self) return { ok: false, status: 403, error: "forbidden" }

  const { data: proj, error } = await supabaseAdmin
    .from("projects")
    .select(PROJECT_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`loadScope: ${error.message}`)
  if (!proj) return { ok: false, status: 404, error: "not_found" }
  const project = proj as ProjectRow

  let canManage = isHrRole(self.role) || project.lead_emp_id === self.id
  if (!canManage && project.dept_id) {
    const managed = await managedDeptIds(tenantId, self.id)
    if (managed.includes(project.dept_id)) canManage = true
  }
  if (!canManage) {
    const { data: membership } = await supabaseAdmin
      .from("project_members")
      .select("role_in_project")
      .eq("tenant_id", tenantId)
      .eq("project_id", projectId)
      .eq("employee_id", self.id)
      .maybeSingle()
    if (membership?.role_in_project === "lead") canManage = true
  }
  return { ok: true, self: { id: self.id, role: self.role }, project, canManage }
}

// ── GET /projects — 全員列所有專案（資訊，不含分潤金額） ────────────────
projectsRouter.get(
  "/projects",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("projects")
        .select(PROJECT_COLS)
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /projects: ${error.message}`))
        return
      }
      const projects = (data ?? []).map((p) => {
        const row = p as ProjectRow
        return {
          id: row.id,
          name: row.name,
          code: row.code,
          fiscalYear: row.fiscal_year,
          description: row.description,
          status: row.status,
          deptId: row.dept_id,
          leadEmpId: row.lead_emp_id,
          shareMode: row.share_mode,
          bonusPool: num(row.bonus_pool),
          createdAt: row.created_at,
        }
      })
      res.status(200).json({ projects })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects — HR 建立專案 ──────────────────────────────────────
projectsRouter.post(
  "/projects",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const b = parsed.data
    try {
      // 編號的年度一律取**建立年**（見 services/project-code.ts 的說明）。
      const year = new Date().getFullYear()
      const manualCode = b.code ?? null

      const baseRow = {
        tenant_id: tenantId,
        name: b.name,
        fiscal_year: b.fiscalYear ?? year,
        description: b.description ?? null,
        dept_id: b.deptId ?? null,
        lead_emp_id: b.leadEmpId ?? null,
        share_mode: b.shareMode ?? "pool_pct",
        bonus_pool: b.bonusPool ?? null,
        status: "active",
      }

      // 人工指定編號：只試一次。撞號回 409——人工指定代表那個號有意義，
      // 不該被系統自動換掉。
      if (manualCode) {
        const { data, error } = await supabaseAdmin
          .from("projects")
          .insert({ ...baseRow, code: manualCode })
          .select("id, code")
          .single()
        if (error) {
          if (isUniqueViolation(error)) {
            res.status(409).json({ error: "code_taken", code: manualCode })
            return
          }
          next(new Error(`POST /projects: ${error.message}`))
          return
        }
        res.status(201).json({ id: data!.id, code: data!.code })
        return
      }

      // 系統產號：MAX(seq)+1 在併發時會撞號，unique index 是真正的保證，
      // 這裡碰到衝突就重算重試——讓 DB 當最後防線，不靠應用層搶。
      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        const code = await nextProjectCode(tenantId, year)
        const { data, error } = await supabaseAdmin
          .from("projects")
          .insert({ ...baseRow, code })
          .select("id, code")
          .single()
        if (!error) {
          res.status(201).json({ id: data!.id, code: data!.code })
          return
        }
        if (!isUniqueViolation(error)) {
          next(new Error(`POST /projects: ${error.message}`))
          return
        }
        // 撞號 → 下一圈重算
      }
      res.status(503).json({ error: "code_generation_failed", attempts: MAX_CODE_ATTEMPTS })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /projects/:id — 全員讀專案詳情 ────────────────────────────────
projectsRouter.get(
  "/projects/:id",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("projects")
        .select(PROJECT_COLS)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
        .maybeSingle()
      if (error) {
        next(new Error(`GET /projects/${req.params.id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const row = data as ProjectRow
      res.status(200).json({
        project: {
          id: row.id,
          name: row.name,
          code: row.code,
          fiscalYear: row.fiscal_year,
          description: row.description,
          status: row.status,
          deptId: row.dept_id,
          leadEmpId: row.lead_emp_id,
          shareMode: row.share_mode,
          bonusPool: num(row.bonus_pool),
          createdAt: row.created_at,
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

// ── PATCH /projects/:id — HR 或該專案 lead 編輯（改 pool 留痕） ─────────
projectsRouter.patch(
  "/projects/:id",
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
      const scope = await loadScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const b = parsed.data

      // 編號不可變更（模組四第 1 條）。回 409 而不是靜默忽略——靜默忽略
      // 會讓呼叫端以為改成功了，等到對帳才發現合約上的號跟系統裡的不同。
      // 要調整歸屬年度請改 `fiscalYear`。
      if (b.code !== undefined) {
        res.status(409).json({ error: "code_immutable", hint: "use fiscalYear" })
        return
      }

      const patch: Record<string, unknown> = {}
      if (b.name !== undefined) patch.name = b.name
      if (b.fiscalYear !== undefined) patch.fiscal_year = b.fiscalYear
      if (b.description !== undefined) patch.description = b.description
      if (b.status !== undefined) patch.status = b.status
      if (b.deptId !== undefined) patch.dept_id = b.deptId
      if (b.leadEmpId !== undefined) patch.lead_emp_id = b.leadEmpId
      if (b.shareMode !== undefined) patch.share_mode = b.shareMode
      if (b.bonusPool !== undefined) patch.bonus_pool = b.bonusPool

      const oldPool = num(scope.project.bonus_pool)
      const { data, error } = await supabaseAdmin
        .from("projects")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", req.params.id)
        .select("id")
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /projects/${req.params.id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      // 獎金池變動留痕（field='pool'）。
      if (b.bonusPool !== undefined && (b.bonusPool ?? null) !== oldPool) {
        await supabaseAdmin.from("project_share_adjustments").insert({
          tenant_id: tenantId,
          project_id: req.params.id,
          employee_id: null,
          field: "pool",
          old_value: oldPool,
          new_value: b.bonusPool ?? null,
          changed_by_emp_id: scope.self.id,
        })
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /projects/:id/members — 依角色分流回傳分潤 ─────────────────────
projectsRouter.get(
  "/projects/:id/members",
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
      const scope = await loadScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      let query = supabaseAdmin
        .from("project_members")
        .select("id, employee_id, role_in_project, share_pct, share_amount, created_at, employees(name, emp_no)")
        .eq("tenant_id", tenantId)
        .eq("project_id", req.params.id)
        .order("created_at", { ascending: true })
      // 非管理者（HR/lead/部門主管）只看自己那筆。
      if (!scope.canManage) query = query.eq("employee_id", scope.self.id)

      const { data, error } = await query
      if (error) {
        next(new Error(`GET /projects/${req.params.id}/members: ${error.message}`))
        return
      }
      const members = (data ?? []).map((m) => {
        const emp = rel1<{ name: string; emp_no: string | null }>(
          (m as { employees: unknown }).employees,
        )
        const pct = num(m.share_pct as string | null)
        const amount = num(m.share_amount as string | null)
        return {
          id: m.id,
          employeeId: m.employee_id,
          name: emp?.name ?? null,
          empNo: emp?.emp_no ?? null,
          roleInProject: m.role_in_project,
          sharePct: pct,
          shareAmount: amount,
          computedAmount: computeAmount(scope.project, pct, amount),
        }
      })
      res.status(200).json({
        canManage: scope.canManage,
        shareMode: scope.project.share_mode,
        bonusPool: num(scope.project.bonus_pool),
        members,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects/:id/members — HR/lead/部門主管 新增成員 ─────────────
projectsRouter.post(
  "/projects/:id/members",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = memberCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const b = parsed.data
      const { data, error } = await supabaseAdmin
        .from("project_members")
        .insert({
          tenant_id: tenantId,
          project_id: req.params.id,
          employee_id: b.employeeId,
          role_in_project: b.roleInProject ?? "member",
          share_pct: b.sharePct ?? null,
          share_amount: b.shareAmount ?? null,
        })
        .select("id")
        .single()
      if (error) {
        if (error.code === "23505") {
          res.status(409).json({ error: "already_member" })
          return
        }
        next(new Error(`POST /projects/${req.params.id}/members: ${error.message}`))
        return
      }
      // 初始分潤也留一筆稽核。
      await supabaseAdmin.from("project_share_adjustments").insert({
        tenant_id: tenantId,
        project_id: req.params.id,
        employee_id: b.employeeId,
        field: scope.project.share_mode === "pool_pct" ? "pct" : "amount",
        old_value: null,
        new_value: scope.project.share_mode === "pool_pct" ? b.sharePct ?? null : b.shareAmount ?? null,
        changed_by_emp_id: scope.self.id,
      })
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// ── PATCH /projects/:id/members/:memberId — 調整分潤（留痕） ───────────
projectsRouter.patch(
  "/projects/:id/members/:memberId",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = memberUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const { data: current, error: curErr } = await supabaseAdmin
        .from("project_members")
        .select("id, employee_id, share_pct, share_amount")
        .eq("tenant_id", tenantId)
        .eq("project_id", req.params.id)
        .eq("id", req.params.memberId)
        .maybeSingle()
      if (curErr) {
        next(new Error(`PATCH member (load): ${curErr.message}`))
        return
      }
      if (!current) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const b = parsed.data
      const patch: Record<string, unknown> = {}
      if (b.roleInProject !== undefined) patch.role_in_project = b.roleInProject
      if (b.sharePct !== undefined) patch.share_pct = b.sharePct
      if (b.shareAmount !== undefined) patch.share_amount = b.shareAmount

      const { data, error } = await supabaseAdmin
        .from("project_members")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("project_id", req.params.id)
        .eq("id", req.params.memberId)
        .select("id")
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH member: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }

      // 分潤異動留痕（pct / amount 各自比較）。
      const adjustments: Record<string, unknown>[] = []
      const oldPct = num(current.share_pct as string | null)
      const oldAmount = num(current.share_amount as string | null)
      if (b.sharePct !== undefined && (b.sharePct ?? null) !== oldPct) {
        adjustments.push({
          tenant_id: tenantId,
          project_id: req.params.id,
          employee_id: current.employee_id,
          field: "pct",
          old_value: oldPct,
          new_value: b.sharePct ?? null,
          reason: b.reason ?? null,
          changed_by_emp_id: scope.self.id,
        })
      }
      if (b.shareAmount !== undefined && (b.shareAmount ?? null) !== oldAmount) {
        adjustments.push({
          tenant_id: tenantId,
          project_id: req.params.id,
          employee_id: current.employee_id,
          field: "amount",
          old_value: oldAmount,
          new_value: b.shareAmount ?? null,
          reason: b.reason ?? null,
          changed_by_emp_id: scope.self.id,
        })
      }
      if (adjustments.length) await supabaseAdmin.from("project_share_adjustments").insert(adjustments)

      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// ── DELETE /projects/:id/members/:memberId — HR/lead/部門主管 移除 ─────
projectsRouter.delete(
  "/projects/:id/members/:memberId",
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
      const scope = await loadScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.canManage) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("project_members")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("project_id", req.params.id)
        .eq("id", req.params.memberId)
        .select("id")
        .maybeSingle()
      if (error) {
        next(new Error(`DELETE member: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /projects/:id/adjustments — 分潤異動史（同成員可見規則） ────────
projectsRouter.get(
  "/projects/:id/adjustments",
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
      const scope = await loadScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      let query = supabaseAdmin
        .from("project_share_adjustments")
        .select("id, employee_id, field, old_value, new_value, reason, changed_by_emp_id, created_at, employees(name)")
        .eq("tenant_id", tenantId)
        .eq("project_id", req.params.id)
        .order("created_at", { ascending: false })
      // 非管理者只看與自己相關的異動。
      if (!scope.canManage) query = query.eq("employee_id", scope.self.id)

      const { data, error } = await query
      if (error) {
        next(new Error(`GET /projects/${req.params.id}/adjustments: ${error.message}`))
        return
      }
      const adjustments = (data ?? []).map((a) => {
        const emp = rel1<{ name: string }>((a as { employees: unknown }).employees)
        return {
          id: a.id,
          employeeId: a.employee_id,
          name: emp?.name ?? null,
          field: a.field,
          oldValue: num(a.old_value as string | null),
          newValue: num(a.new_value as string | null),
          reason: a.reason,
          createdAt: a.created_at,
        }
      })
      res.status(200).json({ adjustments })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /my/project-shares — 員工跨專案彙整自己的分潤 ──────────────────
projectsRouter.get(
  "/my/project-shares",
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
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("project_members")
        .select(
          "id, project_id, role_in_project, share_pct, share_amount, projects(name, status, share_mode, bonus_pool)",
        )
        .eq("tenant_id", tenantId)
        .eq("employee_id", self.id)
        .order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /my/project-shares: ${error.message}`))
        return
      }
      const shares = (data ?? []).map((m) => {
        const proj = rel1<{ name: string; status: string; share_mode: string; bonus_pool: string | null }>(
          (m as { projects: unknown }).projects,
        )
        const pct = num(m.share_pct as string | null)
        const amount = num(m.share_amount as string | null)
        const projRow = proj
          ? ({
              id: m.project_id,
              tenant_id: tenantId,
              name: proj.name,
              code: null,
              description: null,
              status: proj.status,
              dept_id: null,
              lead_emp_id: null,
              share_mode: proj.share_mode,
              bonus_pool: proj.bonus_pool,
              created_at: "",
            } as ProjectRow)
          : null
        return {
          memberId: m.id,
          projectId: m.project_id,
          projectName: proj?.name ?? null,
          status: proj?.status ?? null,
          roleInProject: m.role_in_project,
          shareMode: proj?.share_mode ?? null,
          sharePct: pct,
          shareAmount: amount,
          computedAmount: projRow ? computeAmount(projRow, pct, amount) : null,
        }
      })
      res.status(200).json({ shares })
    } catch (err) {
      next(err)
    }
  },
)
