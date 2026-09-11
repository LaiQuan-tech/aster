import { supabaseAdmin } from "../lib/supabase.js"

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

    const rows = effective.map((v) => ({
      tenant_id: tenantId,
      version_id: v.id as string,
      employee_id: employeeId,
      kind: "accept_on_hire",
    }))

    // ignoreDuplicates：重跑不該覆蓋已簽好的紀錄。
    const { data, error: insErr } = await supabaseAdmin
      .from("announcement_acknowledgements")
      .upsert(rows, {
        onConflict: "tenant_id,version_id,employee_id",
        ignoreDuplicates: true,
      })
      .select("id")
    if (insErr) {
      console.error(`[onboarding] seed acknowledgements insert failed: ${insErr.message}`)
      return 0
    }
    return (data ?? []).length
  } catch (err) {
    console.error("[onboarding] seed acknowledgements threw:", err)
    return 0
  }
}
