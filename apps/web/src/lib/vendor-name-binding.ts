/**
 * 廠商挑選（VendorCombo）手改名稱欄時，vendorId 該綁誰（2026-11-16）。
 *
 * 放款單的名稱帶副委託存的 vendor_name、銀行帳號依 vendor_id 從名冊帶；下拉選了甲之後把名稱改成「乙」
 * 若仍保留甲的 id，就會「顯示乙、匯給甲」。後端（POST /projects、副委託整批 PUT）會擋
 * vendor_name_mismatch，前端這裡先把 id 與名稱對齊：
 *
 * - 名稱（trim）仍等於目前已選廠商的名冊名稱（trim）→ 保留目前的 id（使用者明確下拉選的，
 *   即使名冊有同名廠商也不換掉）。
 * - 否則名冊裡剛好**一筆**名稱（trim）相同 → 綁到那一筆。
 * - 沒有相符、空白、或同名多筆（無法判斷是哪一家）→ null（當未建檔／自由輸入）。
 */
export function vendorIdForTypedName(
  vendors: ReadonlyArray<{ id: string; name: string | null }>,
  currentVendorId: string | null | undefined,
  typedName: string,
): string | null {
  const text = typedName.trim();
  if (!text) return null;
  const sameName = (v: { name: string | null }) => (v.name ?? "").trim() === text;
  if (currentVendorId) {
    const current = vendors.find((v) => v.id === currentVendorId);
    if (current && sameName(current)) return current.id;
  }
  const matches = vendors.filter(sameName);
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * 申請單「協力技師」欄手打名稱時的 {vendorId, name}（2026-11-16）。與 vendorIdForTypedName 同一套規則：
 * 對到名冊（原本已綁定且名稱未變 → 保留原 id；否則名冊剛好一筆同名）→ 掛該廠商、名稱用名冊名稱；
 * 同名多筆／沒有相符 → 自由輸入（vendorId null、名稱照打的字，不 trim，打到一半的空白要留著）。
 */
export function engineerForTypedName(
  vendors: ReadonlyArray<{ id: string; name: string | null }>,
  currentVendorId: string | null | undefined,
  typedName: string,
): { vendorId: string | null; name: string | null } {
  const id = vendorIdForTypedName(vendors, currentVendorId, typedName);
  const match = id ? vendors.find((v) => v.id === id) : undefined;
  return match ? { vendorId: match.id, name: match.name } : { vendorId: null, name: typedName };
}

/** API 對「同時改名稱與帳戶且有未付款項」回 409 vendor_identity_change 時顯示的說明（2026-11-16）。 */
export const VENDOR_IDENTITY_CHANGE_TEXT =
  "同時更改廠商名稱與帳戶，且仍有未付款項。若是換成另一家公司，請新增廠商；若確為同一家公司改名換帳戶，請分兩次修改";

/** 廠商儲存失敗的錯誤訊息：認得 vendor_identity_change（含 apiFetch 的 `[409]` 前綴）就換成中文，其餘原樣。 */
export function humanizeVendorIdentityError(message: string): string {
  return message.includes("vendor_identity_change") ? VENDOR_IDENTITY_CHANGE_TEXT : message;
}
