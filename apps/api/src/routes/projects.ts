import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance } from "../middleware/role.js"
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
import { isHrRole, resolveSelf } from "../middleware/scope.js"
import { loadGroupFinancialsAccess } from "../services/financial-visibility.js"
import {
  bonusEditAccessOf,
  loadProjectBossEmpId,
  resolveBonusEditAccess,
  resolveProjectAccess,
  financeProjectIds,
  type BonusEditAccess,
} from "../services/project-scope.js"
import { recomputeDraftRunsAfterWrite } from "../services/project-bonus-recompute.js"
import { estimateProjectBonus, type ProjectBonusEstimate } from "../services/bonus-estimate.js"
import { writeAuditLog } from "../services/audit.js"
import { DEFAULT_AUTO_ARCHIVE_MONTHS } from "../services/project-archive.js"
import {
  DEFAULT_STAMP_DUTY_RATE,
  DEFAULT_LOOKBACK_YEARS,
} from "../services/stamp-duty.js"
import { todayKey, localDateKey } from "../lib/tz.js"
import { columnsExist } from "../lib/schema-compat.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import {
  PROJECT_KINDS,
  INVOICE_TYPES,
  PAYMENT_METHODS,
  BILLING_KINDS,
  SUBCONTRACT_KINDS,
  DEFAULT_WITHHOLDING_RATE,
  DEFAULT_WITHHOLDING_THRESHOLD,
  DEFAULT_VAT_RATE,
  computeSchedule,
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
  buildAnnualRows,
  annualDisciplines,
  type AnnualProjectRow,
} from "../services/project-application-store.js"
import { maskRegisterRows, type RegisterRow } from "../services/project-register.js"
import {
  applyProjectShareRevision,
  ProjectShareRevisionError,
  projectShareRevisionSchema,
} from "../services/project-share-revision.js"
import type { MainContractInput } from "../services/main-contract.js"
import type { NewBillingInput } from "../services/billing-store.js"
import { AtomicProjectCreationError, createProjectApplicationAtomic } from "../services/project-creation.js"
import {
  checkProjectCompany,
  defaultCompanyOf,
  effectiveCompanyOf,
  loadTenantCompanies,
  type ProjectCompanyCheck,
} from "../services/project-company.js"

export const projectsRouter = Router()

// ⚠️ 必須是單一字串常值，不可用 + 相接——supabase-js 從字串常值推列型別，
// 相接後會退化成 GenericStringError，下游的 as ProjectRow 全數失效。
const PROJECT_COLS =
  "id, tenant_id, name, code, fiscal_year, description, status, status_reason, status_effective_on, status_changed_at, archived_at, archive_reason, starts_on, ends_on, opened_on, dept_id, lead_emp_id, share_mode, bonus_pool, bonus_rate_pct, created_at, client_id, parent_project_id, kind, reserved_at, site_address, site_area_m2, design_scope, invoice_type, payment_method, closing_day, payment_day, other_expenses, engineers, company_id"

/**
 * 舊的預先取號空列的占位名稱。預先取號功能已移除（業主 2026-10-07），不再有建立途徑；
 * 留著這個常數只為了讓 PATCH 填真名時仍會清掉舊資料的 reserved_at（見 PATCH /projects/:id）。
 */
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
/**
 * W8（2026-09-23）：科別不再寫死三個英文 key。key 是**租戶自訂的科別名稱**
 * （`project_settings.disciplines`，預設 電機／空調／消防／汙水），值域由
 * `assertKnownDisciplines()` 在執行期比對——zod 這層只管形狀，因為設定是
 * 租戶級資料、不是編譯期常數。舊資料的 electrical／hvac／fire 由 sql/0040
 * backfill 成中文 key。
 */
const engineersSchema = z.record(z.string().trim().min(1).max(40), engineerRef.nullable())

const dayField = z.string().trim().max(40).nullish()

/**
 * 歸屬年度：存西元年（2000～2100）。也接受民國年——編號用民國年（例如 AE-115-005），
 * 使用者常照著填 115；小於 1000 的整數一律視為民國年 +1911。原本這種值直接 400 invalid_body。
 */
const fiscalYearSchema = z.preprocess(
  (v) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1000 ? v + 1911 : v),
  z.number().int().min(2000).max(2100),
)

/**
 * W3（2026-09-23）：專案成員四角色——manager 經理／lead 主辦／support 支援／
 * member 組員，各自可有不同的分潤趴數（2026-10-27 起每個專案各自設定，見 `sharePctByRoleSchema`）。
 * manager 與 lead 屬「負責人層」（services/project-scope.ts 的 PROJECT_LEAD_ROLES）：
 * 看得到全案分潤、也取得該案 finance 權限。值域與 RLS `is_project_lead()` 同步。
 */
export const PROJECT_MEMBER_ROLES = ["manager", "lead", "support", "member"] as const

/**
 * 本案各角色分潤趴數（2026-10-27，`projects.share_pct_by_role`）：四角色 → 0–100。整鍵覆蓋，
 * **四鍵必填**（缺鍵 400）——存成 `{}` 或缺角色會讓「未設定退回新專案起始值」失效；要取消本案設定請送 null。
 * 只有老闆／platform_admin 可設定。
 */
const sharePctValue = z.number().min(0).max(100)
const sharePctByRoleSchema = z.object({
  manager: sharePctValue,
  lead: sharePctValue,
  support: sharePctValue,
  member: sharePctValue,
})

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

const primaryContractSchema = z.object({
  amount: z.number().finite().nonnegative().max(1e15),
  title: z.string().trim().min(1).max(200).nullish(),
  counterparty: z.string().trim().max(200).nullish(),
  signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  copies: z.number().int().min(1).max(50).optional(),
})

const initialBillingSchema = z.object({
  installmentNo: z.number().int().min(1).max(999),
  kind: z.enum(BILLING_KINDS).optional(),
  percentage: z.number().min(0).max(100).nullish(),
  milestone: z.string().trim().max(200).nullish(),
  plannedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  overrideAmount: z.number().finite().nonnegative().max(1e15).nullish(),
  overrideReason: z.string().trim().max(1000).nullish(),
  note: z.string().trim().max(1000).nullish(),
}).superRefine((billing, ctx) => {
  if (billing.overrideAmount !== null && billing.overrideAmount !== undefined && !billing.overrideReason) {
    ctx.addIssue({ code: "custom", path: ["overrideReason"], message: "override_reason_required" })
  }
})

const initialSubcontractSchema = z.object({
  kind: z.enum(SUBCONTRACT_KINDS).optional(),
  discipline: z.string().trim().max(40).nullish(),
  vendorId: z.string().uuid().nullish(),
  vendorName: z.string().trim().max(120).nullish(),
  contact: z.string().trim().max(120).nullish(),
  item: z.string().trim().max(200).nullish(),
  amount: z.number().finite().nonnegative().max(1e12),
  billingBasis: z.string().trim().max(200).nullish(),
  orderType: z.enum(["quotation", "contract"]).nullish(),
  withholdingRate: z.number().min(0).max(1).nullish(),
  withholdingThreshold: z.number().int().min(0).max(1e9).nullish(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  note: z.string().trim().max(2000).nullish(),
})

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * 人工指定編號（匯入舊案用）。**省略時由系統產生**，見 services/project-code.ts。
   * 指定重複的編號會回 409，不會自動改號——人工指定就代表有意義，不該被系統改掉。
   */
  code: z.string().trim().min(1).max(60).nullish(),
  /** 歸屬年度（分析維度）。省略時預設為編號的年度，即建立年。 */
  fiscalYear: fiscalYearSchema.nullish(),
  description: z.string().trim().max(4000).nullish(),
  deptId: z.string().uuid().nullish(),
  leadEmpId: z.string().uuid().nullish(),
  shareMode: z.enum(["pool_pct", "fixed_amount"]).optional(),
  bonusPool: z.number().nonnegative().nullish(),
  /** 預定起訖日（甘特圖／示警）。 */
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  /** 建案表單簡寫；正式金額只寫 contracts.amount，不寫 projects。 */
  contractAmount: z.number().finite().nonnegative().max(1e15).optional(),
  primaryContract: primaryContractSchema.nullish(),
  billings: z.array(initialBillingSchema).max(100).optional(),
  initialSubcontracts: z.array(initialSubcontractSchema).max(100).optional(),
  /** 承接公司（申請單左上角）。省略／null＝租戶預設公司；不屬於本租戶回 400 invalid_company。 */
  companyId: z.string().uuid().nullish(),
  /**
   * 本案各角色分潤趴數（專案申請單）。只有老闆／platform_admin 可帶非 null（其他人 403，比照獎金池）；
   * 省略＝複製租戶的新專案起始值（有非 0 值才複製，否則 null）；帶 null＝本案不設定。
   */
  sharePctByRole: sharePctByRoleSchema.nullish(),
  ...applicationFields,
}).superRefine((body, ctx) => {
  if (body.contractAmount !== undefined && body.primaryContract != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "contractAmount and primaryContract are mutually exclusive" })
  }
})

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    // `code` 刻意**不可經此端點變更**：編號是識別碼，會被印在合約、請款單、
    // 發票與往來文件上。要調整歸屬請改 `fiscalYear`，那是分析維度。
    // 帶了 code 會回 409，不是靜默忽略——靜默忽略會讓人以為改成功了。
    code: z.string().trim().min(1).max(60).nullable().optional(),
    fiscalYear: fiscalYearSchema.nullable().optional(),
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
    /** 承接公司。帶 null＝改回沿用租戶預設公司；不屬於本租戶回 400 invalid_company。 */
    companyId: z.string().uuid().nullable().optional(),
    /** 本案各角色分潤趴數。**真的有變**才算改分潤，只有老闆／platform_admin 可以（同獎金池）。 */
    sharePctByRole: sharePctByRoleSchema.nullable().optional(),
    /**
     * 申請單付款階段「技師公會代墊」列的「審迄還款」（2026-10-28，migration 0077）。自由文字 ≤200 字；
     * 空字串／null＝清空。權限同付款方式等申請單欄位（canManage）；欄位未套回 409 migration_required。
     */
    guildRepaymentNote: z.string().trim().max(200).nullable().optional(),
    ...applicationFields,
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })
  .refine((b) => !(b.startsOn && b.endsOn) || b.startsOn <= b.endsOn, { message: "endsOn must not be before startsOn" })

const memberCreateSchema = z.object({
  employeeId: z.string().uuid(),
  roleInProject: z.enum(PROJECT_MEMBER_ROLES).optional(),
  sharePct: z.number().min(0).max(100).nullish(),
  shareAmount: z.number().nonnegative().nullish(),
})

const memberUpdateSchema = z
  .object({
    roleInProject: z.enum(PROJECT_MEMBER_ROLES).optional(),
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
  /** 封存理由（C2 複製封存原案時寫「已由 {新 code} 取代：{理由}」；自動封存／手動封存亦可填）。 */
  archive_reason: string | null
  starts_on: string | null
  ends_on: string | null
  /** 開案日（A5）。可空：既有資料由 sql/0031 backfill；新案由 API 預設今天。 */
  opened_on: string | null
  dept_id: string | null
  lead_emp_id: string | null
  share_mode: string
  bonus_pool: string | null
  bonus_rate_pct: string | null
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
  /** 承接公司（companies.id）；null＝沿用租戶預設公司（見 services/project-company.ts）。 */
  company_id: string | null
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

/**
 * W8：技師 key 必須是租戶設定裡的科別（`project_settings.disciplines`）。
 * 回第一個不認得的 key，全部合法回 null。zod 只驗形狀，值域是租戶資料 →
 * 只能在執行期比對；不認得就 400 `unknown_discipline`，不默默存進去
 * （存了會在申請單與年度總表上變成一欄查無此科別的鬼資料）。
 */
async function unknownDiscipline(
  tenantId: string,
  engineers: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!engineers) return null
  const keys = Object.keys(engineers)
  if (keys.length === 0) return null
  const { disciplines } = await loadP3Settings(tenantId)
  const known = new Set(disciplines)
  for (const key of keys) if (!known.has(key)) return key
  return null
}

/**
 * W3：`project_settings.default_share_pct_by_role`（四角色 → 預設分潤趴數）。
 * 欄位尚未套用（migration 0050）時探測一次後退回 `{}`，行為與改動前相同——
 * 部署順序是「先遷移再上碼」，但本機／測試可能在遷移前就跑到這裡。
 */
async function defaultSharePctByRole(tenantId: string): Promise<Record<string, number>> {
  if (!(await columnsExist("project_settings", "default_share_pct_by_role"))) return {}
  const { data, error } = await supabaseAdmin
    .from("project_settings")
    .select("default_share_pct_by_role")
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`defaultSharePctByRole: ${error.message}`)
  const raw = (data as { default_share_pct_by_role?: unknown } | null)?.default_share_pct_by_role
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof value === "number" ? value : Number(value)
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[key] = n
  }
  return out
}

/**
 * 2026-10-27：本案各角色分潤趴數（`projects.share_pct_by_role`，migration 0075）。
 * 欄位尚未套用或本案未設定 → null。刻意不放進 PROJECT_COLS：遷移前上碼時整個專案查詢會因缺欄位而失敗。
 */
async function loadProjectSharePct(tenantId: string, projectId: string): Promise<Record<string, number> | null> {
  if (!(await columnsExist("projects", "share_pct_by_role"))) return null
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("share_pct_by_role")
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`loadProjectSharePct: ${error.message}`)
  const raw = (data as { share_pct_by_role?: unknown } | null)?.share_pct_by_role
  if (raw === null || raw === undefined) return null
  return sharePctMapOf(raw)
}

/**
 * 2026-10-28：申請單「審迄還款」（`projects.guild_repayment_note`，migration 0077）。
 * 同 share_pct_by_role 不放進 PROJECT_COLS：遷移前上碼時整個專案查詢會因缺欄位而失敗。欄位未套或空值 → null。
 */
async function loadProjectGuildRepaymentNote(tenantId: string, projectId: string): Promise<string | null> {
  if (!(await columnsExist("projects", "guild_repayment_note"))) return null
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("guild_repayment_note")
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`loadProjectGuildRepaymentNote: ${error.message}`)
  const raw = (data as { guild_repayment_note?: unknown } | null)?.guild_repayment_note
  return typeof raw === "string" && raw.trim() ? raw : null
}

/**
 * 新增成員時用的角色趴數：本案有設定用本案的；本案未設定（或欄位未套）退回租戶的新專案起始值
 * （`project_settings.default_share_pct_by_role`，相容舊行為）。兩者都沒有的角色由呼叫端當 0。
 */
export async function effectiveSharePctByRole(tenantId: string, projectId: string): Promise<Record<string, number>> {
  return (await loadProjectSharePct(tenantId, projectId)) ?? (await defaultSharePctByRole(tenantId))
}

/** 租戶的新專案起始值裡有沒有任何非 0 的角色趴數（建案省略 sharePctByRole 時決定要不要複製）。 */
function hasNonZeroShare(map: Record<string, number>): boolean {
  return PROJECT_MEMBER_ROLES.some((role) => !isZeroish(map[role]))
}

/** 兩組角色趴數是否相同：null（未設定）只等於 null；有設定時四角色逐一比（缺鍵＝null）。純函式。 */
export function sameSharePctMap(a: Record<string, number> | null, b: Record<string, number> | null): boolean {
  if (a === null || b === null) return a === b
  return PROJECT_MEMBER_ROLES.every((role) => {
    const x = a[role] ?? null
    const y = b[role] ?? null
    if (x === null || y === null) return x === y
    return Math.abs(x - y) < 1e-9
  })
}

/**
 * 專案基本資料（basic 段）。`finance=false` 時不帶申請單的金額欄位；
 * `bonus=false` 時不帶獎金池（W4：會計看得到金流但看不到分潤）。
 * `bonus` 省略時預設跟著 finance——舊呼叫端的行為不變。
 */
function serializeProject(
  row: ProjectRow,
  /** profit：獎金比例可見性（老闆／platform_admin／授權 HR，2026-10-26）；省略＝跟著 bonus。 */
  opts: { finance: boolean; bonus?: boolean; profit?: boolean; hasSignedContract: boolean },
) {
  const bonus = opts.bonus ?? opts.finance
  const profit = bonus && (opts.profit ?? bonus)
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
    archiveReason: row.archive_reason ?? null,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    /** 開案日期（A5）。全員可見，不受 finance 收斂——跟起訖日同一類。 */
    openedOn: row.opened_on,
    deptId: row.dept_id,
    leadEmpId: row.lead_emp_id,
    shareMode: row.share_mode,
    // 分潤池屬 bonus 段：會計與一般員工一律 null（W4）；列表端點一律不回。
    // 2026-10-26 驗收：獎金池（× 入帳比例可反推毛利規模）也屬集團財務——要看得到分潤**且**看得到毛利（profit）才回。
    bonusPool: profit ? num(row.bonus_pool) : null,
    // 獎金比例只給看得到毛利的人（canSeeProfit）：應得 ÷（比例 × 趴數）可反推毛利。
    bonusRatePct: profit ? num(row.bonus_rate_pct) : null,
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
    /** 承接公司：存的值（null＝沿用租戶預設公司）。顯示用的公司名稱由呼叫端以 `companyName` 另補。 */
    companyId: row.company_id ?? null,
  }
}

/**
 * 案型與母案的規則（業主 2026-09-30 會議：拿掉「必須先有母案」的限制）：
 *   • 母案是**選填**——沒帶母案（POST 省略／null、PATCH 帶 null）可以建任何案型。追加減／
 *     加做／代墊常常是先開案、之後才補母案（補母案走 PATCH parentProjectId）。
 *   • **有帶母案才驗**：必須同租戶、且本身是 main（不能掛在追加減底下疊羅漢）→ invalid_parent
 *   • main 不掛母案、任何案也不能掛自己 → invalid_parent
 */
async function validateParent(
  tenantId: string,
  kind: string,
  parentProjectId: string | null,
  selfId: string | null,
): Promise<"invalid_parent" | null> {
  if (!parentProjectId) return null
  if (kind === "main") return "invalid_parent"
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

/**
 * 分潤改版 #1：成員獎金池與員工預估一律走獎金引擎的估算服務（services/bonus-estimate.ts，
 * 與獎金試算同一套：毛利制／舊制／固定金額、入帳比例、已發放）。估算失敗（例如遷移未套）
 * 只記 log 回 null，呼叫端退回舊的 computeAmount——頁面不該因為估算掛掉而整頁 500。
 */
async function estimatesByProject(
  tenantId: string,
  projectIds: string[],
  context: string,
): Promise<Map<string, ProjectBonusEstimate> | null> {
  if (projectIds.length === 0) return new Map()
  try {
    const list = await estimateProjectBonus(tenantId, projectIds)
    return new Map(list.map((e) => [e.projectId, e]))
  } catch (err) {
    console.warn(`[bonus-estimate] ${context}: 估算失敗，退回舊算法`, err)
    return null
  }
}

/** 某成員在估算裡的數字；查無（不是成員／估算失敗）回 null。 */
function memberEstimateOf(est: ProjectBonusEstimate | undefined, employeeId: string) {
  const m = est?.members.find((x) => x.employeeId === employeeId)
  if (!m) return null
  return {
    estimatedAmount: m.estimatedAmount,
    paidAmount: m.paidAmount,
    pendingAmount: Math.max(0, m.estimatedAmount - m.paidAmount),
  }
}

/** 舊算法（估算服務不可用時的退路）：pool_pct: pool×pct/100；fixed_amount: shareAmount。 */
function computeAmount(project: ProjectRow, pct: number | null, amount: number | null): number | null {
  if (project.share_mode === "pool_pct") {
    const pool = num(project.bonus_pool)
    if (pool === null || pct === null) return null
    return Math.round(pool * (pct / 100) * 100) / 100
  }
  return amount
}

/**
 * 專案毛利（毛利／入帳／成本／累計獎金池、獎金比例）＝集團財務的一部分（業主 2026-10-26 二修：老闆與一般 HR 分開）：
 * 只有老闆、platform_admin、被授權的 hr_admin（features.seeGroupFinancials）看得到。未授權 HR、經理／主辦／
 * 部門主管看得到分潤趴數與每人金額，但看不到毛利。見 services/financial-visibility.ts。
 */
async function canSeeProjectProfit(tenantId: string, self: { id: string; role: string }, bossEmpId: string | null): Promise<boolean> {
  return (await loadGroupFinancialsAccess(tenantId, self, bossEmpId)).canSee
}

/** 分潤值的「沒有」：null／undefined／0 都算（新成員趴數 0 與未填視為同一件事）。 */
function isZeroish(v: number | null | undefined): boolean {
  return v === null || v === undefined || Math.abs(v) < 1e-9
}

/**
 * 獎金比例是否相同：null（未設＝舊制）與 0（毛利制、比例 0）是**不同**的設定（驗收 #7），
 * 非老闆把 null 改 0 或 0 改 null 都算改分潤。
 */
function sameRate(a: number | null | undefined, b: number | null | undefined): boolean {
  const an = a ?? null
  const bn = b ?? null
  if (an === null || bn === null) return an === bn
  return Math.abs(an - bn) < 1e-9
}

/** 兩個分潤值是否相同（null 與 0 視為相同，避免編輯器把 null 正規化成 0 被誤判成改分潤）。 */
function sameShare(a: number | null | undefined, b: number | null | undefined): boolean {
  if (isZeroish(a) && isZeroish(b)) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  return Math.abs(a - b) < 1e-9
}

/**
 * 分潤改版 #6：非老闆送來的整批分潤版本是否動到分潤（獎金比例、既有成員趴數、新成員非 0 趴數、
 * 移除趴數 > 0 的成員）。角色變更與移除趴數 0 的成員不算（名單維護，HR／負責人可做）。純函式。
 */
export function shareRevisionChangesShares(
  currentBonusRatePct: number | null,
  currentMembers: Array<{ employeeId: string; sharePct: number | null; shareAmount?: number | null }>,
  revision: { bonusRatePct: number | null; members: Array<{ employeeId: string; sharePct: number | null }> },
): boolean {
  if (!sameRate(revision.bonusRatePct, currentBonusRatePct)) return true
  const current = new Map(currentMembers.map((m) => [m.employeeId.toLowerCase(), m.sharePct]))
  for (const m of revision.members) {
    const key = m.employeeId.toLowerCase()
    if (current.has(key)) {
      if (!sameShare(m.sharePct, current.get(key) ?? null)) return true
    } else if (!isZeroish(m.sharePct)) {
      return true
    }
  }
  // 移除有趴數的成員＝把他的那份變成未分配，也是改分潤（業主 2026-10-26）。
  const kept = new Set(revision.members.map((m) => m.employeeId.toLowerCase()))
  for (const m of currentMembers) {
    if (!kept.has(m.employeeId.toLowerCase()) && (!isZeroish(m.sharePct) || !isZeroish(m.shareAmount))) return true
  }
  return false
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
 * 母案的專案編號（列表的 `parentCode`）：後台首頁「最近變更案」顯示「原案 {母案編號}」用，取代以前從編號格式
 * （`{原案 code}-{n}`）反推——母案選填後，變更案的編號不一定長那樣，也可能根本沒有母案。
 * 母案那列不一定在這次列表結果裡（列表可能只回變更案，母案是已封存的主案），所以另查；含已封存、限本租戶，
 * 每 200 個一批（`.in()` 有 URL 長度上限）。查無（母案列不見）就不在 Map 裡。
 */
async function parentCodesById(tenantId: string, ids: Array<string | null>): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter((v): v is string => !!v))]
  const out = new Map<string, string | null>()
  for (let i = 0; i < uniq.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from("projects")
      .select("id, code")
      .eq("tenant_id", tenantId)
      .in("id", uniq.slice(i, i + 200))
    if (error) throw new Error(`parentCodesById: ${error.message}`)
    for (const row of data ?? []) out.set(row.id as string, (row.code as string | null) ?? null)
  }
  return out
}

/**
 * 載入專案並判定呼叫者的兩段權限（W4，2026-09-23 起 finance 與 bonus 分家）：
 *   • canManage（finance）＝ HR／**會計**／該案 lead（欄位或成員角色 lead｜manager）／
 *     該案所屬部門主管。可讀寫錢與申請單欄位。
 *   • canSeeBonus         ＝ 同上但**不含會計**。獎金池、成員趴數、實得金額與分潤異動史
 *     都只給這一群人。
 * 兩者由 resolveProjectAccess() 一次算完，HR 走零查詢的捷徑（見該函式說明）。
 */
async function loadScope(
  tenantId: string,
  userId: string,
  projectId: string,
): Promise<
  | {
      ok: true
      self: { id: string; role: string }
      project: ProjectRow
      canManage: boolean
      canSeeBonus: boolean
      /** 分潤寫入權（只有老闆／platform_admin，見 services/project-scope.ts bonusEditAccessOf）。 */
      bonusEdit: BonusEditAccess
      /** 專案毛利（毛利／入帳／成本／累計獎金池）可見性：老闆／platform_admin／授權 HR（canSeeProjectProfit）。 */
      canSeeProfit: boolean
    }
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

  const bossEmpId = await loadProjectBossEmpId(tenantId)
  const access = await resolveProjectAccess(
    tenantId,
    self,
    { id: project.id, dept_id: project.dept_id, lead_emp_id: project.lead_emp_id },
    bossEmpId,
  )
  return {
    ok: true,
    self: { id: self.id, role: self.role },
    project,
    canManage: access.finance,
    canSeeBonus: access.bonus,
    bonusEdit: bonusEditAccessOf(self, bossEmpId),
    canSeeProfit: await canSeeProjectProfit(tenantId, self, bossEmpId),
  }
}

/** 承接公司檢查失敗的回應內容：invalid_company 維持舊格式（只有 error），company_inactive 多帶是哪間。 */
function companyErrorBody(check: Extract<ProjectCompanyCheck, { ok: false }>) {
  return check.error === "company_inactive" ? { error: check.error, companyId: check.companyId } : { error: check.error }
}

/**
 * B4：列表排序欄位。key 是 `?sort=` 收的值，value 是實際的 DB 欄位。
 * 不合法的 sort／dir 一律 400（比照 GET /projects/annual 的 invalid_sort
 * 慣例）——排序下拉傳錯值該讓人看見，不要默默退回預設排序。
 */
const PROJECT_SORT_COLUMNS: Record<string, string> = {
  created: "created_at",
  opened: "opened_on",
  name: "name",
  code: "code",
  status: "status",
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
    // M14：?year= 依**歸屬年度**（fiscal_year）篩；不帶＝全部。年度是分析維度，
    // 跟編號裡的建立年刻意分開（見 fiscalYear 的說明）。值不合法一律 400，不默默忽略。
    let year: number | null = null
    if (typeof req.query.year === "string" && req.query.year !== "") {
      const n = Number(req.query.year)
      if (!Number.isInteger(n) || n < 2000 || n > 2100) {
        res.status(400).json({ error: "invalid_year" })
        return
      }
      year = n
    }

    // B4：?sort=created|opened|name|code|status&dir=asc|desc，預設 created desc
    // （與改動前的固定排序相容）。
    const sortParam = typeof req.query.sort === "string" ? req.query.sort : "created"
    if (!Object.prototype.hasOwnProperty.call(PROJECT_SORT_COLUMNS, sortParam)) {
      res.status(400).json({ error: "invalid_sort" })
      return
    }
    const dirParam = typeof req.query.dir === "string" ? req.query.dir : "desc"
    if (dirParam !== "asc" && dirParam !== "desc") {
      res.status(400).json({ error: "invalid_dir" })
      return
    }
    const sortColumn = PROJECT_SORT_COLUMNS[sortParam] as string
    const ascending = dirParam === "asc"

    // 2026-09-30 效能（後台首頁「最近變更案」卡片）：?kind=change,addition 在 DB 端篩類型、
    // ?limit=5 只取排序後前 N 筆，不必把整份清單抓回前端再 filter／slice。兩者都選填，
    // 不帶＝舊行為（全部類型、不限筆數）；值不合法一律 400，不默默忽略（同 year／sort）。
    let kinds: string[] | null = null
    if (req.query.kind !== undefined) {
      const parts = typeof req.query.kind === "string" ? req.query.kind.split(",").map((s) => s.trim()) : []
      if (parts.length === 0 || parts.some((k) => !(PROJECT_KINDS as readonly string[]).includes(k))) {
        res.status(400).json({ error: "invalid_kind" })
        return
      }
      kinds = [...new Set(parts)]
    }
    let limit: number | null = null
    if (req.query.limit !== undefined) {
      const n = typeof req.query.limit === "string" && req.query.limit !== "" ? Number(req.query.limit) : NaN
      if (!Number.isInteger(n) || n < 1 || n > 1000) {
        res.status(400).json({ error: "invalid_limit" })
        return
      }
      limit = n
    }

    // 2026-10-27：?view=register 每案多回一份「專案申請單總表」欄位（金額依權限遮罩，見 services/project-register.ts）。
    // 不帶＝舊行為。值不合法一律 400（同 sort／kind）。
    if (req.query.view !== undefined && req.query.view !== "register") {
      res.status(400).json({ error: "invalid_view" })
      return
    }
    const withRegister = req.query.view === "register"

    try {
      let query = supabaseAdmin
        .from("projects")
        .select(PROJECT_COLS)
        .eq("tenant_id", tenantId)
      if (!includeArchived) query = query.is("archived_at", null)
      // 舊的預先取號空列（reserved_at 非空）還不是案子，一律不進列表，沒有參數可以打開。
      query = query.is("reserved_at", null)
      if (year !== null) query = query.eq("fiscal_year", year)
      if (kinds !== null) query = query.in("kind", kinds)
      // 次要排序固定用 id：主排序值重複（同名／同狀態）時結果仍穩定可測。
      let ordered = query.order(sortColumn, { ascending }).order("id", { ascending: true })
      if (limit !== null) ordered = ordered.limit(limit)
      const { data, error } = await ordered
      if (error) {
        next(new Error(`GET /projects: ${error.message}`))
        return
      }
      // 「有沒有簽約」是衍生的，不另存旗標——旗標與 contracts 會對不起來。
      // 整份列表一次查完，不做 N+1。
      const rows = (data ?? []) as ProjectRow[]
      const ids = rows.map((p) => p.id)
      const [signed, clientNames, companies, parentCodes] = await Promise.all([
        signedProjectIds(tenantId, ids),
        clientNamesById(tenantId, rows.map((p) => p.client_id)),
        loadTenantCompanies(tenantId),
        parentCodesById(tenantId, rows.map((p) => p.parent_project_id)),
      ])

      let register: Map<string, RegisterRow> | null = null
      let registerDisciplines: string[] | null = null
      if (withRegister) {
        const self = req.auth?.userId ? await resolveSelf(tenantId, req.auth.userId) : null
        if (!self) {
          res.status(403).json({ error: "forbidden" })
          return
        }
        const [settings, moneyIds] = await Promise.all([loadP3Settings(tenantId), financeProjectIds(tenantId, self)])
        const annualRows = await buildAnnualRows(tenantId, rows as unknown as AnnualProjectRow[], settings)
        const masked = maskRegisterRows(annualRows, moneyIds)
        register = new Map(masked.map((r) => [r.projectId, r]))
        // 科別欄只由遮罩後的列推（看不到金額的案不會多冒出科別名稱）。
        registerDisciplines = annualDisciplines(settings.disciplines, masked)
      }

      const projects = rows.map((row) => ({
        // 列表一律不回獎金池（W4）：列表沒有逐案算權限，回了等於全租戶都看得到。
        ...serializeProject(row, { finance: false, bonus: false, hasSignedContract: signed.has(row.id) }),
        ...(register ? { register: register.get(row.id) ?? null } : {}),
        clientName: row.client_id ? (clientNames.get(row.client_id) ?? null) : null,
        // 母案的專案編號（母案選填：沒有母案或母案列不見＝null）。parentProjectId 在 serializeProject 裡。
        parentCode: row.parent_project_id ? (parentCodes.get(row.parent_project_id) ?? null) : null,
        // 承接公司的有效名稱：company_id 為 null 的案子顯示租戶預設公司。
        companyName: effectiveCompanyOf(row.company_id, companies)?.name ?? null,
      }))
      res.status(200).json(registerDisciplines ? { projects, registerDisciplines } : { projects })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects — HR／會計 建立專案 ────────────────────────────────
projectsRouter.post(
  "/projects",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      const reasonIssue = parsed.error.issues.find((issue) => issue.message === "override_reason_required")
      if (reasonIssue) {
        const index = reasonIssue.path.find((part) => typeof part === "number")
        const installmentNo = typeof index === "number" ? req.body?.billings?.[index]?.installmentNo : undefined
        res.status(400).json({ error: "override_reason_required", installmentNo })
        return
      }
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const b = parsed.data
    const self = req.auth?.userId ? await resolveSelf(tenantId, req.auth.userId) : null
    if (!self) {
      res.status(403).json({ error: "forbidden" })
      return
    }
    // 會計屬 finance，可建立合約與期款；但獎金池／分潤模式仍是 bonus 權限，
    // 與 PATCH /projects/:id 的規則一致，不可藉由建案端點繞過。
    // 分潤改版 #6（2026-10-26）：寫入分潤只有老闆。HR 建案時帶預設值（pool_pct、無獎金池）
    // 不算改分潤——申請單一律送 shareMode，不能因此讓 HR 建不了案。
    if (b.shareMode !== undefined || b.bonusPool !== undefined) {
      const bonusEdit = await resolveBonusEditAccess(tenantId, self)
      // 看不到分潤的人（會計）帶任何分潤欄位都維持舊行為 403 forbidden_bonus。
      if (!bonusEdit.canEdit && !isHrRole(self.role)) {
        res.status(403).json({ error: "forbidden_bonus" })
        return
      }
      const touchesBonus =
        (b.bonusPool !== undefined && b.bonusPool !== null) ||
        (b.shareMode !== undefined && b.shareMode !== "pool_pct")
      if (touchesBonus && bonusEdit.denial) {
        res.status(bonusEdit.denial.status).json({ error: bonusEdit.denial.error })
        return
      }
    }
    // 2026-10-27：本案各角色分潤趴數只有老闆／platform_admin 可帶（帶 null＝不設定，誰都可以）。
    // 規則比照獎金池：看不到分潤的人（會計）403 forbidden_bonus；HR 403 bonus_edit_boss_only／409 boss_not_configured。
    if (b.sharePctByRole !== undefined && b.sharePctByRole !== null) {
      const bonusEdit = await resolveBonusEditAccess(tenantId, self)
      if (bonusEdit.denial) {
        if (!isHrRole(self.role)) {
          res.status(403).json({ error: "forbidden_bonus" })
          return
        }
        res.status(bonusEdit.denial.status).json({ error: bonusEdit.denial.error })
        return
      }
    }
    const primaryContract: MainContractInput | null =
      b.primaryContract ?? (b.contractAmount !== undefined ? { amount: b.contractAmount } : null)
    const billings: NewBillingInput[] = b.billings ?? []
    const initialSubcontracts = b.initialSubcontracts ?? []
    const seenInstallments = new Set<number>()
    let guildAdvances = 0
    for (const billing of billings) {
      if (seenInstallments.has(billing.installmentNo)) {
        res.status(400).json({ error: "duplicate_installment_no", installmentNo: billing.installmentNo })
        return
      }
      seenInstallments.add(billing.installmentNo)
      if (billing.kind === "guild_advance") guildAdvances += 1
    }
    if (guildAdvances > 1) {
      res.status(400).json({ error: "multiple_guild_advances" })
      return
    }
    const schedule = computeSchedule(billings.map((billing) => ({
      installmentNo: billing.installmentNo,
      kind: billing.kind ?? "installment",
      percentage: billing.percentage ?? null,
      overrideAmount: billing.overrideAmount ?? null,
      billedAmount: null,
      billed: false,
    })), primaryContract?.amount ?? null)
    if (schedule.percentageTotal > 100) {
      res.status(400).json({ error: "billing_percentage_total_exceeded", percentageTotal: schedule.percentageTotal })
      return
    }
    if (schedule.rows.some((row) => row.kind === "installment" && (row.effectiveAmount ?? 0) < 0)) {
      res.status(400).json({ error: "negative_installment_amount" })
      return
    }
    if (billings.length > 0 && schedule.unallocatedResidue !== 0) {
      res.status(400).json({ error: "invalid_billing_total", unallocatedResidue: schedule.unallocatedResidue })
      return
    }
    try {
      if (b.deptId) {
        const { data: department, error: departmentError } = await supabaseAdmin
          .from("departments")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("id", b.deptId)
          .maybeSingle()
        if (departmentError) throw new Error(`POST /projects department validation: ${departmentError.message}`)
        if (!department) {
          res.status(400).json({ error: "invalid_department" })
          return
        }
      }
      if (b.leadEmpId) {
        const { data: leadEmployee, error: leadEmployeeError } = await supabaseAdmin
          .from("employees")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("id", b.leadEmpId)
          .maybeSingle()
        if (leadEmployeeError) throw new Error(`POST /projects lead employee validation: ${leadEmployeeError.message}`)
        if (!leadEmployee) {
          res.status(400).json({ error: "invalid_lead_employee" })
          return
        }
      }
      const engineerVendorIds = Object.values(b.engineers ?? {})
        .map((engineer) => engineer?.vendorId)
        .filter((id): id is string => !!id)
      const vendorIds = [...new Set([
        ...initialSubcontracts.map((item) => item.vendorId).filter((id): id is string => !!id),
        ...engineerVendorIds,
      ])]
      if (vendorIds.length > 0) {
        const { data: vendors, error: vendorError } = await supabaseAdmin
          .from("vendors")
          .select("id")
          .eq("tenant_id", tenantId)
          .in("id", vendorIds)
          .is("deleted_at", null)
        if (vendorError) throw new Error(`POST /projects vendor validation: ${vendorError.message}`)
        const validVendorIds = new Set((vendors ?? []).map((vendor) => vendor.id as string))
        const invalidVendorId = vendorIds.find((id) => !validVendorIds.has(id))
        if (invalidVendorId) {
          res.status(400).json({ error: "invalid_vendor", vendorId: invalidVendorId })
          return
        }
      }

      // 承接公司（申請單左上角）：帶了就必須是本租戶的公司主體，不屬於回 400 invalid_company
      // （不讓它走到 RPC 才變成 500）；已停用的公司不能新選，回 400 company_inactive；
      // 沒帶／帶 null → 租戶預設公司（預設公司一定是啟用的），沒有預設就 null。
      const companies = await loadTenantCompanies(tenantId)
      const companyCheck = checkProjectCompany(companies, b.companyId)
      if (!companyCheck.ok) {
        res.status(400).json(companyErrorBody(companyCheck))
        return
      }
      const companyId = b.companyId ?? defaultCompanyOf(companies)?.id ?? null

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
      // W8：技師的科別 key 必須在租戶設定裡。
      const badDiscipline = await unknownDiscipline(tenantId, b.engineers)
      if (badDiscipline) {
        res.status(400).json({ error: "unknown_discipline", discipline: badDiscipline })
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

      // 本案各角色分潤趴數：省略＝複製租戶的新專案起始值（有非 0 值才複製），之後改起始值不會回頭動到這個案子。
      let sharePctByRole: Record<string, number> | null
      if (b.sharePctByRole !== undefined) {
        sharePctByRole = b.sharePctByRole === null ? null : sharePctMapOf(b.sharePctByRole)
      } else {
        const tenantDefaults = sharePctMapOf(await defaultSharePctByRole(tenantId))
        sharePctByRole = hasNonZeroShare(tenantDefaults) ? tenantDefaults : null
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
        company_id: companyId,
        // migration 0075 之前的建案函式不認得這個鍵，會直接忽略（不會失敗）。
        share_pct_by_role: sharePctByRole,
      }

      const createWithCode = (code: string) => createProjectApplicationAtomic(
        tenantId,
        self.id,
        { ...baseRow, code },
        primaryContract,
        billings,
        initialSubcontracts.map((item, index) => ({
          ...item,
          kind: item.kind ?? "subcontract",
          withholdingRate: item.withholdingRate ?? DEFAULT_WITHHOLDING_RATE,
          withholdingThreshold: item.withholdingThreshold ?? DEFAULT_WITHHOLDING_THRESHOLD,
          sortOrder: item.sortOrder ?? index,
        })),
      )

      // 人工指定編號：只試一次。撞號回 409——人工指定代表那個號有意義，
      // 不該被系統自動換掉。
      if (manualCode) {
        try {
          const inserted = await createWithCode(manualCode)
          res.status(201).json(inserted)
        } catch (error) {
          if (error instanceof AtomicProjectCreationError && isUniqueViolation(error)) {
            res.status(409).json({ error: "code_taken", code: manualCode })
            return
          }
          res.status(500).json({ error: "project_application_create_failed" })
        }
        return
      }

      // 系統產號：MAX(seq)+1 在併發時會撞號，unique index 是真正的保證，
      // 這裡碰到衝突就重算重試——讓 DB 當最後防線，不靠應用層搶。
      const fmt = await loadCodeFormat(tenantId)
      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        const code = await nextProjectCode(tenantId, year, fmt)
        try {
          const inserted = await createWithCode(code)
          res.status(201).json(inserted)
          return
        } catch (error) {
          if (error instanceof AtomicProjectCreationError && isUniqueViolation(error)) continue
          res.status(500).json({ error: "project_application_create_failed" })
          return
        }
      }
      res.status(503).json({ error: "code_generation_failed", attempts: MAX_CODE_ATTEMPTS })
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
 * 專案詳情的三段：basic（全員）／finance（錢）／bonus（分潤）。
 * finance＝HR／會計／該案 lead（欄位或成員角色 lead｜manager）／該案部門主管
 * （`loadScope().canManage`）；bonus＝同上但**不含會計**（`loadScope().canSeeBonus`）。
 * 非 finance：`money:null, billings:[], subcontracts:[], contracts:[]`，
 * 且 project 裡的金額欄位（designScope.amount／otherExpenses）也不帶。
 */
export async function loadProjectDetail(tenantId: string, userId: string, projectId: string) {
  const scope = await loadScope(tenantId, userId, projectId)
  if (!scope.ok) return scope
  const row = scope.project
  const finance = scope.canManage
  const bonus = scope.canSeeBonus
  const [signed, client, settings, companies, sharePctByRole, guildRepaymentNote] = await Promise.all([
    signedProjectIds(tenantId, [row.id]),
    loadClient(tenantId, row.client_id),
    loadP3Settings(tenantId),
    loadTenantCompanies(tenantId),
    bonus ? loadProjectSharePct(tenantId, row.id) : Promise.resolve(null),
    loadProjectGuildRepaymentNote(tenantId, row.id),
  ])
  const project = {
    ...serializeProject(row, { finance, bonus, profit: scope.canSeeProfit, hasSignedContract: signed.has(row.id) }),
    // 本案各角色分潤趴數（2026-10-27）：只給看得到分潤的人（canSeeBonus：老闆／HR／經理／主辦／部門主管）。
    // 趴數本身推不出毛利，所以不限 canSeeProfit。null＝本案未設定（或看不到）。
    sharePctByRole,
    // 申請單「審迄還款」（2026-10-28）：同付款方式，能看專案的人都看得到。欄位未套＝null。
    guildRepaymentNote,
    client: client ? serializeClient(client) : null,
    // 承接公司的有效名稱（申請單／列印頁左上角用）：company_id 為 null 時是租戶預設公司。
    companyName: effectiveCompanyOf(row.company_id, companies)?.name ?? null,
  }
  // editBonus：分潤寫入權（只有老闆／platform_admin）；bossConfigured：租戶是否已指定老闆。
  // profit：專案毛利／毛利率可見性（老闆／platform_admin／授權 HR；2026-10-26 業主決定 2：申請單金額摘要也算集團財務）。
  const access = {
    finance,
    bonus,
    profit: scope.canSeeProfit,
    editBonus: scope.bonusEdit.canEdit,
    bossConfigured: scope.bonusEdit.bossConfigured,
  }
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
    // 毛利（profit）與毛利率屬於集團財務：看不到的人（未授權 HR、會計、專案負責人、部門主管）API 不回。
    money: scope.canSeeProfit ? bundle.money : { ...bundle.money, profit: null, grossMarginPct: null },
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

      // 獎金池屬 bonus 段：會計有 finance 權限但不得改（也看不到）分潤數字。
      if ((b.bonusPool !== undefined || b.shareMode !== undefined) && !scope.canSeeBonus) {
        res.status(403).json({ error: "forbidden_bonus" })
        return
      }
      // 分潤改版 #6：獎金池／分潤模式**真的有變**才算改分潤，只有老闆可以（編輯表單整份送回
      // 原值時不擋，免得 HR 連案名都存不了）。
      const bonusChanged =
        (b.bonusPool !== undefined && (b.bonusPool ?? null) !== num(scope.project.bonus_pool)) ||
        (b.shareMode !== undefined && b.shareMode !== scope.project.share_mode)
      if (bonusChanged && scope.bonusEdit.denial) {
        res.status(scope.bonusEdit.denial.status).json({ error: scope.bonusEdit.denial.error })
        return
      }
      // 2026-10-27：本案各角色分潤趴數——同獎金池，真的有變才算改分潤；會計 forbidden_bonus，其他非老闆 403／409。
      let sharePctChange: { next: Record<string, number> | null } | null = null
      if (b.sharePctByRole !== undefined) {
        if (!(await columnsExist("projects", "share_pct_by_role"))) {
          res.status(409).json({ error: "migration_required", column: "share_pct_by_role" })
          return
        }
        const next = b.sharePctByRole === null ? null : sharePctMapOf(b.sharePctByRole)
        if (!sameSharePctMap(await loadProjectSharePct(tenantId, scope.project.id), next)) {
          if (!scope.canSeeBonus) {
            res.status(403).json({ error: "forbidden_bonus" })
            return
          }
          if (scope.bonusEdit.denial) {
            res.status(scope.bonusEdit.denial.status).json({ error: scope.bonusEdit.denial.error })
            return
          }
          sharePctChange = { next }
        }
      }

      // 2026-10-28 審迄還款：欄位未套（migration 0077）時回 409，整筆不寫（不默默丟掉使用者填的字）。
      if (b.guildRepaymentNote !== undefined && !(await columnsExist("projects", "guild_repayment_note"))) {
        res.status(409).json({ error: "migration_required", column: "guild_repayment_note" })
        return
      }

      const patch: Record<string, unknown> = {}
      if (sharePctChange) patch.share_pct_by_role = sharePctChange.next
      if (b.guildRepaymentNote !== undefined) patch.guild_repayment_note = b.guildRepaymentNote ? b.guildRepaymentNote : null
      if (b.name !== undefined) {
        patch.name = b.name
        // 舊的預先取號空列（功能已移除，僅剩既有資料）一填上真名就是正式的案子了。
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
        // 底下已經有追加／變更／代墊案的主案，不能改成別的案型：它們的母案必須是 main（validateParent
        // 的規則），改了就留下掛在非主案底下的子案。母案改成選填後，改案型不必先選母案，更容易誤觸。
        if (kind !== "main" && (scope.project.kind ?? "main") === "main") {
          const { data: children, error: childErr } = await supabaseAdmin
            .from("projects")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("parent_project_id", scope.project.id)
            .limit(1)
          if (childErr) throw new Error(`PATCH /projects/${scope.project.id} (children): ${childErr.message}`)
          if ((children ?? []).length > 0) {
            res.status(409).json({ error: "has_child_projects" })
            return
          }
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
      // 承接公司：帶 null＝改回沿用租戶預設公司；帶 id 必須是本租戶的公司主體。
      // 改選到已停用的公司回 400 company_inactive；帶的 id 與專案上已存的相同＝沿用（編輯表單
      // 每次存檔都會把目前的承接公司整份送回來，不能因為它後來被停用就連別的欄位都存不了）。
      if (b.companyId !== undefined) {
        const companyCheck = checkProjectCompany(await loadTenantCompanies(tenantId), b.companyId, scope.project.company_id)
        if (!companyCheck.ok) {
          res.status(400).json(companyErrorBody(companyCheck))
          return
        }
        patch.company_id = b.companyId
      }
      if (b.siteAddress !== undefined) patch.site_address = b.siteAddress
      if (b.siteAreaM2 !== undefined) patch.site_area_m2 = b.siteAreaM2
      if (b.designScope !== undefined) patch.design_scope = b.designScope
      if (b.invoiceType !== undefined) patch.invoice_type = b.invoiceType
      if (b.paymentMethod !== undefined) patch.payment_method = b.paymentMethod
      if (b.closingDay !== undefined) patch.closing_day = b.closingDay
      if (b.paymentDay !== undefined) patch.payment_day = b.paymentDay
      if (b.otherExpenses !== undefined) patch.other_expenses = b.otherExpenses ?? 0
      if (b.engineers !== undefined) {
        const badDiscipline = await unknownDiscipline(tenantId, b.engineers)
        if (badDiscipline) {
          res.status(400).json({ error: "unknown_discipline", discipline: badDiscipline })
          return
        }
        patch.engineers = b.engineers
      }

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
      // 封存／解除封存會改變這案進不進獎金批次（封存納入規則）→ 也要重算（best-effort）。
      const archiveChanged =
        Object.prototype.hasOwnProperty.call(patch, "archived_at") &&
        !!patch.archived_at !== !!scope.project.archived_at
      if (bonusChanged || archiveChanged) {
        await recomputeDraftRunsAfterWrite(tenantId, [data.id as string], "PATCH /projects/:id")
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
      // 非管理者只看自己那筆；會計（canManage 但非 bonus）看得到全名單，只是沒有數字。
      if (!scope.canManage) query = query.eq("employee_id", scope.self.id)

      const { data, error } = await query
      if (error) {
        next(new Error(`GET /projects/${req.params.id}/members: ${error.message}`))
        return
      }
      // 估算只在「有數字要給」時才算：看得到分潤，或本人就在名單裡（自己的錢）。
      const needEstimate =
        scope.canSeeBonus || (data ?? []).some((m) => m.employee_id === scope.self.id)
      const estimates = needEstimate
        ? await estimatesByProject(tenantId, [scope.project.id], "GET /projects/:id/members")
        : null
      const est = estimates?.get(scope.project.id)
      // 分潤數字只給 bonus（W4：會計拿得到成員名單，拿不到趴數／金額／獎金池）。
      const members = (data ?? []).map((m) => {
        const emp = rel1<{ name: string; emp_no: string | null }>(
          (m as { employees: unknown }).employees,
        )
        const pct = num(m.share_pct as string | null)
        const amount = num(m.share_amount as string | null)
        const base = {
          id: m.id,
          employeeId: m.employee_id,
          name: emp?.name ?? null,
          empNo: emp?.emp_no ?? null,
          roleInProject: m.role_in_project,
        }
        // 本人那一列一律帶自己的數字——那是他自己的錢，ESS 專案頁靠這個顯示。
        // 只有「看得到全名單但沒有分潤權限」的人（會計）拿到的是純名單。
        if (!scope.canSeeBonus && m.employee_id !== scope.self.id) return base
        // 驗收 #4（2026-10-26）：看得到分潤但看不到毛利的人（經理／主辦／部門主管）只拿得到
        // 別人的角色與趴數——金額（應得／已發／待發／固定金額）會讓人反推出毛利，只留給自己那列。
        // 未授權看集團財務的 HR（2026-10-26 二修）仍看得到每人金額：獎金批次本來就由 HR 試算、送審、發放，
        // 每人金額是發放流程要的數字；他只是看不到毛利／獎金池／獎金比例。
        if (!scope.canSeeProfit && !isHrRole(scope.self.role) && m.employee_id !== scope.self.id) return { ...base, sharePct: pct }
        const me = memberEstimateOf(est, m.employee_id as string)
        return {
          ...base,
          sharePct: pct,
          shareAmount: amount,
          // computedAmount＝截至今天的累計應得（估算服務）；估算不可用時退回舊算法。
          computedAmount: me ? me.estimatedAmount : computeAmount(scope.project, pct, amount),
          estimatedAmount: me?.estimatedAmount ?? null,
          paidAmount: me?.paidAmount ?? null,
          pendingAmount: me?.pendingAmount ?? null,
        }
      })
      res.status(200).json({
        canManage: scope.canManage,
        canSeeBonus: scope.canSeeBonus,
        // 分潤改版 #6：前端據此決定分潤編輯器唯讀與否、提示「僅老闆可修改」或「先指定老闆」。
        canEditBonus: scope.bonusEdit.canEdit,
        bossConfigured: scope.bonusEdit.bossConfigured,
        shareMode: scope.project.share_mode,
        canSeeProfit: scope.canSeeProfit,
        // 獎金池＝估算服務的累計池（毛利制＝max(0,毛利)×比例；舊制＝手填獎金池；固定金額＝null）。
        // 累計池等於洩漏毛利，只給看得到毛利的人（canSeeProfit）。
        bonusPool: scope.canSeeBonus && scope.canSeeProfit ? (est ? est.pool : num(scope.project.bonus_pool)) : null,
        // 獎金比例也只給 canSeeProfit：應得 ÷（比例 × 趴數）就是毛利。
        bonusRatePct: scope.canSeeBonus && scope.canSeeProfit ? num(scope.project.bonus_rate_pct) : null,
        bonusEstimate: scope.canSeeBonus && scope.canSeeProfit && est
          ? {
              basis: est.basis,
              pool: est.pool,
              contractTotal: est.contractTotal,
              revenue: est.revenue,
              cost: est.cost,
              grossProfit: est.grossProfit,
              // 2026-10-27 Excel 含稅入帳制：含稅入帳、稅率、總獎金（含稅合約 × 比例）。
              taxInclusiveRevenue: est.taxInclusiveRevenue,
              vatRate: est.vatRate,
              contractPool: est.contractPool,
              overContractPct: est.overContractPct,
              skipped: est.skipped,
            }
          : null,
        members,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects/:id/members — HR/lead(含 manager)/部門主管 新增成員 ────
/**
 * W3：`roleInProject` 四值（manager 經理／lead 主辦／support 支援／member 組員）。
 * pool_pct 模式下沒帶 `sharePct` 時，依角色套本案的 `projects.share_pct_by_role`（2026-10-27 起每案各自設定；
 * 本案未設定退回租戶的 `project_settings.default_share_pct_by_role`，都沒有＝0）——業主的做法是
 * 「經理幾趴、主辦幾趴」先講好，每次加人不必重打。
 * 守門用 canSeeBonus（**不含會計**）：成員分潤是獎金區。
 */
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
      // 成員與分潤是獎金區：會計（finance 但非 bonus）不得異動。
      if (!scope.canSeeBonus) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const b = parsed.data
      const roleInProject = b.roleInProject ?? "member"
      const isPool = scope.project.share_mode === "pool_pct"
      let sharePct = b.sharePct ?? null
      let shareAmount = b.shareAmount ?? null
      if (scope.bonusEdit.canEdit) {
        // 老闆：pool_pct 且未指定趴數 → 帶本案該角色的趴數（本案未設定退回租戶的新專案起始值，都沒有＝0）。
        if (sharePct === null && isPool) {
          const defaults = await effectiveSharePctByRole(tenantId, scope.project.id)
          sharePct = defaults[roleInProject] ?? 0
        }
      } else {
        // 分潤改版 #6：HR／負責人仍可加人，但趴數一律 0，由老闆另行設定；帶了非 0 的分潤就擋。
        if (!isZeroish(sharePct) || !isZeroish(shareAmount)) {
          res.status(scope.bonusEdit.denial!.status).json({ error: scope.bonusEdit.denial!.error })
          return
        }
        sharePct = isPool ? 0 : null
        shareAmount = isPool ? null : 0
      }
      const { data, error } = await supabaseAdmin
        .from("project_members")
        .insert({
          tenant_id: tenantId,
          project_id: req.params.id,
          employee_id: b.employeeId,
          role_in_project: roleInProject,
          share_pct: sharePct,
          share_amount: shareAmount,
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
        new_value: isPool ? sharePct : shareAmount,
        changed_by_emp_id: scope.self.id,
      })
      await recomputeDraftRunsAfterWrite(tenantId, [req.params.id as string], "POST /projects/:id/members")
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
      // 成員與分潤是獎金區：會計（finance 但非 bonus）不得異動。
      if (!scope.canSeeBonus) {
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
      // 分潤改版 #6：角色可由 HR／負責人調整；趴數／金額**真的有變**才算改分潤，只有老闆可以。
      const shareChanged =
        (b.sharePct !== undefined && !sameShare(b.sharePct, num(current.share_pct as string | null))) ||
        (b.shareAmount !== undefined && !sameShare(b.shareAmount, num(current.share_amount as string | null)))
      if (shareChanged && scope.bonusEdit.denial) {
        res.status(scope.bonusEdit.denial.status).json({ error: scope.bonusEdit.denial.error })
        return
      }
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
      if (shareChanged) {
        await recomputeDraftRunsAfterWrite(tenantId, [req.params.id as string], "PATCH /projects/:id/members/:memberId")
      }

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
      // 成員與分潤是獎金區：會計（finance 但非 bonus）不得異動。
      if (!scope.canSeeBonus) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      // 業主 2026-10-26：移除「趴數或金額 > 0」的成員＝改分潤，只有老闆；趴數 0 的成員 HR／負責人仍可移除。
      if (scope.bonusEdit.denial) {
        const { data: target, error: tErr } = await supabaseAdmin
          .from("project_members")
          .select("id, share_pct, share_amount")
          .eq("tenant_id", tenantId)
          .eq("project_id", req.params.id)
          .eq("id", req.params.memberId)
          .maybeSingle()
        if (tErr) throw new Error(`DELETE member (load): ${tErr.message}`)
        if (!target) {
          res.status(404).json({ error: "not_found" })
          return
        }
        if (!isZeroish(num(target.share_pct as string | null)) || !isZeroish(num(target.share_amount as string | null))) {
          res.status(scope.bonusEdit.denial.status).json({ error: scope.bonusEdit.denial.error })
          return
        }
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
      // 移除成員會改變分配（他的趴數變成未分配）→ 草稿批次跟著重算。
      await recomputeDraftRunsAfterWrite(tenantId, [req.params.id as string], "DELETE /projects/:id/members/:memberId")
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /projects/:id/share-revision — 原子儲存獎金率與整批成員分潤 ────
projectsRouter.put(
  "/projects/:id/share-revision",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = projectShareRevisionSchema.safeParse(req.body)
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
      if (!scope.canSeeBonus) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      // 沒帶 bonusRatePct＝沿用目前的比例（看不到比例的經理／主辦只維護名單時不送這個鍵）。
      const revisionInput = {
        ...parsed.data,
        bonusRatePct: parsed.data.bonusRatePct === undefined ? num(scope.project.bonus_rate_pct) : parsed.data.bonusRatePct,
      }
      // 分潤改版 #6：只有老闆能改獎金比例與趴數。HR／負責人送來的整批版本只能是「成員名單維護」
      // ——加人（趴數 0）、移除、換角色；任何既有成員趴數或獎金比例的變動都擋下。
      if (scope.bonusEdit.denial) {
        const { data: currentMembers, error: curErr } = await supabaseAdmin
          .from("project_members")
          .select("employee_id, share_pct, share_amount")
          .eq("tenant_id", tenantId)
          .eq("project_id", req.params.id)
        if (curErr) throw new Error(`PUT share-revision (load members): ${curErr.message}`)
        const changesShare = shareRevisionChangesShares(
          num(scope.project.bonus_rate_pct),
          (currentMembers ?? []).map((m) => ({
            employeeId: m.employee_id as string,
            sharePct: num(m.share_pct as string | null),
            shareAmount: num(m.share_amount as string | null),
          })),
          revisionInput,
        )
        if (changesShare) {
          res.status(scope.bonusEdit.denial.status).json({ error: scope.bonusEdit.denial.error })
          return
        }
      }
      const result = await applyProjectShareRevision(
        tenantId,
        req.params.id as string,
        scope.self.id,
        revisionInput,
      )
      await recomputeDraftRunsAfterWrite(tenantId, [req.params.id as string], "PUT /projects/:id/share-revision")
      // 獎金比例只給看得到毛利的人（老闆／platform_admin／授權 HR）：經理只維護名單時，後端補上的目前比例不可原樣回傳（可反推毛利）。
      res.status(200).json(scope.canSeeProfit ? result : { ...result, bonusRatePct: null })
    } catch (err) {
      if (err instanceof ProjectShareRevisionError) {
        res.status(err.httpStatus).json({ error: err.code })
        return
      }
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
        .select("id, employee_id, change_set_id, field, old_value, new_value, reason, changed_by_emp_id, created_at, employees(name)")
        .eq("tenant_id", tenantId)
        .eq("project_id", req.params.id)
        .order("created_at", { ascending: false })
      // 分潤異動史是 bonus 段：非 bonus（含會計）只看與自己相關的異動。
      if (!scope.canSeeBonus) query = query.eq("employee_id", scope.self.id)

      const { data, error } = await query
      if (error) {
        next(new Error(`GET /projects/${req.params.id}/adjustments: ${error.message}`))
        return
      }
      const changedByIds = [...new Set((data ?? []).map((a) => a.changed_by_emp_id).filter((id): id is string => !!id))]
      const changedByNames = new Map<string, string>()
      if (changedByIds.length > 0) {
        const { data: actors, error: actorError } = await supabaseAdmin
          .from("employees")
          .select("id, name")
          .eq("tenant_id", tenantId)
          .in("id", changedByIds)
        if (actorError) {
          next(new Error(`GET /projects/${req.params.id}/adjustments actors: ${actorError.message}`))
          return
        }
        for (const actor of actors ?? []) changedByNames.set(actor.id as string, actor.name as string)
      }
      // 驗收（2026-10-26）：看得到分潤但看不到毛利的人（經理／主辦／部門主管）濾掉獎金比例與獎金池
      // 的異動、以及別人的固定金額異動（未授權 HR 例外，金額異動保留）——這些都能反推毛利或別人的金額。自己的異動保留。
      const HIDDEN_FOR_NON_PROFIT = new Set(["bonus_rate", "pool"])
      const visible = (data ?? []).filter((a) => {
        if (scope.canSeeProfit) return true
        if (HIDDEN_FOR_NON_PROFIT.has(a.field as string)) return false
        if (a.field === "amount" && a.employee_id !== scope.self.id && !isHrRole(scope.self.role)) return false
        return true
      })
      const adjustments = visible.map((a) => {
        const emp = rel1<{ name: string }>((a as { employees: unknown }).employees)
        return {
          id: a.id,
          employeeId: a.employee_id,
          changeSetId: a.change_set_id,
          name: emp?.name ?? null,
          changedByEmpId: a.changed_by_emp_id,
          changedByName: a.changed_by_emp_id ? (changedByNames.get(a.changed_by_emp_id) ?? null) : null,
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
      const estimates = await estimatesByProject(
        tenantId,
        [...new Set((data ?? []).map((m) => m.project_id as string))],
        "GET /my/project-shares",
      )
      // 專案毛利只有老闆／platform_admin／授權 HR 看得到（業主 2026-10-26）；一般成員（含經理／主辦／部門主管）不回。
      const canSeeProfit = await canSeeProjectProfit(tenantId, self, await loadProjectBossEmpId(tenantId))
      const shares = (data ?? []).map((m) => {
        const est = estimates?.get(m.project_id as string)
        const mine = memberEstimateOf(est, self.id)
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
          // 分潤改版 #1：預估應得＝估算服務的累計應得；已發＝歷來已發放；待發＝兩者相減（下限 0）。
          computedAmount: mine ? mine.estimatedAmount : projRow ? computeAmount(projRow, pct, amount) : null,
          estimatedAmount: mine?.estimatedAmount ?? null,
          paidAmount: mine?.paidAmount ?? null,
          pendingAmount: mine?.pendingAmount ?? null,
          basis: est?.basis ?? null,
          /** 舊制（手填獎金池，未設獎金比例）——ESS 標「舊制」。 */
          legacy: est ? est.basis === "legacy_pool" : null,
          /** 目前累計毛利（入帳未稅－已發生成本）；只有 canSeeProfit（老闆／platform_admin／授權 HR）拿得到，其他人一律 null。 */
          grossProfit: canSeeProfit && est ? est.grossProfit : null,
        }
      })
      res.status(200).json({ shares, canSeeProfit })
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
    /**
     * W3：四角色的預設分潤趴數（0–100）。2026-10-27 起改稱「新專案起始值」：建案時複製進專案的
     * share_pct_by_role、或專案未設定時的退路；每個專案的實際趴數在專案申請單各自設定。
     * 整鍵覆蓋，不是深合併——少帶一個角色就是把那個角色的預設清掉，UI 一律送完整四鍵。
     */
    defaultSharePctByRole: z
      .record(z.enum(PROJECT_MEMBER_ROLES), z.number().min(0).max(100))
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const SETTINGS_COLS =
  "auto_archive_enabled, auto_archive_months, stamp_duty_rate, stamp_duty_lookback_years, code_prefix, code_year_style, code_seq_digits, vat_rate, disciplines"
/**
 * migration 0050 之後才有 default_share_pct_by_role。⚠️ 與 PROJECT_COLS 同一個坑：
 * 這兩份都必須是**單一字串常值**（不可用 + 或樣板字串相接），否則 supabase-js
 * 推不出列型別，下游的 as SettingsRow 會整個失效。
 */
const SETTINGS_COLS_WITH_SHARE =
  "auto_archive_enabled, auto_archive_months, stamp_duty_rate, stamp_duty_lookback_years, code_prefix, code_year_style, code_seq_digits, vat_rate, disciplines, default_share_pct_by_role"

/** 讀租戶的專案設定列（欄位未套用時退回舊欄位清單）。 */
async function loadSettingsRow(tenantId: string): Promise<SettingsRow | null> {
  const withShare = await columnsExist("project_settings", "default_share_pct_by_role")
  const { data, error } = withShare
    ? await supabaseAdmin.from("project_settings").select(SETTINGS_COLS_WITH_SHARE).eq("tenant_id", tenantId).maybeSingle()
    : await supabaseAdmin.from("project_settings").select(SETTINGS_COLS).eq("tenant_id", tenantId).maybeSingle()
  if (error) throw new Error(`loadSettingsRow: ${error.message}`)
  return (data as SettingsRow | null) ?? null
}

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
  default_share_pct_by_role?: unknown
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
    // 欄位未套用（或沒設定）時回 {}：前端顯示成四格空白，不是 0。
    defaultSharePctByRole: sharePctMapOf(data?.default_share_pct_by_role),
  }
}

/** jsonb → {角色: 趴數}；非四角色的 key、非 0–100 的值一律丟掉。 */
function sharePctMapOf(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const roles = new Set<string>(PROJECT_MEMBER_ROLES)
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!roles.has(key)) continue
    const n = typeof value === "number" ? value : Number(value)
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[key] = n
  }
  return out
}

// ── GET /project-settings — 全員可讀（UI 要顯示「N 個月後自動封存」）──
projectsRouter.get(
  "/project-settings",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const [data, self] = await Promise.all([
        loadSettingsRow(tenantId),
        req.auth?.userId ? resolveSelf(tenantId, req.auth.userId) : Promise.resolve(null),
      ])
      const bonusEdit = self ? await resolveBonusEditAccess(tenantId, self) : null
      // 沒有設定列就回預設值，讓租戶不必先設定就能用。
      // canEditBonus／bossConfigured（分潤改版 #6）：角色預設趴數、建案的分潤欄位只有老闆能改。
      res.status(200).json({
        settings: serializeSettings(data),
        canEditBonus: bonusEdit?.canEdit ?? false,
        bossConfigured: bonusEdit?.bossConfigured ?? false,
      })
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /project-settings — HR 調整；角色預設趴數只有老闆 ───────────────
/**
 * 分潤改版 #6（2026-10-26）：`defaultSharePctByRole` 是分潤設定，只有老闆（或 platform_admin）能改，
 * 老闆不一定是 hr_admin，所以這支不再掛 requireHrAdmin，改在裡面逐欄位判：
 *   • 帶 defaultSharePctByRole → 老闆限定（403 bonus_edit_boss_only／409 boss_not_configured）
 *   • 帶其他欄位（封存、印花稅、編號格式…）→ 仍限 HR（403 forbidden，與 requireHrAdmin 相同）
 */
projectsRouter.put(
  "/project-settings",
  requireAuth,
  requireTenant,
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
      if (!self) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const touchesOther = Object.keys(parsed.data).some((k) => k !== "defaultSharePctByRole")
      if (touchesOther && !isHrRole(self.role)) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (parsed.data.defaultSharePctByRole !== undefined) {
        const bonusEdit = await resolveBonusEditAccess(tenantId, self)
        if (bonusEdit.denial) {
          res.status(bonusEdit.denial.status).json({ error: bonusEdit.denial.error })
          return
        }
      }
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
      if (parsed.data.defaultSharePctByRole !== undefined) {
        if (!(await columnsExist("project_settings", "default_share_pct_by_role"))) {
          res.status(409).json({ error: "migration_required", column: "default_share_pct_by_role" })
          return
        }
        row.default_share_pct_by_role = parsed.data.defaultSharePctByRole
      }

      const { error } = await supabaseAdmin
        .from("project_settings")
        .upsert(row, { onConflict: "tenant_id" })
        .select("tenant_id")
        .single()
      if (error) {
        next(new Error(`PUT /project-settings: ${error.message}`))
        return
      }
      const data = await loadSettingsRow(tenantId)

      await writeAuditLog({
        tenantId,
        tableName: "project_settings",
        action: "UPDATE",
        newRow: parsed.data,
        actorEmpId: self?.id,
        context: "PUT /project-settings",
      })

      const bonusEdit = await resolveBonusEditAccess(tenantId, self)
      res.status(200).json({
        settings: serializeSettings(data),
        canEditBonus: bonusEdit.canEdit,
        bossConfigured: bonusEdit.bossConfigured,
      })
    } catch (err) {
      next(err)
    }
  },
)
