import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版，不連任何 DB。⚠️ 識別碼都是明顯的假值（repo 公開）。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import type { SupabaseClient } from "@supabase/supabase-js"
import { applyApprovalEffects, type ApprovedRequest } from "../services/ledger.js"
import { adjustBucketUsed } from "../services/menstrual-leave.js"
import { logger } from "../lib/logger.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

/**
 * ledger.debitLeaveBalance（核准請假累加 leave_balances.used）改樂觀鎖（2026-11-17 驗收）：
 * 以前讀後直接寫 used＝讀到的值＋時數，與生理假併入病假（adjustBucketUsed）同時改同一病假桶會互蓋。
 */

const EMP = "bbbbbbbb-0000-4000-8000-0000000000d1"
const LT_SICK = "cccccccc-0000-4000-8000-0000000000d1"
const BUCKET = "eeeeeeee-0000-4000-8000-0000000000d1"

const leaveReq = (hours: number): ApprovedRequest =>
  ({
    id: "aaaaaaaa-0000-4000-8000-0000000000d1",
    kind: "leave",
    employee_id: EMP,
    leave_type_id: LT_SICK,
    start_at: "2027-06-03T01:00:00.000Z",
    end_at: "2027-06-03T09:00:00.000Z",
    hours,
  }) as unknown as ApprovedRequest

const bucketRow = () => (fake.db.leave_balances ?? []).find((b) => b.id === BUCKET) as Row

/** 包一層 client：前 n 次對 leave_balances 的 update，在送出前讓「另一個寫入者」先改掉 used。 */
function racingClient(n: number, bump: () => Promise<void> | void): SupabaseClient {
  let left = n
  return {
    from(table: string) {
      const qb = fake.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>
      if (table === "leave_balances") {
        const update = qb.update.bind(qb)
        qb.update = (payload: unknown) => {
          if (left > 0) {
            left -= 1
            void bump()
          }
          return update(payload)
        }
      }
      return qb
    },
  } as unknown as SupabaseClient
}

beforeEach(() => {
  fake.reset()
  fake.db.tenants = [{ id: TENANT_ID, features: {} }]
  fake.db.leave_balances = [
    {
      id: BUCKET,
      tenant_id: TENANT_ID,
      employee_id: EMP,
      leave_type_id: LT_SICK,
      year: 2027,
      period_start: "2027-01-01",
      period_end: "2027-12-31",
      entitled: 0,
      used: 10,
      deferred: 0,
      created_at: "2027-01-01T00:00:00.000Z",
    },
  ]
})

describe("debitLeaveBalance 樂觀鎖", () => {
  it("沒有競爭：照舊累加", async () => {
    await applyApprovalEffects(fake as unknown as SupabaseClient, TENANT_ID, leaveReq(8))
    expect(bucketRow().used).toBe(18)
  })

  it("讀到之後、寫入之前同一桶被生理假併入改過 → 重讀再試，兩邊都算到（不互蓋）", async () => {
    const client = racingClient(1, () => {
      bucketRow().used = Number(bucketRow().used) + 4 // 另一個寫入者（如 adjustBucketUsed）先寫進去
    })
    await applyApprovalEffects(client, TENANT_ID, leaveReq(8))
    expect(bucketRow().used).toBe(22)
  })

  it("與 adjustBucketUsed 交錯（真的呼叫）→ 結果為兩者相加", async () => {
    const client = racingClient(1, async () => {
      await adjustBucketUsed(fake as unknown as SupabaseClient, BUCKET, 4)
    })
    // adjustBucketUsed 在 bump 裡是非同步的；它的 update 也走 fake，順序上先完成讀才改。這裡驗最終值不少算。
    await applyApprovalEffects(client, TENANT_ID, leaveReq(8))
    await new Promise((r) => setTimeout(r, 0))
    expect(bucketRow().used).toBe(22)
  })

  it("一直搶不到（5 次都被改）→ 不靜默覆蓋：不寫入、記錯（applyApprovalEffects 不丟出）", async () => {
    const client = racingClient(99, () => {
      bucketRow().used = Number(bucketRow().used) + 1
    })
    await applyApprovalEffects(client, TENANT_ID, leaveReq(8))
    // 5 次都被別人改過（+1×5），本單 8 小時沒有用舊值覆蓋掉別人的寫入
    expect(bucketRow().used).toBe(15)
  })
})

describe("debitLeaveBalance 建桶並發（23505）", () => {
  it("沒有桶 → 建桶時撞唯一索引（別人剛建好）→ 重讀那個桶、樂觀鎖累加，不丟時數", async () => {
    fake.db.leave_balances = []
    let raced = false
    const client = {
      from(table: string) {
        const qb = fake.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>
        if (table === "leave_balances") {
          const insert = qb.insert.bind(qb)
          qb.insert = (payload: unknown) => {
            if (!raced) {
              raced = true
              // 另一個寫入者剛建好同一桶（used=3），本次 insert 撞唯一索引
              fake.db.leave_balances!.push({
                id: BUCKET, tenant_id: TENANT_ID, employee_id: EMP, leave_type_id: LT_SICK, year: 2027,
                period_start: "2027-01-01", period_end: "2027-12-31", entitled: 0, used: 3, deferred: 0, created_at: "2027-01-01T00:00:00.000Z",
              })
              fake.injectError({ table: "leave_balances", action: "insert", error: { message: "duplicate key value violates unique constraint \"leave_balances_tenant_emp_type_period_uq\"", code: "23505" } })
            }
            return insert(payload)
          }
        }
        return qb
      },
    } as unknown as SupabaseClient
    await applyApprovalEffects(client, TENANT_ID, leaveReq(8))
    expect(fake.db.leave_balances).toHaveLength(1)
    expect(bucketRow().used).toBe(11)
  })

  it("重試 5 次仍搶不到 → 結構化 error log（申請單、時數、桶）方便人工補記", async () => {
    const spy = vi.spyOn(logger, "error")
    const client = racingClient(99, () => {
      bucketRow().used = Number(bucketRow().used) + 1
    })
    await applyApprovalEffects(client, TENANT_ID, leaveReq(8))
    const call = spy.mock.calls.find((c) => typeof c[1] === "string" && (c[1] as string).includes("CAS exhausted"))
    expect(call?.[0]).toMatchObject({ tenantId: TENANT_ID, requestId: "aaaaaaaa-0000-4000-8000-0000000000d1", bucketId: BUCKET, hours: 8, leaveTypeId: LT_SICK })
    spy.mockRestore()
  })
})
