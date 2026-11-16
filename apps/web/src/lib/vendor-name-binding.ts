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
