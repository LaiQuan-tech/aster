import type { RuleConfig } from "@hr/rules"

/**
 * The default 差勤/薪資規則 template returned by GET /rule-config when a tenant
 * has not yet saved one of its own, and the fallback the settlement / payroll
 * runs use when the stored config is missing or malformed. It is a *valid*
 * RuleConfig (passes parseRuleConfig).
 *
 * P0（亞斯特出勤統計表對齊）預設值——以下三項**待業主確認**（計畫 §六）：
 *   • 取整：加班分鐘以 30 分為單位無條件捨去、未滿 30 分不計（rounding）
 *   • 晚餐：當日延長工時 > 180 分先扣 30 分（mealBreak）
 *   • 做 1 給 8：固定假日出勤有加班分鐘即至少以 8 小時計（fixed_holiday.minChargeHours）
 * 其餘：加班倍率採勞基法累進（前 2h 1.334、2–8h 1.666667、8h 以上 2.666667，
 * 平日與例假日同表；固定假日 ×1）、單日加班上限 240 分與月累計警示 36/40/46
 * 小時只供異常判定不裁切、時薪 = 本薪 ÷ 240、22:00–06:00 夜間、月薪制 8h 正常工時。
 * Tenants override any of this via PUT /rule-config.
 */
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  attendance_bonus: {
    base: 0,
    tiers: [{ lateMinutesUpTo: null, deduct: 0 }],
  },
  overtime: {
    rules: [
      {
        when: "weekday_ot",
        multiplier: 1.334,
        tiers: [
          { uptoHours: 2, multiplier: 1.334 },
          { uptoHours: 8, multiplier: 1.666667 },
          { multiplier: 2.666667 },
        ],
      },
      {
        when: "rest_day",
        multiplier: 1.334,
        tiers: [
          { uptoHours: 2, multiplier: 1.334 },
          { uptoHours: 8, multiplier: 1.666667 },
          { multiplier: 2.666667 },
        ],
      },
      { when: "fixed_holiday", multiplier: 1, minChargeHours: 8 },
    ],
    rounding: { unitMinutes: 30, mode: "floor", minimumMinutes: 30 },
    mealBreak: { afterMinutes: 180, deductMinutes: 30 },
    dailyCapMinutes: 240,
    monthlyAlertHours: [36, 40, 46],
  },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
  payroll: { method: "monthly", dailyRegularHours: 8, hourlyWageDivisor: 240 },
}
