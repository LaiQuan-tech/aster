import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { parseYearParam } from "../services/project-money.js"
import { defaultRunLabel } from "../services/bonus-run.js"
import {
  BonusRunError,
  buildSummary,
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
const deleteBody = z.object({ reason: z.string().trim().min(1).max(500) })

async function actorOf(tenantId: string, req: Request): Promise<Actor> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return { empId: self?.id ?? null }
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
    await actorOf(tenantId, req)
    const asOf = parsed.data.asOf ?? (await tenantToday(tenantId))
    const preview = await previewRun(tenantId, asOf, null)
    res.status(200).json({
      label: parsed.data.label ?? defaultRunLabel(asOf),
      asOf,
      items: preview.items,
      totals: preview.totals,
      snapshot: preview.snapshot,
    })
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
    await actorOf(tenantId, req)
    const runs = await listRuns(tenantId)
    res.status(200).json({ runs })
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
    const actor = await actorOf(tenantId, req)
    const asOf = parsed.data.asOf ?? (await tenantToday(tenantId))
    const detail = await createRun(tenantId, actor, {
      label: parsed.data.label ?? defaultRunLabel(asOf),
      asOf,
      note: parsed.data.note ?? null,
    })
    res.status(201).json(detail)
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
    await actorOf(tenantId, req)
    const detail = await getRun(tenantId, id)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const buffer = await bonusRunWorkbookBuffer(detail.run, detail.items)
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
    await actorOf(tenantId, req)
    const detail = await getRun(tenantId, id)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(detail)
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
    const actor = await actorOf(tenantId, req)
    const { recompute, ...input } = parsed.data
    const detail = await updateRun(tenantId, actor, id, input, { recompute })
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(detail)
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
    const actor = await actorOf(tenantId, req)
    const paidOn = parsed.data.paidOn ?? (await tenantToday(tenantId))
    const detail = await payRun(tenantId, actor, id, paidOn)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(detail)
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
    const actor = await actorOf(tenantId, req)
    const detail = await createReversalRun(tenantId, actor, id, parsed.data.reason)
    if (!detail) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(201).json(detail)
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
