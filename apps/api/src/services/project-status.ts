/**
 * 專案案情狀態（模組四第 2 條）。
 *
 * ── 兩軸，不是一軸 ────────────────────────────────────────────────
 * `status`（案情）與 `archived_at`（可見性）分開。混成一欄的話，要封存
 * 一個已解約的案子就得把 `terminated` 覆寫掉，「解約收場」這件事就沒了。
 *
 * ── 不擋轉移，只要求理由 ──────────────────────────────────────────
 * 結案後驗收不過要返工是真的，誤按也要能改回來，所以**任何轉移都合法**。
 * 但任何變更都必填理由——跟刪除申請單、補打卡必填理由同一個原則：
 * 擋不了人，但留得下痕跡。完整轉移歷程 sql/0019 的稽核 trigger 已經有了，
 * 這裡補的是 audit_logs 給不了的「為什麼」。
 *
 * ── 今天擋不到東西 ────────────────────────────────────────────────
 * 請款、費用、出差都還沒綁專案，所以狀態目前只影響列表與報表，
 * 不攔任何操作。等 `project_billings` 出來才有 gating 的對象。
 */

export const PROJECT_STATUSES = ["active", "suspended", "closed", "terminated"] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/** 終止狀態：案子已經結束（正常完工或中途解約）。 */
const TERMINAL: readonly string[] = ["closed", "terminated"]

export function isProjectStatus(v: string): v is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(v)
}

export function isTerminal(status: string): boolean {
  return TERMINAL.includes(status)
}

/** Asia/Taipei 的今天（YYYY-MM-DD）。狀態生效日未填時的預設值。 */
export function taipeiToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const byType = new Map(parts.map((part) => [part.type, part.value]))
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`
}

export type StatusPatchInput = {
  /** 資料庫現況 */
  currentStatus: string
  currentArchivedAt: string | null
  /** 使用者要改的（undefined＝不動） */
  status?: string
  statusReason?: string | null
  statusEffectiveOn?: string | null
  archived?: boolean
  /** 呼叫端提供，讓本函式保持純粹 */
  today: string
  nowIso: string
  actorEmpId: string
}

export type StatusPatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; error: StatusPatchError }

export type StatusPatchError =
  | "invalid_status"
  | "status_reason_required"
  | "archive_requires_non_active"

/**
 * 把使用者送來的狀態／封存意圖換算成要寫進 DB 的欄位。
 *
 * 全部規則集中在這裡，路由只負責搬運——狀態的規則會長，散在 handler 裡
 * 遲早會有一條路徑漏掉理由或漏掉時間戳。
 */
export function resolveStatusPatch(input: StatusPatchInput): StatusPatchResult {
  const patch: Record<string, unknown> = {}
  const reason = input.statusReason?.trim() || null

  // ── 案情 ────────────────────────────────────────────────────────
  const statusChanging = input.status !== undefined && input.status !== input.currentStatus
  if (input.status !== undefined && !isProjectStatus(input.status)) {
    return { ok: false, error: "invalid_status" }
  }

  if (statusChanging) {
    if (!reason) return { ok: false, error: "status_reason_required" }
    patch.status = input.status
    patch.status_reason = reason
    // 未填生效日就用今天。解約通知書上的日期通常早於輸入日，所以這個
    // 預設值只是最後手段，UI 要讓人填真正的那一天。
    patch.status_effective_on = input.statusEffectiveOn ?? input.today
    patch.status_changed_at = input.nowIso
    patch.status_changed_by_emp_id = input.actorEmpId
  } else if (input.status !== undefined || reason || input.statusEffectiveOn !== undefined) {
    // 狀態沒變，但要更正理由或生效日（打錯解約日是真實情況）。
    // 不動 status_changed_at——那記的是「案情何時改變」，不是「誰改過欄位」。
    // 誰改過欄位在 audit_logs 裡。
    if (reason) patch.status_reason = reason
    if (input.statusEffectiveOn !== undefined) {
      patch.status_effective_on = input.statusEffectiveOn
    }
  }

  // ── 可見性 ──────────────────────────────────────────────────────
  const targetStatus = statusChanging ? (input.status as string) : input.currentStatus

  if (input.archived === true) {
    // 「進行中」與「不想看到」互相矛盾，多半是誤按。暫停／結案／解約都可封存。
    if (targetStatus === "active") return { ok: false, error: "archive_requires_non_active" }
    // 已封存就不覆寫時點——重複封存不該把原本的封存日洗掉。
    if (!input.currentArchivedAt) patch.archived_at = input.nowIso
  } else if (input.archived === false) {
    patch.archived_at = null
    // 留下「人特地把它拉回來」的時點——自動封存靠這一欄放過這筆。
    patch.unarchived_at = input.nowIso
  } else if (targetStatus === "active" && input.currentArchivedAt) {
    // 從終止／暫停轉回進行中時自動解除封存，否則會變成「進行中但看不到」。
    patch.archived_at = null
  }

  return { ok: true, patch }
}

/* ──────────────────────────────────────────────────────────────────
 * 自動封存（模組四第 2 條，使用者裁示「自動化」）
 * ────────────────────────────────────────────────────────────────── */

/**
 * 月份加法，日期溢位時夾到當月最後一天。
 * 8/31 + 6 個月＝2/28（或 2/29），不是滾到 3/3。
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return target.toISOString().slice(0, 10)
}

export type AutoArchiveCandidate = {
  status: string
  archived_at: string | null
  unarchived_at: string | null
  status_effective_on: string | null
  status_changed_at: string | null
}

/**
 * 這筆專案今天該不該被自動封存。
 *
 * 四條規則，每一條都有理由：
 *
 * 1. **只封存終止狀態**（結案／已解約）。**暫停永遠不自動封存**——
 *    暫停的案子最需要被看見，收起來就真的忘了，而忘掉的暫停案就是
 *    沒人去追的爛尾。
 * 2. **起算日取「法律生效日」與「輸入時點」較晚的那個**。補登一張三個月前
 *    的解約單，不該讓它當晚就消失；人總要有時間把尾款與驗收文件收乾淨。
 * 3. **人工拉回來的就放過**。有人特地解除封存（多半在追尾款），排程當晚
 *    又收起來，這功能等於壞的。案情之後再變動才恢復自動。
 * 4. **兩個日期都沒有就不動**。不知道案子何時結束，就不要猜。
 */
export function shouldAutoArchive(
  p: AutoArchiveCandidate,
  opts: { today: string; months: number },
): boolean {
  if (p.archived_at) return false
  if (!isTerminal(p.status)) return false

  const changedOn = p.status_changed_at ? p.status_changed_at.slice(0, 10) : null
  const baseline = [p.status_effective_on, changedOn]
    .filter((v): v is string => !!v)
    .sort()
    .pop()
  if (!baseline) return false

  if (p.unarchived_at) {
    // 案情在解除封存之後又變動過，才重新納入自動封存。
    if (!p.status_changed_at || p.status_changed_at <= p.unarchived_at) return false
  }

  return addMonths(baseline, opts.months) <= opts.today
}
