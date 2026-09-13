/**
 * 分期請款的金額計算（模組四第 4 條）。
 *
 * 客戶原文：「輸入百分比後系統自動計算各期應收金額，嚴禁人工口算或
 * Excel 手動拉格」。痛點不是算不動，是**加總對不起來**：
 *
 *   合約 8,888,888 分 5 期每期 20%
 *     每期 8,888,888 × 20% = 1,777,777.6 → 四捨五入 1,777,778
 *     五期合計 8,888,890                  ← 比合約多 2 元
 *
 *   合約 3,000,000「各三分之一」
 *     33.33% 打不出三分之一 → 999,900 × 3 = 2,999,700  ← 短收 300
 *     使用者為了湊數把末期改成 33.34%                   ← 這就是手動拉格
 *
 * 所以**最後一期不按百分比算，而是「合約總額 − 前面各期合計」**，
 * 總和才必然等於合約金額，使用者也不必為了湊數去改百分比。
 */

/** 金額一律到「元」。工程請款不用角分，且四捨五入的尾差正是本模組要處理的。 */
function round(n: number): number {
  return Math.round(n)
}

export type InstallmentInput = {
  installmentNo: number
  /** 百分比，如 20 代表 20%。純人工金額的期別可為 null。 */
  percentage: number | null
  /** 人工覆寫金額；有值就以它為準，不參與試算。 */
  overrideAmount: number | null
  /** 已請款則凍結：本期不再重算，實際請款金額即為有效金額。 */
  billedAmount: number | null
  billed: boolean
}

export type InstallmentOutput = {
  installmentNo: number
  /** 系統試算金額。已請款或已覆寫的期別回 null（它們不由試算決定）。 */
  calculatedAmount: number | null
  /** 本期吸收的尾差。UI 要明示，不能讓人以為系統算錯。 */
  residueApplied: number
  /** 有效金額 = 已請款 ?? 人工覆寫 ?? 試算。 */
  effectiveAmount: number | null
}

export type ScheduleResult = {
  rows: InstallmentOutput[]
  /** 百分比合計。≠100 要在 UI 標示（但不擋存檔）。 */
  percentageTotal: number
  /** 各期有效金額合計。分母有值時應等於 contractTotal。 */
  effectiveTotal: number
  /**
   * 尾差無處可放時的餘額。
   * 所有期別都已請款或都被人工覆寫時會發生——**不靜默吞掉**，
   * 讓 UI 有東西可以顯示，否則那筆錢就消失了。
   */
  unallocatedResidue: number
}

/**
 * 算出各期金額。
 *
 * 規則：
 * 1. **沒有分母就不算**（合約總額為 null）——不猜。
 * 2. **已請款的期別不重算**：帳已經出去了，追加減不該讓它回頭變動。
 * 3. **人工覆寫的期別不重算**：那是談出來的金額，不是算出來的。
 * 4. 其餘期別 = round(合約總額 × 百分比)。
 * 5. **尾差落在最後一個「未請款且未覆寫」的期別**，讓合計等於合約總額。
 *    沒有這種期別時，尾差進 `unallocatedResidue`。
 *
 * 百分比刻意**永遠是合約總額的百分比**，不是「剩餘金額」的百分比：
 * 使用者打 20% 就該是合約的 20%。若因覆寫或實際請款金額不同而產生
 * 較大的尾差，那個差額明擺在最後一期上——那正是「你談的跟期程不一致」
 * 需要被看見的訊號，不該靠悄悄改動其他期別的百分比來抹平。
 */
export function computeInstallments(
  rows: InstallmentInput[],
  contractTotal: number | null,
): ScheduleResult {
  const sorted = [...rows].sort((a, b) => a.installmentNo - b.installmentNo)
  const percentageTotal = sorted.reduce((s, r) => s + (r.percentage ?? 0), 0)

  // 沒有分母就不試算——回傳已知的（已請款／已覆寫）金額即可。
  if (contractTotal === null || !Number.isFinite(contractTotal)) {
    const out = sorted.map((r) => ({
      installmentNo: r.installmentNo,
      calculatedAmount: null,
      residueApplied: 0,
      effectiveAmount: r.billed ? r.billedAmount : r.overrideAmount,
    }))
    return {
      rows: out,
      percentageTotal: roundPct(percentageTotal),
      effectiveTotal: out.reduce((s, r) => s + (r.effectiveAmount ?? 0), 0),
      unallocatedResidue: 0,
    }
  }

  const out: InstallmentOutput[] = sorted.map((r) => {
    if (r.billed) {
      return {
        installmentNo: r.installmentNo,
        calculatedAmount: null,
        residueApplied: 0,
        effectiveAmount: r.billedAmount ?? 0,
      }
    }
    if (r.overrideAmount !== null) {
      return {
        installmentNo: r.installmentNo,
        calculatedAmount: null,
        residueApplied: 0,
        effectiveAmount: round(r.overrideAmount),
      }
    }
    const calc = round(contractTotal * ((r.percentage ?? 0) / 100))
    return {
      installmentNo: r.installmentNo,
      calculatedAmount: calc,
      residueApplied: 0,
      effectiveAmount: calc,
    }
  })

  // 尾差 = 合約總額 − 目前各期有效金額合計。
  const preliminary = out.reduce((s, r) => s + (r.effectiveAmount ?? 0), 0)
  const residue = round(contractTotal - preliminary)

  if (residue !== 0) {
    // 最後一個「未請款且未覆寫」的期別吸收尾差。
    const absorbIdx = lastIndexWhere(
      out,
      (o, i) => !sorted[i].billed && sorted[i].overrideAmount === null,
    )
    if (absorbIdx >= 0) {
      const target = out[absorbIdx]
      target.calculatedAmount = (target.calculatedAmount ?? 0) + residue
      target.residueApplied = residue
      target.effectiveAmount = target.calculatedAmount
    } else {
      return {
        rows: out,
        percentageTotal: roundPct(percentageTotal),
        effectiveTotal: preliminary,
        unallocatedResidue: residue,
      }
    }
  }

  return {
    rows: out,
    percentageTotal: roundPct(percentageTotal),
    effectiveTotal: out.reduce((s, r) => s + (r.effectiveAmount ?? 0), 0),
    unallocatedResidue: 0,
  }
}

function lastIndexWhere<T>(arr: T[], pred: (item: T, index: number) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i], i)) return i
  }
  return -1
}

/** 百分比合計到小數第三位——避免 20+20+20+20+20 因浮點變成 99.99999999。 */
function roundPct(n: number): number {
  return Math.round(n * 1000) / 1000
}
