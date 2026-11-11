/**
 * 純函式：預估「期程整批 PUT 存完後，後端算出的每期有效金額」（2026-11-11 每期分潤驗收修正）。
 *
 * 規則照搬 apps/api services/billing-schedule.ts computeInstallments ＋ project-money.ts computeSchedule／effectiveBillingAmount：
 * - 一般分期（installment）：已請款＝請款金額；人工指定＝指定金額；其餘＝round(合約總額 × %)；
 *   尾差（合約總額 − 各期合計）加到**最後一個未請款且未人工指定**的一般期別。沒有合約總額（null）不試算：
 *   有效金額＝已請款 ? 請款金額 : 人工指定金額。
 * - 技師公會代墊（guild_advance）：不進尾差；已請款＝請款金額、人工指定＝指定金額、否則 round(總額 × %)（沒總額＝null）。
 * - 有效金額＝已請款 ?? 人工指定（原值）?? 試算（同後端 effectiveBillingAmount）。
 *
 * 用途：申請單存檔前，分潤合計要跟「後端會算出的金額」比，不能跟畫面上的金額比——畫面金額與 % 合計不等於
 * 合約總額時，差額會被加到最後一期，前後端不一致就會「期別存了、分潤卻被後端擋掉」。
 *
 * ⚠️ vitest 沒設 `@/` 別名：本檔不 import 任何模組。
 */

export interface PredictScheduleRow {
  installmentNo: number;
  kind?: string | null;
  percentage: number | null;
  overrideAmount: number | null;
  billed: boolean;
  billedAmount: number | null;
}

function round(n: number): number {
  return Math.round(n);
}

/** 期別編號 → 存後有效金額（null＝算不出來）。 */
export function predictScheduleAmounts(rows: readonly PredictScheduleRow[], contractTotal: number | null): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const total = contractTotal !== null && Number.isFinite(contractTotal) ? contractTotal : null;
  const installments = rows.filter((r) => r.kind !== "guild_advance").sort((a, b) => a.installmentNo - b.installmentNo);
  const advances = rows.filter((r) => r.kind === "guild_advance");

  if (total === null) {
    for (const r of installments) out.set(r.installmentNo, r.billed ? r.billedAmount : r.overrideAmount);
  } else {
    // 尾差的計算用後端 computeInstallments 的口徑（人工指定四捨五入、已請款缺金額當 0）。
    const calc = new Map<number, number>();
    let preliminary = 0;
    for (const r of installments) {
      if (r.billed) preliminary += r.billedAmount ?? 0;
      else if (r.overrideAmount !== null) preliminary += round(r.overrideAmount);
      else {
        const c = round(total * ((r.percentage ?? 0) / 100));
        calc.set(r.installmentNo, c);
        preliminary += c;
      }
    }
    const residue = round(total - preliminary);
    if (residue !== 0) {
      for (let i = installments.length - 1; i >= 0; i--) {
        const r = installments[i];
        if (!r.billed && r.overrideAmount === null) {
          calc.set(r.installmentNo, (calc.get(r.installmentNo) ?? 0) + residue);
          break;
        }
      }
    }
    for (const r of installments) {
      out.set(r.installmentNo, r.billed ? r.billedAmount : r.overrideAmount !== null ? r.overrideAmount : (calc.get(r.installmentNo) ?? null));
    }
  }

  for (const a of advances) {
    let effective: number | null;
    if (a.billed) effective = a.billedAmount;
    else if (a.overrideAmount !== null) effective = a.overrideAmount;
    else effective = total !== null && a.percentage !== null ? round(total * (a.percentage / 100)) : null;
    out.set(a.installmentNo, effective);
  }
  return out;
}
