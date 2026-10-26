import type { AttendanceDay, RuleConfig } from "@hr/rules"
import { supabaseAdmin } from "../lib/supabase.js"
import { employeesHavePersonalSettings } from "./employee-shifts.js"

/**
 * 員工個人功能開關（employees.features jsonb，migration 0068；2026-10-13）。
 * 目前有：
 *   wfhPunch        允許「在家上班」打卡——員工端打卡卡片出現勾選框，勾了該筆打卡記 punch_records.wfh=true。
 *   noNightPremium  不計夜間加給（2026-10-13 業主決定，個人開關、不改租戶規則）：結算時 night_minutes 寫 0、
 *                   薪資引擎（薪資執行／月表試算）對這位員工夜間分鐘歸 0、夜間倍率 0（見 applyNightPolicy）。
 *   regularLeaveWeekday  個人例假日（一例一休的「例」，0＝週日…6＝週六；null＝依公司 tenants.features.attendance）。
 *   restDayWeekday       個人休息日（同上；null＝未設時：與公司例假日相同→公司休息日，否則→公司例假日那天）。
 *                        兩者的解讀見 services/day-type.ts（2026-10-17 一例一休）。
 *   seeGroupFinancials   可看集團財務（2026-10-26；只對 hr_admin 有效、只有老闆／platform_admin 能改）。
 * 未知鍵原樣保留（PATCH 是合併寫入），讀取時只吐出已知鍵。
 */
export interface EmployeeFeatures {
  wfhPunch: boolean
  noNightPremium: boolean
  /** 個人例假日 0–6（0＝週日）；null＝依公司設定。 */
  regularLeaveWeekday?: number | null
  /** 個人休息日 0–6；null＝依預設推導（services/day-type.ts employeeWeekendPolicy）。 */
  restDayWeekday?: number | null
  /**
   * 可看集團財務（2026-10-26 業主：老闆與一般 HR 分開）。只對 hr_admin 有效，只有老闆／platform_admin 能改
   * （見 services/financial-visibility.ts）。與出勤／薪資無關，不算進 hasAnyEmployeeFeature。
   */
  seeGroupFinancials?: boolean
}

/** 0–6 的整數 → 星期；其他（含字串、小數、null）→ null。純函式。 */
export function asWeekday(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6 ? v : null
}

/** jsonb（可能是 null、陣列、亂型別）→ 已知鍵、布林化／星期化。純函式。 */
export function normalizeEmployeeFeatures(raw: unknown): EmployeeFeatures {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    wfhPunch: obj.wfhPunch === true,
    noNightPremium: obj.noNightPremium === true,
    regularLeaveWeekday: asWeekday(obj.regularLeaveWeekday),
    restDayWeekday: asWeekday(obj.restDayWeekday),
    seeGroupFinancials: obj.seeGroupFinancials === true,
  }
}

/** 員工有沒有任何一個非預設的個人設定（loadEmployeeFeaturesMap 只收這些人）。純函式。 */
export function hasAnyEmployeeFeature(f: EmployeeFeatures): boolean {
  return f.wfhPunch || f.noNightPremium || f.regularLeaveWeekday != null || f.restDayWeekday != null
}

/**
 * 薪資引擎的單一入口（純函式）：員工開了 noNightPremium → 每天的夜間分鐘歸 0、規則夜間倍率 0
 * （兩道一起：舊的 attendance_days 或已核准月表快照裡殘留的夜間分鐘也算不出錢）。其他員工原樣回傳。
 */
export function applyNightPolicy<D extends Pick<AttendanceDay, "nightMinutes">>(
  features: EmployeeFeatures | null | undefined,
  days: D[],
  rules: RuleConfig,
): { days: D[]; rules: RuleConfig } {
  if (!features?.noNightPremium) return { days, rules }
  return {
    days: days.map((d) => (d.nightMinutes ? { ...d, nightMinutes: 0 } : d)),
    rules: { ...rules, night: { ...rules.night, multiplier: 0 } },
  }
}

/**
 * 一批員工的功能開關（employee_id → features）；`employeeIds` 省略＝全租戶。0068 未套 → 空 Map（全關）。
 * 只收至少有一個開關打開（或設了個人例假／休息日）的員工（其他人查不到＝全關、依公司設定）。
 */
export async function loadEmployeeFeaturesMap(tenantId: string, employeeIds?: string[]): Promise<Map<string, EmployeeFeatures>> {
  const out = new Map<string, EmployeeFeatures>()
  if (employeeIds && employeeIds.length === 0) return out
  if (!(await employeesHavePersonalSettings())) return out
  let q = supabaseAdmin.from("employees").select("id, features").eq("tenant_id", tenantId)
  if (employeeIds) q = q.in("id", employeeIds)
  const { data, error } = await q
  if (error) throw new Error(`loadEmployeeFeaturesMap: ${error.message}`)
  for (const row of (data ?? []) as Array<{ id: string; features?: unknown }>) {
    const f = normalizeEmployeeFeatures(row.features)
    if (hasAnyEmployeeFeature(f)) out.set(row.id, f)
  }
  return out
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
