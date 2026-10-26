import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import { logger } from "./lib/logger.js"
import { adminTenantsRouter } from "./routes/admin-tenants.js"
import { tenantRouter } from "./routes/tenant.js"
import { employeesRouter } from "./routes/employees.js"
import { employeeStatementsRouter } from "./routes/employee-statements.js"
import { authAccountsRouter } from "./routes/auth-accounts.js"
import { departmentsRouter } from "./routes/departments.js"
import { shiftsRouter } from "./routes/shifts.js"
import { punchRouter } from "./routes/punch.js"
import { leaveTypesRouter } from "./routes/leave-types.js"
import { approvalFlowsRouter } from "./routes/approval-flows.js"
import { requestsRouter } from "./routes/requests.js"
import { announcementsRouter } from "./routes/announcements.js"
import { meRouter } from "./routes/me.js"
import { ruleConfigRouter } from "./routes/rule-config.js"
import { salaryRouter } from "./routes/salary.js"
import { attendanceRouter } from "./routes/attendance.js"
import { attendanceSheetsRouter } from "./routes/attendance-sheets.js"
import { exportsRouter } from "./routes/exports.js"
import { calendarRouter } from "./routes/calendar.js"
import { calendarImportRouter } from "./routes/calendar-import.js"
import { payrollRouter } from "./routes/payroll.js"
import { payrollPeriodsRouter } from "./routes/payroll-periods.js"
import { payrollAdjustmentsRouter } from "./routes/payroll-adjustments.js"
import { leaveBalancesRouter } from "./routes/leave-balances.js"
import { leaveRegisterRouter } from "./routes/leave-register.js"
import { compTimeRouter } from "./routes/comp-time.js"
import { reportsRouter } from "./routes/reports.js"
import { detectionRouter } from "./routes/detection.js"
import { notificationsRouter } from "./routes/notifications.js"
import { aiRouter } from "./routes/ai.js"
import { demoRouter } from "./routes/demo.js"
import { kpiTemplatesRouter } from "./routes/kpi-templates.js"
import { kpiReviewsRouter } from "./routes/kpi-reviews.js"
import { employeeProfileRouter } from "./routes/employee-profile.js"
import { recruitmentRouter } from "./routes/recruitment.js"
import { payrollTaxRouter } from "./routes/payroll-tax.js"
import { dashboardRouter } from "./routes/dashboard.js"
import { expensesRouter } from "./routes/expenses.js"
import { advancesRouter } from "./routes/advances.js"
import { attachmentsRouter } from "./routes/attachments.js"
import { internalJobsRouter } from "./routes/internal-jobs.js"
import { personalNotesRouter } from "./routes/personal-notes.js"
import { preferencesRouter } from "./routes/preferences.js"
import { projectsRouter } from "./routes/projects.js"
import { projectDocumentsRouter } from "./routes/project-documents.js"
import { projectDuplicateRouter } from "./routes/project-duplicate.js"
import { projectOverviewRouter } from "./routes/project-overview.js"
import { contractsRouter } from "./routes/contracts.js"
import { billingsRouter } from "./routes/billings.js"
import { projectsAnnualRouter } from "./routes/projects-annual.js"
import { subcontractsRouter } from "./routes/subcontracts.js"
import { clientsRouter } from "./routes/clients.js"
import { companiesRouter } from "./routes/companies.js"
import { optionListsRouter } from "./routes/option-lists.js"
import { companyPagesRouter } from "./routes/company-pages.js"
import { employeeMailboxesRouter } from "./routes/employee-mailboxes.js"
import { vendorsRouter } from "./routes/vendors.js"
import { knowledgeRouter } from "./routes/knowledge.js"
import { disbursementsRouter } from "./routes/disbursements.js"
import { disbursementReportsRouter } from "./routes/disbursement-reports.js"
import { leaveSettlementRouter } from "./routes/leave-settlement.js"
import { auditLogsRouter } from "./routes/audit-logs.js"
import { bonusRunsRouter } from "./routes/bonus-runs.js"
import { importsRouter } from "./routes/imports.js"
// 2026-09-23 需求補齊（WP0 先掛空 router 與 no-op middleware，功能 WP 只填檔案內容）
import { overtimeSettlementsRouter } from "./routes/overtime-settlements.js"
import { festivalBonusesRouter } from "./routes/festival-bonuses.js"
import { dutyRostersRouter } from "./routes/duty-rosters.js"
import { profileChangeRequestsRouter } from "./routes/profile-change-requests.js"
import { internalCronRouter } from "./routes/internal-cron.js"
// 2026-10-11 集團總覽
import { groupOverviewRouter } from "./routes/group-overview.js"
import { essTabGuard } from "./middleware/ess-tab-guard.js"
import { periodClosedErrorHandler } from "./middleware/period-closed.js"
import { privilegeErrorHandler } from "./middleware/privilege-error.js"
import { runWithRequestContext } from "./lib/request-context.js"

const WEB_ORIGINS = (process.env.WEB_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)

export const app = express()

// CORS — restrict to the configured web origins.
app.use(
  cors({
    origin: WEB_ORIGINS,
    credentials: true,
  }),
)

// 12mb 是本機／非 Vercel 環境的保險。線上跑在 Vercel serverless，request body 上限約 4.5MB（超過平台直接回
// 413，到不了這裡），所以專案文件經 API 的 base64 上傳只收 ≤3MiB，更大的檔走簽名網址直傳 Storage
// （見 project-documents.ts 的 BASE64_MAX_BYTES／MAX_BYTES）。
app.use(express.json({ limit: "12mb" }))

// 稽核操作者情境：每個請求開一份 AsyncLocalStorage store（lib/request-context.ts），
// 後續 middleware／handler 查到呼叫者 employee 時 setActor()，supabaseAdmin 的
// fetch 就會自動夾 x-actor-emp-id／x-actor-route 給 DB trigger audit_row() 讀。
// `next()` 必須在 run() 內呼叫，Express 5 之後的 middleware／async handler 才會
// 落在同一個 store。route 延遲解析：req.route.path（'/employees/:id' 這種 pattern）
// 要到 route 層 match 後才有。
app.use((req: Request, _res: Response, next: NextFunction) => {
  runWithRequestContext(
    {
      route: () => {
        const pattern = (req.route as { path?: unknown } | undefined)?.path
        return `${req.method} ${typeof pattern === "string" ? pattern : req.path}`
      },
    },
    () => next(),
  )
})

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" })
})

// ESS 分頁限縮的 API 層守門（M20）：所有 feature router 之前；WP0 為 no-op，WP2 填實。
app.use(essTabGuard)

// Feature routes.
app.use(adminTenantsRouter)
app.use(tenantRouter)
app.use(authAccountsRouter) // /employees/bulk-invite、/employees/:id/invite|send-reset、/auth/forgot-password、/me/password*
app.use(employeesRouter)
app.use(employeeStatementsRouter) // /employees/:id/statements、出勤統計表／薪資明細表 xlsx、/my/payslip-statement(s)
app.use(departmentsRouter)
app.use(shiftsRouter)
// 班表（/schedules）2026-10-11 隨班表功能移除（業主：不需要）：端點取消註冊 → 落到下面的 404。
app.use(punchRouter)
app.use(leaveTypesRouter)
app.use(approvalFlowsRouter)
app.use(requestsRouter)
app.use(announcementsRouter)
app.use(meRouter)
app.use(ruleConfigRouter)
app.use(salaryRouter)
app.use(attendanceRouter)
app.use(attendanceSheetsRouter)
app.use(exportsRouter)
app.use(calendarRouter)
app.use(calendarImportRouter) // /calendar/import/*、/calendar/readiness（國定假日年度匯入，services/holiday-import.ts）
app.use(payrollRouter)
app.use(payrollPeriodsRouter) // /payroll-periods*（發薪鎖定：完成本月發薪／重新開放；2026-10-11）
app.use(payrollAdjustmentsRouter) // /payroll-adjustments*（薪資一次性加減項＝前期更正：下月補發或扣回；2026-10-11）
app.use(leaveBalancesRouter)
app.use(leaveRegisterRouter)
app.use(compTimeRouter)
app.use(reportsRouter)
app.use(detectionRouter)
app.use(notificationsRouter)
app.use(aiRouter)
app.use(demoRouter)
app.use(kpiTemplatesRouter)
app.use(kpiReviewsRouter)
app.use(employeeProfileRouter)
app.use(recruitmentRouter)
app.use(payrollTaxRouter)
app.use(dashboardRouter)
app.use(expensesRouter)
app.use(advancesRouter)
app.use(attachmentsRouter)
app.use(internalJobsRouter)
app.use(personalNotesRouter)
app.use(preferencesRouter)
app.use(projectOverviewRouter) // /projects/alerts 要在 /projects/:id 之前
app.use(projectsAnnualRouter) // /projects/annual、/projects/receivables 同上
app.use(projectsRouter)
app.use(projectDuplicateRouter) // /projects/:id/duplicate、/projects/:id/lineage（C2 複製專案）
app.use(projectDocumentsRouter)
app.use(contractsRouter)
app.use(billingsRouter)
app.use(subcontractsRouter)
app.use(clientsRouter)
app.use(companiesRouter)
app.use(optionListsRouter) // /option-lists*（全站共用的選項清單：客戶分類等，登記表在 services/option-lists.ts）
app.use(companyPagesRouter)
app.use(employeeMailboxesRouter)
app.use(vendorsRouter)
app.use(knowledgeRouter)
app.use(disbursementReportsRouter) // /disbursements/pivot、/disbursements/pivot.xlsx 要在 /disbursements/:id 之前
app.use(disbursementsRouter)
app.use(leaveSettlementRouter)
app.use(auditLogsRouter)
app.use(bonusRunsRouter) // /bonus-runs/preview、/bonus-runs/summary 要在 /bonus-runs/:id 之前（D1 獎金季發放批次）
app.use(importsRouter) // /imports/:kind/template、/imports/:kind（批次匯入：Excel 範本下載＋上傳）
// 2026-09-23 需求補齊
app.use(overtimeSettlementsRouter) // /my/overtime-cap、/overtime-settlements*（M1 加班超額另計；WP1）
app.use(festivalBonusesRouter) // /festival-bonuses*（M6 三節獎金；WP7）
app.use(dutyRostersRouter) // /duty-rosters*（M8 值日／總機；WP8）
app.use(profileChangeRequestsRouter) // /profile-change-requests*（W6 員工改資料審核；WP8）
app.use(internalCronRouter) // /internal/leave/annual-grant、/internal/calendar/holiday-import（WP9；排程端點）
// 2026-10-11 集團總覽
app.use(groupOverviewRouter) // /group-overview、/group-overview/detail（跨公司入帳收入／放款支出／專案毛利；HR）

// 404 fallback.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not_found" })
})

// 發薪鎖定：任何寫入端點或服務層丟出的 PeriodClosedError 一律回 409 { error: "period_closed", period }
// （services/period-lock.ts）；其他錯誤交給下面的 500。
app.use(periodClosedErrorHandler)
// 特權帳號邊界（services/privileged-accounts.ts）：PrivilegeError 一律回 403 { error: "not_boss" | "platform_admin_required", message }。
app.use(privilegeErrorHandler)

// Centralised error handler — must be last and have 4 args for Express to
// recognise it as an error handler.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "unhandled error")
  res.status(500).json({ error: "internal_server_error" })
})
