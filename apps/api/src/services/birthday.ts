/**
 * 生日提醒與壽星清單（M7）。
 *
 * 資料來源是 `employee_profiles.birthday`（一直有欄位但從來沒人讀，見計畫 §1b M7）。
 * 提醒只發給 HR：客戶要的是「HR 別忘了包紅包」，不是給全公司的祝賀廣播。
 *
 * 兩個時點各發一次——**T+3**（還來得及去領現金、買禮物）與 **T+0**（當天別忘了發），
 * 同一天同一個 payload key 不重複入列（比照 `project-alert-store.notifyProjectAlerts`
 * 的去重寫法）。入列走 `services/notify.ts` 的 enqueue，投遞交既有的
 * deliverPendingNotifications job，不另建管線。
 *
 * 2/29 出生的人在平年視為 **2/28**：不做調整的話他們四年才會被提醒一次。
 * 選 2/28 而非 3/1 是為了「當月壽星」清單仍落在二月（HR 是按月結算紅包的）。
 */
import { supabaseAdmin } from "../lib/supabase.js"
import { enqueue } from "./notify.js"

/** HR 收件人角色（與 project-alert-store 的 HR_ROLES 同義）。 */
const HR_ROLES = ["hr_admin", "platform_admin"] as const

export interface BirthdayProfile {
  employeeId: string
  name: string | null
  /** 'YYYY-MM-DD'；null／格式不對的列由 birthdaysBetween 略過。 */
  birthday: string | null
}

export interface BirthdayHit {
  employeeId: string
  name: string | null
  /** 原始生日 'YYYY-MM-DD'。 */
  birthday: string
  /** 今年實際落在哪一天（2/29 在平年＝2/28）。 */
  date: string
  /** 當天滿幾歲；生日年份不明時 null。 */
  age: number | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** 含頭含尾的日期清單；範圍上限 400 天（呼叫端只會用幾天到一個月）。 */
function eachDate(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out
  for (let t = start, i = 0; t <= end && i < maxDays; t += 86_400_000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/**
 * 區間內（含頭含尾）過生日的人。
 *
 * 逐日比對「月-日」而非算「下一次生日」，跨年（12/30 → 1/2）自然成立，
 * 不必特判。同一人在區間內最多出現一次，除非區間超過一年。
 */
export function birthdaysBetween(
  profiles: readonly BirthdayProfile[],
  from: string,
  to: string,
): BirthdayHit[] {
  const valid = profiles.filter(
    (p): p is BirthdayProfile & { birthday: string } =>
      typeof p.birthday === "string" && DATE_RE.test(p.birthday),
  )
  if (valid.length === 0) return []

  const byMmdd = new Map<string, Array<BirthdayProfile & { birthday: string }>>()
  for (const p of valid) {
    const mmdd = p.birthday.slice(5)
    const list = byMmdd.get(mmdd)
    if (list) list.push(p)
    else byMmdd.set(mmdd, [p])
  }

  const out: BirthdayHit[] = []
  for (const date of eachDate(from, to)) {
    const year = Number(date.slice(0, 4))
    const mmdd = date.slice(5)
    const matched = [...(byMmdd.get(mmdd) ?? [])]
    // 平年的 2/28 同時代表 2/29 出生的人。
    if (mmdd === "02-28" && !isLeapYear(year)) matched.push(...(byMmdd.get("02-29") ?? []))
    for (const p of matched) {
      const birthYear = Number(p.birthday.slice(0, 4))
      out.push({
        employeeId: p.employeeId,
        name: p.name,
        birthday: p.birthday,
        date,
        age: Number.isFinite(birthYear) && birthYear > 1900 ? year - birthYear : null,
      })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.name ?? "").localeCompare(b.name ?? ""))
}

/** 某個月（'YYYY-MM'）的壽星，依日期排序。 */
export function birthdaysInMonth(
  profiles: readonly BirthdayProfile[],
  month: string,
): BirthdayHit[] {
  const [y, m] = month.split("-").map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return []
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return birthdaysBetween(profiles, `${month}-01`, `${month}-${String(last).padStart(2, "0")}`)
}

/**
 * 本租戶在職員工的生日清單（沒填生日的人不會出現）。
 * employees 與 employee_profiles 分兩次查再併——`employee_profiles` 沒有
 * `status`，而只有在職者要進提醒與壽星清單。
 */
export async function loadBirthdayProfiles(tenantId: string): Promise<BirthdayProfile[]> {
  const { data: emps, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
  if (empErr) throw new Error(`loadBirthdayProfiles (employees): ${empErr.message}`)
  const nameById = new Map((emps ?? []).map((e) => [e.id as string, (e.name as string) ?? null]))
  if (nameById.size === 0) return []

  const { data: profiles, error: profErr } = await supabaseAdmin
    .from("employee_profiles")
    .select("employee_id, birthday")
    .eq("tenant_id", tenantId)
    .not("birthday", "is", null)
  if (profErr) throw new Error(`loadBirthdayProfiles (profiles): ${profErr.message}`)

  return (profiles ?? [])
    .filter((p) => nameById.has(p.employee_id as string))
    .map((p) => ({
      employeeId: p.employee_id as string,
      name: nameById.get(p.employee_id as string) ?? null,
      birthday: (p.birthday as string | null) ?? null,
    }))
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

function mdLabel(date: string): string {
  const [, m, d] = date.split("-")
  return `${Number(m)}/${Number(d)}`
}

/**
 * 跑一次生日提醒：今天（T+0）與三天後（T+3）的壽星各給全體在職 HR 一則通知。
 *
 * 回 `queued`＝實際入列的通知列數（人數 × 收件 HR 數），`skipped`＝今天已經
 * 發過所以跳過的。WP9 的 `POST /internal/people/birthday-reminder` 每天呼叫一次。
 */
export async function remindBirthdays(
  tenantId: string,
  today: string,
): Promise<{ queued: number; skipped: number }> {
  if (!DATE_RE.test(today)) throw new Error(`remindBirthdays: invalid today ${today}`)

  const profiles = await loadBirthdayProfiles(tenantId)
  if (profiles.length === 0) return { queued: 0, skipped: 0 }

  const soon = addDays(today, 3)
  const hits: Array<BirthdayHit & { stage: "today" | "in3" }> = [
    ...birthdaysBetween(profiles, today, today).map((h) => ({ ...h, stage: "today" as const })),
    ...birthdaysBetween(profiles, soon, soon).map((h) => ({ ...h, stage: "in3" as const })),
  ]
  if (hits.length === 0) return { queued: 0, skipped: 0 }

  const { data: hr, error: hrErr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .in("role", HR_ROLES as unknown as string[])
  if (hrErr) throw new Error(`remindBirthdays (hr): ${hrErr.message}`)
  const hrIds = (hr ?? []).map((e) => e.id as string)
  if (hrIds.length === 0) return { queued: 0, skipped: 0 }

  // 今天已入列的同 key 不重發（重跑 cron 不該洗版）。
  const { data: existing, error: exErr } = await supabaseAdmin
    .from("notifications")
    .select("employee_id, payload")
    .eq("tenant_id", tenantId)
    .eq("type", "birthday_reminder")
    .gte("created_at", `${today}T00:00:00+08:00`)
  if (exErr) throw new Error(`remindBirthdays (existing): ${exErr.message}`)
  const seen = new Set(
    (existing ?? []).map(
      (n) => `${n.employee_id as string}|${(n.payload as { key?: string } | null)?.key ?? ""}`,
    ),
  )

  let queued = 0
  let skipped = 0
  for (const hit of hits) {
    const key = `${hit.employeeId}|${hit.date}`
    const recipients = hrIds.filter((id) => {
      if (seen.has(`${id}|${key}`)) {
        skipped += 1
        return false
      }
      seen.add(`${id}|${key}`)
      return true
    })
    if (recipients.length === 0) continue

    const who = hit.name ?? "同仁"
    const when = mdLabel(hit.date)
    queued += await enqueue({
      tenantId,
      employeeIds: recipients,
      type: "birthday_reminder",
      title: hit.stage === "today" ? `今天是 ${who} 的生日（${when}）` : `${who} 三天後生日（${when}）`,
      body:
        hit.stage === "today"
          ? `記得致意並登記生日紅包（後台 → 人員 → 生日紅包）。`
          : `請先準備生日紅包，發放後到後台 → 人員 → 生日紅包登記金額並拍照留存。`,
      payload: {
        key,
        employeeId: hit.employeeId,
        date: hit.date,
        birthday: hit.birthday,
        stage: hit.stage,
      },
    })
  }

  return { queued, skipped }
}
