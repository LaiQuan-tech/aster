import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { logger } from "../lib/logger.js"
import { departmentsHaveManagerList, employeesHaveCompany } from "../lib/schema-compat.js"
import { employeesHavePersonalSettings } from "../services/employee-shifts.js"
import { normalizeEmployeeFeatures } from "../services/employee-features.js"
import { canGrantGroupFinancials, canSeeGroupFinancials, canSeeGroupOverview } from "../services/financial-visibility.js"
import { loadProjectBossEmpId } from "../services/project-scope.js"

export const meRouter = Router()

/**
 * intern 沒另外設定時的 ESS 分頁清單；其他身分類別預設全部（null）。
 * 「個人班表」（schedule）2026-10-11 隨班表功能移除（與 middleware/ess-tab-guard.ts、web ess-tabs.ts 同步）。
 */
const INTERN_DEFAULT_ESS_TABS = ["home", "punches", "requests", "notifications", "mydata"]

async function resolveEssTabs(tenantId: string, employmentType: string | null): Promise<string[] | null> {
  const { data } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  const features = (data?.features as Record<string, unknown> | null) ?? null
  const cfg = features?.essTabs
  if (employmentType && cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const list = (cfg as Record<string, unknown>)[employmentType]
    if (Array.isArray(list)) return list.filter((t): t is string => typeof t === "string")
  }
  if (employmentType === "intern") return INTERN_DEFAULT_ESS_TABS
  return null
}

/**
 * B7：是否為任一部門的主管（manager_emp_id，或在多級簽核的 manager_emp_ids 任一順位）；
 * 前台據此判斷要不要顯示「待我簽核」等主管功能。manager_emp_ids 欄位尚未套用
 * （migration 0049）時退回只看 manager_emp_id。
 */
async function isDeptManager(tenantId: string, empId: string): Promise<boolean> {
  const multi = await departmentsHaveManagerList()
  let q = supabaseAdmin.from("departments").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
  q = multi ? q.or(`manager_emp_id.eq.${empId},manager_emp_ids.cs.{${empId}}`) : q.eq("manager_emp_id", empId)
  const { count, error } = await q
  if (error) throw new Error(`isDeptManager: ${error.message}`)
  return (count ?? 0) > 0
}

/**
 * 本人的所屬公司（migration 0072）。員工列的 company_id 與公司名冊並行查（名冊是小表，整張讀回再對）；
 * 欄位未套 → null；任何查詢錯誤 → null＋warn（只是顯示用，不能讓 /me 整支 500、把人擋在登入後）。
 */
async function loadOwnCompany(tenantId: string, empId: string): Promise<{ companyId: string | null; companyName: string | null }> {
  const none = { companyId: null, companyName: null }
  try {
    if (!(await employeesHaveCompany())) return none
    const [own, roster] = await Promise.all([
      supabaseAdmin.from("employees").select("company_id").eq("tenant_id", tenantId).eq("id", empId).maybeSingle(),
      supabaseAdmin.from("companies").select("id, name").eq("tenant_id", tenantId),
    ])
    if (own.error || roster.error) {
      logger.warn({ tenantId, empId, employeeError: own.error?.message ?? null, companiesError: roster.error?.message ?? null }, "GET /me: 讀所屬公司失敗，回 null")
      return none
    }
    const companyId = (own.data as { company_id?: string | null } | null)?.company_id ?? null
    if (!companyId) return none
    const company = ((roster.data ?? []) as Array<{ id: string; name: string }>).find((c) => c.id === companyId)
    return { companyId, companyName: company?.name ?? null }
  } catch (err) {
    logger.warn({ tenantId, empId, err: err instanceof Error ? err.message : String(err) }, "GET /me: 讀所屬公司失敗，回 null")
    return none
  }
}

/**
 * GET /me — the authenticated caller's own employee profile in their tenant.
 *
 * Resolves the employees row from req.auth.userId + res.locals.tenantId (both
 * derived from the JWT, so a user can only ever read themselves). Returns
 * { id, name, role, deptId, empNo, status, email, mustChangePassword,
 *   employmentType, essTabs, isManager } — email comes from the auth user,
 * the rest from the employees row (isManager 另查 departments，見 isDeptManager)．
 * 404 when the token's user has no employee row in this tenant (e.g. a
 * platform operator with no staff record).
 *
 * `mustChangePassword`：HR 配發暫時密碼時為 true，前端 AuthGate 據此把人導去
 * /auth/set-password?mode=change。`essTabs`：由 `tenants.features.essTabs[employment_type]`
 * 取；沒設定時 intern 用預設清單，其他身分回 null（＝全部分頁）。
 *
 * 員工個人設定（2026-10-13，migration 0068；未套 → features 全關、defaultShift null）：
 *   `features: { wfhPunch }`——員工端據此決定要不要顯示「在家上班」勾選框；
 *   `defaultShift: { id, name, start, end } | null`——個人預設班別（沒有＝依公司規則／彈性上班）。
 *
 * 員工所屬公司（2026-10-25，migration 0072；未套 → 兩個都 null）：`companyId`、`companyName`。
 *
 * `canSeeGroupFinancials`（2026-10-26）：看不看得到集團財務（專案毛利、獎金批次毛利、獎金分潤總表）——
 * 老闆／platform_admin／被授權的 hr_admin（features.seeGroupFinancials）。`canGrantGroupFinancials`：
 * 能不能在員工編輯頁授權別人（老闆／platform_admin）。見 services/financial-visibility.ts。
 * `canSeeGroupOverview`（2026-10-27）：看不看得到首頁的集團總覽區塊與本年收入／毛利率——只有在職 platform_admin
 * （業主：「只有平台管理員才看得到」；與 GET /group-overview 的 403 同一條規則 canSeeGroupOverview）。
 *
 * Open to any authenticated tenant member: the ESS uses it to detect HR admins
 * (to surface the back-office link) and the admin console uses it as its gate.
 */
meRouter.get(
  "/me",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    try {
      const { data, error } = await supabaseAdmin
        .from("employees")
        .select("id, name, role, dept_id, emp_no, status, employment_type, must_change_password")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .maybeSingle()

      if (error) {
        next(new Error(`GET /me: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }

      // 個人設定：另查一次（欄位可能還沒套，不能塞進上面的 select 讓整支 /me 500）。
      let features = normalizeEmployeeFeatures(null)
      let defaultShift: { id: string; name: string; start: string; end: string } | null = null
      if (await employeesHavePersonalSettings()) {
        const { data: personal, error: personalErr } = await supabaseAdmin
          .from("employees")
          .select("features, default_shift_id")
          .eq("tenant_id", tenantId)
          .eq("id", data.id as string)
          .maybeSingle()
        if (personalErr) throw new Error(`GET /me (personal settings): ${personalErr.message}`)
        const row = personal as { features?: unknown; default_shift_id?: string | null } | null
        features = normalizeEmployeeFeatures(row?.features)
        if (row?.default_shift_id) {
          const { data: shift, error: shiftErr } = await supabaseAdmin
            .from("shifts")
            .select("id, name, start_time, end_time")
            .eq("tenant_id", tenantId)
            .eq("id", row.default_shift_id)
            .maybeSingle()
          if (shiftErr) throw new Error(`GET /me (default shift): ${shiftErr.message}`)
          if (shift) {
            defaultShift = {
              id: shift.id as string,
              name: shift.name as string,
              start: shift.start_time as string,
              end: shift.end_time as string,
            }
          }
        }
      }

      // 所屬公司：同樣另查（0072 未套時不能塞進主 select）。讀不到（任何錯誤）→ 兩個都 null＋warn，不讓 /me 500。
      const { companyId, companyName } = await loadOwnCompany(tenantId, data.id as string)

      const employmentType = (data.employment_type as string | null) ?? null
      const self = { id: data.id as string, role: data.role as string }
      // 查老闆失敗 → 兩個集團財務旗標降級為 false＋warn，不讓 /me 500（只是導覽可見性，API 各自守門）。
      let bossLookupOk = true
      let bossEmpId: string | null = null
      try {
        bossEmpId = await loadProjectBossEmpId(tenantId)
      } catch (err) {
        bossLookupOk = false
        logger.warn({ tenantId, empId: data.id, err: err instanceof Error ? err.message : String(err) }, "GET /me: 讀老闆設定失敗，集團財務旗標回 false")
      }
      res.status(200).json({
        id: data.id,
        name: data.name,
        role: data.role,
        deptId: data.dept_id,
        empNo: data.emp_no,
        status: data.status,
        email: req.auth?.email ?? null,
        mustChangePassword: data.must_change_password === true,
        employmentType,
        essTabs: await resolveEssTabs(tenantId, employmentType),
        isManager: await isDeptManager(tenantId, data.id as string),
        features,
        defaultShift,
        companyId,
        companyName,
        canSeeGroupFinancials: bossLookupOk && canSeeGroupFinancials(self, bossEmpId, features),
        canGrantGroupFinancials: bossLookupOk && canGrantGroupFinancials(self, bossEmpId),
        canSeeGroupOverview: canSeeGroupOverview({ role: data.role as string, status: data.status as string | null }),
      })
    } catch (err) {
      next(err)
    }
  },
)
