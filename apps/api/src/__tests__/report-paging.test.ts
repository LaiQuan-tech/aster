import { describe, expect, it, vi } from "vitest"
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())
import { loadYearPaidDisbursements } from "../routes/disbursement-reports.js"
import { loadAttendanceReportDays } from "../routes/reports.js"
import { listOtherProjectIds } from "../services/bonus-sheet.js"
import { loadShareRevisions } from "../services/bonus-sheet-revisions.js"
import { loadOvertimeSettlements } from "../services/group-overview.js"
import { loadGrossProfitInput } from "../services/project-gross-profit.js"
import { loadOptionUsage, findOptionList } from "../services/option-lists.js"
import { contractLinkedDocumentIds } from "../services/knowledge-store.js"
import { loadCompanyUsage } from "../services/company-lifecycle.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * 報表分頁（2026-10-27）：PostgREST max-rows 靜默截斷。每個改用 lib/select-all-pages 的報表查詢，
 * 在 max-rows=1000 與 500（伺服器上限小於頁大小）下都要讀全，且結果與不截斷（maxRows=null）完全相同。
 */
const N = 2345
const pad = (i: number) => String(i).padStart(12, "0")
const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${pad(i)}`

async function compare<T>(seed: () => void, run: () => Promise<T>, check?: (r: T) => void) {
  seed()
  fake.limits.maxRows = null
  const full = await run()
  check?.(full)
  for (const maxRows of [1000, 500]) {
    seed()
    fake.limits.maxRows = maxRows
    try {
      const got = await run()
      expect(got).toEqual(full)
    } finally {
      fake.limits.maxRows = null
    }
  }
}

describe("報表分頁讀全（max-rows 1000／500）", () => {
  it("放款樞紐：年度已匯款放款單", async () => {
    await compare(
      () => {
        fake.reset()
        fake.db.disbursements = Array.from({ length: N }, (_, i) => ({
          id: uuid("dddddddd", i), tenant_id: TENANT_ID, status: "paid", paid_on: "2026-05-01", amount: 100, withheld_amount: 0,
          payee_kind: "other", payee_name: `p${i}`, disbursement_no: `D-${i}`,
        })) as Row[]
      },
      () => loadYearPaidDisbursements(TENANT_ID, 2026),
      (r) => expect(r).toHaveLength(N),
    )
  })

  it("出勤報表：全公司區間每日列（含 deptId 分批 .in()）", async () => {
    const emps = Array.from({ length: 150 }, (_, i) => uuid("eeeeeeee", i))
    const seed = () => {
      fake.reset()
      const rows: Row[] = []
      let n = 0
      for (const e of emps) for (let d = 1; d <= 20; d++) rows.push({ id: uuid("aaaaaaaa", ++n), tenant_id: TENANT_ID, employee_id: e, work_date: `2026-10-${String(d).padStart(2, "0")}`, worked_minutes: 480, late_minutes: d % 3, overtime_minutes: 0, night_minutes: 0 })
      fake.db.attendance_days = rows
    }
    await compare(seed, () => loadAttendanceReportDays(TENANT_ID, "2026-10-01", "2026-10-31", null), (r) => expect(r.days).toHaveLength(3000))
    await compare(seed, () => loadAttendanceReportDays(TENANT_ID, "2026-10-01", "2026-10-31", emps), (r) => expect(r.days).toHaveLength(3000))
  })

  it("獎金總表：批次外的專案清單", async () => {
    await compare(
      () => {
        fake.reset()
        fake.db.projects = Array.from({ length: N }, (_, i) => ({ id: uuid("pppppppp", i), tenant_id: TENANT_ID, archive_reason: null })) as Row[]
      },
      () => listOtherProjectIds(TENANT_ID, new Set([uuid("pppppppp", 0)])),
      (r) => expect(r).toHaveLength(N - 1),
    )
  })

  it("獎金總表：分配異動紀錄（>100 專案分批＋每批分頁）", async () => {
    const projects = Array.from({ length: 120 }, (_, i) => uuid("pppppppp", i))
    await compare(
      () => {
        fake.reset()
        const rows: Row[] = []
        let n = 0
        for (const p of projects) for (let k = 0; k < 20; k++) rows.push({ id: uuid("ssssssss".replace(/s/g, "5"), ++n), tenant_id: TENANT_ID, project_id: p, employee_id: null, change_set_id: `c${n}`, field: "share_pct", old_value: "1", new_value: "2", reason: null, changed_by_emp_id: null, created_at: `2026-10-01T00:00:${String(n % 60).padStart(2, "0")}Z` })
        fake.db.project_share_adjustments = rows
      },
      async () => {
        const m = await loadShareRevisions(TENANT_ID, projects, new Map())
        return [...m.entries()].map(([k, v]) => [k, v.length])
      },
      (r) => expect(r.reduce((s, [, c]) => s + (c as number), 0)).toBeGreaterThan(0),
    )
  })

  it("集團總覽：年度加班超額另計", async () => {
    await compare(
      () => {
        fake.reset()
        fake.db.overtime_settlements = Array.from({ length: N }, (_, i) => ({ id: uuid("oooooooo".replace(/o/g, "0"), i), tenant_id: TENANT_ID, employee_id: "e", period: "2026-03", amount: 10, status: "paid", source: "manual", minutes: 60, note: null })) as Row[]
      },
      () => loadOvertimeSettlements(TENANT_ID, 2026),
      (r) => expect(r).toHaveLength(N),
    )
  })

  it("專案毛利：入帳期別", async () => {
    const pid = uuid("pppppppp", 1)
    await compare(
      () => {
        fake.reset()
        fake.db.project_billings = Array.from({ length: N }, (_, i) => ({ id: uuid("bbbbbbbb", i), tenant_id: TENANT_ID, project_id: pid, received_amount: 1, received_on: "2026-01-01", deleted_at: null })) as Row[]
      },
      () => loadGrossProfitInput(TENANT_ID, [pid], "2026-12-31", { includeCost: false }),
      (r) => expect(r.billings).toHaveLength(N),
    )
  })

  it("選項清單使用量", async () => {
    const def = findOptionList("client_category") ?? (await import("../services/option-lists.js")).OPTION_LISTS[0]!
    const src = def.usage[0]!
    await compare(
      () => {
        fake.reset()
        fake.db[src.table] = Array.from({ length: N }, (_, i) => ({ id: uuid("cccccccc", i), tenant_id: TENANT_ID, [src.column]: i % 2 ? "a" : "b" })) as Row[]
      },
      () => loadOptionUsage(TENANT_ID, def, ["a", "b"]),
      (r) => expect(r.a! + r.b!).toBe(N),
    )
  })

  it("知識庫合約掃描防線", async () => {
    await compare(
      () => {
        fake.reset()
        fake.db.knowledge_documents = Array.from({ length: N }, (_, i) => ({ id: uuid("kkkkkkkk".replace(/k/g, "1"), i), tenant_id: TENANT_ID, kind: "project_document", project_document_id: uuid("dddddddd", i) })) as Row[]
        fake.db.project_documents = [{ id: uuid("dddddddd", N - 1), tenant_id: TENANT_ID, contract_id: "x" }] as Row[]
      },
      async () => [...(await contractLinkedDocumentIds(TENANT_ID))].sort(),
      (r) => expect(r).toEqual([uuid("11111111", N - 1)]),
    )
  })

  it("公司使用量", async () => {
    const cid = uuid("cccccccc", 1)
    await compare(
      () => {
        fake.reset()
        fake.db.employees = Array.from({ length: N }, (_, i) => ({ id: uuid("eeeeeeee", i), tenant_id: TENANT_ID, company_id: cid })) as Row[]
      },
      async () => [...(await loadCompanyUsage(TENANT_ID, [cid])).entries()],
      (r) => expect(r[0]![1].employees).toBe(N),
    )
  })
})
