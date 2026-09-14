import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"
import { isValidTaiwanTaxId, TAX_ID_RE } from "../services/tax-id.js"

export const companiesRouter = Router()

/**
 * 我方主體名冊（P3）。多數租戶只有一家；集團型客戶可能用不同主體付下包款
 * 或開收據（`project_subcontract_payments.paying_company_id` /
 * `receipt_issuer_company_id` 指到這裡）。
 *
 * - `GET /companies` 登入即可讀（下包期款表單要下拉）。
 * - `PUT /companies` HR 整批 upsert：帶 id 的更新、沒 id 的新增；**不在 payload
 *   裡的不刪**（主體被期款引用，刪了歷史憑證就對不到付款人；要停用就改名
 *   或在 note 標記）。`isDefault` 只能一筆——多筆 true 回 400，一筆都沒有時
 *   維持既有預設。
 */

const COLS = "id, name, tax_id, bank_name, bank_account, is_default, note, created_at, updated_at"

type CompanyRow = {
  id: string
  name: string
  tax_id: string | null
  bank_name: string | null
  bank_account: string | null
  is_default: boolean
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
  note: z.string().trim().max(2000).nullable().optional(),
})

const putBody = z.object({
  companies: z.array(companyItem).min(1).max(50),
})

function serialize(r: CompanyRow) {
  return {
    id: r.id,
    name: r.name,
    taxId: r.tax_id,
    bankName: r.bank_name,
    bankAccount: r.bank_account,
    isDefault: r.is_default,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
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
    res.status(200).json({ companies: (await listCompanies(tenantId)).map(serialize) })
  } catch (err) {
    next(err)
  }
})

// ── PUT /companies — HR 整批 upsert ────────────────────────────────────
companiesRouter.put("/companies", requireAuth, requireTenant, requireHrAdmin, async (req: Request, res: Response, next: NextFunction) => {
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
    const now = new Date().toISOString()

    // 只能有一筆預設：payload 指定了新的預設，就先把其他的清掉。
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
    const after = await listCompanies(tenantId)
    if (after.length > 0 && !after.some((c) => c.is_default)) {
      if (after.length === 1) {
        await supabaseAdmin
          .from("companies")
          .update({ is_default: true, updated_at: now })
          .eq("tenant_id", tenantId)
          .eq("id", after[0].id)
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
    res.status(200).json({ companies: after.map(serialize) })
  } catch (err) {
    next(err)
  }
})
