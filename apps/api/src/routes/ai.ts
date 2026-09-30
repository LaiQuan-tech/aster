import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import {
  GeminiNotConfiguredError,
  answerAiQuestion,
  generateAiReportSummary,
} from "../services/ai-insights.js"

export const aiRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/
const periodRe = /^\d{4}-\d{2}$/

const reportSummarySchema = z.object({
  from: z.string().regex(dateRe),
  to: z.string().regex(dateRe),
  period: z.string().regex(periodRe),
  deptId: z.string().uuid().optional(),
})

const askSchema = z.object({
  question: z.string().trim().min(1).max(800),
  from: z.string().regex(dateRe),
  to: z.string().regex(dateRe),
  period: z.string().regex(periodRe),
})

async function resolveCaller(tenantId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`AI resolve caller: ${error.message}`)
  return data as { id: string; role: string } | null
}

function handleAiError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof GeminiNotConfiguredError) {
    res.status(503).json({
      error: "gemini_not_configured",
      message: "Set GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY) on the API service.",
    })
    return
  }
  next(err)
}

aiRouter.post(
  "/ai/report-summary",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = reportSummarySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const result = await generateAiReportSummary(tenantId, parsed.data)
      res.status(200).json(result)
    } catch (err) {
      handleAiError(err, res, next)
    }
  },
)

// 2026-09-30 起員工端（/ess）不開放 AI 問答；只有 HR／平台管理員／會計（requireFinance）可呼叫此端點。
aiRouter.post(
  "/ai/ask",
  requireAuth,
  requireTenant,
  requireFinance,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const parsed = askSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    if (!userId) {
      res.status(403).json({ error: "forbidden" })
      return
    }

    try {
      const caller = await resolveCaller(tenantId, userId)
      if (!caller) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const isHr = ["hr_admin", "platform_admin"].includes(caller.role)
      const result = await answerAiQuestion(tenantId, {
        ...parsed.data,
        ...(isHr ? {} : { employeeId: caller.id }),
      })
      res.status(200).json(result)
    } catch (err) {
      handleAiError(err, res, next)
    }
  },
)
