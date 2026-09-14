import {
  pgTable, uuid, text, integer, numeric, timestamp, date, jsonb, uniqueIndex,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { departments } from "./departments"
import { clients } from "./clients"

/**
 * Projects — 專案，內部知識庫與獎金分潤的核心單位。
 * `deptId` 指向專案所屬部門（可空），驅動「部門主管可見旗下專案分潤」。
 * `leadEmpId` 是專案負責人的 employee id；比照 departments.managerEmpId
 * 刻意不設 DB FK 以避免與 employees 循環依賴。分潤兩種模式：
 *   • shareMode='pool_pct'  → 設 bonusPool 總額，每位成員給 sharePct（%），金額 = pool × pct。
 *   • shareMode='fixed_amount' → 直接對每位成員填 shareAmount，忽略 bonusPool。
 * 專案「資訊」全租戶可讀（知識庫），但成員分潤金額由 project_members 的 RLS 收斂。
 *
 * ── 編號與歸屬年度是兩件事（模組四第 1 條）──────────────────────────
 *
 * `code` 是**識別碼**：會被印在合約、請款單、發票與往來文件上，
 * **一旦產生就不再變更**。因此編號中的年度只能取「建立年」——
 * 簽約年、開工年、完工年都是事後才知道的，立案當下產不出編號。
 *
 * `fiscalYear` 是**分析維度**：報表、業績與獎金歸屬看這一欄，可人工調整。
 * 12 月談成、1 月才立案的案子，編號是新年度，歸屬年度可設回舊年度。
 *
 * **不要用編號表達歸屬**——混在一起就會出現「為了改歸屬而想改編號」的
 * 壓力，而那個編號已經在客戶手上的合約上了。
 *
 * 唯一性由 `projects_tenant_code_uq` 保證，不是靠應用層檢查：兩個人同時
 * 建專案時，各自查都說沒重複、然後都寫進去。unique index 才是最後防線。
 * （欄位維持可空以相容既有資料；新建一律由 API 產生編號。）
 *
 * ── 案情與可見性是兩軸（模組四第 2 條）──────────────────────────────
 *
 * `status` 是**案情**：active 進行中 / suspended 暫停 / closed 結案 /
 * terminated 已解約。`archivedAt` 是**可見性**：還想不想在列表看到它。
 *
 * 混成同一欄會弄丟資訊——要封存一個已解約的案子就得把 terminated 覆寫掉，
 * 「這案子是解約收場」就沒了，而保留款收得到與收不到差別就在這裡。
 *
 * `statusEffectiveOn` 是**法律日期**（解約通知書上的那一天），
 * `statusChangedAt` 是**輸入時點**。解約通知可能是上個月的，這週才進系統；
 * 解約日決定已完成部分的請款範圍與分期獎金的結算基準，用輸入時點會算錯帳。
 * 同一個教訓見模組四第 1 條的「請款 ≠ 開票 ≠ 收款」。
 *
 * 狀態集合刻意寫死不做成設定表：一旦可自訂，「哪些狀態算終止」就寫不死，
 * 之後請款的 gating 要跟著可設定。彈性由 `statusReason` 自由填吸收。
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    /** 專案編號（識別碼，不可變更）。見上方說明。 */
    code: text("code"),
    /** 歸屬年度（分析維度，可調整）。預設同編號的年度。 */
    fiscalYear: integer("fiscal_year"),
    description: text("description"),
    /** 案情。見上方說明；合法值由 api 的 services/project-status.ts 收斂。 */
    status: text("status").notNull().default("active"),
    /** 這次狀態變更的理由。任何變更都必填——擋不了人，但留得下痕跡。 */
    statusReason: text("status_reason"),
    /** 狀態的法律生效日（解約日、結案日）。≠ 輸入時點。 */
    statusEffectiveOn: date("status_effective_on"),
    /** 輸入時點（系統記錄）。 */
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    statusChangedByEmpId: uuid("status_changed_by_emp_id"),
    /** 可見性：非 null 即已封存，列表預設不顯示。與 status 互不干涉。 */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * 人工解除封存的時點。**自動封存看這一欄決定要不要放過這筆**：
     * 有人特地把案子拉回來（多半是在追尾款），排程當晚又把它收起來，
     * 那個功能就等於壞的。案情之後再變動（`statusChangedAt` 更晚）才恢復自動。
     */
    unarchivedAt: timestamp("unarchived_at", { withTimezone: true }),
    /**
     * 預定起訖日——甘特圖與進度示警的依據（都是「預定」，實際結案看 statusEffectiveOn）。
     * 可空：沒填的案子在總覽上以建立日～今天畫虛線，示警會提醒補。
     */
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    deptId: uuid("dept_id").references(() => departments.id),
    leadEmpId: uuid("lead_emp_id"),
    shareMode: text("share_mode").notNull().default("pool_pct"),
    bonusPool: numeric("bonus_pool"),
    // ── P3 專案申請單（模組五）新增 ──────────────────────────────────
    /** 業主／客戶。可空：知識庫舊案未必補得回業主資料。 */
    clientId: uuid("client_id").references(() => clients.id),
    /** 母專案，用於「追加減／加做／估驗」掛回主案。刻意不設 FK
     * （比照 departments.managerEmpId／projects.leadEmpId 的排除理由：
     * 這裡純粹是分類用的軟參照，不是完整性關鍵鏈）。 */
    parentProjectId: uuid("parent_project_id"),
    /** 'main' 主案 | 'change' 追加減 | 'addition' 加做 | 'advance' 估驗（公會制）。 */
    kind: text("kind").notNull().default("main"),
    /** 建案／保留案號的時點，與 createdAt（系統寫入時點）分開。 */
    reservedAt: timestamp("reserved_at", { withTimezone: true }),
    siteAddress: text("site_address"),
    siteAreaM2: numeric("site_area_m2", { precision: 12, scale: 2 }),
    /** 設計範圍（複選），如 ["電機","空調"]。 */
    designScope: jsonb("design_scope").notNull().default([]),
    /** 'duplicate' 二聯式 | 'triplicate' 三聯式。新建時可由 clientId 預填，
     * 專案上可個別覆寫（業主慣例與單一專案的約定可能不同）。 */
    invoiceType: text("invoice_type"),
    /** 'transfer' 匯款 | 'check' 支票。同上，可個別覆寫。 */
    paymentMethod: text("payment_method"),
    closingDay: text("closing_day"),
    paymentDay: text("payment_day"),
    /** 雜項支出（差旅、規費等），計入專案損益但不屬於下包/技師費。 */
    otherExpenses: numeric("other_expenses", { precision: 14, scale: 2 }).notNull().default("0"),
    /** 工程師指派，開放形狀如 {discipline: employeeId[]}。 */
    engineers: jsonb("engineers").notNull().default({}),
    /**
     * 開案日——供「開案日期」WP 使用，區別於 `reservedAt`（建號／保留案號的
     * 時點）與 `startsOn`（預定開工日）。可空：既有案件由 sql/0031 backfill
     * 成 `createdAt`（台北時區）當天；之後新案由 API 視流程另填。
     */
    openedOn: date("opened_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCodeUnique: uniqueIndex("projects_tenant_code_uq").on(table.tenantId, table.code),
  }),
)
