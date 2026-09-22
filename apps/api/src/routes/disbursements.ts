import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireFinance, requireHrAdmin } from "../middleware/role.js"
import { isFinanceRole, resolveSelf } from "../middleware/scope.js"
import {
  DISBURSEMENT_METHODS,
  DISBURSEMENT_STATUSES,
  DisbursementError,
  PAYEE_KINDS,
  addAttachment,
  buildPayables,
  buildSummary,
  createDisbursement,
  getDisbursement,
  listAttachments,
  listDisbursements,
  listManualPaidPayments,
  loadDisbursement,
  payDisbursement,
  removeAttachment,
  tenantToday,
  updateDisbursement,
  voidDisbursement,
  type Actor,
  type DisbursementStatus,
} from "../services/disbursements.js"
import {
  changeDisbursementApprover,
  decideDisbursement,
  listPendingDisbursementApprovals,
  loadApprovalTrail,
  submitDisbursement,
  withdrawDisbursement,
} from "../services/disbursement-approval.js"
import { disbursementsFilename, disbursementsWorkbookBuffer } from "../lib/xlsx/disbursements.js"

export const disbursementsRouter = Router()

/**
 * 放款專區（匯款紀錄 × 專案連動）。整個租戶付出去的錢都在這裡，不分案給 lead 看。
 * 守門分三層（W4／M4）：
 *   `requireFinance`  HR／平台管理員／**會計**——列表、建單、編輯、送簽、付款、作廢、附件。
 *   `requireHrAdmin`  HR 專屬——變更簽核人、撤回送簽。
 *   只要登入      簽核動作（approve／reject／pending-approvals）：主管不一定是會計，
 *                 能不能簽由關卡候選決定（`services/disbursement-approval.ts`）。
 *
 * 業務規則全部在 services/disbursements.ts 與 services/disbursement-approval.ts；
 * 這裡只做認人、zod、查詢字串解析、錯誤碼對應、xlsx 回傳。
 *
 * 路由順序：`/disbursements/summary`、`/payables`、`/pending-approvals`、`/export.xlsx`
 * 這些靜態路徑先註冊，`/:id` 在後，且 `:id` 不是 uuid 時 `next()`——同 projects-annual.ts。
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/
/** 'YYYY-MM-DD' 且真的是一個日期（2026-13-01 這種格式對、日曆錯的擋在 zod／查詢字串層，不丟給 DB 變 500）。 */
function isCalendarDate(s: string): boolean {
  if (!dateRe.test(s)) return false
  const [y, m, d] = s.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
const dateKey = z.string().refine(isCalendarDate, "須為 YYYY-MM-DD 的有效日期")
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const allocationItem = z.object({
  projectId: z.string().uuid(),
  subcontractId: z.string().uuid().nullish(),
  subcontractPaymentId: z.string().uuid().nullish(),
  /** 毛額（含代扣）。 */
  amount: z.number().positive().max(1e12),
  withheldAmount: z.number().nonnegative().max(1e12).nullish(),
  note: z.string().trim().max(1000).nullish(),
})

const createBody = z.object({
  payeeKind: z.enum(PAYEE_KINDS),
  vendorId: z.string().uuid().nullish(),
  payeeName: z.string().trim().max(200).nullish(),
  payeeBankName: z.string().trim().max(160).nullish(),
  payeeBankAccount: z.string().trim().max(160).nullish(),
  /** 收款方銀行代碼；未給且 payeeKind='vendor' 時服務層從 vendors 快照。 */
  payeeBankCode: z.string().trim().max(20).nullish(),
  payingCompanyId: z.string().uuid(),
  method: z.enum(DISBURSEMENT_METHODS),
  paidOn: dateKey.nullish(),
  /** 實付＝淨額。 */
  amount: z.number().nonnegative().max(1e12),
  withheldAmount: z.number().nonnegative().max(1e12).nullish(),
  receiptIssuerCompanyId: z.string().uuid().nullish(),
  receiptRef: z.string().trim().max(120).nullish(),
  /** 是否已取得發票／收據；paid 之後仍可用 PATCH 補（見 services/disbursements.ts PAID_EDITABLE）。 */
  hasInvoice: z.boolean().optional(),
  invoiceNo: z.string().trim().max(40).nullish(),
  purpose: z.string().trim().max(500).nullish(),
  note: z.string().trim().max(2000).nullish(),
  status: z.enum(["draft", "paid"]).default("draft"),
  allocations: z.array(allocationItem).max(200).default([]),
  /** HR 跳過簽核直接建已匯款單，或強制放行未驗收期款的理由（寫稽核）。 */
  forceReason: z.string().trim().max(500).nullish(),
  /** HR 勾「未驗收仍要放款」（M5）。 */
  forceAcceptance: z.boolean().optional(),
})

const patchBody = createBody.omit({ status: true }).partial()
const payBody = z.object({
  paidOn: dateKey.nullish(),
  forceReason: z.string().trim().max(500).nullish(),
  forceAcceptance: z.boolean().optional(),
})
const voidBody = z.object({ reason: z.string().trim().min(1).max(500) })
const submitBody = z.object({
  forceReason: z.string().trim().max(500).nullish(),
  forceAcceptance: z.boolean().optional(),
})
const decisionBody = z.object({ comment: z.string().trim().max(500).nullish() })
const changeApproverBody = z.object({ approverEmpId: z.string().uuid() })
const withdrawBody = z.object({ reason: z.string().trim().min(1).max(500) })
const uploadBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
})

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined
}

/** from／to／vendorId／projectId／companyId／status／q；格式不對回 400 invalid_query。 */
function parseListQuery(query: Request["query"]):
  | { ok: true; filters: { from?: string; to?: string; vendorId?: string; projectId?: string; companyId?: string; status?: DisbursementStatus; q?: string } }
  | { ok: false; param: string } {
  const from = str(query.from)
  const to = str(query.to)
  if (from && !isCalendarDate(from)) return { ok: false, param: "from" }
  if (to && !isCalendarDate(to)) return { ok: false, param: "to" }
  if (from && to && from > to) return { ok: false, param: "from" }
  const ids: Record<string, string | undefined> = {}
  for (const k of ["vendorId", "projectId", "companyId"] as const) {
    const v = str(query[k])
    if (v && !UUID_RE.test(v)) return { ok: false, param: k }
    ids[k] = v
  }
  const status = str(query.status)
  if (status && !(DISBURSEMENT_STATUSES as readonly string[]).includes(status)) return { ok: false, param: "status" }
  return {
    ok: true,
    filters: {
      from,
      to,
      vendorId: ids.vendorId,
      projectId: ids.projectId,
      companyId: ids.companyId,
      status: status as DisbursementStatus | undefined,
      q: str(query.q)?.slice(0, 100),
    },
  }
}

/** 呼叫者（含 role——service 用 `isHrRole` 判斷可不可以強制放行）。 */
async function actorOf(tenantId: string, req: Request): Promise<Actor> {
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  return { empId: self?.id ?? null, role: self?.role ?? null }
}

function handleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof DisbursementError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.details ?? {}) })
    return
  }
  next(err)
}

function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

const guards = [requireAuth, requireTenant, requireFinance] as const
/** HR 專屬（變更簽核人／撤回送簽）。 */
const hrGuards = [requireAuth, requireTenant, requireHrAdmin] as const
/** 簽核動作：任何員工都可能是候選（主管不一定是會計）；能不能簽由關卡決定。 */
const authGuards = [requireAuth, requireTenant] as const

// ── GET /disbursements?from=&to=&vendorId=&projectId=&companyId=&status=&q=&manualPaid=1 ──
/**
 * 匯款紀錄列表（預設近 90 天、排除 void 除非 status=void）。`manualPaid=1` 改列
 * 「已付但無匯款單」的期款（舊路徑手動標記的），讓老闆補單——這個模式不帶 from
 * 就是全部年份，不套近 90 天（要挖的正是很久以前的舊期款）。
 */
disbursementsRouter.get("/disbursements", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = parseListQuery(req.query)
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_query", param: parsed.param })
    return
  }
  try {
    if (req.query.manualPaid === "1" || req.query.manualPaid === "true") {
      const { from, to, items } = await listManualPaidPayments(tenantId, parsed.filters)
      res.status(200).json({ mode: "manualPaid", from, to, items })
      return
    }
    const { from, to, disbursements } = await listDisbursements(tenantId, parsed.filters)
    res.status(200).json({
      from,
      to,
      status: parsed.filters.status ?? "active",
      disbursements,
      totals: {
        count: disbursements.length,
        amount: disbursements.reduce((s, d) => s + (d.status === "void" ? 0 : d.amount), 0),
        withheldAmount: disbursements.reduce((s, d) => s + (d.status === "void" ? 0 : d.withheldAmount), 0),
        grossAmount: disbursements.reduce((s, d) => s + (d.status === "void" ? 0 : d.grossAmount), 0),
      },
    })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /disbursements/summary?from=&to= — 老闆卡 ─────────────────────
disbursementsRouter.get("/disbursements/summary", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = parseListQuery(req.query)
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_query", param: parsed.param })
    return
  }
  try {
    res.status(200).json(await buildSummary(tenantId, { from: parsed.filters.from, to: parsed.filters.to }))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /disbursements/payables?vendorId=&projectId= — 應付清單 ───────
disbursementsRouter.get("/disbursements/payables", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = parseListQuery(req.query)
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_query", param: parsed.param })
    return
  }
  try {
    res.status(200).json(await buildPayables(tenantId, { vendorId: parsed.filters.vendorId, projectId: parsed.filters.projectId }))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /disbursements/pending-approvals?scope=mine|all — 輪到我簽的放款單 ──
/**
 * M4：ESS 簽核頁與後台「放款簽核」頁共用。只要登入就能打（主管不一定是會計）——
 * 看得到什麼由關卡候選決定。`scope=all` 列全租戶送簽中的單，限 finance 角色；
 * 一般員工帶 all 也只會拿到輪到自己的那幾張。
 */
disbursementsRouter.get("/disbursements/pending-approvals", ...authGuards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const actor = await actorOf(tenantId, req)
    if (!actor.empId) {
      res.status(403).json({ error: "not_an_employee" })
      return
    }
    const wantAll = req.query.scope === "all" && isFinanceRole(actor.role)
    const items = await listPendingDisbursementApprovals(tenantId, actor, { scope: wantAll ? "all" : "mine" })
    res.status(200).json({ scope: wantAll ? "all" : "mine", disbursements: items })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /disbursements/export.xlsx?from=&to=… — 同列表篩選 ───────────
disbursementsRouter.get("/disbursements/export.xlsx", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = parseListQuery(req.query)
  if (!parsed.ok) {
    res.status(400).json({ error: "invalid_query", param: parsed.param })
    return
  }
  try {
    const [{ from, to, disbursements }, today] = await Promise.all([listDisbursements(tenantId, parsed.filters), tenantToday(tenantId)])
    const buffer = await disbursementsWorkbookBuffer(disbursements, { from, to, today })
    sendXlsx(res, buffer, disbursementsFilename(from, to))
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /disbursements ────────────────────────────────────────────────
disbursementsRouter.post("/disbursements", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const parsed = createBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actor = await actorOf(tenantId, req)
    const disbursement = await createDisbursement(tenantId, actor, parsed.data)
    res.status(201).json({ disbursement })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── GET /disbursements/:id — 明細＋分攤＋附件（signed URL 3600s） ──────
disbursementsRouter.get("/disbursements/:id", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  try {
    const disbursement = await getDisbursement(tenantId, id)
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    // M4：簽核軌跡（含舊輪）；簽核表尚未套用時是空陣列，畫面自動不顯示該區。
    disbursement.approvalSteps = await loadApprovalTrail(tenantId, id)
    res.status(200).json({ disbursement })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── PATCH /disbursements/:id ───────────────────────────────────────────
disbursementsRouter.patch("/disbursements/:id", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = patchBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actor = await actorOf(tenantId, req)
    const disbursement = await updateDisbursement(tenantId, actor, id, parsed.data)
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ disbursement })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /disbursements/:id/pay {paidOn?,forceReason?,forceAcceptance?} ──
/** approved → paid；draft 直接付款須 HR ＋ `forceReason`（409 `approval_required`）。 */
disbursementsRouter.post("/disbursements/:id/pay", ...guards, async (req: Request, res: Response, next: NextFunction) => {
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
    const disbursement = await payDisbursement(tenantId, actor, id, {
      paidOn: parsed.data.paidOn,
      forceReason: parsed.data.forceReason,
      forceAcceptance: parsed.data.forceAcceptance,
    })
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ disbursement })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /disbursements/:id/void {reason} — paid/draft → void ─────────
disbursementsRouter.post("/disbursements/:id/void", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = voidBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actor = await actorOf(tenantId, req)
    const disbursement = await voidDisbursement(tenantId, actor, id, parsed.data.reason)
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ disbursement })
  } catch (err) {
    handleError(err, res, next)
  }
})

/* ──────────────────────────────────────────────────────────────────
 * M4 簽核鏈：送簽 → 核准／駁回 →（HR）變更簽核人／撤回
 * ────────────────────────────────────────────────────────────────── */

// ── POST /disbursements/:id/submit — draft → pending_approval ─────────
disbursementsRouter.post("/disbursements/:id/submit", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = submitBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actor = await actorOf(tenantId, req)
    const out = await submitDisbursement(tenantId, actor, id, parsed.data)
    if (!out) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /disbursements/:id/approve|reject {comment} ──────────────────
function decisionRoute(action: "approve" | "reject") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    if (!UUID_RE.test(id)) {
      next()
      return
    }
    const parsed = decisionBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const actor = await actorOf(tenantId, req)
      if (!actor.empId) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }
      const out = await decideDisbursement({ action, tenantId, id, actor, comment: parsed.data.comment })
      if (!out) {
        res.status(404).json({ error: "not_found" })
        return
      }
      res.status(200).json(out)
    } catch (err) {
      handleError(err, res, next)
    }
  }
}
disbursementsRouter.post("/disbursements/:id/approve", ...authGuards, decisionRoute("approve"))
disbursementsRouter.post("/disbursements/:id/reject", ...authGuards, decisionRoute("reject"))

// ── POST /disbursements/:id/change-approver {approverEmpId} — HR ──────
disbursementsRouter.post("/disbursements/:id/change-approver", ...hrGuards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = changeApproverBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actor = await actorOf(tenantId, req)
    const out = await changeDisbursementApprover(tenantId, actor, id, parsed.data.approverEmpId)
    if (!out) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── POST /disbursements/:id/withdraw {reason} — HR 撤回送簽 ───────────
disbursementsRouter.post("/disbursements/:id/withdraw", ...hrGuards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = withdrawBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const actor = await actorOf(tenantId, req)
    const disbursement = await withdrawDisbursement(tenantId, actor, id, parsed.data.reason)
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ disbursement })
  } catch (err) {
    handleError(err, res, next)
  }
})

// ── 附件三段式（沿用 project-documents.ts）──────────────────────────────
disbursementsRouter.get("/disbursements/:id/attachments", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  try {
    const disbursement = await loadDisbursement(tenantId, id)
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ attachments: await listAttachments(tenantId, id, true) })
  } catch (err) {
    handleError(err, res, next)
  }
})

disbursementsRouter.post("/disbursements/:id/attachments", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  if (!UUID_RE.test(id)) {
    next()
    return
  }
  const parsed = uploadBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
    return
  }
  try {
    const disbursement = await loadDisbursement(tenantId, id)
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    let bytes: Buffer
    try {
      bytes = Buffer.from(parsed.data.dataBase64, "base64")
    } catch {
      res.status(400).json({ error: "invalid_base64" })
      return
    }
    const actor = await actorOf(tenantId, req)
    const out = await addAttachment(tenantId, actor, disbursement, {
      fileName: parsed.data.fileName,
      contentType: parsed.data.contentType,
      bytes,
    })
    res.status(201).json(out)
  } catch (err) {
    handleError(err, res, next)
  }
})

disbursementsRouter.delete("/disbursements/:id/attachments/:aid", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const id = req.params.id as string
  const aid = req.params.aid as string
  if (!UUID_RE.test(id) || !UUID_RE.test(aid)) {
    next()
    return
  }
  try {
    const disbursement = await loadDisbursement(tenantId, id)
    if (!disbursement) {
      res.status(404).json({ error: "not_found" })
      return
    }
    const actor = await actorOf(tenantId, req)
    const removed = await removeAttachment(tenantId, actor, disbursement, aid)
    if (!removed) {
      res.status(404).json({ error: "not_found" })
      return
    }
    res.status(200).json({ id: aid })
  } catch (err) {
    handleError(err, res, next)
  }
})
