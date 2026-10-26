import { recomputeDraftRunsForProject } from "./bonus-run-store.js"

/**
 * 分潤改版 #3（業主 2026-10-26）：改合約額、追加減、成員趴數、獎金比例成功後，
 * 自動重算仍未發放的獎金批次。
 *
 * 真正的重算邏輯在獎金引擎（services/bonus-run-store.ts 的 `recomputeDraftRunsForProject`）；
 * 這裡只是寫入端共用的呼叫點：**best-effort**——重算失敗只記 log，不影響原本那次寫入的回應
 * （錢的資料已經存好了，草稿批次之後打開或重算一次都會對上）。
 *
 * 引擎的 recomputeDraftRunsForProject 重算的是**租戶全部**未發放 regular 批次（批次明細整租戶一起算，
 * 只挑含該案的批次會漏掉「這次才進批次」的案），projectId 只用於 log——所以一次寫入只呼叫一次，
 * 傳進來多個專案（例如追加減的新案＋原案）也不重複重算。永遠不 throw。
 */
export async function recomputeDraftRunsAfterWrite(
  tenantId: string,
  projectIds: Array<string | null | undefined>,
  context: string,
): Promise<void> {
  const ids = [...new Set(projectIds.filter((id): id is string => !!id))]
  if (ids.length === 0) return
  try {
    const res = await recomputeDraftRunsForProject(tenantId, ids[0] as string)
    if (res.failed.length > 0) {
      console.warn(`[bonus-recompute] ${context}: ${res.failed.length} 批重算失敗（專案 ${ids.join(",")}）`, res.failed)
    }
  } catch (err) {
    console.warn(`[bonus-recompute] ${context}: 重算草稿批次失敗（專案 ${ids.join(",")}）`, err)
  }
}
