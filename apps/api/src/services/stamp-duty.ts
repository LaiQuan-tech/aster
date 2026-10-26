/**
 * 印花稅試算（模組四第 3 條）。
 *
 * ⚠️ **系統不報稅，系統提供數字。** 跟第 1 條的營收認列同一個原則。
 * 印花稅有數個判斷點，系統判不了：
 *   • 是否屬承攬契據（勞務／買賣／混合型契約的歸類）
 *   • 金額不確定的單價契約（先按概算貼用、結算找補）
 *   • 是否已申請按期彙總繳納（免逐件貼花）
 *   • §6 的免稅憑證
 * 所以本模組做的是**清單、試算、標示未貼花**，不是「算出應納稅額並宣稱正確」。
 * 所有稅務細節請會計師確認。
 *
 * ── 法源（印花稅法）────────────────────────────────────────────────
 * §5③ 承攬契據：一方為他方完成一定工作之契據，如承包各種工程契約。
 * §7③ 承攬契據每件按金額 **千分之一**，**由承攬人**貼印花稅票。
 * §13  同一憑證繕寫兩份以上者，各份均應貼用。
 *
 * **報價單不是契據**（無雙方合意），不在課稅範圍——客戶要「合約／報價單」
 * 這個分類就是為了這件事。
 */

export const DOC_TYPES = ["contract", "quotation", "change_order"] as const
export type DocType = (typeof DOC_TYPES)[number]

export const OUR_ROLES = ["contractor", "client", "both"] as const
export type OurRole = (typeof OUR_ROLES)[number]

/** 應貼花與否的人工覆寫：auto 依規則判定，yes/no 強制。 */
export const STAMP_DUTY_FLAGS = ["auto", "yes", "no"] as const
export type StampDutyFlag = (typeof STAMP_DUTY_FLAGS)[number]

/** 承攬契據千分之一（§7③）。只是預設值，實際費率凍結在合約列上。 */
export const DEFAULT_STAMP_DUTY_RATE = 0.001

/**
 * 回溯期間預設 **7** 年。
 *
 * 稅捐稽徵法 §21：已依規定期間申報且無詐術逃漏 → 核課期間 5 年；
 * **未於規定期間申報**或以詐術逃漏 → **7 年**。
 * 印花稅是自行貼花，若過去根本沒貼，那正是「未申報」的情形，
 * 而那也正是最需要這份清單的情形。客戶原文寫「近 5 年」，做 5 年會漏掉它。
 */
export const DEFAULT_LOOKBACK_YEARS = 7

export function isDocType(v: string): v is DocType {
  return (DOC_TYPES as readonly string[]).includes(v)
}

/**
 * 依規則判定本件是否應由我方貼花。
 *
 * 兩個條件都要成立：
 * 1. **是契據**——合約與追加減帳是，報價單不是
 * 2. **我方要貼**——§7③ 由承攬人貼花：
 *    • `contractor` 我方是承攬人 → 我方貼
 *    • `both` 雙重身分（B 批次新增）——雙方互為承攬與定作，各自貼自己
 *      持有的那份，我方仍須貼，稅額算法與 `contractor` 相同（見
 *      `computeStampDuty` 的 `copies` 本就只算我方持有份數）
 *    • `client` 我方是定作人，公司發包給下包時貼花的是下包，
 *      這種列不該進我方的應納稅額
 */
export function isStampDutyApplicable(input: {
  docType: string
  ourRole: string
}): boolean {
  if (input.ourRole !== "contractor" && input.ourRole !== "both") return false
  return input.docType === "contract" || input.docType === "change_order"
}

/** 把 auto/yes/no 與規則判定合併成最終結論。 */
export function resolveStampDutyRequired(input: {
  docType: string
  ourRole: string
  flag: string
}): boolean {
  if (input.flag === "yes") return true
  if (input.flag === "no") return false
  return isStampDutyApplicable(input)
}

/**
 * 試算稅額 = 金額 × 費率 × 份數。
 *
 * 份數：§13 同一憑證繕寫兩份以上，各份均應貼用。雙方各執一份時，
 * 我方就自己持有的份數貼。※ 「一式三份」的實務請會計師確認。
 *
 * 尾數：未滿一元捨去。※ 尾數處理請會計師確認。
 *
 * 追加減帳可能是負數（減帳）；**減帳不退稅**，所以負數一律回 0。
 */
export function computeStampDuty(input: {
  amount: number | null
  rate: number
  copies?: number
}): number | null {
  if (input.amount === null || !Number.isFinite(input.amount)) return null
  const copies = input.copies ?? 1
  if (copies < 1) return null
  const raw = input.amount * input.rate * copies
  if (!(raw > 0)) return 0
  return Math.floor(raw)
}
