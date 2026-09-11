import {
  pgTable, uuid, text, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { announcementVersions } from "./announcement-versions"
import { announcementSignatureSheets } from "./announcement-signature-sheets"
import { employees } from "./employees"

/**
 * Announcement acknowledgements — 逐人簽收紀錄（模組二第 1、3 條）。
 *
 * 一份規章、一位員工、一個版本 = 一列。這張表回答的是客戶沒提、但本模組
 * 最該做的問題：**「誰還沒簽」**。一張紙本傳閱單傳完，沒人知道少了誰。
 *
 * 三個時間戳，作用各不相同：
 *
 *   • `viewedAt` — 線上查閱時間（被動 log，非「勾選同意」）。
 *     這一層滿足勞基法施行細則 §37「揭示或發給勞工」的法定義務——
 *     法律要的是揭示／發給，不是取得簽名。客戶排斥的是「線上勾選同意」，
 *     不是查閱紀錄，兩者是不同的東西。
 *   • `signedAt` — **紙本實際簽署日**，由 HR 輸入。不可從掃描檔推斷：
 *     傳閱單頂上是公告日期，新人數月後補簽，紙上不記錄他何時簽。
 *     不利益變更需證明「每個人何時同意」，這一欄是那個證明。
 *   • `createdAt` — 本列建立時間（例如新人報到時自動生成待簽項）。
 *
 * `kind` 區分同一張紙上兩種法律性質不同的簽名：
 *
 *   • `'consent_to_change'` — 在職員工簽不利益變更＝**同意變更**既有勞動條件
 *   • `'accept_on_hire'`    — 新人到職補簽＝**接受既有勞動條件**，
 *     對他而言不存在「變更」，這是聘僱條件的一部分
 *
 * 盤點「本次不利益變更有多少人同意」時，`accept_on_hire` 既不進分母也不進
 * 分子——新人不是同意變更的對象。混算會讓同意率失真，而該比率正是不利益
 * 變更是否生效的關鍵事實。
 *
 * `signatureSheetId` 指向承載該簽名的掃描檔（可 null：先建待簽項、之後補）。
 */
export const announcementAcknowledgements = pgTable(
  "announcement_acknowledgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => announcementVersions.id),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id),
    /** 'consent_to_change' | 'accept_on_hire'（見上方說明） */
    kind: text("kind").notNull().default("consent_to_change"),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signatureSheetId: uuid("signature_sheet_id").references(
      () => announcementSignatureSheets.id,
    ),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantVersionEmployeeUnique: uniqueIndex("announcement_acks_version_employee_uq").on(
      table.tenantId,
      table.versionId,
      table.employeeId,
    ),
    /** 「這位員工還有哪些沒簽」的查詢。 */
    tenantEmployeeSignedIdx: index("announcement_acks_tenant_employee_signed_idx").on(
      table.tenantId,
      table.employeeId,
      table.signedAt,
    ),
  }),
)
