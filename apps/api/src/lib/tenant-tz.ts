import { supabaseAdmin } from "./supabase.js"
import { DEFAULT_TIMEZONE } from "./tz.js"
import { isMissingColumnError, warnSchemaGapOnce } from "./schema-compat.js"

/**
 * Resolve a tenant's business timezone (`tenants.timezone`, IANA name; default
 * 'Asia/Taipei'). Cached per tenant for a short TTL — a settlement or scan
 * touches it once per request, and a timezone change is a rare admin action
 * that can tolerate a minute of staleness.
 *
 * Degrades to the default when the column is not yet migrated (0038) or the
 * stored value is not a timezone the runtime knows.
 */

const TTL_MS = 60_000
const cache = new Map<string, { tz: string; expiresAt: number }>()
let columnMissingUntil = 0

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function getTenantTimezone(tenantId: string): Promise<string> {
  const now = Date.now()
  const hit = cache.get(tenantId)
  if (hit && hit.expiresAt > now) return hit.tz
  if (columnMissingUntil > now) return DEFAULT_TIMEZONE

  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("timezone")
    .eq("id", tenantId)
    .maybeSingle()

  let tz = DEFAULT_TIMEZONE
  if (error) {
    if (isMissingColumnError(error)) {
      warnSchemaGapOnce("tenants.timezone", error)
      // Re-probe every few minutes so the fallback lifts once 0038 is applied.
      columnMissingUntil = now + 5 * TTL_MS
      return DEFAULT_TIMEZONE
    }
    throw new Error(`getTenantTimezone: ${error.message}`)
  }
  const stored = (data as { timezone?: string | null } | null)?.timezone
  if (stored && isValidTimezone(stored)) tz = stored

  cache.set(tenantId, { tz, expiresAt: now + TTL_MS })
  return tz
}

/** Test hook / admin hook: forget cached timezones. */
export function clearTenantTimezoneCache(): void {
  cache.clear()
  columnMissingUntil = 0
}
