import { supabaseAdmin } from "../lib/supabase.js"
import { localDateKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"

/**
 * 獎金分潤總表的「分潤調整」（2026-10-27 業主追加）：專案進行中調整獎金比例、成員 %、成員增減、角色，
 * 要寫進總表該案的「備註」欄（畫面、列印、Excel 同一段文字），展開的發放歷程也依時間穿插顯示。
 *
 * 資料來源＝project_share_adjustments（專案頁「分潤版本歷程」AdjustmentsCard 同一張表；GET /projects/:id/adjustments）：
 *   • 整批修訂（PUT /projects/:id/share-revision → SQL apply_project_share_revision）：同一 change_set_id，
 *     field＝bonus_rate／pct／role／member_add／member_remove，reason 必填。
 *   • 舊版單筆：PATCH 成員（pct／amount，可帶 reason）、PATCH 專案獎金池（pool）、POST 成員（初始 pct／amount）。
 *     沒有 change_set_id → 各自一組。
 *   role 的 old／new 是代碼：1 經理、2 主辦、3 組員、4 支援（同 SQL 與 AdjustmentsCard）。
 *
 * 「初始設定」不算調整：專案最早一筆異動那一天（租戶時區）的「從無到有」紀錄（old_value 為 null 的
 * bonus_rate／pct／amount／pool／member_add／role）略過——那是開案時設定比例與成員，不是進行中的調整。
 * 之後才加入的成員、第一次設定比例，照樣列為調整。
 *
 * 權限：只由 /bonus-sheet 路由（集團財務：老闆／platform_admin／授權 HR）呼叫；含獎金比例與各人 %。
 */

export type ShareAdjustmentRow = {
  id: string
  project_id: string
  employee_id: string | null
  change_set_id?: string | null
  field: string
  old_value: string | number | null
  new_value: string | number | null
  reason: string | null
  changed_by_emp_id: string | null
  created_at: string
}

export type ShareRevisionItem = {
  field: string
  employeeId: string | null
  name: string | null
  /** 該成員的角色（同組有角色變更用變更後的，否則用目前角色）；專案層異動 null。 */
  role: string | null
  oldValue: number | null
  newValue: number | null
  /** 精簡文字，例「主辦 測試員甲 20%→25%」。 */
  text: string
}

export type ShareRevision = {
  key: string
  /** 異動時間（ISO）。 */
  at: string
  /** 租戶時區日期 YYYY-MM-DD。 */
  date: string
  changedByEmpId: string | null
  changedByName: string | null
  reason: string | null
  items: ShareRevisionItem[]
  /** 備註用的一行，例「115/03/10 主辦 測試員甲 20%→25%；獎金比例 3%→4%（原因：…）」。 */
  text: string
}

const ROLE_CODE: Record<number, string> = { 1: "manager", 2: "lead", 3: "member", 4: "support" }
export const ROLE_LABEL: Record<string, string> = { manager: "經理", lead: "主辦", member: "組員", support: "支援" }

const toNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 'YYYY-MM-DD' → 民國「115/03/10」。 */
export function rocDate(date: string): string {
  const y = Number(date.slice(0, 4)) - 1911
  return `${y}/${date.slice(5, 7)}/${date.slice(8, 10)}`
}

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 10000) / 10000}%`)
const money = (n: number | null) => (n === null ? "—" : Math.round(n).toLocaleString("zh-TW"))
const roleText = (code: number | null) => (code === null ? "—" : (ROLE_LABEL[ROLE_CODE[code] ?? ""] ?? String(code)))

function itemText(field: string, who: string, roleLabel: string | null, oldV: number | null, newV: number | null): string {
  const person = [roleLabel, who].filter(Boolean).join(" ")
  switch (field) {
    case "bonus_rate":
      return `獎金比例 ${pct(oldV)}→${pct(newV)}`
    case "pool":
      return `獎金池 ${money(oldV)}→${money(newV)}`
    case "pct":
      return `${person} ${pct(oldV)}→${pct(newV)}`
    case "amount":
      return `${person} 固定金額 ${money(oldV)}→${money(newV)}`
    case "role":
      return `${who} 角色 ${roleText(oldV)}→${roleText(newV)}`
    case "member_add":
      return `加入 ${person}${newV !== null ? ` ${pct(newV)}` : ""}`
    case "member_remove":
      return `移除 ${person}${oldV !== null ? `（原 ${pct(oldV)}）` : ""}`
    default:
      return `${person || "專案"} ${field} ${oldV ?? "—"}→${newV ?? "—"}`
  }
}

const FIELD_ORDER: Record<string, number> = { bonus_rate: 0, pool: 1, member_remove: 2, role: 3, pct: 4, amount: 5, member_add: 6 }

/**
 * 純函式：單一專案的異動列 → 依時間排序（舊 → 新）的調整組。
 * names：employeeId → 姓名（成員與操作者）；roles：employeeId → 目前角色。
 */
export function groupShareRevisions(
  rows: readonly ShareAdjustmentRow[],
  names: ReadonlyMap<string, string | null>,
  roles: ReadonlyMap<string, string | null>,
  tz: string,
): ShareRevision[] {
  if (rows.length === 0) return []
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const firstDate = localDateKey(sorted[0]!.created_at, tz)
  const isInitial = (r: ShareAdjustmentRow) =>
    toNum(r.old_value) === null && r.field !== "member_remove" && localDateKey(r.created_at, tz) === firstDate

  const groups = new Map<string, ShareAdjustmentRow[]>()
  for (const r of sorted) {
    if (isInitial(r)) continue
    const key = r.change_set_id ? `set:${r.change_set_id}` : `row:${r.id}`
    const arr = groups.get(key) ?? []
    arr.push(r)
    groups.set(key, arr)
  }
  const out: ShareRevision[] = []
  for (const [key, list] of groups) {
    const head = list[0]!
    // 同組的角色變更：成員的角色以變更後為準。
    const roleInSet = new Map<string, string>()
    for (const r of list) {
      const code = toNum(r.new_value)
      if (r.field === "role" && r.employee_id && code !== null && ROLE_CODE[code]) roleInSet.set(r.employee_id, ROLE_CODE[code]!)
    }
    const items: ShareRevisionItem[] = [...list]
      .sort((a, b) => (FIELD_ORDER[a.field] ?? 9) - (FIELD_ORDER[b.field] ?? 9))
      .map((r) => {
        const empId = r.employee_id
        const name = empId ? (names.get(empId) ?? null) : null
        const role = empId ? (roleInSet.get(empId) ?? roles.get(empId) ?? null) : null
        const oldValue = toNum(r.old_value)
        const newValue = toNum(r.new_value)
        const who = name ?? (empId ? "（已離開成員）" : "")
        const roleLabel = role && r.field !== "role" ? (ROLE_LABEL[role] ?? null) : null
        return { field: r.field, employeeId: empId, name, role, oldValue, newValue, text: itemText(r.field, who, roleLabel, oldValue, newValue) }
      })
    const date = localDateKey(head.created_at, tz)
    const reason = list.find((r) => r.reason && r.reason.trim())?.reason?.trim() ?? null
    out.push({
      key,
      at: head.created_at,
      date,
      changedByEmpId: head.changed_by_emp_id,
      changedByName: head.changed_by_emp_id ? (names.get(head.changed_by_emp_id) ?? null) : null,
      reason,
      items,
      text: `${rocDate(date)} ${items.map((i) => i.text).join("；")}${reason ? `（原因：${reason}）` : ""}`,
    })
  }
  return out
}

/** 備註欄的分潤調整段：多次依時間換行串接；沒有調整空字串。 */
export function revisionNoteOf(revisions: readonly ShareRevision[]): string {
  return revisions.map((r) => r.text).join("\n")
}

/**
 * IO：讀指定專案的分潤異動、相關姓名與目前角色，回 projectId → 調整組。
 * roles 可由呼叫端提供（總表已有成員）；沒提供就讀 project_members。
 */
export async function loadShareRevisions(
  tenantId: string,
  projectIds: readonly string[],
  roles?: ReadonlyMap<string, ReadonlyMap<string, string | null>>,
): Promise<Map<string, ShareRevision[]>> {
  const result = new Map<string, ShareRevision[]>()
  const ids = [...new Set(projectIds)]
  if (ids.length === 0) return result
  const rows: ShareAdjustmentRow[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin
        .from("project_share_adjustments")
        .select("id, project_id, employee_id, change_set_id, field, old_value, new_value, reason, changed_by_emp_id, created_at")
        .eq("tenant_id", tenantId)
        .in("project_id", chunk)
        .order("id", { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`bonus-sheet (share adjustments): ${error.message}`)
      const batch = (data ?? []) as ShareAdjustmentRow[]
      rows.push(...batch)
      if (batch.length < 1000) break
    }
  }
  if (rows.length === 0) return result

  const empIds = [...new Set(rows.flatMap((r) => [r.employee_id, r.changed_by_emp_id]).filter((v): v is string => !!v))]
  const names = new Map<string, string | null>()
  for (let i = 0; i < empIds.length; i += 100) {
    const { data, error } = await supabaseAdmin.from("employees").select("id, name").eq("tenant_id", tenantId).in("id", empIds.slice(i, i + 100))
    if (error) throw new Error(`bonus-sheet (share adjustments names): ${error.message}`)
    for (const e of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(e.id, e.name)
  }

  let roleMaps = roles
  if (!roleMaps) {
    const m = new Map<string, Map<string, string | null>>()
    const withRows = [...new Set(rows.map((r) => r.project_id))]
    for (let i = 0; i < withRows.length; i += 100) {
      const { data, error } = await supabaseAdmin
        .from("project_members")
        .select("project_id, employee_id, role_in_project")
        .eq("tenant_id", tenantId)
        .in("project_id", withRows.slice(i, i + 100))
      if (error) throw new Error(`bonus-sheet (share adjustments roles): ${error.message}`)
      for (const r of (data ?? []) as Array<{ project_id: string; employee_id: string; role_in_project: string | null }>) {
        const inner = m.get(r.project_id) ?? new Map<string, string | null>()
        inner.set(r.employee_id, r.role_in_project)
        m.set(r.project_id, inner)
      }
    }
    roleMaps = m
  }

  const tz = await getTenantTimezone(tenantId)
  const byProject = new Map<string, ShareAdjustmentRow[]>()
  for (const r of rows) {
    const arr = byProject.get(r.project_id) ?? []
    arr.push(r)
    byProject.set(r.project_id, arr)
  }
  for (const [projectId, list] of byProject) {
    const revs = groupShareRevisions(list, names, roleMaps.get(projectId) ?? new Map(), tz)
    if (revs.length > 0) result.set(projectId, revs)
  }
  return result
}
