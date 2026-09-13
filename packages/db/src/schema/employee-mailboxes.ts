import { pgTable, uuid, text, date, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Employee mailboxes — 各員工「專屬公司 Email」的配發台帳。
 *
 * 信箱本身在郵件供應商（Google Workspace / Microsoft 365）那邊建，系統不代建
 * （要建得拿網域管理員憑證，那是另一個決定）。這張表管的是：該給誰、給什麼
 * 地址、建了沒、什麼時候停用。`address` 與 employees 的登入 email 是兩回事——
 * 登入 email 可以是私人信箱，這裡一定是公司網域。
 *
 * status：planned（已配、供應商還沒建）→ active（可用）→ suspended（離職停用）。
 */
export const employeeMailboxes = pgTable(
  "employee_mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    address: text("address").notNull(),
    status: text("status").notNull().default("planned"),
    provider: text("provider"),
    activatedOn: date("activated_on"),
    suspendedOn: date("suspended_on"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeeUnique: uniqueIndex("employee_mailboxes_tenant_employee_uq").on(
      table.tenantId,
      table.employeeId,
    ),
    tenantAddressUnique: uniqueIndex("employee_mailboxes_tenant_address_uq").on(
      table.tenantId,
      table.address,
    ),
  }),
)
