/**
 * docs/test/seed-test/00-base.mjs — 測試資料的地基（永遠第一個跑）。
 *
 * 建的東西（全部冪等：先 GET 列表用名稱／email／code 比對，有就沿用）：
 *   1. 部門 3：【測試】測試部（root）、【測試】測試一組／二組（parent＝測試部）
 *   2. 員工 3（lib.mjs 的 TEST_EMPLOYEES）：全掛在測試部；A 當測試部主管
 *      （B、C 的簽核鏈才會走到 A）；建完用 service role 把三位的
 *      must_change_password 關掉，讓業主能直接用測試帳號登入前台。
 *   3. 每位員工：profile／學歷／證照／工作經歷／職務經歷各 1 筆（全帶【測試】）
 *   4. 假別 3（code test_a／test_b／test_c）
 *   5. 班別 3
 *   6. 行事曆 3 天（2026-12-28～30，dayType workday＝本來就是平日，不改變任何人的出勤）
 *   7. 內部連結 3（保留既有連結，只附加）
 *   8. ctx.state.approvalFlows = GET /approval-flows（只讀，給後續模組決定簽核走法）
 *
 * 填入 ctx.state：
 *   employees: { A:{id,userId,email,name,role,empNo,deptId}, B, C }
 *   dept:      { root:{id,name}, sub1:{id,name}, sub2:{id,name} }
 *   leaveTypes:{ A:{id,code,name}, B, C }
 *   shifts:    { A:{id,name}, B, C }
 *   approvalFlows: GET /approval-flows 的 flows 原樣
 */

import { T, TEST_EMPLOYEES } from "./lib.mjs"

export const name = "base"

const DEPT_ROOT = T("測試部")
const DEPT_SUB1 = T("測試一組")
const DEPT_SUB2 = T("測試二組")

const LEAVE_TYPES = [
  { key: "A", code: "test_a", name: T("假別A"), paid: true, deductRate: 0, requiresAttachment: false },
  { key: "B", code: "test_b", name: T("假別B"), paid: false, deductRate: 1, requiresAttachment: false },
  { key: "C", code: "test_c", name: T("假別C"), paid: true, deductRate: 0, requiresAttachment: true },
]

const SHIFTS = [
  { key: "A", name: T("班別A"), startTime: "09:00", endTime: "18:00", breakMinutes: 60 },
  { key: "B", name: T("班別B"), startTime: "10:00", endTime: "19:00", breakMinutes: 60 },
  { key: "C", name: T("班別C"), startTime: "13:00", endTime: "22:00", breakMinutes: 60 },
]

const CALENDAR_DAYS = [
  { date: "2026-12-28", dayType: "workday", label: T("行事曆A") },
  { date: "2026-12-29", dayType: "workday", label: T("行事曆B") },
  { date: "2026-12-30", dayType: "workday", label: T("行事曆C") },
]

const INTERNAL_LINKS = [
  { name: T("連結A"), url: "https://example.com/test-a", enabled: true },
  { name: T("連結B"), url: "https://example.com/test-b", enabled: true },
  { name: T("連結C"), url: "https://example.com/test-c", enabled: true },
]

// ---------------------------------------------------------------------------
// 1. 部門
// ---------------------------------------------------------------------------
async function seedDepartments(ctx) {
  const listDepts = async () => (await ctx.api("GET", "/departments")).body.departments
  const root = await ctx.ensure({
    list: listDepts,
    match: (d) => d.name === DEPT_ROOT,
    create: async () => (await ctx.api("POST", "/departments", { name: DEPT_ROOT, parentId: null })).body.id,
    label: `部門 ${DEPT_ROOT}`,
  })
  const subs = {}
  for (const [key, subName] of [["sub1", DEPT_SUB1], ["sub2", DEPT_SUB2]]) {
    const sub = await ctx.ensure({
      list: listDepts,
      match: (d) => d.name === subName,
      create: async () => (await ctx.api("POST", "/departments", { name: subName, parentId: root.id })).body.id,
      label: `部門 ${subName}`,
    })
    // 既有子部門若沒掛在測試部底下，對齊 parent
    if (sub.parent_id !== undefined && sub.parent_id !== root.id) {
      await ctx.api("PATCH", `/departments/${sub.id}`, { parentId: root.id })
      ctx.log(`  ↳ 已把 ${subName} 的 parent 對齊為 ${DEPT_ROOT}`)
    }
    subs[key] = { id: sub.id, name: subName }
  }
  ctx.state.dept = { root: { id: root.id, name: DEPT_ROOT }, ...subs }
  ctx.manifest.push({
    page: "/admin/departments",
    feature: "部門",
    records: [
      { id: root.id, name: DEPT_ROOT },
      { id: subs.sub1.id, name: DEPT_SUB1, note: "parent＝測試部" },
      { id: subs.sub2.id, name: DEPT_SUB2, note: "parent＝測試部" },
    ],
  })
}

// ---------------------------------------------------------------------------
// 2. 員工
// ---------------------------------------------------------------------------
/** [service-role] 用 email 找 auth user id（GET /employees 不回 email，只有 409 email_exists 時才需要）。 */
async function findAuthUserIdByEmail(ctx, email) {
  let page = 1
  for (;;) {
    const { data, error } = await ctx.admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`[service-role] listUsers 失敗：${error.message}`)
    const hit = (data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase())
    if (hit) return hit.id
    if (!data?.users?.length || data.users.length < 200) return null
    page++
  }
}

async function ensureEmployee(ctx, def, deptId) {
  const list = (await ctx.api("GET", "/employees")).body.employees
  let row = list.find((e) => e.name === def.name)
  if (row) {
    ctx.reused(`員工 ${def.name}（${def.email}）`)
  } else {
    const r = await ctx.tryApi("POST", "/employees", {
      email: def.email,
      name: def.name,
      password: ctx.testPassword,
      role: def.role,
      deptId,
      empNo: def.empNo,
      employmentType: def.employmentType,
      hireDate: def.hireDate,
    })
    if (r.status === 201) {
      row = { id: r.body.employeeId, user_id: r.body.userId, name: def.name, role: def.role, dept_id: deptId, emp_no: def.empNo, employment_type: def.employmentType, hire_date: def.hireDate, status: "active" }
      ctx.created(`員工 ${def.name}（${def.email}）`)
    } else if (r.status === 409 && r.body?.error === "email_exists") {
      // auth 帳號已存在但列表裡沒有同名員工 → 用 email 反查 user_id，再對回 employees 列
      ctx.log(`  [service-role] ${def.email} 的 auth 帳號已存在，用 email 反查 user_id`)
      const userId = await findAuthUserIdByEmail(ctx, def.email)
      row = userId ? list.find((e) => e.user_id === userId) : null
      if (!row) {
        const err = new Error(`測試員工 ${def.email} 的 auth 帳號已存在，但本租戶找不到對應的 employees 列（可能掛在別租戶或被改名）`)
        err.status = r.status
        err.body = r.body
        throw err
      }
      ctx.reused(`員工 ${def.name}（${def.email}，由 user_id 對回）`)
    } else {
      const err = new Error(`POST /employees（${def.email}）→ ${r.status}: ${JSON.stringify(r.body)}`)
      err.status = r.status
      err.body = r.body
      throw err
    }
  }

  // 對齊 name／role／dept／empNo／employmentType／hireDate／status（只 PATCH 有差異的欄位）
  const patch = {}
  if (row.name !== def.name) patch.name = def.name
  if (row.role !== def.role) patch.role = def.role
  if (row.dept_id !== deptId) patch.deptId = deptId
  if (row.emp_no !== def.empNo) patch.empNo = def.empNo
  if (row.employment_type !== def.employmentType) patch.employmentType = def.employmentType
  if (row.hire_date !== def.hireDate) patch.hireDate = def.hireDate
  if (row.status !== "active") patch.status = "active"
  if (Object.keys(patch).length > 0) {
    await ctx.api("PATCH", `/employees/${row.id}`, patch)
    ctx.log(`  ↳ 已對齊 ${def.name}：${Object.keys(patch).join("、")}`)
  }
  return {
    id: row.id,
    userId: row.user_id ?? null,
    email: def.email,
    name: def.name,
    role: def.role,
    empNo: def.empNo,
    employmentType: def.employmentType,
    hireDate: def.hireDate,
    deptId,
  }
}

async function seedEmployees(ctx) {
  const deptId = ctx.state.dept.root.id
  const employees = {}
  for (const def of TEST_EMPLOYEES) employees[def.key] = await ensureEmployee(ctx, def, deptId)
  ctx.state.employees = employees

  // A 當測試部主管（B、C 的 manager 簽核鏈才會走到 A）
  const depts = (await ctx.api("GET", "/departments")).body.departments
  const root = depts.find((d) => d.id === deptId)
  if (root?.manager_emp_id !== employees.A.id) {
    await ctx.api("PATCH", `/departments/${deptId}`, { managerEmpId: employees.A.id })
    ctx.log(`  ↳ 已設 ${employees.A.name} 為 ${ctx.state.dept.root.name} 主管`)
  } else {
    ctx.log(`  ${employees.A.name} 已是 ${ctx.state.dept.root.name} 主管`)
  }

  // [service-role] 關掉 must_change_password（沒有端點；POST /employees 一律設 true）
  const ids = Object.values(employees).map((e) => e.id)
  const { data, error } = await ctx.admin
    .from("employees")
    .update({ must_change_password: false })
    .eq("tenant_id", ctx.tenantId)
    .in("id", ids)
    .select("id")
  if (error) throw new Error(`[service-role] 關 must_change_password 失敗：${error.message}`)
  ctx.log(`  [service-role] 已把 ${data?.length ?? 0} 位測試員工的 must_change_password 設為 false`)

  // 確認三位都能用 SEED_TEST_PASSWORD 登入；登不進去（例如密碼被改過）就用 HR 端點重設後再關一次旗標
  for (const emp of Object.values(employees)) {
    try {
      await ctx.loginAs(emp.email, ctx.testPassword)
      ctx.log(`  登入驗證 OK：${emp.email}`)
    } catch (err) {
      ctx.log(`  ${emp.email} 用 SEED_TEST_PASSWORD 登不進去（${err.status ?? "?"}），改用 HR 重設密碼`)
      await ctx.api("POST", `/employees/${emp.id}/reset-password`, { password: ctx.testPassword })
      const upd = await ctx.admin.from("employees").update({ must_change_password: false }).eq("tenant_id", ctx.tenantId).eq("id", emp.id)
      if (upd.error) throw new Error(`[service-role] 關 must_change_password 失敗：${upd.error.message}`)
      await ctx.loginAs(emp.email, ctx.testPassword)
      ctx.log(`  [service-role] 已重設 ${emp.email} 密碼並關掉 must_change_password，登入驗證 OK`)
    }
  }

  ctx.manifest.push({
    page: "/admin/employees",
    feature: "員工",
    records: Object.values(employees).map((e) => ({ id: e.id, name: e.name, note: `${e.email}／${e.role}／${e.empNo}` })),
  })
}

// ---------------------------------------------------------------------------
// 3. 個人資料（profile／學歷／證照／工作經歷／職務經歷）
// ---------------------------------------------------------------------------
async function seedProfiles(ctx) {
  const genders = { A: "male", B: "female", C: "male" }
  for (const def of TEST_EMPLOYEES) {
    const emp = ctx.state.employees[def.key]
    const idx = def.key.charCodeAt(0) - "A".charCodeAt(0) + 1
    const before = (await ctx.api("GET", `/employees/${emp.id}/profile`)).body

    // profile 是 upsert，本身冪等；有既有列算 reused、沒有算 created
    await ctx.api("PUT", `/employees/${emp.id}/profile`, {
      englishName: `Test ${def.key}`,
      nationality: "TW",
      birthday: "1990-01-01",
      gender: genders[def.key],
      maritalStatus: "single",
      phone: `0900-000-00${idx}`,
      registeredAddress: T("測試市測試路1號"),
      address: T("測試市測試路1號"),
      companyEmail: emp.email,
      personalEmail: emp.email,
      emergencyContact: T("緊急聯絡人"),
      emergencyRelationship: T("關係"),
      emergencyPhone: "0900-000-009",
      note: T("測試資料，可刪除"),
    })
    if (before.profile) ctx.reused(`個人資料 ${def.name}`)
    else ctx.created(`個人資料 ${def.name}`)

    await ctx.ensure({
      list: async () => before.educations,
      match: (r) => r.school === T("測試大學"),
      create: async () =>
        (await ctx.api("POST", `/employees/${emp.id}/educations`, {
          school: T("測試大學"),
          isHighest: true,
          major: T("測試系"),
          degree: "bachelor",
          startDate: "2008-09-01",
          endDate: "2012-06-30",
        })).body.id,
      label: `學歷 ${def.name}`,
    })
    await ctx.ensure({
      list: async () => before.certifications,
      match: (r) => r.name === T("證照"),
      create: async () =>
        (await ctx.api("POST", `/employees/${emp.id}/certifications`, {
          name: T("證照"),
          issuer: T("發證單位"),
          issuedDate: "2020-01-01",
        })).body.id,
      label: `證照 ${def.name}`,
    })
    await ctx.ensure({
      list: async () => before.workHistory,
      match: (r) => r.company === T("前公司"),
      create: async () =>
        (await ctx.api("POST", `/employees/${emp.id}/work-history`, {
          company: T("前公司"),
          title: T("前職稱"),
          startDate: "2015-01-01",
          endDate: "2025-12-31",
          description: T("測試資料，可刪除"),
        })).body.id,
      label: `工作經歷 ${def.name}`,
    })
    await ctx.ensure({
      list: async () => before.jobHistory,
      match: (r) => r.action === "新進" && r.title === T("職稱"),
      create: async () =>
        (await ctx.api("POST", `/employees/${emp.id}/job-history`, {
          effectiveDate: def.hireDate,
          action: "新進",
          deptId: ctx.state.dept.root.id,
          deptName: ctx.state.dept.root.name,
          title: T("職稱"),
        })).body.id,
      label: `職務經歷 ${def.name}`,
    })
  }
}

// ---------------------------------------------------------------------------
// 4. 假別
// ---------------------------------------------------------------------------
async function seedLeaveTypes(ctx) {
  const listLt = async () => (await ctx.api("GET", "/leave-types")).body.leaveTypes
  const out = {}
  for (const lt of LEAVE_TYPES) {
    const row = await ctx.ensure({
      list: listLt,
      match: (r) => r.code === lt.code,
      create: async () =>
        (await ctx.api("POST", "/leave-types", {
          code: lt.code,
          name: lt.name,
          paid: lt.paid,
          deductRate: lt.deductRate,
          requiresAttachment: lt.requiresAttachment,
        })).body.id,
      label: `假別 ${lt.name}（${lt.code}）`,
    })
    // 既有列：對齊名稱／paid／deductRate／requiresAttachment（只 PATCH 有差異的）
    if (row.name !== undefined) {
      const patch = {}
      if (row.name !== lt.name) patch.name = lt.name
      if (row.paid !== lt.paid) patch.paid = lt.paid
      if (Number(row.deduct_rate) !== lt.deductRate) patch.deductRate = lt.deductRate
      // GET /leave-types 把 DB 的 requires_attachment 映射成 camelCase requiresAttachment（其餘欄位維持 snake_case）
      if ((row.requiresAttachment ?? row.requires_attachment ?? false) !== lt.requiresAttachment) patch.requiresAttachment = lt.requiresAttachment
      if (Object.keys(patch).length > 0) {
        await ctx.api("PATCH", `/leave-types/${row.id}`, patch)
        ctx.log(`  ↳ 已對齊假別 ${lt.code}：${Object.keys(patch).join("、")}`)
      }
    }
    out[lt.key] = { id: row.id, code: lt.code, name: lt.name }
  }
  ctx.state.leaveTypes = out
  ctx.manifest.push({
    page: "/admin/leave-types",
    feature: "假別",
    records: LEAVE_TYPES.map((lt) => ({ id: out[lt.key].id, name: lt.name, note: `${lt.code}／${lt.paid ? "paid" : "unpaid"}／deductRate ${lt.deductRate}${lt.requiresAttachment ? "／需附件" : ""}` })),
  })
}

// ---------------------------------------------------------------------------
// 5. 班別
// ---------------------------------------------------------------------------
async function seedShifts(ctx) {
  const listShifts = async () => (await ctx.api("GET", "/shifts")).body.shifts
  const out = {}
  for (const s of SHIFTS) {
    const row = await ctx.ensure({
      list: listShifts,
      match: (r) => r.name === s.name,
      create: async () =>
        (await ctx.api("POST", "/shifts", { name: s.name, startTime: s.startTime, endTime: s.endTime, breakMinutes: s.breakMinutes })).body.id,
      label: `班別 ${s.name}`,
    })
    out[s.key] = { id: row.id, name: s.name }
  }
  ctx.state.shifts = out
  ctx.manifest.push({
    page: "/admin/shifts",
    feature: "班別",
    records: SHIFTS.map((s) => ({ id: out[s.key].id, name: s.name, note: `${s.startTime}–${s.endTime}／休息 ${s.breakMinutes} 分` })),
  })
}

// ---------------------------------------------------------------------------
// 6. 行事曆
// ---------------------------------------------------------------------------
async function seedCalendar(ctx) {
  const year = CALENDAR_DAYS[0].date.slice(0, 4)
  const existing = (await ctx.api("GET", `/calendar?year=${year}`)).body.days
  const byDate = new Map(existing.map((d) => [d.date, d]))
  const toPut = []
  const records = []
  for (const day of CALENDAR_DAYS) {
    const cur = byDate.get(day.date)
    if (cur && cur.label === day.label && cur.day_type === day.dayType) {
      ctx.reused(`行事曆 ${day.date} ${day.label}`)
      records.push({ id: cur.id, name: day.label, note: `${day.date}／${day.dayType}` })
    } else if (cur && !(typeof cur.label === "string" && cur.label.startsWith("【測試】"))) {
      // 該日已有「不是測試資料」的裁定（例如業主自己設的假日）→ 不覆蓋
      ctx.issue(`行事曆 ${day.date} 已有非測試裁定（${cur.day_type}／${cur.label ?? "無標籤"}），略過不覆蓋`)
    } else {
      toPut.push(day)
    }
  }
  if (toPut.length > 0) {
    const put = (await ctx.api("PUT", "/calendar/days", { days: toPut })).body
    for (const day of toPut) {
      const row = (put.days ?? []).find((d) => d.date === day.date)
      ctx.created(`行事曆 ${day.date} ${day.label}`)
      records.push({ id: row?.id ?? day.date, name: day.label, note: `${day.date}／${day.dayType}` })
    }
  }
  ctx.manifest.push({ page: "/admin/calendar", feature: "行事曆", records })
}

// ---------------------------------------------------------------------------
// 7. 內部連結（tenants.features.internalLinks；PUT 是整個陣列取代 → 先讀再附加）
// ---------------------------------------------------------------------------
async function seedInternalLinks(ctx) {
  const current = (await ctx.api("GET", "/api/tenant/branding")).body
  const existing = Array.isArray(current.features?.internalLinks) ? current.features.internalLinks : []
  const merged = [...existing]
  const records = []
  for (const link of INTERNAL_LINKS) {
    const found = existing.find((l) => l?.name === link.name)
    if (found) {
      ctx.reused(`內部連結 ${link.name}`)
      records.push({ id: link.name, name: link.name, note: found.url })
      continue
    }
    merged.push({ ...link, sort: merged.length })
    ctx.created(`內部連結 ${link.name}`)
    records.push({ id: link.name, name: link.name, note: link.url })
  }
  if (merged.length !== existing.length) {
    // 既有連結原樣保留（只送 zod 認得的四個欄位，避免既有物件夾雜多餘鍵被 400）
    const payload = merged.map((l) => {
      const o = { name: l.name, url: l.url }
      if (typeof l.enabled === "boolean") o.enabled = l.enabled
      if (Number.isInteger(l.sort)) o.sort = l.sort
      return o
    })
    await ctx.api("PUT", "/api/tenant/settings", { features: { internalLinks: payload } })
    ctx.log(`  ↳ internalLinks：既有 ${existing.length} 筆保留 + 新增 ${merged.length - existing.length} 筆`)
  }
  ctx.manifest.push({ page: "/admin/company-space", feature: "內部連結", records })
}

// ---------------------------------------------------------------------------
// 8. 簽核流程（只讀）
// ---------------------------------------------------------------------------
async function readApprovalFlows(ctx) {
  const flows = (await ctx.api("GET", "/approval-flows")).body.flows ?? []
  ctx.state.approvalFlows = flows
  if (flows.length === 0) {
    ctx.log("  approval-flows：本租戶尚未設定任何 kind（＝全部走預設 manager 鏈：直屬主管 → fallback → 第一位 hr_admin）")
  }
  for (const f of flows) {
    ctx.log(`  approval-flows ${f.applies_to}: mode=${f.mode} approverEmpIds=${JSON.stringify(f.approver_emp_ids ?? [])}`)
  }
}

// ---------------------------------------------------------------------------
export async function seed(ctx) {
  await seedDepartments(ctx)
  await seedEmployees(ctx)
  await seedProfiles(ctx)
  await seedLeaveTypes(ctx)
  await seedShifts(ctx)
  await seedCalendar(ctx)
  await seedInternalLinks(ctx)
  await readApprovalFlows(ctx)

  const e = ctx.state.employees
  ctx.log(
    `\nstate：employees A=${e.A.id} B=${e.B.id} C=${e.C.id}｜dept root=${ctx.state.dept.root.id}｜` +
      `leaveTypes ${Object.values(ctx.state.leaveTypes).map((l) => `${l.code}=${l.id}`).join(" ")}｜` +
      `shifts ${Object.entries(ctx.state.shifts).map(([k, s]) => `${k}=${s.id}`).join(" ")}`,
  )
}
