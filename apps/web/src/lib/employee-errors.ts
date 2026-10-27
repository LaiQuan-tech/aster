/**
 * 員工管理（列表與內頁共用）的 API 錯誤 → 中文。`apiFetch` 的訊息形如 `[422] weak_password`：
 * 先抽出代碼再查各對照表；查不到就維持原字串（保留狀態碼方便回報），原字串也是空的才用 fallback。
 * 原本寫在 admin/employees/page.tsx 裡，2026-10-26 員工內頁上線後搬來共用。
 */
import { accountErrorMessage } from "./auth-api";
import { companyErrorMessage } from "./employee-company";
import { parseApiErrorCode } from "./employee-actions";

export function describeEmployeeError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : "";
  const code = parseApiErrorCode(raw);
  const probe = code ?? raw;
  // 個人出勤設定（2026-10-13）的兩個錯誤碼。
  if (probe === "shift_not_found") return "選的班別不存在（可能剛被刪除），請重新選擇";
  // schema_not_ready：個人班別與在家打卡（0068）或所屬公司（0072）的資料庫更新還沒套。
  if (probe === "schema_not_ready") return "資料庫尚未套用最新更新（員工個人設定或所屬公司），請洽系統維護人員";
  // 可看集團財務（2026-10-26）：只有老闆或平台管理員能改。
  if (probe === "group_financials_grant_forbidden") return "只有平台管理員（老闆）可以設定「可看集團財務」";
  const companyMsg = companyErrorMessage(code);
  if (companyMsg) return companyMsg;
  const translated = accountErrorMessage(new Error(probe), "");
  if (translated && translated !== probe) return translated;
  return raw || fallback;
}
