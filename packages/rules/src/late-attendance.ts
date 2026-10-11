/**
 * late-attendance — 遲到說明 × 全勤 (2026-10-11 業主拍板),純函式、無 IO。
 *
 * 遲到一律要填理由 (late_reports,一人一天一筆),老闆逐筆決定這次遲到「影響全勤」
 * (affects) 或「不影響全勤」(exempt);**沒決定視為影響**。payroll-engine 算全勤獎金的
 * 累計遲到分鐘時略過 exempt 的那幾天 (AttendanceDay.lateExempt),其餘照舊套階梯。
 *
 * 這裡回答「某員某月是否因遲到失去全勤，以及還有幾筆沒決定」:
 *   countingLateMinutes = 當月逐日遲到分鐘 (attendance_days,與薪資同一份) 扣掉 exempt 的日子
 *   失去全勤 = 有給階梯 → 依階梯扣款 > 0;沒給 → countingLateMinutes > 0
 */

import { resolveAttendanceDeduction } from "./payroll-engine.js";
import type { RuleConfig } from "./rules-schema.js";

export type LateDecision = "affects" | "exempt" | null;

export interface LateReportLike {
  /** 'YYYY-MM-DD' (租戶時區的上班日)。 */
  workDate: string;
  lateMinutes: number;
  decision: LateDecision;
}

export interface LateAttendanceStatus {
  /** 遲到說明筆數。 */
  reportCount: number;
  affectsCount: number;
  exemptCount: number;
  /**
   * 老闆尚未決定的筆數 (視為影響全勤)。有給 days 時只算「那天現在仍有遲到」的
   * (事後補核准請假、或打卡沒寫成的那筆不再算)。
   */
  undecidedCount: number;
  /** 老闆決定不影響全勤的日期 (給 AttendanceDay.lateExempt)。 */
  exemptDates: string[];
  /** 計入全勤的累計遲到分鐘 (exempt 的日子不算)。 */
  countingLateMinutes: number;
  /** 依階梯算出的全勤扣款 (沒給 tiers → null)。 */
  attendanceDeduction: number | null;
  /** 是否因遲到失去 (部分) 全勤。 */
  losesFullAttendance: boolean;
}

/** 有沒有決定都正規化成三態;不認得的值當「沒決定」(= 影響)。 */
export function normalizeLateDecision(value: unknown): LateDecision {
  return value === "affects" || value === "exempt" ? value : null;
}

export function lateAttendanceStatus(input: {
  /** 當月逐日遲到分鐘 (attendance_days 或月表快照);省略 → 改用遲到說明的分鐘。 */
  days?: ReadonlyArray<{ date: string; lateMinutes: number }>;
  reports: ReadonlyArray<LateReportLike>;
  tiers?: RuleConfig["attendance_bonus"]["tiers"];
}): LateAttendanceStatus {
  const exempt = new Set<string>();
  const stillLate = input.days
    ? new Set(input.days.filter((d) => (Number(d.lateMinutes) || 0) > 0).map((d) => d.date))
    : null;
  let affectsCount = 0;
  let exemptCount = 0;
  let undecidedCount = 0;
  for (const r of input.reports) {
    const decision = normalizeLateDecision(r.decision);
    if (decision === "exempt") {
      exemptCount += 1;
      exempt.add(r.workDate);
    } else if (decision === "affects") {
      affectsCount += 1;
    } else if (!stillLate || stillLate.has(r.workDate)) {
      undecidedCount += 1;
    }
  }
  const lateByDate: Array<{ date: string; lateMinutes: number }> = input.days
    ? [...input.days]
    : input.reports.map((r) => ({ date: r.workDate, lateMinutes: r.lateMinutes }));
  const countingLateMinutes = lateByDate.reduce(
    (acc, d) => acc + (exempt.has(d.date) ? 0 : Math.max(0, Number(d.lateMinutes) || 0)),
    0,
  );
  const attendanceDeduction = input.tiers ? resolveAttendanceDeduction(countingLateMinutes, input.tiers) : null;
  return {
    reportCount: input.reports.length,
    affectsCount,
    exemptCount,
    undecidedCount,
    exemptDates: [...exempt].sort(),
    countingLateMinutes,
    attendanceDeduction,
    losesFullAttendance: attendanceDeduction === null ? countingLateMinutes > 0 : attendanceDeduction > 0,
  };
}

/** 薪資試算的提醒字樣 (HR 看):有未決定才回字串。 */
export function undecidedLateWarning(undecidedCount: number): string | null {
  return undecidedCount > 0 ? `${undecidedCount} 筆遲到說明老闆尚未決定（視為影響全勤）` : null;
}
