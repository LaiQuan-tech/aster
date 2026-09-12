import { supabaseAdmin } from "../lib/supabase.js"
import { shouldAutoArchive, taipeiToday, type AutoArchiveCandidate } from "./project-status.js"

/**
 * 自動封存終止已久的專案（模組四第 2 條）。
 *
 * 判斷規則全在 `shouldAutoArchive()`（純函式、本機測得到）；這裡只負責
 * 撈資料、套規則、寫回去。
 *
 * ── 為何不寫成一條 UPDATE ... WHERE ────────────────────────────────
 * 規則裡有「起算日取兩個日期較晚者」與「人工拉回來的放過」，寫成 SQL
 * 會是一串看不懂的 coalesce/greatest，而且沒辦法測。撈回來用 TS 判斷，
 * 專案表本來就不大（一租戶幾百筆），一天跑一次。
 */

const CANDIDATE_COLS =
  "id, status, archived_at, unarchived_at, status_effective_on, status_changed_at"

export type AutoArchiveResult = {
  scanned: number
  archived: number
  archivedIds: string[]
}

export async function autoArchiveProjects(params: {
  tenantId: string
  /** 省略時取台北今天。 */
  today?: string
  /** 省略時讀 project_settings，沒有設定列就用預設值。 */
  months?: number
  nowIso?: string
}): Promise<AutoArchiveResult> {
  const today = params.today ?? taipeiToday()
  const nowIso = params.nowIso ?? new Date().toISOString()

  let months = params.months
  if (months === undefined) {
    const { data: settings, error } = await supabaseAdmin
      .from("project_settings")
      .select("auto_archive_enabled, auto_archive_months")
      .eq("tenant_id", params.tenantId)
      .maybeSingle()
    if (error) throw new Error(`autoArchiveProjects(settings): ${error.message}`)
    // 關掉就整個不做——手動封存不受影響。
    if (settings && settings.auto_archive_enabled === false) {
      return { scanned: 0, archived: 0, archivedIds: [] }
    }
    months = settings ? Number(settings.auto_archive_months) : DEFAULT_AUTO_ARCHIVE_MONTHS
  }

  // 只撈還沒封存的終止案，其餘規則在 TS 裡判。
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select(CANDIDATE_COLS)
    .eq("tenant_id", params.tenantId)
    .is("archived_at", null)
    .in("status", ["closed", "terminated"])
  if (error) throw new Error(`autoArchiveProjects(scan): ${error.message}`)

  const rows = (data ?? []) as Array<AutoArchiveCandidate & { id: string }>
  const due = rows.filter((row) => shouldAutoArchive(row, { today, months }))
  if (due.length === 0) return { scanned: rows.length, archived: 0, archivedIds: [] }

  const { error: updateError } = await supabaseAdmin
    .from("projects")
    .update({ archived_at: nowIso })
    .eq("tenant_id", params.tenantId)
    .in(
      "id",
      due.map((row) => row.id),
    )
  if (updateError) throw new Error(`autoArchiveProjects(update): ${updateError.message}`)

  // 不寫 audit_logs：sql/0019 的 audit_all trigger 已經涵蓋 projects 的
  // UPDATE，再寫一筆只是同一件事記兩次。
  return { scanned: rows.length, archived: due.length, archivedIds: due.map((r) => r.id) }
}

/** 沒有 project_settings 列時的預設值，與 schema 的 default 對齊。 */
export const DEFAULT_AUTO_ARCHIVE_MONTHS = 6
