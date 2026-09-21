import { pgTable, text, timestamp } from "drizzle-orm/pg-core"

/**
 * Rate limits — 跨 instance 的簡易節流（忘記密碼等未登入端點）。
 *
 * API 跑在 Vercel serverless，每個 instance 各自一份記憶體，Map 型節流等於沒有：
 * 同一 email 連打兩次落到不同 instance 就都放行。改成一列一個 key 的表，由
 * `rate_limit_touch(key, window_seconds)`（sql/0035）以單一 upsert 原子判定
 * 「這個視窗內是不是第一次」。key 由呼叫端組（例 `forgot:<sha256(email)>`），
 * 不存明文 email。沒有 tenant_id：忘記密碼發生在登入前，沒有租戶脈絡。
 * RLS 啟用不給 policy（API 專用表）。
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  lastAt: timestamp("last_at", { withTimezone: true }).notNull().defaultNow(),
})
