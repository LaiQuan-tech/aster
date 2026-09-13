/**
 * tw-tax — 純函式：台灣薪資相關法規計算（二代健保補充保費、薪資所得扣繳、
 * 健保費本人+眷屬負擔）。無 IO。
 *
 * 設計原則：**費率與門檻一律由參數傳入**（來自租戶設定 / 年度公告），本模組只負責
 * 算術，不把會逐年變動的法定數字寫死，避免過時。所有金額四捨五入到「元」。
 */

function round(n: number): number {
  return Math.round(n)
}

/* -------------------------------------------------- 二代健保補充保費 ----- */

/** 補充保費費率預設值（2021 起 2.11%）。實務上以租戶設定覆寫。 */
export const DEFAULT_SUPPLEMENTARY_NHI_RATE = 0.0211

/** 高額獎金補充保費的免扣門檻倍數：年度累計獎金超過投保金額 4 倍的部分才計費。 */
export const BONUS_MULTIPLE_THRESHOLD = 4

/** 其他類所得（兼職/執行業務/利息/租金/股利…）單筆最低計費門檻（元）。 */
export const OTHER_INCOME_MIN = 20_000

/* ---------------------------------------------------------- 勞退自提 ----- */

/**
 * 勞工自願提繳退休金比例上限：勞工退休金條例 §14 III「於每月工資 6% 範圍內」。
 * 只用來擋輸入（API 驗證），不參與計算；計算在 payroll-engine 以員工設定的比例乘投保薪資。
 */
export const PENSION_VOLUNTARY_RATE_MAX = 0.06

/**
 * 高額獎金的補充保費。年度累計獎金超過「投保金額 × 4」的部分，按費率計收；只針對
 * 「本次」落在門檻以上的金額計費（先前已累計的不重複計）。
 *
 * @param monthlyInsuredSalary 月投保金額
 * @param cumulativeBonusBefore 本次之前的年度累計獎金
 * @param thisBonus 本次發放獎金
 * @returns 本次應扣補充保費（元，四捨五入）
 */
export function bonusSupplementaryPremium(
  monthlyInsuredSalary: number,
  cumulativeBonusBefore: number,
  thisBonus: number,
  rate: number = DEFAULT_SUPPLEMENTARY_NHI_RATE,
): number {
  if (thisBonus <= 0 || monthlyInsuredSalary <= 0) return 0
  const threshold = monthlyInsuredSalary * BONUS_MULTIPLE_THRESHOLD
  const cumulativeAfter = cumulativeBonusBefore + thisBonus
  if (cumulativeAfter <= threshold) return 0
  // 只對「本次」超過門檻的部分計費。
  const alreadyOver = Math.max(0, cumulativeBonusBefore - threshold)
  const totalOver = cumulativeAfter - threshold
  const thisOver = totalOver - alreadyOver
  return round(thisOver * rate)
}

/**
 * 其他類所得（兼職薪資、執行業務所得、利息、租金、股利、退職所得等）的補充保費。
 * 單筆給付達門檻（預設 NT$20,000）才計費，否則為 0。
 */
export function otherIncomeSupplementaryPremium(
  amount: number,
  rate: number = DEFAULT_SUPPLEMENTARY_NHI_RATE,
  minThreshold: number = OTHER_INCOME_MIN,
): number {
  if (amount < minThreshold) return 0
  return round(amount * rate)
}

/* ------------------------------------------------------- 薪資所得扣繳 ----- */

/**
 * 薪資所得扣繳（定率法）：全月給付總額達起扣門檻時，按固定費率（預設 5%）扣繳；
 * 未達門檻不扣。門檻與費率由呼叫端提供（年度公告）。
 */
export function salaryWithholdingFixedRate(
  monthlyPayment: number,
  opts: { rate?: number; threshold?: number } = {},
): number {
  const rate = opts.rate ?? 0.05
  const threshold = opts.threshold ?? 0
  if (monthlyPayment <= threshold) return 0
  return round(monthlyPayment * rate)
}

/**
 * 非居住者（非中華民國境內居住之個人）扣繳：一律按給付總額定率扣繳（薪資預設 18%）。
 */
export function nonResidentWithholding(amount: number, rate: number = 0.18): number {
  if (amount <= 0) return 0
  return round(amount * rate)
}

/* ----------------------------------------------- 健保費（本人 + 眷屬） ----- */

/** 健保眷屬計費口數上限：超過 3 口以 3 口計（第 4 口起免繳）。 */
export const NHI_MAX_DEPENDENTS = 3

/**
 * 受僱者健保自付額 = 投保金額 × 費率 × 自付比例 ×（1 + 計費眷口數）。
 * 眷口數超過 3 以 3 計。
 *
 * @param insuredSalary 投保金額
 * @param dependents 眷屬人數
 * @param rate 健保費率（如 0.0517）
 * @param employeeShareRatio 受僱者自付比例（如 0.3）
 */
export function nhiEmployeePremium(
  insuredSalary: number,
  dependents: number,
  rate: number,
  employeeShareRatio: number,
): number {
  if (insuredSalary <= 0) return 0
  const billableDependents = Math.min(Math.max(0, Math.floor(dependents)), NHI_MAX_DEPENDENTS)
  const perPerson = insuredSalary * rate * employeeShareRatio
  return round(perPerson * (1 + billableDependents))
}
