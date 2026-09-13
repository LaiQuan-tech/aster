/**
 * 台灣統一編號檢查碼（財政部 2021-04 起新規則：加權和可被 5 整除；舊規則是 10）。
 * 純函式，廠商名冊建檔與名片辨識都用它標記「格式對但檢查碼錯」——只標記不擋，
 * 因為名片上的統編常有印刷或辨識錯字，讓人看得到問題再改比直接拒絕好。
 *
 * 規則：8 碼數字逐位乘權重 [1,2,1,2,1,2,4,1]，每個乘積的十位與個位相加後總和；
 * 總和 % 5 == 0 為有效。第 7 碼為 7 時乘積 28 → 2+8=10，得視為 1 或 0，
 * 所以總和或總和 +1 其一能被 5 整除即可。
 */
export const TAX_ID_RE = /^\d{8}$/

export function isValidTaiwanTaxId(id: string): boolean {
  if (!TAX_ID_RE.test(id)) return false
  const weights = [1, 2, 1, 2, 1, 2, 4, 1]
  let sum = 0
  for (let i = 0; i < 8; i++) {
    const p = Number(id[i]) * weights[i]
    sum += Math.floor(p / 10) + (p % 10)
  }
  if (sum % 5 === 0) return true
  if (id[6] === "7" && (sum + 1) % 5 === 0) return true
  return false
}
