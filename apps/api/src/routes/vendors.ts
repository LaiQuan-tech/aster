import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"
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
const COLS =
  "id, tenant_id, name, category, contact_name, title, phone, mobile, email, address, tax_id, website, bank_name, bank_code, bank_account, account_holder, note, card_storage_path, source, created_by_emp_id, created_at, updated_at, deleted_at"
/** 正式庫尚未套 0041 時的退路（見 lib/schema-compat.ts 的部署順序說明）。 */
const COLS_LEGACY =
  "id, tenant_id, name, category, contact_name, title, phone, mobile, email, address, tax_id, website, note, card_storage_path, source, created_by_emp_id, created_at, updated_at, deleted_at"
const BANK_COLS = ["bank_name", "bank_code", "bank_account", "account_holder"]
let bankColsMissing = false

/**
 * 用完整欄位集跑一次；撞到「欄位不存在」就記住並用舊欄位集重跑（寫入時 toRow 會
 * 同步略過銀行欄）。套完 0041 後永遠不會走到第二次。
 */
async function withVendorCols<T>(
  run: (cols: string) => PromiseLike<{ data: T; error: { code?: string | null; message?: string | null } | null }>,
): Promise<{ data: T; error: { code?: string | null; message?: string | null } | null }> {
  let r = await run(bankColsMissing ? COLS_LEGACY : COLS)
  if (r.error && !bankColsMissing && isMissingColumnError(r.error)) {
    bankColsMissing = true
    warnSchemaGapOnce("vendors.bank_*", r.error)
    r = await run(COLS_LEGACY)
  }
  return r
}

const vendorBody = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).nullable().optional(),
  contactName: z.string().trim().max(60).nullable().optional(),
  title: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  mobile: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  taxId: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => v == null || v === "" || TAX_ID_RE.test(v), "統一編號須為 8 碼數字"),
  website: z.string().trim().max(200).nullable().optional(),
  /** 收款帳戶（放款專區預填用）。 */
  bankName: z.string().trim().max(120).nullable().optional(),
  bankCode: z.string().trim().max(20).nullable().optional(),
  bankAccount: z.string().trim().max(60).nullable().optional(),
  accountHolder: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  cardStoragePath: z.string().trim().max(300).nullable().optional(),
  source: z.enum(["manual", "card_ocr"]).optional(),
})

const scanBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().regex(/^image\/(jpeg|png|webp|heic|heif)$/i, "只接受 JPEG / PNG / WebP / HEIC 影像"),
  dataBase64: z.string().min(1),
})

function serialize(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    category: r.category ?? null,
    contactName: r.contact_name ?? null,
    title: r.title ?? null,
    phone: r.phone ?? null,
    mobile: r.mobile ?? null,
    email: r.email ?? null,
    address: r.address ?? null,
    taxId: r.tax_id ?? null,
    taxIdValid: typeof r.tax_id === "string" && r.tax_id ? isValidTaiwanTaxId(r.tax_id) : null,
    website: r.website ?? null,
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

function toRow(b: z.infer<typeof vendorBody>): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  const map: Array<[keyof typeof b, string]> = [
    ["name", "name"], ["category", "category"], ["contactName", "contact_name"], ["title", "title"],
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
    const { data, error } = await withVendorCols((cols) => {
      let query = supabaseAdmin.from("vendors").select(cols).eq("tenant_id", tenantId).is("deleted_at", null)
      if (q) {
        const like = `%${q.replace(/[%_]/g, "")}%`
        query = query.or(`name.ilike.${like},contact_name.ilike.${like},category.ilike.${like},tax_id.ilike.${like},phone.ilike.${like},mobile.ilike.${like}`)
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
    const { data, error } = await withVendorCols((cols) =>
      supabaseAdmin
        .from("vendors")
        .insert({ tenant_id: tenantId, created_by_emp_id: self?.id ?? null, ...toRow(parsed.data) })
        .select(cols)
        .single(),
    )
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
    const { data, error } = await withVendorCols((cols) =>
      supabaseAdmin
        .from("vendors")
        .update({ ...toRow(parsed.data as z.infer<typeof vendorBody>), updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .select(cols)
        .maybeSingle(),
    )
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
