import { z } from "zod"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { localDateKey } from "../lib/tz.js"
import { BINDABLE_ADVANCE_STATUSES, isBindableAdvance, isBindableTrip } from "./expense-binding.js"
import { PERIOD_RE, PeriodClosedError, isPeriodClosed } from "./period-lock.js"

/**
 * 建立一張報銷單（POST /expenses 的主體，2026-11-05 自 routes/expenses.ts 原樣搬出）。
 *
 * 搬出來是為了讓公務車「用車費用轉報銷」（POST /vehicle-trips/:id/expense-claims）走**同一條**驗證與
 * 鎖期規則，不另寫一套。行為零變更：POST /expenses 現在是 parse → resolveSelf → createExpenseClaim →
 * 依結果回應的薄包裝；`PeriodClosedError` 仍 throw，交給全域 handler 回 409 period_closed；
 * 讀寫 DB 失敗也照舊 throw（呼叫端 next(err) → 500）。
 *
 * 報銷沒有事前簽核鏈：送出即 `submitted`，財務月結時一次 `settled`（見 routes/expenses.ts 檔頭說明）。
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

export const claimSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().positive(),
  incurredOn: z.string().regex(dateRe),
  /** 省略時由 incurredOn 推導（發生月）。遲交的單可明確指定歸屬期。 */
  period: z.string().regex(PERIOD_RE).optional(),
  note: z.string().trim().max(250).optional(),
  /**
   * 代填已移除（2026-10-11，與 POST /requests 的代申請一起）。欄位留在 schema 只為了偵測：
   * 對象不是本人 → 400 filing_on_behalf_removed（不分角色）；是本人或沒帶 → 照常。
   */
  onBehalfOfEmployeeId: z.string().uuid().optional(),
  /**
   * 綁定的出差單（模組三第 2 條）。類別的 `requires_trip_approval` 為 true 時必填；
   * 沒要求也可以選填（自行墊付的出差憑證靠它對回哪一趟）。**有帶就驗**：須為本人的
   * business_trip，否則 400 `invalid_trip_request`；須已核准——例外：類別沒要求出差核准時，
   * 簽核中（pending）的也可以綁（公出表單當場填報銷，2026-10-16）；類別要求核准而出差單還在簽核
   * → 400 `trip_not_approved`。
   */
  tripRequestId: z.string().uuid().optional(),
  /**
   * 這筆費用用哪一筆預支的錢付的（模組三第 2、3 條的沖抵連結；員工在 ESS 報銷頁選
   * 「這筆是哪次預支的花費？」）。**有帶就驗**：須為本人、同租戶、尚未核銷
   * （requested／paid）的預支，否則 400 `invalid_advance`。綁了預支的憑證由預支核銷結算、
   * 不再隨月薪報銷給付。出差軌若該趟已有預支，省略時由系統自動綁上；零用金必須明指。
   */
  advanceId: z.string().uuid().optional(),
})

export type ClaimInput = z.infer<typeof claimSchema>

export type CreateExpenseClaimResult =
  | { ok: true; id: string; period: string; nature: string; advanceId: string | null }
  | { ok: false; status: number; body: Record<string, unknown> }

/** 該期是否已核銷（已核銷即鎖定，不得再增減）。 */
export async function periodIsSettled(tenantId: string, period: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("expense_settlements")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("period", period)
    .maybeSingle()
  if (error) throw new Error(`expenses period status: ${error.message}`)
  return data?.status === "settled"
}

/**
 * 該期被什麼鎖住：'closed'＝發薪鎖定（period_closes，services/period-lock.ts），'settled'＝報銷月結
 * （expense_settlements），沒鎖＝null。兩個都鎖時回 'closed'（發薪鎖定是更後面那一關）。
 */
export async function periodLockReason(tenantId: string, period: string): Promise<"closed" | "settled" | null> {
  if (await isPeriodClosed(tenantId, period)) return "closed"
  if (await periodIsSettled(tenantId, period)) return "settled"
  return null
}

/** 租戶當地的「本月」（YYYY-MM）；已月結鎖定（報銷月結或發薪鎖定）則回 null。 */
export async function currentOpenPeriod(tenantId: string): Promise<string | null> {
  const tz = await getTenantTimezone(tenantId)
  const current = localDateKey(new Date().toISOString(), tz).slice(0, 7)
  return (await periodLockReason(tenantId, current)) ? null : current
}

/**
 * 以 `self`（token 的主人，已由呼叫端 resolveSelf）的身分建一張報銷單。
 * 失敗回 `{ ok:false, status, body }`（呼叫端原樣回應）；發薪鎖定 throw `PeriodClosedError`；DB 錯誤 throw。
 */
export async function createExpenseClaim(
  tenantId: string,
  self: { id: string; role: string },
  input: ClaimInput,
  /** 錯誤訊息前綴（POST /expenses 沿用舊字串；其他呼叫端可自訂以利追查）。 */
  context = "POST /expenses",
): Promise<CreateExpenseClaimResult> {
  // 代填已移除：對象不是本人 → 一律 400（不分角色；舊版頁面不能把單默默記到填單人自己名下）。
  // 對象就是本人（uuid 不分大小寫）或沒帶 → 照常；報銷人永遠是 token 的主人。
  const onBehalf = input.onBehalfOfEmployeeId
  if (onBehalf && onBehalf.toLowerCase() !== self.id.toLowerCase()) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "filing_on_behalf_removed",
        message: "代為申請功能已移除，申請單只能以本人身分送出",
      },
    }
  }
  const employeeId = self.id
  // 歸屬期；該月已月結鎖定時，綁預支的憑證可以改歸本月（見下面「鎖期」），其餘照舊 409。
  let period = input.period ?? input.incurredOn.slice(0, 7)
  const periodLocked = await periodLockReason(tenantId, period)

  const { data: cat, error: catErr } = await supabaseAdmin
    .from("expense_categories")
    .select("id, nature, active, requires_trip_approval")
    .eq("tenant_id", tenantId)
    .eq("id", input.categoryId)
    .maybeSingle()
  if (catErr) throw new Error(`${context} (category): ${catErr.message}`)
  if (!cat || cat.active === false) {
    return { ok: false, status: 400, body: { error: "invalid_category" } }
  }

  // ── 兩軌政策的閘門（模組三第 1 條 vs 第 2 條）────────────────────
  // 日常常態不事前審核；長途出差必須老闆簽核。**沒有這道檢查，出差費用
  // 可以拆成「日常」報銷繞過事前審核，第 2 條即形同虛設。**
  if (cat.requires_trip_approval === true && !input.tripRequestId) {
    return { ok: false, status: 400, body: { error: "trip_request_required" } }
  }
  // 出差單綁定：類別沒要求時也是選填，但**有帶就驗**（不再只在類別要求時才驗——
  // 否則員工可以把憑證掛到別人的出差單上）。須為本人的 business_trip、已核准（或見下方簽核中的例外）。
  if (input.tripRequestId) {
    const { data: trip, error: tripErr } = await supabaseAdmin
      .from("leave_requests")
      .select("id, tenant_id, kind, status, employee_id")
      .eq("tenant_id", tenantId)
      .eq("id", input.tripRequestId)
      .is("deleted_at", null)
      .maybeSingle()
    if (tripErr) throw new Error(`${context} (trip): ${tripErr.message}`)
    // 不區分「不存在」「非出差單」「非本人」——一律同一個錯誤，免得成為探測他人單號的管道。
    // 簽核中的出差單（2026-10-16，公出表單「自行墊付」當場填報銷）：類別沒要求出差核准時可綁；
    // 類別要求出差核准（第 2 條閘門）→ 400 trip_not_approved（本人的單，告訴他原因不會洩漏什麼）。
    const gated = cat.requires_trip_approval === true
    if (!isBindableTrip(trip, { tenantId, employeeId }, { allowPending: !gated })) {
      const ownPending = gated && isBindableTrip(trip, { tenantId, employeeId }, { allowPending: true })
      return { ok: false, status: 400, body: { error: ownPending ? "trip_not_approved" : "invalid_trip_request" } }
    }
  }

  // 預支綁定（2026-10-11）：明指的 advanceId 必須是本人、同租戶、尚未核銷的預支——
  // 原本完全不驗，員工可以把憑證掛到別人的預支（別人的核銷多算一筆、自己的憑證又因為
  // 綁了預支而被排除在月報銷之外）。同樣不區分原因，統一 400 invalid_advance。
  // 定額補貼（allowance）不能綁預支：補貼屬薪資所得（進 gross、計入投保薪資），綁了預支就會改走
  // 非所得的差額結算，等於把補貼轉成實報實銷。ESS 對這類別不顯示預支欄位，這裡是 API 層的保險。
  const canBindAdvance = cat.nature !== "allowance"
  if (input.advanceId) {
    if (!canBindAdvance) {
      return { ok: false, status: 400, body: { error: "invalid_advance", message: "定額補貼不能綁預支" } }
    }
    const { data: adv, error: advErr } = await supabaseAdmin
      .from("advances")
      .select("id, tenant_id, employee_id, status")
      .eq("tenant_id", tenantId)
      .eq("id", input.advanceId)
      .maybeSingle()
    if (advErr) throw new Error(`${context} (advance check): ${advErr.message}`)
    if (!isBindableAdvance(adv, { tenantId, employeeId })) {
      return { ok: false, status: 400, body: { error: "invalid_advance" } }
    }
  }

  // 沖抵連結：出差軌若該趟已開預支，未明指時自動綁上——同仁沒有理由
  // 記得自己的預支單號，而漏綁會讓核銷算不到這筆、差額算錯。
  let advanceId = input.advanceId ?? null
  if (!advanceId && input.tripRequestId && canBindAdvance) {
    // limit(1)：預支沒有 request_id 的唯一索引，萬一併發核准開出兩列，maybeSingle() 會讓該趟的
    // 所有報銷都 500；取最早那一列就好。
    const { data: adv, error: advErr } = await supabaseAdmin
      .from("advances")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("request_id", input.tripRequestId)
      .eq("employee_id", employeeId)
      .in("status", [...BINDABLE_ADVANCE_STATUSES])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (advErr) throw new Error(`${context} (advance): ${advErr.message}`)
    advanceId = (adv?.id as string | undefined) ?? null
  }

  // ── 鎖期 ───────────────────────────────────────────────────────
  // 該期已月結 → 不得再填報（409），**例外：綁了預支的憑證**。它們的付款路徑是預支核銷
  // （POST /advances/:id/settle 合計綁定憑證），與歸屬期無關，月薪也不付它們；若連它們也被鎖期擋住，
  // 跨月的出差（月底出差、HR 月初就月結上個月）員工就綁不上，核銷時整筆預支被算成員工應退全額。
  // 所以改歸「本月」（發生日 incurred_on 維持實際日期）；本月也已鎖定就照舊 409。
  if (periodLocked) {
    const open = advanceId ? await currentOpenPeriod(tenantId) : null
    if (!open) {
      if (periodLocked === "closed") throw new PeriodClosedError([period])
      return { ok: false, status: 409, body: { error: "period_settled", period } }
    }
    period = open
  }

  const { data, error } = await supabaseAdmin
    .from("expense_claims")
    .insert({
      tenant_id: tenantId,
      employee_id: employeeId,
      category_id: input.categoryId,
      nature: cat.nature, // 凍結當時的稅務性質
      amount: input.amount,
      incurred_on: input.incurredOn,
      period,
      note: input.note ?? null,
      status: "submitted",
      trip_request_id: input.tripRequestId ?? null,
      advance_id: advanceId,
    })
    .select("id, period, nature, advance_id")
    .single()
  if (error || !data) throw new Error(`${context}: ${error?.message}`)
  return {
    ok: true,
    id: data.id as string,
    period: data.period as string,
    nature: data.nature as string,
    advanceId: (data.advance_id as string | null) ?? null,
  }
}
