import {
  pgTable, uuid, text, integer, boolean, date, timestamp, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { announcements } from "./announcements"
import { employees } from "./employees"

/**
 * Announcement versions — 公告／規章的**內容版本鏈**（模組二第 2 條）。
 *
 * 這是兩條版本軸中的「內容」那條。另一條是掃描檔快照
 * （`announcement_signature_sheets`）——**有人補簽不會讓內容進版**。
 * 混為一軸的後果：新人一來規章就進版一次，內容一字未改卻變成第 17 版，
 * 真正的條款修訂被補簽噪音淹沒，勞檢時答不出「當時生效的是第幾版」。
 *
 * `versionNo` 是給人看的版號（第一版、第二版）。`changeType` 區分客戶原文
 * 「當條款**跨年度**或有**增修**時」的兩種進版觸發——跨年度意味著條款一字
 * 未改也要進版（年度特休、年度福利額度這類條款，適用年度不同即為不同版本），
 * 兩者不分開記，「今年與去年相同」這件事本身就無法證明。
 *
 * `isAdverseChange`（不利益變更）決定簽收的法律性質：實務見解上，對勞工
 * 不利的變更原則上需勞工個別同意，否則對不同意者不生效力。標記為 true 時，
 * `announcement_acknowledgements` 的簽收才是「同意」而非只是「已閱讀」。
 *
 * `effectiveTo` 為 null 代表仍生效。保存期限應掛「最後適用日 + N 年」而非
 * 「建立日 + N 年」——爭議時要證明的是「當時適用哪一版」，故某一版要保留到
 * 最後一位受該版規範的員工請求權時效屆滿為止。本表永不刪除。
 */
export const announcementVersions = pgTable(
  "announcement_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => announcements.id),
    /** 人類可讀版號，自 1 起遞增。 */
    versionNo: integer("version_no").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    audience: text("audience").notNull().default("all"),
    /** 'initial' | 'amendment'（增修） | 'annual_rollover'（跨年度） */
    changeType: text("change_type").notNull().default("initial"),
    /** 本次改了什麼，給日後查核的人看。 */
    changeNote: text("change_note"),
    effectiveFrom: date("effective_from"),
    /** null = 仍生效；被新版取代時填上。 */
    effectiveTo: date("effective_to"),
    /** 本版是否需要逐人簽收（工作規則類為 true，一般佈告為 false）。 */
    requiresSignature: boolean("requires_signature").notNull().default(false),
    /** 是否涉及勞動條件不利益變更（見上方說明）。 */
    isAdverseChange: boolean("is_adverse_change").notNull().default(false),
    /** 內容 hash，證明這一版的文字未被事後替換。 */
    contentHash: text("content_hash"),
    createdByEmpId: uuid("created_by_emp_id").references(() => employees.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantAnnVersionUnique: uniqueIndex("announcement_versions_ann_version_uq").on(
      table.tenantId,
      table.announcementId,
      table.versionNo,
    ),
    tenantEffectiveIdx: index("announcement_versions_tenant_effective_idx").on(
      table.tenantId,
      table.effectiveFrom,
      table.effectiveTo,
    ),
  }),
)
