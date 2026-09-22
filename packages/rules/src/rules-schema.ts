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

// 加班起算基準 (W9,2026-09-23):
//   regularHours  超過 payroll.dailyRegularHours (法定 8 小時) 才算加班 (舊行為,預設)
//   shift         超過**當日班表淨工時** (班別時段 − 休息) 即算加班 (亞斯特 Excel 語意:
//                 14:00–22:00 班淨 7 小時,打到 23:00 算 1 小時加班);無排班退回 regularHours
export const OvertimeBasisSchema = z.enum(["regularHours", "shift"]);
export type OvertimeBasis = z.infer<typeof OvertimeBasisSchema>;

// 月加班超過上限後的處理 (M1,2026-09-22 業主決策 1):
//   settle_separately  超額分鐘不進薪資單加班費,月表核准時歸入 overtime_settlements
//                      另行給付 (現金/補休;只有老闆與 HR 看得到)。預設。
//   warn               只在月表標異常,薪資照算 (法定 46 小時內合規的租戶用)
export const OvertimeBeyondCapSchema = z.enum(["settle_separately", "warn"]);
export type OvertimeBeyondCap = z.infer<typeof OvertimeBeyondCapSchema>;

// 加班設定：
//   rules             逐情境倍率規則 (見上)
//   rounding          加班分鐘取整 (省略 = DEFAULT_OVERTIME_ROUNDING)
//   mealBreak         用餐扣除 (省略 = DEFAULT_OVERTIME_MEAL_BREAK;null = 不扣)
//   dailyCapMinutes   單日加班上限 (分)。引擎**只回傳、不裁切**,由 API 拿來判異常。
//   monthlyAlertHours 月累計加班警示門檻 (小時),由小到大;同樣只供 API 判異常。
//   basis             加班起算基準 (省略 = regularHours)
//   monthlyCapHours   月加班上限 (小時;省略 = 40。法定 46)。送加班單時超過即標 beyond_cap;
//                     月表核准時超額依 beyondCap 處理。
//   beyondCap         超過上限的處理 (省略 = settle_separately)
const OvertimeSchema = z.object({
  rules: z.array(OvertimeRuleSchema),
  rounding: OvertimeRoundingSchema.optional(),
  mealBreak: OvertimeMealBreakSchema.nullable().optional(),
  dailyCapMinutes: z.number().int().positive().optional(),
  monthlyAlertHours: z.array(z.number().nonnegative()).optional(),
  basis: OvertimeBasisSchema.optional(),
  monthlyCapHours: z.number().positive().optional(),
  beyondCap: OvertimeBeyondCapSchema.optional(),
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
//   method              'monthly' 月薪 / 'by_attendance_days' 按出勤天數 /
//                       'hourly' 時薪 (工讀生/Part-time,C5;本俸=Σ工作分鐘÷60×時薪)
//   overtimeFlatHourly  若設定，加班一律以此固定時薪計 (覆蓋倍率制)
//   dailyRegularHours   每日正常工時 (超過即算加班;折算時薪用)。預設 8。
//   hourlyWageDivisor   時薪除數:員工未明示 hourlyWage 時,時薪 = 本薪 ÷ divisor
//                       (亞斯特：37000 ÷ 240 = 154.1667)。省略 = 240。
//                       ('hourly' 制不適用此推算,見 payroll-engine 的丟錯規則。)
//   requireApprovedSheet 結算薪資前是否要求出勤表已核准 (API 用;省略 = false)。
//   requireAnomalyAck   結算薪資前是否要求異常已確認 (API 用;省略 = true)。
const PayrollSchema = z.object({
  method: z.enum(["monthly", "by_attendance_days", "hourly"]),
  overtimeFlatHourly: z.number().optional(),
  dailyRegularHours: z.number().default(8),
  hourlyWageDivisor: z.number().positive().optional(),
  requireApprovedSheet: z.boolean().optional(),
  requireAnomalyAck: z.boolean().optional(),
});

// 勞健保投保級距表 (M12,2026-09-23):一組級距含生效日,勞保與健保各一串**由小到大**的
// 投保薪資級距金額 (例 labor: [28590, 28800, 30300, 31800, …])。HR 設定薪資未帶投保
// 薪資時,API 以 bracketFor() 自動選「≥ 基數的最小級距」(超過最高級距取最高;時薪制
// 基數 = 時薪 × 每週約定時數 × 52 ÷ 12)。整串可省略 = 不自動選。
// 生效日 (effectiveFrom 'YYYY-MM-DD') 供逐年調整:resolveInsuranceBrackets(rules, date)
// 取生效日 ≤ date 的最新一組,陣列順序不拘。
const InsuranceBracketSetSchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected 'YYYY-MM-DD'"),
  labor: z.array(z.number().positive()),
  health: z.array(z.number().positive()),
});
export type InsuranceBracketSet = z.infer<typeof InsuranceBracketSetSchema>;

// 勞健保自付額：以員工的投保薪資為基數。費率逐年調整，故放在租戶規則設定裡而非寫死。
//   labor.rate         勞保普通事故＋就保合計費率 (例 0.125)
//   labor.employeeShare 員工自付比例 (例 0.2)
//   health.rate        健保費率 (例 0.0517)
//   health.employeeShare 員工自付比例 (例 0.3)
//   brackets           投保級距表 (含生效日;見上。省略 = 不自動選級距)
// 整段可省略；省略時不計保費（引擎回 0），既有租戶設定不會因此解析失敗。
const InsuranceSchema = z
  .object({
    labor: z.object({ rate: z.number(), employeeShare: z.number() }),
    health: z.object({ rate: z.number(), employeeShare: z.number() }),
    brackets: z.array(InsuranceBracketSetSchema).optional(),
  })
  .optional();

// 特休週年制 (W1,2026-09-23):特休桶以**到職日週年**為期間,由年度給假排程自動發放。
//   annualLeaveBasis      'anniversary' 週年制 (預設) / 'calendar' 曆年制 (排程只 skip,
//                         餘額桶維持 HR 手動)
//   annualLeaveTable      年資→天數表 [{minMonths, days}] (預設勞基法 §38:滿 6 個月 3 天、
//                         1 年 7、2 年 10、3 年 14、5 年 15、10 年 16);以「日」設定,發放時
//                         × payroll.dailyRegularHours 轉小時 (leave_balances 是小時)
//   annualLeaveIncrement  滿 afterMonths 後每滿一年 +perYearDays,上限 maxDays
//                         (預設 10 年後每年 +1、最多 30)
//   annualLeaveTypeCode   特休對應的 leave_types.code (預設 'annual')
// 整段可省略 = 全部預設 (見 resolveAnnualLeavePolicy)。
const AnnualLeaveTierSchema = z.object({
  minMonths: z.number().int().nonnegative(),
  days: z.number().nonnegative(),
});
export type AnnualLeaveTier = z.infer<typeof AnnualLeaveTierSchema>;

const AnnualLeaveIncrementSchema = z.object({
  afterMonths: z.number().int().nonnegative(),
  perYearDays: z.number().nonnegative(),
  maxDays: z.number().nonnegative(),
});
export type AnnualLeaveIncrement = z.infer<typeof AnnualLeaveIncrementSchema>;

export const AnnualLeaveBasisSchema = z.enum(["anniversary", "calendar"]);
export type AnnualLeaveBasis = z.infer<typeof AnnualLeaveBasisSchema>;

const LeaveSchema = z
  .object({
    annualLeaveBasis: AnnualLeaveBasisSchema.optional(),
    annualLeaveTable: z.array(AnnualLeaveTierSchema).optional(),
    annualLeaveIncrement: AnnualLeaveIncrementSchema.optional(),
    annualLeaveTypeCode: z.string().trim().min(1).optional(),
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
  leave: LeaveSchema,
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

/* ------------------------------------ 2026-09-23 需求補齊:加班上限/特休/級距 ----- */

export const DEFAULT_OVERTIME_BASIS: OvertimeBasis = "regularHours";
/** 月加班上限 (小時);業主決策 2:預設 40,法定 46。 */
export const DEFAULT_OVERTIME_MONTHLY_CAP_HOURS = 40;
export const DEFAULT_OVERTIME_BEYOND_CAP: OvertimeBeyondCap = "settle_separately";
export const DEFAULT_ANNUAL_LEAVE_BASIS: AnnualLeaveBasis = "anniversary";
/** 勞基法 §38 年資→特休天數 (以「日」計)。 */
export const DEFAULT_ANNUAL_LEAVE_TABLE: readonly AnnualLeaveTier[] = [
  { minMonths: 6, days: 3 },
  { minMonths: 12, days: 7 },
  { minMonths: 24, days: 10 },
  { minMonths: 36, days: 14 },
  { minMonths: 60, days: 15 },
  { minMonths: 120, days: 16 },
];
/** 滿 10 年後每滿一年 +1 日,上限 30 日 (勞基法 §38 ①六)。 */
export const DEFAULT_ANNUAL_LEAVE_INCREMENT: AnnualLeaveIncrement = {
  afterMonths: 120,
  perYearDays: 1,
  maxDays: 30,
};
export const DEFAULT_ANNUAL_LEAVE_TYPE_CODE = "annual";

/** 加班起算基準 (省略 → regularHours)。 */
export function resolveOvertimeBasis(rules: RuleConfig): OvertimeBasis {
  return rules.overtime.basis ?? DEFAULT_OVERTIME_BASIS;
}

/** 月加班上限 (小時;省略 → 40)。 */
export function resolveOvertimeMonthlyCapHours(rules: RuleConfig): number {
  return rules.overtime.monthlyCapHours ?? DEFAULT_OVERTIME_MONTHLY_CAP_HOURS;
}

/** 超過月上限的處理 (省略 → settle_separately)。 */
export function resolveOvertimeBeyondCap(rules: RuleConfig): OvertimeBeyondCap {
  return rules.overtime.beyondCap ?? DEFAULT_OVERTIME_BEYOND_CAP;
}

export interface AnnualLeavePolicy {
  basis: AnnualLeaveBasis;
  /** 已依 minMonths 升冪排序 (設定端不必排)。 */
  table: readonly AnnualLeaveTier[];
  increment: AnnualLeaveIncrement;
  typeCode: string;
}

/** 特休政策 (每個鍵各自補預設;table 依 minMonths 升冪)。 */
export function resolveAnnualLeavePolicy(rules: RuleConfig): AnnualLeavePolicy {
  const leave = rules.leave;
  const table = [...(leave?.annualLeaveTable ?? DEFAULT_ANNUAL_LEAVE_TABLE)].sort(
    (a, b) => a.minMonths - b.minMonths,
  );
  return {
    basis: leave?.annualLeaveBasis ?? DEFAULT_ANNUAL_LEAVE_BASIS,
    table,
    increment: leave?.annualLeaveIncrement ?? DEFAULT_ANNUAL_LEAVE_INCREMENT,
    typeCode: leave?.annualLeaveTypeCode ?? DEFAULT_ANNUAL_LEAVE_TYPE_CODE,
  };
}

/**
 * 某日適用的投保級距表:生效日 ≤ date ('YYYY-MM-DD') 的最新一組 (陣列順序不拘);
 * 沒設定、或全部都晚於 date → null (＝不自動選級距)。
 */
export function resolveInsuranceBrackets(rules: RuleConfig, date: string): InsuranceBracketSet | null {
  const sets = rules.insurance?.brackets;
  if (!sets || sets.length === 0) return null;
  let picked: InsuranceBracketSet | null = null;
  for (const s of sets) {
    if (s.effectiveFrom > date) continue;
    if (!picked || s.effectiveFrom > picked.effectiveFrom) picked = s;
  }
  return picked;
}

/**
 * 純函式:基數 → 級距 (≥ amount 的最小級距;超過最高級距取最高;空清單 → null)。
 * 30,300 → 30,300;30,301 → 31,800 (勞保級距表);清單順序不拘。
 */
export function bracketFor(amount: number, list: readonly number[]): number | null {
  const sorted = list.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  for (const v of sorted) if (v >= amount) return v;
  return sorted[sorted.length - 1];
}
