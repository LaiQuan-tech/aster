import { pgTable, uuid, text, date, timestamp, uniqueIndex, integer } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { employees } from "./employees"

/**
 * Employee profiles — 1:1 contact / personal extension of an employee, aligned
 * field-for-field with My Data ▸ 基本資料 + 通訊資料:
 *   基本: firstName/lastName 姓名拆欄, englishName 英文姓名, nationality 國籍,
 *   idType/idNumber/idExpiry ×3 (證件三組), entryDate 入境時間, birthday 生日,
 *   gender 性別, maritalStatus 婚姻, photo 員工照片.
 *   通訊: phone 手機, phoneMobile2 手機2, phoneLandline 市話, registeredAddress
 *   戶籍地址, address 聯絡地址, companyEmail 公司信箱, personalEmail 私人信箱,
 *   lineUserId LINE Messaging API user id,
 *   emergencyContact/emergencyRelationship/emergencyPhone 緊急聯絡人組.
 * Unique (tenant_id, employee_id) makes it a true 1:1 and powers the upsert in
 * PUT /employees/:id/profile.
 */
export const employeeProfiles = pgTable(
  "employee_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    // 基本資料
    firstName: text("first_name"),
    lastName: text("last_name"),
    englishName: text("english_name"),
    nationality: text("nationality"),
    idType: text("id_type"),
    idNumber: text("id_number"),
    idExpiry: date("id_expiry"),
    idType2: text("id_type2"),
    idNumber2: text("id_number2"),
    idExpiry2: date("id_expiry2"),
    idType3: text("id_type3"),
    idNumber3: text("id_number3"),
    idExpiry3: date("id_expiry3"),
    entryDate: date("entry_date"),
    birthday: date("birthday"),
    gender: text("gender"),
    maritalStatus: text("marital_status"),
    photoFileName: text("photo_file_name"),
    photoStoragePath: text("photo_storage_path"),
    photoSizeBytes: integer("photo_size_bytes"),
    photoContentType: text("photo_content_type"),
    // 通訊資料
    phone: text("phone"),
    phoneMobile2: text("phone_mobile2"),
    phoneLandline: text("phone_landline"),
    registeredAddress: text("registered_address"),
    address: text("address"),
    companyEmail: text("company_email"),
    personalEmail: text("personal_email"),
    lineUserId: text("line_user_id"),
    emergencyContact: text("emergency_contact"),
    emergencyRelationship: text("emergency_relationship"),
    emergencyPhone: text("emergency_phone"),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantEmployeeUnique: uniqueIndex("employee_profiles_tenant_employee_uq").on(
      table.tenantId,
      table.employeeId,
    ),
  }),
)
