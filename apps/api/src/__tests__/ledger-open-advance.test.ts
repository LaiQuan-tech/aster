import type { SupabaseClient } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { applyApprovalEffects } from "../services/ledger.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 最終核准 → 開預支（services/ledger.ts openAdvance；2026-10-11 費用方式二選一）：
 *   • 先預支：advance_requested > 0 → 開一列 advances（status='requested'、尚未撥款）；
 *     出差 kind='trip'、零用金 kind='petty_cash'。
 *   • 自行墊付、回來報銷：advance_requested 沒帶／0／null → 不開預支（憑證之後走月報銷）。
 *   • 重複核准不重複開（以 request_id 去重）。
 * 整條送單→簽核→核准的路徑見 approval-boss-final.test.ts。⚠️ 識別碼都是明顯的假值。
 */

const EMP = "bbbbbbbb-0000-4000-8000-000000000004"
const REQ = "eeeeeeee-0000-4000-8000-000000000001"

const client = fake as unknown as SupabaseClient
const approved = (kind: string, advance: string | number | null) => ({
  id: REQ,
  employee_id: EMP,
  kind,
  leave_type_id: null,
  hours: null,
  start_at: "2027-06-03T01:00:00.000Z",
  end_at: "2027-06-03T09:00:00.000Z",
  advance_requested: advance,
})
const advances = () => fake.db.advances ?? []

beforeEach(() => fake.reset())

describe("applyApprovalEffects — 預支只在「先預支」時開", () => {
  it("出差、advance_requested=5000 → 開一列 kind='trip'、requested、金額 5000", async () => {
    await applyApprovalEffects(client, TENANT_ID, approved("business_trip", 5000))

    expect(advances()).toHaveLength(1)
    expect(advances()[0]).toMatchObject({ tenant_id: TENANT_ID, kind: "trip", request_id: REQ, employee_id: EMP, amount: 5000, status: "requested" })
  })

  it("零用金、advance_requested='3000'（PostgREST 的 numeric 是字串）→ 開一列 kind='petty_cash'、金額 3000", async () => {
    await applyApprovalEffects(client, TENANT_ID, approved("petty_cash", "3000"))

    expect(advances()).toHaveLength(1)
    expect(advances()[0]).toMatchObject({ kind: "petty_cash", amount: 3000, status: "requested" })
  })

  it.each([
    ["沒帶（null）", null],
    ["帶 0", 0],
    ["帶 '0'", "0"],
    ["負數", -100],
    ["非數字", "abc"],
  ])("自行墊付：advance_requested %s → 不開預支（出差與零用金都一樣）", async (_label, advance) => {
    await applyApprovalEffects(client, TENANT_ID, approved("business_trip", advance))
    await applyApprovalEffects(client, TENANT_ID, approved("petty_cash", advance))

    expect(advances()).toEqual([])
    expect(fake.writes).toEqual([])
  })

  it("重複核准（同一張單再呼叫一次）不會重複開預支", async () => {
    await applyApprovalEffects(client, TENANT_ID, approved("business_trip", 5000))
    await applyApprovalEffects(client, TENANT_ID, approved("business_trip", 5000))

    expect(advances()).toHaveLength(1)
  })
})
