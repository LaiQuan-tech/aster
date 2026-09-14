/**
 * payroll-engine — 純函式。把一個月的 AttendanceDay[] + 員工薪資結構 + 規則,
 * 結算成可稽核的 PayslipBreakdown。無 IO。
 *
 * gross = 本俸 + 加班費 + 夜間加給 + 全勤獎金(已淨額化:base − 階梯扣款) + 定額補貼。
 * net   = gross − 應扣(勞保/健保/自願提繳/預支/請假扣款/遲到早退扣款) + 代墊支出。
 *
 * 時薪:員工明示 hourlyWage (>0) 優先;否則 本薪 ÷ payroll.hourlyWageDivisor
 * (預設 240,四捨五入到小數 4 位;亞斯特 37000 ÷ 240 = 154.1667)。
 *
 * 代墊支出刻意不進 gross:那是代收代付、非薪資所得,課稅基礎不同。
 */

import { nhiEmployeePremium } from "./tw-tax.js";
import {
  resolveHourlyWageDivisor,
  resolveLateEarlyDeductionEnabled,
  type OvertimeWhen,
  type RuleConfig,
} from "./rules-schema.js";
import {
  DAY_TYPE_TO_OVERTIME_WHEN,
  type AttendanceDay,
  type OvertimeSegment,
  type PayrollMethod,
  type PayslipBreakdown,
  type PayslipLine,
  type SalaryStructure,
} from "./types.js";

/**
 * 四捨五入到「分」(小數 2 位) 以消除浮點殘差,同時保留客戶既有薪資表的精度 ——
 * 該表的加班費/應發/實發都帶小數(例 47533.50),若在此就進位到整數元會與其歷史
 * 數字產生數角落差。要不要在發放時進位到整數元,是呈現層/付款層的決定。
 */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 時薪專用:四捨五入到小數 4 位 (客戶薪資表「平日每小時工資額」的精度)。 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * 決定本次計算的基準時薪:員工明示的 hourlyWage (>0) 優先;否則以月薪本俸 ÷
 * hourlyWageDivisor 推算。兩者都沒有就無法折算加班/夜間/請假 → 丟錯,不猜。
 * (API 層對沒填時薪的員工會傳 0 進來,所以 0 視同「未明示」。)
 */
function resolveHourlyWage(salary: SalaryStructure, rules: RuleConfig): number {
  if (salary.hourlyWage !== undefined && salary.hourlyWage > 0) return salary.hourlyWage;
  if (salary.baseSalary !== undefined && salary.baseSalary > 0) {
    return round4(salary.baseSalary / resolveHourlyWageDivisor(rules));
  }
  throw new Error("payroll-engine: hourlyWage or baseSalary required");
}

/**
 * 保費專用:勞保局/健保署的保費是以「整數元」計收,不留小數。
 * 例 38,200 × 5.17% × 30% = 592.482 → 實際扣 592。
 */
function roundYuan(n: number): number {
  return Math.round(n);
}

/**
 * 全勤獎金:以「全月累計遲到分鐘」套階梯。tiers 由小到大,取第一個
 * lateMinutesUpTo === null(封頂) 或 totalLate <= lateMinutesUpTo 的階。
 * 回傳該階扣款 (找不到任何階則扣 0)。
 */
function resolveAttendanceDeduction(
  totalLateMinutes: number,
  tiers: RuleConfig["attendance_bonus"]["tiers"],
): number {
  for (const tier of tiers) {
    if (tier.lateMinutesUpTo === null || totalLateMinutes <= tier.lateMinutesUpTo) {
      return tier.deduct;
    }
  }
  return 0;
}

export function computePayslip(
  days: AttendanceDay[],
  salary: SalaryStructure,
  rules: RuleConfig,
  /** 本期核准的員工代墊支出合計 (加項)。預設 0。 */
  expenses = 0,
  /**
   * 本期定額補貼合計 (油錢補貼這類「每月固定 X 元、不論實花」的給付)。
   * 預設 0。
   *
   * **與 expenses 稅務性質相反,不可互換**:定額補貼屬薪資所得
   * (所得稅法 §14 第 1 類含各種補助費),要進 gross、要併入扣繳、
   * 且應計入勞健保投保薪資。把它當代墊支出處理 = 不課稅 + 不計保
   * = 漏報薪資所得 + 高薪低報。
   *
   * 註:本函式不會因為補貼而自動調整保費 —— 投保薪資是另行申報的級距,
   * 不是從當月 gross 推算的。補貼是否使該員需重新申報投保薪資,
   * 由呼叫端依投保級距表判斷 (該表尚未匯入,見帳本待辦)。
   */
  allowances = 0,
): PayslipBreakdown {
  const method: PayrollMethod = salary.method ?? rules.payroll.method;
  const hourlyWage = resolveHourlyWage(salary, rules);
  const flatHourly = rules.payroll.overtimeFlatHourly;

  // --- 本俸 -------------------------------------------------------------
  // 出勤天數 = 當天有實際工時的天數。
  const attendanceDays = days.filter((d) => d.workedMinutes > 0).length;
  const base =
    method === "by_attendance_days"
      ? round(attendanceDays * (salary.dailyWage ?? 0))
      : round(salary.baseSalary ?? 0);

  // --- 加班費 / 補休 -----------------------------------------------------
  // 分段倍率是「逐日」套用的:勞基法的前 2 小時是指「當日」前 2 小時,不是當月。
  // 各日同 (when, multiplier) 的段會在最後合併成 overtimeSegments 供明細表列印。
  let overtimePay = 0;
  let compTimeMinutes = 0;
  const segmentAcc = new Map<string, OvertimeSegment>();

  const addSegment = (when: OvertimeWhen, multiplier: number, hours: number, amount: number) => {
    if (hours <= 0) return;
    const key = `${when}@${multiplier}`;
    const prev = segmentAcc.get(key);
    if (prev) {
      prev.hours += hours;
      prev.amount += amount;
    } else {
      segmentAcc.set(key, { when, multiplier, hours, amount });
    }
  };

  for (const day of days) {
    if (day.overtimeMinutes <= 0) continue;
    const when = DAY_TYPE_TO_OVERTIME_WHEN[day.dayType];
    const rule = rules.overtime.rules.find((r) => r.when === when);
    if (!rule) continue; // 無對應規則 → 不計加班(亦不補休)
    if (rule.compTime) {
      compTimeMinutes += day.overtimeMinutes; // 轉補休,不發現金
      continue;
    }
    const hours = day.overtimeMinutes / 60;

    // 固定時薪制(若設定)覆蓋一切倍率設定。
    if (flatHourly !== undefined) {
      const amount = hours * flatHourly;
      overtimePay += amount;
      addSegment(when, 1, hours, amount);
      continue;
    }

    if (!rule.tiers) {
      const amount = hours * hourlyWage * rule.multiplier;
      overtimePay += amount;
      addSegment(when, rule.multiplier, hours, amount);
      continue;
    }

    // 累進分段:uptoHours 是「累計」上限,最後一段可省略代表無上限。
    let remaining = hours;
    let consumed = 0;
    for (const tier of rule.tiers) {
      if (remaining <= 0) break;
      const cap = tier.uptoHours ?? Infinity;
      const segHours = Math.min(remaining, cap - consumed);
      if (segHours <= 0) continue; // 這段的額度已被前面用完
      const amount = segHours * hourlyWage * tier.multiplier;
      overtimePay += amount;
      addSegment(when, tier.multiplier, segHours, amount);
      remaining -= segHours;
      consumed += segHours;
    }
  }
  overtimePay = round(overtimePay);
  const overtimeSegments = [...segmentAcc.values()].map((s) => ({
    ...s,
    amount: round(s.amount),
  }));

  // --- 夜間加給 ----------------------------------------------------------
  const totalNightMinutes = days.reduce((acc, d) => acc + d.nightMinutes, 0);
  const nightPay = round(
    (totalNightMinutes / 60) * hourlyWage * rules.night.multiplier,
  );

  // --- 全勤獎金 (全月累計遲到 → 階梯扣款,從 base 扣) ----------------------
  const totalLateMinutes = days.reduce((acc, d) => acc + d.lateMinutes, 0);
  const bonusBase = rules.attendance_bonus.base;
  const attendanceDeduction = resolveAttendanceDeduction(
    totalLateMinutes,
    rules.attendance_bonus.tiers,
  );
  const attendanceBonus = bonusBase - attendanceDeduction;

  // --- gross + 逐項稽核明細 ---------------------------------------------
  const lines: PayslipLine[] = [
    { label: method === "by_attendance_days" ? "本俸(出勤天數)" : "本俸(月薪)", amount: base },
  ];
  if (overtimePay !== 0) lines.push({ label: "加班費", amount: overtimePay });
  if (nightPay !== 0) lines.push({ label: "夜間加給", amount: nightPay });
  // 全勤以「基準 − 扣款」兩條呈現,淨額即 attendanceBonus,且 lines 加總 = gross。
  lines.push({ label: "全勤獎金(基準)", amount: bonusBase });
  if (attendanceDeduction !== 0) {
    lines.push({ label: "全勤遲到扣款", amount: -attendanceDeduction });
  }

  // 定額補貼屬薪資所得,進 gross (與 expenses 的處理刻意不同,見參數說明)。
  const allowancesTotal = round(allowances);
  if (allowancesTotal !== 0) lines.push({ label: "定額補貼", amount: allowancesTotal });

  const gross = round(base + overtimePay + nightPay + attendanceBonus + allowancesTotal);

  // --- 請假扣款 / 遲到早退扣款 (扣項,不動 gross) ---------------------------
  // 請假扣款 = Σ 請假分鐘 ÷ 60 × 時薪 × deductRate;比例由呼叫端隨每筆帶入
  // (事假 1、病假 0.5…),同 code 合併成一條明細。總額以未取整的合計四捨五入到分,
  // 逐 code 明細各自取整後,若與總額差 1 分則調整最後一條,確保 lines 加總對得上。
  const leaveByCode = new Map<string, number>();
  let leaveRaw = 0;
  for (const day of days) {
    for (const leave of day.leaves ?? []) {
      const amount = (leave.minutes / 60) * hourlyWage * leave.deductRate;
      if (amount === 0) continue;
      leaveRaw += amount;
      leaveByCode.set(leave.code, (leaveByCode.get(leave.code) ?? 0) + amount);
    }
  }
  const leaveDeduction = round(leaveRaw);
  const leaveLines: PayslipLine[] = [];
  for (const [code, amount] of leaveByCode) {
    const rounded = round(amount);
    if (rounded === 0) continue; // 不足 1 分的碎數併進下方 drift 調整,不出空行
    leaveLines.push({ label: `請假扣款(${code})`, amount: -rounded });
  }
  if (leaveLines.length > 0) {
    const linesSum = round(leaveLines.reduce((acc, l) => acc + l.amount, 0));
    const drift = round(-leaveDeduction - linesSum);
    if (drift !== 0) {
      const last = leaveLines[leaveLines.length - 1]!;
      last.amount = round(last.amount + drift);
    }
  }

  // 遲到早退扣款 = Σ(遲到 + 早退分鐘) ÷ 60 × 時薪;只在規則開啟時計。
  // (與全勤階梯扣款是兩回事:那個扣的是全勤獎金,這個扣的是本俸。)
  const lateEarlyMinutes = days.reduce(
    (acc, d) => acc + d.lateMinutes + (d.earlyLeaveMinutes ?? 0),
    0,
  );
  const lateEarlyDeduction = resolveLateEarlyDeductionEnabled(rules)
    ? round((lateEarlyMinutes / 60) * hourlyWage)
    : 0;

  // --- 應扣項目 ----------------------------------------------------------
  // 保費以「投保薪資」為基數(非本俸)。缺任一設定就當 0,不臆測。
  const ins = rules.insurance;
  const laborInsurance =
    ins && salary.laborInsuredSalary
      ? roundYuan(salary.laborInsuredSalary * ins.labor.rate * ins.labor.employeeShare)
      : 0;
  // 健保自付額含眷屬:本人 + 計費眷口數。
  // 一律走 tw-tax 的 nhiEmployeePremium,那裡有健保法定的 3 口上限裁切
  // (第 4 口起免繳)。先前此處自行相乘且未裁切,與 tw-tax 兩份實作不一致——
  // 眷屬 4 口以上會多扣。裁切邏輯只留一份,避免再次分岔。
  const healthInsurance =
    ins && salary.healthInsuredSalary
      ? nhiEmployeePremium(
          salary.healthInsuredSalary,
          salary.nhiDependents ?? 0,
          ins.health.rate,
          ins.health.employeeShare,
        )
      : 0;
  const pensionVoluntary = roundYuan(
    (salary.laborInsuredSalary ?? 0) * (salary.pensionVoluntaryRate ?? 0),
  );
  const advance = round(salary.advance ?? 0);
  const totalDeductions = round(
    laborInsurance +
      healthInsurance +
      pensionVoluntary +
      advance +
      leaveDeduction +
      lateEarlyDeduction,
  );

  // 代墊支出是「代收代付」,不是薪資所得 → 不進 gross,直接加在實發。
  const expensesTotal = round(expenses);
  const net = round(gross - totalDeductions + expensesTotal);

  if (laborInsurance !== 0) lines.push({ label: "勞保費", amount: -laborInsurance });
  if (healthInsurance !== 0) lines.push({ label: "健保費", amount: -healthInsurance });
  if (pensionVoluntary !== 0)
    lines.push({ label: "勞工自願提繳退休金", amount: -pensionVoluntary });
  if (advance !== 0) lines.push({ label: "預支", amount: -advance });
  if (leaveDeduction !== 0) lines.push(...leaveLines);
  if (lateEarlyDeduction !== 0)
    lines.push({ label: "遲到早退扣款", amount: -lateEarlyDeduction });
  if (expensesTotal !== 0) lines.push({ label: "支出(代墊)", amount: expensesTotal });

  return {
    base,
    regularPay: base,
    hourlyWage,
    overtimePay,
    nightPay,
    attendanceBonus,
    attendanceDeduction,
    allowances: allowancesTotal,
    compTimeMinutes,
    gross,
    overtimeSegments,
    laborInsurance,
    healthInsurance,
    pensionVoluntary,
    advance,
    leaveDeduction,
    lateEarlyDeduction,
    totalDeductions,
    expenses: expensesTotal,
    net,
    lines,
  };
}
