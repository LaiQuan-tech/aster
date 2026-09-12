import { describe, it, expect } from "vitest"
import {
  PROJECT_STATUSES,
  isProjectStatus,
  isTerminal,
  taipeiToday,
  resolveStatusPatch,
  addMonths,
  shouldAutoArchive,
} from "../services/project-status"

/**
 * 案情狀態的規則（模組四第 2 條）。
 * 規則集中在 resolveStatusPatch，所以測試也集中在這裡。
 */

const BASE = {
  currentStatus: "active",
  currentArchivedAt: null as string | null,
  today: "2026-09-12",
  nowIso: "2026-09-12T05:00:00.000Z",
  actorEmpId: "emp-1",
}

describe("狀態集合", () => {
  it("四個值，寫死不做成設定表", () => {
    expect([...PROJECT_STATUSES]).toEqual(["active", "suspended", "closed", "terminated"])
  })

  it("結案與解約是終止狀態", () => {
    expect(isTerminal("closed")).toBe(true)
    expect(isTerminal("terminated")).toBe(true)
    expect(isTerminal("active")).toBe(false)
    expect(isTerminal("suspended")).toBe(false)
  })

  it("舊制的 archived 不再是合法狀態", () => {
    expect(isProjectStatus("archived")).toBe(false)
  })
})

describe("變更案情一律要理由", () => {
  it("沒填理由就擋下", () => {
    const r = resolveStatusPatch({ ...BASE, status: "terminated" })
    expect(r).toEqual({ ok: false, error: "status_reason_required" })
  })

  it("只有空白也算沒填", () => {
    const r = resolveStatusPatch({ ...BASE, status: "closed", statusReason: "   " })
    expect(r).toEqual({ ok: false, error: "status_reason_required" })
  })

  it("填了就放行，並寫下輸入時點與操作人", () => {
    const r = resolveStatusPatch({
      ...BASE,
      status: "terminated",
      statusReason: "業主資金斷鏈，依約第 12 條終止",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status).toBe("terminated")
    expect(r.patch.status_reason).toBe("業主資金斷鏈，依約第 12 條終止")
    expect(r.patch.status_changed_at).toBe(BASE.nowIso)
    expect(r.patch.status_changed_by_emp_id).toBe("emp-1")
  })

  it("不擋任何方向的轉移——結案後返工是真的", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "terminated",
      status: "active",
      statusReason: "雙方復談，合約回復",
    })
    expect(r.ok).toBe(true)
  })
})

describe("生效日 ≠ 輸入時點", () => {
  it("填了就用填的那天（解約通知書上的日期常早於輸入日）", () => {
    const r = resolveStatusPatch({
      ...BASE,
      status: "terminated",
      statusReason: "解約",
      statusEffectiveOn: "2026-08-01",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status_effective_on).toBe("2026-08-01")
    // 輸入時點仍是現在，兩者不可混用。
    expect(r.patch.status_changed_at).toBe(BASE.nowIso)
  })

  it("沒填才退回今天", () => {
    const r = resolveStatusPatch({ ...BASE, status: "closed", statusReason: "驗收完成" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status_effective_on).toBe("2026-09-12")
  })
})

describe("狀態沒變時的更正", () => {
  it("可以只更正理由，不動輸入時點", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "terminated",
      status: "terminated",
      statusReason: "更正：依約第 12 條第 2 項",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status_reason).toBe("更正：依約第 12 條第 2 項")
    // status_changed_at 記的是「案情何時改變」，不是「誰改過欄位」——
    // 後者在 audit_logs 裡。
    expect(r.patch.status_changed_at).toBeUndefined()
    expect(r.patch.status).toBeUndefined()
  })

  it("可以只更正打錯的解約日", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "terminated",
      statusEffectiveOn: "2026-07-15",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status_effective_on).toBe("2026-07-15")
  })

  it("什麼都沒送就什麼都不寫", () => {
    const r = resolveStatusPatch({ ...BASE })
    expect(r).toEqual({ ok: true, patch: {} })
  })
})

describe("封存是另一軸", () => {
  it("進行中的專案不能封存——「進行中」與「不想看到」互相矛盾", () => {
    const r = resolveStatusPatch({ ...BASE, archived: true })
    expect(r).toEqual({ ok: false, error: "archive_requires_non_active" })
  })

  it("同一次把進行中改成結案並封存是可以的", () => {
    const r = resolveStatusPatch({
      ...BASE,
      status: "closed",
      statusReason: "驗收完成",
      archived: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status).toBe("closed")
    expect(r.patch.archived_at).toBe(BASE.nowIso)
  })

  it("封存不覆寫案情——解約的案子封存後仍是解約", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "terminated",
      archived: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status).toBeUndefined()
    expect(r.patch.archived_at).toBe(BASE.nowIso)
  })

  it("重複封存不洗掉原本的封存日", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "closed",
      currentArchivedAt: "2026-01-01T00:00:00.000Z",
      archived: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.archived_at).toBeUndefined()
  })

  it("取消封存", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "closed",
      currentArchivedAt: "2026-01-01T00:00:00.000Z",
      archived: false,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.archived_at).toBeNull()
  })

  it("轉回進行中會自動解除封存，否則會變成「進行中但看不到」", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "closed",
      currentArchivedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      statusReason: "驗收不過，返工",
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.status).toBe("active")
    expect(r.patch.archived_at).toBeNull()
  })
})

describe("不合法的值", () => {
  it("舊制的 archived 當狀態送進來會被擋", () => {
    const r = resolveStatusPatch({ ...BASE, status: "archived", statusReason: "x" })
    expect(r).toEqual({ ok: false, error: "invalid_status" })
  })
})

describe("taipeiToday", () => {
  it("用台北時區，不是 UTC", () => {
    // UTC 2026-09-12T23:00Z 在台北已經是 9/13。
    expect(taipeiToday(new Date("2026-09-12T23:00:00.000Z"))).toBe("2026-09-13")
    expect(taipeiToday(new Date("2026-09-12T10:00:00.000Z"))).toBe("2026-09-12")
  })
})

/* ── 自動封存（使用者裁示「自動化」）────────────────────────────── */

describe("addMonths", () => {
  it("一般情況", () => {
    expect(addMonths("2026-03-15", 6)).toBe("2026-09-15")
    expect(addMonths("2026-09-15", 6)).toBe("2027-03-15")
    expect(addMonths("2026-09-15", 0)).toBe("2026-09-15")
  })

  it("日期溢位時夾到當月最後一天，不滾到下個月", () => {
    // 8/31 + 6 個月是 2/28，不是 3/3。
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28")
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29") // 閏年
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28")
  })
})

describe("shouldAutoArchive", () => {
  const OPTS = { today: "2026-09-12", months: 6 }
  const CLOSED = {
    status: "closed",
    archived_at: null as string | null,
    unarchived_at: null as string | null,
    status_effective_on: "2026-01-01",
    status_changed_at: "2026-01-01T00:00:00.000Z",
  }

  it("結案滿 6 個月就封存", () => {
    expect(shouldAutoArchive(CLOSED, OPTS)).toBe(true)
  })

  it("還沒滿就不封存", () => {
    expect(
      shouldAutoArchive(
        { ...CLOSED, status_effective_on: "2026-06-01", status_changed_at: "2026-06-01T00:00:00.000Z" },
        OPTS,
      ),
    ).toBe(false)
  })

  it("已解約同樣會被自動封存", () => {
    expect(shouldAutoArchive({ ...CLOSED, status: "terminated" }, OPTS)).toBe(true)
  })

  it("⚠️ 暫停永遠不自動封存——收起來就真的忘了", () => {
    expect(shouldAutoArchive({ ...CLOSED, status: "suspended" }, OPTS)).toBe(false)
  })

  it("進行中不封存", () => {
    expect(shouldAutoArchive({ ...CLOSED, status: "active" }, OPTS)).toBe(false)
  })

  it("已封存的不重複處理（冪等）", () => {
    expect(
      shouldAutoArchive({ ...CLOSED, archived_at: "2026-05-01T00:00:00.000Z" }, OPTS),
    ).toBe(false)
  })

  it("起算日取兩個日期較晚者——補登舊解約單不該當晚就消失", () => {
    // 解約日是去年，但今天才進系統：從輸入日起算，還要等 6 個月。
    expect(
      shouldAutoArchive(
        {
          ...CLOSED,
          status: "terminated",
          status_effective_on: "2025-03-01",
          status_changed_at: "2026-09-12T01:00:00.000Z",
        },
        OPTS,
      ),
    ).toBe(false)
  })

  it("反過來，生效日較晚時用生效日", () => {
    // 預先登記一張下個月才生效的結案：更不該現在封存。
    expect(
      shouldAutoArchive(
        { ...CLOSED, status_effective_on: "2026-10-01", status_changed_at: "2026-01-01T00:00:00.000Z" },
        OPTS,
      ),
    ).toBe(false)
  })

  it("⚠️ 人工拉回來的就放過——否則排程當晚又收起來，功能等於壞的", () => {
    expect(
      shouldAutoArchive(
        { ...CLOSED, unarchived_at: "2026-08-01T00:00:00.000Z" },
        OPTS,
      ),
    ).toBe(false)
  })

  it("拉回來之後案情又變動過，才恢復自動封存", () => {
    expect(
      shouldAutoArchive(
        {
          ...CLOSED,
          unarchived_at: "2026-02-01T00:00:00.000Z",
          // 解除封存後又重新結案一次 → 新的寬限期已過
          status_effective_on: "2026-02-15",
          status_changed_at: "2026-02-15T00:00:00.000Z",
        },
        OPTS,
      ),
    ).toBe(true)
  })

  it("兩個日期都沒有就不動——不知道何時結束就不要猜", () => {
    expect(
      shouldAutoArchive(
        { ...CLOSED, status_effective_on: null, status_changed_at: null },
        OPTS,
      ),
    ).toBe(false)
  })

  it("months 設 0 表示終止當天就封存", () => {
    expect(
      shouldAutoArchive(
        { ...CLOSED, status_effective_on: "2026-09-12", status_changed_at: "2026-09-12T00:00:00.000Z" },
        { today: "2026-09-12", months: 0 },
      ),
    ).toBe(true)
  })
})

describe("解除封存要留下時點", () => {
  it("人工解除封存寫下 unarchived_at，自動封存才知道要放過", () => {
    const r = resolveStatusPatch({
      ...BASE,
      currentStatus: "closed",
      currentArchivedAt: "2026-01-01T00:00:00.000Z",
      archived: false,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.patch.archived_at).toBeNull()
    expect(r.patch.unarchived_at).toBe(BASE.nowIso)
  })
})
