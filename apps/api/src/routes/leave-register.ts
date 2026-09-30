import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { workbookToBuffer, toRocYear } from "../lib/xlsx/attendance-sheet.js"
import { buildLeaveRegisterWorkbook } from "../lib/xlsx/leave-register.js"
import { getEmployeeLeaveRegister } from "../services/leave-register.js"

export const leaveRegisterRouter = Router()

const querySchema = z.object({
  employeeId: z.string().uuid(),
  year: z.coerce.number().int().min(1900).max(2100),
})

function parseQuery(req: Request, res: Response) {
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
    return null
  }
  return parsed.data
}

async function load(req: Request, res: Response) {
  const query = parseQuery(req, res)
  if (!query) return null
  const result = await getEmployeeLeaveRegister(res.locals.tenantId as string, query.employeeId, query.year)
  if (!result) {
    res.status(404).json({ error: "employee_not_found" })
    return null
  }
  return result
}

leaveRegisterRouter.get(
  "/leave-register",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await load(req, res)
      if (result) res.status(200).json(result)
    } catch (err) {
      next(err)
    }
  },
)

leaveRegisterRouter.get(
  "/leave-register/export.xlsx",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await load(req, res)
      if (!result) return
      const workbook = await buildLeaveRegisterWorkbook({
        employeeName: result.employee.name,
        hireDate: result.employee.hireDate,
        register: result.register,
      })
      const buffer = await workbookToBuffer(workbook)
      const filename = `${toRocYear(result.register.year)}年${result.employee.name}請假表.xlsx`
      res
        .status(200)
        .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer)
    } catch (err) {
      next(err)
    }
  },
)
