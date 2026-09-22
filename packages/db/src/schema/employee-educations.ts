import { pgTable, uuid, text, date, boolean, timestamp, integer } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Employee education records — 學歷 (My Data ▸ 學歷證照). Fields mirror the
 * add-education form: isHighest 最高學歷, degree 學歷類別, school 學校,
 * majorCategory 科系類別, major 科系名稱, studyType 就學類別(day/night/other),
 * studyStatus 就學狀態(graduated/enrolled/incomplete), start/end 就學起訖,
 * region 學校所在地區. N per employee.
 */
export const employeeEducations = pgTable("employee_educations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id),
  isHighest: boolean("is_highest").notNull().default(false),
  school: text("school").notNull(),
  majorCategory: text("major_category"),
  major: text("major"),
  degree: text("degree"),
  studyType: text("study_type"),
  studyStatus: text("study_status"),
  region: text("region"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  proofFileName: text("proof_file_name"),
  proofStoragePath: text("proof_storage_path"),
  proofSizeBytes: integer("proof_size_bytes"),
  proofContentType: text("proof_content_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
