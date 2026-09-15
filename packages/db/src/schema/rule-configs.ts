import { pgTable, uuid, text, jsonb, integer, boolean, timestamp, date, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"

/**
 * Rule configs — the per-tenant 差勤/薪資規則 DSL (validated by @hr/rules'
 * `parseRuleConfig`) stored as `config` jsonb. `scope` defaults to 'all'
 * (P2 supports a single tenant-wide config); `version` + `active` let a tenant
 * keep history while exactly one row is the live config the engines read.
 *
 * The worktime / payroll settlement loads the active row for the tenant and
 * feeds `config` straight into the rules engine.
 *
 * `effectiveFrom`：C 批次新增，這版規則從哪天起生效（供之後「規則異動不影響
 * 已結算月份」的判斷）。既有列沒有這個概念，預設值 '1900-01-01' 是刻意選的
 * 「早於任何真實資料」哨兵值；sql/0033 backfill 把既有列改填
 * `(created_at at time zone 'Asia/Taipei')::date`（近似「這版是何時建立即生效」）。
 *
 * `(tenant_id, version)` unique（migration 0046，C4 驗收）：版本號是 API 用
 * max+1 算的，兩個 PUT 同時進來會算到同一號；沒有唯一約束時兩列都寫得進去，
 * 「依計算月份選版」就會選到不確定的那一版。撞索引的 23505 由
 * services/rule-config-version.ts 重取 max+1 重試。
 */
export const ruleConfigs = pgTable(
  "rule_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    scope: text("scope").notNull().default("all"),
    config: jsonb("config").notNull(),
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    effectiveFrom: date("effective_from").notNull().default("1900-01-01"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantVersionUq: uniqueIndex("rule_configs_tenant_version_uq").on(table.tenantId, table.version),
  }),
)
