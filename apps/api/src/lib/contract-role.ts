/**
 * `contracts.our_role` 有三個值：contractor（我方承攬）／client（我方定作，
 * 對方才是承攬人）／both（印花稅各自貼——雙方各貼自己那份，但**我方仍是
 * 承攬方**）。
 *
 * 「這張合約／報價單算不算我方的」只有一個排除條件：our_role === "client"
 * （我方是定作人，那份金額是應付給下包，不是我方應收的營收）。
 * contractor／both 一律算我方的——營收合計、分期分母、示警分母、前台訂單
 * 類型判斷都要共用這條規則，不要各自寫死 `=== "contractor"`：B1 加 both
 * 這個值時就是因為有地方漏改，把標成 both 的正式合約當成下包合約排除在
 * 營收之外（详见 commit 2f6ad95 之後的修補）。哪天再加第四種角色值，
 * 也只要改這一個函式。
 */
export function isOurContract(ourRole: string): boolean {
  return ourRole !== "client"
}

/**
 * 上面判斷式的 DB 查詢版本——Supabase `.in()` 篩選用（query builder 沒辦法
 * 直接塞一個 JS 函式進去，只能給值列表）。兩邊各自維護的話遲早會漏改其中一邊，
 * 所以從 `isOurContract` 的排除條件反推，維持同一個真相來源。
 */
export const OUR_CONTRACT_ROLES = ["contractor", "both"] as const
