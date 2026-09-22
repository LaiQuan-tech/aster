import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { loadProjectScope } from "../services/project-scope.js"
import { num } from "../services/billing-store.js"
import {
  SUBCONTRACT_KINDS,
  computeSubcontractPayments,
  round0,
  withheldAmount,
  DEFAULT_WITHHOLDING_RATE,
  DEFAULT_WITHHOLDING_THRESHOLD,
} from "../services/project-money.js"
import {
  SUBCONTRACT_COLS,
  PAYMENT_COLS,
  loadSubcontracts,
  loadPayments,
  serializeSubcontract,
  type SubcontractRow,
  type PaymentRow,
} from "../services/project-application-store.js"
import { loadPaymentAcceptance, paymentsHaveAcceptance } from "../services/disbursements.js"
import { writeAuditLog } from "../services/audit.js"

export const subcontractsRouter = Router()

/**
 * 副委託（下包工程／技師簽證費）與其分期放款（P3）。
 *
 * 我方是甲方：發包給協力廠商或技師，分期放款、技師費代扣 10%（起扣 20,000），
 * 收據可能開給集團另一家公司（`receiptIssuerCompanyId` ≠ `payingCompanyId`）。
 *
 * 權限：finance（HR／該案 lead／該案部門主管）。
 *
 * ── 整批 PUT，比照 billings ──────────────────────────────────────────
 * 帶 id 更新、沒 id 新增、未出現的軟刪（必填 `deleteReason`）。
 * 有**已付款期別**的副委託不可移除（409 `paid`）——錢已經付出去了。
 *
 * ── 期款：金額算法與請款期程同一套 ──────────────────────────────────
 * `amount = round(percentage × 下包金額)`，末期吸收尾差（`computeInstallments`），
 * 可 `overrideAmount + overrideReason`。已付（`paidOn`）的期別凍結金額；
 * `withheldAmount = amount > 門檻 ? round(amount × 扣繳率) : 0` 按期算。
 *
 * ⚠️ `project_subcontract_payments` 沒有軟刪欄位、又掛了 no_hard_delete
 * trigger（sql/0028），所以**期款列不能移除**：payload 漏掉既有列一律 409
 * `payment_not_removable`（已付的回 `paid`）。要「拿掉」一期就把它的百分比
 * 改成 0。測試租戶雖然刪得掉，這裡刻意不刪，免得正式環境行為不一樣。
 *
 * ── 驗收確認（M5，2026-09-23）────────────────────────────────────────
 * 每期多了 `accepted_on` / `accepted_by_emp_id` / `acceptance_note`：**沒驗收就
 * 不能放款**（放款專區建單／改分攤／送簽／付款都會擋，409 `acceptance_required`，
 * 見 services/disbursements.ts `assertPaymentsAccepted`）。這裡提供兩個寫入點：
 * 整批 PUT 帶 `acceptedOn` / `acceptanceNote`，以及單期的
 * `POST …/payments/:installmentNo/accept`（專案頁每期的「驗收確認」鈕）。
 * **已付款的期別不可清掉驗收日**（400 `acceptance_locked`）——錢都付了還說沒驗收。
 * 欄位尚未套用（migration 0050）時整段略過，行為與上線前一致。
 *
 * ── 與放款專區的分工 ────────────────────────────────────────────────
 * 期款有 `disbursement_id`（放款專區連動付清）時，放款日／實付／撤銷付款
 * 一律 409 `linked_to_disbursement`——單一真相在匯款單，要改就作廢那張單。
 * 沒有 `disbursement_id` 的舊路徑（手動標記已付）維持原樣，專案頁顯示
 * 「手動標記」，放款專區列表可用 `manualPaid=1` 找出來補單。
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

const subcontractItem = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(SUBCONTRACT_KINDS).optional(),
  discipline: z.string().trim().max(40).nullish(),
  vendorId: z.string().uuid().nullish(),
  vendorName: z.string().trim().max(120).nullish(),
  contact: z.string().trim().max(120).nullish(),
  item: z.string().trim().max(200).nullish(),
  amount: z.number().nonnegative().max(1e12),
  billingBasis: z.string().trim().max(200).nullish(),
  orderType: z.enum(["quotation", "contract"]).nullish(),
  contractId: z.string().uuid().nullish(),
  withholdingRate: z.number().min(0).max(1).nullish(),
  withholdingThreshold: z.number().int().min(0).max(1e9).nullish(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  note: z.string().trim().max(2000).nullish(),
})

const putSubcontractsBody = z.object({
  subcontracts: z.array(subcontractItem).max(100),
  /** 有要移除的列時必填。 */
  deleteReason: z.string().trim().min(1).max(500).optional(),
})

const paymentItem = z.object({
  id: z.string().uuid().optional(),
  installmentNo: z.number().int().min(1).max(999),
  percentage: z.number().min(0).max(100).nullish(),
  overrideAmount: z.number().nonnegative().nullish(),
  overrideReason: z.string().trim().max(1000).nullish(),
  dueWhen: z.string().trim().max(200).nullish(),
  paidOn: z.string().regex(dateRe).nullish(),
  /** 實付（毛額 − 代扣）。省略時＝有效毛額 − 代扣。 */
  paidAmount: z.number().nonnegative().nullish(),
  payingCompanyId: z.string().uuid().nullish(),
  receiptIssuerCompanyId: z.string().uuid().nullish(),
  receiptRef: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(2000).nullish(),
  /** M5 驗收確認日；null＝取消驗收（已付款的期別不可清）。 */
  acceptedOn: z.string().regex(dateRe).nullish(),
  acceptanceNote: z.string().trim().max(1000).nullish(),
})

const acceptBody = z.object({
  acceptedOn: z.string().regex(dateRe).optional(),
  note: z.string().trim().max(1000).nullish(),
})

const putPaymentsBody = z.object({
  payments: z.array(paymentItem).max(100),
  /** 把已付的期別改回未付時必填（撤銷一個付款事件要有理由，同 unbill）。 */
  reason: z.string().trim().min(1).max(500).optional(),
})

/**
 * M5：`serializeSubcontract`（services/project-application-store.ts）是好幾個模組
 * 共用的純函式，不在本 WP 範圍；驗收三欄改在這裡查出來後掛回期款物件上，形狀
 * 與其他期款欄位一致（`acceptedOn` / `acceptedByEmpId` / `acceptanceNote`）。
 * 欄位尚未套用時 `loadPaymentAcceptance` 回 null，這裡就原樣回傳。
 */
async function withAcceptance<T extends { payments?: Array<Record<string, unknown>> }>(
  tenantId: string,
  subcontracts: T[],
): Promise<T[]> {
  const ids = subcontracts.flatMap((s) => (s.payments ?? []).map((p) => p.id as string | undefined)).filter((v): v is string => !!v)
  const acceptance = await loadPaymentAcceptance(tenantId, ids)
  if (acceptance === null) return subcontracts
  for (const sub of subcontracts) {
    for (const p of sub.payments ?? []) {
      const row = acceptance.get(p.id as string)
      p.acceptedOn = row?.accepted_on ?? null
      p.acceptedByEmpId = row?.accepted_by_emp_id ?? null
      p.acceptanceNote = row?.acceptance_note ?? null
    }
  }
  return subcontracts
}

async function respondSubcontracts(tenantId: string, projectId: string, res: Response, status = 200) {
  const subs = await loadSubcontracts(tenantId, projectId)
  const payments = await loadPayments(tenantId, subs.map((s) => s.id))
  const bySub = new Map<string, PaymentRow[]>()
  for (const p of payments) {
    const arr = bySub.get(p.subcontract_id)
    if (arr) arr.push(p)
    else bySub.set(p.subcontract_id, [p])
  }
  const serialized = await withAcceptance(tenantId, subs.map((s) => serializeSubcontract(s, bySub.get(s.id) ?? [])))
  const subcontractTotal = serialized.filter((s) => s.kind !== "technician").reduce((a, s) => a + s.amount, 0)
  const technicianTotal = serialized.filter((s) => s.kind === "technician").reduce((a, s) => a + s.amount, 0)
  res.status(status).json({
    subcontracts: serialized,
    summary: {
      subcontractTotal,
      technicianTotal,
      total: subcontractTotal + technicianTotal,
      paidTotal: serialized.reduce((a, s) => a + s.summary.paidTotal, 0),
      withheldTotal: serialized.reduce((a, s) => a + s.summary.withheldTotal, 0),
    },
  })
}

async function idsExist(table: string, tenantId: string, ids: string[], extra?: (q: any) => any): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  let q = supabaseAdmin.from(table).select("id").eq("tenant_id", tenantId).in("id", ids)
  if (extra) q = extra(q)
  const { data, error } = await q
  if (error) throw new Error(`idsExist(${table}): ${error.message}`)
  return new Set((data ?? []).map((r: { id: string }) => r.id))
}

/**
 * 重算一個副委託的期款：未付的期別寫回 amount／withheld_amount，已付的不動。
 * 下包金額改了、或期款百分比改了都要跑；與 billing-store.recomputeBillings 同一個理由
 * （試算值存進 DB，報表直接讀）。
 */
async function recomputePayments(tenantId: string, sub: SubcontractRow, payments: PaymentRow[]): Promise<void> {
  if (payments.length === 0) return
  const contractAmount = num(sub.amount) ?? 0
  const rate = num(sub.withholding_rate) ?? DEFAULT_WITHHOLDING_RATE
  const threshold = Number(sub.withholding_threshold ?? DEFAULT_WITHHOLDING_THRESHOLD)
  const result = computeSubcontractPayments(
    payments.map((p) => ({
      installmentNo: p.installment_no,
      percentage: num(p.percentage),
      overrideAmount: num(p.override_amount),
      paid: p.paid_on !== null,
      paidGrossAmount: num(p.override_amount) ?? num(p.amount),
    })),
    contractAmount,
    rate,
    threshold,
  )
  const byNo = new Map(result.rows.map((r) => [r.installmentNo, r]))
  for (const p of payments) {
    if (p.paid_on !== null) continue
    const next = byNo.get(p.installment_no)
    if (!next) continue
    // amount 欄＝系統試算：一般期別是含尾差的試算值；覆寫的期別存「純百分比算出來的數」
    // （試算與覆寫分開存才看得出偏離多少）。
    const pct = num(p.percentage)
    const rawCalc = pct === null ? 0 : round0(contractAmount * (pct / 100))
    const amount = next.calculatedAmount ?? rawCalc
    const withheld = next.withheldAmount
    if (num(p.amount) === amount && (num(p.withheld_amount) ?? 0) === withheld) continue
    const { error } = await supabaseAdmin
      .from("project_subcontract_payments")
      .update({ amount, withheld_amount: withheld, updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("id", p.id)
    if (error) throw new Error(`recomputePayments: ${error.message}`)
  }
}

// ── GET /projects/:id/subcontracts ────────────────────────────────────
subcontractsRouter.get(
  "/projects/:id/subcontracts",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const scope = await loadProjectScope(tenantId, userId, req.params.id as string)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.finance) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      await respondSubcontracts(tenantId, req.params.id as string, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /projects/:id/subcontracts — 整批 ─────────────────────────────
subcontractsRouter.put(
  "/projects/:id/subcontracts",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const projectId = req.params.id as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = putSubcontractsBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadProjectScope(tenantId, userId, projectId)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.finance) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const payload = parsed.data.subcontracts
      const existing = await loadSubcontracts(tenantId, projectId)
      const existingById = new Map(existing.map((s) => [s.id, s]))

      // 參照檢查：廠商要在名冊裡（未刪）、合約要是本案的（未作廢）。
      const vendorIds = [...new Set(payload.map((p) => p.vendorId).filter((v): v is string => !!v))]
      const contractIds = [...new Set(payload.map((p) => p.contractId).filter((v): v is string => !!v))]
      const [vendors, contracts] = await Promise.all([
        idsExist("vendors", tenantId, vendorIds, (q) => q.is("deleted_at", null)),
        idsExist("contracts", tenantId, contractIds, (q) => q.eq("project_id", projectId).is("deleted_at", null)),
      ])
      for (const p of payload) {
        if (p.id && !existingById.has(p.id)) {
          res.status(404).json({ error: "not_found", id: p.id })
          return
        }
        if (p.vendorId && !vendors.has(p.vendorId)) {
          res.status(400).json({ error: "invalid_vendor", vendorId: p.vendorId })
          return
        }
        if (p.contractId && !contracts.has(p.contractId)) {
          res.status(400).json({ error: "invalid_contract", contractId: p.contractId })
          return
        }
      }

      // 未出現的 → 軟刪；有已付期款的不可移除。
      const keepIds = new Set(payload.map((p) => p.id).filter((v): v is string => !!v))
      const removing = existing.filter((s) => !keepIds.has(s.id))
      if (removing.length > 0) {
        if (!parsed.data.deleteReason) {
          res.status(400).json({ error: "delete_reason_required", ids: removing.map((s) => s.id) })
          return
        }
        const paidRows = await loadPayments(tenantId, removing.map((s) => s.id))
        const paid = paidRows.find((p) => p.paid_on !== null)
        if (paid) {
          res.status(409).json({ error: "paid", subcontractId: paid.subcontract_id, installmentNo: paid.installment_no })
          return
        }
        const nowIso = new Date().toISOString()
        for (const s of removing) {
          const { error } = await supabaseAdmin
            .from("project_subcontracts")
            .update({ deleted_at: nowIso, deleted_by: scope.self.id, delete_reason: parsed.data.deleteReason, updated_at: nowIso })
            .eq("tenant_id", tenantId)
            .eq("id", s.id)
          if (error) {
            next(new Error(`PUT /projects/${projectId}/subcontracts (delete): ${error.message}`))
            return
          }
        }
      }

      const nowIso = new Date().toISOString()
      const touched: string[] = []
      for (let i = 0; i < payload.length; i++) {
        const p = payload[i]
        const fields: Record<string, unknown> = {
          kind: p.kind ?? "subcontract",
          discipline: p.discipline ?? null,
          vendor_id: p.vendorId ?? null,
          vendor_name: p.vendorName ?? null,
          contact: p.contact ?? null,
          item: p.item ?? null,
          amount: p.amount,
          billing_basis: p.billingBasis ?? null,
          order_type: p.orderType ?? null,
          contract_id: p.contractId ?? null,
          withholding_rate: p.withholdingRate ?? DEFAULT_WITHHOLDING_RATE,
          withholding_threshold: p.withholdingThreshold ?? DEFAULT_WITHHOLDING_THRESHOLD,
          sort_order: p.sortOrder ?? i,
          note: p.note ?? null,
          updated_at: nowIso,
        }
        if (p.id) {
          const { error } = await supabaseAdmin
            .from("project_subcontracts")
            .update(fields)
            .eq("tenant_id", tenantId)
            .eq("id", p.id)
          if (error) {
            next(new Error(`PUT /projects/${projectId}/subcontracts (update): ${error.message}`))
            return
          }
          touched.push(p.id)
        } else {
          const { data, error } = await supabaseAdmin
            .from("project_subcontracts")
            .insert({ tenant_id: tenantId, project_id: projectId, created_by_emp_id: scope.self.id, ...fields })
            .select("id")
            .single()
          if (error || !data) {
            next(new Error(`PUT /projects/${projectId}/subcontracts (insert): ${error?.message}`))
            return
          }
          touched.push(data.id as string)
        }
      }

      // 下包金額／扣繳參數改了，未付的期款要跟著重算。
      const refreshed = await loadSubcontracts(tenantId, projectId)
      const payments = await loadPayments(tenantId, refreshed.map((s) => s.id))
      for (const s of refreshed) {
        if (!touched.includes(s.id)) continue
        await recomputePayments(tenantId, s, payments.filter((p) => p.subcontract_id === s.id))
      }

      await writeAuditLog({
        tenantId,
        tableName: "project_subcontracts",
        recordId: projectId,
        action: "UPDATE",
        newRow: parsed.data,
        actorEmpId: scope.self.id,
        context: "PUT /projects/:id/subcontracts",
      })
      await respondSubcontracts(tenantId, projectId, res)
    } catch (err) {
      next(err)
    }
  },
)

// ── PUT /projects/:id/subcontracts/:sid/payments — 整批期款 ───────────
subcontractsRouter.put(
  "/projects/:id/subcontracts/:sid/payments",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const projectId = req.params.id as string
    const subcontractId = req.params.sid as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = putPaymentsBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadProjectScope(tenantId, userId, projectId)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.finance) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const { data: subData, error: subErr } = await supabaseAdmin
        .from("project_subcontracts")
        .select(SUBCONTRACT_COLS)
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("id", subcontractId)
        .is("deleted_at", null)
        .maybeSingle()
      if (subErr) {
        next(new Error(`PUT payments (load subcontract): ${subErr.message}`))
        return
      }
      if (!subData) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const sub = subData as unknown as SubcontractRow
      const payload = parsed.data.payments

      // 期別編號不可重複；覆寫要理由。
      const seen = new Set<number>()
      for (const item of payload) {
        if (seen.has(item.installmentNo)) {
          res.status(400).json({ error: "duplicate_installment_no", installmentNo: item.installmentNo })
          return
        }
        seen.add(item.installmentNo)
        if (item.overrideAmount !== null && item.overrideAmount !== undefined && !item.overrideReason) {
          res.status(400).json({ error: "override_reason_required", installmentNo: item.installmentNo })
          return
        }
      }

      // 付款／收據主體要在 companies 名冊裡。
      const companyIds = [
        ...new Set(
          payload
            .flatMap((p) => [p.payingCompanyId, p.receiptIssuerCompanyId])
            .filter((v): v is string => !!v),
        ),
      ]
      const companies = await idsExist("companies", tenantId, companyIds)
      for (const p of payload) {
        for (const cid of [p.payingCompanyId, p.receiptIssuerCompanyId]) {
          if (cid && !companies.has(cid)) {
            res.status(400).json({ error: "invalid_company", companyId: cid })
            return
          }
        }
      }

      const existing = await loadPayments(tenantId, [subcontractId])
      const byId = new Map(existing.map((p) => [p.id, p]))
      const byNo = new Map(existing.map((p) => [p.installment_no, p]))

      // 對應到既有列：先看 id，再看期別編號（UI 沒帶 id 也能冪等）。
      const matched = new Map<number, PaymentRow | null>()
      for (const item of payload) {
        let row: PaymentRow | null = null
        if (item.id) {
          row = byId.get(item.id) ?? null
          if (!row) {
            res.status(404).json({ error: "not_found", id: item.id })
            return
          }
        } else {
          row = byNo.get(item.installmentNo) ?? null
        }
        matched.set(item.installmentNo, row)
      }
      const matchedIds = new Set([...matched.values()].filter((r): r is PaymentRow => !!r).map((r) => r.id))
      // 期別編號撞到另一列（改號撞到既有的）。
      for (const item of payload) {
        const other = byNo.get(item.installmentNo)
        const mine = matched.get(item.installmentNo)
        if (other && mine && other.id !== mine.id) {
          res.status(409).json({ error: "installment_no_taken", installmentNo: item.installmentNo })
          return
        }
      }

      // 漏掉的既有列：不能移除（見檔頭）。
      const missing = existing.filter((p) => !matchedIds.has(p.id))
      const missingPaid = missing.find((p) => p.paid_on !== null)
      if (missingPaid) {
        res.status(409).json({ error: "paid", installmentNo: missingPaid.installment_no })
        return
      }
      if (missing.length > 0) {
        res.status(409).json({
          error: "payment_not_removable",
          installmentNos: missing.map((p) => p.installment_no),
          hint: "期款列不可移除；要拿掉就把該期百分比改成 0。",
        })
        return
      }

      // 已付的期別：金額凍結；改回未付要理由。
      let unpaying = false
      for (const item of payload) {
        const row = matched.get(item.installmentNo)
        if (!row || row.paid_on === null) continue
        const pctChanged = (item.percentage ?? null) !== num(row.percentage)
        const overrideChanged = (item.overrideAmount ?? null) !== num(row.override_amount)
        if (pctChanged || overrideChanged) {
          res.status(409).json({ error: "paid", installmentNo: row.installment_no })
          return
        }
        // 由放款專區連動付清的期別：放款日／實付／撤銷付款都歸匯款單管（要改就去作廢那張單），
        // 這裡只准改備註類欄位。
        if (row.disbursement_id) {
          const paidOnChanged = item.paidOn !== undefined && item.paidOn !== row.paid_on
          const paidAmountChanged =
            item.paidAmount !== undefined && item.paidAmount !== null && item.paidAmount !== num(row.paid_amount)
          if (paidOnChanged || paidAmountChanged) {
            res.status(409).json({
              error: "linked_to_disbursement",
              installmentNo: row.installment_no,
              disbursementId: row.disbursement_id,
              disbursementNo: row.disbursement_no ?? null,
              hint: "此期款由放款專區的匯款單連動付清；要改放款日／實付或撤銷，請作廢該匯款單。",
            })
            return
          }
        }
        if (item.paidOn === null) unpaying = true
      }
      if (unpaying && !parsed.data.reason) {
        res.status(400).json({ error: "reason_required" })
        return
      }

      const contractAmount = num(sub.amount) ?? 0
      const rate = num(sub.withholding_rate) ?? DEFAULT_WITHHOLDING_RATE
      const threshold = Number(sub.withholding_threshold ?? DEFAULT_WITHHOLDING_THRESHOLD)

      // 先算整份（已付凍結、末期吸收尾差），再逐列寫。
      const computed = computeSubcontractPayments(
        payload.map((item) => {
          const row = matched.get(item.installmentNo)
          const stillPaid = !!row && row.paid_on !== null && item.paidOn !== null
          return {
            installmentNo: item.installmentNo,
            percentage: item.percentage ?? null,
            overrideAmount: item.overrideAmount ?? null,
            paid: stillPaid,
            paidGrossAmount: stillPaid ? (num(row!.override_amount) ?? num(row!.amount)) : null,
          }
        }),
        contractAmount,
        rate,
        threshold,
      )
      const computedByNo = new Map(computed.rows.map((r) => [r.installmentNo, r]))
      const nowIso = new Date().toISOString()

      // M5：驗收欄位（欄位尚未套用就整段不碰）。
      const acceptanceReady = await paymentsHaveAcceptance()
      const acceptance = acceptanceReady ? await loadPaymentAcceptance(tenantId, existing.map((p) => p.id)) : null
      if (acceptance) {
        for (const item of payload) {
          const row = matched.get(item.installmentNo)
          if (!row || item.acceptedOn !== null) continue
          // 已付款的期別不可清掉驗收日（錢都付了還說沒驗收）。
          if (row.paid_on && acceptance.get(row.id)?.accepted_on) {
            res.status(400).json({ error: "acceptance_locked", installmentNo: item.installmentNo })
            return
          }
        }
      }

      for (const item of payload) {
        const row = matched.get(item.installmentNo)
        const calc = computedByNo.get(item.installmentNo)!
        const stillPaid = !!row && row.paid_on !== null && item.paidOn !== null
        const fields: Record<string, unknown> = {
          due_when: item.dueWhen ?? null,
          paying_company_id: item.payingCompanyId ?? null,
          receipt_issuer_company_id: item.receiptIssuerCompanyId ?? null,
          receipt_ref: item.receiptRef ?? null,
          note: item.note ?? null,
          updated_at: nowIso,
        }
        if (acceptanceReady) {
          // 沒帶就不碰（專案頁的「驗收確認」走 /accept 端點，整批 PUT 不會誤清）。
          if (item.acceptedOn !== undefined) {
            fields.accepted_on = item.acceptedOn
            fields.accepted_by_emp_id = item.acceptedOn ? scope.self.id : null
          }
          if (item.acceptanceNote !== undefined) fields.acceptance_note = item.acceptanceNote?.trim() || null
        }
        if (stillPaid) {
          // 已付：只准改付款日／實付金額與備註類欄位，金額欄不動。
          if (item.paidOn !== undefined) fields.paid_on = item.paidOn
          if (item.paidAmount !== undefined && item.paidAmount !== null) fields.paid_amount = item.paidAmount
        } else {
          const pct = item.percentage ?? null
          const rawCalc = pct === null ? 0 : round0(contractAmount * (pct / 100))
          const effective = calc.effectiveAmount
          const withheld = withheldAmount(effective, rate, threshold)
          fields.percentage = pct
          fields.amount = calc.calculatedAmount ?? rawCalc
          fields.override_amount = item.overrideAmount ?? null
          fields.override_reason = item.overrideAmount !== null && item.overrideAmount !== undefined ? item.overrideReason ?? null : null
          fields.withheld_amount = withheld
          if (item.paidOn) {
            // 這一期在這次存檔被標成已付：實付預設＝毛額 − 代扣。
            if (effective === null) {
              res.status(400).json({ error: "amount_unknown", installmentNo: item.installmentNo })
              return
            }
            fields.paid_on = item.paidOn
            fields.paid_amount = item.paidAmount ?? effective - withheld
          } else {
            fields.paid_on = null
            fields.paid_amount = null
            if (row && row.paid_on !== null) {
              // 撤銷付款事件：理由附在備註後（同 billings unbill）。
              fields.note = [item.note ?? row.note, `撤銷付款（原 ${row.paid_on} 實付 ${num(row.paid_amount) ?? "-"}）：${parsed.data.reason}`]
                .filter(Boolean)
                .join("\n")
            }
          }
        }

        if (row) {
          const { error } = await supabaseAdmin
            .from("project_subcontract_payments")
            .update({ ...fields, installment_no: item.installmentNo })
            .eq("tenant_id", tenantId)
            .eq("id", row.id)
          if (error) {
            next(new Error(`PUT payments (update): ${error.message}`))
            return
          }
        } else {
          const { error } = await supabaseAdmin.from("project_subcontract_payments").insert({
            tenant_id: tenantId,
            subcontract_id: subcontractId,
            installment_no: item.installmentNo,
            ...fields,
          })
          if (error) {
            if (error.code === "23505") {
              res.status(409).json({ error: "installment_no_taken", installmentNo: item.installmentNo })
              return
            }
            next(new Error(`PUT payments (insert): ${error.message}`))
            return
          }
        }
      }

      await writeAuditLog({
        tenantId,
        tableName: "project_subcontract_payments",
        recordId: subcontractId,
        action: "UPDATE",
        newRow: parsed.data,
        actorEmpId: scope.self.id,
        context: "PUT /projects/:id/subcontracts/:sid/payments",
      })
      const payments = await loadPayments(tenantId, [subcontractId])
      const [serialized] = await withAcceptance(tenantId, [serializeSubcontract(sub, payments)])
      res.status(200).json({ subcontract: serialized })
    } catch (err) {
      next(err)
    }
  },
)

// ── POST /projects/:id/subcontracts/:sid/payments/:installmentNo/accept ──
/**
 * M5 驗收確認：專案頁每期的「驗收確認」鈕。`acceptedOn` 省略＝今天（租戶當地日，
 * 這裡沿用前端傳值；未傳就用伺服器當日）。已經驗收過的期別重按＝更新日期／備註
 * （冪等），不另外擋。驗收欄位尚未套用（migration 0050）→ 503 `acceptance_not_available`。
 */
subcontractsRouter.post(
  "/projects/:id/subcontracts/:sid/payments/:installmentNo/accept",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const projectId = req.params.id as string
    const subcontractId = req.params.sid as string
    const installmentNo = Number(req.params.installmentNo)
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    if (!Number.isInteger(installmentNo) || installmentNo < 1) {
      res.status(400).json({ error: "invalid_installment_no" })
      return
    }
    const parsed = acceptBody.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const scope = await loadProjectScope(tenantId, userId, projectId)
      if (!scope.ok) {
        res.status(scope.status).json({ error: scope.error })
        return
      }
      if (!scope.finance) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      if (!(await paymentsHaveAcceptance())) {
        res.status(503).json({ error: "acceptance_not_available" })
        return
      }
      const existing = await loadPayments(tenantId, [subcontractId])
      const row = existing.find((p) => p.installment_no === installmentNo)
      if (!row) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const acceptedOn = parsed.data.acceptedOn ?? new Date().toISOString().slice(0, 10)
      const { error } = await supabaseAdmin
        .from("project_subcontract_payments")
        .update({
          accepted_on: acceptedOn,
          accepted_by_emp_id: scope.self.id,
          acceptance_note: parsed.data.note?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", row.id)
      if (error) {
        next(new Error(`accept payment: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "project_subcontract_payments",
        recordId: row.id,
        action: "UPDATE",
        oldRow: row,
        newRow: { accepted_on: acceptedOn, accepted_by_emp_id: scope.self.id, acceptance_note: parsed.data.note ?? null },
        actorEmpId: scope.self.id,
        context: "POST /projects/:id/subcontracts/:sid/payments/:no/accept",
      })
      const { data: subData, error: subErr } = await supabaseAdmin
        .from("project_subcontracts")
        .select(SUBCONTRACT_COLS)
        .eq("tenant_id", tenantId)
        .eq("project_id", projectId)
        .eq("id", subcontractId)
        .is("deleted_at", null)
        .maybeSingle()
      if (subErr) {
        next(new Error(`accept payment (subcontract): ${subErr.message}`))
        return
      }
      if (!subData) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const payments = await loadPayments(tenantId, [subcontractId])
      const [serialized] = await withAcceptance(tenantId, [serializeSubcontract(subData as unknown as SubcontractRow, payments)])
      res.status(200).json({ subcontract: serialized, acceptedOn })
    } catch (err) {
      next(err)
    }
  },
)
