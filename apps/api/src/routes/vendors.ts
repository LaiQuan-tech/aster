import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { sanitizeSearchTerm } from "../lib/search-term.js"
import { isHrRole, resolveSelf } from "../middleware/scope.js"
import { generateJson, GeminiNotConfiguredError, isGeminiConfigured } from "../lib/gemini.js"
import { isValidTaiwanTaxId, TAX_ID_RE } from "../services/tax-id.js"
import { isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"

export const vendorsRouter = Router()

/**
 * 廠商名冊 + 名片建檔。
 * - 名冊全租戶可讀寫（往來窗口是大家都會用的資料）；刪除（軟刪）限 HR。
 * - 名片：影像存私有 bucket vendor-cards，送 Gemini 抽欄位。抽出來的永遠是
 *   「建議值」，前端帶進表單讓人確認後才 POST /vendors；系統不會自己新增廠商。
 *   沒設 GEMINI_API_KEY 時 /card-scan 回 503，名冊本身照常可用。
 */

const BUCKET = "vendor-cards"
const MAX_BYTES = 8 * 1024 * 1024
// 收款帳戶四欄（bank_*／account_holder）由 packages/db 0041 加入，放款專區建立匯款時預填。
// short_name（簡稱）由 0060 加入，已套正式庫，直接 select（比照 clients.short_name，不另做退路）。
// is_affiliate（關係企業）由 0062 加入，同樣已套正式庫：集團總覽的集團合計會剔除「付給關係企業廠商的放款」。
const COLS =
  "id, tenant_id, name, short_name, is_affiliate, category, contact_name, title, phone, mobile, email, address, tax_id, website, bank_name, bank_code, bank_account, account_holder, note, card_storage_path, source, created_by_emp_id, created_at, updated_at, deleted_at"
/** 正式庫尚未套 0041 時的退路（見 lib/schema-compat.ts 的部署順序說明）。 */
const COLS_LEGACY =
  "id, tenant_id, name, category, contact_name, title, phone, mobile, email, address, tax_id, website, note, card_storage_path, source, created_by_emp_id, created_at, updated_at, deleted_at"
const BANK_COLS = ["bank_name", "bank_code", "bank_account", "account_holder"]
let bankColsMissing = false

/**
 * 2026-10-27 名冊對齊 Excel「客供商基本資料」（packages/db 0076）：名冊類別（工作表）、序、細目、編號、FAX、付款方式。
 * 部署順序不限：先帶新欄位查，撞到「欄位不存在」就記住（60 秒後再試一次帶新欄位），改用舊欄位集重跑——
 * 列表不回新欄位（rosterKind 一律當 supplier），寫入帶了非空的新欄位回 409 migration_required（空值直接略過）。
 */
const ROSTER_COLS = "roster_kind, seq, sub_category, code, fax, payment_terms"
export const VENDOR_ROSTER_KINDS = ["supplier", "engineer", "review_unit"] as const
const ROSTER_FIELDS = [
  ["rosterKind", "roster_kind"], ["seq", "seq"], ["subCategory", "sub_category"], ["code", "code"], ["fax", "fax"], ["paymentTerms", "payment_terms"],
] as const

const ROSTER_RETRY_MS = 60_000
let rosterMissingAt = 0
const rosterKnownMissing = () => rosterMissingAt > 0 && Date.now() - rosterMissingAt < ROSTER_RETRY_MS
/** 測試用：清掉「0076／0041 沒套」的記憶。 */
export function resetVendorSchemaCompatForTests(): void {
  rosterMissingAt = 0
  bankColsMissing = false
}

type DbResult<T> = { data: T; error: { code?: string | null; message?: string | null } | null }
const MIGRATION_REQUIRED_CODE = "migration_required"

/**
 * 用完整欄位集跑一次；撞到「欄位不存在」就記住並用舊欄位集重跑（寫入時 toRow 會
 * 同步略過銀行欄）。套完 0041 後永遠不會走到第二次。`roster`＝這一次是否帶 0076 新欄位。
 */
async function withVendorCols<T>(
  run: (cols: string, roster: boolean) => PromiseLike<DbResult<T>>,
): Promise<DbResult<T>> {
  const roster = !bankColsMissing && !rosterKnownMissing()
  let r = await run(bankColsMissing ? COLS_LEGACY : roster ? `${COLS}, ${ROSTER_COLS}` : COLS, roster)
  // 缺的是銀行欄（0041 都沒套）→ 0076 當然也沒有，直接退到最舊的欄位集；其他「欄位不存在」先當成 0076 沒套。
  const bankMissing = (e: { message?: string | null } | null) => BANK_COLS.some((col) => (e?.message ?? "").includes(col))
  if (r.error && roster && isMissingColumnError(r.error) && !bankMissing(r.error)) {
    rosterMissingAt = Date.now()
    warnSchemaGapOnce("vendors.roster_*(0076)", r.error)
    r = await run(COLS, false)
  }
  if (r.error && !bankColsMissing && isMissingColumnError(r.error)) {
    if (roster) rosterMissingAt = Date.now()
    bankColsMissing = true
    warnSchemaGapOnce("vendors.bank_*", r.error)
    r = await run(COLS_LEGACY, false)
  }
  return r
}

/**
 * 0076 沒套時：body 裡非空的新欄位（有就該回 409）；空值（null／""）直接從寫入剔除，不擋舊畫面或清空的表單。
 * 名冊類別等於預設值 supplier 也視為沒帶——表單永遠會送 rosterKind，沒套前所有廠商本來就都是供應商。
 */
function rosterFieldsPresent(b: Partial<z.infer<typeof vendorBody>>): string[] {
  return ROSTER_FIELDS.filter(([k]) => {
    const v = b[k]
    if (k === "rosterKind" && v === "supplier") return false
    return v !== undefined && v !== null && v !== ""
  }).map(([, col]) => col)
}
const MIGRATION_REQUIRED = (columns: string[]) => ({ error: MIGRATION_REQUIRED_CODE, columns, message: "名冊新欄位（序、細目、編號、FAX、付款方式、名冊類別）尚未套用資料庫更新（migration 0076）。" })
/** 寫入在「0076 沒套」那一輪：帶了非空新欄位就不寫，回一個假錯誤讓路由回 409。 */
function migrationBlocked<T>(): PromiseLike<DbResult<T>> {
  return Promise.resolve({ data: null as T, error: { code: MIGRATION_REQUIRED_CODE, message: "migration_required" } })
}

const vendorBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** 簡稱：列表／下拉顯示與搜尋用，最長 40 字，可空（空字串視為清除）。 */
  shortName: z.string().trim().max(40).nullable().optional(),
  /** 關係企業（集團內姊妹公司）：集團總覽合計時剔除與它的往來。DB 欄位 NOT NULL，所以只收 boolean，不收 null。 */
  isAffiliate: z.boolean().optional(),
  /** 名冊類別＝Excel 工作表（0076）：supplier 供應商資料 | engineer 技師資料 | review_unit 送審相關單位。DB NOT NULL，不收 null。 */
  rosterKind: z.enum(VENDOR_ROSTER_KINDS).optional(),
  /** Excel「序」（0076）。 */
  seq: z.number().int().min(0).max(99999).nullable().optional(),
  /** Excel「類別」。 */
  category: z.string().trim().max(60).nullable().optional(),
  /** Excel「細目」（0076）。 */
  subCategory: z.string().trim().max(60).nullable().optional(),
  /** Excel「編號」（0076）。 */
  code: z.string().trim().max(40).nullable().optional(),
  /** Excel「承辦窗口」：原格常是多位窗口＋分機的一段文字，放寬到 300 字。 */
  contactName: z.string().trim().max(300).nullable().optional(),
  title: z.string().trim().max(60).nullable().optional(),
  /** TEL／FAX／Mobil 原格可能有多支號碼與說明，放寬到 200 字。 */
  phone: z.string().trim().max(200).nullable().optional(),
  fax: z.string().trim().max(200).nullable().optional(),
  mobile: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(500).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  taxId: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => v == null || v === "" || TAX_ID_RE.test(v), "統一編號須為 8 碼數字"),
  website: z.string().trim().max(200).nullable().optional(),
  /** Excel「付款方式」（0076），自由文字。 */
  paymentTerms: z.string().trim().max(100).nullable().optional(),
  /** 收款帳戶（放款專區預填用）。 */
  bankName: z.string().trim().max(120).nullable().optional(),
  bankCode: z.string().trim().max(20).nullable().optional(),
  bankAccount: z.string().trim().max(60).nullable().optional(),
  accountHolder: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  cardStoragePath: z.string().trim().max(300).nullable().optional(),
  source: z.enum(["manual", "card_ocr"]).optional(),
})

/**
 * 「關係企業」標記會改變集團總覽的集團合計（剔除付給這家廠商的放款），所以只有 HR／平台管理員能設定或變更；
 * 廠商名冊其他欄位仍是全租戶可寫。重送跟現值一樣的值不算變更。
 */
const AFFILIATE_HR_ONLY = { error: "affiliate_hr_only", message: "只有 HR 管理員可以設定「關係企業」標記。" } as const

const scanBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().regex(/^image\/(jpeg|png|webp|heic|heif)$/i, "只接受 JPEG / PNG / WebP / HEIC 影像"),
  dataBase64: z.string().min(1),
})

function serialize(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    shortName: r.short_name ?? null,
    isAffiliate: r.is_affiliate === true,
    rosterKind: (VENDOR_ROSTER_KINDS as readonly string[]).includes(r.roster_kind as string) ? r.roster_kind : "supplier",
    seq: typeof r.seq === "number" ? r.seq : null,
    category: r.category ?? null,
    subCategory: r.sub_category ?? null,
    code: r.code ?? null,
    contactName: r.contact_name ?? null,
    title: r.title ?? null,
    phone: r.phone ?? null,
    fax: r.fax ?? null,
    mobile: r.mobile ?? null,
    email: r.email ?? null,
    address: r.address ?? null,
    taxId: r.tax_id ?? null,
    taxIdValid: typeof r.tax_id === "string" && r.tax_id ? isValidTaiwanTaxId(r.tax_id) : null,
    website: r.website ?? null,
    paymentTerms: r.payment_terms ?? null,
    bankName: r.bank_name ?? null,
    bankCode: r.bank_code ?? null,
    bankAccount: r.bank_account ?? null,
    accountHolder: r.account_holder ?? null,
    note: r.note ?? null,
    hasCard: !!r.card_storage_path,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toRow(b: z.infer<typeof vendorBody>, roster = true): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  const map: Array<[keyof typeof b, string]> = [
    ...ROSTER_FIELDS.filter(() => roster).map(([k, col]) => [k, col] as [keyof typeof b, string]),
    ["name", "name"], ["shortName", "short_name"], ["isAffiliate", "is_affiliate"], ["category", "category"], ["contactName", "contact_name"], ["title", "title"],
    ["phone", "phone"], ["mobile", "mobile"], ["email", "email"], ["address", "address"],
    ["taxId", "tax_id"], ["website", "website"],
    ["bankName", "bank_name"], ["bankCode", "bank_code"], ["bankAccount", "bank_account"], ["accountHolder", "account_holder"],
    ["note", "note"], ["cardStoragePath", "card_storage_path"], ["source", "source"],
  ]
  for (const [k, col] of map) {
    if (b[k] === undefined) continue
    if (bankColsMissing && BANK_COLS.includes(col)) continue
    row[col] = b[k] === "" ? null : b[k]
  }
  return row
}

// ── GET /vendors?q= ────────────────────────────────────────────────────
vendorsRouter.get("/vendors", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const q = typeof req.query.q === "string" ? req.query.q.trim() : ""
  try {
    const { data, error } = await withVendorCols((cols, roster) => {
      let query = supabaseAdmin.from("vendors").select(cols).eq("tenant_id", tenantId).is("deleted_at", null)
      if (q) {
        const like = `%${sanitizeSearchTerm(q)}%`
        // 0076 已套時多比對「細目」（類別改放 Excel 的大類後，細目才是辨識廠商的關鍵字）。
        query = query.or(`name.ilike.${like},short_name.ilike.${like},contact_name.ilike.${like},category.ilike.${like},tax_id.ilike.${like},phone.ilike.${like},mobile.ilike.${like}${roster ? `,sub_category.ilike.${like}` : ""}`)
      }
      return query.order("name", { ascending: true })
    })
    if (error) {
      next(new Error(`GET /vendors: ${error.message}`))
      return
    }
    res.status(200).json({ vendors: (data ?? []).map((r) => serialize(r as unknown as Record<string, unknown>)) })
  } catch (err) {
    next(err)
  }
})

// ── POST /vendors ──────────────────────────────────────────────────────
vendorsRouter.post("/vendors", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const parsed = vendorBody.safeParse(req.body)
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
    const present = rosterFieldsPresent(parsed.data)
    const { data, error } = await withVendorCols((cols, roster) =>
      !roster && present.length > 0
        ? migrationBlocked()
        : supabaseAdmin
            .from("vendors")
            .insert({ tenant_id: tenantId, created_by_emp_id: self?.id ?? null, ...toRow(parsed.data, roster) })
            .select(cols)
            .single(),
    )
    if (error?.code === MIGRATION_REQUIRED_CODE) {
      res.status(409).json(MIGRATION_REQUIRED(present))
      return
    }
    if (error || !data) {
      next(new Error(`POST /vendors: ${error?.message}`))
      return
    }
    res.status(201).json({ vendor: serialize(data as unknown as Record<string, unknown>) })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /vendors/:id ─────────────────────────────────────────────────
vendorsRouter.patch("/vendors/:id", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const id = req.params.id as string
  const parsed = vendorBody.partial().safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  if (Object.keys(toRow(parsed.data as z.infer<typeof vendorBody>)).length === 0) {
    res.status(400).json({ error: "no_fields" })
    return
  }
  try {
    const present = rosterFieldsPresent(parsed.data)
    // 關係企業標記只有 HR 能「變更」：非 HR 帶了這個欄位就比對現值，不同 → 403；一樣＝沒變更，放行，
    // 但這個欄位從 update 剔除（不把一個可能已被 HR 並發改掉的舊值寫回去）。
    let dropAffiliate = false
    if (parsed.data.isAffiliate !== undefined) {
      const self = userId ? await resolveSelf(tenantId, userId) : null
      if (!isHrRole(self?.role)) {
        const { data: stored, error: storedError } = await supabaseAdmin
          .from("vendors")
          .select("is_affiliate")
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .is("deleted_at", null)
          .maybeSingle()
        if (storedError) {
          next(new Error(`PATCH /vendors/${id} (load is_affiliate): ${storedError.message}`))
          return
        }
        // 查無這個廠商就往下走，由下面的 update 回 404。
        if (stored && ((stored as { is_affiliate?: boolean | null }).is_affiliate === true) !== parsed.data.isAffiliate) {
          res.status(403).json(AFFILIATE_HR_ONLY)
          return
        }
        dropAffiliate = true
      }
    }
    const { data, error } = await withVendorCols((cols, roster) => {
      if (!roster && present.length > 0) return migrationBlocked()
      const row = toRow(parsed.data as z.infer<typeof vendorBody>, roster)
      if (dropAffiliate) delete row.is_affiliate
      return supabaseAdmin
        .from("vendors")
        .update({ ...row, updated_at: new Date().toISOString() })
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
      next(new Error(`PATCH /vendors/${id}: ${error.message}`))
      return
    }
    if (!data) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ vendor: serialize(data as unknown as Record<string, unknown>) })
  } catch (err) {
    next(err)
  }
})

// ── DELETE /vendors/:id — HR 軟刪 ──────────────────────────────────────
vendorsRouter.delete("/vendors/:id", requireAuth, requireTenant, requireHrAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  try {
    const { data, error } = await supabaseAdmin
      .from("vendors")
      .update({ deleted_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle()
    if (error) {
      next(new Error(`DELETE /vendors/${id}: ${error.message}`))
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

// ── GET /vendors/:id/card — 名片影像的短效簽名 URL ──────────────────────
vendorsRouter.get("/vendors/:id/card", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  try {
    const { data } = await supabaseAdmin.from("vendors").select("card_storage_path").eq("tenant_id", tenantId).eq("id", id).maybeSingle()
    if (!data?.card_storage_path) {
      res.status(404).json({ error: "no_card" })
      return
    }
    const { data: signed, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(data.card_storage_path as string, 3600)
    if (error || !signed) {
      next(new Error(`GET /vendors/${id}/card: ${error?.message}`))
      return
    }
    res.status(200).json({ url: signed.signedUrl })
  } catch (err) {
    next(err)
  }
})

/** Gemini 抽出來的欄位（全部可空；模型讀不到就 null）。 */
interface CardFields {
  company?: string | null
  contactName?: string | null
  title?: string | null
  phone?: string | null
  mobile?: string | null
  email?: string | null
  address?: string | null
  taxId?: string | null
  website?: string | null
  category?: string | null
}

const CARD_SYSTEM = `你是名片資料擷取器。使用者會給一張名片影像，請只回一個 JSON 物件，鍵固定為：
company（公司／單位名稱）、contactName（人名）、title（職稱）、phone（市話，含區碼）、mobile（手機）、
email、address、taxId（統一編號，8 碼數字，沒有就 null）、website、category（依名片內容推測的行業別，短詞，例如「印刷」「建材」「顧問」）。
讀不到的欄位一律 null。不要編造；電話與 email 要照影像上的字元原樣。統一編號只在影像明確印有「統一編號」或「統編」時才填。`

// ── POST /vendors/card-scan — 上傳名片影像並抽欄位（不建檔）───────────
vendorsRouter.post("/vendors/card-scan", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = scanBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "gemini_not_configured", message: "未設定 GEMINI_API_KEY，名片辨識不可用；可手動建檔。" })
    return
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(parsed.data.dataBase64, "base64")
  } catch {
    res.status(400).json({ error: "invalid_base64" })
    return
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    res.status(413).json({ error: "file_too_large", maxBytes: MAX_BYTES })
    return
  }
  try {
    const ext = (parsed.data.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
    const path = `${tenantId}/${crypto.randomUUID()}${ext}`
    const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, bytes, { contentType: parsed.data.contentType })
    if (upErr) {
      next(new Error(`POST /vendors/card-scan (upload): ${upErr.message}`))
      return
    }
    let fields: CardFields = {}
    let model = ""
    try {
      const out = await generateJson<CardFields>(CARD_SYSTEM, "請擷取這張名片的欄位。", {
        images: [{ mimeType: parsed.data.contentType, data: parsed.data.dataBase64 }],
        temperature: 0,
      })
      fields = out.data ?? {}
      model = out.model
    } catch (err) {
      if (err instanceof GeminiNotConfiguredError) {
        res.status(503).json({ error: "gemini_not_configured" })
        return
      }
      // 影像存了但辨識失敗：回路徑讓人手填，不要讓上傳白費
      res.status(200).json({ cardStoragePath: path, fields: {}, model: null, warning: err instanceof Error ? err.message : "recognition_failed" })
      return
    }
    const taxId = typeof fields.taxId === "string" ? fields.taxId.replace(/\D/g, "") : null
    res.status(200).json({
      cardStoragePath: path,
      model,
      fields: {
        name: fields.company ?? null,
        contactName: fields.contactName ?? null,
        title: fields.title ?? null,
        phone: fields.phone ?? null,
        mobile: fields.mobile ?? null,
        email: fields.email ?? null,
        address: fields.address ?? null,
        taxId: taxId && TAX_ID_RE.test(taxId) ? taxId : null,
        taxIdValid: taxId && TAX_ID_RE.test(taxId) ? isValidTaiwanTaxId(taxId) : null,
        website: fields.website ?? null,
        category: fields.category ?? null,
      },
    })
  } catch (err) {
    next(err)
  }
})
