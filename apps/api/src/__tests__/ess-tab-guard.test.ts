import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { purgeTestTenant } from "./helpers/purge"
import { app } from "../app"
import { essTabsFor, resetEssTabGuardCache, tabForRoute, tabsForRoute } from "../middleware/ess-tab-guard"

/**
 * ESS 分頁限縮的 API 層守門（M20）。
 *
 * 前半段是純函式（對照表與身分類別 → 可用分頁），不打任何 IO。
 * 後半段是 live 合約測試（throwaway 租戶）：實習生打 `GET /payslips` → 403
 * `ess_tab_disabled`，同一支路徑 HR 200；被限縮的人打 `/punch/today`、`/me`、
 * `/announcements`（永遠可見）仍通。
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

describe("tabForRoute（路由 → ESS 分頁對照表，純函式）", () => {
  it("申請與簽核：待我簽核、批次簽核、單筆核准／駁回都是 approvals，其餘 /requests* 是 requests", () => {
    expect(tabForRoute("GET", "/requests/pending-approvals")).toBe("approvals")
    // 簽核動作屬「簽核」分頁（以前被歸在 requests）
    expect(tabForRoute("POST", "/requests/batch-decision")).toBe("approvals")
    expect(tabForRoute("POST", "/requests/abc-123/approve")).toBe("approvals")
    expect(tabForRoute("POST", "/requests/abc-123/reject")).toBe("approvals")
    expect(tabForRoute("POST", "/requests/batch-decision/")).toBe("approvals") // 結尾斜線正規化
    // 送單、撤回、補附件、提醒、出差報告、註銷、換簽核人仍是「請假申請」
    expect(tabForRoute("GET", "/requests")).toBe("requests")
    expect(tabForRoute("POST", "/requests")).toBe("requests")
    expect(tabForRoute("POST", "/requests/abc-123/cancel")).toBe("requests")
    expect(tabForRoute("POST", "/requests/abc-123/attachments")).toBe("requests")
    expect(tabForRoute("POST", "/requests/abc-123/remind")).toBe("requests")
    expect(tabForRoute("POST", "/requests/abc-123/change-approver")).toBe("requests")
    expect(tabForRoute("PATCH", "/requests/abc-123/trip-report")).toBe("requests")
    expect(tabForRoute("DELETE", "/requests/abc-123")).toBe("requests")
    // 只認 /requests/:id/approve|reject 的完整形狀，不會誤傷長得像的路徑
    expect(tabForRoute("POST", "/requests/abc-123/approve/extra")).toBe("requests")
    expect(tabForRoute("POST", "/requests/abc-123/approved")).toBe("requests")
    expect(tabForRoute("POST", "/requests/approve")).toBe("requests")
    expect(tabForRoute("POST", "/requests-archive/abc/approve")).toBeNull()
    expect(tabForRoute("POST", "/disbursements/abc/approve")).toBeNull() // 放款單的簽核不在 ESS 分頁對照表
  })

  it("申請單附件：GET 申請人（請假申請）與簽核者（簽核）共用，其他方法仍只屬請假申請", () => {
    // 簽核頁看病假憑證等附件就是打 GET /requests/:id/attachments——只開「簽核」的主管也要拿得到
    expect(tabsForRoute("GET", "/requests/abc-123/attachments")).toEqual(["requests", "approvals"])
    expect(tabForRoute("GET", "/requests/abc-123/attachments")).toBe("requests") // 主要分頁（403 回報的）
    expect(tabsForRoute("POST", "/requests/abc-123/attachments")).toEqual(["requests"])
    expect(tabsForRoute("DELETE", "/requests/abc-123/attachments/att-1")).toEqual(["requests"])
    // 其他路由都只有一個分頁
    expect(tabsForRoute("POST", "/requests/abc-123/approve")).toEqual(["approvals"])
    expect(tabsForRoute("GET", "/requests")).toEqual(["requests"])
    expect(tabsForRoute("GET", "/me")).toEqual([])
    expect(tabsForRoute("GET", "/leave-types")).toEqual([])
  })

  it("路徑大小寫不影響歸類（Express 的路由不分大小寫，改個大小寫不能繞過分頁限縮）", () => {
    expect(tabForRoute("POST", "/requests/abc-123/APPROVE")).toBe("approvals")
    expect(tabForRoute("POST", "/requests/abc-123/Reject")).toBe("approvals")
    expect(tabForRoute("POST", "/Requests/Batch-Decision")).toBe("approvals")
    expect(tabForRoute("POST", "/REQUESTS/BATCH-DECISION/")).toBe("approvals")
    expect(tabForRoute("GET", "/Requests/Pending-Approvals")).toBe("approvals")
    expect(tabForRoute("POST", "/REQUESTS")).toBe("requests")
    expect(tabForRoute("GET", "/PAYSLIPS")).toBe("payslips")
    expect(tabForRoute("GET", "/Leave-Balances")).toBe("balances")
    expect(tabForRoute("PUT", "/Employees/E1/Profile")).toBe("mydata")
    expect(tabsForRoute("GET", "/REQUESTS/abc/ATTACHMENTS")).toEqual(["requests", "approvals"])
    // 永遠放行的路由大小寫變化也照放行
    expect(tabForRoute("GET", "/ME")).toBeNull()
    expect(tabForRoute("POST", "/Punch")).toBeNull()
    expect(tabForRoute("GET", "/ANNOUNCEMENTS")).toBeNull()
  })

  it("其餘分頁：假別餘額／月表／薪資單／報銷／分潤／專案／考核／職缺／AI／公司／通知／班表", () => {
    expect(tabForRoute("GET", "/leave-balances")).toBe("balances")
    expect(tabForRoute("GET", "/my/attendance-sheet")).toBe("sheet")
    expect(tabForRoute("GET", "/payslips")).toBe("payslips")
    expect(tabForRoute("GET", "/payslips/abc")).toBe("payslips")
    expect(tabForRoute("GET", "/expenses")).toBe("expenses")
    expect(tabForRoute("GET", "/expense-categories")).toBe("expenses")
    expect(tabForRoute("GET", "/advances")).toBe("expenses")
    expect(tabForRoute("GET", "/my/bonus-history")).toBe("bonus")
    expect(tabForRoute("GET", "/my/project-shares")).toBe("bonus")
    expect(tabForRoute("GET", "/projects")).toBe("projects")
    expect(tabForRoute("GET", "/projects/abc/members")).toBe("projects")
    expect(tabForRoute("GET", "/kpi-reviews")).toBe("kpi")
    expect(tabForRoute("GET", "/internal-jobs")).toBe("jobs")
    expect(tabForRoute("POST", "/ai/ask")).toBe("ai")
    expect(tabForRoute("GET", "/company-pages")).toBe("company")
    expect(tabForRoute("GET", "/notifications/unread-count")).toBe("notifications")
    // 個人班表（/schedules）2026-10-11 隨班表功能移除：端點已取消註冊，不在對照表
    expect(tabForRoute("GET", "/schedules")).toBeNull()
  })

  it("我的資料：/employees/:id/profile 與個人履歷子資源 → mydata；/employees 本身不擋", () => {
    expect(tabForRoute("PUT", "/employees/e1/profile")).toBe("mydata")
    expect(tabForRoute("POST", "/employees/e1/profile/photo")).toBe("mydata")
    expect(tabForRoute("GET", "/employees/e1/certifications")).toBe("mydata")
    expect(tabForRoute("GET", "/employees/e1/educations")).toBe("mydata")
    expect(tabForRoute("GET", "/employees/e1/work-history")).toBe("mydata")
    expect(tabForRoute("DELETE", "/certifications/c1")).toBe("mydata")
    expect(tabForRoute("GET", "/employees")).toBeNull()
  })

  it("永遠放行：/me、打卡、公告；對照表沒列到的路由也放行（＝維持現況，只有前端擋）", () => {
    expect(tabForRoute("GET", "/me")).toBeNull()
    expect(tabForRoute("POST", "/punch")).toBeNull()
    expect(tabForRoute("GET", "/punch/today")).toBeNull()
    expect(tabForRoute("GET", "/announcements")).toBeNull()
    expect(tabForRoute("POST", "/announcements/a1/acknowledgements")).toBeNull()
    expect(tabForRoute("GET", "/leave-types")).toBeNull()
    expect(tabForRoute("GET", "/health")).toBeNull()
    expect(tabForRoute("GET", "/payroll/runs")).toBeNull()
  })

  it("前綴不會誤傷同字首的別支路由；結尾斜線正規化", () => {
    // /projects 不該吃掉 /project-settings、/project-documents
    expect(tabForRoute("GET", "/project-settings")).toBeNull()
    expect(tabForRoute("GET", "/requests-archive")).toBeNull()
    expect(tabForRoute("GET", "/requests/")).toBe("requests")
  })
})

describe("essTabsFor（身分類別 → 可用分頁，純函式；與 routes/me.ts 同義）", () => {
  it("有設定就用設定；intern 沒設定用預設清單；其他身分類別 null＝不限縮", () => {
    expect(essTabsFor({ intern: ["home", "requests"] }, "intern")).toEqual(["home", "requests"])
    expect(essTabsFor(null, "intern")).toEqual(["home", "punches", "requests", "notifications", "mydata"])
    expect(essTabsFor(null, "regular")).toBeNull()
    expect(essTabsFor({ parttime: ["home"] }, "regular")).toBeNull()
    expect(essTabsFor({}, null)).toBeNull()
  })

  it("設定值不是陣列（後台打錯）→ 當成沒設定；陣列裡的非字串忽略", () => {
    expect(essTabsFor({ intern: "home" }, "intern")).toEqual([
      "home",
      "punches",
      "requests",
      "notifications",
      "mydata",
    ])
    expect(essTabsFor({ parttime: ["home", 3, null, "requests"] }, "parttime")).toEqual(["home", "requests"])
  })
})

/* ── live：實習生的 API 限權 ─────────────────────────────────────────── */

const ready = !!SUPABASE_URL && !!SUPABASE_ANON_KEY
const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let adminToken: string
let internToken: string

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

function as(token: string, req: request.Test) {
  return req.set("Authorization", `Bearer ${token}`)
}

describe.skipIf(!ready)("essTabGuard — live（實習生只看得到預設分頁）", () => {
  beforeAll(async () => {
    const adminEmail = `esstab-${stamp}-admin@example.com`
    const adminPassword = `Pw-${stamp}-Admin-Aa1!`
    const p = await provisionTenant({ name: `ESSTAB ${stamp}`, adminEmail, adminPassword })
    createdTenantIds.push(p.tenantId)
    createdUserIds.push(p.userId)
    adminToken = await signIn(adminEmail, adminPassword)

    const internEmail = `esstab-${stamp}-intern@example.com`
    const internPassword = `Pw-${stamp}-Intern-Bb2!`
    const res = await as(adminToken, request(app).post("/employees")).send({
      email: internEmail,
      name: `實習生-${stamp}`,
      password: internPassword,
      role: "employee",
      employmentType: "intern",
    })
    if (res.status !== 201) throw new Error(`createEmployee(intern) ${res.status}: ${JSON.stringify(res.body)}`)
    createdUserIds.push(res.body.userId)
    internToken = await signIn(internEmail, internPassword)
    // 這個租戶是新建的，快取裡不可能有它的舊值；保險起見清一次。
    resetEssTabGuardCache()
  }, 120_000)

  afterAll(async () => {
    for (const tid of createdTenantIds) {
      try {
        await purgeTestTenant(tid)
      } catch (err) {
        console.warn(`[ess-tab-guard] purge ${tid} 失敗：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid).catch(() => undefined)
    resetEssTabGuardCache()
  }, 60_000)

  it("GET /me 回 essTabs 預設清單（不含 payslips）", async () => {
    const res = await as(internToken, request(app).get("/me"))
    expect(res.status).toBe(200)
    expect(res.body.employmentType).toBe("intern")
    expect(res.body.essTabs).toEqual(["home", "punches", "requests", "notifications", "mydata"])
  })

  it("實習生打 GET /payslips → 403 ess_tab_disabled；同一支 HR 200", async () => {
    const blocked = await as(internToken, request(app).get("/payslips"))
    expect(blocked.status).toBe(403)
    expect(blocked.body.error).toBe("ess_tab_disabled")
    expect(blocked.body.tab).toBe("payslips")

    const hr = await as(adminToken, request(app).get("/payslips"))
    expect(hr.status).toBe(200)
  })

  it("實習生打不在清單內的其他分頁（/leave-balances、/my/bonus-history）也 403", async () => {
    const balances = await as(internToken, request(app).get("/leave-balances"))
    expect(balances.status).toBe(403)
    expect(balances.body.error).toBe("ess_tab_disabled")
    const bonus = await as(internToken, request(app).get("/my/bonus-history"))
    expect(bonus.status).toBe(403)
    expect(bonus.body.error).toBe("ess_tab_disabled")
  })

  it("清單內的分頁與永遠可見的路由照常：/requests 200、/punch/today 200、/announcements 200", async () => {
    const requests = await as(internToken, request(app).get("/requests?scope=mine"))
    expect(requests.status).toBe(200)
    const punch = await as(internToken, request(app).get("/punch/today"))
    expect(punch.status).toBe(200)
    const ann = await as(internToken, request(app).get("/announcements"))
    expect(ann.status).toBe(200)
  })

  it("沒有 token 的請求不由本 middleware 處理（維持 401，不是 403）", async () => {
    const res = await request(app).get("/payslips")
    expect(res.status).toBe(401)
  })
})
