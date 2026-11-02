import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * MCP 連接（migration 0082 ＝ sql/0072）：AI 用戶端以使用者本人身分操作系統。
 * token／授權碼／金鑰／確認碼只存 HMAC 雜湊；只由 API（service role）存取，RLS 開啟無 policy。
 */
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
})

export const mcpGrants = pgTable(
  "mcp_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id").notNull(),
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    /** 'oauth'（一次 OAuth 同意）／'pat'（個人存取金鑰） */
    kind: text("kind").notNull(),
    clientId: text("client_id"),
    clientName: text("client_name").notNull(),
    scope: text("scope"),
    resource: text("resource"),
    tokenPrefix: text("token_prefix"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tenantUserIdx: index("mcp_grants_tenant_user_idx").on(table.tenantId, table.userId, table.kind, table.createdAt),
  }),
)

export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => mcpGrants.id, { onDelete: "cascade" }),
    /** 'access'／'refresh'／'pat' */
    kind: text("kind").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    grantIdx: index("mcp_tokens_grant_idx").on(table.grantId),
  }),
)

export const mcpOauthCodes = pgTable("mcp_oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  userId: uuid("user_id").notNull(),
  employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scope: text("scope"),
  resource: text("resource"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  grantId: uuid("grant_id").references(() => mcpGrants.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const mcpConfirmations = pgTable(
  "mcp_confirmations",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => mcpGrants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    argsHash: text("args_hash").notNull(),
    summary: text("summary"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresIdx: index("mcp_confirmations_expires_idx").on(table.expiresAt),
  }),
)
