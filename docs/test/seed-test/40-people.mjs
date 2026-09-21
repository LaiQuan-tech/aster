/**
 * docs/test/seed-test/40-people.mjs — 「人員」「公告與資訊」「系統」三區的測試資料。
 *
 * 建的東西（全部冪等：先 GET 列表用名稱／候選人／(employee, template, period) 比對，
 * 有就沿用；狀態機類先讀回目前狀態再決定要不要推進；跑兩次 created=0）：
 *
 *   公告與資訊
 *   1. 公告 3（/admin/announcements）：
 *      A【測試】公告A（需簽收）requiresSignature → A／B／C 各以自己的 token 標「已讀」
 *        （POST /announcement-versions/:vid/acknowledge，不帶 employeeId＝只寫 viewed_at），
 *        再由 HR 帶 employeeId 為 B、C 登錄紙本簽署（signed_at）。A 只讀不簽，
 *        簽收名單才看得到 pending。設計上員工端只能「查閱」，簽署一律 HR 代登錄
 *        （announcements.ts 檔頭：客戶排斥線上勾選同意）。
 *      B【測試】公告B → 建好後 PATCH 一次 changeType=amendment（發第 2 版）
 *      C【測試】公告C → effectiveFrom 2026-10-01
 *      ⚠️ 公告全租戶可見，真實員工也會看到；業主測完可 DELETE /announcements/:id {reason} 軟刪。
 *   2. 公司資訊頁 2（/admin/company-info）：slug 只有 benefits／safety 兩個（寫死在
 *      company-pages.ts），所以最多 2 筆。已有非測試內容就跳過並 issue()。
 *   3. 知識庫 3（/admin/knowledge）：kind=text 文件 A／B／C（POST 會立即索引）。
 *
 *   人員
 *   4. 報到 3（/admin/onboarding）：報到者A／B／C；C 走 POST /onboardings/:id/complete
 *      → 會多一位「無登入帳號」的員工列【測試】報到者C（user_id null），並自動替他建
 *      現行需簽收規章的 accept_on_hire 待簽列（所以公告要先於報到建）。
 *   5. 招募 3+3+3+3（/admin/recruitment）：職缺（open／draft／closed）、候選人
 *      （new／interviewing／offered）、面試（pending／pass／fail，面試官 A）、offer
 *      （draft／sent／accepted）。
 *   6. 考核 3 範本＋3 考核（/admin/kpi）：
 *      B：reviewer A、範本A、2026-Q3 → 留 draft
 *      C：reviewer A、範本B → A 的 token 評分＋submit → submitted
 *      A：reviewer＝HR 本人、範本C → HR 評分＋submit＋finalize → finalized
 *   7. 專屬 Email 3（/admin/employee-mail）：A active／B planned／C suspended（PUT upsert）。
 *
 *   系統
 *   8. 備份快照 3（/admin/backups）：2026-06／07／08 三期；POST /backups/run 分段
 *      執行（每段 ~12 秒預算），done=false 就帶 nextTable／nextOffset 續打（上限 300 段，
 *      同 apps/web/src/lib/backup-api.ts 的 runBackupLoop）。快照是整租戶全表快照
 *      （含真實資料，這是備份功能本身的正常行為），存 Storage bucket
 *      `tenant-snapshots/<tenantId>/<period>/{<table>.json.gz…, manifest.json}`。
 *   9. 通知／稽核（/admin/notifications、/admin/audit-logs）：不手灌；跑完讀回與測試
 *      員工／【測試】相關的列寫進 manifest。注意：本模組的操作（公告、招募、考核…）
 *      本身不會入列通知——通知只由簽核／出勤表／放款／異常偵測產生（services/notify.ts
 *      的呼叫端），所以通知筆數取決於其他 seed 模組（attendance／finance）有沒有先跑。
 *
 * 用到 ctx.state：employees.{A,B,C}、dept.root（00-base 填入）。
 */

import { T, TEST_EMAIL_DOMAIN } from "./lib.mjs"

export const name = "people"

const REPORTEES = [
  { key: "A", name: T("報到者A"), reportDate: "2026-10-01", complete: false },
  { key: "B", name: T("報到者B"), reportDate: "2026-10-05", complete: false },
  { key: "C", name: T("報到者C"), reportDate: "2026-10-12", complete: true },
]

const KPI_PERIOD = "2026-Q3"
const BACKUP_PERIODS = ["2026-06", "2026-07", "2026-08"]
const BACKUP_MAX_STEPS = 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 只回測試員工 A／B／C 的 token（快取，同一次執行不重複登入）。 */
function tokenCache(ctx) {
  const cache = {}
  return async (key) => {
    if (!cache[key]) cache[key] = await ctx.loginAs(ctx.state.employees[key].email, ctx.testPassword)
    return cache[key]
  }
}

// ---------------------------------------------------------------------------
// 1. 公告（先於報到：報到完成會替新員工建「現行需簽收規章」的待簽列）
// ---------------------------------------------------------------------------
async function seedAnnouncements(ctx, tokenOf) {
  const listAnn = async () => (await ctx.api("GET", "/announcements")).body.announcements

  const defs = [
    {
      key: "A",
      title: T("公告A（需簽收）"),
      body: T("這是一則測試用的需簽收規章，供業主確認「公告／版本／簽收名單」功能；內容可忽略，測完可註銷。"),
      extra: { requiresSignature: true, changeNote: T("初版") },
      note: "requiresSignature；A 已讀未簽、B／C 已簽（HR 登錄紙本簽署）",
    },
    {
      key: "B",
      title: T("公告B"),
      body: T("這是一則測試公告（第 1 版），供業主確認版本歷程功能；內容可忽略。"),
      extra: { changeNote: T("初版") },
      note: "2 個版本（initial → amendment）",
    },
    {
      key: "C",
      title: T("公告C"),
      body: T("這是一則測試公告，生效日 2026-10-01，供業主確認生效日欄位；內容可忽略。"),
      extra: { effectiveFrom: "2026-10-01", changeNote: T("初版") },
      note: "effectiveFrom 2026-10-01",
    },
  ]

  const rows = {}
  for (const d of defs) {
    rows[d.key] = await ctx.ensure({
      list: listAnn,
      match: (r) => r.title === d.title,
      create: async () => (await ctx.api("POST", "/announcements", { title: d.title, body: d.body, audience: "all", ...d.extra })).body,
      label: `公告 ${d.title}`,
    })
  }

  // 公告B：第 2 版（amendment）。先數版本，已有 2 版就不再發。
  const versionsB = (await ctx.api("GET", `/announcements/${rows.B.id}/versions`)).body.versions
  if (versionsB.length < 2) {
    await ctx.api("PATCH", `/announcements/${rows.B.id}`, {
      body: T("這是一則測試公告（第 2 版，修訂版），供業主確認版本歷程功能；內容可忽略。"),
      changeType: "amendment",
      changeNote: T("修訂版"),
    })
    ctx.created(`公告 ${defs[1].title} 第 2 版（amendment）`)
  } else {
    ctx.reused(`公告 ${defs[1].title} 已有 ${versionsB.length} 版`)
  }

  // 公告A 的現行版：員工端「已讀」＋ HR 登錄紙本簽署
  const annA = (await listAnn()).find((r) => r.id === rows.A.id)
  const vidA = annA?.current_version_id
  if (!vidA) throw new Error(`公告A（${rows.A.id}）沒有 current_version_id`)

  // 已讀：A／B／C 各用自己的 token 呼叫（只記第一次 viewed_at，本身冪等）
  const ackList = async () => (await ctx.api("GET", `/announcements/${rows.A.id}/acknowledgements`)).body
  let acks = await ackList()
  const byEmp = (list, empId) => list.find((r) => r.employee_id === empId)
  for (const key of ["A", "B", "C"]) {
    const emp = ctx.state.employees[key]
    const existing = byEmp([...acks.signed, ...acks.pending], emp.id)
    if (existing?.viewed_at) {
      ctx.reused(`公告A 已讀 ${emp.name}`)
      continue
    }
    await ctx.apiAs(await tokenOf(key))("POST", `/announcement-versions/${vidA}/acknowledge`, {})
    ctx.created(`公告A 已讀 ${emp.name}（員工端 viewed_at）`)
  }
  // 簽收：只有 B、C；HR 帶 employeeId 登錄紙本簽署日
  acks = await ackList()
  for (const key of ["B", "C"]) {
    const emp = ctx.state.employees[key]
    if (byEmp(acks.signed, emp.id)) {
      ctx.reused(`公告A 簽收 ${emp.name}`)
      continue
    }
    await ctx.api("POST", `/announcement-versions/${vidA}/acknowledge`, {
      employeeId: emp.id,
      kind: "consent_to_change",
      signedAt: ctx.dates.iso(ctx.dates.todayKey(), "09:00"),
      note: T("紙本簽署登錄（測試）"),
    })
    ctx.created(`公告A 簽收 ${emp.name}（HR 登錄紙本簽署 signed_at）`)
  }
  acks = await ackList()
  ctx.log(`  公告A 簽收名單：signed=${acks.signed.length}（${acks.signed.map((r) => r.employee_id.slice(0, 8)).join("、")}）pending=${acks.pending.length}`)

  ctx.state.announcements = { A: { id: rows.A.id, versionId: vidA }, B: { id: rows.B.id }, C: { id: rows.C.id } }
  ctx.manifest.push({
    page: "/admin/announcements",
    feature: "公告（含版本、簽收名單）",
    records: defs.map((d) => ({ id: rows[d.key].id, name: d.title, note: d.note })),
  })
}

// ---------------------------------------------------------------------------
// 2. 公司資訊頁（只有 benefits／safety 兩個 slug）
// ---------------------------------------------------------------------------
async function seedCompanyPages(ctx) {
  const pages = (await ctx.api("GET", "/company-pages")).body.pages
  const defs = {
    benefits: { title: T("公司福利"), body: T("這是測試用的公司福利頁內容：三節獎金、生日禮金、年度健檢、教育訓練補助等，僅供業主確認頁面呈現，正式內容請自行覆寫。") },
    safety: { title: T("職業安全衛生"), body: T("這是測試用的職業安全衛生頁內容：辦公室逃生路線、急救箱位置、每年一次消防演練、通報流程等，僅供業主確認頁面呈現，正式內容請自行覆寫。") },
  }
  const records = []
  for (const [slug, def] of Object.entries(defs)) {
    const cur = pages.find((p) => p.slug === slug)
    if (cur?.exists && (cur.body ?? "").trim() !== "" && !cur.title.startsWith(T(""))) {
      ctx.issue(`公司資訊頁 ${slug} 已有非測試內容（title=${cur.title}），跳過不覆寫`)
      continue
    }
    if (cur?.exists && cur.title === def.title && cur.body === def.body) {
      ctx.reused(`公司資訊頁 ${slug} ${def.title}`)
    } else {
      await ctx.api("PUT", `/company-pages/${slug}`, def)
      ctx.created(`公司資訊頁 ${slug} ${def.title}`)
    }
    records.push({ id: slug, name: def.title, note: `slug=${slug}` })
  }
  ctx.manifest.push({ page: "/admin/company-info", feature: "公司資訊頁（slug 上限 2：benefits／safety）", records })
}

// ---------------------------------------------------------------------------
// 3. 知識庫
// ---------------------------------------------------------------------------
async function seedKnowledge(ctx) {
  const defs = [
    { title: T("知識文件A"), body: T("請假流程說明（測試文件）。員工請假請先在自助平台送出假單，選擇假別、起訖時間與事由，附件視假別規定上傳。假單送出後由直屬主管簽核，主管核准後人資備查；若假別需要證明文件，請於三日內補上。臨時請假請先以電話或通訊軟體告知主管，事後仍須在系統補單。年度特休依到職日按比例給假，未休完依規定結算。此文件僅供測試知識庫的索引與問答功能，內容可忽略。") },
    { title: T("知識文件B"), body: T("出勤打卡規範（測試文件）。上下班請使用手機或公司電腦打卡，忘記打卡請於當日填寫補卡申請並由主管核准。遲到早退依公司規則計算，累計時數於月結時反映。外出洽公請事先登記，出差期間以出差單代替打卡。加班需事先申請，核准後的加班時數可選擇換補休或加班費。每月五日前人資會產出上月出勤表，員工確認無誤後簽核。此文件僅供測試知識庫的索引與問答功能，內容可忽略。") },
    { title: T("知識文件C"), body: T("報帳與零用金規範（測試文件）。員工墊付的費用請於三十日內在系統填寫報支單並附上發票或收據，金額三千元以上需事先申請。交通費以實際票價核銷，自駕依公司里程單價計算。餐費、交際費需註明對象與事由。報支單經主管與財務審核後，於次月薪資一併撥付或以匯款方式支付。零用金請向財務借支並於七日內結清。此文件僅供測試知識庫的索引與問答功能，內容可忽略。") },
  ]
  const listDocs = async () => (await ctx.api("GET", "/knowledge/documents")).body.documents
  const records = []
  for (const d of defs) {
    const doc = await ctx.ensure({
      list: listDocs,
      match: (r) => r.title === d.title,
      create: async () => {
        const r = (await ctx.api("POST", "/knowledge/documents", { kind: "text", title: d.title, body: d.body })).body
        ctx.log(`  索引結果 ${d.title}：${JSON.stringify(r.index)}`)
        return r.document
      },
      label: `知識文件 ${d.title}`,
    })
    records.push({ id: doc.id, name: d.title, note: `kind=text／status=${doc.status ?? "?"}／chunks=${doc.chunkCount ?? "?"}` })
  }
  ctx.manifest.push({ page: "/admin/knowledge", feature: "知識庫文件", records })
}

// ---------------------------------------------------------------------------
// 4. 報到管理
// ---------------------------------------------------------------------------
async function seedOnboardings(ctx) {
  const { A } = ctx.state.employees
  const deptId = ctx.state.dept.root.id
  const listOb = async () => (await ctx.api("GET", "/onboardings")).body.onboardings
  const records = []
  for (const d of REPORTEES) {
    let ob = await ctx.ensure({
      list: listOb,
      match: (r) => r.name === d.name,
      create: async () =>
        (await ctx.api("POST", "/onboardings", {
          name: d.name,
          deptId,
          managerEmpId: A.id,
          employmentType: "regular",
          identityType: "全職",
          region: "台北",
          reportDate: d.reportDate,
        })).body,
      label: `報到 ${d.name}`,
    })
    if (ob.status === undefined) ob = (await listOb()).find((r) => r.id === ob.id) ?? ob

    if (d.complete) {
      if (ob.status === "completed") {
        ctx.reused(`報到 ${d.name} 已完成（employee_id=${ob.employee_id}）`)
      } else {
        // 冪等保護：employees 已有同名無帳號列（例如報到列被刪過再重建）→ 不再 complete，避免多一位重複員工
        const dup = (await ctx.api("GET", "/employees")).body.employees.find((e) => e.name === d.name)
        if (dup) {
          ctx.issue(`報到 ${d.name} 仍是 pending，但 employees 已有同名列（${dup.id}），略過 complete 以免重複建員工；請手動處理`)
        } else {
          const r = (await ctx.api("POST", `/onboardings/${ob.id}/complete`)).body
          ctx.created(`報到 ${d.name} complete → 員工列 ${r.employeeId}（無登入帳號）；待簽規章 ${r.pendingSignatures ?? 0} 筆`)
          ob = { ...ob, status: "completed", employee_id: r.employeeId }
        }
      }
    }
    records.push({ id: ob.id, name: d.name, note: `reportDate ${d.reportDate}／status ${ob.status}${ob.employee_id ? `／employee ${ob.employee_id}` : ""}` })
  }
  ctx.manifest.push({ page: "/admin/onboarding", feature: "報到管理", records })
}

// ---------------------------------------------------------------------------
// 5. 招募：職缺／候選人／面試／offer
// ---------------------------------------------------------------------------
async function seedRecruitment(ctx) {
  const { A } = ctx.state.employees
  const deptId = ctx.state.dept.root.id

  // 職缺
  const listReq = async () => (await ctx.api("GET", "/job-requisitions")).body["job-requisitions"]
  const reqDefs = [
    { key: "A", title: T("職缺A"), status: "open", headcount: 2, isInternal: true },
    { key: "B", title: T("職缺B"), status: "draft", headcount: 1 },
    { key: "C", title: T("職缺C"), status: "closed", headcount: 1 },
  ]
  const reqs = {}
  for (const d of reqDefs) {
    reqs[d.key] = await ctx.ensure({
      list: listReq,
      match: (r) => r.title === d.title,
      create: async () =>
        (await ctx.api("POST", "/job-requisitions", {
          title: d.title,
          deptId,
          headcount: d.headcount,
          employmentType: "regular",
          description: T("測試職缺，內容可忽略"),
          status: d.status,
          isInternal: d.isInternal ?? false,
        })).body,
      label: `職缺 ${d.title}`,
    })
  }
  ctx.manifest.push({
    page: "/admin/recruitment",
    feature: "職缺",
    records: reqDefs.map((d) => ({ id: reqs[d.key].id, name: d.title, note: `status ${d.status}${d.isInternal ? "／內部職缺" : ""}` })),
  })

  // 候選人（都掛職缺A）
  const listCand = async () => (await ctx.api("GET", "/candidates")).body.candidates
  const candDefs = [
    { key: "A", name: T("候選人A"), status: "new" },
    { key: "B", name: T("候選人B"), status: "interviewing" },
    { key: "C", name: T("候選人C"), status: "offered" },
  ]
  const cands = {}
  for (const d of candDefs) {
    cands[d.key] = await ctx.ensure({
      list: listCand,
      match: (r) => r.name === d.name,
      create: async () =>
        (await ctx.api("POST", "/candidates", {
          name: d.name,
          requisitionId: reqs.A.id,
          email: `cand-${d.key.toLowerCase()}@${TEST_EMAIL_DOMAIN}`,
          phone: `0911-000-00${d.key.charCodeAt(0) - 64}`,
          source: T("內推"),
          status: d.status,
          note: T("測試候選人，內容可忽略"),
        })).body,
      label: `候選人 ${d.name}`,
    })
  }
  ctx.manifest.push({
    page: "/admin/recruitment",
    feature: "候選人",
    records: candDefs.map((d) => ({ id: cands[d.key].id, name: d.name, note: `status ${d.status}／職缺A` })),
  })

  // 面試（每位候選人一筆，面試官 A；以 candidate_id 比對）
  const intDefs = [
    { key: "A", result: "pending", stage: T("初試"), date: "2026-10-06" },
    { key: "B", result: "pass", stage: T("複試"), date: "2026-10-07" },
    { key: "C", result: "fail", stage: T("主管面談"), date: "2026-10-08" },
  ]
  const intRecords = []
  for (const d of intDefs) {
    const cand = cands[d.key]
    const row = await ctx.ensure({
      list: async () => (await ctx.api("GET", `/interviews?candidateId=${cand.id}`)).body.interviews,
      match: (r) => r.candidate_id === cand.id && (r.notes ?? "").startsWith(T("")),
      create: async () =>
        (await ctx.api("POST", "/interviews", {
          candidateId: cand.id,
          interviewerEmpId: A.id,
          scheduledAt: ctx.dates.iso(d.date, "10:00"),
          stage: d.stage,
          result: d.result,
          notes: T(`面試紀錄（${d.result}），內容可忽略`),
        })).body,
      label: `面試 ${candDefs.find((c) => c.key === d.key).name}／${d.stage}`,
    })
    intRecords.push({ id: row.id, name: `${T("面試")}${d.key}（${candDefs.find((c) => c.key === d.key).name}）`, note: `result ${d.result}／面試官 ${A.name}／${d.date} 10:00` })
  }
  ctx.manifest.push({ page: "/admin/recruitment", feature: "面試", records: intRecords })

  // offer（每位候選人一筆；以 candidate_id 比對）
  const offDefs = [
    { key: "A", status: "draft", salary: 45000, startDate: "2026-11-02" },
    { key: "B", status: "sent", salary: 52000, startDate: "2026-11-02" },
    { key: "C", status: "accepted", salary: 60000, startDate: "2026-11-16" },
  ]
  const offRecords = []
  for (const d of offDefs) {
    const cand = cands[d.key]
    const row = await ctx.ensure({
      list: async () => (await ctx.api("GET", `/offers?candidateId=${cand.id}`)).body.offers,
      match: (r) => r.candidate_id === cand.id && (r.note ?? "").startsWith(T("")),
      create: async () =>
        (await ctx.api("POST", "/offers", {
          candidateId: cand.id,
          salary: d.salary,
          startDate: d.startDate,
          status: d.status,
          note: T(`錄用通知（${d.status}），內容可忽略`),
        })).body,
      label: `offer ${candDefs.find((c) => c.key === d.key).name}／${d.status}`,
    })
    offRecords.push({ id: row.id, name: `${T("offer")}${d.key}（${candDefs.find((c) => c.key === d.key).name}）`, note: `status ${d.status}／薪資 ${d.salary}／到職 ${d.startDate}` })
  }
  ctx.manifest.push({ page: "/admin/recruitment", feature: "offer", records: offRecords })
}

// ---------------------------------------------------------------------------
// 6. 績效考核：範本 3 ＋ 考核 3（draft／submitted／finalized）
// ---------------------------------------------------------------------------
async function seedKpi(ctx, tokenOf) {
  const { A, B, C } = ctx.state.employees
  const items = [
    { key: "item1", label: T("項目一"), weight: 40, maxScore: 10 },
    { key: "item2", label: T("項目二"), weight: 30, maxScore: 10 },
    { key: "item3", label: T("項目三"), weight: 30, maxScore: 10 },
  ]
  const listTpl = async () => (await ctx.api("GET", "/kpi-templates")).body.templates
  const tpls = {}
  for (const key of ["A", "B", "C"]) {
    const tplName = T(`考核範本${key}`)
    tpls[key] = await ctx.ensure({
      list: listTpl,
      match: (r) => r.name === tplName,
      create: async () => (await ctx.api("POST", "/kpi-templates", { name: tplName, items, active: true })).body,
      label: `考核範本 ${tplName}`,
    })
  }
  ctx.manifest.push({
    page: "/admin/kpi",
    feature: "考核範本",
    records: ["A", "B", "C"].map((k) => ({ id: tpls[k].id, name: T(`考核範本${k}`), note: "3 項（40／30／30，maxScore 10）" })),
  })

  // 考核指派（HR）：unique(employee, template, period)；409 review_already_exists 視為既有
  const listReviews = async () => (await ctx.api("GET", `/kpi-reviews?period=${KPI_PERIOD}`)).body.reviews
  async function ensureReview(emp, reviewerEmpId, tpl, label) {
    let rows = await listReviews()
    let found = rows.find((r) => r.employee_id === emp.id && r.template_id === tpl.id)
    if (found) {
      ctx.reused(`考核 ${label}（status ${found.status}）`)
      return found
    }
    const r = await ctx.tryApi("POST", "/kpi-reviews", { employeeId: emp.id, reviewerEmpId, templateId: tpl.id, period: KPI_PERIOD })
    if (r.status === 201) {
      ctx.created(`考核 ${label}`)
    } else if (r.status === 409 && r.body?.error === "review_already_exists") {
      ctx.reused(`考核 ${label}（409 review_already_exists）`)
    } else {
      const err = new Error(`POST /kpi-reviews（${label}）→ ${r.status}: ${JSON.stringify(r.body)}`)
      err.status = r.status
      err.body = r.body
      throw err
    }
    rows = await listReviews()
    found = rows.find((r2) => r2.employee_id === emp.id && r2.template_id === tpl.id)
    if (!found) throw new Error(`考核 ${label} 建立後在列表找不到`)
    return found
  }

  const scores = [
    { key: "item1", score: 8, comment: T("表現良好") },
    { key: "item2", score: 7, comment: T("尚可") },
    { key: "item3", score: 9, comment: T("優秀") },
  ]
  /** 依目標狀態推進：draft →(評分+submit)→ submitted →(finalize, HR)→ finalized。 */
  async function advance(review, target, scorerApi, label) {
    let status = review.status
    if (status === "draft" && target !== "draft") {
      await scorerApi("PATCH", `/kpi-reviews/${review.id}`, { scores })
      await scorerApi("POST", `/kpi-reviews/${review.id}/submit`)
      ctx.log(`  考核 ${label}：draft → submitted（評分 8／7／9 → 加權 80）`)
      status = "submitted"
    }
    if (status === "submitted" && target === "finalized") {
      await ctx.api("POST", `/kpi-reviews/${review.id}/finalize`)
      ctx.log(`  考核 ${label}：submitted → finalized（HR）`)
      status = "finalized"
    }
    return status
  }

  const apiA = ctx.apiAs(await tokenOf("A"))
  const revB = await ensureReview(B, A.id, tpls.A, `${B.name}（reviewer ${A.name}／範本A／${KPI_PERIOD}）`)
  const stB = await advance(revB, "draft", apiA, B.name)
  const revC = await ensureReview(C, A.id, tpls.B, `${C.name}（reviewer ${A.name}／範本B／${KPI_PERIOD}）`)
  const stC = await advance(revC, "submitted", apiA, C.name)
  const revA = await ensureReview(A, ctx.hr.employeeId, tpls.C, `${A.name}（reviewer HR ${ctx.hr.name}／範本C／${KPI_PERIOD}）`)
  const stA = await advance(revA, "finalized", ctx.api, A.name)

  ctx.manifest.push({
    page: "/admin/kpi",
    feature: "考核",
    records: [
      { id: revB.id, name: `${T("考核")}${B.name}`, note: `status ${stB}／reviewer ${A.name}／範本A／${KPI_PERIOD}` },
      { id: revC.id, name: `${T("考核")}${C.name}`, note: `status ${stC}／reviewer ${A.name}／範本B／${KPI_PERIOD}` },
      { id: revA.id, name: `${T("考核")}${A.name}`, note: `status ${stA}／reviewer HR／範本C／${KPI_PERIOD}` },
    ],
  })
}

// ---------------------------------------------------------------------------
// 7. 專屬 Email 配發（PUT upsert；GET 列表比對地址／狀態決定 created／reused）
// ---------------------------------------------------------------------------
async function seedMailboxes(ctx) {
  const defs = [
    { key: "A", status: "active", activatedOn: "2026-01-05" },
    { key: "B", status: "planned" },
    { key: "C", status: "suspended", activatedOn: "2026-03-02", suspendedOn: "2026-09-01" },
  ]
  const list = (await ctx.api("GET", "/employee-mailboxes")).body.mailboxes
  const records = []
  for (const d of defs) {
    const emp = ctx.state.employees[d.key]
    const address = `test-${d.key.toLowerCase()}@mail.${TEST_EMAIL_DOMAIN}`
    const body = { address, status: d.status, provider: "google", note: T("測試信箱台帳，內容可忽略") }
    if (d.activatedOn) body.activatedOn = d.activatedOn
    if (d.suspendedOn) body.suspendedOn = d.suspendedOn
    const cur = list.find((m) => m.employeeId === emp.id)
    let row = cur
    if (cur && cur.address === address && cur.status === d.status) {
      ctx.reused(`專屬 Email ${emp.name} ${address}（${d.status}）`)
    } else {
      row = (await ctx.api("PUT", `/employee-mailboxes/${emp.id}`, body)).body.mailbox
      ctx.created(`專屬 Email ${emp.name} ${address}（${d.status}）`)
    }
    records.push({ id: row.id, name: `${emp.name} ${address}`, note: `status ${d.status}` })
  }
  ctx.manifest.push({ page: "/admin/employee-mail", feature: "專屬 Email 配發", records })
}

// ---------------------------------------------------------------------------
// 8. 備份快照（分段執行）
// ---------------------------------------------------------------------------
/** 續打時 API 回讀 manifest 可能撞到 CDN 舊版（503 manifest_stale）；同一段連續重試上限。 */
const BACKUP_STALE_RETRIES = 10

async function runBackupLoop(ctx, period) {
  let body = { period }
  let staleRetries = 0 // 連續 manifest_stale 次數，成功一段就歸零
  for (let step = 1; step <= BACKUP_MAX_STEPS; step++) {
    const r = await ctx.tryApi("POST", "/backups/run", body)
    if (r.status === 503 && r.body?.error === "manifest_stale" && staleRetries < BACKUP_STALE_RETRIES) {
      staleRetries++
      ctx.log(`  快照 ${period} 第 ${step} 段：manifest_stale（CDN 延遲），15 秒後重試（${staleRetries}/${BACKUP_STALE_RETRIES}）`)
      await sleep(15_000)
      step--
      continue
    }
    staleRetries = 0
    if (r.status < 200 || r.status >= 300) {
      const err = new Error(`POST /backups/run（${period}）→ ${r.status}: ${JSON.stringify(r.body)}`)
      err.status = r.status
      err.body = r.body
      throw err
    }
    const s = r.body
    ctx.log(`  快照 ${period} 第 ${step} 段：table=${s.table} rows=${s.rowsWritten} tables=${s.tablesCompleted} ${s.elapsedMs}ms done=${s.done}`)
    if (s.done) return { steps: step, manifestPath: s.manifestPath ?? null }
    body = { period, table: s.nextTable, offset: s.nextOffset }
  }
  throw new Error(`快照 ${period} 超過 ${BACKUP_MAX_STEPS} 段仍未完成`)
}

/** GET /backups；剛跑完的期別 manifest 可能還是 CDN 舊版（manifestStale），最多等 3 次再回。 */
async function listBackupPeriods(ctx) {
  let periods = (await ctx.api("GET", "/backups")).body.periods
  for (let i = 0; i < 3 && periods.some((p) => BACKUP_PERIODS.includes(p.period) && p.manifestStale); i++) {
    ctx.log(`  GET /backups 有 manifestStale 的期別，20 秒後重讀（${i + 1}/3）`)
    await sleep(20_000)
    periods = (await ctx.api("GET", "/backups")).body.periods
  }
  return periods
}

async function seedBackups(ctx) {
  const listPeriods = () => listBackupPeriods(ctx)
  let periods = await listPeriods()
  const records = []
  for (const period of BACKUP_PERIODS) {
    const cur = periods.find((p) => p.period === period)
    if (cur?.manifest?.status === "complete") {
      ctx.reused(`備份快照 ${period}（complete，${cur.manifest.totals?.tables ?? "?"} 表／${cur.manifest.totals?.rows ?? "?"} 列）`)
    } else {
      if (cur) ctx.log(`  備份快照 ${period} 已存在但 status=${cur.manifest?.status ?? "無 manifest"}，重跑`)
      const out = await runBackupLoop(ctx, period)
      ctx.created(`備份快照 ${period}（${out.steps} 段，manifest ${out.manifestPath ?? `${ctx.tenantId}/${period}/manifest.json`}）`)
    }
  }
  // 讀回清單（listBackupPeriods 已處理剛跑完的 manifestStale）
  periods = await listPeriods()
  for (const period of BACKUP_PERIODS) {
    const cur = periods.find((p) => p.period === period)
    const m = cur?.manifest
    records.push({
      id: `tenant-snapshots/${ctx.tenantId}/${period}/manifest.json`,
      name: `${T("備份")}${period}`,
      note: m ? `status ${m.status}／${m.totals?.tables} 表／${m.totals?.rows} 列／${cur.files?.length ?? "?"} 檔${cur.manifestStale ? "（manifestStale）" : ""}` : "清單裡沒有 manifest",
    })
  }
  ctx.manifest.push({ page: "/admin/backups", feature: "備份快照（整租戶全表快照；Storage bucket tenant-snapshots）", records })
}

// ---------------------------------------------------------------------------
// 9. 通知／稽核：只讀回，不手灌
// ---------------------------------------------------------------------------
/** 本模組會留下稽核軌跡的表（DB trigger：sql/0019、0025、0033；應用層 writeAuditLog：announcements、tenant_snapshots）。 */
const AUDIT_TABLES = [
  "announcements",
  "announcement_versions",
  "announcement_acknowledgements",
  "employee_mailboxes",
  "onboardings",
  "tenant_snapshots",
]
/** manifest 每張表最多列幾筆（不然全被同一張表洗版）。 */
const AUDIT_PER_TABLE = 4

async function collectNotificationsAndAudit(ctx) {
  const employees = (await ctx.api("GET", "/employees")).body.employees
  const testEmpIds = new Set(employees.filter((e) => e.name.startsWith(T(""))).map((e) => e.id))
  const nameOf = new Map(employees.map((e) => [e.id, e.name]))

  // 通知：HR 看整租戶；先挑「收件人是測試員工」的，再補「標題／內文含【測試】」的（寄給真實簽核者的）
  const notifications = (await ctx.api("GET", "/notifications")).body.notifications
  const toTest = notifications.filter((n) => testEmpIds.has(n.employee_id))
  const mentionTest = notifications.filter((n) => !testEmpIds.has(n.employee_id) && ((n.title ?? "").includes(T("")) || (n.body ?? "").includes(T(""))))
  const mine = [...toTest, ...mentionTest]
  ctx.log(`  通知：全租戶 ${notifications.length} 筆；收件人為測試員工 ${toTest.length} 筆、內容提及【測試】但寄給其他人 ${mentionTest.length} 筆`)
  if (mine.length < 3) {
    ctx.issue(`通知只讀到 ${mine.length} 筆與測試相關的列（<3）：本模組的操作不會入列通知（通知只由簽核／出勤表／放款／異常偵測產生），需先跑 attendance／finance 等會送單簽核的模組`)
  }
  ctx.manifest.push({
    page: "/admin/notifications",
    feature: "通知（由操作自動產生，未手灌）",
    records: mine.slice(0, 20).map((n) => ({ id: n.id, name: `${n.title}（→ ${nameOf.get(n.employee_id) ?? n.employee_id}）`, note: `type ${n.type}／status ${n.status}／由操作自動產生` })),
  })

  // 稽核：先取本模組相關表、內容含【測試】或備份期別的列；不足 3 筆再用 q=【測試】全域補
  const tag = T("")
  const relevant = (l) => {
    const text = JSON.stringify(l)
    if (l.tableName === "tenant_snapshots") return BACKUP_PERIODS.some((p) => text.includes(p))
    return text.includes(tag)
  }
  const byTable = (await ctx.api("GET", `/audit-logs?table=${AUDIT_TABLES.join(",")}&limit=200`)).body.logs.filter(relevant)
  let logs = byTable
  if (logs.length < 3) {
    const global = (await ctx.api("GET", `/audit-logs?q=${encodeURIComponent(tag)}&limit=50`)).body.logs
    logs = [...byTable, ...global.filter((g) => !byTable.some((b) => b.id === g.id))]
  }
  ctx.log(`  稽核：本模組相關表（${AUDIT_TABLES.join("、")}）含【測試】／備份期別的列 ${byTable.length} 筆（最多 200）`)
  if (logs.length < 3) ctx.issue(`稽核只讀到 ${logs.length} 筆與測試相關的列（<3）`)
  // 每張表最多 AUDIT_PER_TABLE 筆（列表本來就新到舊），讓公告／簽收／報到／信箱／備份各自看得到
  const perTable = new Map()
  const picked = logs.filter((l) => {
    const n = perTable.get(l.tableName) ?? 0
    if (n >= AUDIT_PER_TABLE) return false
    perTable.set(l.tableName, n + 1)
    return true
  })
  ctx.manifest.push({
    page: "/admin/audit-logs",
    feature: "稽核（由操作自動產生，未手灌）",
    records: picked.slice(0, 24).map((l) => ({ id: l.id, name: `${l.tableLabel ?? l.tableName} ${l.action}：${l.recordLabel ?? l.recordId ?? ""}`, note: `${l.source}／${l.context ?? ""}／${l.at}／由操作自動產生` })),
  })
}

// ---------------------------------------------------------------------------
export async function seed(ctx) {
  if (!ctx.state.employees?.A || !ctx.state.dept?.root) throw new Error("需要 00-base 先填 ctx.state.employees／dept")
  const tokenOf = tokenCache(ctx)

  await seedAnnouncements(ctx, tokenOf)
  await seedCompanyPages(ctx)
  await seedKnowledge(ctx)
  await seedOnboardings(ctx)
  await seedRecruitment(ctx)
  await seedKpi(ctx, tokenOf)
  await seedMailboxes(ctx)
  await seedBackups(ctx)
  await collectNotificationsAndAudit(ctx)
}
