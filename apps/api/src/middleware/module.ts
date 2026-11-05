import type { Request, Response, NextFunction } from "express"
import { supabaseAdmin } from "../lib/supabase.js"

/**
 * 模組開關守門（2026-11-05，公務車起）：`tenants.features.adminModules[key] === true` 才放行，
 * 否則 403 `{ error:"module_disabled", module:key }`。
 *
 * 既有的後台模組（adminModules）只控制導覽、直開網址與 API 都不擋；新模組沒有舊資料包袱，
 * 關掉就該停（員工不能繞過前端直接打 API 預約）。讀取失敗一律當「未開」（fail closed）。
 *
 * 快取：每租戶 60 秒（比照 ess-tab-guard 的 featureCache）；HR 剛勾選後最多 60 秒生效。
 * 必須掛在 requireAuth、requireTenant 之後（要 res.locals.tenantId）。
 */

const TTL_MS = 60_000
const cache = new Map<string, { modules: Record<string, unknown>; at: number }>()

/** 測試用：清快取。 */
export function resetModuleCache(): void {
  cache.clear()
}

async function adminModulesOf(tenantId: string): Promise<Record<string, unknown>> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.modules
  const { data, error } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  if (error) throw new Error(`module guard (tenants): ${error.message}`)
  const features = (data?.features as Record<string, unknown> | null) ?? null
  const raw = features?.adminModules
  const modules = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  cache.set(tenantId, { modules, at: Date.now() })
  return modules
}

/** 該租戶是否開了某模組（讀取失敗＝false）。 */
export async function isModuleEnabled(tenantId: string, key: string): Promise<boolean> {
  try {
    return (await adminModulesOf(tenantId))[key] === true
  } catch {
    return false
  }
}

export function requireModule(key: string) {
  return async function moduleGuard(_req: Request, res: Response, next: NextFunction): Promise<void> {
    const tenantId = res.locals.tenantId as string | undefined
    if (!tenantId || !(await isModuleEnabled(tenantId, key))) {
      res.status(403).json({ error: "module_disabled", module: key })
      return
    }
    next()
  }
}

export const requireVehiclesModule = requireModule("vehicles")
