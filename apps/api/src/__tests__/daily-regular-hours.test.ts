import { beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { DEFAULT_RULE_CONFIG } from "../lib/default-rule-config.js"
import { loadDailyRegularHours } from "../services/daily-regular-hours.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 「1 天 ＝ 幾小時」的換算基準（只給請假時數的天＋時顯示用）：租戶目前生效規則的
 * payroll.dailyRegularHours，預設 8；讀不到一律退回 8、**絕不丟錯**（顯示用的附加欄位不能拖垮主回應）。
 */

function ruleRow(dailyRegularHours: number, extra: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT_ID,
    config: { ...DEFAULT_RULE_CONFIG, payroll: { ...DEFAULT_RULE_CONFIG.payroll, dailyRegularHours } },
    version: 1,
    effective_from: "1900-01-01",
    ...extra,
  }
}

describe("loadDailyRegularHours", () => {
  beforeEach(() => {
    fake.reset()
  })

  it("這個租戶沒有任何規則版本 → 預設 8", async () => {
    expect(await loadDailyRegularHours(TENANT_ID)).toBe(8)
  })

  it("規則設 7.5 → 7.5（1 天 ＝ 7.5 小時）", async () => {
    fake.db.rule_configs = [ruleRow(7.5)]
    expect(await loadDailyRegularHours(TENANT_ID)).toBe(7.5)
  })

  it("規則設 8 → 8", async () => {
    fake.db.rule_configs = [ruleRow(8)]
    expect(await loadDailyRegularHours(TENANT_ID)).toBe(8)
  })

  it("多個版本：取目前生效（effective_from 不晚於本月、最新）的那版", async () => {
    fake.db.rule_configs = [
      ruleRow(8, { version: 1, effective_from: "1900-01-01" }),
      ruleRow(7, { version: 2, effective_from: "2026-01-01" }),
      ruleRow(6, { version: 3, effective_from: "2999-01-01" }), // 還沒生效，不能用
    ]
    expect(await loadDailyRegularHours(TENANT_ID)).toBe(7)
  })

  it("只讀自己租戶的規則（別的租戶設 6 不能影響）", async () => {
    fake.db.rule_configs = [ruleRow(6, { tenant_id: "99999999-9999-4999-8999-999999999999" })]
    expect(await loadDailyRegularHours(TENANT_ID)).toBe(8)
  })

  it("規則 jsonb 壞掉 → 退回預設 8（不丟錯）", async () => {
    fake.db.rule_configs = [ruleRow(7.5, { config: { payroll: "壞掉的設定" } })]
    expect(await loadDailyRegularHours(TENANT_ID)).toBe(8)
  })

  it("DB 查詢失敗 → 退回 8（不丟錯）", async () => {
    fake.injectError({ table: "rule_configs", action: "select", error: { message: "boom", code: "XX000" } })
    expect(await loadDailyRegularHours(TENANT_ID)).toBe(8)
  })
})
