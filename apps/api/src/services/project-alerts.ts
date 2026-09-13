/**
 * 專案進度示警——純規則引擎（無 IO）。輸入是專案、合約、分期請款、文件活動的
 * 精簡快照，輸出是示警清單；路由負責撈資料與（選配）叫 Gemini 寫摘要。
 *
 * 「AI 示警」的 AI 是摘要層，不是判斷層：哪些案子該警告由這裡的規則決定，
 * 規則可測、可解釋、可追溯（每條示警都帶 rule 與依據）；模型只把清單整理成
 * 人看得懂的一段話。沒設金鑰時清單照常，只是沒有摘要。
 *
 * 嚴重度：high 已經出事（逾期未請款、到期未結案、到期仍有未請款金額）、
 * medium 快出事或缺東西（7 天內到期的請款、沒合約、沒期程、印花稅未貼、停滯、停工過久）、
 * low 資料不完整（沒填起訖日、快到期提醒）。
 */

export type AlertSeverity = "high" | "medium" | "low"

export type AlertRule =
  | "billing_overdue"
  | "billing_due_soon"
  | "unbilled_after_end"
  | "past_end_date"
  | "ending_soon"
  | "no_contract"
  | "no_billing_schedule"
  | "stamp_duty_unpaid"
  | "stale"
  | "suspended_long"
  | "missing_dates"

export interface AlertProject {
  id: string
  name: string
  code: string | null
  status: string
  startsOn: string | null
  endsOn: string | null
  createdAt: string
  statusChangedAt: string | null
  archivedAt: string | null
  leadEmpId: string | null
}
export interface AlertContract {
  projectId: string
  docType: string
  signedOn: string | null
  amount: number | null
  dutiable: boolean
  stampDutyPaidOn: string | null
}
export interface AlertBilling {
  projectId: string
  installmentNo: number
  plannedOn: string | null
  billedOn: string | null
  /** 有效金額：已請款用 billedAmount，否則覆寫或試算 */
  amount: number | null
}
export interface AlertInput {
  projects: AlertProject[]
  contracts: AlertContract[]
  billings: AlertBilling[]
  /** 每個專案最近一次活動（文件上傳、合約、請款、狀態變更）的日期 YYYY-MM-DD */
  lastActivity: Record<string, string | null>
}

export interface ProjectAlert {
  key: string
  rule: AlertRule
  severity: AlertSeverity
  projectId: string
  projectName: string
  projectCode: string | null
  leadEmpId: string | null
  message: string
  /** 相關日期（到期日／預定日） */
  dueOn?: string
  amount?: number
  installmentNo?: number
  daysOverdue?: number
}

export const ALERT_RULE_LABEL: Record<AlertRule, string> = {
  billing_overdue: "逾期未請款",
  billing_due_soon: "請款即將到期",
  unbilled_after_end: "已到期仍有未請款",
  past_end_date: "逾預定完工日未結案",
  ending_soon: "即將到期",
  no_contract: "沒有合約",
  no_billing_schedule: "沒有請款期程",
  stamp_duty_unpaid: "印花稅未貼",
  stale: "長期無進度",
  suspended_long: "停工過久",
  missing_dates: "未填起訖日",
}

/** 門檻集中放，之後要調只改這裡（都不是法規，是管理上的合理預設）。 */
export const ALERT_THRESHOLDS = {
  billingDueSoonDays: 7,
  endingSoonDays: 14,
  noContractAfterDays: 30,
  stampDutyGraceDays: 30,
  staleDays: 60,
  suspendedLongDays: 90,
} as const

const DAY = 86_400_000

function toDate(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00Z`)
}
/** a - b 的天數（皆 YYYY-MM-DD；正值 = a 在 b 之後） */
export function daysBetween(a: string, b: string): number {
  return Math.round((toDate(a).getTime() - toDate(b).getTime()) / DAY)
}

export function computeProjectAlerts(input: AlertInput, today: string): ProjectAlert[] {
  const T = ALERT_THRESHOLDS
  const out: ProjectAlert[] = []
  const contractsBy = groupBy(input.contracts, (c) => c.projectId)
  const billingsBy = groupBy(input.billings, (b) => b.projectId)

  for (const p of input.projects) {
    if (p.archivedAt) continue // 封存 = 不想再看到
    const base = { projectId: p.id, projectName: p.name, projectCode: p.code, leadEmpId: p.leadEmpId }
    const push = (a: Omit<ProjectAlert, keyof typeof base | "key"> & { keySuffix?: string }) => {
      const { keySuffix, ...rest } = a
      out.push({ ...base, ...rest, key: `${a.rule}:${p.id}${keySuffix ? `:${keySuffix}` : ""}` })
    }
    const contracts = contractsBy.get(p.id) ?? []
    const billings = billingsBy.get(p.id) ?? []
    const isOpen = p.status === "active" || p.status === "suspended"
    const contractTotal = contracts
      .filter((c) => c.docType === "contract" || c.docType === "change_order")
      .reduce((s, c) => s + (c.amount ?? 0), 0)
    const unbilled = billings.filter((b) => !b.billedOn)
    const unbilledTotal = unbilled.reduce((s, b) => s + (b.amount ?? 0), 0)

    // ── 請款 ─────────────────────────────────────────────────────────
    for (const b of unbilled) {
      if (!b.plannedOn || !isOpen) continue
      const d = daysBetween(today, b.plannedOn)
      if (d > 0) {
        push({ rule: "billing_overdue", severity: "high", keySuffix: String(b.installmentNo), installmentNo: b.installmentNo, dueOn: b.plannedOn, amount: b.amount ?? undefined, daysOverdue: d,
          message: `第 ${b.installmentNo} 期預定 ${b.plannedOn} 請款，已逾期 ${d} 天${b.amount != null ? `（${fmt(b.amount)}）` : ""}` })
      } else if (-d <= T.billingDueSoonDays) {
        push({ rule: "billing_due_soon", severity: "medium", keySuffix: String(b.installmentNo), installmentNo: b.installmentNo, dueOn: b.plannedOn, amount: b.amount ?? undefined,
          message: `第 ${b.installmentNo} 期 ${-d === 0 ? "今天" : `${-d} 天後`}（${b.plannedOn}）到期${b.amount != null ? `，${fmt(b.amount)}` : ""}` })
      }
    }

    // ── 期程 ─────────────────────────────────────────────────────────
    if (p.status === "active") {
      if (p.endsOn) {
        const d = daysBetween(today, p.endsOn)
        if (d > 0) {
          push({ rule: "past_end_date", severity: "high", dueOn: p.endsOn, daysOverdue: d, message: `預定完工日 ${p.endsOn} 已過 ${d} 天，案情仍是進行中——結案、解約或延期擇一` })
        } else if (-d <= T.endingSoonDays) {
          push({ rule: "ending_soon", severity: "low", dueOn: p.endsOn, message: `${-d === 0 ? "今天" : `${-d} 天後`}（${p.endsOn}）到預定完工日` })
        }
      }
      if (!p.startsOn || !p.endsOn) {
        push({ rule: "missing_dates", severity: "low", message: `沒填${!p.startsOn ? "起始日" : ""}${!p.startsOn && !p.endsOn ? "與" : ""}${!p.endsOn ? "預定完工日" : ""}，甘特圖與到期示警無法追蹤` })
      }
    }
    // 已到期（過完工日或已結案／解約）但還有未請款金額：錢還沒收完
    const ended = (p.endsOn && daysBetween(today, p.endsOn) > 0) || p.status === "closed" || p.status === "terminated"
    if (ended && unbilledTotal > 0) {
      push({ rule: "unbilled_after_end", severity: "high", amount: unbilledTotal, message: `專案已${p.status === "closed" ? "結案" : p.status === "terminated" ? "解約" : "過完工日"}，仍有 ${fmt(unbilledTotal)} 未請款（${unbilled.length} 期）` })
    }

    // ── 合約與期程資料 ────────────────────────────────────────────────
    if (p.status === "active") {
      const ageFrom = p.startsOn ?? p.createdAt.slice(0, 10)
      const age = daysBetween(today, ageFrom)
      const hasContract = contracts.some((c) => c.docType === "contract")
      if (!hasContract && age >= T.noContractAfterDays) {
        push({ rule: "no_contract", severity: "medium", message: `進行 ${age} 天了還沒有合約（只有報價單或什麼都沒有），請款沒有依據` })
      }
      if (hasContract && contractTotal > 0 && billings.length === 0) {
        push({ rule: "no_billing_schedule", severity: "medium", amount: contractTotal, message: `合約 ${fmt(contractTotal)} 但沒有分期請款期程，沒人知道什麼時候該請款` })
      }
    }
    for (const c of contracts) {
      if (!c.dutiable || c.stampDutyPaidOn || !c.signedOn) continue
      const d = daysBetween(today, c.signedOn)
      if (d >= T.stampDutyGraceDays) {
        push({ rule: "stamp_duty_unpaid", severity: "medium", keySuffix: c.signedOn, dueOn: c.signedOn, daysOverdue: d, message: `${c.signedOn} 簽訂的合約應貼印花稅，${d} 天了還沒標記已貼（印花稅法：書立時貼花）` })
      }
    }

    // ── 活動 ─────────────────────────────────────────────────────────
    if (p.status === "active") {
      const last = input.lastActivity[p.id] ?? p.statusChangedAt?.slice(0, 10) ?? p.createdAt.slice(0, 10)
      const idle = daysBetween(today, last)
      if (idle >= T.staleDays) {
        push({ rule: "stale", severity: "medium", daysOverdue: idle, message: `${idle} 天沒有任何動靜（文件、合約、請款、狀態都沒變），確認是否還在進行` })
      }
    }
    if (p.status === "suspended" && p.statusChangedAt) {
      const d = daysBetween(today, p.statusChangedAt.slice(0, 10))
      if (d >= T.suspendedLongDays) {
        push({ rule: "suspended_long", severity: "medium", daysOverdue: d, message: `停工已 ${d} 天，該恢復、解約還是結案？` })
      }
    }
  }

  const rank: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0) || a.projectName.localeCompare(b.projectName))
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = m.get(k)
    if (list) list.push(r)
    else m.set(k, [r])
  }
  return m
}
function fmt(n: number): string {
  return `$${Math.round(n).toLocaleString("zh-TW")}`
}
