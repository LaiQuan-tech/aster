import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"
import { isValidTaiwanTaxId, TAX_ID_RE } from "../services/tax-id.js"
import {
  emptyCompanyUsage,
  findInactiveDefault,
  loadCompanyUsage,
  resolveFinalFlags,
  type CompanyUsage,
} from "../services/company-lifecycle.js"

export const companiesRouter = Router()

/**
 * 我方主體名冊（P3）。多數租戶只有一家；集團型客戶可能用不同主體付下包款
 * 或開收據（`project_subcontract_payments.paying_company_id` /
 * `receipt_issuer_company_id` 指到這裡），專案承接公司（`projects.company_id`）與
 * 放款單的付款公司／收據抬頭（`disbursements.*_company_id`）也指到這裡。
 *
 * 生命週期（2026-10-10 業主拍板；規則細節與「使用」的定義見 services/company-lifecycle.ts）：
 *   • 從沒被用過的公司可以刪除（`DELETE /companies/:id`）；用過的不能刪，改成**停用**。
 *   • 停用（`is_active=false`）＝新專案／新放款／新下包付款的下拉不再出現，寫入時也擋
 *     （400 `company_inactive`，見各寫入路徑）；舊紀錄照常顯示原公司名稱。
 *   • 預設公司不能停用、不能刪。
 *
 * - `GET /companies` 登入即可讀（下包期款表單要下拉）；每筆帶 `isActive` 與 `usage`（被引用的筆數）。
 * - `PUT /companies` 整批 upsert：帶 id 的更新、沒 id 的新增；**不在 payload
 *   裡的不刪**（刪除一律走 DELETE，且只准刪沒被用過的）。`isDefault` 只能一筆——多筆 true 回 400，
 *   一筆都沒有時維持既有預設。`isActive` 可帶；停用預設公司（或把停用的公司設成預設）回 400
 *   `default_company_inactive`。
 * - `DELETE /companies/:id` 權限同 PUT：不是本租戶 404、預設 409 `company_is_default`、
 *   被用過 409 `company_in_use`（附 `usage` 明細）；競態下 DB 外鍵擋下（23503）也是 409 `company_in_use`。
 */

const COLS = "id, name, tax_id, bank_name, bank_account, is_default, is_active, note, created_at, updated_at"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type CompanyRow = {
  id: string
  name: string
  tax_id: string | null
  bank_name: string | null
  bank_account: string | null
  is_default: boolean
  /** 停用＝新單據的下拉不再出現（舊紀錄照常顯示）。DB 欄位 NOT NULL DEFAULT true。 */
  is_active: boolean
  note: string | null
  created_at: string
  updated_at: string
}

const companyItem = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  taxId: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => v == null || v === "" || TAX_ID_RE.test(v), "統一編號須為 8 碼數字")
    .refine((v) => v == null || v === "" || isValidTaiwanTaxId(v), "統一編號檢查碼錯誤"),
  bankName: z.string().trim().max(120).nullable().optional(),
  bankAccount: z.string().trim().max(60).nullable().optional(),
  isDefault: z.boolean().optional(),
  /** 省略＝維持現狀（新增列預設啟用）。 */
  isActive: z.boolean().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
})

const putBody = z.object({
  companies: z.array(companyItem).min(1).max(50),
})

function serialize(r: CompanyRow, usage: CompanyUsage) {
  return {
    id: r.id,
    name: r.name,
    taxId: r.tax_id,
    bankName: r.bank_name,
    bankAccount: r.bank_account,
    isDefault: r.is_default,
    isActive: r.is_active !== false,
    /** 被專案／放款／下包期款引用的筆數（含已作廢、已軟刪的列）；0＝可以刪除。 */
    usage,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 名冊＋每間公司的使用量（GET 與 PUT 回同一種形狀；使用量是批次查，不是每間公司各打一輪）。 */
async function serializeAll(tenantId: string, rows: CompanyRow[]) {
  const usage = await loadCompanyUsage(tenantId, rows.map((r) => r.id))
  return rows.map((r) => serialize(r, usage.get(r.id) ?? emptyCompanyUsage()))
}

async function listCompanies(tenantId: string): Promise<CompanyRow[]> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .select(COLS)
    .eq("tenant_id", tenantId)
    .order("is_default", { ascending: false })
    .order("name", { ascending: true })
  if (error) throw new Error(`listCompanies: ${error.message}`)
  return (data ?? []) as CompanyRow[]
}

// ── GET /companies ─────────────────────────────────────────────────────
companiesRouter.get("/companies", requireAuth, requireTenant, async (_req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    res.status(200).json({ companies: await serializeAll(tenantId, await listCompanies(tenantId)) })
  } catch (err) {
    next(err)
  }
})

// ── PUT /companies — HR 整批 upsert ────────────────────────────────────
companiesRouter.put("/companies", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const parsed = putBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  const items = parsed.data.companies
  const defaults = items.filter((c) => c.isDefault === true)
  if (defaults.length > 1) {
    res.status(400).json({ error: "multiple_defaults" })
    return
  }
  const names = new Set<string>()
  for (const c of items) {
    if (names.has(c.name)) {
      res.status(400).json({ error: "duplicate_name", name: c.name })
      return
    }
    names.add(c.name)
  }
  try {
    const self = userId ? await resolveSelf(tenantId, userId) : null
    const existing = await listCompanies(tenantId)
    const existingIds = new Set(existing.map((c) => c.id))
    for (const c of items) {
      if (c.id && !existingIds.has(c.id)) {
        res.status(404).json({ error: "not_found", id: c.id })
        return
      }
    }
    // 預設公司必須是啟用的（DB CHECK `companies_default_active_chk`）。套完這批 payload 之後有
    // 「是預設卻被停用」的公司，在第一筆寫入之前就擋成 400——不要讓 CHECK 變成 500，也不要寫到一半才失敗。
    // 同一批「把預設改到 B、同時停用原預設 A」不算違規（A 的預設旗標會先被清掉，見下方寫入順序）。
    const inactiveDefault = findInactiveDefault(resolveFinalFlags(existing, items))
    if (inactiveDefault) {
      res.status(400).json({ error: "default_company_inactive", id: inactiveDefault.id, name: inactiveDefault.name })
      return
    }
    const now = new Date().toISOString()

    // 只能有一筆預設：payload 指定了新的預設，就先把其他的清掉。
    // ⚠️ 順序有意義：這一步必須排在逐筆更新之前——同一批若要「預設改到 B、停用原預設 A」，
    // 要先讓 A 不再是預設，之後 A 的 is_active=false 才不會在中途違反 CHECK（is_active OR NOT is_default）。
    const newDefault = defaults[0]
    if (newDefault) {
      const keepId = newDefault.id ?? null
      let q = supabaseAdmin
        .from("companies")
        .update({ is_default: false, updated_at: now })
        .eq("tenant_id", tenantId)
        .eq("is_default", true)
      if (keepId) q = q.neq("id", keepId)
      const { error } = await q
      if (error) {
        next(new Error(`PUT /companies (clear default): ${error.message}`))
        return
      }
    }

    for (const c of items) {
      const row: Record<string, unknown> = {
        name: c.name,
        updated_at: now,
      }
      if (c.taxId !== undefined) row.tax_id = c.taxId === "" ? null : c.taxId
      if (c.bankName !== undefined) row.bank_name = c.bankName
      if (c.bankAccount !== undefined) row.bank_account = c.bankAccount
      if (c.note !== undefined) row.note = c.note
      if (c.isDefault !== undefined) row.is_default = c.isDefault
      if (c.isActive !== undefined) row.is_active = c.isActive

      if (c.id) {
        const { error } = await supabaseAdmin.from("companies").update(row).eq("tenant_id", tenantId).eq("id", c.id)
        if (error) {
          if (error.code === "23505") {
            res.status(409).json({ error: "name_taken", name: c.name })
            return
          }
          next(new Error(`PUT /companies (update): ${error.message}`))
          return
        }
      } else {
        const { error } = await supabaseAdmin
          .from("companies")
          .insert({ tenant_id: tenantId, ...row, is_default: c.isDefault ?? false })
        if (error) {
          if (error.code === "23505") {
            res.status(409).json({ error: "name_taken", name: c.name })
            return
          }
          next(new Error(`PUT /companies (insert): ${error.message}`))
          return
        }
      }
    }

    // 一筆都沒被標預設而名冊只有一家時，那家就是預設——省得 UI 還要多按一次。
    // （那一家若是停用的就不設：預設不能是停用狀態，硬寫會被 CHECK 擋成 500。）
    const after = await listCompanies(tenantId)
    if (after.length > 0 && !after.some((c) => c.is_default)) {
      if (after.length === 1 && after[0].is_active !== false) {
        const { error } = await supabaseAdmin
          .from("companies")
          .update({ is_default: true, updated_at: now })
          .eq("tenant_id", tenantId)
          .eq("id", after[0].id)
        if (error) throw new Error(`PUT /companies (auto default): ${error.message}`)
        after[0].is_default = true
      }
    }

    await writeAuditLog({
      tenantId,
      tableName: "companies",
      action: "UPDATE",
      newRow: parsed.data,
      actorEmpId: self?.id,
      context: "PUT /companies",
    })
    res.status(200).json({ companies: await serializeAll(tenantId, after) })
  } catch (err) {
    next(err)
  }
})

// ── DELETE /companies/:id — 只能刪沒被用過的公司 ───────────────────────
companiesRouter.delete("/companies/:id", requireAuth, requireTenant, requireFinance, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const id = req.params.id as string
  // 不是 uuid 的 id 不可能屬於本租戶；交給 PostgREST 會變成 22P02 → 500。
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: "not_found" })
    return
  }
  try {
    const { data, error } = await supabaseAdmin.from("companies").select(COLS).eq("tenant_id", tenantId).eq("id", id).maybeSingle()
    if (error) {
      next(new Error(`DELETE /companies/${id} (load): ${error.message}`))
      return
    }
    if (!data) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const company = data as unknown as CompanyRow
    if (company.is_default) {
      res.status(409).json({ error: "company_is_default" })
      return
    }
    const usage = (await loadCompanyUsage(tenantId, [id])).get(id) ?? emptyCompanyUsage()
    if (usage.total > 0) {
      res.status(409).json({ error: "company_in_use", usage })
      return
    }

    const { data: deleted, error: deleteError } = await supabaseAdmin
      .from("companies")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select("id")
    if (deleteError) {
      // 檢查到刪除之間有人剛好用了這間公司：DB 外鍵（NO ACTION）擋下，也是「用過了」，不是 500。
      if (deleteError.code === "23503") {
        const latest = await loadCompanyUsage(tenantId, [id]).then((m) => m.get(id) ?? emptyCompanyUsage()).catch(() => usage)
        res.status(409).json({ error: "company_in_use", usage: latest })
        return
      }
      next(new Error(`DELETE /companies/${id}: ${deleteError.message}`))
      return
    }
    if (!deleted || deleted.length === 0) {
      // 讀到之後被別人先刪掉了。
      res.status(404).json({ error: "not_found" })
      return
    }

    const self = userId ? await resolveSelf(tenantId, userId) : null
    await writeAuditLog({
      tenantId,
      tableName: "companies",
      recordId: id,
      action: "DELETE",
      oldRow: company,
      actorEmpId: self?.id,
      context: "DELETE /companies/:id",
    })
    res.status(200).json({ id })
  } catch (err) {
    next(err)
  }
})
