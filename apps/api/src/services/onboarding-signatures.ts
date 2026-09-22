import { supabaseAdmin } from "../lib/supabase.js"

export type AckKind = "consent_to_change" | "accept_on_hire"

/**
 * 待簽列的共同寫入點（W5）。`versionIds × employeeIds` 的笛卡兒積各建一列
 * （signed_at 為 null＝待簽），**ignoreDuplicates**：重跑不覆蓋已簽好的紀錄。
 *
 * 回實際新建的筆數。**永不 throw**——呼叫端（報到完成、發佈公告、建員工）
 * 的主要動作都已經成功，不該因為待簽清單建不出來而失敗。
 */
export async function seedAcknowledgementsFor(
  tenantId: string,
  opts: { versionIds: string[]; employeeIds: string[]; kind: AckKind },
): Promise<number> {
  const versionIds = Array.from(new Set(opts.versionIds.filter(Boolean)))
  const employeeIds = Array.from(new Set(opts.employeeIds.filter(Boolean)))
  if (versionIds.length === 0 || employeeIds.length === 0) return 0

  const rows = versionIds.flatMap((versionId) =>
    employeeIds.map((employeeId) => ({
      tenant_id: tenantId,
      version_id: versionId,
      employee_id: employeeId,
      kind: opts.kind,
    })),
  )
  try {
    const { data, error } = await supabaseAdmin
      .from("announcement_acknowledgements")
      .upsert(rows, { onConflict: "tenant_id,version_id,employee_id", ignoreDuplicates: true })
      .select("id")
    if (error) {
      console.error(`[announcements] seed acknowledgements failed: ${error.message}`)
      return 0
    }
    return (data ?? []).length
  } catch (err) {
    console.error("[announcements] seed acknowledgements threw:", err)
    return 0
  }
}

/** 本租戶在職員工 id（離職者不該進待簽分母）。 */
export async function activeEmployeeIds(tenantId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
  if (error) {
    console.error(`[announcements] load active employees failed: ${error.message}`)
    return []
  }
  return (data ?? []).map((row) => row.id as string)
}

/**
 * 某一版公告對**全體在職員工**建待簽列（W5）。
 *
 * 客戶原文：「20 個人 5 個沒簽」——要看得出分母，就得在**發佈／進版當下**
 * 把全員的待簽列建出來。原本只有「報到完成／員工自己開過／HR 登錄」三條路
 * 會產生列，沒開過 App 的人根本不在名單裡，於是「誰還沒簽」永遠少算。
 *
 * kind 固定 'consent_to_change'：這是在職員工對條款變更的同意，與新人到職
 * 補簽的 'accept_on_hire' 法律性質不同（同意率只算前者）。
 */
export async function seedVersionAcknowledgements(
  tenantId: string,
  versionId: string,
): Promise<number> {
  const employeeIds = await activeEmployeeIds(tenantId)
  return seedAcknowledgementsFor(tenantId, {
    versionIds: [versionId],
    employeeIds,
    kind: "consent_to_change",
  })
}

/**
 * 新人報到時生成待簽清單（模組二第 3 條）。
 *
 * 客戶原文：「新進同仁需於**現行生效公告文件**之後續欄位進行補簽」——
 * 注意是**複數**：新人要簽的是所有現行生效且需簽收的規章，不是一份。
 * 故報到完成時一次把待簽項全部建出來，`announcement_acknowledgements`
 * 的「誰還沒簽」清單自然涵蓋新人，不必另做一套。
 *
 * `kind = 'accept_on_hire'`：新人補簽的法律性質是**接受既有勞動條件**
 * （對他而言不存在「變更」，這是聘僱條件的一部分），與在職員工簽不利益
 * 變更的「**同意變更**」不同。盤點同意率時 accept_on_hire 既不進分母也不
 * 進分子——混算會讓同意率失真，而該比率正是不利益變更是否生效的關鍵事實。
 *
 * 建立的是**待簽**項（signed_at 為 null）。實際簽署日要等紙本簽完由 HR
 * 登錄，不可從掃描檔推斷（傳閱單頂上是公告日期，不是補簽日期）。
 *
 * **永不 throw**：報到本身已經成功，不該因為待簽清單建不出來而失敗。
 * 回傳實際建立的筆數供呼叫端回報。
 */
export async function seedHireAcknowledgements(
  tenantId: string,
  employeeId: string,
  onDate: string = new Date().toISOString().slice(0, 10),
): Promise<number> {
  try {
    // 現行生效 = 已開始生效（或未設生效日）且尚未失效，且該版需要簽收。
    const { data: versions, error } = await supabaseAdmin
      .from("announcement_versions")
      .select("id, effective_from, effective_to")
      .eq("tenant_id", tenantId)
      .eq("requires_signature", true)
      .or(`effective_to.is.null,effective_to.gt.${onDate}`)
    if (error) {
      console.error(`[onboarding] seed acknowledgements failed: ${error.message}`)
      return 0
    }

    const effective = (versions ?? []).filter((v) => {
      const from = v.effective_from as string | null
      return from === null || from <= onDate
    })
    if (effective.length === 0) return 0

    return await seedAcknowledgementsFor(tenantId, {
      versionIds: effective.map((v) => v.id as string),
      employeeIds: [employeeId],
      kind: "accept_on_hire",
    })
  } catch (err) {
    console.error("[onboarding] seed acknowledgements threw:", err)
    return 0
  }
}
