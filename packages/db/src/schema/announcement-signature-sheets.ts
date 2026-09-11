import {
  pgTable, uuid, text, integer, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { announcementVersions } from "./announcement-versions"
import { employees } from "./employees"

/**
 * Announcement signature sheets — 紙本傳閱簽名單的**掃描檔快照**（模組二第 3 條）。
 *
 * 兩條版本軸中的「簽署」那條。一份掃描檔 = 某個時點「誰已經簽了」的切片。
 * 新人在後續欄位補簽後**加一份新的掃描檔（sheetNo + 1），不是覆蓋舊的**，
 * 也**不動 `announcement_versions`**——規章內容沒改。
 *
 * 客戶原文寫「**更新**掃描檔」；照字面覆蓋會失去時間切片，且紙本若毀損或
 * 某個簽名被遮住即無從還原，與模組二第 2 條「嚴禁刪除」相違。
 *
 * 二進位檔放私有 bucket 的 `storagePath`（同 request_attachments 模式），
 * 本表是租戶範圍的索引，讀取走短效期 signed URL。
 * `contentHash` 證明掃描檔未被事後替換。
 *
 * ⚠️ 掃描檔上的簽名日期不可信：傳閱單頂上是公告日期，新人數月後在後續欄位
 * 補簽，紙上不記錄他何時簽。**實際簽署日以
 * `announcement_acknowledgements.signedAt` 為準**，掃描檔只是佐證。
 */
export const announcementSignatureSheets = pgTable(
  "announcement_signature_sheets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => announcementVersions.id),
    /** 同一版的第幾份掃描檔，自 1 起遞增。補簽產生下一份。 */
    sheetNo: integer("sheet_no").notNull(),
    fileName: text("file_name").notNull(),
    storagePath: text("storage_path").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    contentType: text("content_type"),
    contentHash: text("content_hash"),
    /** 這份掃描檔的拍攝／掃描說明，例如「補入 3 位新進同仁簽名」。 */
    note: text("note"),
    uploadedByEmpId: uuid("uploaded_by_emp_id").references(() => employees.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantVersionSheetUnique: uniqueIndex("announcement_sheets_version_sheet_uq").on(
      table.tenantId,
      table.versionId,
      table.sheetNo,
    ),
  }),
)
