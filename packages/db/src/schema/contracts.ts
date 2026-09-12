import {
  pgTable, uuid, text, integer, numeric, date, timestamp, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { projects } from "./projects"

/**
 * Contracts — 專案搭配的合約／報價單／追加減帳（模組四第 3 條，docs/02 區塊 E）。
 *
 * ── 為何不是 projects 上的一個欄位 ─────────────────────────────────
 * 客戶原文「專案需註記搭配之文件類型為『合約』或『報價單』」字面上像專案欄位。
 * 但報價單 → 得標 → 簽約是同一個案子的**兩份文件**，兩份都要留：報價單是
 * 議價紀錄，日後有爭議要用。存成專案單一欄位，簽約後就把報價單覆寫掉了。
 * 專案層級的「有沒有簽約」用**衍生**方式判斷（存在 docType='contract' 且
 * 有 signedOn 的列），不另存旗標，避免兩份真相。
 *
 * ── 這個分類就是課稅開關 ──────────────────────────────────────────
 * 報價單不是契據（無雙方合意），不課印花稅；承攬契據課千分之一
 * （印花稅法 §5③、§7③）。客戶要這個分類是為了報稅，不是為了歸檔整齊。
 *
 * ── ⚠️ 誰貼花取決於我方是承攬人還是定作人 ────────────────────────
 * §7③ 承攬契據「**由承攬人**貼印花稅票」。公司承包業主的案子＝公司貼；
 * 公司發包給下包＝下包貼，**公司不貼**。`ourRole` 不分這件事，清單會把
 * 下包合約也算進應納稅額，金額直接高估。
 *
 * ── ⚠️ 費率凍結在列上，不查當下設定 ──────────────────────────────
 * 印花稅清單是回溯 5～7 年的：2021 年簽的約要用 2021 年的費率。薪資只算
 * 當期，所以那邊「預設值 + 租戶覆寫」就夠；這裡不行。
 * 比照 `advances.balance` 在核銷時凍結——同一個模式。
 * 補登舊約時可直接指定 `stampDutyRate` 為當年度費率。
 *
 * ── 稽核 ──────────────────────────────────────────────────────────
 * 經手金額的表：sql/0022 掛禁刪與稽核 trigger，API 只做軟刪除。
 */
export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    /** 'contract' 合約 | 'quotation' 報價單 | 'change_order' 追加減帳 */
    docType: text("doc_type").notNull(),
    /** 我方角色：'contractor' 承攬人（我方貼花）| 'client' 定作人（對方貼花） */
    ourRole: text("our_role").notNull().default("contractor"),
    title: text("title").notNull(),
    counterparty: text("counterparty"),
    amount: numeric("amount"),
    /** 簽訂日。報價單通常沒有；沒有簽訂日就不算「已簽約」。 */
    signedOn: date("signed_on"),

    /** 版本鏈：改版時新增一列指回舊列，不就地覆寫。 */
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),

    /** 繕寫份數。§13 同一憑證繕寫兩份以上，各份均應貼用。 */
    copies: integer("copies").notNull().default(1),

    /** 是否應貼花。由 docType + ourRole 判定後寫入，可人工覆寫（免稅憑證等）。 */
    stampDutyRequired: text("stamp_duty_required").notNull().default("auto"),
    /** **凍結**：本件適用的費率。 */
    stampDutyRate: numeric("stamp_duty_rate"),
    /** **凍結**：試算稅額 = amount × rate × copies。系統試算，不是申報值。 */
    stampDutyAmount: numeric("stamp_duty_amount"),
    stampDutyPaidOn: date("stamp_duty_paid_on"),
    stampDutyNote: text("stamp_duty_note"),

    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // 軟刪除：金額憑證不實體刪除（sql/0018 的同一套理由）。
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByEmpId: uuid("deleted_by_emp_id"),
    deleteReason: text("delete_reason"),
  },
  (table) => ({
    projectIdx: index("contracts_project_idx").on(table.tenantId, table.projectId),
    // 印花稅清單按簽訂日回溯 5～7 年，這是主要的查詢路徑。
    signedIdx: index("contracts_signed_idx").on(table.tenantId, table.signedOn),
  }),
)
