/**
 * 期程版本（樂觀鎖，2026-11-18）：整批 PUT /projects/:id/billings 帶 expectedVersion，跟目前期程算出的版本不符 → 409 conflict_retry，
 * 避免兩人同時存檔，後存的人用舊畫面把對方剛新增的期別當成「不在 payload」而軟刪除。
 *
 * 只看「結構」欄位（期別 id、編號、類型、百分比、名稱、預計日、人工金額／理由、備註）——試算金額與尾差會因合約金額變動而重算，
 * 請款／開票／入帳另有各自的檢查，不算進版本，免得同一次存檔流程裡前一步就讓後一步誤判衝突。
 * ⚠️ 前端 apps/web/src/lib/billing-version.ts 有一模一樣的實作（輸入是 API 回傳的期別欄位），兩邊要同步；測試用同一組向量。
 */
export type BillingVersionInput = {
  id: string
  installmentNo: number
  kind?: string | null
  percentage?: number | null
  milestone?: string | null
  plannedOn?: string | null
  overrideAmount?: number | null
  overrideReason?: string | null
  note?: string | null
}

export function billingScheduleVersion(rows: readonly BillingVersionInput[]): string {
  const canonical = [...rows]
    .map((r) => [
      r.id.toLowerCase(),
      r.installmentNo,
      r.kind ?? "installment",
      r.percentage ?? null,
      r.milestone ?? null,
      r.plannedOn ?? null,
      r.overrideAmount ?? null,
      r.overrideReason ?? null,
      r.note ?? null,
    ])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))
  const text = JSON.stringify(canonical)
  // FNV-1a 32-bit（前後端同一實作；不是安全用途，只偵測「讀取之後被改過」）。
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${rows.length}-${hash.toString(16).padStart(8, "0")}`
}
