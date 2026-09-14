import {
  pgTable, uuid, text, date, smallint, integer, boolean, timestamp, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { attendanceSheets } from "./attendance-sheets"
import { projects } from "./projects"

/**
 * Attendance sheet days — 月表的逐日明細，一張月表（`sheetId`）一個
 * `workDate` 一列。由結算流程從 `attendance_days` 複製/彙總成月表當下的
 * 快照，之後月表被覆核／鎖定，這裡的數字就凍結，不再隨 attendance_days
 * 或規則版本更動而改變（同 attendance_sheets.snapshot 的凍結理由）。
 *
 * `overtimeMinutesComputed`＋分級（`otTier1/2/3Minutes`）是系統試算；
 * `overtimeMinutesOverride` 是人工覆寫，兩者分開存才看得出偏離多少——
 * 覆寫必須填 `overrideReason`（CHECK 見 sql/0027 的
 * attendance_sheet_days_override_chk），比照 project_billings 的
 * overrideAmount/overrideReason 模式。
 *
 * `content`／`outingNote`／`projectId`／`note` 是 Excel 常見的人工補充欄
 * （當日內容、外出事由、支援專案、備註），`anomalyAck` 是使用者對
 * `anomalies` 的確認/註記（如「已知悉，補休已排」），供覆核者一眼看出
 * 哪些異常已被處理過。`sheetId` 設 `onDelete: "restrict"`：月表底下已有
 * 逐日明細時不允許整張母表被刪除。
 */
export const attendanceSheetDays = pgTable(
  "attendance_sheet_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sheetId: uuid("sheet_id")
      .notNull()
      .references(() => attendanceSheets.id, { onDelete: "restrict" }),
    workDate: date("work_date").notNull(),
    weekday: smallint("weekday"),
    dayType: text("day_type"),
    firstIn: timestamp("first_in", { withTimezone: true }),
    lastOut: timestamp("last_out", { withTimezone: true }),
    workedMinutes: integer("worked_minutes").notNull().default(0),
    lateMinutes: integer("late_minutes").default(0),
    earlyLeaveMinutes: integer("early_leave_minutes").default(0),
    overtimeMinutesComputed: integer("overtime_minutes_computed").notNull().default(0),
    otTier1Minutes: integer("ot_tier1_minutes").default(0),
    otTier2Minutes: integer("ot_tier2_minutes").default(0),
    otTier3Minutes: integer("ot_tier3_minutes").default(0),
    outingMinutes: integer("outing_minutes").default(0),
    leaveMinutesComputed: integer("leave_minutes_computed").default(0),
    leaveSummary: text("leave_summary"),
    wfh: boolean("wfh").notNull().default(false),
    anomalies: jsonb("anomalies").notNull().default([]),
    // ── 人工欄（Excel 常見補充內容）──
    overtimeMinutesOverride: integer("overtime_minutes_override"),
    overrideReason: text("override_reason"),
    content: text("content"),
    outingNote: text("outing_note"),
    projectId: uuid("project_id").references(() => projects.id),
    note: text("note"),
    anomalyAck: text("anomaly_ack"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sheetWorkDateUnique: uniqueIndex("attendance_sheet_days_sheet_work_date_uq").on(
      table.sheetId,
      table.workDate,
    ),
    tenantSheetIdx: index("attendance_sheet_days_tenant_sheet_idx").on(
      table.tenantId,
      table.sheetId,
    ),
  }),
)
