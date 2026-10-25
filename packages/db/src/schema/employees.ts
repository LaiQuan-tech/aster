import {
  pgTable, uuid, text, date, timestamp, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { tenants } from "./tenants"
import { departments } from "./departments"
import { shifts } from "./shifts"
import { companies } from "./companies"

/**
 * Employees — people belonging to a tenant. `userId` links to the auth user
 * (nullable until invited/registered). `deptId` references departments.
 *
 * `userId` 一人最多一組登入帳號：非 null 值之間必須唯一，否則帳號邀請流程
 * 可能把兩個員工綁到同一個 auth user。比照 `clients.ts` 的 partial unique
 * index 理由——NULL（尚未邀請）互不相等，兩筆都留白的列不該互相卡住。
 *
 * `mustChangePassword` 供帳號邀請 WP 使用：管理員配發初始密碼時設 true，
 * 使用者登入後首次改密碼即清為 false。
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id"),
    empNo: text("emp_no"),
    name: text("name").notNull(),
    deptId: uuid("dept_id").references(() => departments.id),
    employmentType: text("employment_type").notNull().default("regular"),
    hireDate: date("hire_date"),
    role: text("role").notNull().default("employee"),
    status: text("status").notNull().default("active"),
    // 離職日 — set when the employee is deactivated; drives Dashboard 離職 counts.
    terminatedAt: date("terminated_at"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /**
     * 2026-10-13 員工個人設定（migration 0068）：個人預設班別——工作日沒有 schedules 列時用它判遲到／應下班／缺卡
     * （apps/api services/employee-shifts.ts）；NULL＝依公司規則（彈性上班）。班別被刪 → SET NULL。
     */
    defaultShiftId: uuid("default_shift_id").references(() => shifts.id, { onDelete: "set null" }),
    /** 個人功能開關（CHECK：必須是 object）；目前只用 `{ wfhPunch: true }`＝可勾「在家上班」打卡。 */
    features: jsonb("features").$type<{ wfhPunch?: boolean }>().notNull().default(sql`'{}'::jsonb`),
    /**
     * 2026-10-25 員工所屬公司（migration 0072）：集團總覽依它把在職人數、薪資成本歸到公司；
     * NULL＝未指派（另列、不分攤）。公司被刪 → SET NULL。API 寫入前驗證同租戶。
     */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdUnique: uniqueIndex("employees_user_id_uq")
      .on(table.userId)
      .where(sql`${table.userId} is not null`),
    defaultShiftIdx: index("employees_default_shift_idx")
      .on(table.defaultShiftId)
      .where(sql`${table.defaultShiftId} is not null`),
    tenantCompanyIdx: index("employees_tenant_company_idx").on(table.tenantId, table.companyId),
  }),
)
