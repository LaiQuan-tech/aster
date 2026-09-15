import { Router, type Request, type Response, type NextFunction } from "express"
import { parseRuleConfig } from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import {
  currentPeriod,
  loadRuleConfig,
  nextPeriodFirstDay,
  todayDateString,
} from "../services/payroll-inputs.js"
import { writeAuditLog } from "../services/audit.js"

export const ruleConfigRouter = Router()

const effectiveFromRe = /^\d{4}-\d{2}-\d{2}$/

/**
 * PUT 的 `effectiveFrom` → 實際寫進 rule_configs.effective_from 的日期。
 *
 *   • "now"                → 今天（立刻生效，含當月）
 *   • 未給／null／空字串   → 下個月1號（預設：不影響本月已在跑的數字）
 *   • 'YYYY-MM-DD'         → 照收
 *   • 其他                 → null（呼叫端回 400 invalid_effective_from）
 */
function resolveEffectiveFrom(input: unknown): string | null {
  if (input === "now") return todayDateString()
  if (input === undefined || input === null || input === "") return nextPeriodFirstDay(currentPeriod())
  if (typeof input === "string" && isValidCalendarDate(input)) return input
  return null
}

/**
 * `/^\d{4}-\d{2}-\d{2}$/` 只驗形狀，"2026-13-99"／"2026-02-30" 這種日曆上不存在
 * 的日期會通過 regex，insert 到 DB 時才炸——但那時「停用舊版」可能已經跑完，
 * 會把 nextVersion 的計算基準搞爛（見 PUT handler 內的註解）。這裡用往返驗證：
 * 組回 UTC Date 再比對三個欄位有沒有被瀏覽器式的「進位」（例如 13 月變成隔年 1
 * 月）吃掉，比單純 regex 嚴謹。
 */
function isValidCalendarDate(input: string): boolean {
  if (!effectiveFromRe.test(input)) return false
  const [y, m, d] = input.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** GET /rule-config/versions 的一列。`summary` 目前 schema 無對應欄位，故不回。 */
interface RuleConfigVersionRow {
  version: number
  effectiveFrom: string | null
  createdAt: string | null
  active: boolean
  summary?: string
}

/**
 * GET /rule-config — 今天所屬月份生效的 差勤/薪資規則 config。Readable by any
 * authenticated member of the tenant (employees may need to render rules); when
 * the tenant has not saved one yet（或所有版本的 effective_from 都還沒到）
 * `loadRuleConfig` 會退回 DEFAULT_RULE_CONFIG，client 永遠拿得到合法形狀。
 * Tenant-scoped via res.locals.tenantId.
 *
 * ⚠️ 選版改走 services/payroll-inputs 的 `loadRuleConfig`，跟薪資／結算同一套
 * 邏輯——設定頁看到的規則必須就是系統這個月實際在用的那一版。回傳的 config 是
 * parseRuleConfig 過的形狀（預設值已填），不再是原始 jsonb。
 */
ruleConfigRouter.get(
  "/rule-config",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { rules, version, effectiveFrom, isDefault } = await loadRuleConfig(tenantId)
      res.status(200).json({ config: rules, version, effectiveFrom, isDefault })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /rule-config/versions — 這個租戶的規則版本歷史（新版在前）。
 *
 * 權限用 requireHrAdmin（跟 PUT 同級）：版本歷史是管理端資訊——誰在什麼時候換
 * 過規則、哪一版從哪天起生效——一般員工只需要看到「現在的規則」（GET
 * /rule-config），不需要看得到異動軌跡。
 *
 * 查無資料回空陣列（不是 404）：沒存過規則的租戶是正常狀態，不是錯誤。
 */
ruleConfigRouter.get(
  "/rule-config/versions",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("rule_configs")
        .select("version, effective_from, created_at, active")
        .eq("tenant_id", tenantId)
        .order("version", { ascending: false })
      if (error) {
        next(new Error(`GET /rule-config/versions: ${error.message}`))
        return
      }
      const rows = (data ?? []) as Array<{
        version: number | null
        effective_from: string | null
        created_at: string | null
        active: boolean | null
      }>
      const versions: RuleConfigVersionRow[] = rows.map((r) => ({
        version: typeof r.version === "number" ? r.version : 0,
        effectiveFrom: r.effective_from ?? null,
        createdAt: r.created_at ?? null,
        active: r.active === true,
      }))
      res.status(200).json(versions)
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PUT /rule-config — HR admin saves the tenant's rule config. The body is the
 * raw DSL; it is validated with @hr/rules' parseRuleConfig (the SAME validator
 * the engine uses) before anything is written — an invalid DSL is a 400 and
 * touches no rows. On success we deactivate the current active row and insert a
 * new active row at version+1, so exactly one active config exists per tenant
 * while history is preserved.
 *
 * Body 除了規則 DSL 本體外，可多帶一個 `effectiveFrom`（這一版從哪天起適用於
 * 計算）：'now' = 今天、'YYYY-MM-DD' = 指定日、不給 = 下個月1號。它必須在丟給
 * parseRuleConfig 之前從 body 拆掉，否則會被當成未知的 DSL 欄位。
 */
ruleConfigRouter.put(
  "/rule-config",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string

    // `effectiveFrom` 是版本的中繼資料，不是規則 DSL 的一部分 → 先拆出來。
    // body 不是普通物件時原封不動往下丟，讓 parseRuleConfig 給出跟以前一樣的 400。
    const isPlainBody =
      req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
    const { effectiveFrom: effectiveFromInput, ...ruleBody } = isPlainBody
      ? (req.body as Record<string, unknown>)
      : ({} as Record<string, unknown>)
    const ruleInput: unknown = isPlainBody ? ruleBody : req.body

    // Validate via the engine's own parser — this is the load-bearing guard.
    let config
    try {
      config = parseRuleConfig(ruleInput)
    } catch (err) {
      res.status(400).json({
        error: "invalid_rule_config",
        details: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // 生效日壞掉就整筆退回——不要寫入一列生效日不明的規則。
    const resolvedEffectiveFrom = resolveEffectiveFrom(effectiveFromInput)
    if (resolvedEffectiveFrom === null) {
      res.status(400).json({ error: "invalid_effective_from" })
      return
    }

    try {
      // nextVersion 取這個租戶「所有版本」（不篩 active）的最大值＋1。C4 之後
      // active 只代表「最後存的那版」，跟「現在生效的那版」在生效日之前必然
      // 不同——若還用 active 篩，一旦曾經發生過下面 insert 失敗、active 被清空
      // 的情況，下一次 PUT 會把 nextVersion 算回 1，造成 version 重複。
      const { data: current, error: curErr } = await supabaseAdmin
        .from("rule_configs")
        .select("id, version")
        .eq("tenant_id", tenantId)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (curErr) {
        next(new Error(`PUT /rule-config (current): ${curErr.message}`))
        return
      }

      const nextVersion = (current?.version ?? 0) + 1

      // 先 insert 新版、成功了才停用舊版（順序刻意反過來）：effective_from 驗證
      // 再嚴謹也難保 insert 不會因為其他原因失敗（DB 暫斷線等）；若先停用舊版
      // 才 insert、insert 又失敗，這個租戶會落到「零個 active」，且上面的
      // nextVersion 已經不看 active 了，不會被這個狀態污染，但畫面/舊版
      // consumer 若還在讀 active 會短暫看不到任何生效規則。insert 優先可以讓
      // 失敗時舊版原封不動、什麼都沒發生。
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("rule_configs")
        .insert({
          tenant_id: tenantId,
          scope: "all",
          config,
          version: nextVersion,
          active: true,
          // 不給就會落回 schema default '1900-01-01'，等於「從古至今都適用」，
          // 選版邏輯就永遠選到最新版——生效日必須明寫。
          effective_from: resolvedEffectiveFrom,
        })
        .select("id, version, effective_from")
        .single()
      if (insErr || !inserted) {
        next(new Error(`PUT /rule-config (insert): ${insErr?.message}`))
        return
      }

      // Deactivate every other row for this tenant now that the new one exists
      // (exclude the row we just inserted — belt-and-braces, it's already the
      // only one with this id). A failure here leaves an extra active=true row
      // behind but does NOT corrupt version numbering or the new row's
      // effective_from, so it's safe to surface as an error without rolling
      // back the insert (there is nothing destructive to roll back).
      const { error: deactErr } = await supabaseAdmin
        .from("rule_configs")
        .update({ active: false })
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .neq("id", inserted.id as string)
      if (deactErr) {
        next(new Error(`PUT /rule-config (deactivate): ${deactErr.message}`))
        return
      }

      // 稽核（應用層）：版本遞移；config 全文由 trigger 的 new_row 記。
      await writeAuditLog({
        tenantId,
        tableName: "rule_configs",
        recordId: inserted.id as string,
        action: "INSERT",
        oldRow: current ? { id: current.id, version: current.version } : null,
        newRow: { version: inserted.version, scope: "all", active: true },
        context: "PUT /rule-config — 儲存差勤／薪資規則（新版本）",
      })
      // effectiveFrom 一併回傳：預設值（下個月1號）是伺服器算的，client 無從得知。
      res.status(200).json({
        id: inserted.id,
        version: inserted.version,
        effectiveFrom: inserted.effective_from ?? resolvedEffectiveFrom,
      })
    } catch (err) {
      next(err)
    }
  },
)
