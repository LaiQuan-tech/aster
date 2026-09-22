import { supabaseAdmin } from "../../lib/supabase.js"

/**
 * 批次匯入的「人／班別／部門」對照（services/imports 共用）。
 *
 * 範本讓管理員填工號＋姓名（不是 UUID），這裡一次撈整個租戶的 employees 建 Map，
 * 逐列比對：
 *   • 工號有填 → 以工號為準（同工號多列時取在職的；仍不唯一 → 錯誤）；姓名有填就核對，
 *     不符 → 錯誤（避免填錯工號寫到別人身上）。
 *   • 工號空白 → 姓名唯一才接受；同名多人 → 「姓名重複，請填工號」。
 *   • 停用（inactive）員工也能匹配——補登離職前的紀錄是合理需求。
 * 班別、部門都是名稱→id（同租戶）。比對一律 trim、去掉所有空白後做。
 */

export interface EmployeeRef {
  id: string
  empNo: string | null
  name: string
  status: string
  deptId: string | null
  /** 已綁登入帳號（employees 範本建帳號時用不到，但 template 的員工清單要顯示）。 */
  hasUser: boolean
}

export type ResolveOutcome = { ok: true; employee: EmployeeRef } | { ok: false; message: string }

function squash(s: string): string {
  return s.replace(/\s+/g, "")
}

export class EmployeeResolver {
  private readonly byEmpNo = new Map<string, EmployeeRef[]>()
  private readonly byName = new Map<string, EmployeeRef[]>()

  constructor(readonly all: EmployeeRef[]) {
    for (const e of all) {
      if (e.empNo) {
        const k = squash(e.empNo).toLowerCase()
        this.byEmpNo.set(k, [...(this.byEmpNo.get(k) ?? []), e])
      }
      const n = squash(e.name)
      this.byName.set(n, [...(this.byName.get(n) ?? []), e])
    }
  }

  /** 工號（可空）＋姓名（可空）→ 員工。 */
  resolve(empNoRaw: string, nameRaw: string): ResolveOutcome {
    const empNo = squash(empNoRaw)
    const name = squash(nameRaw)
    if (!empNo && !name) return { ok: false, message: "工號與姓名至少要填一個" }

    if (empNo) {
      const hits = this.byEmpNo.get(empNo.toLowerCase()) ?? []
      if (hits.length === 0) return { ok: false, message: `找不到工號「${empNoRaw.trim()}」的員工` }
      let pick = hits
      if (pick.length > 1) {
        const active = pick.filter((e) => e.status === "active")
        if (active.length >= 1) pick = active
      }
      if (pick.length > 1) {
        return { ok: false, message: `工號「${empNoRaw.trim()}」對應到 ${pick.length} 位員工，請先到員工管理整理工號` }
      }
      const employee = pick[0]
      if (name && squash(employee.name) !== name) {
        return {
          ok: false,
          message: `工號「${empNoRaw.trim()}」的員工是「${employee.name}」，與填寫的姓名「${nameRaw.trim()}」不符`,
        }
      }
      return { ok: true, employee }
    }

    const sameName = this.byName.get(name) ?? []
    if (sameName.length === 0) return { ok: false, message: `找不到姓名「${nameRaw.trim()}」的員工` }
    if (sameName.length > 1) return { ok: false, message: `姓名「${nameRaw.trim()}」有 ${sameName.length} 位員工重複，請填工號` }
    return { ok: true, employee: sameName[0] }
  }

  /** 只用工號找（onboardings 的主管工號）。 */
  byEmpNoOnly(empNoRaw: string): ResolveOutcome {
    return this.resolve(empNoRaw, "")
  }
}

export async function resolveEmployees(tenantId: string): Promise<EmployeeResolver> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, emp_no, name, status, dept_id, user_id")
    .eq("tenant_id", tenantId)
  if (error) throw new Error(`imports (employees): ${error.message}`)
  const all: EmployeeRef[] = (data ?? []).map((r) => ({
    id: r.id as string,
    empNo: (r.emp_no as string | null) ?? null,
    name: (r.name as string) ?? "",
    status: (r.status as string) ?? "active",
    deptId: (r.dept_id as string | null) ?? null,
    hasUser: !!r.user_id,
  }))
  return new EmployeeResolver(all)
}

/** 名稱 → id 的小對照（班別、部門共用）：trim、去空白後比對；重名時取第一個。 */
export class NameResolver {
  private readonly map = new Map<string, string>()
  constructor(readonly entries: Array<{ id: string; name: string }>) {
    for (const e of entries) {
      const k = squash(e.name)
      if (!this.map.has(k)) this.map.set(k, e.id)
    }
  }
  get(nameRaw: string): string | null {
    return this.map.get(squash(nameRaw)) ?? null
  }
}

export interface ShiftRef {
  id: string
  name: string
  startTime: string
  endTime: string
}

export async function loadShifts(tenantId: string): Promise<ShiftRef[]> {
  const { data, error } = await supabaseAdmin
    .from("shifts")
    .select("id, name, start_time, end_time")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true })
  if (error) throw new Error(`imports (shifts): ${error.message}`)
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    startTime: (r.start_time as string) ?? "",
    endTime: (r.end_time as string) ?? "",
  }))
}

export interface DepartmentRef {
  id: string
  name: string
}

export async function loadDepartments(tenantId: string): Promise<DepartmentRef[]> {
  const { data, error } = await supabaseAdmin
    .from("departments")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true })
  if (error) throw new Error(`imports (departments): ${error.message}`)
  return (data ?? []).map((r) => ({ id: r.id as string, name: r.name as string }))
}
