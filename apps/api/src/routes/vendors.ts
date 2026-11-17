import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLogStrict } from "../services/audit.js"
import { vendorHasOpenDisbursements, vendorHasUnpaidInstallments } from "../services/vendor-unpaid.js"
import { compareRosterKeySets, exactNameKey, invalidNameMessage, rosterVendorKeys, type RosterKeySets } from "../lib/payee-name.js"
import { selectAllPages } from "../lib/select-all-pages.js"
import { sanitizeSearchTerm } from "../lib/search-term.js"
import { isFinanceRole, isHrRole, resolveSelf } from "../middleware/scope.js"
import { generateJson, GeminiNotConfiguredError, isGeminiConfigured } from "../lib/gemini.js"
import { isValidTaiwanTaxId, TAX_ID_RE } from "../services/tax-id.js"
import { columnsExist, isMissingColumnError, warnSchemaGapOnce } from "../lib/schema-compat.js"
import { BankChangeError, createBankChangeRequest, vendorHasPendingBankChange, vendorsWithPendingBankChange, type BankFields } from "../services/vendor-bank-change.js"

export const vendorsRouter = Router()

/**
 * 廠商名冊 + 名片建檔。
 * - 名冊全租戶可讀（往來窗口是大家都會用的資料），但收款帳戶四欄只給會計與 HR、其他人回 null；新增／修改／名片辨識限會計與 HR（requireFinance：
 *   hr_admin、platform_admin、accountant，2026-10-27 業主決定——一般員工、主管只能讀）；刪除（軟刪）限 HR。
 *   vendors 只有這支 router 會寫（報銷、放款、專案發包只存 vendor_id／名稱，不回寫名冊）。
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
 * 會計仍可維護其他欄位。重送跟現值一樣的值不算變更。
 */
const AFFILIATE_HR_ONLY = { error: "affiliate_hr_only", message: "只有 HR 可以設定「關係企業」標記。" } as const

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

/**
 * 收款帳戶四欄（銀行名稱／代碼／帳號／戶名）只給會計與 HR（2026-10-27 業主決定）；其他角色讀名冊時遮成 null。
 * 寫入端點本來就限 requireFinance，回應不用遮。
 */
export function maskVendorBank<T extends Record<string, unknown>>(v: T): T {
  return { ...v, bankName: null, bankCode: null, bankAccount: null, accountHolder: null }
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
    const userId = req.auth?.userId
    const self = userId ? await resolveSelf(tenantId, userId) : null
    const canSeeBank = isFinanceRole(self?.role)
    const vendors: Array<ReturnType<typeof serialize> & { bankVerified?: boolean; bankChangePending?: boolean }> = (data ?? []).map((r) => serialize(r as unknown as Record<string, unknown>))
    // 2026-11-17：帳戶是否經第二人確認（0104）；放款建單畫面據此提示「帳戶尚待確認，無法送審」。查不到不擋列表。
    // 只有帶 ?bankVerified=1 才查（放款建單畫面用），一般名冊列表不多打一次查詢。
    if (req.query.bankVerified === "1" && vendors.length > 0 && (await columnsExist("vendors", "bank_verified_at").catch(() => false))) {
      const verified = await selectAllPages<{ id: string; bank_verified_at: string | null }>(
        (from, to) => supabaseAdmin.from("vendors").select("id, bank_verified_at").eq("tenant_id", tenantId).is("deleted_at", null).order("id").range(from, to),
        "vendors (bank_verified_at)",
      ).catch(() => null)
      if (verified) {
        const map = new Map(verified.map((v) => [v.id, v.bank_verified_at]))
        for (const v of vendors) if (map.has(v.id as string)) v.bankVerified = map.get(v.id as string) != null
      }
      // F7：帳戶變更覆核中（名冊列表／內頁顯示狀態、建單畫面提示）。
      const pending = await vendorsWithPendingBankChange(tenantId, vendors.map((v) => v.id as string)).catch(() => null)
      if (pending) for (const v of vendors) v.bankChangePending = pending.has(String(v.id).toLowerCase())
    }
    res.status(200).json({ vendors: canSeeBank ? vendors : vendors.map(maskVendorBank) })
  } catch (err) {
    next(err)
  }
})

// ── POST /vendors ──────────────────────────────────────────────────────
vendorsRouter.post("/vendors", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const parsed = vendorBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  const invalidName = invalidVendorName(parsed.data)
  if (invalidName) {
    res.status(400).json(invalidName)
    return
  }
  try {
    const self = userId ? await resolveSelf(tenantId, userId) : null
    if (parsed.data.isAffiliate === true && !isHrRole(self?.role)) {
      res.status(403).json(AFFILIATE_HR_ONLY)
      return
    }
    const identity: RosterIdentity = { name: parsed.data.name, short_name: parsed.data.shortName ?? null, account_holder: parsed.data.accountHolder ?? null }
    const dup = await duplicateVendorName(tenantId, identity, null, null)
    if (dup?.kind === "exact") {
      res.status(409).json(vendorNameDuplicateBody(dup.vendors[0]?.name ?? ""))
      return
    }
    // 第八輪：名稱相近 → 須帶 confirmDistinctReason；帶了就先寫嚴格稽核（寫不進去就不建），id 先產好讓稽核對得到這筆。
    const newId = crypto.randomUUID()
    if (dup?.kind === "similar") {
      const reason = confirmDistinctReasonOf(req)
      if (!reason) {
        res.status(409).json(vendorNameSimilarBody(dup))
        return
      }
      await writeAuditLogStrict({
        tenantId,
        tableName: "vendors",
        recordId: newId,
        action: "INSERT",
        oldRow: null,
        newRow: { ...identity, confirmDistinctVendor: true, similarVendorIds: dup.vendors.map((v) => v.id), similarVendorNames: dup.vendors.map((v) => v.name), confirmDistinctReason: reason },
        actorEmpId: self?.id ?? null,
        context: "POST /vendors 名稱與名冊廠商相近（確認為不同公司）",
      })
    }
    const present = rosterFieldsPresent(parsed.data)
    // 驗收 H2（2026-11-17）：新建廠商帶的收款帳戶不直接寫進名冊——廠商照建（銀行欄位留空、bank_verified_at 空），
    // 另建「帳戶登錄待覆核」，老闆／平台管理員（非申請人）核准後才寫入並視為已確認。
    const norm = (v: unknown) => {
      const t = typeof v === "string" ? v.trim() : ""
      return t === "" ? null : t
    }
    const sentBank = Object.fromEntries(BANK_FIELDS.map(([k, col]) => [col, norm(parsed.data[k])])) as BankFields
    const hasSentBank = Object.values(sentBank).some((v) => v !== null)
    const verifiedCol = await columnsExist("vendors", "bank_verified_at")
    const { data, error } = await withVendorCols((cols, roster) => {
      if (!roster && present.length > 0) return migrationBlocked()
      const row = toRow(parsed.data, roster)
      for (const [, col] of BANK_FIELDS) delete row[col]
      if (verifiedCol) row.bank_verified_at = null
      return supabaseAdmin
        .from("vendors")
        .insert({ id: newId, tenant_id: tenantId, created_by_emp_id: self?.id ?? null, ...row })
        .select(cols)
        .single()
    })
    if (error?.code === MIGRATION_REQUIRED_CODE) {
      res.status(409).json(MIGRATION_REQUIRED(present))
      return
    }
    if (error || !data) {
      next(new Error(`POST /vendors: ${error?.message}`))
      return
    }
    if (hasSentBank) {
      try {
        const created = await createBankChangeRequest({
          tenantId,
          vendorId: newId,
          vendorName: parsed.data.name,
          requestedByEmpId: self?.id ?? null,
          before: { bank_code: null, bank_name: null, bank_account: null, account_holder: null },
          after: sentBank,
          reason: null,
          context: "POST /vendors 新建廠商帶收款帳戶 → 送雙人覆核",
        })
        res.status(201).json({
          vendor: serialize(data as unknown as Record<string, unknown>),
          bankChangeRequested: true,
          bankChangeRequest: { id: created.id, status: "pending" },
          message: "廠商已建立；收款帳戶已送老闆／平台管理員 覆核，核准後才寫入名冊",
        })
      } catch (err) {
        // 廠商已建好（沒有帳戶）；帳戶申請失敗 → 回 201 並告知，讓使用者到廠商頁重填帳戶。
        res.status(201).json({
          vendor: serialize(data as unknown as Record<string, unknown>),
          bankChangeRequested: false,
          bankChangeError: err instanceof BankChangeError ? err.code : "bank_change_request_failed",
          message: "廠商已建立，但收款帳戶沒有送出覆核，請到廠商頁重新填寫帳戶",
        })
      }
      return
    }
    res.status(201).json({ vendor: serialize(data as unknown as Record<string, unknown>) })
  } catch (err) {
    next(err)
  }
})

const BANK_FIELDS: Array<[keyof z.infer<typeof vendorBody>, string]> = [
  ["bankCode", "bank_code"], ["bankName", "bank_name"], ["bankAccount", "bank_account"], ["accountHolder", "account_holder"],
]

/**
 * R3 第五輪（2026-11-17）：名冊名稱／帳戶戶名不可含不可見字元（零寬、變體選擇符、組合符號、韓文填充字、格式字元…）；
 * 第六輪 F2：也不可拉丁字母混用西里爾／希臘字母。合法回 null，否則回 400 本文。
 * stored（PATCH）：只檢查這次值有變的欄位（與現值相同＝原樣存檔，不回溯舊資料）。
 */
function invalidVendorName(
  body: Partial<z.infer<typeof vendorBody>>,
  stored?: { name: string | null; short_name: string | null; account_holder: string | null } | null,
): { error: "invalid_vendor_name"; message: string } | null {
  const changed = (v: string | null | undefined, cur: string | null | undefined) =>
    v !== undefined && (stored == null || (v === "" ? null : v) !== (cur ?? null))
  const fields: Array<[string | null | undefined, string | null | undefined]> = [
    [body.name, stored?.name], [body.shortName, stored?.short_name], [body.accountHolder, stored?.account_holder],
  ]
  for (const [v, cur] of fields) {
    if (!changed(v, cur)) continue
    const message = invalidNameMessage(v)
    if (message) return { error: "invalid_vendor_name", message }
  }
  return null
}

/**
 * 名冊重名（第六輪 F1；第七輪改比全部 key；第八輪拆兩級）：
 * 只拿「這次新增的 key」（新資料的 rosterVendorKeys 減掉自己舊資料已有的；新增廠商、或名稱 exact key 有變＝全部，第九輪 A）
 * 去比同租戶其他每家未刪廠商（第九輪 H-2：exact 只看名稱；簡稱／戶名只到相近；H-1：相近含「包含」）：
 * - exact（exactNameKey，只差空白／全形／標點／大小寫／臺台）有交集 → kind "exact"（409 vendor_name_duplicate，硬擋）；
 * - similar（去公司後綴、分公司、括號段…）有交集 → kind "similar"（409 vendor_name_similar；帶 confirmDistinctReason 放行＋嚴格稽核）。
 * 既有撞名不回溯：自己舊資料就有的 key 不拿來比，避免改電話之類的欄位或別家改名時卡住無辜方。沒撞到回 null。
 */
type RosterIdentity = { name: string | null; short_name: string | null; account_holder: string | null }
type RosterNameHit = { kind: "exact" | "similar"; vendors: Array<{ id: string; name: string }> }
async function duplicateVendorName(tenantId: string, next: RosterIdentity, selfId: string | null, prev: RosterIdentity | null): Promise<RosterNameHit | null> {
  const nextKeys = rosterVendorKeys(next)
  // 第九輪 A：名稱的 exact key 有變（改名）→ 整組 key 重新比對（不只新增的 key；自己那筆在下面排除）；
  // 名稱沒變、只改簡稱／戶名 → 只比這次新增的 key（既有撞名不回溯）。
  const renamed = !prev || exactNameKey(prev.name) !== exactNameKey(next.name)
  const prevKeys: RosterKeySets = prev && !renamed ? rosterVendorKeys(prev) : { exact: [], similar: [], full: [] }
  const mine: RosterKeySets = {
    exact: nextKeys.exact.filter((k) => !prevKeys.exact.includes(k)),
    similar: nextKeys.similar.filter((k) => !prevKeys.similar.includes(k)),
    full: nextKeys.full.filter((k) => !prevKeys.full.includes(k)),
    fullHay: nextKeys.fullHay,
    // 第十輪「名稱包含」只看名稱：名稱沒變（只改簡稱／戶名）就不比，改名或新增才比。
    ...(renamed
      ? { name: nextKeys.name, nameHay: nextKeys.nameHay, nameParen: nextKeys.nameParen, f4Suffix: nextKeys.f4Suffix }
      : { name: [], nameHay: [], nameParen: null, f4Suffix: null }),
    // 收尾輪 F1／F2：名稱／簡稱的核心——只拿這次新增的（只改簡稱時就是新簡稱的核心）。
    patterns: (nextKeys.patterns ?? []).filter((p) => !(prevKeys.patterns ?? []).includes(p)),
    // 2026-11-17 英文中間字複數：只拿這次新增的複數變化 key。
    plural: (nextKeys.plural ?? []).filter((p) => !(prevKeys.plural ?? []).includes(p)),
  }
  if (
    mine.exact.length === 0 && mine.similar.length === 0 && mine.full.length === 0 && (mine.name ?? []).length === 0 &&
    (mine.patterns ?? []).length === 0 && (mine.plural ?? []).length === 0
  ) return null
  const roster = await selectAllPages<{ id: string; name: string | null; short_name: string | null; account_holder: string | null }>(
    (from, to) =>
      supabaseAdmin
        .from("vendors")
        .select("id, name, short_name, account_holder")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .order("id")
        .range(from, to),
    "vendors (duplicate name)",
  )
  const isSelf = (v: { id: string }) => !!selfId && v.id.toLowerCase() === selfId.toLowerCase()
  const exact: Array<{ id: string; name: string }> = []
  const similar: Array<{ id: string; name: string }> = []
  for (const v of roster) {
    if (isSelf(v) || (v.name ?? "").trim() === "") continue
    const kind = compareRosterKeySets(mine, rosterVendorKeys(v))
    if (kind === "exact") exact.push({ id: v.id, name: v.name ?? "" })
    else if (kind === "similar") similar.push({ id: v.id, name: v.name ?? "" })
  }
  if (exact.length > 0) return { kind: "exact", vendors: exact }
  if (similar.length > 0) return { kind: "similar", vendors: similar }
  return null
}
const vendorNameDuplicateBody = (existing: string) => ({
  error: "vendor_name_duplicate",
  matchedVendorName: existing,
  message: `名冊已有同名廠商「${existing}」`,
})
const vendorNameSimilarBody = (hit: RosterNameHit) => ({
  error: "vendor_name_similar",
  matchedVendorName: hit.vendors[0]?.name ?? "",
  matchedVendorNames: hit.vendors.map((v) => v.name),
  message: `名冊已有名稱相近的廠商「${hit.vendors[0]?.name ?? ""}」；若是同一家請直接使用該廠商，若確為不同公司請填寫說明`,
})
/** 第八輪：相近名稱的確認原因（req.body.confirmDistinctReason，trim 後非空才算）。 */
function confirmDistinctReasonOf(req: Request): string {
  const raw = (req.body as { confirmDistinctReason?: unknown } | undefined)?.confirmDistinctReason
  return typeof raw === "string" ? raw.trim().slice(0, 500) : ""
}

type BankChangeCheck = {
  /** 名稱（trim 後不同）與收款帳戶同時改、且有未付款項 → 409 vendor_identity_change。 */
  identityBlocked: boolean
  /** 改了收款帳戶、且有未作廢未匯款的放款單 → 409 vendor_has_open_disbursements。 */
  openDisbursements: boolean
  /** 改了收款帳戶、只有未付期款（沒有開單）→ 須帶 changeReason 並寫稽核。 */
  needsReason: boolean
  /** 改到的收款帳戶欄位（寫稽核用）。 */
  before: Record<string, string | null> | null
  /** 收款帳戶值有變。 */
  bankChanged: boolean
  /** 2026-11-17 雙人覆核：改了收款帳戶且有未付期款（沒有開單）→ 不直接生效，建「帳戶變更待覆核」（第一次補帳戶也一樣）。 */
  needsReview: boolean
  /** 該廠商已有一筆待覆核帳戶變更 → 409 vendor_bank_change_pending。 */
  pendingReview: boolean
  /** 改後的收款帳戶四欄（沒帶的欄位＝現值）；建覆核申請用。 */
  after: BankFields | null
  /** 廠商現名（通知用）。 */
  vendorName: string | null
}

/**
 * 名冊 PATCH 改收款帳戶的防線（2026-11-16 R2 第四輪）。只在任一收款帳戶欄位（代碼／銀行名／帳號／戶名）值有變時才查。
 * 未付期款：見 services/vendor-unpaid.ts（第六輪起與應付清單一致：有付款日＝已付、排除歸檔專案與金額 0 的期款）。
 * 開單：未作廢未匯款（draft／pending_approval／approved）的放款單。查無廠商回全 false（交給後面的 update 回 404）。
 */
async function checkBankChange(tenantId: string, vendorId: string, body: Partial<z.infer<typeof vendorBody>>): Promise<BankChangeCheck> {
  const none: BankChangeCheck = {
    identityBlocked: false, openDisbursements: false, needsReason: false, before: null,
    bankChanged: false, needsReview: false, pendingReview: false, after: null, vendorName: null,
  }
  if (!BANK_FIELDS.some(([k]) => body[k] !== undefined)) return none
  if (bankColsMissing) return none
  const { data: stored, error } = await supabaseAdmin
    .from("vendors")
    .select("name, bank_code, bank_name, bank_account, account_holder")
    .eq("tenant_id", tenantId)
    .eq("id", vendorId)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`PATCH /vendors/${vendorId} (load identity): ${error.message}`)
  if (!stored) return none
  const cur = stored as Record<string, string | null>
  const norm = (v: unknown) => {
    const t = typeof v === "string" ? v.trim() : ""
    return t === "" ? null : t
  }
  const bankChanged = BANK_FIELDS.some(([k, col]) => body[k] !== undefined && norm(body[k]) !== norm(cur[col]))
  if (!bankChanged) return none
  const nameChanged = body.name !== undefined && norm(body.name) !== norm(cur.name)

  const hasOpen = await vendorHasOpenDisbursements(tenantId, vendorId, `PATCH /vendors/${vendorId}`)
  const hasUnpaid = await vendorHasUnpaidInstallments(tenantId, vendorId, `PATCH /vendors/${vendorId}`)

  const before = Object.fromEntries(BANK_FIELDS.map(([, col]) => [col, cur[col] ?? null]))
  // 第六輪 U1：名冊第一次補帳戶（原本代碼／銀行名／帳號三欄皆空）不需要變更原因。
  const firstFill = ["bank_code", "bank_name", "bank_account"].every((col) => norm(cur[col]) === null)
  const after = Object.fromEntries(
    BANK_FIELDS.map(([k, col]) => [col, body[k] !== undefined ? norm(body[k]) : (cur[col] ?? null)]),
  ) as BankFields
  return {
    identityBlocked: nameChanged && (hasOpen || hasUnpaid),
    openDisbursements: hasOpen,
    // 驗收後（2026-11-17，取代「有未付才要原因」）：改帳戶一律要原因；第一次補帳戶免。
    needsReason: !firstFill,
    before,
    bankChanged: true,
    // 驗收 H1：「有未付才覆核」可先把期款標已付來繞過 → 任何帳戶寫入一律走雙人覆核（第一次補也是）。
    needsReview: true,
    pendingReview: await vendorHasPendingBankChange(tenantId, vendorId),
    after,
    vendorName: cur.name ?? null,
  }
}

// ── PATCH /vendors/:id ─────────────────────────────────────────────────
vendorsRouter.patch("/vendors/:id", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
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
    // 名冊把廠商整筆改成另一家（2026-11-16）：同一次同時改名稱與收款帳戶，等於把這筆 vendor_id 換成另一家公司；
    // 掛在這個 vendor_id 上的未付期款／未匯款的放款單會跟著匯到新帳戶 → 有未付款項時 409 vendor_identity_change。
    // R2 第四輪：只改帳戶也要擋——有未匯款放款單 → 409；只有未付期款 → 須填變更原因（寫稽核）。
    // 第七輪：改了名稱、簡稱或帳戶戶名任一 → 比對其他廠商；第八輪：只比這次新增的 key，exact 硬擋、similar 需說明。
    const nameBody = parsed.data as Partial<z.infer<typeof vendorBody>>
    let similarAudit: (() => Promise<void>) | null = null
    if (nameBody.name !== undefined || nameBody.shortName !== undefined || nameBody.accountHolder !== undefined) {
      const { data: stored, error: storedErr } = await supabaseAdmin
        .from("vendors")
        .select("name, short_name, account_holder")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle()
      if (storedErr) {
        next(new Error(`PATCH /vendors/${id} (load names): ${storedErr.message}`))
        return
      }
      // 2026-11-17：名稱類驗證只對這次值有變的欄位（未變的原樣存檔不擋）；查無廠商（stored 為 null）整組檢查。
      const invalidName = invalidVendorName(nameBody, (stored as RosterIdentity | null) ?? null)
      if (invalidName) {
        res.status(400).json(invalidName)
        return
      }
      // 查無這個廠商就往下走，由下面的 update 回 404。
      if (stored) {
        const cur = stored as RosterIdentity
        const next_: RosterIdentity = {
          name: nameBody.name !== undefined ? nameBody.name : cur.name,
          short_name: nameBody.shortName !== undefined ? nameBody.shortName ?? null : cur.short_name,
          account_holder: nameBody.accountHolder !== undefined ? nameBody.accountHolder ?? null : cur.account_holder,
        }
        const dup = await duplicateVendorName(tenantId, next_, id, cur)
        if (dup?.kind === "exact") {
          res.status(409).json(vendorNameDuplicateBody(dup.vendors[0]?.name ?? ""))
          return
        }
        if (dup?.kind === "similar") {
          const reason = confirmDistinctReasonOf(req)
          if (!reason) {
            res.status(409).json(vendorNameSimilarBody(dup))
            return
          }
          // 稽核在其餘檢查都過之後、update 之前寫（嚴格：寫不進去就不改）。
          similarAudit = async () => {
            const actor = userId ? await resolveSelf(tenantId, userId) : null
            await writeAuditLogStrict({
              tenantId,
              tableName: "vendors",
              recordId: id,
              action: "UPDATE",
              oldRow: cur,
              newRow: { ...next_, confirmDistinctVendor: true, similarVendorIds: dup.vendors.map((v) => v.id), similarVendorNames: dup.vendors.map((v) => v.name), confirmDistinctReason: reason },
              actorEmpId: actor?.id ?? null,
              context: "PATCH /vendors/:id 名稱與名冊廠商相近（確認為不同公司）",
            })
          }
        }
      }
    }
    const bankCheck = await checkBankChange(tenantId, id, parsed.data)
    if (bankCheck.identityBlocked) {
      res.status(409).json({
        error: "vendor_identity_change",
        message: "同時更改廠商名稱與帳戶，且仍有未付款項。若是換成另一家公司，請新增廠商",
      })
      return
    }
    if (bankCheck.openDisbursements) {
      res.status(409).json({
        error: "vendor_has_open_disbursements",
        message: "此廠商仍有未匯款的放款單，請先作廢或匯款後再更改收款帳戶",
      })
      return
    }
    if (bankCheck.pendingReview) {
      res.status(409).json({
        error: "vendor_bank_change_pending",
        message: "此廠商已有一筆收款帳戶變更待覆核，請等覆核完成或取消後再改",
      })
      return
    }
    const rawReason = (req.body as { changeReason?: unknown } | undefined)?.changeReason
    const changeReason = typeof rawReason === "string" ? rawReason.trim() : ""
    if (bankCheck.needsReason && !changeReason) {
      res.status(400).json({
        error: "change_reason_required",
        message: "更改收款帳戶請填寫變更原因（會送老闆／平台管理員 覆核）",
      })
      return
    }
    if (similarAudit) await similarAudit()
    // 2026-11-17 雙人覆核（驗收後：任何帳戶寫入都走覆核）：收款帳戶四欄從 update 剔除，其他欄位照常存；
    // 驗收 D：先存其他欄位（migration／欄位檢查都在這一步），成功後才建「帳戶變更待覆核」——不留孤兒申請。
    const wantsBankChange = bankCheck.needsReview && !!bankCheck.before && !!bankCheck.after
    const { data, error } = await withVendorCols((cols, roster) => {
      if (!roster && present.length > 0) return migrationBlocked()
      const row = toRow(parsed.data as z.infer<typeof vendorBody>, roster)
      if (dropAffiliate) delete row.is_affiliate
      for (const [, col] of BANK_FIELDS) delete row[col]
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
    if (wantsBankChange) {
      const actor = userId ? await resolveSelf(tenantId, userId) : null
      try {
        const created = await createBankChangeRequest({
          tenantId,
          vendorId: id,
          vendorName: bankCheck.vendorName ?? "",
          requestedByEmpId: actor?.id ?? null,
          before: bankCheck.before as BankFields,
          after: bankCheck.after as BankFields,
          reason: changeReason || null,
        })
        res.status(202).json({
          vendor: serialize(data as unknown as Record<string, unknown>),
          bankChangeRequested: true,
          bankChangeRequest: { id: created.id, status: "pending" },
          message: "收款帳戶變更已送老闆／平台管理員 覆核，核准後才生效；其他欄位已儲存",
        })
      } catch (err) {
        if (err instanceof BankChangeError) {
          res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}), otherFieldsSaved: true })
          return
        }
        throw err
      }
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
    // 第五輪（2026-11-17）：還有未付期款或未匯款放款單的廠商不能刪——刪了之後名冊帶不出帳戶、
    // 同名「其他」收款也不再被擋，期款就可能匯給冒名帳戶。
    const label = `DELETE /vendors/${id}`
    if ((await vendorHasUnpaidInstallments(tenantId, id, label)) || (await vendorHasOpenDisbursements(tenantId, id, label))) {
      res.status(409).json({ error: "vendor_in_use", message: "此廠商仍有未付期款或未匯款的放款單，不能刪除" })
      return
    }
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
vendorsRouter.post("/vendors/card-scan", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
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
