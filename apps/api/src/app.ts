import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import { logger } from "./lib/logger.js"
import { adminTenantsRouter } from "./routes/admin-tenants.js"
import { tenantRouter } from "./routes/tenant.js"
import { employeesRouter } from "./routes/employees.js"
import { departmentsRouter } from "./routes/departments.js"
import { shiftsRouter } from "./routes/shifts.js"
import { schedulesRouter } from "./routes/schedules.js"
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
import { payrollRouter } from "./routes/payroll.js"
import { leaveBalancesRouter } from "./routes/leave-balances.js"
import { compTimeRouter } from "./routes/comp-time.js"
import { reportsRouter } from "./routes/reports.js"
import { detectionRouter } from "./routes/detection.js"
import { notificationsRouter } from "./routes/notifications.js"
import { aiRouter } from "./routes/ai.js"
import { demoRouter } from "./routes/demo.js"
import { kpiTemplatesRouter } from "./routes/kpi-templates.js"
import { kpiReviewsRouter } from "./routes/kpi-reviews.js"
import { onboardingsRouter } from "./routes/onboardings.js"
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
import { projectOverviewRouter } from "./routes/project-overview.js"
import { contractsRouter } from "./routes/contracts.js"
import { billingsRouter } from "./routes/billings.js"
import { projectsAnnualRouter } from "./routes/projects-annual.js"
import { subcontractsRouter } from "./routes/subcontracts.js"
import { clientsRouter } from "./routes/clients.js"
import { companiesRouter } from "./routes/companies.js"
import { companyPagesRouter } from "./routes/company-pages.js"
import { employeeMailboxesRouter } from "./routes/employee-mailboxes.js"
import { vendorsRouter } from "./routes/vendors.js"
import { knowledgeRouter } from "./routes/knowledge.js"
import { disbursementsRouter } from "./routes/disbursements.js"

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

// 12mb 容得下專案文件的 base64 上傳（單檔上限 8MB，見 project-documents.ts）。
app.use(express.json({ limit: "12mb" }))

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" })
})

// Feature routes.
app.use(adminTenantsRouter)
app.use(tenantRouter)
app.use(employeesRouter)
app.use(departmentsRouter)
app.use(shiftsRouter)
app.use(schedulesRouter)
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
app.use(payrollRouter)
app.use(leaveBalancesRouter)
app.use(compTimeRouter)
app.use(reportsRouter)
app.use(detectionRouter)
app.use(notificationsRouter)
app.use(aiRouter)
app.use(demoRouter)
app.use(kpiTemplatesRouter)
app.use(kpiReviewsRouter)
app.use(onboardingsRouter)
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
app.use(projectOverviewRouter) // /projects/overview、/projects/alerts 要在 /projects/:id 之前
app.use(projectsAnnualRouter) // /projects/annual、/projects/receivables 同上
app.use(projectsRouter)
app.use(projectDocumentsRouter)
app.use(contractsRouter)
app.use(billingsRouter)
app.use(subcontractsRouter)
app.use(clientsRouter)
app.use(companiesRouter)
app.use(companyPagesRouter)
app.use(employeeMailboxesRouter)
app.use(vendorsRouter)
app.use(knowledgeRouter)
app.use(disbursementsRouter)

// 404 fallback.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not_found" })
})

// Centralised error handler — must be last and have 4 args for Express to
// recognise it as an error handler.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "unhandled error")
  res.status(500).json({ error: "internal_server_error" })
})
