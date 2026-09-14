import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import {
  nextProjectCode,
  isUniqueViolation,
  loadCodeFormat,
  MAX_CODE_ATTEMPTS,
  DEFAULT_CODE_FORMAT,
} from "../services/project-code.js"
import {
  PROJECT_STATUSES,
  resolveStatusPatch,
  taipeiToday,
} from "../services/project-status.js"
import { resolveSelf, isHrRole, managedDeptIds } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"
import { DEFAULT_AUTO_ARCHIVE_MONTHS } from "../services/project-archive.js"
import {
  DEFAULT_STAMP_DUTY_RATE,
  DEFAULT_LOOKBACK_YEARS,
} from "../services/stamp-duty.js"
import { todayKey, localDateKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import {
  PROJECT_KINDS,
  INVOICE_TYPES,
  PAYMENT_METHODS,
  DEFAULT_VAT_RATE,
  rocDate,
} from "../services/project-money.js"
import {
  loadP3Settings,
  loadProjectFinance,
  loadClient,
  serializeClient,
  serializeBilling,
  serializeSubcontract,
  serializeContractLite,
} from "../services/project-application-store.js"

export const projectsRouter = Router()

// ⚠️ 必須是單一字串常值，不可用 + 相接——supabase-js 從字串常值推列型別，
// 相接後會退化成 GenericStringError，下游的 as ProjectRow 全數失效。
const PROJECT_COLS =
  "id, tenant_id, name, code, fiscal_year, description, status, status_reason, status_effective_on, status_changed_at, archived_at, starts_on, ends_on, opened_on, dept_id, lead_emp_id, share_mode, bonus_pool, created_at, client_id, parent_project_id, kind, reserved_at, site_address, site_area_m2, design_scope, invoice_type, payment_method, closing_day, payment_day, other_expenses, engineers"

/** 預先取號的專案名稱——之後 PATCH 填真名時自動清掉 reserved_at。 */
export const RESERVED_NAME = "（預先取號）"

/* ── P3 專案申請單的欄位（模組五） ──────────────────────────────────── */

const designScopeItem = z.object({
  discipline: z.string().trim().min(1).max(40),
  item: z.string().trim().max(200).nullish(),
  amount: z.number().nonnegative().nullish(),
})

/** 工程師（技師）指派：值可以是名冊裡的廠商（vendorId）或直接填名字。 */
const engineerRef = z.object({
  vendorId: z.string().uuid().nullish(),
  name: z.string().trim().max(120).nullish(),
})
const engineersSchema = z.record(z.enum(["electrical", "hvac", "fire"]), engineerRef.nullable())

const dayField = z.string().trim().max(40).nullish()

const applicationFields = {
  /**
   * 開案日期（A5）。事後補 K 單的案子不該用建立日／K 單當天當日期，
   * 讓人可填實際開案那天。POST 省略／null 時由呼叫端補租戶今天（見
   * `tenantToday`）；PATCH 省略則不動、帶 null 會清空。
   */
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  clientId: z.string().uuid().nullish(),
  parentProjectId: z.string().uuid().nullish(),
  kind: z.enum(PROJECT_KINDS).optional(),
  siteAddress: z.string().trim().max(300).nullish(),
  siteAreaM2: z.number().nonnegative().max(1e9).nullish(),
  designScope: z.array(designScopeItem).max(50).optional(),
  invoiceType: z.enum(INVOICE_TYPES).nullish(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullish(),
  closingDay: dayField,
  paymentDay: dayField,
  otherExpenses: z.number().nonnegative().max(1e12).nullish(),
  engineers: engineersSchema.optional(),
}

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
  /** 預定起訖日（甘特圖／示警）。 */
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  ...applicationFields,
})

const reserveSchema = z.object({
  count: z.number().int().min(1).max(20),
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
    // 案情（模組四第 2 條）。改狀態一律要 statusReason，否則 400。
    status: z.enum(PROJECT_STATUSES).optional(),
    statusReason: z.string().trim().min(1).max(2000).optional(),
    /** 法律生效日（解約日／結案日）。未填時取今天，但 UI 要讓人填真正那天。 */
    statusEffectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    /** 可見性，與 status 互不干涉。 */
    archived: z.boolean().optional(),
    deptId: z.string().uuid().nullable().optional(),
    leadEmpId: z.string().uuid().nullable().optional(),
    shareMode: z.enum(["pool_pct", "fixed_amount"]).optional(),
    bonusPool: z.number().nonnegative().nullable().optional(),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    ...applicationFields,
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })
  .refine((b) => !(b.startsOn && b.endsOn) || b.startsOn <= b.endsOn, { message: "endsOn must not be before startsOn" })

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
  status_reason: string | null
  status_effective_on: string | null
  status_changed_at: string | null
  archived_at: string | null
  starts_on: string | null
  ends_on: string | null
  /** 開案日（A5）。可空：既有資料由 sql/0031 backfill；新案由 API 預設今天。 */
  opened_on: string | null
  dept_id: string | null
  lead_emp_id: string | null
  share_mode: string
  bonus_pool: string | null
  created_at: string
  // P3 專案申請單
  client_id: string | null
  parent_project_id: string | null
  kind: string
  reserved_at: string | null
  site_address: string | null
  site_area_m2: string | null
  design_scope: unknown
  invoice_type: string | null
  payment_method: string | null
  closing_day: string | null
  payment_day: string | null
  other_expenses: string | null
  engineers: unknown
}

type DesignScopeItem = z.infer<typeof designScopeItem>

/** design_scope 是 jsonb，讀回來要收斂形狀；非 finance 的人看不到金額。 */
function designScopeOf(v: unknown, withAmount: boolean): DesignScopeItem[] {
  if (!Array.isArray(v)) return []
  const out: DesignScopeItem[] = []
  for (const item of v) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    if (typeof o.discipline !== "string") continue
    out.push({
      discipline: o.discipline,
      item: typeof o.item === "string" ? o.item : null,
      amount: withAmount && typeof o.amount === "number" ? o.amount : null,
    })
  }
  return out
}

function engineersOf(v: unknown): Record<string, { vendorId: string | null; name: string | null } | null> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {}
  const out: Record<string, { vendorId: string | null; name: string | null } | null> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null) {
      out[k] = null
      continue
    }
    if (!val || typeof val !== "object") continue
    const o = val as Record<string, unknown>
    out[k] = {
      vendorId: typeof o.vendorId === "string" ? o.vendorId : null,
      name: typeof o.name === "string" ? o.name : null,
    }
  }
  return out
}

/** 專案基本資料（basic 段）。`finance=false` 時不帶任何金額欄位。 */
function serializeProject(row: ProjectRow, opts: { finance: boolean; hasSignedContract: boolean }) {
  return {
    hasSignedContract: opts.hasSignedContract,
    id: row.id,
    name: row.name,
    code: row.code,
    fiscalYear: row.fiscal_year,
    description: row.description,
    status: row.status,
    statusReason: row.status_reason,
    statusEffectiveOn: row.status_effective_on,
    statusChangedAt: row.status_changed_at,
    archivedAt: row.archived_at,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    /** 開案日期（A5）。全員可見，不受 finance 收斂——跟起訖日同一類。 */
    openedOn: row.opened_on,
    deptId: row.dept_id,
    leadEmpId: row.lead_emp_id,
    shareMode: row.share_mode,
    // 分潤池維持既有可見性（bonus 段照舊）；finance 只收斂申請單的金額欄。
    bonusPool: num(row.bonus_pool),
    createdAt: row.created_at,
    // P3
    clientId: row.client_id,
    parentProjectId: row.parent_project_id,
    kind: row.kind ?? "main",
    reservedAt: row.reserved_at,
    siteAddress: row.site_address,
    siteAreaM2: num(row.site_area_m2),
    designScope: designScopeOf(row.design_scope, opts.finance),
    invoiceType: row.invoice_type,
    paymentMethod: row.payment_method,
    closingDay: row.closing_day,
    paymentDay: row.payment_day,
    otherExpenses: opts.finance ? (num(row.other_expenses) ?? 0) : null,
    engineers: engineersOf(row.engineers),
  }
}

/**
 * 案型與母案的規則：
 *   • kind≠main 必須掛母案（追加減／加做／估驗都是「某個主案的」）→ parent_required
 *   • 母案必須同租戶、且本身是 main（不能掛在追加減底下疊羅漢）→ invalid_parent
 *   • main 不掛母案、也不能掛自己
 */
async function validateParent(
  tenantId: string,
  kind: string,
  parentProjectId: string | null,
  selfId: string | null,
): Promise<"parent_required" | "invalid_parent" | null> {
  if (kind === "main") return parentProjectId ? "invalid_parent" : null
  if (!parentProjectId) return "parent_required"
  if (selfId && parentProjectId === selfId) return "invalid_parent"
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("id, kind")
    .eq("tenant_id", tenantId)
    .eq("id", parentProjectId)
    .maybeSingle()
  if (error) throw new Error(`validateParent: ${error.message}`)
  if (!data || (data.kind ?? "main") !== "main") return "invalid_parent"
  return null
}

async function clientExists(tenantId: string, clientId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", clientId)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`clientExists: ${error.message}`)
  return !!data
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
 * 哪些專案有「已簽訂的合約」（模組四第 3 條）。
 *
 * 專案層級的「合約 or 報價單」刻意**衍生**而不另存欄位：存了旗標就會有
 * 兩份真相，而合約是會改版、會作廢的。有 `doc_type='contract'` 且有
 * `signed_on` 的未刪除列 ＝ 已簽約。
 */
async function signedProjectIds(tenantId: string, projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set()
  const { data, error } = await supabaseAdmin
    .from("contracts")
    .select("project_id")
    .eq("tenant_id", tenantId)
    .eq("doc_type", "contract")
    .is("deleted_at", null)
    .not("signed_on", "is", null)
    .in("project_id", projectIds)
  if (error) throw new Error(`signedProjectIds: ${error.message}`)
  return new Set((data ?? []).map((r) => r.project_id as string))
}

async function clientNamesById(tenantId: string, ids: Array<string | null>): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((v): v is string => !!v))]
  if (uniq.length === 0) return new Map()
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", uniq)
  if (error) throw new Error(`clientNamesById: ${error.message}`)
  return new Map((data ?? []).map((c) => [c.id as string, c.name as string]))
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
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    // 封存的目的就是從列表收起來，所以預設不回。要看全部帶 ?includeArchived=1。
    // 案情（進行中／暫停／結案／解約）不在這裡篩——那是前端的檢視選擇，
    // 已解約的案子仍要出現在列表上。
    const includeArchived = req.query.includeArchived === "1"
    // 預先取號的空列（reserved_at 非空）預設不進列表——它們還不是案子，
    // 只是佔了號。年度總表要看得到，帶 ?includeReserved=1。
    const includeReserved = req.query.includeReserved === "1"
    try {
      let query = supabaseAdmin
        .from("projects")
        .select(PROJECT_COLS)
        .eq("tenant_id", tenantId)
      if (!includeArchived) query = query.is("archived_at", null)
      if (!includeReserved) query = query.is("reserved_at", null)
      const { data, error } = await query.order("created_at", { ascending: false })
      if (error) {
        next(new Error(`GET /projects: ${error.message}`))
        return
      }
      // 「有沒有簽約」是衍生的，不另存旗標——旗標與 contracts 會對不起來。
      // 整份列表一次查完，不做 N+1。
      const rows = (data ?? []) as ProjectRow[]
      const ids = rows.map((p) => p.id)
      const [signed, clientNames] = await Promise.all([
        signedProjectIds(tenantId, ids),
        clientNamesById(tenantId, rows.map((p) => p.client_id)),
      ])

      const projects = rows.map((row) => ({
        ...serializeProject(row, { finance: false, hasSignedContract: signed.has(row.id) }),
        clientName: row.client_id ? (clientNames.get(row.client_id) ?? null) : null,
      }))
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
      // 編號的年度一律取**建立年**（見 services/project-code.ts 的說明），
      // 而且是**台北當地**的年——12/31 深夜立的案不該拿到新年度的號。
      const year = await taipeiYear(tenantId)
      const manualCode = b.code ?? null
      // A5：省略／null 一律補租戶今天——事後補 K 單的案子，UI 會讓人改成真正開案那天。
      const openedOn = b.openedOn ?? (await tenantToday(tenantId))

      // 案型與母案（P3）。
      const kind = b.kind ?? "main"
      const parentError = await validateParent(tenantId, kind, b.parentProjectId ?? null, null)
      if (parentError) {
        res.status(400).json({ error: parentError })
        return
      }
      // 業主：要存在且未刪。請款慣例（開票聯式／付款方式／結帳日／付款日）
      // 未填時從業主名冊預填，專案上可個別覆寫。
      let client: Awaited<ReturnType<typeof loadClient>> = null
      if (b.clientId) {
        client = await loadClient(tenantId, b.clientId)
        if (!client || client.deleted_at) {
          res.status(400).json({ error: "invalid_client" })
          return
        }
      }

      const baseRow = {
        tenant_id: tenantId,
        name: b.name,
        fiscal_year: b.fiscalYear ?? year,
        description: b.description ?? null,
        dept_id: b.deptId ?? null,
        lead_emp_id: b.leadEmpId ?? null,
        share_mode: b.shareMode ?? "pool_pct",
        bonus_pool: b.bonusPool ?? null,
        starts_on: b.startsOn ?? null,
        ends_on: b.endsOn ?? null,
        opened_on: openedOn,
        status: "active",
        // P3
        client_id: b.clientId ?? null,
        parent_project_id: kind === "main" ? null : (b.parentProjectId ?? null),
        kind,
        site_address: b.siteAddress ?? null,
        site_area_m2: b.siteAreaM2 ?? null,
        design_scope: b.designScope ?? [],
        invoice_type: b.invoiceType ?? client?.invoice_type ?? null,
        payment_method: b.paymentMethod ?? client?.payment_method ?? null,
        closing_day: b.closingDay ?? client?.closing_day ?? null,
        payment_day: b.paymentDay ?? client?.payment_day ?? null,
        other_expenses: b.otherExpenses ?? 0,
        engineers: b.engineers ?? {},
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
      const inserted = await insertWithGeneratedCode(tenantId, year, baseRow)
      if (!inserted) {
        res.status(503).json({ error: "code_generation_failed", attempts: MAX_CODE_ATTEMPTS })
        return
      }
      res.status(201).json(inserted)
    } catch (err) {
      next(err)
    }
  },
)

/** 台北（租戶時區）的今年——編號與歸屬年度的預設值。 */
async function taipeiYear(tenantId: string): Promise<number> {
  const tz = await getTenantTimezone(tenantId)
  return Number(todayKey(tz).slice(0, 4))
}

/** 租戶時區的今天——A5 開案日期（`openedOn`）未填時的預設值。 */
async function tenantToday(tenantId: string): Promise<string> {
  const tz = await getTenantTimezone(tenantId)
  return todayKey(tz)
}

/**
 * 系統產號＋插入，撞號重試。回 null 代表重試用盡（呼叫端回 503）。
 * 建案與預先取號共用——兩邊的併發與格式邏輯要一模一樣。
 */
async function insertWithGeneratedCode(
  tenantId: string,
  year: number,
  row: Record<string, unknown>,
): Promise<{ id: string; code: string } | null> {
  const fmt = await loadCodeFormat(tenantId)
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = await nextProjectCode(tenantId, year, fmt)
    const { data, error } = await supabaseAdmin
      .from("projects")
      .insert({ ...row, code })
      .select("id, code")
      .single()
    if (!error) return { id: data!.id as string, code: data!.code as string }
    if (!isUniqueViolation(error)) throw new Error(`insertWithGeneratedCode: ${error.message}`)
    // 撞號 → 下一圈重算
  }
  return null
}

// ── POST /projects/reserve — HR 預先取號（連號） ─────────────────────
/**
 * 老闆的做法：申請單編號先開好，案子談定再補內容。連續取 `count` 個號，
 * 每個都是一列 `name='（預先取號）'`、`reserved_at=now` 的空專案；之後
 * `PATCH /projects/:id` 填 name 時自動清掉 reserved_at，就變成正式的案子。
 * 列表預設不回 reserved 列（見 GET /projects 的 includeReserved）。
 */
projectsRouter.post(
  "/projects/reserve",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = reserveSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const year = await taipeiYear(tenantId)
      const nowIso = new Date().toISOString()
      const projects: Array<{ id: string; code: string }> = []
      for (let i = 0; i < parsed.data.count; i++) {
        const inserted = await insertWithGeneratedCode(tenantId, year, {
          tenant_id: tenantId,
          name: RESERVED_NAME,
          fiscal_year: year,
          status: "active",
          kind: "main",
          reserved_at: nowIso,
          design_scope: [],
          engineers: {},
          other_expenses: 0,
        })
        if (!inserted) {
          // 已經取到的號留著（它們是合法的空列），只回報取到幾個。
          res.status(503).json({ error: "code_generation_failed", attempts: MAX_CODE_ATTEMPTS, projects })
          return
        }
        projects.push(inserted)
      }
      res.status(201).json({ projects })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * 專案詳情的三段：basic（全員）／finance（錢）／bonus（分潤）。
 * finance＝HR／該案 lead／該案部門主管（`loadScope().canManage`）；bonus 維持
 * 既有分潤區的邏輯（目前與 finance 同一條規則，但分開回傳，前端別綁在一起）。
 * 非 finance：`money:null, billings:[], subcontracts:[], contracts:[]`，
 * 且 project 裡的金額欄位（designScope.amount／otherExpenses）也不帶。
 */
export async function loadProjectDetail(tenantId: string, userId: string, projectId: string) {
  const scope = await loadScope(tenantId, userId, projectId)
  if (!scope.ok) return scope
  const row = scope.project
  const finance = scope.canManage
  const [signed, client, settings] = await Promise.all([
    signedProjectIds(tenantId, [row.id]),
    loadClient(tenantId, row.client_id),
    loadP3Settings(tenantId),
  ])
  const project = {
    ...serializeProject(row, { finance, hasSignedContract: signed.has(row.id) }),
    client: client ? serializeClient(client) : null,
  }
  const access = { finance, bonus: scope.canManage }
  if (!finance) {
    return {
      ok: true as const,
      project,
      access,
      money: null,
      billings: [] as ReturnType<typeof serializeBilling>[],
      subcontracts: [] as ReturnType<typeof serializeSubcontract>[],
      contracts: [] as ReturnType<typeof serializeContractLite>[],
      latestDocument: null,
      settings,
    }
  }
  const bundle = await loadProjectFinance(tenantId, row.id, num(row.other_expenses) ?? 0, settings)
  const paymentsBySub = new Map<string, typeof bundle.payments>()
  for (const p of bundle.payments) {
    const arr = paymentsBySub.get(p.subcontract_id)
    if (arr) arr.push(p)
    else paymentsBySub.set(p.subcontract_id, [p])
  }
  return {
    ok: true as const,
    project,
    access,
    money: bundle.money,
    billings: bundle.billings.map(serializeBilling),
    subcontracts: bundle.subcontracts.map((sc) => serializeSubcontract(sc, paymentsBySub.get(sc.id) ?? [])),
    contracts: bundle.contracts.map(serializeContractLite),
    latestDocument: bundle.latestDocument,
    settings,
  }
}

// ── GET /projects/:id — 全員讀專案詳情（錢依權限裁剪） ────────────────
projectsRouter.get(
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
    try {
      const detail = await loadProjectDetail(tenantId, userId, req.params.id as string)
      if (!detail.ok) {
        res.status(detail.status).json({ error: detail.error })
        return
      }
      res.status(200).json({
        project: detail.project,
        access: detail.access,
        money: detail.money,
        billings: detail.billings,
        subcontracts: detail.subcontracts,
        contracts: detail.contracts,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ── GET /projects/:id/application — 申請單資料（Word 申請單的欄位集） ──
/**
 * 老闆的 Word「專案申請單」一頁要印的東西：編號、日期（民國）、業主、
 * 現場、設計範圍、工程師、最新文件（合約／報價單）、請款期程、副委託、
 * 金額試算。權限同 GET /projects/:id：非 finance 只拿得到 basic＋client。
 */
projectsRouter.get(
  "/projects/:id/application",
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
      const detail = await loadProjectDetail(tenantId, userId, req.params.id as string)
      if (!detail.ok) {
        res.status(detail.status).json({ error: detail.error })
        return
      }
      const tz = await getTenantTimezone(tenantId)
      const createdOn = localDateKey(detail.project.createdAt, tz)
      const { client, ...project } = detail.project
      // A5：申請單抬頭印「開案日期」，用 openedOn（缺值才退回建立日）——
      // createdOn／dateRoc 維持原本建立日語意，兩者刻意分開，別互相取代。
      const openedOn = project.openedOn ?? createdOn
      res.status(200).json({
        application: {
          code: project.code,
          createdOn,
          dateRoc: rocDate(createdOn),
          openedOn,
          project,
          client,
          latestDocument: detail.latestDocument,
          designScope: project.designScope,
          engineers: project.engineers,
          billings: detail.billings,
          subcontracts: detail.subcontracts,
          money: detail.money,
          settings: { vatRate: detail.settings.vatRate, disciplines: detail.settings.disciplines },
        },
        access: detail.access,
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
      if (b.name !== undefined) {
        patch.name = b.name
        // 預先取號的空列一填上真名就是正式的案子了。
        if (scope.project.reserved_at && b.name !== RESERVED_NAME) patch.reserved_at = null
      }
      if (b.fiscalYear !== undefined) patch.fiscal_year = b.fiscalYear
      if (b.description !== undefined) patch.description = b.description
      if (b.deptId !== undefined) patch.dept_id = b.deptId
      if (b.leadEmpId !== undefined) patch.lead_emp_id = b.leadEmpId
      if (b.shareMode !== undefined) patch.share_mode = b.shareMode
      if (b.bonusPool !== undefined) patch.bonus_pool = b.bonusPool
      if (b.startsOn !== undefined) patch.starts_on = b.startsOn
      if (b.endsOn !== undefined) patch.ends_on = b.endsOn
      if (b.openedOn !== undefined) patch.opened_on = b.openedOn

      // ── P3 專案申請單欄位 ──
      if (b.kind !== undefined || b.parentProjectId !== undefined) {
        const kind = b.kind ?? scope.project.kind ?? "main"
        const parentId =
          b.parentProjectId !== undefined ? b.parentProjectId : scope.project.parent_project_id
        const parentError = await validateParent(tenantId, kind, parentId ?? null, scope.project.id)
        if (parentError) {
          res.status(400).json({ error: parentError })
          return
        }
        patch.kind = kind
        patch.parent_project_id = kind === "main" ? null : parentId
      }
      if (b.clientId !== undefined) {
        if (b.clientId && !(await clientExists(tenantId, b.clientId))) {
          res.status(400).json({ error: "invalid_client" })
          return
        }
        patch.client_id = b.clientId
      }
      if (b.siteAddress !== undefined) patch.site_address = b.siteAddress
      if (b.siteAreaM2 !== undefined) patch.site_area_m2 = b.siteAreaM2
      if (b.designScope !== undefined) patch.design_scope = b.designScope
      if (b.invoiceType !== undefined) patch.invoice_type = b.invoiceType
      if (b.paymentMethod !== undefined) patch.payment_method = b.paymentMethod
      if (b.closingDay !== undefined) patch.closing_day = b.closingDay
      if (b.paymentDay !== undefined) patch.payment_day = b.paymentDay
      if (b.otherExpenses !== undefined) patch.other_expenses = b.otherExpenses ?? 0
      if (b.engineers !== undefined) patch.engineers = b.engineers

      // 案情與封存的規則全在 services/project-status.ts，這裡只搬運。
      const status = resolveStatusPatch({
        currentStatus: scope.project.status,
        currentArchivedAt: scope.project.archived_at,
        status: b.status,
        statusReason: b.statusReason,
        statusEffectiveOn: b.statusEffectiveOn,
        archived: b.archived,
        today: taipeiToday(),
        nowIso: new Date().toISOString(),
        actorEmpId: scope.self.id,
      })
      if (!status.ok) {
        res.status(400).json({ error: status.error })
        return
      }
      Object.assign(patch, status.patch)

      if (Object.keys(patch).length === 0) {
        res.status(200).json({ id: req.params.id as string })
        return
      }

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

/* ─────────────────────────────────────────────────────────────────────
 * 專案模組的租戶級參數（模組四第 2 條）
 * ───────────────────────────────────────────────────────────────────── */

const projectSettingsSchema = z
  .object({
    autoArchiveEnabled: z.boolean().optional(),
    /** 0 表示終止當天就封存。上限 120 個月，超過等於沒在封存。 */
    autoArchiveMonths: z.number().int().min(0).max(120).optional(),
    /** 新建合約時的預設費率（模組四第 3 條）。實際費率凍結在合約列上。 */
    stampDutyRate: z.number().min(0).max(1).optional(),
    /** 印花稅清單回溯年數。預設 7——未申報的核課期間是 7 年，不是 5 年。 */
    stampDutyLookbackYears: z.number().int().min(1).max(15).optional(),
    // ── P3：編號格式與稅率。改格式只影響之後產的號，既有編號不動。 ──
    codePrefix: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9]+$/, "前綴只能是英數").optional(),
    codeYearStyle: z.enum(["roc", "ad"]).optional(),
    codeSeqDigits: z.number().int().min(1).max(6).optional(),
    vatRate: z.number().min(0).max(1).optional(),
    disciplines: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const SETTINGS_COLS =
  "auto_archive_enabled, auto_archive_months, stamp_duty_rate, stamp_duty_lookback_years, code_prefix, code_year_style, code_seq_digits, vat_rate, disciplines"

type SettingsRow = {
  auto_archive_enabled: boolean | null
  auto_archive_months: number | string | null
  stamp_duty_rate: number | string | null
  stamp_duty_lookback_years: number | string | null
  code_prefix: string | null
  code_year_style: string | null
  code_seq_digits: number | string | null
  vat_rate: number | string | null
  disciplines: unknown
}

function serializeSettings(data: SettingsRow | null) {
  return {
    autoArchiveEnabled: data ? data.auto_archive_enabled !== false : true,
    autoArchiveMonths: data ? Number(data.auto_archive_months) : DEFAULT_AUTO_ARCHIVE_MONTHS,
    stampDutyRate: data ? Number(data.stamp_duty_rate) : DEFAULT_STAMP_DUTY_RATE,
    stampDutyLookbackYears: data ? Number(data.stamp_duty_lookback_years) : DEFAULT_LOOKBACK_YEARS,
    codePrefix: data?.code_prefix ?? DEFAULT_CODE_FORMAT.prefix,
    codeYearStyle: data?.code_year_style === "ad" ? "ad" : DEFAULT_CODE_FORMAT.yearStyle,
    codeSeqDigits: data?.code_seq_digits ? Number(data.code_seq_digits) : DEFAULT_CODE_FORMAT.seqDigits,
    vatRate: data?.vat_rate !== null && data?.vat_rate !== undefined ? Number(data.vat_rate) : DEFAULT_VAT_RATE,
    disciplines: Array.isArray(data?.disciplines)
      ? (data!.disciplines as unknown[]).filter((d): d is string => typeof d === "string")
      : ["電機", "空調", "消防", "汙水"],
  }
}

// ── GET /project-settings — 全員可讀（UI 要顯示「N 個月後自動封存」）──
projectsRouter.get(
  "/project-settings",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("project_settings")
        .select(SETTINGS_COLS)
        .eq("tenant_id", tenantId)
        .maybeSingle()
      if (error) {
        next(new Error(`GET /project-settings: ${error.message}`))
        return
      }
      // 沒有設定列就回預設值，讓租戶不必先設定就能用。
      res.status(200).json({ settings: serializeSettings(data as SettingsRow | null) })
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /project-settings — HR 調整 ───────────────────────────────────
projectsRouter.put(
  "/project-settings",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = projectSettingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const self = await resolveSelf(tenantId, userId)
      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        updated_at: new Date().toISOString(),
      }
      if (parsed.data.autoArchiveEnabled !== undefined)
        row.auto_archive_enabled = parsed.data.autoArchiveEnabled
      if (parsed.data.autoArchiveMonths !== undefined)
        row.auto_archive_months = parsed.data.autoArchiveMonths
      if (parsed.data.stampDutyRate !== undefined)
        row.stamp_duty_rate = parsed.data.stampDutyRate
      if (parsed.data.stampDutyLookbackYears !== undefined)
        row.stamp_duty_lookback_years = parsed.data.stampDutyLookbackYears
      if (parsed.data.codePrefix !== undefined) row.code_prefix = parsed.data.codePrefix
      if (parsed.data.codeYearStyle !== undefined) row.code_year_style = parsed.data.codeYearStyle
      if (parsed.data.codeSeqDigits !== undefined) row.code_seq_digits = parsed.data.codeSeqDigits
      if (parsed.data.vatRate !== undefined) row.vat_rate = parsed.data.vatRate
      if (parsed.data.disciplines !== undefined) row.disciplines = parsed.data.disciplines

      const { data, error } = await supabaseAdmin
        .from("project_settings")
        .upsert(row, { onConflict: "tenant_id" })
        .select(SETTINGS_COLS)
        .single()
      if (error || !data) {
        next(new Error(`PUT /project-settings: ${error?.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "project_settings",
        action: "UPDATE",
        newRow: parsed.data,
        actorEmpId: self?.id,
        context: "PUT /project-settings",
      })

      res.status(200).json({ settings: serializeSettings(data as SettingsRow) })
    } catch (err) {
      next(err)
    }
  },
)
