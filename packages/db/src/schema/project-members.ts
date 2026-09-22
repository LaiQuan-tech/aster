import { pgTable, uuid, text, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { projects } from "./projects"
import { employees } from "./employees"

/**
 * Project members — 專案成員與其獎金分潤（敏感）。一名成員在一個專案一列
 * （unique(project_id, employee_id)）。`roleInProject` 值域（DB 無 CHECK，由
 * API zod 決定；2026-09-23 W3 起四值）：
 *   • 'manager' 經理 — 與 lead 同樣可看該專案全部成員分潤、可管理專案
 *     （sql/0015 is_project_lead 與 services/project-scope.ts 皆 IN ('lead','manager')）
 *   • 'lead'    主辦（負責人；舊值，語意不變）
 *   • 'support' 支援 — 一般成員，只看自己
 *   • 'member'  組員（預設；舊值）
 * 各角色預設趴數在 project_settings.default_share_pct_by_role。分潤依
 * projects.shareMode 擇一填：
 *   • pool_pct 模式 → sharePct（百分比，金額 = projects.bonusPool × pct）
 *   • fixed_amount 模式 → shareAmount（直接金額）
 * 「組員彼此看不到分潤」由 RLS（sql/0015）與 API handler 依角色分流雙重把關；
 * 會計角色（employees.role='accountant'）看得到專案與金流，但**看不到**分潤趴數
 * 與獎金池（services/project-scope.ts canSeeBonus）。
 */
export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    roleInProject: text("role_in_project").notNull().default("member"),
    sharePct: numeric("share_pct"),
    shareAmount: numeric("share_amount"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectEmployeeUnique: uniqueIndex("project_members_project_employee_uq").on(
      table.projectId,
      table.employeeId,
    ),
  }),
)
