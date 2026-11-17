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

/** API 對「同時改名稱與帳戶且有未付款項」回 409 vendor_identity_change 時顯示的說明（2026-11-16，第四輪不再教分兩次改）。 */
export const VENDOR_IDENTITY_CHANGE_TEXT = "同時更改廠商名稱與帳戶，且仍有未付款項。若是換成另一家公司，請新增廠商";
/** 有未匯款放款單時改收款帳戶 → 409 vendor_has_open_disbursements（2026-11-16 R2）。 */
export const VENDOR_HAS_OPEN_DISBURSEMENTS_TEXT = "此廠商仍有未匯款的放款單，請先作廢或匯款後再更改收款帳戶";
/** 只有未付期款時改收款帳戶要填原因 → 400 change_reason_required。 */
export const VENDOR_CHANGE_REASON_REQUIRED_TEXT = "此廠商仍有未付期款，更改收款帳戶請填寫變更原因";

/** 名稱／簡稱／帳戶戶名含不可見字元或西里爾／希臘字母（第七輪起只要出現就擋）→ 400 invalid_vendor_name（2026-11-17）。 */
export const INVALID_VENDOR_NAME_TEXT = "名稱含有不可見字元或西里爾／希臘字母，請重新輸入";
/** 新名稱與名冊另一家廠商視為同名 → 409 vendor_name_duplicate（第六輪；後端訊息帶那一家的名稱，優先顯示）。 */
export const VENDOR_NAME_DUPLICATE_TEXT = "名冊已有同名廠商";
/** 刪除仍有未付期款或未匯款放款單的廠商 → 409 vendor_in_use（2026-11-17）。 */
export const VENDOR_IN_USE_TEXT = "此廠商仍有未付期款或未匯款的放款單，不能刪除";

/** 廠商刪除失敗的錯誤訊息（含 apiFetch 的 `[409]` 前綴）→ 中文，其餘原樣。 */
export function humanizeVendorDeleteError(message: string): string {
  if (message.includes("vendor_in_use")) return VENDOR_IN_USE_TEXT;
  return message;
}

/** 廠商儲存失敗的錯誤訊息：認得名冊身分／帳戶變更的錯誤碼（含 apiFetch 的 `[409]` 前綴）就換成中文，其餘原樣。 */
export function humanizeVendorIdentityError(message: string, serverMessage?: string): string {
  const server = serverMessage?.trim();
  if (message.includes("vendor_name_duplicate")) return server || VENDOR_NAME_DUPLICATE_TEXT;
  if (message.includes("vendor_name_similar")) return `${server || "名冊已有名稱相近的廠商"}（未填說明，沒有儲存）`;
  if (message.includes("invalid_vendor_name") && server) return server;
  if (message.includes("vendor_identity_change")) return VENDOR_IDENTITY_CHANGE_TEXT;
  if (message.includes("vendor_has_open_disbursements")) return VENDOR_HAS_OPEN_DISBURSEMENTS_TEXT;
  if (message.includes("change_reason_required")) return VENDOR_CHANGE_REASON_REQUIRED_TEXT;
  // 2026-11-17 雙人覆核：同廠商已有一筆帳戶變更待覆核。
  if (message.includes("vendor_bank_change_pending")) return server || "此廠商已有一筆收款帳戶變更待覆核，請等覆核完成或取消後再改";
  if (message.includes("no_bank_change_reviewer")) return server || "目前沒有可核准的老闆或平台管理員（申請人以外），收款帳戶無法送出覆核";
  if (message.includes("invalid_vendor_name")) return INVALID_VENDOR_NAME_TEXT;
  return message;
}

/** 這個錯誤是「改帳戶要填原因」：前端據此請使用者輸入原因後帶 changeReason 重送。 */
export function isChangeReasonRequired(message: string): boolean {
  return message.includes("change_reason_required");
}

/**
 * 第八輪（2026-11-17）：名稱與名冊廠商「相近」但不是完全相同 → 後端 409 vendor_name_similar（名冊、副委託、建案）
 * 或 payee_name_similar（放款「其他」收款）。不硬擋：同一家請改選名冊廠商；確為不同公司就填說明、帶 confirmDistinctReason 重送
 * （後端寫嚴格稽核，核准頁醒目標示）。完全相同（must_bind_vendor／vendor_name_duplicate／payee_is_registered_vendor）仍是硬擋，不走這裡。
 */
export type SimilarNameConflict = {
  code: "vendor_name_similar" | "payee_name_similar";
  /** 撞到的名冊廠商名稱。 */
  matchedVendorName: string;
  /** 副委託列在 payload 的位置（副委託整批 PUT／建案 initialSubcontracts）；其他端點沒有。 */
  index: number | null;
  message: string;
};

export function similarNameConflict(err: unknown): SimilarNameConflict | null {
  const body = (err as { body?: { error?: unknown; matchedVendorName?: unknown; index?: unknown; message?: unknown } } | null)?.body;
  if (body?.error !== "vendor_name_similar" && body?.error !== "payee_name_similar") return null;
  const matchedVendorName = typeof body.matchedVendorName === "string" ? body.matchedVendorName : "";
  const message =
    typeof body.message === "string" && body.message.trim() ? body.message : `名稱與名冊廠商「${matchedVendorName}」相近`;
  return { code: body.error, matchedVendorName, index: typeof body.index === "number" ? body.index : null, message };
}

/** 問使用者「確為不同公司」說明時的提示文字。 */
export function similarNamePrompt(conflict: SimilarNameConflict): string {
  return `${conflict.message}\n\n若確為不同公司，請說明（例如統編、地址不同；會留存稽核紀錄並在核准頁顯示）。\n若是同一家，請按取消，改在下拉選擇名冊廠商「${conflict.matchedVendorName}」。`;
}

/**
 * 送出 → 遇到相近名稱就用 ask 問說明，帶 confirmDistinctReason 重送（最多 3 次，每次可能是不同列）。
 * 使用者取消或空白 → 把原錯誤丟出去（呼叫端照常顯示錯誤）。
 * `send(conflict, reason)`：第一次呼叫 conflict／reason 都是 null；之後帶這次撞到的資訊與說明。
 */
export async function withSimilarNameConfirm<T>(
  send: (conflict: SimilarNameConflict | null, reason: string | null) => Promise<T>,
  ask: (message: string) => string | null,
): Promise<T> {
  let conflict: SimilarNameConflict | null = null;
  let reason: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send(conflict, reason);
    } catch (err) {
      const next = similarNameConflict(err);
      if (!next) throw err;
      const answer = ask(similarNamePrompt(next))?.trim();
      if (!answer) throw err;
      conflict = next;
      reason = answer;
    }
  }
  return send(conflict, reason);
}

/** 相近名稱錯誤的顯示文字（使用者取消說明時）：後端訊息帶撞到的名冊名稱。 */
export function similarNameErrorText(err: unknown): string | null {
  const c = similarNameConflict(err);
  return c ? `${c.message}（未填說明，沒有儲存）` : null;
}
