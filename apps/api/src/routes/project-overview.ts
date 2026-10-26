import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { currentAlerts, taipeiToday } from "../services/project-alert-store.js"
import { ALERT_RULE_LABEL } from "../services/project-alerts.js"
import { generateText, GeminiNotConfiguredError, isGeminiConfigured } from "../lib/gemini.js"

export const projectOverviewRouter = Router()

/**
 * 專案進度示警（2026-10-27 看板已移除，只剩 alerts）。
 * 路徑是 /projects/alerts —— 必須掛在 projectsRouter 之前，
 * 否則會被 /projects/:id 吃掉。全租戶可讀（專案列表本來就是）。
 */

// ── GET /projects/alerts ────────────────────────────────────────────────
projectOverviewRouter.get("/projects/alerts", requireAuth, requireTenant, async (_req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const today = taipeiToday()
    const alerts = await currentAlerts(tenantId, today)
    res.status(200).json({ today, alerts, ruleLabels: ALERT_RULE_LABEL, aiAvailable: isGeminiConfigured() })
  } catch (err) {
    next(err)
  }
})

const DIGEST_SYSTEM = `你是專案管理助理，讀者是設計顧問公司的負責人與專案主管。你會拿到系統依規則算出的專案示警清單（JSON）。
請用繁體中文寫一段簡短摘要（最多 200 字）＋最多 5 條「今天該做的事」，每條一句、指名專案與動作、先急後緩。
不要複述整份清單，不要加入清單裡沒有的事實，不要客套。金額用千分位。`

// ── POST /projects/alerts/digest — Gemini 把示警清單整理成人話 ──────────
projectOverviewRouter.post("/projects/alerts/digest", requireAuth, requireTenant, async (_req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "gemini_not_configured", message: "未設定 GEMINI_API_KEY；規則示警照常，只是沒有 AI 摘要。" })
    return
  }
  try {
    const today = taipeiToday()
    const alerts = await currentAlerts(tenantId, today)
    if (alerts.length === 0) {
      res.status(200).json({ digest: "目前沒有任何示警，所有進行中的專案都在軌道上。", model: null, alerts: 0 })
      return
    }
    const compact = alerts.slice(0, 40).map((a) => ({
      嚴重度: a.severity, 規則: ALERT_RULE_LABEL[a.rule], 專案: `${a.projectCode ? `${a.projectCode} ` : ""}${a.projectName}`, 說明: a.message,
      ...(a.dueOn ? { 日期: a.dueOn } : {}), ...(a.amount != null ? { 金額: a.amount } : {}),
    }))
    const { text, model } = await generateText(DIGEST_SYSTEM, `今天是 ${today}。示警清單：\n${JSON.stringify(compact, null, 0)}`, { temperature: 0.3, maxOutputTokens: 2048 })
    res.status(200).json({ digest: text, model, alerts: alerts.length })
  } catch (err) {
    if (err instanceof GeminiNotConfiguredError) {
      res.status(503).json({ error: "gemini_not_configured" })
      return
    }
    next(err)
  }
})
