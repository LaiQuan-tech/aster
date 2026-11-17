/**
 * 匯款資訊複製（M15：廠商頁／放款列表／放款單明細共用）。
 *
 *   buildRemittanceText  純函式：戶名／銀行（代號）／帳號／金額，一行一項，貼進網銀 APP
 *                        轉帳頁面剛好對應四個欄位。原本在 lib/disbursements-api.ts，2026-09-23
 *                        抽到這裡讓廠商頁（lib/company-api 的 Vendor）也能用；放款單明細頁
 *                        （admin/disbursements/[id]/page.tsx）與放款列表改 import 這裡。
 *   copyText             剪貼簿三段式（從放款單明細頁的 handleCopyRemittance 抽出）：
 *                        Clipboard API（https）→ document.execCommand('copy') → 都失敗就
 *                        window.prompt 讓使用者手動選取；回傳是否已自動複製成功。
 */

/** 銀行顯示字串：後端 vendor 快照慣例會把代碼內嵌進 bankName（如「國泰世華（013）」，
 * 見 services/disbursements.ts vendorBankName）；已內嵌就照原樣顯示，否則把
 * bankCode 用括號補在後面，避免「國泰世華（013）（013）」重複。純函式。 */
export function formatBankLine(bankName: string | null | undefined, bankCode: string | null | undefined): string {
  const name = (bankName ?? "").trim();
  const code = (bankCode ?? "").trim();
  if (!code) return name;
  if (name.includes(code)) return name;
  return name ? `${name}（${code}）` : code;
}

export interface RemittanceInfo {
  /** 戶名（廠商頁用 accountHolder ?? name）。 */
  payeeName: string;
  payeeBankName: string | null | undefined;
  payeeBankCode: string | null | undefined;
  payeeBankAccount: string | null | undefined;
  /** 0106 分欄（放款單有就優先）：帳號只含數字、真正的帳戶戶名。 */
  payeeBankAccountNumber?: string | null;
  payeeAccountHolder?: string | null;
  /** 金額；廠商頁沒有金額時省略，該行不輸出。 */
  amount?: number | null;
}

/** 驗收第四輪 H1：輸出前去掉控制字元／格式字元／換行，避免戶名或帳號被注入多一行（後端也已拒收）。 */
export function sanitizeRemittanceField(v: string | null | undefined): string {
  return String(v ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
}

/** 「複製匯款資訊」的文字組裝（純函式，不碰 DOM／clipboard，方便單元測試）。 */
export function buildRemittanceText(d: RemittanceInfo): string {
  const holder = sanitizeRemittanceField(d.payeeAccountHolder) || sanitizeRemittanceField(d.payeeName);
  const account = sanitizeRemittanceField(d.payeeBankAccountNumber) || sanitizeRemittanceField(d.payeeBankAccount);
  const lines = [
    `戶名：${holder || "—"}`,
    `銀行：${sanitizeRemittanceField(formatBankLine(d.payeeBankName, d.payeeBankCode)) || "—"}`,
    `帳號：${account || "—"}`,
  ];
  if (d.amount !== undefined && d.amount !== null) lines.push(`金額：${d.amount.toLocaleString()}`);
  return lines.join("\n");
}

/**
 * 把文字放進剪貼簿。回 true＝已自動複製；false＝退到 window.prompt 讓使用者手動複製
 * （非 https／舊瀏覽器／被瀏覽器擋）。只在瀏覽器呼叫。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (!ok) throw new Error("execCommand copy failed");
    return true;
  } catch {
    window.prompt("無法自動複製，請手動選取以下文字複製：", text);
    return false;
  }
}
