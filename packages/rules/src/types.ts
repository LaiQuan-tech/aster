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

export interface DayContext {
  /** ISO date 'YYYY-MM-DD' — 用來定位這天 (純標籤，不參與工時運算)。 */
  date: string;
  dayType: DayType;
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
  /** 超過 dailyRegularHours 的加班分鐘。 */
  overtimeMinutes: number;
  /** 落在 night.window 內的分鐘 (可與 overtime 重疊)。 */
  nightMinutes: number;
  dayType: DayType;
}

/** 計薪方式 (與 RuleConfig.payroll.method 對齊)。 */
export type PayrollMethod = "monthly" | "by_attendance_days";

/**
 * 員工的薪資結構。hourlyWage 為加班/夜間折算的基準時薪 (必填)。
 * baseSalary 供月薪制本俸;dailyWage 供按出勤天數制本俸。
 * method 若提供則覆蓋 rules.payroll.method (允許個別員工不同制)。
 */
export interface SalaryStructure {
  method?: PayrollMethod;
  baseSalary?: number;
  dailyWage?: number;
  hourlyWage: number;
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
  /** 應扣合計 = 勞保 + 健保 + 自願提繳 + 預支 (正值)。 */
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
