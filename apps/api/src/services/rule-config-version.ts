/**
 * rule_configs 版本號配發（C4 驗收修正）。
 *
 * 版本號是「這個租戶目前最大 version＋1」算出來的，兩個 PUT /rule-config 同時進來
 * 會算到同一號。migration 0046 起 (tenant_id, version) 有唯一索引，第二個會撞
 * 23505；這裡把「重取 max＋1 再 insert」包成可重試的純流程，DB 存取全由呼叫端
 * 注入（route 用 supabaseAdmin；單元測試用假函式模擬撞索引），引擎本身無 IO。
 *
 * 只有 23505（unique_violation）才重試；其他錯誤（連線斷、欄位不存在…）第一次就
 * 回報，不重試——那不是搶號造成的，重試也不會好。
 */

export const RULE_CONFIG_VERSION_RETRIES = 3

/** PostgREST／postgres 的 unique_violation SQLSTATE。 */
export const UNIQUE_VIOLATION = "23505"

export type DbError = { code?: string | null; message?: string | null }

export interface RuleConfigVersionDeps<Row, Current extends { version: number }> {
  /** 這個租戶目前 version 最大的那一列（不篩 active）；沒有任何版本 → null。 */
  readCurrent: () => Promise<Current | null>
  /** 以指定 version 寫入一列；撞唯一索引時 error.code 為 '23505'。 */
  insertVersion: (version: number) => Promise<{ data: Row | null; error: DbError | null }>
}

export type RuleConfigVersionResult<Row, Current> =
  | { ok: true; row: Row; version: number; current: Current | null; attempts: number }
  | {
      ok: false
      /** conflict_exhausted：重試用完仍撞號；insert_failed：非 23505 的錯，不重試。 */
      reason: "conflict_exhausted" | "insert_failed"
      attempts: number
      error: DbError | null
    }

/**
 * 首次嘗試＋最多 `retries` 次重試（預設 3）。每次都重新讀 max version 再 +1，
 * 不沿用上一次算的號（上一次就是因為那個號被搶走才失敗的）。
 */
export async function insertRuleConfigVersion<Row, Current extends { version: number }>(
  deps: RuleConfigVersionDeps<Row, Current>,
  retries = RULE_CONFIG_VERSION_RETRIES,
): Promise<RuleConfigVersionResult<Row, Current>> {
  const maxAttempts = 1 + Math.max(0, retries)
  let attempts = 0
  let lastError: DbError | null = null
  while (attempts < maxAttempts) {
    attempts += 1
    const current = await deps.readCurrent()
    const version = (current?.version ?? 0) + 1
    const { data, error } = await deps.insertVersion(version)
    if (!error && data) return { ok: true, row: data, version, current, attempts }
    lastError = error ?? { code: null, message: "insert returned no row" }
    if (lastError.code !== UNIQUE_VIOLATION) {
      return { ok: false, reason: "insert_failed", attempts, error: lastError }
    }
    // 23505：號被搶了，回頭重讀 max 再試
  }
  return { ok: false, reason: "conflict_exhausted", attempts, error: lastError }
}
