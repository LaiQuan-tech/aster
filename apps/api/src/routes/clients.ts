import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin, requireFinance } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { sanitizeSearchTerm } from "../lib/search-term.js"
import { resolveSelf } from "../middleware/scope.js"
import { isValidTaiwanTaxId, TAX_ID_RE } from "../services/tax-id.js"
import { INVOICE_TYPES, PAYMENT_METHODS } from "../services/project-money.js"
import { CLIENT_COLS, serializeClient, type ClientRow } from "../services/project-application-store.js"
import { CLIENT_CATEGORY_LIST_KEY, checkOptionPick, findOptionList } from "../services/option-lists.js"

export const clientsRouter = Router()

/**
 * B4：`category`、`short_name`（簡稱）欄位獨立加在這裡，不動 `services/project-application-store.ts`
 * 的 `CLIENT_COLS`／`serializeClient`／`ClientRow`（該檔另一批任務同時在改，
 * 這裡改了容易互相打架）。做法：select 時在共用欄位清單後面多接幾欄，
 * 序列化時在共用序列化結果外面再疊一層。
 */
const CLIENT_COLS_EXT = `${CLIENT_COLS}, category, short_name`
type ClientRowExt = ClientRow & { category: string | null; short_name: string | null }
function serializeClientExt(r: ClientRowExt) {
  return { ...serializeClient(r), category: r.category ?? null, shortName: r.short_name ?? null }
}

/**
 * 客戶／業主名冊（P3 專案申請單），比照 vendors.ts 的廠商名冊。
 *
 * - 讀：登入即可（開票對象是全公司都會查的資料）。
 * - 寫：HR 才能新增／修改／軟刪。業主的統編、開票地址與付款慣例會被
 *   合約與請款文件引用，改錯的代價比廠商名冊高，所以收窄到 HR。
 * - 統編：8 碼＋檢查碼**都要過**（與 vendors 只標記不擋不同——業主統編
 *   會印在發票上，發票統編錯了是要作廢重開的）。重複回 409 `tax_id_taken`
 *   （partial unique index `clients_tenant_tax_id_uq` 是最後防線）。
 * - 軟刪：名冊是往來紀錄，不實體刪；已被專案引用的客戶刪了仍能 join 回名字。
 */

const dayField = z.string().trim().max(40).nullable().optional()

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
  taxId: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => v == null || v === "" || TAX_ID_RE.test(v), "統一編號須為 8 碼數字")
    .refine((v) => v == null || v === "" || isValidTaiwanTaxId(v), "統一編號檢查碼錯誤"),
  phone: z.string().trim().max(40).nullable().optional(),
  fax: z.string().trim().max(40).nullable().optional(),
  invoiceAddress: z.string().trim().max(300).nullable().optional(),
  contactName: z.string().trim().max(60).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  invoiceType: z.enum(INVOICE_TYPES).nullable().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  /** 結帳日／付款日：業主慣例多是「每月 25 日結、次月 10 日付」這類自由文字。 */
  closingDay: dayField,
  paymentDay: dayField,
  note: z.string().trim().max(2000).nullable().optional(),
})

function toRow(b: Partial<z.infer<typeof clientBody>>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  const map: Array<[keyof z.infer<typeof clientBody>, string]> = [
    ["name", "name"], ["shortName", "short_name"], ["category", "category"], ["taxId", "tax_id"], ["phone", "phone"], ["fax", "fax"],
    ["invoiceAddress", "invoice_address"], ["contactName", "contact_name"], ["contactPhone", "contact_phone"],
    ["email", "email"], ["invoiceType", "invoice_type"], ["paymentMethod", "payment_method"],
    ["closingDay", "closing_day"], ["paymentDay", "payment_day"], ["note", "note"],
  ]
  for (const [k, col] of map) if (b[k] !== undefined) row[col] = b[k] === "" ? null : b[k]
  return row
}

/** clients 唯一的 unique index 就是統編那個（partial），23505 一律視為統編重複。 */
function isTaxIdConflict(err: { code?: string } | null): boolean {
  return err?.code === "23505"
}

// ── GET /clients?q= ────────────────────────────────────────────────────
clientsRouter.get("/clients", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const q = typeof req.query.q === "string" ? req.query.q.trim() : ""
  try {
    let query = supabaseAdmin.from("clients").select(CLIENT_COLS_EXT).eq("tenant_id", tenantId).is("deleted_at", null)
    if (q) {
      const like = `%${sanitizeSearchTerm(q)}%`
      query = query.or(`name.ilike.${like},short_name.ilike.${like},contact_name.ilike.${like},tax_id.ilike.${like},phone.ilike.${like}`)
    }
    const { data, error } = await query.order("name", { ascending: true })
    if (error) {
      next(new Error(`GET /clients: ${error.message}`))
      return
    }
    res.status(200).json({ clients: (data ?? []).map((r) => serializeClientExt(r as ClientRowExt)) })
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
    const problem = await categoryProblem(tenantId, parsed.data.category, null)
    if (problem) {
      res.status(400).json({ error: problem, category: parsed.data.category })
      return
    }
    const self = userId ? await resolveSelf(tenantId, userId) : null
    const { data, error } = await supabaseAdmin
      .from("clients")
      .insert({ tenant_id: tenantId, created_by_emp_id: self?.id ?? null, ...toRow(parsed.data) })
      .select(CLIENT_COLS_EXT)
      .single()
    if (error || !data) {
      if (isTaxIdConflict(error)) {
        res.status(409).json({ error: "tax_id_taken", taxId: parsed.data.taxId })
        return
      }
      next(new Error(`POST /clients: ${error?.message}`))
      return
    }
    res.status(201).json({ client: serializeClientExt(data as ClientRowExt) })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /clients/:id — HR ────────────────────────────────────────────
clientsRouter.patch("/clients/:id", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
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
    const { data, error } = await supabaseAdmin
      .from("clients")
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .is("deleted_at", null)
      .select(CLIENT_COLS_EXT)
      .maybeSingle()
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
    res.status(200).json({ client: serializeClientExt(data as ClientRowExt) })
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
