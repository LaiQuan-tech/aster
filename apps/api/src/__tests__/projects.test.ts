import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient } from "@supabase/supabase-js"
import request from "supertest"
// .env is loaded by the vitest setupFile (src/__tests__/setup.ts) before this
// module is imported, so the eagerly-constructed clients below have real creds.
import { supabaseAdmin } from "../lib/supabase"
import { provisionTenant } from "../services/tenants"
import { app } from "../app"

const SUPABASE_URL = process.env.SUPABASE_URL ?? ""
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ""

const stamp = Date.now()
const createdUserIds: string[] = []
const createdTenantIds: string[] = []

let tenantId: string
let adminToken: string

/** 編號的年度＝建立年。測試與程式取同一個來源。 */
const YEAR = new Date().getFullYear()

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

  it("第一個案子拿到 P{建立年}-001", async () => {
    const res = await createProject({ name: "官網改版" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`P${YEAR}-001`)
    firstId = res.body.id
  })

  it("流水號遞增", async () => {
    const res = await createProject({ name: "倉儲系統" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`P${YEAR}-002`)
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
    expect(res.body.code).toBe(`P${YEAR}-003`)

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
    // ABC-999 若被算進去，這裡會變成 P{YEAR}-1000。
    const res = await createProject({ name: "後續案" })
    expect(res.status).toBe(201)
    expect(res.body.code).toBe(`P${YEAR}-004`)
  })

  it("撞號回 409，不自動改號——人工指定代表那個號有意義", async () => {
    const res = await createProject({ name: "又一個舊案", code: "ABC-999" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("code_taken")
  })

  it("人工指定既有的系統編號一樣擋下", async () => {
    const res = await createProject({ name: "手打撞到自動號", code: `P${YEAR}-001` })
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
    expect(res.body.code).toBe(`P${YEAR}-001`)
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

  function runJob(body: Record<string, unknown> = {}) {
    return request(app)
      .post("/internal/projects/auto-archive")
      .set("x-internal-job-token", process.env.INTERNAL_JOB_TOKEN ?? "")
      .send(body)
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
    const res = await request(app)
      .post("/internal/projects/auto-archive")
      .set("x-internal-job-token", process.env.INTERNAL_JOB_TOKEN ?? "")
      .send({})
    if (res.status === 409) return
    expect(res.status).toBe(200)

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
    // 報價單與下包合約不進應貼花件數。
    expect(res.body.summary.dutiableCount).toBe(5)
    expect(res.body.summary.paidCount).toBe(0)
    expect(res.body.summary.unpaidCount).toBe(5)
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
    expect(res.body.summary.unpaidCount).toBe(4)
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
