import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { taipeiToday } from "../services/project-status"
import { autoArchiveProjects } from "../services/project-archive"
import { app } from "../app"

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string

/** 編號的年度＝建立年（台北）。測試與程式取同一個來源。 */
const YEAR = Number(taipeiToday().slice(0, 4))
/** P3 起編號格式預設 AT-民國年-流水號（見 services/project-code.ts）。 */
const ROC = YEAR - 1911

async function signIn(email: string, password: string): Promise<string> {
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`signIn(${email}) failed: ${error?.message}`)
  return data.session.access_token
}

function createProject(body: Record<string, unknown>) {
  return request(app)
    .post("/projects")
    .set("Authorization", `Bearer ${adminToken}`)
    .send(body)
}

beforeAll(async () => {
  const name = `PROJTEST ${stamp}`
  const adminEmail = `proj-${stamp}-admin@example.com`
  const adminPassword = `Pw-${stamp}-Aa1!`
  const provisioned = await provisionTenant({ name, adminEmail, adminPassword })
  tenantId = provisioned.tenantId
  createdTenantIds.push(provisioned.tenantId)
  createdUserIds.push(provisioned.userId)
  adminToken = await signIn(adminEmail, adminPassword)
}, 60_000)

afterAll(async () => {
  for (const tid of createdTenantIds) {
    await supabaseAdmin.from("project_share_adjustments").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_members").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_documents").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_billings").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("contracts").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("project_settings").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("projects").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("audit_logs").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("employees").delete().eq("tenant_id", tid)
    await supabaseAdmin.from("tenants").delete().eq("id", tid)
  }
  for (const uid of createdUserIds) await supabaseAdmin.auth.admin.deleteUser(uid)
}, 60_000)

describe("M4-1 專案編號 — 系統產號", () => {
  let firstId: string

  it("第一個案子拿到 AT-{民國建立年}-001", async () => {
    const res = await createProject({ name: "官網改版" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`AT-${ROC}-001`)
    firstId = res.body.id
  })

  it("流水號遞增", async () => {
    const res = await createProject({ name: "倉儲系統" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`AT-${ROC}-002`)
  })

  it("歸屬年度未指定時預設為建立年", async () => {
    const res = await request(app)
      .get(`/projects/${firstId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.project.fiscalYear).toBe(YEAR)
  })

  it("建立時可指定與建立年不同的歸屬年度（12 月談成、1 月立案）", async () => {
    const res = await createProject({ name: "跨年案", fiscalYear: YEAR - 1 })
    expect(res.status).toBe(201)
    // 編號仍是建立年——編號不表達歸屬。
    expect(res.body.code).toBe(`AT-${ROC}-003`)

    const got = await request(app)
      .get(`/projects/${res.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.fiscalYear).toBe(YEAR - 1)
  })
})

describe("M4-1 專案編號 — 人工指定（匯入舊案）", () => {
  it("可人工指定編號", async () => {
    const res = await createProject({ name: "民國 112 年舊案", code: "ABC-999" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe("ABC-999")
  })

  it("人工編號不參與流水號計算，下一個自動號不會被推高", async () => {
    // ABC-999 若被算進去，這裡會變成 AT-{ROC}-1000。
    const res = await createProject({ name: "後續案" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`AT-${ROC}-004`)
  })

  it("撞號回 409，不自動改號——人工指定代表那個號有意義", async () => {
    const res = await createProject({ name: "又一個舊案", code: "ABC-999" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_taken")
  })

  it("人工指定既有的系統編號一樣擋下", async () => {
    const res = await createProject({ name: "手打撞到自動號", code: `AT-${ROC}-001` })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_taken")
  })
})

describe("M4-1 專案編號 — 不可變更", () => {
  let projectId: string
  let originalCode: string

  beforeAll(async () => {
    const res = await createProject({ name: "已出合約的案子" })
    projectId = res.body.id
    originalCode = res.body.code
  })

  it("PATCH 帶 code 回 409，不是靜默忽略", async () => {
    const res = await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "NEW-001" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_immutable")
  })

  it("編號確實沒被改掉", async () => {
    const res = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.project.code).toBe(originalCode)
  })

  it("同一次請求裡夾帶 code，其餘欄位也不會被寫入（整筆拒絕）", async () => {
    const res = await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "NEW-002", name: "改過的名字" })
    expect(res.status).toBe(409)

    const got = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.name).toBe("已出合約的案子")
  })

  it("歸屬年度可以改，編號不動", async () => {
    const res = await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fiscalYear: YEAR - 1 })
    expect(res.status).toBe(200)

    const got = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.fiscalYear).toBe(YEAR - 1)
    expect(got.body.project.code).toBe(originalCode)
  })
})

describe("M4-1 專案編號 — 租戶隔離", () => {
  it("另一租戶的流水號從 001 重新開始", async () => {
    const otherEmail = `proj-${stamp}-b@example.com`
    const otherPassword = `Pw-${stamp}-Bb1!`
    const other = await provisionTenant({
      name: `PROJTEST-B ${stamp}`,
      adminEmail: otherEmail,
      adminPassword: otherPassword,
    })
    createdTenantIds.push(other.tenantId)
    createdUserIds.push(other.userId)
    const otherToken = await signIn(otherEmail, otherPassword)

    const res = await request(app)
      .post("/projects")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "別家的第一個案子" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`AT-${ROC}-001`)
    expect(other.tenantId).not.toBe(tenantId)
  }, 60_000)
})

describe("M4-2 案情狀態", () => {
  let projectId: string

  beforeAll(async () => {
    const res = await createProject({ name: "狀態測試案" })
    projectId = res.body.id
  })

  function patch(body: Record<string, unknown>) {
    return request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body)
  }

  function get(id = projectId) {
    return request(app).get(`/projects/${id}`).set("Authorization", `Bearer ${adminToken}`)
  }

  it("新建的專案是進行中", async () => {
    const res = await get()
    expect(res.body.project.status).toBe("active")
    expect(res.body.project.archivedAt).toBeNull()
  })

  it("改狀態沒填理由回 400", async () => {
    const res = await patch({ status: "suspended" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("status_reason_required")
  })

  it("舊制的 archived 不再是合法狀態", async () => {
    const res = await patch({ status: "archived", statusReason: "x" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
  })

  it("填了理由就能暫停，並記下生效日與輸入時點", async () => {
    const res = await patch({
      status: "suspended",
      statusReason: "業主要求緩辦，等都審",
      statusEffectiveOn: "2026-08-01",
    })
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.status).toBe("suspended")
    expect(got.body.project.statusReason).toBe("業主要求緩辦，等都審")
    // 法律生效日是填的那天，不是今天。
    expect(got.body.project.statusEffectiveOn).toBe("2026-08-01")
    expect(got.body.project.statusChangedAt).not.toBeNull()
  })

  it("轉解約也留下理由，且蓋掉的是案情不是紀錄", async () => {
    const res = await patch({
      status: "terminated",
      statusReason: "業主資金斷鏈，依約第 12 條終止",
      statusEffectiveOn: "2026-09-01",
    })
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.status).toBe("terminated")
    expect(got.body.project.statusEffectiveOn).toBe("2026-09-01")
  })

  it("封存不覆寫案情——已解約的案子封存後仍是已解約", async () => {
    const res = await patch({ archived: true })
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.status).toBe("terminated")
    expect(got.body.project.archivedAt).not.toBeNull()
  })

  it("已封存的專案預設不出現在列表", async () => {
    const res = await request(app).get("/projects").set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.projects.map((p: { id: string }) => p.id)).not.toContain(projectId)
  })

  it("?includeArchived=1 才看得到", async () => {
    const res = await request(app)
      .get("/projects?includeArchived=1")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.projects.map((p: { id: string }) => p.id)).toContain(projectId)
  })

  it("轉回進行中會自動解除封存，不會變成「進行中但看不到」", async () => {
    const res = await patch({ status: "active", statusReason: "雙方復談，合約回復" })
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.status).toBe("active")
    expect(got.body.project.archivedAt).toBeNull()
  })

  it("進行中的專案不能封存", async () => {
    const res = await patch({ archived: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("archive_requires_non_active")
  })

  it("狀態沒變時可以只更正理由", async () => {
    const res = await patch({ statusReason: "更正：依約第 12 條第 2 項" })
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.statusReason).toBe("更正：依約第 12 條第 2 項")
    expect(got.body.project.status).toBe("active")
  })
})

describe("M4-2 自動封存", () => {
  let projectId: string

  beforeAll(async () => {
    const res = await createProject({ name: "自動封存測試案" })
    projectId = res.body.id
    await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "closed",
        statusReason: "驗收完成",
        statusEffectiveOn: "2020-01-01",
      })
    // 輸入時點是「現在」，而起算日取兩者較晚者 → 今天跑不會被封存。
  })

  // 不打 /internal/projects/auto-archive：那支路由對**所有 status='active' 的租戶**跑，
  // (a) 測試租戶是 status='test'，路由根本不會處理它——這幾個案例從 sql/0018 引入 test 租戶
  //     起就不可能過（2026-09-15 交接記的「自動封存 3 例＋專案參數 1 例既有失敗」的真正根因）；
  // (b) 在有 token 的環境跑 months=0 會把**正式租戶**已結案的專案全部封存——測試不該有這種副作用。
  // 直接呼叫服務並指定 tenantId，邏輯完全相同、範圍只在 throwaway 租戶；路由的 token 保護
  // 由下面「沒有 token 就打不到」單獨驗。
  async function runJob(body: { months?: number } = {}) {
    const result = await autoArchiveProjects({ tenantId, months: body.months })
    return { status: 200, body: result }
  }

  function get() {
    return request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
  }

  it("沒有 token 就打不到", async () => {
    const res = await request(app).post("/internal/projects/auto-archive").send({})
    expect([401, 404]).toContain(res.status)
  })

  it("生效日很舊但剛輸入 → 今天不封存（補登不該當晚消失）", async () => {
    const res = await runJob()
    if (res.status === 409) return // internal jobs 未啟用
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.archivedAt).toBeNull()
  })

  it("months=0 就會被封存", async () => {
    const res = await runJob({ months: 0 })
    if (res.status === 409) return
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.archivedAt).not.toBeNull()
    // 封存不動案情。
    expect(got.body.project.status).toBe("closed")
  })

  it("重跑不會重複處理（冪等）", async () => {
    const before = await get()
    const res = await runJob({ months: 0 })
    if (res.status === 409) return
    const after = await get()
    expect(after.body.project.archivedAt).toBe(before.body.project.archivedAt)
  })

  it("人工拉回來之後，排程不會再把它收起來", async () => {
    const unarchive = await request(app)
      .patch(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ archived: false })
    expect(unarchive.status).toBe(200)

    const res = await runJob({ months: 0 })
    if (res.status === 409) return
    expect(res.status).toBe(200)

    const got = await get()
    expect(got.body.project.archivedAt).toBeNull()
  })

  it("暫停的專案永遠不會被自動封存", async () => {
    const other = await createProject({ name: "暫停中的案子" })
    await request(app)
      .patch(`/projects/${other.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "suspended", statusReason: "等都審" })

    const res = await runJob({ months: 0 })
    if (res.status === 409) return

    const got = await request(app)
      .get(`/projects/${other.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.status).toBe("suspended")
    expect(got.body.project.archivedAt).toBeNull()
  })
})

describe("M4-2 專案參數", () => {
  it("沒有設定列時回預設值", async () => {
    const res = await request(app)
      .get("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.settings.autoArchiveEnabled).toBe(true)
    expect(res.body.settings.autoArchiveMonths).toBe(6)
  })

  it("HR 可以調整並讀回", async () => {
    const put = await request(app)
      .put("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ autoArchiveMonths: 12 })
    expect(put.status).toBe(200)
    expect(put.body.settings.autoArchiveMonths).toBe(12)

    const get = await request(app)
      .get("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(get.body.settings.autoArchiveMonths).toBe(12)
  })

  it("關掉之後排程完全不動手", async () => {
    await request(app)
      .put("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ autoArchiveEnabled: false })

    const p = await createProject({ name: "關掉自動封存後的案子" })
    await request(app)
      .patch(`/projects/${p.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "terminated", statusReason: "解約" })

    // months 由設定決定時才會看 enabled；這裡不覆寫 months。
    // 同上：直接呼叫服務、只掃 throwaway 租戶（理由見 M4-2 自動封存 runJob）。
    const result = await autoArchiveProjects({ tenantId })
    expect(result.archived).toBe(0)

    const got = await request(app)
      .get(`/projects/${p.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(got.body.project.archivedAt).toBeNull()
  })
})

describe("M4-3 合約／報價單與印花稅", () => {
  let projectId: string
  let contractId: string

  beforeAll(async () => {
    const res = await createProject({ name: "印花稅測試案" })
    projectId = res.body.id
  })

  function addContract(body: Record<string, unknown>) {
    return request(app)
      .post(`/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body)
  }

  it("報價單不課印花稅——不是契據", async () => {
    const res = await addContract({
      docType: "quotation",
      title: "官網改版報價單",
      amount: 1_000_000,
      signedOn: "2024-03-01",
    })
    expect(res.status).toBe(201)
    expect(res.body.contract.dutiable).toBe(false)
    expect(res.body.contract.stampDutyAmount).toBeNull()
  })

  it("只有報價單時，專案不算已簽約", async () => {
    const res = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.project.hasSignedContract).toBe(false)
  })

  it("承攬契據課千分之一", async () => {
    const res = await addContract({
      docType: "contract",
      ourRole: "contractor",
      title: "官網改版承攬契約",
      counterparty: "某某建設",
      amount: 3_000_000,
      signedOn: "2024-04-01",
    })
    expect(res.status).toBe(201)
    expect(res.body.contract.dutiable).toBe(true)
    expect(res.body.contract.stampDutyRate).toBe(0.001)
    expect(res.body.contract.stampDutyAmount).toBe(3000)
    contractId = res.body.contract.id
  })

  it("有合約且有簽訂日 → 專案算已簽約（衍生，不另存旗標）", async () => {
    const res = await request(app)
      .get(`/projects/${projectId}`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.project.hasSignedContract).toBe(true)
  })

  it("⚠️ 我方是定作人就不課——發包出去的由下包貼花", async () => {
    const res = await addContract({
      docType: "contract",
      ourRole: "client",
      title: "水電工程發包合約",
      amount: 800_000,
      signedOn: "2024-05-01",
    })
    expect(res.status).toBe(201)
    expect(res.body.contract.dutiable).toBe(false)
    expect(res.body.contract.stampDutyAmount).toBeNull()
  })

  it("追加減帳也要補貼花", async () => {
    const res = await addContract({
      docType: "change_order",
      title: "追加：增設後台報表",
      amount: 500_000,
      signedOn: "2024-08-01",
    })
    expect(res.status).toBe(201)
    expect(res.body.contract.stampDutyAmount).toBe(500)
  })

  it("份數相乘", async () => {
    const res = await addContract({
      docType: "contract",
      title: "一式兩份的約",
      amount: 1_000_000,
      signedOn: "2024-09-01",
      copies: 2,
    })
    expect(res.status).toBe(201)
    expect(res.body.contract.stampDutyAmount).toBe(2000)
  })

  it("改金額會重算稅額", async () => {
    const res = await request(app)
      .patch(`/contracts/${contractId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 5_000_000 })
    expect(res.status).toBe(200)
    expect(res.body.contract.stampDutyAmount).toBe(5000)
  })

  it("重算用列上凍結的費率，不抓當下設定", async () => {
    // 把租戶設定改掉，既有合約的費率不該跟著變。
    await request(app)
      .put("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stampDutyRate: 0.004 })

    const res = await request(app)
      .patch(`/contracts/${contractId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amount: 2_000_000 })
    expect(res.status).toBe(200)
    expect(res.body.contract.stampDutyRate).toBe(0.001)
    expect(res.body.contract.stampDutyAmount).toBe(2000)

    await request(app)
      .put("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stampDutyRate: 0.001 })
  })

  it("補登舊約可指定當年度費率", async () => {
    const res = await addContract({
      docType: "contract",
      title: "2019 年的舊約",
      amount: 1_000_000,
      signedOn: "2019-06-01",
      stampDutyRate: 0.002,
    })
    expect(res.status).toBe(201)
    expect(res.body.contract.stampDutyRate).toBe(0.002)
    expect(res.body.contract.stampDutyAmount).toBe(2000)
  })

  it("清單只收應貼花的，並分出已貼／未貼", async () => {
    const res = await request(app)
      .get("/reports/stamp-duty?from=2019-01-01&to=2026-12-31")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    // 報價單與下包合約不進應貼花件數。本 describe 到此建了 6 張：報價單（不課）、
    // 承攬契據、下包合約（我方定作人，不課）、追加減、兩份的契據、2019 補登的舊約
    // → 應貼花 4。原斷言寫 5 從一開始就對不上自己的 fixture（寫測試時沒有環境可跑）。
    expect(res.body.summary.dutiableCount).toBe(4)
    expect(res.body.summary.paidCount).toBe(0)
    expect(res.body.summary.unpaidCount).toBe(4)
    expect(res.body.disclaimer).toContain("試算")
  })

  it("標記已貼花後移到已貼那一側", async () => {
    await request(app)
      .patch(`/contracts/${contractId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stampDutyPaidOn: "2024-04-15" })

    const res = await request(app)
      .get("/reports/stamp-duty?from=2019-01-01&to=2026-12-31")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.summary.paidCount).toBe(1)
    expect(res.body.summary.unpaidCount).toBe(3)
  })

  it("unpaidOnly=1 只回未貼花的", async () => {
    const res = await request(app)
      .get("/reports/stamp-duty?from=2019-01-01&to=2026-12-31&unpaidOnly=1")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.items.every((i: { stampDutyPaidOn: string | null }) => !i.stampDutyPaidOn)).toBe(true)
  })

  it("⚠️ 應貼花但缺簽訂日的另外計數——不在任何區間查詢裡", async () => {
    await addContract({ docType: "contract", title: "還沒填簽訂日的約", amount: 1_000_000 })

    const res = await request(app)
      .get("/reports/stamp-duty?from=2019-01-01&to=2026-12-31")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.summary.missingSignedOn).toBeGreaterThanOrEqual(1)
  })

  it("預設區間回溯 7 年，不是 5 年", async () => {
    const res = await request(app)
      .get("/reports/stamp-duty")
      .set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.range.lookbackYears).toBe(7)
  })

  it("作廢要理由，且是軟刪除", async () => {
    const noReason = await request(app)
      .delete(`/contracts/${contractId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("reason_required")

    const ok = await request(app)
      .delete(`/contracts/${contractId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "重複建檔" })
    expect(ok.status).toBe(200)

    const again = await request(app)
      .delete(`/contracts/${contractId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "再刪一次" })
    expect(again.status).toBe(409)
  })

  it("作廢後不出現在清單也不出現在專案文件裡", async () => {
    const list = await request(app)
      .get(`/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(list.body.contracts.map((c: { id: string }) => c.id)).not.toContain(contractId)
  })
})

describe("M4-4 分期請款期程", () => {
  let projectId: string
  let installmentIds: string[] = []

  beforeAll(async () => {
    const res = await createProject({ name: "分期請款測試案" })
    projectId = res.body.id
  })

  function saveSchedule(installments: Array<Record<string, unknown>>) {
    return request(app)
      .put(`/projects/${projectId}/billings`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ installments })
  }

  function getSchedule() {
    return request(app)
      .get(`/projects/${projectId}/billings`)
      .set("Authorization", `Bearer ${adminToken}`)
  }

  function addContract(body: Record<string, unknown>) {
    return request(app)
      .post(`/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body)
  }

  it("沒有合約時分母是 null，不是 0", async () => {
    const res = await saveSchedule([
      { installmentNo: 1, percentage: 20, milestone: "開工款" },
      { installmentNo: 2, percentage: 20 },
      { installmentNo: 3, percentage: 20 },
      { installmentNo: 4, percentage: 20 },
      { installmentNo: 5, percentage: 20, milestone: "驗收款" },
    ])
    expect(res.status).toBe(200)
    expect(res.body.contract.total).toBeNull()
    expect(res.body.installments).toHaveLength(5)
    // 0 元會看起來像算過了，null 才能讓 UI 說「還沒有合約」。
    expect(res.body.installments.every((i: { calculatedAmount: number | null }) => i.calculatedAmount === null)).toBe(true)
    expect(res.body.summary.percentageTotal).toBe(100)
    installmentIds = res.body.installments.map((i: { id: string }) => i.id)
  })

  it("⚠️ 建立合約後金額自動算出來，不必回頭按存檔", async () => {
    const c = await addContract({
      docType: "contract",
      title: "承攬契約",
      amount: 8_888_888,
      signedOn: "2026-01-15",
    })
    expect(c.status).toBe(201)

    const res = await getSchedule()
    expect(res.body.contract.total).toBe(8_888_888)
    // 每期 1,777,777.6 → 1,777,778，五期合計會多 2 元。
    expect(res.body.installments[0].calculatedAmount).toBe(1_777_778)
    // 末期吸收 −2，合計回到合約金額。
    expect(res.body.installments[4].residueApplied).toBe(-2)
    expect(res.body.installments[4].calculatedAmount).toBe(1_777_776)
    expect(res.body.summary.effectiveTotal).toBe(8_888_888)
  })

  it("標記請款會凍結該期金額", async () => {
    const res = await request(app)
      .post(`/billings/${installmentIds[0]}/bill`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ billedOn: "2026-02-01" })
    expect(res.status).toBe(200)
    const first = res.body.installments[0]
    expect(first.billedOn).toBe("2026-02-01")
    expect(first.billedAmount).toBe(1_777_778)
    expect(res.body.summary.billedTotal).toBe(1_777_778)
  })

  it("重複標記回 409", async () => {
    const res = await request(app)
      .post(`/billings/${installmentIds[0]}/bill`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("already_billed")
  })

  it("⚠️ 追加減帳改變分母，已請款那期不動，未請款的重算", async () => {
    const c = await addContract({
      docType: "change_order",
      title: "追加：增設後台",
      amount: 1_111_112,
      signedOn: "2026-03-01",
    })
    expect(c.status).toBe(201)

    const res = await getSchedule()
    // 分母 8,888,888 + 1,111,112 = 10,000,000
    expect(res.body.contract.total).toBe(10_000_000)
    expect(res.body.contract.changeOrders).toBe(1_111_112)
    // 已請款那期維持原值——帳已經出去了。
    expect(res.body.installments[0].billedAmount).toBe(1_777_778)
    // 未請款各期照新分母算 20%。
    expect(res.body.installments[1].calculatedAmount).toBe(2_000_000)
    // 合計仍等於新的合約總額。
    expect(res.body.summary.effectiveTotal).toBe(10_000_000)
  })

  it("尾差落在最後一個未請款期別", async () => {
    const res = await getSchedule()
    expect(res.body.installments[4].residueApplied).not.toBe(0)
    expect(res.body.installments[0].residueApplied).toBe(0)
  })

  it("人工指定金額必須填理由", async () => {
    const res = await saveSchedule([
      { id: installmentIds[0], installmentNo: 1, percentage: 20 },
      { id: installmentIds[1], installmentNo: 2, percentage: 20, overrideAmount: 3_000_000 },
      { id: installmentIds[2], installmentNo: 3, percentage: 20 },
      { id: installmentIds[3], installmentNo: 4, percentage: 20 },
      { id: installmentIds[4], installmentNo: 5, percentage: 20 },
    ])
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("override_reason_required")
  })

  it("人工指定後，試算與覆寫分開存，差額掛末期", async () => {
    const res = await saveSchedule([
      { id: installmentIds[0], installmentNo: 1, percentage: 20 },
      {
        id: installmentIds[1],
        installmentNo: 2,
        percentage: 20,
        overrideAmount: 3_000_000,
        overrideReason: "業主要求本期多付",
      },
      { id: installmentIds[2], installmentNo: 3, percentage: 20 },
      { id: installmentIds[3], installmentNo: 4, percentage: 20 },
      { id: installmentIds[4], installmentNo: 5, percentage: 20 },
    ])
    expect(res.status).toBe(200)
    expect(res.body.installments[1].overrideAmount).toBe(3_000_000)
    expect(res.body.installments[1].effectiveAmount).toBe(3_000_000)
    // 差額落在末期，讓合計仍等於合約金額。第 1 期已請款凍結在 1,777,778（上面的案例），
    // 不是新分母的 2,000,000：1,777,778 + 3,000,000 + 2,000,000×3 = 10,777,778 → 尾差 −777,778。
    // 原斷言 −1,000,000 忘了第 1 期是凍結值，與本 describe 自己的「已請款那期維持原值」矛盾。
    expect(res.body.summary.effectiveTotal).toBe(10_000_000)
    expect(res.body.installments[4].residueApplied).toBe(-777_778)
  })

  it("⚠️ 已請款的期別不可移除", async () => {
    const res = await saveSchedule([
      { id: installmentIds[1], installmentNo: 2, percentage: 25, overrideAmount: 3_000_000, overrideReason: "x" },
      { id: installmentIds[2], installmentNo: 3, percentage: 25 },
    ])
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("billed_installment_not_removable")
  })

  it("未請款的期別可以移除，且尾差重新落點", async () => {
    const res = await saveSchedule([
      { id: installmentIds[0], installmentNo: 1, percentage: 20 },
      { id: installmentIds[1], installmentNo: 2, percentage: 20 },
      { id: installmentIds[2], installmentNo: 3, percentage: 30 },
      { id: installmentIds[3], installmentNo: 4, percentage: 30 },
    ])
    expect(res.status).toBe(200)
    expect(res.body.installments).toHaveLength(4)
    expect(res.body.summary.effectiveTotal).toBe(10_000_000)
  })

  it("重複期別編號回 400", async () => {
    const res = await saveSchedule([
      { installmentNo: 1, percentage: 50 },
      { installmentNo: 1, percentage: 50 },
    ])
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("duplicate_installment_no")
  })

  it("取消請款要理由，取消後該期回到試算", async () => {
    const noReason = await request(app)
      .post(`/billings/${installmentIds[0]}/unbill`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({})
    expect(noReason.status).toBe(400)
    expect(noReason.body.error).toBe("reason_required")

    const res = await request(app)
      .post(`/billings/${installmentIds[0]}/unbill`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "業主退件重開" })
    expect(res.status).toBe(200)
    expect(res.body.installments[0].billedOn).toBeNull()
    expect(res.body.summary.billedTotal).toBe(0)
    expect(res.body.summary.effectiveTotal).toBe(10_000_000)
  })

  it("作廢合約後分母跟著變", async () => {
    const list = await request(app)
      .get(`/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${adminToken}`)
    const changeOrder = list.body.contracts.find((c: { docType: string }) => c.docType === "change_order")

    await request(app)
      .delete(`/contracts/${changeOrder.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "追加取消" })

    const res = await getSchedule()
    expect(res.body.contract.total).toBe(8_888_888)
    expect(res.body.contract.changeOrders).toBe(0)
    expect(res.body.summary.effectiveTotal).toBe(8_888_888)
  })
})

/* ────────────────────────────────────────────────────────────────────
 * WP5（2026-09-23）：W3 成員四角色＋角色預設趴數、W4 列表不回獎金池、M14 年度篩選
 * ──────────────────────────────────────────────────────────────────── */

/** 租戶管理員自己的 employees 列——測試要有一個真實的 employeeId 當成員。 */
async function adminEmpId(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(1)
    .single()
  if (error) throw new Error(`adminEmpId: ${error.message}`)
  return data!.id as string
}

/** migration 0050 的 project_settings.default_share_pct_by_role 是否已在正式庫。 */
async function shareDefaultsMigrated(): Promise<boolean> {
  const { error } = await supabaseAdmin.from("project_settings").select("default_share_pct_by_role").limit(1)
  return !error
}
const shareDefaultsReady = await shareDefaultsMigrated()

describe("W3 專案成員四角色（manager／lead／support／member）", () => {
  let projectId: string
  let empId: string

  beforeAll(async () => {
    const res = await createProject({ name: "四角色測試案", shareMode: "pool_pct", bonusPool: 1_000_000 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    projectId = res.body.id
    empId = await adminEmpId()
  })

  it("roleInProject:'support' 可以新增（支援）", async () => {
    const res = await request(app)
      .post(`/projects/${projectId}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: empId, roleInProject: "support", sharePct: 5 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const list = await request(app)
      .get(`/projects/${projectId}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(list.body.members[0].roleInProject).toBe("support")
  })

  it("角色可改成 manager（經理）", async () => {
    const list = await request(app)
      .get(`/projects/${projectId}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
    const memberId = list.body.members[0].id
    const res = await request(app)
      .patch(`/projects/${projectId}/members/${memberId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ roleInProject: "manager" })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const after = await request(app)
      .get(`/projects/${projectId}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(after.body.members[0].roleInProject).toBe("manager")
  })

  it("不在值域的角色（owner）回 400", async () => {
    const other = await createProject({ name: "角色值域測試案" })
    const res = await request(app)
      .post(`/projects/${other.body.id}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: empId, roleInProject: "owner" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_body")
  })
})

// 需要 migration 0050 的 default_share_pct_by_role；正式庫未套時整組跳過。
// 套完後執行：npx vitest run src/__tests__/projects.test.ts
describe.skipIf(!shareDefaultsReady)("W3 角色預設分潤趴數（pool_pct 未帶 sharePct 時預帶）", () => {
  let projectId: string
  let empId: string

  beforeAll(async () => {
    await request(app)
      .put("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ defaultSharePctByRole: { manager: 12, lead: 8, support: 3, member: 1 } })
    const res = await createProject({ name: "預設趴數測試案", shareMode: "pool_pct", bonusPool: 500_000 })
    projectId = res.body.id
    empId = await adminEmpId()
  })

  it("GET /project-settings 回得出剛存的四角色預設", async () => {
    const res = await request(app).get("/project-settings").set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.settings.defaultSharePctByRole).toEqual({ manager: 12, lead: 8, support: 3, member: 1 })
  })

  it("新增成員沒帶 sharePct → 套該角色的預設（manager=12）", async () => {
    const res = await request(app)
      .post(`/projects/${projectId}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: empId, roleInProject: "manager" })
    expect(res.status, JSON.stringify(res.body)).toBe(201)

    const list = await request(app)
      .get(`/projects/${projectId}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(list.body.members[0].sharePct).toBe(12)
    // 獎金池 500,000 × 12% ＝ 60,000
    expect(list.body.members[0].computedAmount).toBe(60_000)
  })

  it("明確帶 sharePct 時不被預設值蓋掉", async () => {
    const other = await createProject({ name: "預設趴數覆寫案", shareMode: "pool_pct", bonusPool: 500_000 })
    const res = await request(app)
      .post(`/projects/${other.body.id}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ employeeId: empId, roleInProject: "manager", sharePct: 30 })
    expect(res.status).toBe(201)

    const list = await request(app)
      .get(`/projects/${other.body.id}/members`)
      .set("Authorization", `Bearer ${adminToken}`)
    expect(list.body.members[0].sharePct).toBe(30)
  })
})

describe("W4 列表不回獎金池 ＋ M14 年度篩選", () => {
  it("GET /projects 每一列的 bonusPool 都是 null（列表沒有逐案算權限）", async () => {
    await createProject({ name: "有獎金池的案", shareMode: "pool_pct", bonusPool: 999_000 })
    const res = await request(app).get("/projects").set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.projects.length).toBeGreaterThan(0)
    for (const p of res.body.projects) expect(p.bonusPool).toBeNull()
  })

  it("GET /projects/:id 仍看得到獎金池（HR 有 bonus 權限）", async () => {
    const created = await createProject({ name: "詳情看得到池", shareMode: "pool_pct", bonusPool: 123_000 })
    const res = await request(app).get(`/projects/${created.body.id}`).set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.project.bonusPool).toBe(123_000)
    expect(res.body.access).toEqual({ finance: true, bonus: true })
  })

  it("?year= 只回該歸屬年度的案子", async () => {
    const target = YEAR - 3
    const created = await createProject({ name: `${target} 年度案`, fiscalYear: target })
    const res = await request(app).get(`/projects?year=${target}`).set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const ids = res.body.projects.map((p: { id: string }) => p.id)
    expect(ids).toContain(created.body.id)
    for (const p of res.body.projects) expect(p.fiscalYear).toBe(target)

    // 不帶 year 時那一案仍在（篩選沒有黏住）
    const all = await request(app).get("/projects").set("Authorization", `Bearer ${adminToken}`)
    expect(all.body.projects.map((p: { id: string }) => p.id)).toContain(created.body.id)
  })

  it("?year= 不是合法年度 → 400 invalid_year（不默默忽略）", async () => {
    const res = await request(app).get("/projects?year=abc").set("Authorization", `Bearer ${adminToken}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_year")
  })
})

describe("W8 技師科別依租戶設定（不再是 electrical／hvac／fire）", () => {
  it("中文科別 key 存得進去、讀得回來", async () => {
    const created = await createProject({ name: "科別測試案", engineers: { 空調: { name: "李技師" } } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const res = await request(app).get(`/projects/${created.body.id}`).set("Authorization", `Bearer ${adminToken}`)
    expect(res.body.project.engineers["空調"].name).toBe("李技師")
  })

  it("不在 project_settings.disciplines 裡的 key → 400 unknown_discipline", async () => {
    const created = await createProject({ name: "科別值域測試案" })
    const res = await request(app)
      .patch(`/projects/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ engineers: { electrical: { name: "王技師" } } })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unknown_discipline")
    expect(res.body.discipline).toBe("electrical")
  })

  it("租戶把科別改成自訂清單後，新的科別就過得了", async () => {
    await request(app)
      .put("/project-settings")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ disciplines: ["電機", "空調", "消防", "汙水", "弱電"] })
    const created = await createProject({ name: "自訂科別案", engineers: { 弱電: { name: "陳技師" } } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
  })
})
