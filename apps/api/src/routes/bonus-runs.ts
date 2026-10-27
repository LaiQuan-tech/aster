import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { loadGroupFinancialsAccess } from "../services/financial-visibility.js"
import { parseYearParam } from "../services/project-money.js"
import { defaultRunLabel } from "../services/bonus-run.js"
import {
  approveRun,
  BonusRunError,
  buildSummary,
  isBonusApprover,
  isSelfSubmitted,
  listPendingApprovals,
  returnRun,
  submitRun,
  withdrawRun,
  createReversalRun,
  createRun,
  deleteRun,
  getRun,
  listRuns,
  myBonusHistory,
  payRun,
  previewRun,
  tenantToday,
  updateRun,
  type Actor,
  type SerializedItem,
} from "../services/bonus-run-store.js"
import { bonusRunFilename, bonusRunWorkbookBuffer } from "../lib/xlsx/bonus-runs.js"

export const bonusRunsRouter = Router()

/**
 * D1 專案獎金季發放批次（bonus_runs／bonus_run_items）。
 *
 * 全部 HR（`requireHrAdmin`，同 routes/projects.ts 建案／分潤設定的 guard——本系統沒有
 * 獨立的 finance 角色）；ESS 的 `/my/bonus-history` 只要登入。業務規則在
 * services/bonus-run-store.ts（IO）與 services/bonus-run.ts（純函式）；這裡只做認人、
 * zod、錯誤碼對應、xlsx 回傳。
 *
 * 路由順序：`/bonus-runs/preview`、`/bonus-runs/summary` 這些靜態路徑先註冊，`/:id`
 * 在後，且 `:id` 不是 uuid 時 `next()`——同 routes/disbursements.ts 的理由。
 *
 * **不做 void、改做紅字沖銷**（2026-09-20）：paid 批次是凍結快照（DB trigger 擋
 * UPDATE/DELETE），不回頭改。`POST /bonus-runs/:id/reverse` 開一批 kind='reversal'
 * 的 draft：每列金額取負、paid_before 接在原批之後；走既有的 pay 才生效，發放後
 * 累計口徑對原批歸零，下一季重算等於原批沒發生過。只能沖銷最新一批 paid、一批只能
 * 沖一次、沖銷批不能再被沖銷（services/bonus-run-store.ts createReversalRun）。
 *
 * **核准（#7，2026-10-26）**：草稿 →（HR）`POST /:id/submit` 送審 →（老闆）`POST /:id/approve` 核准
 * →（HR）`POST /:id/pay` 發放；老闆 `POST /:id/return {reason}` 退回草稿；HR `POST /:id/withdraw {reason}`
 * 撤回送審（限送審中，已核准後只能老闆退回；通知老闆）。老闆＝租戶
 * features.approval.fallbackApproverEmpId；**platform_admin 也能核准／退回**（2026-10-27，不需要老闆存在）。其他人：
 * 沒設老闆 → 409 boss_not_configured；非老闆 → 403 not_approver。送審仍需要老闆已設定（通知對象）。
 * approve／return 不掛 requireHrAdmin（老闆不一定是 HR），身分在 service 裡比對。老闆在 ESS 簽核頁用
 * `GET /my/bonus-approvals` 看待核准批次（含明細），不必進後台。沖銷批次走同一套。
 *
 * **毛利欄位（2026-10-26 二修：老闆與一般 HR 分開）**：毛利／成本／獎金比例／累計獎金池屬於集團財務，只有老闆、
 * platform_admin、被授權的 hr_admin（features.seeGroupFinancials）看得到；其他 HR 照樣能試算、建立、送審、發放與
 * 匯出，但回應（含 xlsx）裡這些欄位是 null，並帶 `canSeeProfit: false` 讓前端隱藏欄位。發放所需的金額（入帳、
 * 入帳比例、趴數、應得累計、已發、本次金額）不受影響。見 maskProfit。
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/
function isCalendarDate(s: string): boolean {
  if (!dateRe.test(s)) return false
  const [y, m, d] = s.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
const dateKey = z.string().refine(isCalendarDate, "須為 YYYY-MM-DD 的有效日期")
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const label = z.string().trim().min(1).max(40)

const previewBody = z.object({ asOf: dateKey.optional(), label: label.optional() })
const createBody = z.object({ asOf: dateKey.optional(), label: label.optional(), note: z.string().trim().max(2000).nullish() })
const patchBody = z
  .object({
    asOf: dateKey.optional(),
    label: label.optional(),
    note: z.string().trim().max(2000).nullish(),
    /** true＝即使 asOf 沒變也重算明細（入帳／成員變了要拿最新數字）。 */
    recompute: z.boolean().optional(),
  })
  .refine((b) => b.asOf !== undefined || b.label !== undefined || b.note !== undefined || b.recompute !== undefined, "至少要有一個欄位")
const payBody = z.object({ paidOn: dateKey.optional() })
const returnBody = z.object({ reason: z.string().trim().min(1).max(500) })
const deleteBody = z.object({ reason: z.string().trim().min(1).max(500) })

async function actorOf(tenantId: string, req: Request): Promise<Actor> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return { empId: self?.id ?? null, role: self?.role ?? null, active: self?.active }
}

/** 呼叫者＋看不看得到毛利（老闆／platform_admin／授權 HR）。 */
async function viewerOf(tenantId: string, req: Request): Promise<{ actor: Actor; canSeeProfit: boolean }> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  const canSeeProfit = self ? (await loadGroupFinancialsAccess(tenantId, self)).canSee : false
  return { actor: { empId: self?.id ?? null, role: self?.role ?? null }, canSeeProfit }
}

/** 明細的毛利類欄位（可直接或反推出專案毛利）。 */
const ITEM_PROFIT_KEYS = ["bonusRatePct", "bonusPool", "cost", "disbursementCost", "subcontractCost", "grossProfit"] as const
/** 批次 snapshot.projects[] 的毛利類欄位。 */
const SNAPSHOT_PROFIT_KEYS = ["bonusRatePct", "bonusPool", "effectivePool", "contractPool", "cost", "disbursementCost", "subcontractCost", "grossProfit"] as const

function maskItems(items: SerializedItem[]): SerializedItem[] {
  return items.map((i) => {
    const out = { ...i } as Record<string, unknown>
    for (const k of ITEM_PROFIT_KEYS) out[k] = null
    return out as SerializedItem
  })
}

function maskSnapshot(snapshot: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!snapshot) return snapshot ?? null
  const projects = Array.isArray(snapshot.projects)
    ? (snapshot.projects as Array<Record<string, unknown>>).map((p) => {
        const out = { ...p }
        for (const k of SNAPSHOT_PROFIT_KEYS) if (k in out) out[k] = null
        return out
      })
    : snapshot.projects
  return { ...snapshot, projects }
}

/** 看不到毛利的人：把毛利類欄位換成 null（發放流程要的金額不動），並帶 canSeeProfit 旗標。 */
export function maskProfit<T extends { items: SerializedItem[]; snapshot?: Record<string, unknown> | null }>(
  detail: T,
  canSeeProfit: boolean,
): T & { canSeeProfit: boolean } {
  if (canSeeProfit) return { ...detail, canSeeProfit }
  return {
    ...detail,
    items: maskItems(detail.items),
    ...("snapshot" in detail ? { snapshot: maskSnapshot(detail.snapshot) } : {}),
    canSeeProfit,
  }
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof BonusRunError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  next(err)
}

/** 同 routes/disbursements.ts 的 sendXlsx——那邊是私有函式沒有 export，這裡複製一份。 */
function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

const guards = [requireAuth, requireTenant, requireHrAdmin] as const

// ── POST /bonus-runs/preview {asOf?, label?} — 試算，不寫入 ─────────────
bonusRunsRouter.post("/bonus-runs/preview", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = previewBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { canSeeProfit } = await viewerOf(tenantId, req)
    const asOf = parsed.data.asOf ?? (await tenantToday(tenantId))
    const preview = await previewRun(tenantId, asOf, null)
    res.status(200).json(
      maskProfit(
        {
          label: parsed.data.label ?? defaultRunLabel(asOf),
          asOf,
          items: preview.items,
          totals: preview.totals,
          snapshot: preview.snapshot as Record<string, unknown>,
        },
        canSeeProfit,
      ),
    )
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /bonus-runs/summary?year=&empId= — 歷年累計／上季對比（只看 paid） ──
bonusRunsRouter.get("/bonus-runs/summary", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const yearRaw = req.query.year
  const year = yearRaw === undefined || yearRaw === "" ? null : parseYearParam(yearRaw)
  if (yearRaw !== undefined && yearRaw !== "" && year === null) {
    res.status(400).json({ error: "invalid_query", param: "year" })
    return
  }
  const empId = typeof req.query.empId === "string" && req.query.empId !== "" ? req.query.empId : null
  if (empId && !UUID_RE.test(empId)) {
    res.status(400).json({ error: "invalid_query", param: "empId" })
    return
  }
  try {
    await actorOf(tenantId, req)
    const summary = await buildSummary(tenantId, { year, employeeId: empId })
    res.status(200).json({ summary })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /bonus-runs — 列表＋totals ───────────────────────────────────
bonusRunsRouter.get("/bonus-runs", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const actor = await actorOf(tenantId, req)
    const [runs, canApprove] = await Promise.all([listRuns(tenantId), isBonusApprover(tenantId, actor)])
    res.status(200).json({ runs, canApprove })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /bonus-runs {asOf?, label?, note?} — 建 draft＋items；409 label_exists ──
bonusRunsRouter.post("/bonus-runs", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = createBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const asOf = parsed.data.asOf ?? (await tenantToday(tenantId))
    const detail = await createRun(tenantId, actor, {
      label: parsed.data.label ?? defaultRunLabel(asOf),
      asOf,
      note: parsed.data.note ?? null,
    })
    res.status(201).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /bonus-runs/:id/export.xlsx ──────────────────────────────────
bonusRunsRouter.get("/bonus-runs/:id/export.xlsx", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  try {
    const { canSeeProfit } = await viewerOf(tenantId, req)
    const raw = await getRun(tenantId, id)
    if (!raw) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const detail = maskProfit(raw, canSeeProfit)
    // 看不到集團財務：毛利類欄位已遮成 null，xlsx 另外整欄移除「%／總獎金」（不是留空）。
    const buffer = await bonusRunWorkbookBuffer(detail.run, detail.items, { showProfit: canSeeProfit })
    sendXlsx(res, buffer, bonusRunFilename(detail.run))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /bonus-runs/:id — 明細（items 含專案代號名稱／員工姓名工號） ─────
bonusRunsRouter.get("/bonus-runs/:id", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const detail = await getRun(tenantId, id)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    // selfSubmitted：呼叫者就是送審人 → 不能核准／退回（追加 F），前端隱藏按鈕並說明。
    res.status(200).json({
      ...maskProfit(detail, canSeeProfit),
      canApprove: await isBonusApprover(tenantId, actor),
      selfSubmitted: isSelfSubmitted({ submitted_by_emp_id: detail.run.submittedByEmpId ?? null, created_by_emp_id: detail.run.createdByEmpId ?? null }, actor),
    })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── PATCH /bonus-runs/:id {asOf?, label?, note?, recompute?} — draft only；paid → 409 not_draft ──
bonusRunsRouter.patch("/bonus-runs/:id", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = patchBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const { recompute, ...input } = parsed.data
    const detail = await updateRun(tenantId, actor, id, input, { recompute })
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /bonus-runs/:id/pay {paidOn?} — draft → paid（凍結） ───────────
bonusRunsRouter.post("/bonus-runs/:id/pay", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = payBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const paidOn = parsed.data.paidOn ?? (await tenantToday(tenantId))
    const detail = await payRun(tenantId, actor, id, paidOn)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /bonus-runs/:id/submit — HR 送審：draft → pending_approval（通知老闆） ──
bonusRunsRouter.post("/bonus-runs/:id/submit", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const detail = await submitRun(tenantId, actor, id)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /bonus-runs/:id/approve — 老闆核准：pending_approval → approved（通知送審人） ──
bonusRunsRouter.post("/bonus-runs/:id/approve", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const detail = await approveRun(tenantId, actor, id)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /bonus-runs/:id/return {reason} — 老闆退回草稿（需原因；通知送審人） ──
bonusRunsRouter.post("/bonus-runs/:id/return", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = returnBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const detail = await returnRun(tenantId, actor, id, parsed.data.reason)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /bonus-runs/:id/withdraw {reason} — HR 撤回送審：pending_approval → draft（通知老闆；已核准 409） ──
bonusRunsRouter.post("/bonus-runs/:id/withdraw", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = returnBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const detail = await withdrawRun(tenantId, actor, id, parsed.data.reason)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /bonus-runs/:id/reverse {reason} — 對 paid 批次開紅字沖銷 draft ──
const reverseBody = z.object({ reason: z.string().trim().min(1).max(2000) })
bonusRunsRouter.post("/bonus-runs/:id/reverse", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = reverseBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const { actor, canSeeProfit } = await viewerOf(tenantId, req)
    const detail = await createReversalRun(tenantId, actor, id, parsed.data.reason)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(201).json(maskProfit(detail, canSeeProfit))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── DELETE /bonus-runs/:id {reason} — draft 軟刪；paid → 409 not_draft ────
bonusRunsRouter.delete("/bonus-runs/:id", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = deleteBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actor = await actorOf(tenantId, req)
    const ok = await deleteRun(tenantId, actor, id, parsed.data.reason)
    if (!ok) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ ok: true, id })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /my/bonus-approvals — ESS 簽核頁：老闆／platform_admin 看待核准的獎金批次（含明細）；其他人回空清單 ──
bonusRunsRouter.get("/my/bonus-approvals", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const actor = await actorOf(tenantId, req)
    if (!(await isBonusApprover(tenantId, actor))) {
      res.status(200).json({ canApprove: false, runs: [] })
      return
    }
    const runs = (await listPendingApprovals(tenantId)).map((d) => ({
      ...d,
      selfSubmitted: isSelfSubmitted({ submitted_by_emp_id: d.run.submittedByEmpId ?? null, created_by_emp_id: d.run.createdByEmpId ?? null }, actor),
    }))
    res.status(200).json({ canApprove: true, runs })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /my/bonus-history — ESS：本人各 paid 批次的明細 ──────────────────
bonusRunsRouter.get("/my/bonus-history", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  try {
    const self = await resolveSelf(tenantId, userId)
    if (!self) {
      res.status(403).json({ error: "forbidden" })
      return
    }
    const history = await myBonusHistory(tenantId, self.id)
    res.status(200).json(history)
  } catch (err) {
    handleError(err, res, next)
  }
})
