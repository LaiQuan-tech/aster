import { Router, type Request, type Response, type NextFunction } from "express"
import { parseRuleConfig } from "@hr/rules"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { writeAuditLog } from "../services/audit.js"

export const ruleConfigRouter = Router()

/**
 * GET /rule-config — the tenant's active 差勤/薪資規則 config. Readable by any
 * authenticated member of the tenant (employees may need to render rules); when
 * the tenant has not saved one yet we return DEFAULT_RULE_CONFIG so the client
 * always has a valid shape to work with. Tenant-scoped via res.locals.tenantId.
 */
ruleConfigRouter.get(
  "/rule-config",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("rule_configs")
        .select("id, config, version, scope, active, created_at")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error) {
        next(new Error(`GET /rule-config: ${error.message}`))
        return
      }
      if (!data) {
        res.status(200).json({ config: DEFAULT_RULE_CONFIG, version: 0, isDefault: true })
        return
      }
      res.status(200).json({
        config: data.config,
        version: data.version,
        scope: data.scope,
        isDefault: false,
      })
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
 */
ruleConfigRouter.put(
  "/rule-config",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string

    // Validate via the engine's own parser — this is the load-bearing guard.
    let config
    try {
      config = parseRuleConfig(req.body)
    } catch (err) {
      res.status(400).json({
        error: "invalid_rule_config",
        details: err instanceof Error ? err.message : String(err),
      })
      return
    }

    try {
      // Current active version (if any) → next version number.
      const { data: current, error: curErr } = await supabaseAdmin
        .from("rule_configs")
        .select("id, version")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (curErr) {
        next(new Error(`PUT /rule-config (current): ${curErr.message}`))
        return
      }

      const nextVersion = (current?.version ?? 0) + 1

      // Deactivate any currently-active rows for this tenant.
      const { error: deactErr } = await supabaseAdmin
        .from("rule_configs")
        .update({ active: false })
        .eq("tenant_id", tenantId)
        .eq("active", true)
      if (deactErr) {
        next(new Error(`PUT /rule-config (deactivate): ${deactErr.message}`))
        return
      }

      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("rule_configs")
        .insert({
          tenant_id: tenantId,
          scope: "all",
          config,
          version: nextVersion,
          active: true,
        })
        .select("id, version")
        .single()
      if (insErr || !inserted) {
        next(new Error(`PUT /rule-config (insert): ${insErr?.message}`))
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
      res.status(200).json({ id: inserted.id, version: inserted.version })
    } catch (err) {
      next(err)
    }
  },
)
