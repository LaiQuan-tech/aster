import { z } from "zod";

/**
 * RuleConfig — the tenant-configurable 差勤/薪資規則 DSL.
 *
 * Deliberately a *closed* declarative config (not a Turing-complete script):
 * every knob is a value the worktime / payroll engines read, so a tenant can
 * express the three special schemes the product must support out of the box
 * without ever running arbitrary code.
 *
 *   - attendance_bonus 全勤獎金: base 金額 + 遲到階梯扣款 (tiers)
 *   - overtime 加班: 多條條件式倍率規則 (可選補休 compTime)
 *                    + 加班分鐘取整 / 用餐扣除 / 日上限 / 月警示 (亞斯特出勤表)
 *   - night 夜間: 時段視窗 + 倍率
 *   - payroll 薪資: 計薪方式 (月薪 / 按出勤天數) + 加班參數 + 時薪除數
 *   - leave_deduction 請假/遲到早退扣款開關
 *
 * 新增的 knob 一律「型別上 optional、引擎端補預設」(見檔尾 resolve* helpers),
 * 而不是用 zod `.default()` 讓 parse 後變成必填:apps/api 的 DEFAULT_RULE_CONFIG
 * 是一個**沒經過 parseRuleConfig** 就直接餵給引擎的 RuleConfig 字面值,新欄位若在
 * 型別上必填會同時弄壞它的 typecheck 與執行期。舊 config 不帶新欄位照樣 parse 成功。
 */

// 'HH:MM' 24-hour clock literal, e.g. "00:00", "08:30", "23:59".
const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected 'HH:MM' 24-hour time");

// 全勤獎金階梯：lateMinutesUpTo 為「累計遲到分鐘數上限」(含)，null 代表
// 「以上不封頂」(最後一階)。deduct 為落在該階時的扣款金額。
const AttendanceTierSchema = z.object({
  lateMinutesUpTo: z.number().nullable(),
  deduct: z.number(),
});

const AttendanceBonusSchema = z.object({
  base: z.number(),
  tiers: z.array(AttendanceTierSchema),
});

// 加班觸發情境的閉集合，對應 DayContext.dayType：
//   weekday_ot   ← workday      平日延長工時
//   rest_day     ← rest_day     例假日出勤
//   fixed_holiday ← fixed_holiday 國定/固定假日出勤
export const OvertimeWhenSchema = z.enum([
  "weekday_ot",
  "rest_day",
  "fixed_holiday",
]);
export type OvertimeWhen = z.infer<typeof OvertimeWhenSchema>;

// 加班規則：when 觸發情境、multiplier 倍率、compTime 是否改以補休
// (true = 不發現金，轉補休時數;預設 false 發現金)。
// 分段倍率：勞基法的加班費是「累進」的（平日前 2 小時 1⅓、第 3 小時起 1⅔），
// 故同一個 when 可帶一組 tiers，依當日加班時數由前往後逐段套率。
// uptoHours = 這一段的累計上限（含）；最後一段省略 uptoHours 代表無上限。
// 有 tiers 時忽略 multiplier；沒有 tiers 則沿用單一 multiplier（相容舊設定）。
// minChargeHours：「做 1 給 8」— 該情境當天有加班分鐘 (>0) 時，當日加班分鐘
// 至少以 minChargeHours × 60 計 (國定假日出勤常見)。省略 = 不保底。
const OvertimeTierSchema = z.object({
  uptoHours: z.number().positive().optional(),
  multiplier: z.number(),
});

const OvertimeRuleSchema = z.object({
  when: OvertimeWhenSchema,
  multiplier: z.number(),
  tiers: z.array(OvertimeTierSchema).nonempty().optional(),
  compTime: z.boolean().optional(),
  minChargeHours: z.number().nonnegative().optional(),
});

// 加班分鐘取整 (亞斯特出勤表：以 30 分鐘為單位無條件捨去、未滿 30 分不計)：
//   unitMinutes    取整單位 (分)
//   mode           floor 無條件捨去 / nearest 四捨五入 (半數進位) / ceil 無條件進位
//   minimumMinutes 取整後低於此分鐘數 → 該日加班分鐘歸 0
export const OvertimeRoundingModeSchema = z.enum(["floor", "nearest", "ceil"]);
export type OvertimeRoundingMode = z.infer<typeof OvertimeRoundingModeSchema>;

const OvertimeRoundingSchema = z.object({
  unitMinutes: z.number().int().positive().default(30),
  mode: OvertimeRoundingModeSchema.default("floor"),
  minimumMinutes: z.number().int().nonnegative().default(30),
});
export type OvertimeRounding = z.infer<typeof OvertimeRoundingSchema>;

// 加班用餐扣除：當日原始加班分鐘 > afterMinutes 時扣 deductMinutes (不低於 0)。
// 整個物件給 null = 不扣;省略 = 用預設 {180, 30}。
const OvertimeMealBreakSchema = z.object({
  afterMinutes: z.number().int().nonnegative().default(180),
  deductMinutes: z.number().int().nonnegative().default(30),
});
export type OvertimeMealBreak = z.infer<typeof OvertimeMealBreakSchema>;

// 加班設定：
//   rules             逐情境倍率規則 (見上)
//   rounding          加班分鐘取整 (省略 = DEFAULT_OVERTIME_ROUNDING)
//   mealBreak         用餐扣除 (省略 = DEFAULT_OVERTIME_MEAL_BREAK;null = 不扣)
//   dailyCapMinutes   單日加班上限 (分)。引擎**只回傳、不裁切**,由 API 拿來判異常。
//   monthlyAlertHours 月累計加班警示門檻 (小時),由小到大;同樣只供 API 判異常。
const OvertimeSchema = z.object({
  rules: z.array(OvertimeRuleSchema),
  rounding: OvertimeRoundingSchema.optional(),
  mealBreak: OvertimeMealBreakSchema.nullable().optional(),
  dailyCapMinutes: z.number().int().positive().optional(),
  monthlyAlertHours: z.array(z.number().nonnegative()).optional(),
});

// 夜間加給：window 時段視窗 ("HH:MM"，允許跨午夜如 00:00–08:30)，multiplier 倍率。
const NightSchema = z.object({
  window: z.object({
    from: HHMM,
    to: HHMM,
  }),
  multiplier: z.number(),
});

// 計薪設定：
//   method              'monthly' 月薪 / 'by_attendance_days' 按出勤天數
//   overtimeFlatHourly  若設定，加班一律以此固定時薪計 (覆蓋倍率制)
//   dailyRegularHours   每日正常工時 (超過即算加班;折算時薪用)。預設 8。
//   hourlyWageDivisor   時薪除數:員工未明示 hourlyWage 時,時薪 = 本薪 ÷ divisor
//                       (亞斯特：37000 ÷ 240 = 154.1667)。省略 = 240。
//   requireApprovedSheet 結算薪資前是否要求出勤表已核准 (API 用;省略 = false)。
//   requireAnomalyAck   結算薪資前是否要求異常已確認 (API 用;省略 = true)。
const PayrollSchema = z.object({
  method: z.enum(["monthly", "by_attendance_days"]),
  overtimeFlatHourly: z.number().optional(),
  dailyRegularHours: z.number().default(8),
  hourlyWageDivisor: z.number().positive().optional(),
  requireApprovedSheet: z.boolean().optional(),
  requireAnomalyAck: z.boolean().optional(),
});

// 勞健保自付額：以員工的投保薪資為基數。費率逐年調整，故放在租戶規則設定裡而非寫死。
//   labor.rate         勞保普通事故＋就保合計費率 (例 0.125)
//   labor.employeeShare 員工自付比例 (例 0.2)
//   health.rate        健保費率 (例 0.0517)
//   health.employeeShare 員工自付比例 (例 0.3)
// 整段可省略；省略時不計保費（引擎回 0），既有租戶設定不會因此解析失敗。
const InsuranceSchema = z
  .object({
    labor: z.object({ rate: z.number(), employeeShare: z.number() }),
    health: z.object({ rate: z.number(), employeeShare: z.number() }),
  })
  .optional();

// 請假 / 遲到早退扣款：
//   lateEarly.enabled  true 時扣 (遲到分鐘 + 早退分鐘) ÷ 60 × 時薪;省略 = false。
// 假別的扣薪比例**不放這裡**:由呼叫端隨每日 AttendanceDay.leaves 帶 deductRate
// (事假 1、病假 0.5…由假別主檔決定),引擎只負責乘。
const LeaveDeductionSchema = z
  .object({
    lateEarly: z.object({ enabled: z.boolean().default(false) }).optional(),
  })
  .optional();

export const RuleConfigSchema = z.object({
  attendance_bonus: AttendanceBonusSchema,
  overtime: OvertimeSchema,
  night: NightSchema,
  payroll: PayrollSchema,
  insurance: InsuranceSchema,
  leave_deduction: LeaveDeductionSchema,
});

export type RuleConfig = z.infer<typeof RuleConfigSchema>;

/**
 * Parse-and-validate an unknown input into a typed RuleConfig.
 * Throws a ZodError when the input does not match the schema.
 */
export function parseRuleConfig(input: unknown): RuleConfig {
  return RuleConfigSchema.parse(input);
}

/* ------------------------------------------------ 預設值與 resolve helpers ----- */

export const DEFAULT_OVERTIME_ROUNDING: OvertimeRounding = {
  unitMinutes: 30,
  mode: "floor",
  minimumMinutes: 30,
};
export const DEFAULT_OVERTIME_MEAL_BREAK: OvertimeMealBreak = {
  afterMinutes: 180,
  deductMinutes: 30,
};
export const DEFAULT_OVERTIME_DAILY_CAP_MINUTES = 240;
export const DEFAULT_OVERTIME_MONTHLY_ALERT_HOURS: readonly number[] = [36, 40, 46];
export const DEFAULT_HOURLY_WAGE_DIVISOR = 240;
export const DEFAULT_REQUIRE_APPROVED_SHEET = false;
export const DEFAULT_REQUIRE_ANOMALY_ACK = true;

/** 加班取整設定 (省略 → 預設 30 分 floor、未滿 30 分歸 0)。 */
export function resolveOvertimeRounding(rules: RuleConfig): OvertimeRounding {
  return rules.overtime.rounding ?? DEFAULT_OVERTIME_ROUNDING;
}

/** 加班用餐扣除 (省略 → 預設 {180, 30};明示 null → 不扣,回 null)。 */
export function resolveOvertimeMealBreak(rules: RuleConfig): OvertimeMealBreak | null {
  const v = rules.overtime.mealBreak;
  return v === undefined ? DEFAULT_OVERTIME_MEAL_BREAK : v;
}

/** 單日加班上限 (分);引擎不裁切,供 API 判異常。 */
export function resolveOvertimeDailyCapMinutes(rules: RuleConfig): number {
  return rules.overtime.dailyCapMinutes ?? DEFAULT_OVERTIME_DAILY_CAP_MINUTES;
}

/** 月累計加班警示門檻 (小時);供 API 判異常。 */
export function resolveOvertimeMonthlyAlertHours(rules: RuleConfig): readonly number[] {
  return rules.overtime.monthlyAlertHours ?? DEFAULT_OVERTIME_MONTHLY_ALERT_HOURS;
}

/** 時薪除數 (時薪 = 本薪 ÷ divisor;省略 → 240)。 */
export function resolveHourlyWageDivisor(rules: RuleConfig): number {
  return rules.payroll.hourlyWageDivisor ?? DEFAULT_HOURLY_WAGE_DIVISOR;
}

/** 結算前置門檻 (API 用)。 */
export function resolvePayrollGates(rules: RuleConfig): {
  requireApprovedSheet: boolean;
  requireAnomalyAck: boolean;
} {
  return {
    requireApprovedSheet:
      rules.payroll.requireApprovedSheet ?? DEFAULT_REQUIRE_APPROVED_SHEET,
    requireAnomalyAck: rules.payroll.requireAnomalyAck ?? DEFAULT_REQUIRE_ANOMALY_ACK,
  };
}

/** 遲到早退是否扣款 (省略 → false)。 */
export function resolveLateEarlyDeductionEnabled(rules: RuleConfig): boolean {
  return rules.leave_deduction?.lateEarly?.enabled ?? false;
}
