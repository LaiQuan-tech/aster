export {
  RuleConfigSchema,
  parseRuleConfig,
  OvertimeWhenSchema,
  type RuleConfig,
  type OvertimeWhen,
} from "./rules-schema.js";

export * from "./types.js";
export { computeAttendanceDay } from "./worktime-engine.js";
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
