import type { Request, Response, NextFunction } from "express"
import { getUserFromToken } from "../lib/supabase.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { isFinanceRole, isHrRole } from "./scope.js"

/**
 * ESS 分頁限縮的 **API 層**守門（M20）。
 *
 * 在此之前 `tenants.features.essTabs[employment_type]` 只影響前端分頁（`GET /me`
 * 的 `essTabs` → `apps/web/src/lib/ess-tabs.ts visibleTabs`）：實習生看不到「我的
 * 薪資單」分頁，但直接打 `GET /payslips` 仍然拿得到資料。本 middleware 把同一份
 * 清單搬到 API：被限縮的分頁對應的路由一律 403 `ess_tab_disabled`。
 *
 * 設計取捨
 * --------
 * - **對照表沒列到的路由＝不擋**（行為與現況相同，只有前端擋）。寧可漏擋也不要
 *   誤擋：誤擋會讓一個正常員工打不開頁面，漏擋只是維持現狀。
 * - HR／平台管理員／會計**直接放行**：後台頁面與 ESS 共用不少端點（`/employees`、
 *   `/projects`、`/attendance-sheets`…），這些角色本來就不受 essTabs 限制。
 * - `essTabs` 為 null（沒設定的身分類別）＝不限縮，直接放行。
 * - `home`／`announcements` 對應的路由（`/me`、`/punch*`、`/announcements*`）永遠
 *   不擋——與 web 的 `ALWAYS_VISIBLE_TAB_KEYS` 一致（勞基法施行細則 §37 的揭示義務）。
 *
 * 成本
 * ----
 * 本 middleware 掛在 `app.ts` 所有 feature router **之前**，也就是在 `requireAuth`
 * 之前跑，拿不到 `req.auth`，必須自己解 token。為了不讓每個請求都多一次
 * `auth.getUser` 往返：①對照表沒中的路由完全不做 IO；②中了才解，且 token →
 * 身分、租戶 → essTabs 設定各快取 60 秒（同一個人連續操作只會在每分鐘多付一次）。
 *
 * `resolveEssTabs` 的邏輯與 `routes/me.ts:11-24` 相同（同一份 features.essTabs 與
 * intern 預設清單）。刻意在這裡重寫一份而不是從 me.ts 匯出：那個檔案屬於別的工作
 * 包，本輪不動它。**兩邊要一起改**——me.ts 決定前端看得到什麼分頁，這裡決定 API
 * 放不放行，不同步就會出現「看得到但打不開」或反過來。
 */

/** intern 沒另外設定時的 ESS 分頁清單（與 routes/me.ts INTERN_DEFAULT_ESS_TABS 同一份）。 */
const INTERN_DEFAULT_ESS_TABS = ["home", "schedule", "punches", "requests", "notifications", "mydata"]

/**
 * 路由 → ESS 分頁 key 的對照表（順序就是比對順序，**前綴長的排前面**）。
 *
 * `exact` 只比對完全相同的路徑；否則比對「等於 path 或以 `path/` 開頭」。
 * `methods` 省略＝所有方法。key 一律是 `apps/web/src/lib/ess-tabs.ts` 的 `EssTabKey`。
 */
interface RouteTabRule {
  path: string
  tab: string
  exact?: boolean
  methods?: readonly string[]
}

const ROUTE_TABS: readonly RouteTabRule[] = [
  // 「待我簽核」必須排在 /requests 之前，否則會被前綴規則吃掉。
  { path: "/requests/pending-approvals", tab: "approvals" },
  { path: "/requests", tab: "requests" },
  { path: "/leave-balances", tab: "balances" },
  { path: "/my/attendance-sheet", tab: "sheet" },
  { path: "/payslips", tab: "payslips" },
  // 員工端報銷（/expenses、/expense-categories）；HR／會計的設定與結算端點走同一個分頁。
  { path: "/expenses", tab: "expenses" },
  { path: "/expense-categories", tab: "expenses" },
  { path: "/expense-settlements", tab: "expenses" },
  { path: "/advances", tab: "expenses" },
  // 「我的分潤」讀的是分潤資料，不是專案知識庫。
  { path: "/my/bonus-history", tab: "bonus" },
  { path: "/my/project-shares", tab: "bonus" },
  { path: "/projects", tab: "projects" },
  { path: "/kpi-reviews", tab: "kpi" },
  { path: "/kpi-templates", tab: "kpi" },
  { path: "/internal-jobs", tab: "jobs" },
  { path: "/ai", tab: "ai" },
  { path: "/company-pages", tab: "company" },
  { path: "/notifications", tab: "notifications" },
  { path: "/schedules", tab: "schedule" },
]

/** `/employees/:empId/profile`、`/certifications`、`/educations`、`/work-history` → 我的資料。 */
const MYDATA_EMPLOYEE_SUBPATHS = ["profile", "certifications", "educations", "work-history"]
const MYDATA_TOP_PREFIXES = ["/certifications", "/educations", "/work-history"]

function matches(path: string, rule: RouteTabRule): boolean {
  if (rule.exact) return path === rule.path
  return path === rule.path || path.startsWith(`${rule.path}/`) || path.startsWith(`${rule.path}?`)
}

/**
 * 純函式：某個請求屬於哪個 ESS 分頁；不在對照表內回 null（＝不擋）。
 * `path` 是 `req.path`（不含 query string）。
 */
export function tabForRoute(method: string, path: string): string | null {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path

  // 永遠放行：打卡、/me、公告（web 的 ALWAYS_VISIBLE_TAB_KEYS 與打卡本身）。
  if (clean === "/me" || clean.startsWith("/me/")) return null
  if (clean === "/punch" || clean.startsWith("/punch/")) return null
  if (clean === "/announcements" || clean.startsWith("/announcements/")) return null

  // /employees/:id/profile… → mydata（/employees 本身是 HR／會計端點，不在此擋）。
  const emp = /^\/employees\/[^/]+\/([^/?]+)/.exec(clean)
  if (emp && MYDATA_EMPLOYEE_SUBPATHS.includes(emp[1])) return "mydata"
  if (MYDATA_TOP_PREFIXES.some((p) => clean === p || clean.startsWith(`${p}/`))) return "mydata"

  for (const rule of ROUTE_TABS) {
    if (rule.methods && !rule.methods.includes(method.toUpperCase())) continue
    if (matches(clean, rule)) return rule.tab
  }
  return null
}

/* ── 快取（每項 60 秒）────────────────────────────────────────────────── */

const TTL_MS = 60_000

interface Cached<T> {
  value: T
  at: number
}

function fresh<T>(entry: Cached<T> | undefined): entry is Cached<T> {
  return !!entry && Date.now() - entry.at < TTL_MS
}

/** token → 身分（解不出來就是 null，交給後面的 requireAuth 回 401）。 */
const identityCache = new Map<string, Cached<{ tenantId: string; role: string; employmentType: string | null } | null>>()
/** tenantId → tenants.features.essTabs。 */
const featureCache = new Map<string, Cached<Record<string, unknown> | null>>()

/** 測試用：清掉兩份快取。 */
export function resetEssTabGuardCache(): void {
  identityCache.clear()
  featureCache.clear()
}

/**
 * token 會輪替（Supabase 預設 1 小時），舊 key 沒人再查也不會自己消失 → 長跑的
 * API 程序會慢慢累積。超過上限就把過期的清掉（都還沒過期就整份丟掉重來）。
 */
const IDENTITY_CACHE_MAX = 500

function pruneIdentityCache(): void {
  if (identityCache.size <= IDENTITY_CACHE_MAX) return
  const now = Date.now()
  for (const [key, entry] of identityCache) {
    if (now - entry.at >= TTL_MS) identityCache.delete(key)
  }
  if (identityCache.size > IDENTITY_CACHE_MAX) identityCache.clear()
}

async function essTabsCfgOf(tenantId: string): Promise<Record<string, unknown> | null> {
  const hit = featureCache.get(tenantId)
  if (fresh(hit)) return hit.value
  const { data } = await supabaseAdmin.from("tenants").select("features").eq("id", tenantId).maybeSingle()
  const features = (data?.features as Record<string, unknown> | null) ?? null
  const cfg = features?.essTabs
  const value = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? (cfg as Record<string, unknown>) : null
  featureCache.set(tenantId, { value, at: Date.now() })
  return value
}

/**
 * 純函式：身分類別 → 可用分頁清單（null＝不限縮）。與 routes/me.ts resolveEssTabs 同義。
 */
export function essTabsFor(cfg: Record<string, unknown> | null, employmentType: string | null): string[] | null {
  if (employmentType && cfg) {
    const list = cfg[employmentType]
    if (Array.isArray(list)) return list.filter((t): t is string => typeof t === "string")
  }
  if (employmentType === "intern") return INTERN_DEFAULT_ESS_TABS
  return null
}

async function identityOf(token: string): Promise<{ tenantId: string; role: string; employmentType: string | null } | null> {
  const hit = identityCache.get(token)
  if (fresh(hit)) return hit.value
  let value: { tenantId: string; role: string; employmentType: string | null } | null = null
  const user = await getUserFromToken(token)
  const tenantId = user?.appMetadata?.tenant_id
  if (user && typeof tenantId === "string" && tenantId) {
    const { data } = await supabaseAdmin
      .from("employees")
      .select("role, employment_type")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.userId)
      .maybeSingle()
    if (data) {
      value = {
        tenantId,
        role: (data.role as string | null) ?? "",
        employmentType: (data.employment_type as string | null) ?? null,
      }
    }
  }
  identityCache.set(token, { value, at: Date.now() })
  pruneIdentityCache()
  return value
}

/**
 * 被限縮的分頁 → 403 `ess_tab_disabled`。任何一步拿不到資料（token 無效、沒有員工列、
 * 查詢失敗）都 `next()` 放行：這支 middleware 只負責「多擋一層」，不負責認證——
 * 真正的 401／403 由後面的 requireAuth／requireTenant／requireRole 決定。
 */
export async function essTabGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tab = tabForRoute(req.method, req.path)
    if (!tab) {
      next()
      return
    }
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) {
      next()
      return
    }
    const token = header.slice("Bearer ".length).trim()
    if (!token) {
      next()
      return
    }
    const identity = await identityOf(token)
    if (!identity) {
      next()
      return
    }
    // HR／平台管理員／會計不受 essTabs 限制（後台與 ESS 共用端點）。
    if (isHrRole(identity.role) || isFinanceRole(identity.role)) {
      next()
      return
    }
    const allowed = essTabsFor(await essTabsCfgOf(identity.tenantId), identity.employmentType)
    if (allowed == null || allowed.includes(tab)) {
      next()
      return
    }
    res.status(403).json({ error: "ess_tab_disabled", tab })
  } catch {
    // 守門失敗不該讓整個 API 掛掉：退回「只有前端擋」的現況。
    next()
  }
}
