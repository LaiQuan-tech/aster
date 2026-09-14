export {
  RuleConfigSchema,
  parseRuleConfig,
  OvertimeWhenSchema,
  OvertimeRoundingModeSchema,
  DEFAULT_OVERTIME_ROUNDING,
  DEFAULT_OVERTIME_MEAL_BREAK,
  DEFAULT_OVERTIME_DAILY_CAP_MINUTES,
  DEFAULT_OVERTIME_MONTHLY_ALERT_HOURS,
  DEFAULT_HOURLY_WAGE_DIVISOR,
  DEFAULT_REQUIRE_APPROVED_SHEET,
  DEFAULT_REQUIRE_ANOMALY_ACK,
  resolveOvertimeRounding,
  resolveOvertimeMealBreak,
  resolveOvertimeDailyCapMinutes,
  resolveOvertimeMonthlyAlertHours,
  resolveHourlyWageDivisor,
  resolvePayrollGates,
  resolveLateEarlyDeductionEnabled,
  type RuleConfig,
  type OvertimeWhen,
  type OvertimeRounding,
  type OvertimeRoundingMode,
  type OvertimeMealBreak,
} from "./rules-schema.js";

export * from "./types.js";
export { computeAttendanceDay, applyOvertimePipeline } from "./worktime-engine.js";
export { computePayslip } from "./payroll-engine.js";
export {
  bonusSupplementaryPremium,
  otherIncomeSupplementaryPremium,
  salaryWithholdingFixedRate,
  nonResidentWithholding,
  nhiEmployeePremium,
  DEFAULT_SUPPLEMENTARY_NHI_RATE,
  BONUS_MULTIPLE_THRESHOLD,
  OTHER_INCOME_MIN,
  NHI_MAX_DEPENDENTS,
  PENSION_VOLUNTARY_RATE_MAX,
} from "./tw-tax.js";
