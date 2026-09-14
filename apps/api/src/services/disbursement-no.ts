import { supabaseAdmin } from "../lib/supabase.js"
import {
  codeLikePrefix,
  formatCode,
  loadCodeFormat,
  parseSeq,
  type CodeFormat,
} from "./project-code.js"

/**
 * 匯款單號的產生（放款專區）——`D-{民國年}-{NNN}`，沿用 services/project-code.ts
 * 的模式（settings 年制／位數＋unique index 重試）。
 *
 * 與專案編號的差別只有前綴：**固定 `D`**，不吃 `project_settings.code_prefix`
 * ——匯款單號要一眼看出「這是放款單」，跟專案代號（AT-…）分開；年制
 * （roc／ad）與流水號位數則跟租戶的專案編號設定走，兩種單據的長相一致。
 *
 * 年度＝建立當下的租戶當地年（呼叫端算好傳進來），流水號每年重置；
 * 併發撞號由 `disbursements_tenant_disbursement_no_uq` 當最後防線，
 * 呼叫端（services/disbursements.ts createDisbursement）在 23505 時重試。
 */

export const DISBURSEMENT_NO_PREFIX = "D"

/** 把租戶的專案編號格式換成匯款單號格式：只換前綴。 */
export function toDisbursementNoFormat(fmt: CodeFormat): CodeFormat {
  return { ...fmt, prefix: DISBURSEMENT_NO_PREFIX }
}

export async function loadDisbursementNoFormat(tenantId: string): Promise<CodeFormat> {
  return toDisbursementNoFormat(await loadCodeFormat(tenantId))
}

export function formatDisbursementNo(fmt: CodeFormat, year: number, seq: number): string {
  return formatCode(toDisbursementNoFormat(fmt), year, seq)
}

/**
 * 該租戶該年度的下一個單號。只掃描「符合本格式」的既有單號（同
 * nextProjectCode 的理由：例外編號不推動流水號）。
 */
export async function nextDisbursementNo(tenantId: string, year: number, fmt?: CodeFormat): Promise<string> {
  const format = toDisbursementNoFormat(fmt ?? (await loadCodeFormat(tenantId)))
  const { data, error } = await supabaseAdmin
    .from("disbursements")
    .select("disbursement_no")
    .eq("tenant_id", tenantId)
    .like("disbursement_no", codeLikePrefix(format, year))
  if (error) throw new Error(`nextDisbursementNo: ${error.message}`)

  let maxSeq = 0
  for (const row of data ?? []) {
    const seq = parseSeq(format, (row.disbursement_no as string) ?? "", year)
    if (seq !== null && seq > maxSeq) maxSeq = seq
  }
  return formatCode(format, year, maxSeq + 1)
}
