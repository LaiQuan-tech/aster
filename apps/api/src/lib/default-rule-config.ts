import {
  NEW_TENANT_OVERTIME_MEAL_BREAK,
  NEW_TENANT_OVERTIME_ROUNDING,
  STATUTORY_OVERTIME_RULES,
  type RuleConfig,
} from "@hr/rules"

/**
 * The default 差勤/薪資規則 template returned by GET /rule-config when a tenant
 * has not yet saved one of its own, and the fallback the settlement / payroll
 * runs use when the stored config is missing or malformed. It is a *valid*
 * RuleConfig (passes parseRuleConfig).
 *
 * 2026-10-17 一例一休改版（@hr/rules 的法定常數，新租戶建議值）：
 *   • 加班倍率 STATUTORY_OVERTIME_RULES：平日 ≤2h ×1.334、之後 ×1.666667；休息日 ≤2h ×1.334、3–8h ×1.666667、
 *     9h 起 ×2.666667；國定假日做 1 給 8（8h ×1）、8h 後 ×1.334／×1.666667；例假同國定假日＋需補假。
 *   • 取整 NEW_TENANT_OVERTIME_ROUNDING：照分鐘（unit 1、無最低分鐘）。
 *   • 晚餐 NEW_TENANT_OVERTIME_MEAL_BREAK：員工勾選晚餐才扣 60 分（mode opt_in）。
 * ⚠️ 本系統建租戶時不寫 rule_configs，所以「沒存過規則」的既有租戶也會吃到這份預設；
 * 已存過規則的租戶（例：正式租戶）不受影響，要改版得另外存一版新規則。
 * 其餘：單日加班上限 240 分與月累計警示 36/40/46 小時只供異常判定不裁切、時薪 = 本薪 ÷ 240、
 * 22:00–06:00 夜間、月薪制 8h 正常工時。Tenants override any of this via PUT /rule-config.
 */
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  attendance_bonus: {
    base: 0,
    tiers: [{ lateMinutesUpTo: null, deduct: 0 }],
  },
  overtime: {
    rules: structuredClone(STATUTORY_OVERTIME_RULES),
    rounding: { ...NEW_TENANT_OVERTIME_ROUNDING },
    mealBreak: { ...NEW_TENANT_OVERTIME_MEAL_BREAK },
    dailyCapMinutes: 240,
    monthlyAlertHours: [36, 40, 46],
  },
  night: { window: { from: "22:00", to: "06:00" }, multiplier: 1.34 },
  payroll: { method: "monthly", dailyRegularHours: 8, hourlyWageDivisor: 240 },
}

/**
 * 2026-10-17 之前的系統預設（P0 對齊亞斯特 115-06 出勤統計表時定的值）：加班 30 分無條件捨去、未滿 30 分不計；
 * 當日延長工時 > 180 分先扣晚餐 30 分（mode auto）；平日與休息日同一張累進表（2h 1.334、2–8h 1.666667、
 * 8h 以上 2.666667）；國定假日 ×1 做 1 給 8；沒有例假規則（引擎採法定預設）。
 * 只留給「照舊規則算」的回歸測試與 115-06 fixture 比對用；正式租戶實際吃的是自己存的 rule_configs。
 */
export const LEGACY_RULE_CONFIG_2026_09: RuleConfig = {
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
