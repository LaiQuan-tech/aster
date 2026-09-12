import { supabaseAdmin } from "../lib/supabase.js"

/**
 * 專案編號的產生（模組四第 1 條）。
 *
 * ── 格式 ──────────────────────────────────────────────────────────
 * `{PREFIX}{YYYY}-{NNN}`，例如 `P2026-001`。
 *
 * **使用者裁示：先做這個格式，之後有特殊需求再改。**
 * 要改格式就改下面三個常數與 `formatCode()`——這裡是唯一的地方。
 *
 * ── 年度為何只能取「建立年」 ──────────────────────────────────────
 * 編號會被印在合約、請款單、發票與往來文件上，一旦印出去就不能改。
 * 因此任何「事後才知道」的年度都不能拿來編號：
 *   • 簽約年 —— 立案時可能還沒簽約（先立案、後簽約），那時編不出號
 *   • 開工年 —— 更晚
 *   • 完工年 —— 2~4 年後才知道
 * 只有建立年在立案當下就確定。
 *
 * 歸屬年度另有 `projects.fiscal_year`，可人工調整、可與編號的年度不同。
 * **不要用編號表達歸屬。**
 *
 * ── 流水號每年重置 ────────────────────────────────────────────────
 * 編號既然含年度，流水號就該每年從 001 開始，否則年度那一段沒有意義。
 * 2~4 年的專案到了第 4 年仍是當初的編號，不隨時間改。
 *
 * ── 併發 ──────────────────────────────────────────────────────────
 * `MAX(seq) + 1` 在兩人同時建案時會拿到同一個號。真正的保證是
 * `projects_tenant_code_uq` 這個 unique index；本模組在衝突時重試，
 * **讓 DB 當最後防線，而不是靠應用層搶**。
 */

/** 要改編號格式，改這三個常數與 formatCode()。 */
const PREFIX = "P"
const SEQ_DIGITS = 3
const SEPARATOR = "-"

/** 同一年度內最多重試幾次（併發衝突時）。 */
export const MAX_CODE_ATTEMPTS = 5

export function formatCode(year: number, seq: number): string {
  return `${PREFIX}${year}${SEPARATOR}${String(seq).padStart(SEQ_DIGITS, "0")}`
}

/** 從編號字串取出流水號；格式不符回 null（人工輸入的舊編號不參與計算）。 */
export function parseSeq(code: string, year: number): number | null {
  const re = new RegExp(`^${PREFIX}${year}${SEPARATOR}(\\d+)$`)
  const m = code.match(re)
  return m ? Number(m[1]) : null
}

/**
 * 取該租戶該年度的下一個編號。
 *
 * 只掃描「符合本格式」的既有編號——人工輸入的例外編號不參與流水號計算，
 * 否則一筆手打的 `ABC-999` 會把之後所有自動編號推到 1000。
 */
export async function nextProjectCode(tenantId: string, year: number): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("code")
    .eq("tenant_id", tenantId)
    .like("code", `${PREFIX}${year}${SEPARATOR}%`)
  if (error) throw new Error(`nextProjectCode: ${error.message}`)

  let maxSeq = 0
  for (const row of data ?? []) {
    const seq = parseSeq((row.code as string) ?? "", year)
    if (seq !== null && seq > maxSeq) maxSeq = seq
  }
  return formatCode(year, maxSeq + 1)
}

/** Postgres unique violation —— 併發撞號時重試的判斷依據。 */
export function isUniqueViolation(err: { code?: string } | null): boolean {
  return err?.code === "23505"
}
