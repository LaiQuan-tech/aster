import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { setActor } from "../lib/request-context.js"
import { clientIpOf } from "../lib/client-ip.js"
import { writeAuditLog } from "../services/audit.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { dayWindowUtc, localParts, todayKey } from "../lib/tz.js"
import { logger } from "../lib/logger.js"
import { checkPunchCooldown, cooldownSeconds, statusFromRecords } from "../services/punch-guard.js"
import { assertInstantsOpen } from "../services/period-lock.js"
import { importManualPunches } from "../services/imports/writers.js"
import { lateMinutesForArrival, type ArrivalLateness } from "../services/settlement.js"
import { checkWfhPunch, loadEmployeeFeatures } from "../services/employee-features.js"
import { punchRecordsHaveWfh } from "../lib/schema-compat.js"
import {
  LATE_REASON_MAX,
  attachPunchToLateReport,
  normalizeLateReason,
  notifyLateReport,
  recordLateReport,
} from "../services/late-reports.js"
import { lateReportsRouter } from "./late-reports.js"

export const punchRouter = Router()
// 遲到說明 API（GET /late-reports、POST /late-reports/:id/decision）由打卡產生，掛在打卡路由底下。
punchRouter.use(lateReportsRouter)

// "YYYY-MM-DD".
const dateRe = /^\d{4}-\d{2}-\d{2}$/

const punchSchema = z.object({
  // type is optional — when omitted we infer it from the employee's last punch
  // today (none / last 'out' → 'in'; last 'in' → 'out').
  // Work in/out plus 休息/外出 pairs. Inference (omitted type) only
  // applies to work in/out; break/outing must be explicit.
  type: z.enum(["in", "out", "break_in", "break_out", "outing_in", "outing_out"]).optional(),
  source: z.enum(["gps", "web", "line"]).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  deviceId: z.string().trim().min(1).optional(),
  // 2026-09-30：沒拿到座標時，前端帶來的定位失敗原因（見 punch_records.geo_status
  // 的 CHECK，migrations/0051）。有 lat/lng 時就算帶了也會被忽略（見下方 insert）。
  geoStatus: z.enum(["denied", "unavailable", "timeout", "unsupported"]).optional(),
  // 2026-10-11 遲到理由：當天第一張上班卡遲到時必填（trim 後 1–500 字，見下方 POST /punch）。
  // 沒遲到時帶了也不理會。
  lateReason: z.string().max(5000).optional(),
  // 2026-10-13 在家上班打卡：只有 employees.features.wfhPunch 開通的員工能帶 true（否則 400
  // wfh_punch_not_enabled）；寫進 punch_records.wfh，月表該日標「在家工作」，工時照打卡算。
  wfh: z.boolean().optional(),
  // NOTE: we deliberately do NOT read employeeId from the body. The punch is
  // always recorded for the token owner (anti-proxy-punch). Any employeeId a
  // client sends is ignored — kept lax here so a stray field doesn't 400.
})

const querySchema = z.object({
  employeeId: z.string().uuid().optional(),
  deptId: z.string().uuid().optional(),
  type: z.enum(["in", "out", "break_in", "break_out", "outing_in", "outing_out"]).optional(),
  source: z.enum(["gps", "web", "line", "manual"]).optional(),
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
  // punch_at 排序；預設 asc（員工端 /ess/punches 靠升冪建每日列，不可改預設）。
  order: z.enum(["asc", "desc"]).optional(),
  // 帶了就不論角色一律鎖回呼叫者自己（忽略 employeeId/deptId）。給 ESS 打卡紀錄頁用，
  // 修 hr_admin/platform_admin 在員工端反而看到全公司資料的 bug。
  mine: z.enum(["1", "true"]).optional(),
})

const SELECT_COLS_BASE = "id, tenant_id, employee_id, punch_at, type, source, lat, lng, device_id, geo_status"
/** 打卡列表欄位：0068 套了就多撈 wfh（在家上班打卡），員工端打卡紀錄／今日狀態據此標「在家」。 */
async function selectCols(withIp = false): Promise<string> {
  const base = (await punchRecordsHaveWfh()) ? `${SELECT_COLS_BASE}, wfh` : SELECT_COLS_BASE
  return withIp ? `${base}, ip_address` : base
}
// 打卡來源 IP（0060 punch_records.ip_address）只給 HR 的後台列表：GET /punch 在 HR 且非 mine 時才多撈
// （selectCols(true)），序列化成 ipAddress（見 withIpAddress）。員工端查詢（/punch/today、mine=1、一般員工）
// 一律 selectCols()，連欄位都不撈。

/** 把 DB 的 ip_address 換成回應用的 ipAddress（沒有就 null），其餘欄位原樣。 */
function withIpAddress(row: Record<string, unknown>): Record<string, unknown> {
  const { ip_address: ipAddress, ...rest } = row
  return { ...rest, ipAddress: typeof ipAddress === "string" ? ipAddress : null }
}

// [start, end) UTC instants covering "today" on the TENANT's clock
// (tenants.timezone, default Asia/Taipei) — used to scope today's punches and
// to infer the next in/out. Deterministic regardless of the host timezone.
async function todayWindow(tenantId: string): Promise<{ start: string; end: string }> {
  const tz = await getTenantTimezone(tenantId)
  const { startIso, endIso } = dayWindowUtc(todayKey(tz), tz)
  return { start: startIso, end: endIso }
}

// Resolve the caller's own employee row (id + role) in this tenant, or null.
async function resolveSelf(
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`resolve self employee: ${error.message}`)
  if (data) setActor(data.id as string) // 稽核：本請求後續 DB 寫入由 trigger 記 actor
  return data ? { id: data.id as string, role: data.role as string } : null
}

function isHrRole(role: string | undefined): boolean {
  return !!role && ["hr_admin", "platform_admin"].includes(role)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 遲到理由（2026-10-11 業主拍板）：這張上班卡是不是**當天（租戶時區）第一張上班卡**、而且遲到。
 * 不是第一張、沒遲到、或沒有應上班時間（例假日沒排班）→ null。遲到分鐘與月結同一個引擎算
 * （settlement.lateMinutesForArrival：整分鐘比較、扣午休與已核准請假）。
 * 判斷本身出錯時記 warn 並放行（null）——不能讓打卡因為遲到檢查掛掉；月表照樣會記遲到。
 */
async function firstInLateness(tenantId: string, employeeId: string, now: Date): Promise<ArrivalLateness | null> {
  try {
    const { start, end } = await todayWindow(tenantId)
    const { data: prior, error: priorErr } = await supabaseAdmin
      .from("punch_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("employee_id", employeeId)
      .eq("type", "in")
      .gte("punch_at", start)
      .lt("punch_at", end)
      .limit(1)
      .maybeSingle()
    if (priorErr) throw new Error(`first in: ${priorErr.message}`)
    if (prior) return null
    const lateness = await lateMinutesForArrival({ tenantId, employeeId, arrivalAt: now })
    return lateness.lateMinutes > 0 ? lateness : null
  } catch (err) {
    logger.warn({ err, tenantId, employeeId }, "POST /punch: late check failed — punch allowed without late reason")
    return null
  }
}

/**
 * POST /punch — the authenticated employee clocks in/out for THEMSELVES.
 *
 * Anti-proxy-punch: the employee_id written is always derived from the token
 * (req.auth.userId → employees row in this tenant); any employeeId in the body
 * is ignored. A caller with no employee row in this tenant gets 403.
 *
 * If `type` is omitted it is inferred from the employee's last punch today:
 * no punch yet / last was 'out' → 'in'; last was 'in' → 'out'. Optional
 * source/lat/lng/deviceId are stored as given (source defaults to 'web').
 *
 * Cooldown（連按防呆）: before inferring or writing anything we load the
 * employee's most recent punch (any type, any day). If it is younger than
 * `PUNCH_COOLDOWN_SECONDS` (default 1; see services/punch-guard.ts) the
 * request is refused with
 *   409 { error: "punch_too_soon", retryAfterSeconds, last: { id, type, punchAt } }
 * so a double tap on the front page yields exactly one row. HR back-fills
 * (`/punch/manual`, `/punch/manual/import`) are NOT subject to the cooldown.
 *
 * 201 body: `{ id, type, punchAt, source, lat, lng, deviceId, record }` —
 * the original three fields keep their names and types; `record` is the full
 * stored row (snake_case, as `GET /punch/today` lists it) so the client can
 * optimistically append it without a refetch.
 *
 * 打卡 IP（0060）：寫入時記下 `ip_address`（lib/client-ip.ts：x-forwarded-for 第一段 →
 * x-real-ip → req.ip，不合法存 null）。IP 只給 HR 在後台看，員工自己的 201 回應
 * 不帶——`record` 也剝掉 ip_address。HR 補登（/punch/manual、匯入）不記 IP。
 *
 * 遲到理由（2026-10-11，沒有人可以免）：當天第一張上班卡若遲到（沒排班的工作日＝晚於彈性時窗
 * 10:00；有排班＝晚於班別上班時間；整分鐘比較，10:00:59 不算），body 必須帶 `lateReason`
 * （trim 後 1–500 字），否則
 *   400 { error: "late_reason_required", lateMinutes, threshold, punchTime, workDate }
 * 而且**不寫打卡**。帶了就先寫 late_reports（一人一天一筆，老闆的決定欄位不動）、再寫打卡、
 * 把打卡 id 掛回去，第一次寫入時通知直屬主管與老闆；201 多帶 `lateReport: { id, lateMinutes }`。
 * 手動補登（/punch/manual）與匯入不要求理由。
 *
 * 發薪鎖定（2026-10-11）：當下所在的月份（租戶時區）已結算 → 409 `{ error: "period_closed", period }`，
 * 不寫打卡也不寫遲到說明（正常情況當月不會是已結算月，這是提早結算的特例）。
 */
punchRouter.post(
  "/punch",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = punchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { type, source, lat, lng, deviceId, geoStatus, wfh } = parsed.data
    const now = new Date()

    try {
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        // No employee identity in this tenant → cannot punch (and definitely
        // cannot punch for anyone else).
        res.status(403).json({ error: "not_an_employee" })
        return
      }

      // 在家上班打卡：沒開通卻帶 wfh=true → 400，不寫打卡（services/employee-features.ts）。
      const wfhRequested = wfh === true
      if (wfhRequested) {
        const guard = checkWfhPunch(wfh, await loadEmployeeFeatures(tenantId, self.id))
        if (!guard.ok) {
          res.status(400).json({ error: guard.error })
          return
        }
      }

      // 發薪鎖定：當下所在的月份（租戶時區）已結算 → 409 period_closed（提早結算的特例；services/period-lock.ts）。
      await assertInstantsOpen(tenantId, now.toISOString())

      // Cooldown check against the employee's most recent punch of ANY type on
      // ANY day (a double tap does not care about the tenant's day boundary).
      // Runs before inference so a refused request never reads as "out".
      // Skipped entirely when the window is 0 (disabled / test setup).
      const seconds = cooldownSeconds()
      if (seconds > 0) {
        const { data: recent, error: recentErr } = await supabaseAdmin
          .from("punch_records")
          .select("id, type, punch_at")
          .eq("tenant_id", tenantId)
          .eq("employee_id", self.id)
          .order("punch_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (recentErr) {
          next(new Error(`POST /punch (cooldown): ${recentErr.message}`))
          return
        }
        const guard = checkPunchCooldown(
          recent ? { punch_at: recent.punch_at as string } : null,
          now,
          seconds,
        )
        if (!guard.ok && recent) {
          res.set("Retry-After", String(guard.retryAfterSeconds))
          res.status(409).json({
            error: "punch_too_soon",
            retryAfterSeconds: guard.retryAfterSeconds,
            last: { id: recent.id, type: recent.type, punchAt: recent.punch_at },
          })
          return
        }
      }

      // Infer in/out from today's last punch when the client didn't specify.
      let resolvedType = type
      if (!resolvedType) {
        const { start, end } = await todayWindow(tenantId)
        const { data: last, error: lastErr } = await supabaseAdmin
          .from("punch_records")
          .select("type")
          .eq("tenant_id", tenantId)
          .eq("employee_id", self.id)
          .in("type", ["in", "out"]) // break/outing punches don't flip work state
          .gte("punch_at", start)
          .lt("punch_at", end)
          .order("punch_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        if (lastErr) {
          next(new Error(`POST /punch (infer): ${lastErr.message}`))
          return
        }
        resolvedType = last?.type === "in" ? "out" : "in"
      }

      // 遲到理由：當天第一張上班卡遲到 → 沒帶理由就擋下（不寫打卡）。
      const lateness = resolvedType === "in" ? await firstInLateness(tenantId, self.id, now) : null
      let lateReason: string | null = null
      let punchTime = ""
      if (lateness) {
        const tz = await getTenantTimezone(tenantId)
        const parts = localParts(now, tz)
        punchTime = `${pad2(parts.hh)}:${pad2(parts.mm)}`
        lateReason = normalizeLateReason(parsed.data.lateReason)
        if (!lateReason) {
          if (typeof parsed.data.lateReason === "string" && parsed.data.lateReason.trim().length > LATE_REASON_MAX) {
            res.status(400).json({
              error: "invalid_body",
              details: { formErrors: [], fieldErrors: { lateReason: [`遲到原因最多 ${LATE_REASON_MAX} 字`] } },
            })
            return
          }
          res.status(400).json({
            error: "late_reason_required",
            lateMinutes: lateness.lateMinutes,
            threshold: lateness.threshold,
            punchTime,
            workDate: lateness.workDate,
          })
          return
        }
      }

      // 先存遲到說明再寫打卡：打卡寫進去就刪不掉（forbid_hard_delete），反過來才不會有
      // 「遲到卻沒有理由」的打卡。表不存在（舊庫）→ null，照常打卡。
      const lateReport =
        lateness && lateReason
          ? await recordLateReport({
              tenantId,
              employeeId: self.id,
              workDate: lateness.workDate,
              punchAt: now.toISOString(),
              lateMinutes: lateness.lateMinutes,
              reason: lateReason,
            })
          : null

      const { data, error } = await supabaseAdmin
        .from("punch_records")
        .insert({
          tenant_id: tenantId,
          employee_id: self.id,
          type: resolvedType,
          source: source ?? "web",
          lat: lat ?? null,
          lng: lng ?? null,
          device_id: deviceId ?? null,
          // 有座標就不需要原因（一律 null，蓋掉任何亂帶的值）；沒座標才寫 geoStatus。
          geo_status: lat != null && lng != null ? null : (geoStatus ?? null),
          // 來源 IP（只有員工自己打卡才記，見 lib/client-ip.ts；取不到或不合法 → null）。
          ip_address: clientIpOf(req),
          // 打卡時間＝這個請求檢查（冷卻、遲到）用的同一刻：秒數邊界（10:00:59.8 檢查不算遲到、
          // DB 晚一點寫成 10:01:00.1）才不會讓月結多出一筆沒有遲到說明的遲到。
          punch_at: now.toISOString(),
          // 只在勾了才帶欄位：沒勾＝DB 預設 false，舊庫（0068 未套）一般打卡照常寫得進去。
          ...(wfhRequested ? { wfh: true } : {}),
        })
        .select("*")
        .single()

      if (error || !data) {
        next(new Error(`POST /punch: ${error?.message}`))
        return
      }

      // 打卡已經寫進去了：之後的掛 id／通知出錯只記 warn、照樣回 201（回 500 會讓員工重試、
      // 多出一張上班卡）。
      if (lateReport && lateness && lateReason) {
        try {
          await attachPunchToLateReport(tenantId, lateReport.id, data.id as string)
          if (lateReport.needsNotify) {
            const { data: emp } = await supabaseAdmin
              .from("employees")
              .select("name")
              .eq("tenant_id", tenantId)
              .eq("id", self.id)
              .maybeSingle()
            await notifyLateReport({
              tenantId,
              employeeId: self.id,
              employeeName: ((emp as { name?: string | null } | null)?.name ?? "").trim() || "同仁",
              reportId: lateReport.id,
              workDate: lateness.workDate,
              punchHm: punchTime,
              lateMinutes: lateness.lateMinutes,
              reason: lateReason,
            })
          }
        } catch (err) {
          logger.warn({ err, tenantId, lateReportId: lateReport.id }, "POST /punch: late report follow-up failed (punch already saved)")
        }
      }

      // IP 只給 HR（GET /punch 後台列表）看：員工自己的回應不帶，record 也剝掉。
      const { ip_address: _ipAddress, ...record } = data
      res.status(201).json({
        id: data.id,
        type: data.type,
        punchAt: data.punch_at,
        source: data.source,
        lat: data.lat,
        lng: data.lng,
        deviceId: data.device_id,
        wfh: data.wfh === true,
        record,
        ...(lateReport && lateness ? { lateReport: { id: lateReport.id, lateMinutes: lateness.lateMinutes } } : {}),
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /punch/today — the caller's own punches for today (chronological) plus a
 * derived status: 'working' if the most recent work in/out punch today was
 * 'in', else 'off'. break_* / outing_* punches are ignored for the status
 * (see statusFromRecords) so a break never reads as "已下班" on the front
 * page. A caller with no employee row returns an empty list and status 'off'.
 */
punchRouter.get(
  "/punch/today",
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
      const self = await resolveSelf(tenantId, userId)
      if (!self) {
        res.status(200).json({ records: [], status: "off" })
        return
      }

      const { start, end } = await todayWindow(tenantId)
      const { data, error } = await supabaseAdmin
        .from("punch_records")
        .select(await selectCols())
        .eq("tenant_id", tenantId)
        .eq("employee_id", self.id)
        .gte("punch_at", start)
        .lt("punch_at", end)
        .order("punch_at", { ascending: true })

      if (error) {
        next(new Error(`GET /punch/today: ${error.message}`))
        return
      }
      const records = data ?? []
      const status = statusFromRecords(records as unknown as Array<{ type: string }>)
      res.status(200).json({ records, status })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /punch?employeeId=&from=&to=&mine=&order= — list punch records.
 *
 * Role-based scoping (on top of the always-on tenant filter):
 *   • `mine=1`/`mine=true` → forced to the CALLER's own employee row regardless
 *     of role, ignoring employeeId/deptId. Used by the ESS 打卡紀錄 page so an
 *     hr_admin/platform_admin looking at their OWN history doesn't fall through
 *     to the HR branch below and see the whole tenant's punches.
 *   • HR admin / platform admin (no `mine`) → may see the whole tenant; honours
 *     an optional employeeId filter and from/to (YYYY-MM-DD) date window.
 *   • Any other role → forced to their OWN employee row regardless of the
 *     employeeId param (passing someone else's id reveals nothing).
 *
 * `order` (default "asc", or "desc") sorts by punch_at server-side — Supabase
 * caps a single query at 1000 rows, so sorting client-side after the fact could
 * silently drop the newest rows once from/to spans a large range. The admin
 * 打卡紀錄 page always requests desc; ESS's daily-list building relies on the
 * asc default and must not change it.
 *
 * Uses supabaseAdmin (bypasses RLS); the explicit filters are the load-bearing
 * guard. from/to are inclusive calendar days on the tenant's clock (`to` is
 * expanded to the end of that local day).
 *
 * 打卡 IP：只有 HR／平台管理員且沒帶 `mine` 時（＝後台打卡紀錄列表）每列多一個
 * `ipAddress`（string｜null；補登／匯入／舊資料為 null）。`mine=1`（員工端「我的打卡」，
 * HR 看自己也算）與一般員工的回應完全沒有 IP 欄位——連 DB 欄位都不撈。
 */
punchRouter.get(
  "/punch",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }

    const parsed = querySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", details: parsed.error.flatten() })
      return
    }
    const { employeeId, deptId, type, source, from, to, order, mine } = parsed.data

    try {
      const self = await resolveSelf(tenantId, userId)
      const isHr = isHrRole(self?.role)

      // IP 只回給後台列表（HR 且非 mine）；其餘情境不撈欄位。
      const includeIp = isHr && !mine
      let query = supabaseAdmin
        .from("punch_records")
        .select(await selectCols(includeIp))
        .eq("tenant_id", tenantId)

      if (mine) {
        // Caller explicitly asked for "my own" — pin to self no matter the role,
        // and ignore employeeId/deptId entirely (an HR admin's own history page
        // must never fall through to the whole-tenant branch below).
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      } else if (isHr) {
        if (employeeId) query = query.eq("employee_id", employeeId)
        if (deptId) {
          const { data: deptEmployees, error: deptErr } = await supabaseAdmin
            .from("employees")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("dept_id", deptId)
          if (deptErr) {
            next(new Error(`GET /punch (dept employees): ${deptErr.message}`))
            return
          }
          const ids = (deptEmployees ?? []).map((employee) => employee.id as string)
          query = ids.length > 0 ? query.in("employee_id", ids) : query.eq("employee_id", "00000000-0000-0000-0000-000000000000")
        }
      } else {
        // Non-HR: always pinned to self. No employee row → impossible filter →
        // empty result (never another user's data).
        query = query.eq("employee_id", self?.id ?? "00000000-0000-0000-0000-000000000000")
      }

      if (type) query = query.eq("type", type)
      if (source) query = query.eq("source", source)
      if (from || to) {
        const tz = await getTenantTimezone(tenantId)
        if (from) query = query.gte("punch_at", dayWindowUtc(from, tz).startIso)
        if (to) query = query.lt("punch_at", dayWindowUtc(to, tz).endIso)
      }

      const { data, error } = await query.order("punch_at", { ascending: order !== "desc" })
      if (error) {
        next(new Error(`GET /punch: ${error.message}`))
        return
      }
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
      res.status(200).json({ records: includeIp ? rows.map(withIpAddress) : rows })
    } catch (err) {
      next(err)
    }
  },
)

// 補登 body — HR back-fills a punch for an employee (打卡紀錄維護的
// 批次打卡補登/忘打卡補登). Explicit employeeId + timestamp + type.
const manualSchema = z.object({
  employeeId: z.string().uuid(),
  punchAt: z.string().datetime(),
  type: z.enum(["in", "out", "break_in", "break_out", "outing_in", "outing_out"]),
})

const manualImportSchema = z.object({
  csv: z.string().min(1, "csv is required"),
})

type ManualPunchInput = z.infer<typeof manualSchema>

function canonicalManualHeader(h: string): keyof ManualPunchInput | null {
  switch (h.trim().toLowerCase()) {
    case "employeeid":
    case "employee_id":
      return "employeeId"
    case "punchat":
    case "punch_at":
      return "punchAt"
    case "type":
      return "type"
    default:
      return null
  }
}

function parseManualPunchCsv(csv: string): {
  records: ManualPunchInput[]
  errors: { line: number; error: string }[]
} {
  const lines = csv.split(/\r?\n/).map((line) => line.trim())
  const nonEmpty = lines.filter((line) => line.length > 0)
  const result: { records: ManualPunchInput[]; errors: { line: number; error: string }[] } = {
    records: [],
    errors: [],
  }
  if (nonEmpty.length < 2) {
    result.errors.push({ line: 0, error: "csv needs a header row and at least one data row" })
    return result
  }

  const headers = nonEmpty[0].split(",").map(canonicalManualHeader)
  nonEmpty.slice(1).forEach((line, i) => {
    const lineNo = i + 2
    const cells = line.split(",")
    const raw: Record<string, string> = {}
    headers.forEach((key, col) => {
      if (!key) return
      const val = (cells[col] ?? "").trim()
      if (val.length > 0) raw[key] = val
    })
    const parsed = manualSchema.safeParse(raw)
    if (!parsed.success) {
      result.errors.push({
        line: lineNo,
        error: parsed.error.issues.map((issue) => issue.message).join("; "),
      })
      return
    }
    result.records.push(parsed.data)
  })
  return result
}

/**
 * POST /punch/manual/import — HR-admin bulk back-fills manual punch records from
 * CSV. Header row: employeeId,punchAt,type. Invalid lines are skipped and
 * returned in errors so HR can fix only the failed rows.
 * 發薪鎖定：任何一列的打卡時間落在已結算月 → 整批 409 period_closed（寫入段在
 * services/imports/writers.ts importManualPunches，xlsx 匯入共用）。
 */
punchRouter.post(
  "/punch/manual/import",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = manualImportSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const { records, errors } = parseManualPunchCsv(parsed.data.csv)
    if (records.length === 0) {
      res.status(400).json({ error: "no_valid_rows", errors })
      return
    }

    try {
      // 寫入段抽到 services/imports/writers.ts（xlsx 匯入 POST /imports/punches 共用）：
      // 先驗同租戶員工、逐筆 employee_not_found、source='manual'。行號沿用原本的
      // 「有效紀錄序 + 2」（parser 已把壞行剔掉，這是既有行為）。
      const { ids, errors: writeErrors } = await importManualPunches(
        tenantId,
        records.map((record, index) => ({ ...record, line: index + 2 })),
        "POST /punch/manual/import",
      )
      errors.push(...writeErrors)
      if (ids.length === 0) {
        res.status(400).json({ error: "no_valid_rows", errors })
        return
      }
      res.status(201).json({ imported: ids, count: ids.length, errors })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /punch/manual — HR-admin creates a punch record on someone's behalf
 * (source='manual' so audits can tell back-fills from real punches). The target
 * employee must belong to this tenant → otherwise 404. 打卡時間（租戶時區）落在已結算月
 * → 409 period_closed。
 */
punchRouter.post(
  "/punch/manual",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = manualSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    const { employeeId, punchAt, type } = parsed.data
    try {
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", employeeId)
        .maybeSingle()
      if (empErr) {
        next(new Error(`POST /punch/manual (employee): ${empErr.message}`))
        return
      }
      if (!emp) {
        res.status(404).json({ error: "employee_not_found" })
        return
      }
      // 發薪鎖定：補登的打卡時間落在已結算月 → 409 period_closed（services/period-lock.ts）。
      await assertInstantsOpen(tenantId, punchAt)
      const { data, error } = await supabaseAdmin
        .from("punch_records")
        .insert({
          tenant_id: tenantId,
          employee_id: employeeId,
          punch_at: punchAt,
          type,
          source: "manual",
          // 不記 IP（ip_address 留 NULL）：IP 代表「本人打卡當下的來源」，HR 代填的沒有意義。
        })
        .select("id")
        .single()
      if (error || !data) {
        next(new Error(`POST /punch/manual: ${error?.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "punch_records",
        recordId: data.id as string,
        action: "INSERT",
        newRow: { employee_id: employeeId, punch_at: punchAt, type, source: "manual" },
        context: "POST /punch/manual — HR 補登打卡",
      })
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
