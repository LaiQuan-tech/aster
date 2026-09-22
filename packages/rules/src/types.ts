/**
 * Domain types for the worktime + payroll engines.
 *
 * These are plain data shapes (no IO). Dates may be supplied either as native
 * `Date` objects or ISO-8601 strings; the engines normalise on the way in.
 */

import type { OvertimeWhen } from "./rules-schema.js";

/** A single in/out punch pair for one working day. */
export interface PunchPair {
  inAt: Date | string;
  outAt: Date | string;
}

/**
 * 班別定義。start/end 為 'HH:MM'。end < start 視為跨日班 (e.g. 22:00→06:00)。
 * breakMinutes 為不計薪的休息時間。isNightShift 純標記用 (引擎以 night.window
 * 重疊計算夜間時數，不依賴此旗標)。
 */
export interface ShiftDef {
  start: string;
  end: string;
  breakMinutes: number;
  isNightShift?: boolean;
}

/** 該日屬性 (例假/固定假由呼叫端判定，引擎不需國定假日表)。 */
export type DayType = "workday" | "rest_day" | "fixed_holiday";

/** DayType → 加班規則 when 的對應 (閉集合;worktime 與 payroll 兩個引擎共用)。 */
export const DAY_TYPE_TO_OVERTIME_WHEN: Record<DayType, OvertimeWhen> = {
  workday: "weekday_ot",
  rest_day: "rest_day",
  fixed_holiday: "fixed_holiday",
};

export interface DayContext {
  /** ISO date 'YYYY-MM-DD' — 用來定位這天 (純標籤，不參與工時運算)。 */
  date: string;
  dayType: DayType;
  /**
   * W9 加班起算基準：這一天的「正常工時分鐘」。省略 = `payroll.dailyRegularHours
   * × 60`（法定 8 小時，`overtime.basis='regularHours'` 的行為）。
   * `overtime.basis='shift'` 時由呼叫端填「班表淨工時」(span − breakMinutes)，
   * 例如 14:00–22:00 休 60 分的班 → 420：做到 23:00 (淨 480) 就有 60 分加班，
   * 而不是照 8 小時算成 0。無排班的日子呼叫端仍應留空（退回法定 8 小時）。
   */
  regularMinutes?: number;
}

/**
 * 當日一筆請假 (由呼叫端自假單/假別主檔帶入,引擎不判假別)。
 *   code       假別代碼 (sick / personal / …),同 code 多筆在薪資單合併成一條
 *   minutes    請假分鐘
 *   deductRate 扣薪比例 0–1 (1 = 全扣、0.5 = 半薪、0 = 不扣薪但仍記錄)
 */
export interface LeaveEntry {
  code: string;
  minutes: number;
  deductRate: number;
}

/**
 * 一天結算後的出勤結果 (worktime-engine 的輸出、payroll-engine 的輸入)。
 * 所有時間單位皆為「分鐘」。
 */
export interface AttendanceDay {
  date: string;
  /** 實際工時 = 在班時間 − 休息;不含休息分鐘。 */
  workedMinutes: number;
  /** 遲到分鐘 (相對班表 start;早到為 0)。 */
  lateMinutes: number;
  /** 早退分鐘 (相對班表 end;晚走為 0;rest_day / fixed_holiday 一律 0)。 */
  earlyLeaveMinutes?: number;
  /**
   * 當日加班分鐘 (計薪用)。worktime-engine 的輸出已經過
   * 用餐扣除 → 取整 → 最低分鐘 → 保底時數 的管線;人工覆寫請直接改這欄。
   */
  overtimeMinutes: number;
  /**
   * 稽核用：系統算出的加班分鐘 (覆寫前的值)。worktime-engine 輸出時恆等於
   * overtimeMinutes;人工覆寫 overtimeMinutes 後兩者即出現差異。
   */
  overtimeMinutesComputed?: number;
  /** 落在 night.window 內的分鐘 (可與 overtime 重疊)。 */
  nightMinutes: number;
  /** 當日請假 (呼叫端帶入;payroll-engine 據此算請假扣款)。 */
  leaves?: LeaveEntry[];
  dayType: DayType;
}

/** 計薪方式 (與 RuleConfig.payroll.method 對齊)。 */
export type PayrollMethod = "monthly" | "by_attendance_days" | "hourly";

/**
 * 員工的薪資結構。
 * hourlyWage 為加班/夜間/請假扣款折算的基準時薪;可省略 (或給 0),此時引擎以
 * baseSalary ÷ rules.payroll.hourlyWageDivisor 推算 (預設 ÷ 240)。兩者都沒有
 * 就無法折算 → computePayslip 丟錯。
 * baseSalary 供月薪制本俸;dailyWage 供按出勤天數制本俸。
 * method='hourly'(工讀生/Part-time,C5) 時 hourlyWage 兼作本俸基準:
 * 本俸 = Σ當月 (workedMinutes − overtimeMinutes) ÷ 60 × hourlyWage,加班/假日
 * 段只走加班費倍率一次;請假與遲到早退不另扣 (那些分鐘本俸沒付過)。此制不接受
 * 用 baseSalary ÷ divisor 反推時薪——未明示 hourlyWage(>0) 直接丟錯,不猜。
 * method 若提供則覆蓋 rules.payroll.method (允許個別員工不同制)。
 */
export interface SalaryStructure {
  method?: PayrollMethod;
  baseSalary?: number;
  dailyWage?: number;
  hourlyWage?: number;
  /** 勞保投保薪資 (已套級距的金額);未提供則不計勞保自付額。 */
  laborInsuredSalary?: number;
  /** 健保投保金額;未提供則不計健保自付額。 */
  healthInsuredSalary?: number;
  /** 健保眷屬人數 (本人不計);健保自付額 = 費率 × 自付比例 × (1 + 眷屬數)。 */
  nhiDependents?: number;
  /** 勞工自願提繳退休金比例 (0–0.06);以勞保投保薪資為基數。 */
  pensionVoluntaryRate?: number;
  /** 本期預支金額 (扣項)。 */
  advance?: number;
}

/** 薪資單逐項。amount 正為加項、負為扣項。 */
export interface PayslipLine {
  label: string;
  amount: number;
}

/**
 * 薪資單明細 (payroll-engine 的輸出)。所有欄位為金額。
 * gross = base + overtimePay + nightPay + attendanceBonus + allowances
 *         − attendanceDeduction
 * (attendanceDeduction 以正值表示扣了多少;已反映在 gross)。
 *
 * 注意 allowances 與 expenses 的差別 —— 兩者稅務性質相反,不可互換:
 *   • allowances 定額補貼 → **屬薪資所得**,進 gross,應計入投保薪資
 *   • expenses   實報實銷 → 非所得,不進 gross,直接加在實發
 */
export interface PayslipBreakdown {
  /** 本俸 (月薪 baseSalary 或 出勤天數×dailyWage)。 */
  base: number;
  /** 與 base 同義的別名,保留供報表使用。 */
  regularPay?: number;
  /**
   * 本次計算實際採用的基準時薪:員工明示的 hourlyWage,或 baseSalary ÷
   * hourlyWageDivisor (四捨五入到小數 4 位,例 37000 ÷ 240 = 154.1667)。
   */
  hourlyWage: number;
  /** 加班費現金總額 (compTime 的部分不計入此)。 */
  overtimePay: number;
  /** 夜間加給總額。 */
  nightPay: number;
  /** 全勤獎金實發 (base 扣掉階梯扣款後的全勤項;見 attendanceDeduction)。 */
  attendanceBonus: number;
  /** 全勤獎金被扣的金額 (正值)。 */
  attendanceDeduction: number;
  /** 定額補貼合計 (屬薪資所得,已計入 gross;見本介面開頭說明)。 */
  allowances: number;
  /** 轉補休的加班時數 (compTime=true 的規則;不發現金,僅供 ledger)。 */
  compTimeMinutes: number;
  /** 應發合計。 */
  gross: number;
  /** 加班費按加班別×倍率分段的逐段明細 (供薪資明細表逐列呈現)。 */
  overtimeSegments: OvertimeSegment[];
  /** 勞保自付額 (正值)。 */
  laborInsurance: number;
  /** 健保自付額 (正值)。 */
  healthInsurance: number;
  /** 勞工自願提繳退休金 (正值)。 */
  pensionVoluntary: number;
  /** 本期預支 (正值)。 */
  advance: number;
  /** 請假扣款 (正值) = Σ 請假分鐘 ÷ 60 × 時薪 × deductRate。 */
  leaveDeduction: number;
  /**
   * 遲到早退扣款 (正值) = Σ(遲到 + 早退分鐘) ÷ 60 × 時薪;
   * 僅 rules.leave_deduction.lateEarly.enabled 時計,否則 0。
   */
  lateEarlyDeduction: number;
  /** 應扣合計 = 勞保 + 健保 + 自願提繳 + 預支 + 請假扣款 + 遲到早退扣款 (正值)。 */
  totalDeductions: number;
  /** 員工代墊支出 (加項;不計入 gross,直接加在實發)。 */
  expenses: number;
  /** 實發金額 = gross − totalDeductions + expenses。 */
  net: number;
  /** 逐項稽核明細。 */
  lines: PayslipLine[];
}

/** 加班費的一個分段 (例:平日前 2 小時 1.334 倍)。 */
export interface OvertimeSegment {
  /** 加班別 (對應 RuleConfig.overtime.rules[].when)。 */
  when: OvertimeWhen;
  /** 該段倍率。 */
  multiplier: number;
  /** 該段時數 (小時)。 */
  hours: number;
  /** 該段金額。 */
  amount: number;
}
