/**
 * 客戶／廠商名冊的「關係企業（集團內姊妹公司）」標記（clients.is_affiliate／vendors.is_affiliate，packages/db 0062）的
 * 表單小工具：純函式、無 React，有 vitest（lib/__tests__/affiliate.test.ts）。
 *
 * 集團總覽的集團合計會剔除關係企業往來，所以這個標記會改變老闆看的集團數字：API 只准 hr_admin／platform_admin
 * 設定或變更（其他角色帶了與現值不同的值回 403 affiliate_hr_only，見 apps/api routes/clients.ts、vendors.ts）。
 */

/** API 對非 HR 變更關係企業旗標回 403 affiliate_hr_only 時顯示的說明。 */
export const AFFILIATE_HR_ONLY_TEXT = "只有 HR 管理員可以設定「關係企業」標記。";

/**
 * 客戶／廠商表單送出的關係企業欄位：只在旗標有變動時才送（新增＝勾了才送）。
 * 會計改別的欄位時不順帶送一個沒變的值——API 對沒變動的值雖然放行，不送最單純，也不會把舊值寫回去。
 */
export function affiliateInputField(next: boolean, original: { isAffiliate?: boolean } | null): { isAffiliate?: boolean } {
  return next !== (original?.isAffiliate === true) ? { isAffiliate: next } : {};
}

/** 儲存失敗的錯誤訊息：認得 affiliate_hr_only（含 apiFetch 的 `[403]` 前綴）就換成中文，其餘原樣。 */
export function humanizeAffiliateError(message: string): string {
  return message.includes("affiliate_hr_only") ? AFFILIATE_HR_ONLY_TEXT : message;
}
