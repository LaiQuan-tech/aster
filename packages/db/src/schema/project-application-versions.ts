import { pgTable, uuid, text, integer, numeric, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core"
import { tenants } from "./tenants"
import { projects } from "./projects"

/**
 * ProjectApplicationVersions — 專案申請單版本（2026-11-10，migration 0090 ＝ sql/0080）。
 *   合約金額（銷售金額未稅）改了 → 申請單變下一版：第一次改時先把改之前的內容存成第 1 版（initial），
 *   再把改後的內容存成第 N+1 版（contract_amount_changed）；也可手動另存（manual）。
 *   snapshot ＝ GET /projects/:id/application 的 application 段（完整財務，不含分潤）。
 *   版本被下一版取代時 API 會把 snapshot 更新成被取代前的最後內容並記 supersededAt（之前它就是即時資料）。
 *   只由 API（service role）存取；RLS 開、無 policy；audit_all。
 */
export const projectApplicationVersions = pgTable(
  "project_application_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    versionNo: integer("version_no").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    trigger: text("trigger").notNull(),
    amountBefore: numeric("amount_before"),
    amountAfter: numeric("amount_after"),
    note: text("note"),
    createdByEmpId: uuid("created_by_emp_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    projectNoUq: uniqueIndex("project_application_versions_project_no_uq").on(t.projectId, t.versionNo),
    tenantProjectIdx: index("project_application_versions_tenant_project_idx").on(t.tenantId, t.projectId),
  }),
)
