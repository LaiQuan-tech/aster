import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"

export const companyPagesRouter = Router()

/**
 * 公司資訊頁：固定幾個 slug，一租戶一 slug 一頁。內容是長期有效的說明
 * （福利制度、職安衛規範），不是公告——公告有版本與簽收，走 announcements。
 * 全員可讀（ESS），HR 可改。slug 集合寫死：頁面是合約列出的固定項目，
 * 開放自訂會讓「客戶買了哪些頁」說不清。
 */
export const COMPANY_PAGE_SLUGS = {
  benefits: "公司福利",
  safety: "職業安全衛生",
} as const
export type CompanyPageSlug = keyof typeof COMPANY_PAGE_SLUGS

const COLS = "id, tenant_id, slug, title, body, updated_by_emp_id, created_at, updated_at"

const upsertSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().max(50_000),
})

function isSlug(s: string): s is CompanyPageSlug {
  return Object.prototype.hasOwnProperty.call(COMPANY_PAGE_SLUGS, s)
}

// ── GET /company-pages — 全員：每個 slug 一筆（沒建過的回預設標題、空內容）──
companyPagesRouter.get(
  "/company-pages",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin.from("company_pages").select(COLS).eq("tenant_id", tenantId)
      if (error) {
        next(new Error(`GET /company-pages: ${error.message}`))
        return
      }
      const bySlug = new Map((data ?? []).map((r) => [r.slug as string, r]))
      const pages = (Object.keys(COMPANY_PAGE_SLUGS) as CompanyPageSlug[]).map((slug) => {
        const row = bySlug.get(slug)
        return {
          slug,
          defaultTitle: COMPANY_PAGE_SLUGS[slug],
          title: (row?.title as string | undefined) ?? COMPANY_PAGE_SLUGS[slug],
          body: (row?.body as string | undefined) ?? "",
          updatedAt: (row?.updated_at as string | undefined) ?? null,
          updatedByEmpId: (row?.updated_by_emp_id as string | undefined) ?? null,
          exists: !!row,
        }
      })
      res.status(200).json({ pages })
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /company-pages/:slug — HR：建立或整頁覆寫 ────────────────────
companyPagesRouter.put(
  "/company-pages/:slug",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const slug = req.params.slug as string
    if (!isSlug(slug)) {
      res.status(404).json({ error: "unknown_slug", allowed: Object.keys(COMPANY_PAGE_SLUGS) })
      return
    }
    const parsed = upsertSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = userId ? await resolveSelf(tenantId, userId) : null
      const { data, error } = await supabaseAdmin
        .from("company_pages")
        .upsert(
          {
            tenant_id: tenantId,
            slug,
            title: parsed.data.title,
            body: parsed.data.body,
            updated_by_emp_id: self?.id ?? null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,slug" },
        )
        .select(COLS)
        .single()
      if (error || !data) {
        next(new Error(`PUT /company-pages/${slug}: ${error?.message}`))
        return
      }
      res.status(200).json({ page: { slug, title: data.title, body: data.body, updatedAt: data.updated_at } })
    } catch (err) {
      next(err)
    }
  },
)
