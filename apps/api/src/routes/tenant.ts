import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { resolveSelf } from "../middleware/scope.js"
import { writeAuditLog } from "../services/audit.js"
import { canEditUnlockList, sameEmployeeSet, unlockPolicyOf } from "../services/period-lock.js"

export const tenantRouter = Router()

/**
 * GET /api/tenant/branding — white-label config for the caller's own tenant.
 * Returns { branding, features }. Tenant is resolved from the JWT, so a user
 * can only ever read their own tenant's branding.
 */
tenantRouter.get(
  "/api/tenant/branding",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("tenants")
        .select("branding, features")
        .eq("id", tenantId)
        .single()

      if (error || !data) {
        res.status(404).json({ error: "tenant_not_found" })
        return
      }
      res.status(200).json({ branding: data.branding, features: data.features })
    } catch (err) {
      next(err)
    }
  },
)

export const tenantSettingsSchema = z.object({
  branding: z
    .object({
      appName: z.string().trim().min(1).optional(),
      primaryColor: z.string().trim().min(1).optional(),
      logoUrl: z.string().trim().url().optional().or(z.literal("")),
    })
    .optional(),
  features: z
    .object({
      /**
       * 未收款追蹤（B5）：逾期天數起算基準。'billed'＝已請款未開票也算逾期（預設，
       * 沒設定時走這個）；'invoiced'＝維持舊行為，只從開票日起算。
       * 見 apps/api/src/services/project-money.ts 的 overdueDays。
       */
      receivable: z
        .object({
          overdueBasis: z.enum(["billed", "invoiced"]).optional(),
        })
        .optional(),
      permissions: z
        .array(
          z.object({
            module: z.string().trim().min(1),
            unit: z.string().trim().min(1),
            desc: z.string().trim().optional(),
            account: z.string().trim().optional(),
            enabled: z.boolean().optional(),
          }),
        )
        .optional(),
      internalLinks: z
        .array(
          z.object({
            name: z.string().trim().min(1),
            url: z.string().trim().url(),
            enabled: z.boolean().optional(),
            sort: z.number().int().optional(),
          }),
        )
        .optional(),
      dashboardWidgets: z.array(z.string().trim().min(1)).optional(),
      site: z
        .object({
          employeePortalPath: z.string().trim().min(1).optional(),
          adminPortalPath: z.string().trim().min(1).optional(),
        })
        .optional(),
      /** 專屬 Email 配發：公司網域與地址命名規則（後台「專屬 Email 配發」頁）。 */
      mail: z
        .object({
          domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "domain 格式").optional(),
          /** 預設 local part 來源：emp_no（工號）或 manual（每人手填） */
          rule: z.enum(["emp_no", "manual"]).optional(),
          provider: z.enum(["google", "microsoft", "other"]).optional(),
        })
        .optional(),
      /**
       * 簽核（A2）：找不到直屬主管時的簽核者（老闆）。簽核鏈順序見
       * services/approval-chain.ts：固定名單 → 直屬主管 → 這裡 → 第一位 hr_admin。
       * null＝清除設定。
       */
      approval: z
        .object({
          fallbackApproverEmpId: z.string().uuid().nullable().optional(),
        })
        .optional(),
      /**
       * ESS 分頁限縮：employment_type → 可見的分頁 key 清單（例如
       * { intern: ["home","schedule","punches","requests","notifications","mydata"] }）。
       * 沒列的身分類別＝全部可見；tab key 定義見 apps/web/src/components/EssHeader.tsx。
       */
      essTabs: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1))).optional(),
      /**
       * 後台導覽的隱藏模組開關：module key → 是否列在分頁列（true 才顯示，缺席＝隱藏，直開網址不擋）。
       * key 定義見 apps/web/src/lib/admin-nav.ts 的 ADMIN_MODULES（前端只讀認得的 key）。
       */
      adminModules: z.record(z.string().trim().min(1), z.boolean()).optional(),
      /**
       * 出勤月表（B8 假單月底核銷）approve 關卡：預設 false（月表異常
       * unsettled_leave_in_period 只是 warn）；true 時升級為 error，approve
       * 前必須先核銷完當月已核准假單。見 routes/attendance-sheets.ts 的
       * approve 409 檢查與 services/attendance-sheets.ts 的 computeAnomalies。
       */
      attendance: z
        .object({
          blockApproveOnUnsettledLeave: z.boolean().optional(),
        })
        .optional(),
      /**
       * 發薪鎖定（2026-10-11）：`periodUnlockEmpIds`＝老闆指定「可以重新開放已結算月份」的員工（預設空陣列）。
       * 老闆（features.approval.fallbackApproverEmpId）本人永遠能解鎖，不必列在名單裡。
       * **只有老闆（或 platform_admin）能改這份名單**——其他人（含 HR）帶了不同的名單 → 403 `not_boss`
       * （見 PUT /api/tenant/settings）。名單裡的人必須是本租戶的員工。
       * ⚠️ 這支端點本身是 requireHrAdmin：老闆要是 hr_admin／platform_admin 才進得了（本系統的老闆就是 hr_admin，
       * 見 routes/group-overview.ts）。另外「誰是老闆」（approval.fallbackApproverEmpId）目前任何 HR 都能改，
       * 所以 HR 並沒有被技術性地擋在解鎖之外。要不要把「換老闆」也收成老闆／platform_admin 專屬（以及限制誰能把角色
       * 設成 platform_admin），是權限模型的決定，目前沒做（已回報業主）。
       */
      payroll: z
        .object({
          periodUnlockEmpIds: z.array(z.string().uuid()).max(50).optional(),
        })
        .optional(),
      /**
       * 帳號安全：allowWeakInitialPassword=true 時，HR 配發的密碼略過 Supabase 的弱密碼／外洩
       * 密碼（HIBP）檢查——POST /employees（建帳號、帶 password）改以 bcrypt hash 交給 GoTrue
       * createUser（password_hash）；POST /employees/:id/reset-password 帶 password（後台「設定
       * 密碼」）則繞過 GoTrue 直接寫 auth.users（sql/0038 auth_set_user_password）。兩者都是
       * HR 知道、員工下次登入就會被強制改掉的密碼；員工自設密碼（/me/password、set-password）
       * 仍走 GoTrue 檢查。見 services/password-policy.ts。
       */
      accounts: z
        .object({
          allowWeakInitialPassword: z.boolean().optional(),
        })
        .optional(),
      /**
       * 規則參數頁「表單參數」與「差勤模組設定」兩張卡（module-settings/page.tsx）。
       * 2026-09-20 前這兩個鍵沒宣告在這裡，zod 會整個 strip 掉——前端存了、畫面顯示成功、
       * DB 裡卻沒有，下次進頁面又變回預設值。目前只有前端讀，API 端沒有邏輯依賴。
       */
      formParameters: z
        .object({
          myDataRequiresApproval: z.boolean().optional(),
          editableFields: z.array(z.string().trim().min(1)).max(50).optional(),
          attachmentLimitKb: z.number().int().min(1).max(50_000).optional(),
        })
        .optional(),
      attendanceModule: z
        .object({
          activeYear: z.string().trim().regex(/^\d{4}$/).optional(),
          yearStatus: z.enum(["draft", "published", "locked"]).optional(),
          workCalendar: z.string().trim().max(60).optional(),
          attendanceCutoffDay: z.number().int().min(1).max(31).optional(),
          allowEmployeeDispute: z.boolean().optional(),
          enableAutoSettlement: z.boolean().optional(),
        })
        .optional(),
      /**
       * 角色可用範圍（W4 會計角色；2026-09-22 業主決策 3「範圍做成進階功能可勾選」）。
       * `accountant.sections`：後台可見分區 key 清單；`accountant.tabs`：分區 key →
       * 可見分頁 key 清單（分區沒列＝該區全部）。key 定義見 apps/web/src/lib/admin-nav.ts
       * 的 ADMIN_SECTIONS／ADMIN_TABS（roleNavOf 只讀認得的 key）；沒設定時前端用
       * ACCOUNTANT_DEFAULT_NAV。設定頁整鍵覆蓋。API 端守門不讀這裡（requireFinance／
       * canSeeBonus 是寫死的），這只影響導覽可見性。
       */
      roles: z
        .object({
          accountant: z
            .object({
              sections: z.array(z.string().trim().min(1)).max(20).optional(),
              tabs: z.record(z.string().trim().min(1), z.array(z.string().trim().min(1)).max(40)).optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
})

tenantRouter.put(
  "/api/tenant/settings",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = tenantSettingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const { data: current, error: currentErr } = await supabaseAdmin
        .from("tenants")
        .select("branding, features")
        .eq("id", tenantId)
        .single()
      if (currentErr || !current) {
        res.status(404).json({ error: "tenant_not_found" })
        return
      }

      const branding = {
        ...((current.branding as Record<string, unknown>) ?? {}),
        ...((parsed.data.branding as Record<string, unknown> | undefined) ?? {}),
      }
      const currentFeatures = (current.features as Record<string, unknown>) ?? {}
      const incomingFeatures = (parsed.data.features as Record<string, unknown> | undefined) ?? {}
      const features: Record<string, unknown> = { ...currentFeatures, ...incomingFeatures }
      // payroll 是巢狀設定：合併而不是整鍵覆蓋，之後在裡面加別的設定不會被只帶 periodUnlockEmpIds 的請求洗掉。
      if (incomingFeatures.payroll !== undefined) {
        features.payroll = {
          ...((currentFeatures.payroll as Record<string, unknown> | undefined) ?? {}),
          ...(incomingFeatures.payroll as Record<string, unknown>),
        }
      }

      // 發薪鎖定的解鎖名單（features.payroll.periodUnlockEmpIds）：比對「合併後」與目前的名單（不是只看請求有沒有帶
      // 這個鍵——否則帶 `payroll: {}` 之類的請求也能改到）。名單有變更，呼叫者必須是老闆（或 platform_admin），
      // 否則 403 not_boss；老闆是以**目前**設定的人為準（同一個請求不能一邊換老闆一邊改名單）。
      const before = unlockPolicyOf(currentFeatures)
      const after = unlockPolicyOf(features)
      const unlockListChanged = !sameEmployeeSet(before.designatedEmpIds, after.designatedEmpIds)
      let unlockActorId: string | null = null
      if (unlockListChanged) {
        const userId = req.auth?.userId
        const self = userId ? await resolveSelf(tenantId, userId) : null
        if (!self || !canEditUnlockList(before, self)) {
          res.status(403).json({ error: "not_boss", message: "只有老闆可以指定誰能重新開放已結算的月份" })
          return
        }
        unlockActorId = self.id
        if (after.designatedEmpIds.length > 0) {
          const { data: found, error: foundErr } = await supabaseAdmin
            .from("employees")
            .select("id")
            .eq("tenant_id", tenantId)
            .in("id", after.designatedEmpIds)
          if (foundErr) {
            next(new Error(`PUT /api/tenant/settings (unlock employees): ${foundErr.message}`))
            return
          }
          const known = new Set(((found ?? []) as Array<{ id: string }>).map((r) => r.id.toLowerCase()))
          const unknown = after.designatedEmpIds.filter((id) => !known.has(id))
          if (unknown.length > 0) {
            res.status(400).json({ error: "invalid_employee", employeeIds: unknown })
            return
          }
        }
      }
      // 請求有帶名單就存成去重、小寫的 id（比對一律小寫）——沒變更時也一樣，不留大小寫不一的髒值。
      if ((incomingFeatures.payroll as { periodUnlockEmpIds?: unknown } | undefined)?.periodUnlockEmpIds !== undefined) {
        features.payroll = {
          ...((features.payroll as Record<string, unknown> | undefined) ?? {}),
          periodUnlockEmpIds: after.designatedEmpIds,
        }
      }

      const { data, error } = await supabaseAdmin
        .from("tenants")
        .update({ branding, features })
        .eq("id", tenantId)
        .select("branding, features")
        .single()
      if (error || !data) {
        next(new Error(`PUT /api/tenant/settings: ${error?.message}`))
        return
      }
      if (unlockListChanged) {
        await writeAuditLog({
          tenantId,
          tableName: "tenants",
          recordId: tenantId,
          action: "UPDATE",
          oldRow: { payroll: { periodUnlockEmpIds: before.designatedEmpIds } },
          newRow: { payroll: { periodUnlockEmpIds: after.designatedEmpIds } },
          actorEmpId: unlockActorId,
          context: "PUT /api/tenant/settings — 老闆指定可重新開放已結算月份的人",
        })
      }
      res.status(200).json({ branding: data.branding, features: data.features })
    } catch (err) {
      next(err)
    }
  },
)
