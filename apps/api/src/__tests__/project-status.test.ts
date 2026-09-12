import { describe, it, expect } from "vitest"
import {
  PROJECT_STATUSES,
  isProjectStatus,
  isTerminal,
  taipeiToday,
  resolveStatusPatch,
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
