import type { BonusBasis } from "./bonus-run.js"
import type { PaidMember, ProjectPaymentTotals } from "./bonus-run-store.js"
import { excelPoolOf, sortProjects, taxed, type BonusSheetProject } from "../lib/statements/bonus-sheet.js"

/**
 * 獎金分潤總表「管理檢視」（2026-10-27 業主：網頁預設；一眼看出每案還有多少獎金沒發、已發比例與金額）——純函式。
 * 公司格式（Excel 版面）仍在 lib/statements/bonus-sheet.ts，列印與 xlsx 下載用公司格式。
 *
 * 口徑（以獎金引擎 services/bonus-run.ts 為準；累計應得用今天的即時試算）：
 *   • 含稅合約／累計收款＝未稅 ×（1＋營業稅率）到元；收款比例＝未稅累計入帳 ÷ 未稅合約。
 *   • 獎金總額（全部收齊總共要發多少）：
 *       Excel 含稅入帳制（tax_inclusive_receipts）＝含稅合約 × 獎金比例（同公司格式「總獎金」）；
 *       舊制手填獎金池（legacy_pool）＝手填的獎金池；固定金額（fixed_amount）＝各成員固定金額合計；
 *       毛利制（gross_profit）＝目前已實現毛利 × 比例（引擎的池；完工前會隨成本與入帳變動，畫面標註「估」，待收款不算）。
 *   • 已發放＝已發放（paid）批次合計，含沖銷負數；已核准／送審中尚未發放的批次不算，另外標示。
 *   • 未發放＝獎金總額 − 已發放。
 *       可發＝各現任成員 max(0, 引擎累計應得 − 該員已發放) 合計＝下一批試算會發的金額；
 *       超發＝各成員 max(0, 已發放 − 累計應得)（含已移除成員：應得視為 0），> 0 紅字；
 *       待收款＝未發放 − 可發（含尚未分配的比例；毛利制 null）。
 *   • 成員：現任成員依角色排序，加上曾領過但已移除的人；每人 已發／未發（＝個人總額 − 已發，個人總額＝獎金總額 × 個人%，
 *     固定金額＝設定金額，毛利制＝目前累計應得）／可發。％合計未滿 100 → 「未分配 N%：獎金總額 × N%」。
 */

export type ManageMember = {
  employeeId: string
  name: string | null
  role: string | null
  /** 已移除（不在現任成員，但領過錢）。 */
  removed: boolean
  shareMode: string
  sharePct: number | null
  shareAmount: number | null
  paid: number
  /** 個人總額（全部收齊）；算不出 null。 */
  total: number | null
  /** total − paid；算不出 null。 */
  unpaid: number | null
  /** 目前可發＝max(0, 累計應得 − 已發)；算不出 null。 */
  available: number | null
}

export type ManageRow = {
  projectId: string
  code: string | null
  name: string | null
  closed: boolean
  basis: BonusBasis | null
  contractTaxed: number | null
  receivedTaxed: number
  receivedRatio: number | null
  bonusRatePct: number | null
  bonusTotal: number | null
  /** 獎金總額是估計值（毛利制）。 */
  bonusTotalEstimated: boolean
  paid: number
  /** 已發放 ÷ 獎金總額（0～1，可 >1）；總額 0 或算不出 null。 */
  paidRatio: number | null
  unpaid: number | null
  available: number
  overpaid: number
  awaiting: number | null
  /** 已核准未發放／送審中（不計入已發放）。 */
  approvedUnpaid: number
  pendingApproval: number
  members: ManageMember[]
  /** 尚未分配（百分點）與金額；沒有未分配或固定金額制 null。 */
  unallocated: { pct: number; amount: number | null } | null
  /** 分潤調整紀錄（同公司格式備註的那段）。 */
  revisionNote: string | null
  /** 專案說明（project note）。 */
  note: string | null
}

export type ManageTotals = {
  contractTaxed: number
  receivedTaxed: number
  bonusTotal: number
  paid: number
  unpaid: number
  available: number
  awaiting: number
}

const roleRank = (role: string | null) => (role === "manager" ? 0 : role === "lead" ? 1 : role === "member" ? 2 : role === "support" ? 3 : 4)
const round = (n: number) => Math.round(n)

export function buildManageRow(p: BonusSheetProject, paidByEmp: ReadonlyMap<string, PaidMember> | undefined, unpaid: { approved: number; pending: number } | undefined, vatRate: number): ManageRow {
  const basis = p.basis
  const poolMembers = p.members.filter((m) => m.shareMode === "pool_pct")
  let bonusTotal: number | null
  if (basis === "fixed_amount") bonusTotal = p.members.reduce((s, m) => s + (m.shareAmount ?? 0), 0)
  else if (basis === "legacy_pool") bonusTotal = p.pool
  else if (basis === "gross_profit") bonusTotal = p.pool
  else bonusTotal = excelPoolOf(p, vatRate) // Excel 制，或沒有成員（basis null）時照比例算
  if (bonusTotal !== null) bonusTotal = round(bonusTotal)
  const estimated = basis === "gross_profit"

  const paidMap = paidByEmp ?? new Map<string, PaidMember>()
  const current = new Set(p.members.map((m) => m.employeeId))
  const members: ManageMember[] = [...p.members]
    .sort((a, b) => roleRank(a.role) - roleRank(b.role) || (a.empNo ?? "").localeCompare(b.empNo ?? "") || (a.name ?? "").localeCompare(b.name ?? ""))
    .map((m) => {
      const paid = paidMap.get(m.employeeId)?.amount ?? 0
      const total =
        m.shareMode !== "pool_pct"
          ? m.shareAmount
          : estimated
            ? m.entitled
            : bonusTotal === null || m.sharePct === null
              ? null
              : round((bonusTotal * m.sharePct) / 100)
      return {
        employeeId: m.employeeId,
        name: m.name,
        role: m.role,
        removed: false,
        shareMode: m.shareMode,
        sharePct: m.sharePct,
        shareAmount: m.shareAmount,
        paid: round(paid),
        total: total === null ? null : round(total),
        unpaid: total === null ? null : round(total - paid),
        available: m.entitled === null ? null : Math.max(0, round(m.entitled - paid)),
      }
    })
  for (const [employeeId, pm] of paidMap) {
    if (current.has(employeeId) || Math.round(pm.amount) === 0) continue
    members.push({ employeeId, name: pm.name, role: pm.role, removed: true, shareMode: "pool_pct", sharePct: null, shareAmount: null, paid: round(pm.amount), total: null, unpaid: null, available: 0 })
  }

  const paid = round([...paidMap.values()].reduce((s, m) => s + m.amount, 0))
  const available = members.reduce((s, m) => s + (m.removed ? 0 : (m.available ?? 0)), 0)
  const overpaid = members.reduce((s, m) => {
    const entitled = m.removed ? 0 : p.members.find((x) => x.employeeId === m.employeeId)?.entitled
    return entitled === null || entitled === undefined ? s : s + Math.max(0, round(m.paid - entitled))
  }, 0)
  const unpaidTotal = bonusTotal === null ? null : bonusTotal - paid
  const allocated = poolMembers.reduce((s, m) => s + (m.sharePct ?? 0), 0)
  const unallocPct = basis === "fixed_amount" || p.members.length === 0 ? null : Math.max(0, Math.round((100 - allocated) * 10000) / 10000)
  return {
    projectId: p.projectId,
    code: p.code,
    name: p.name,
    closed: p.closed,
    basis,
    contractTaxed: taxed(p.contractTotal, vatRate),
    receivedTaxed: taxed(p.receivedTotal, vatRate) ?? 0,
    receivedRatio: p.contractTotal ? p.receivedRatio : null,
    bonusRatePct: p.bonusRatePct,
    bonusTotal,
    bonusTotalEstimated: estimated,
    paid,
    paidRatio: bonusTotal ? paid / bonusTotal : null,
    unpaid: unpaidTotal,
    available,
    overpaid,
    awaiting: unpaidTotal === null || estimated ? null : unpaidTotal - available,
    approvedUnpaid: round(unpaid?.approved ?? 0),
    pendingApproval: round(unpaid?.pending ?? 0),
    members,
    unallocated: unallocPct && unallocPct > 0 ? { pct: unallocPct, amount: bonusTotal === null || estimated ? null : round((bonusTotal * unallocPct) / 100) } : null,
    revisionNote: p.revisionNote?.trim() || null,
    note: p.note?.trim() || null,
  }
}

export function manageTotalsOf(rows: readonly ManageRow[]): ManageTotals {
  const sum = (f: (r: ManageRow) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0)
  return {
    contractTaxed: sum((r) => r.contractTaxed),
    receivedTaxed: sum((r) => r.receivedTaxed),
    bonusTotal: sum((r) => r.bonusTotal),
    paid: sum((r) => r.paid),
    unpaid: sum((r) => r.unpaid),
    available: sum((r) => r.available),
    awaiting: sum((r) => r.awaiting),
  }
}

/** 每案一列（同公司格式排序：單號、名稱）。 */
export function buildManageRows(projects: readonly BonusSheetProject[], payments: ProjectPaymentTotals, vatRate: number): ManageRow[] {
  return sortProjects(projects).map((p) => buildManageRow(p, payments.paid.get(p.projectId), payments.unpaid.get(p.projectId), vatRate))
}
