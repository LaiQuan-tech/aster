import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { currentAlerts, loadAlertInput, taipeiToday } from "../services/project-alert-store.js"
import { computeProjectAlerts, ALERT_RULE_LABEL, type ProjectAlert } from "../services/project-alerts.js"
import { generateText, GeminiNotConfiguredError, isGeminiConfigured } from "../lib/gemini.js"

export const projectOverviewRouter = Router()

/**
 * 專案總覽（甘特圖／看板）與進度示警。
 * 路徑是 /projects/overview、/projects/alerts —— 必須掛在 projectsRouter 之前，
 * 否則會被 /projects/:id 吃掉。全租戶可讀（專案列表本來就是）。
 */

// ── GET /projects/overview ──────────────────────────────────────────────
projectOverviewRouter.get("/projects/overview", requireAuth, requireTenant, async (_req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const today = taipeiToday()
    const [input, { data: emps, error: empErr }] = await Promise.all([
      loadAlertInput(tenantId),
      supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId),
    ])
    if (empErr) {
      next(new Error(`GET /projects/overview (employees): ${empErr.message}`))
      return
    }
    const nameById = new Map((emps ?? []).map((e) => [e.id as string, e.name as string]))
    const alerts = computeProjectAlerts(input, today)
    const alertsBy = new Map<string, ProjectAlert[]>()
    for (const a of alerts) alertsBy.set(a.projectId, [...(alertsBy.get(a.projectId) ?? []), a])

    const projects = input.projects
      .filter((p) => !p.archivedAt)
      .map((p) => {
        const contracts = input.contracts.filter((c) => c.projectId === p.id)
        const billings = input.billings.filter((b) => b.projectId === p.id).sort((a, b) => a.installmentNo - b.installmentNo)
        const contractTotal = contracts.filter((c) => c.docType === "contract" || c.docType === "change_order").reduce((s, c) => s + (c.amount ?? 0), 0)
        const billed = billings.filter((b) => b.billedOn).reduce((s, b) => s + (b.amount ?? 0), 0)
        const scheduled = billings.reduce((s, b) => s + (b.amount ?? 0), 0)
        const pa = alertsBy.get(p.id) ?? []
        return {
          id: p.id,
          name: p.name,
          code: p.code,
          status: p.status,
          startsOn: p.startsOn,
          endsOn: p.endsOn,
          createdAt: p.createdAt,
          leadEmpId: p.leadEmpId,
          leadName: p.leadEmpId ? (nameById.get(p.leadEmpId) ?? null) : null,
          hasContract: contracts.some((c) => c.docType === "contract"),
          contractTotal: contractTotal || null,
          billedTotal: billed,
          scheduledTotal: scheduled,
          milestones: billings.map((b) => ({ installmentNo: b.installmentNo, plannedOn: b.plannedOn, billedOn: b.billedOn, amount: b.amount })),
          lastActivity: input.lastActivity[p.id] ?? null,
          alerts: { high: pa.filter((a) => a.severity === "high").length, medium: pa.filter((a) => a.severity === "medium").length, low: pa.filter((a) => a.severity === "low").length },
        }
      })
    res.status(200).json({ today, projects })
  } catch (err) {
    next(err)
  }
})

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
