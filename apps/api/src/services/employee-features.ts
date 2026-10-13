import { supabaseAdmin } from "../lib/supabase.js"
import { employeesHavePersonalSettings } from "./employee-shifts.js"

/**
 * 員工個人功能開關（employees.features jsonb，migration 0068；2026-10-13）。
 * 目前只有：
 *   wfhPunch  允許「在家上班」打卡——員工端打卡卡片出現勾選框，勾了該筆打卡記 punch_records.wfh=true。
 * 未知鍵原樣保留（PATCH 是合併寫入），讀取時只吐出已知鍵。
 */
export interface EmployeeFeatures {
  wfhPunch: boolean
}

/** jsonb（可能是 null、陣列、亂型別）→ 已知鍵、布林化。純函式。 */
export function normalizeEmployeeFeatures(raw: unknown): EmployeeFeatures {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { wfhPunch: obj.wfhPunch === true }
}

/**
 * POST /punch 的在家打卡守門（純函式）：沒帶或帶 false 一律放行；帶 true 但員工沒開通 → 拒絕。
 */
export function checkWfhPunch(requested: boolean | undefined, features: EmployeeFeatures): { ok: true } | { ok: false; error: "wfh_punch_not_enabled" } {
  if (requested !== true) return { ok: true }
  return features.wfhPunch ? { ok: true } : { ok: false, error: "wfh_punch_not_enabled" }
}

/** 讀某員工的個人功能開關；0068 未套 → 全關。 */
export async function loadEmployeeFeatures(tenantId: string, employeeId: string): Promise<EmployeeFeatures> {
  if (!(await employeesHavePersonalSettings())) return normalizeEmployeeFeatures(null)
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("features")
    .eq("tenant_id", tenantId)
    .eq("id", employeeId)
    .maybeSingle()
  if (error) throw new Error(`loadEmployeeFeatures: ${error.message}`)
  return normalizeEmployeeFeatures((data as { features?: unknown } | null)?.features)
}
