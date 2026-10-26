import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin, requireFinance } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { sanitizeSearchTerm } from "../lib/search-term.js"
import { isHrRole, resolveSelf } from "../middleware/scope.js"
import { isValidTaiwanTaxId, TAX_ID_RE } from "../services/tax-id.js"
import { INVOICE_TYPES, PAYMENT_METHODS } from "../services/project-money.js"
import { CLIENT_COLS, serializeClient, type ClientRow } from "../services/project-application-store.js"
import { CLIENT_CATEGORY_LIST_KEY, checkOptionPick, findOptionList } from "../services/option-lists.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { logger } from "../lib/logger.js"

export const clientsRouter = Router()

/**
 * B4：`category`、`short_name`（簡稱）欄位獨立加在這裡，不動 `services/project-application-store.ts`
 * 的 `CLIENT_COLS`／`serializeClient`／`ClientRow`（該檔另一批任務同時在改，
 * 這裡改了容易互相打架）。做法：select 時在共用欄位清單後面多接幾欄，
 * 序列化時在共用序列化結果外面再疊一層。
 *
 * 2026-10-11：`is_affiliate`（關係企業，packages/db 0062，已套正式庫）同樣疊在這裡——
 * 集團總覽（services/group-overview.ts）的集團合計會剔除「客戶是關係企業的專案收入」。
 */
const CLIENT_COLS_EXT = `${CLIENT_COLS}, category, short_name, is_affiliate`
type ClientRowExt = ClientRow & {
  category: string | null
  short_name: string | null
  is_affiliate: boolean | null
  seq?: number | null
  region?: string | null
  code?: string | null
}
function serializeClientExt(r: ClientRowExt) {
  return {
    ...serializeClient(r),
    category: r.category ?? null,
    shortName: r.short_name ?? null,
    isAffiliate: r.is_affiliate === true,
    seq: typeof r.seq === "number" ? r.seq : null,
    region: r.region ?? null,
    code: r.code ?? null,
  }
}

/**
 * 2026-10-27 名冊對齊 Excel「客供商基本資料／客戶資料」（packages/db 0076）：序、區域、編號。
 * 部署順序不限：先帶新欄位查，撞到「欄位不存在」就記住（60 秒後再試）改用舊欄位集重跑——
 * 列表不回新欄位；寫入帶了非空的新欄位回 409 migration_required（空值直接略過）。
 */
const ROSTER_COLS = "seq, region, code"
const ROSTER_FIELDS = [["seq", "seq"], ["region", "region"], ["code", "code"]] as const
const ROSTER_RETRY_MS = 60_000
let rosterMissingAt = 0
const rosterKnownMissing = () => rosterMissingAt > 0 && Date.now() - rosterMissingAt < ROSTER_RETRY_MS
/** 測試用：清掉「0076 沒套」的記憶。 */
export function resetClientSchemaCompatForTests(): void {
  rosterMissingAt = 0
}
type DbResult<T> = { data: T; error: { code?: string | null; message?: string | null } | null }
const MIGRATION_REQUIRED_CODE = "migration_required"
async function withClientCols<T>(run: (cols: string, roster: boolean) => PromiseLike<DbResult<T>>): Promise<DbResult<T>> {
  const roster = !rosterKnownMissing()
  let r = await run(roster ? `${CLIENT_COLS_EXT}, ${ROSTER_COLS}` : CLIENT_COLS_EXT, roster)
  if (r.error && roster && isMissingColumnError(r.error)) {
    rosterMissingAt = Date.now()
    warnSchemaGapOnce("clients.seq/region/code(0076)", r.error)
    r = await run(CLIENT_COLS_EXT, false)
  }
  return r
}
function migrationBlocked<T>(): PromiseLike<DbResult<T>> {
  return Promise.resolve({ data: null as T, error: { code: MIGRATION_REQUIRED_CODE, message: "migration_required" } })
}
const MIGRATION_REQUIRED = (columns: string[]) => ({ error: MIGRATION_REQUIRED_CODE, columns, message: "名冊新欄位（序、區域、編號）尚未套用資料庫更新（migration 0076）。" })

/**
 * 客戶／業主名冊（P3 專案申請單），比照 vendors.ts 的廠商名冊。
 *
 * - 讀：登入即可（開票對象是全公司都會查的資料）。
 * - 寫：HR 才能新增／修改／軟刪。業主的統編、開票地址與付款慣例會被
 *   合約與請款文件引用，改錯的代價比廠商名冊高，所以收窄到 HR。
 * - 統編：8 碼＋檢查碼**都要過**（與 vendors 只標記不擋不同——業主統編
 *   會印在發票上，發票統編錯了是要作廢重開的）。2026-10-28（migration 0078）起同一統編可對應多個客戶名稱
 *   （同公司不同對外名稱）：重複照常存檔，回應附 `warnings: [{ code: "tax_id_shared", taxId, clients }]` 提示；
 *   0078 還沒套時 DB 唯一索引仍在，撞到就照舊回 409 `tax_id_taken`。
 * - 軟刪：名冊是往來紀錄，不實體刪；已被專案引用的客戶刪了仍能 join 回名字。
 */

const dayField = z.string().trim().max(40).nullable().optional()

/**
 * 「關係企業」標記會改變集團總覽的集團合計（剔除這家客戶的專案收入），所以只有 HR／平台管理員能設定或變更；
 * 會計（requireFinance 放行）仍可照常維護其他欄位。重送跟現值一樣的值不算變更。
 */
const AFFILIATE_HR_ONLY = { error: "affiliate_hr_only", message: "只有 HR 管理員可以設定「關係企業」標記。" } as const

/**
 * 客戶分類（B4）：合法值是租戶「選項清單 → 客戶分類」（`option_items`，list_key＝client_category）裡**啟用**的
 * code，管理員可自行新增（見 services/option-lists.ts）。DB 的 `clients_category_chk` 已拿掉（sql/0048），
 * 改在寫入時依清單驗證——`categoryProblem()`：
 *   • 新選或改選到停用的項目 → 400 `category_inactive`；不存在的 code → 400 `invalid_category`；
 *   • 沿用這個客戶已存的值不擋（即使該分類後來被停用），舊客戶才改得了別的欄位；
 *   • 不選（null）永遠可以。
 */
const CATEGORY_LIST = findOptionList(CLIENT_CATEGORY_LIST_KEY)

/** 這次寫入的分類有問題就回錯誤碼；沒問題回 null。`stored`＝這個客戶現在存的分類（新建客戶沒有＝null）。 */
async function categoryProblem(
  tenantId: string,
  picked: string | null | undefined,
  stored: string | null,
): Promise<"invalid_category" | "category_inactive" | null> {
  if (!CATEGORY_LIST) throw new Error(`option list ${CLIENT_CATEGORY_LIST_KEY} is not registered`)
  const verdict = await checkOptionPick(tenantId, CATEGORY_LIST, picked, stored)
  if (verdict === "unknown") return "invalid_category"
  if (verdict === "inactive") return "category_inactive"
  return null
}

const clientBody = z.object({
  name: z.string().trim().min(1).max(200),
  /** 簡稱：列表／下拉顯示與搜尋用，最長 40 字，可空（空字串視為清除）。 */
  shortName: z.string().trim().max(40).nullable().optional(),
  /** 分類 code（選項清單 client_category 的 code；預設有建築師／技師／業主／政府機關／其他）。可空——既有名冊未必補得回。 */
  category: z.string().trim().min(1).max(100).nullable().optional(),
  /** 關係企業（集團內姊妹公司）：集團總覽合計時剔除與它的往來。DB 欄位 NOT NULL，所以只收 boolean，不收 null。 */
  isAffiliate: z.boolean().optional(),
  taxId: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => v == null || v === "" || TAX_ID_RE.test(v), "統一編號須為 8 碼數字")
    .refine((v) => v == null || v === "" || isValidTaiwanTaxId(v), "統一編號檢查碼錯誤"),
  /** Excel「序」「區域」「編號」（0076）。 */
  seq: z.number().int().min(0).max(99999).nullable().optional(),
  region: z.string().trim().max(40).nullable().optional(),
  code: z.string().trim().max(40).nullable().optional(),
  /** TEL／FAX／Mobil（contactPhone）原格可能有多支號碼與說明，放寬到 200 字。 */
  phone: z.string().trim().max(200).nullable().optional(),
  fax: z.string().trim().max(200).nullable().optional(),
  /** Excel「公司地址」。 */
  invoiceAddress: z.string().trim().max(300).nullable().optional(),
  /** Excel「承辦窗口」：原格常是多位窗口＋分機的一段文字，放寬到 300 字。 */
  contactName: z.string().trim().max(300).nullable().optional(),
  contactPhone: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(500).nullable().optional(),
  invoiceType: z.enum(INVOICE_TYPES).nullable().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  /** 結帳日／付款日：業主慣例多是「每月 25 日結、次月 10 日付」這類自由文字。 */
  closingDay: dayField,
  paymentDay: dayField,
  note: z.string().trim().max(2000).nullable().optional(),
})

function toRow(b: Partial<z.infer<typeof clientBody>>, roster = true): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  const map: Array<[keyof z.infer<typeof clientBody>, string]> = [
    ...ROSTER_FIELDS.filter(() => roster).map(([k, col]) => [k, col] as [keyof z.infer<typeof clientBody>, string]),
    ["name", "name"], ["shortName", "short_name"], ["category", "category"], ["isAffiliate", "is_affiliate"], ["taxId", "tax_id"], ["phone", "phone"], ["fax", "fax"],
    ["invoiceAddress", "invoice_address"], ["contactName", "contact_name"], ["contactPhone", "contact_phone"],
    ["email", "email"], ["invoiceType", "invoice_type"], ["paymentMethod", "payment_method"],
    ["closingDay", "closing_day"], ["paymentDay", "payment_day"], ["note", "note"],
  ]
  for (const [k, col] of map) if (b[k] !== undefined) row[col] = b[k] === "" ? null : b[k]
  return row
}

/** 0076 沒套時：body 裡非空的新欄位（有就該回 409）。 */
function rosterFieldsPresent(b: Partial<z.infer<typeof clientBody>>): string[] {
  return ROSTER_FIELDS.filter(([k]) => {
    const v = b[k]
    return v !== undefined && v !== null && v !== ""
  }).map(([, col]) => col)
}

/**
 * 同租戶、未軟刪、統編相同的其他客戶（排除自己）。用來在回應附「統編與誰相同」的提示——不擋存檔。
 */
async function clientsSharingTaxId(tenantId: string, taxId: string | null | undefined, selfId: string | null): Promise<Array<{ id: string; name: string }>> {
  if (!taxId) return []
  let query = supabaseAdmin.from("clients").select("id, name").eq("tenant_id", tenantId).eq("tax_id", taxId).is("deleted_at", null)
  if (selfId) query = query.neq("id", selfId)
  const { data, error } = await query
  if (error) throw new Error(`clientsSharingTaxId: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; name: string }>).map((r) => ({ id: r.id, name: r.name }))
}
/** 存檔已成功才查的提示：查詢失敗不影響存檔結果（記 warn、不附提示），不能回 500 讓前端以為沒存。 */
async function sharedTaxIdHint(tenantId: string, taxId: string | null | undefined, selfId: string): Promise<Array<{ id: string; name: string }>> {
  try {
    return await clientsSharingTaxId(tenantId, taxId, selfId)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), tenantId, clientId: selfId }, "clients: 同統編提示查詢失敗，略過提示")
    return []
  }
}
const taxWarnings = (taxId: string | null | undefined, shared: Array<{ id: string; name: string }>) =>
  shared.length > 0 ? { warnings: [{ code: "tax_id_shared", taxId, clients: shared }] } : {}

/** 0078 前 clients 唯一的 unique index 就是統編那個（partial），23505 一律視為統編重複。 */
function isTaxIdConflict(err: { code?: string | null } | null): boolean {
  return err?.code === "23505"
}

// ── GET /clients?q= ────────────────────────────────────────────────────
clientsRouter.get("/clients", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const q = typeof req.query.q === "string" ? req.query.q.trim() : ""
  try {
    const { data, error } = await withClientCols((cols) => {
      let query = supabaseAdmin.from("clients").select(cols).eq("tenant_id", tenantId).is("deleted_at", null)
      if (q) {
        const like = `%${sanitizeSearchTerm(q)}%`
        query = query.or(`name.ilike.${like},short_name.ilike.${like},contact_name.ilike.${like},tax_id.ilike.${like},phone.ilike.${like}`)
      }
      return query.order("name", { ascending: true })
    })
    if (error) {
      next(new Error(`GET /clients: ${error.message}`))
      return
    }
    res.status(200).json({ clients: (data ?? []).map((r) => serializeClientExt(r as unknown as ClientRowExt)) })
  } catch (err) {
    next(err)
  }
})

// ── POST /clients — HR ─────────────────────────────────────────────────
clientsRouter.post("/clients", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const parsed = clientBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const self = userId ? await resolveSelf(tenantId, userId) : null
    if (parsed.data.isAffiliate === true && !isHrRole(self?.role)) {
      res.status(403).json(AFFILIATE_HR_ONLY)
      return
    }
    const problem = await categoryProblem(tenantId, parsed.data.category, null)
    if (problem) {
      res.status(400).json({ error: problem, category: parsed.data.category })
      return
    }
    const present = rosterFieldsPresent(parsed.data)
    const { data, error } = await withClientCols((cols, roster) =>
      !roster && present.length > 0
        ? migrationBlocked()
        : supabaseAdmin
            .from("clients")
            .insert({ tenant_id: tenantId, created_by_emp_id: self?.id ?? null, ...toRow(parsed.data, roster) })
            .select(cols)
            .single(),
    )
    if (error?.code === MIGRATION_REQUIRED_CODE) {
      res.status(409).json(MIGRATION_REQUIRED(present))
      return
    }
    if (error || !data) {
      if (isTaxIdConflict(error)) {
        res.status(409).json({ error: "tax_id_taken", taxId: parsed.data.taxId })
        return
      }
      next(new Error(`POST /clients: ${error?.message}`))
      return
    }
    const created = serializeClientExt(data as ClientRowExt)
    const shared = await sharedTaxIdHint(tenantId, created.taxId, created.id)
    res.status(201).json({ client: created, ...taxWarnings(created.taxId, shared) })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /clients/:id — HR ────────────────────────────────────────────
clientsRouter.patch("/clients/:id", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const id = req.params.id as string
  const parsed = clientBody.partial().safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  const row = toRow(parsed.data)
  if (Object.keys(row).length === 0) {
    res.status(400).json({ error: "no_fields" })
    return
  }
  try {
    // 關係企業標記只有 HR 能「變更」：非 HR 帶了這個欄位就比對現值，不同 → 403；一樣＝沒變更，放行，
    // 但這個欄位從 update 剔除（不把一個可能已被 HR 並發改掉的舊值寫回去）。
    if (parsed.data.isAffiliate !== undefined) {
      const self = userId ? await resolveSelf(tenantId, userId) : null
      if (!isHrRole(self?.role)) {
        const { data: stored, error: storedError } = await supabaseAdmin
          .from("clients")
          .select("is_affiliate")
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .is("deleted_at", null)
          .maybeSingle()
        if (storedError) {
          next(new Error(`PATCH /clients/${id} (load is_affiliate): ${storedError.message}`))
          return
        }
        // 查無這個客戶就往下走，由下面的 update 回 404。
        if (stored && ((stored as { is_affiliate?: boolean | null }).is_affiliate === true) !== parsed.data.isAffiliate) {
          res.status(403).json(AFFILIATE_HR_ONLY)
          return
        }
        delete row.is_affiliate
      }
    }
    // 改選分類才要比對清單；先讀這個客戶現在存的值，沿用原值（即使已停用）不擋。
    if (parsed.data.category) {
      const { data: current, error: currentError } = await supabaseAdmin
        .from("clients")
        .select("category")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle()
      if (currentError) {
        next(new Error(`PATCH /clients/${id} (load category): ${currentError.message}`))
        return
      }
      const stored = ((current as { category?: string | null } | null)?.category ?? null) as string | null
      const problem = await categoryProblem(tenantId, parsed.data.category, stored)
      if (problem) {
        res.status(400).json({ error: problem, category: parsed.data.category })
        return
      }
    }
    const present = rosterFieldsPresent(parsed.data)
    const { data, error } = await withClientCols((cols, roster) => {
      if (!roster && present.length > 0) return migrationBlocked()
      const update = { ...row }
      if (!roster) for (const [, col] of ROSTER_FIELDS) delete update[col]
      return supabaseAdmin
        .from("clients")
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .select(cols)
        .maybeSingle()
    })
    if (error?.code === MIGRATION_REQUIRED_CODE) {
      res.status(409).json(MIGRATION_REQUIRED(present))
      return
    }
    if (error) {
      if (isTaxIdConflict(error)) {
        res.status(409).json({ error: "tax_id_taken", taxId: parsed.data.taxId })
        return
      }
      next(new Error(`PATCH /clients/${id}: ${error.message}`))
      return
    }
    if (!data) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const updated = serializeClientExt(data as ClientRowExt)
    // 只在這次有動統編時提示（改別的欄位不重複提醒）
    const shared = parsed.data.taxId ? await sharedTaxIdHint(tenantId, updated.taxId, updated.id) : []
    res.status(200).json({ client: updated, ...taxWarnings(updated.taxId, shared) })
  } catch (err) {
    next(err)
  }
})

// ── DELETE /clients/:id — HR 軟刪 ──────────────────────────────────────
clientsRouter.delete("/clients/:id", requireAuth, requireTenant, requireHrAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  try {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle()
    if (error) {
      next(new Error(`DELETE /clients/${id}: ${error.message}`))
      return
    }
    if (!data) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ id })
  } catch (err) {
    next(err)
  }
})
