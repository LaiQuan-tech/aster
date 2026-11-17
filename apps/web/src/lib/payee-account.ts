import { formatBankLine } from "./remittance";
import type { Disbursement } from "./disbursements-api";

/**
 * 核准放款畫面的「收款帳戶」摘要（2026-11-17 業主決定）：戶名、銀行名稱／代碼、帳號只露末 4 碼、
 * 帳戶來源（照名冊／手動輸入），名冊帳戶 30 天內變更過 → 黃色警示文字。純函式，有單元測試。
 * 帳號一律用後端遮好的 payeeAccountMasked；舊 API 沒帶時才從手上有的完整帳號自己遮（財務頁面）。
 */
export type PayeeAccountFields = Pick<Disbursement, "payeeName" | "payeeBankName" | "payeeBankCode" | "payeeBankAccount" | "payeeKind" | "vendorId"> &
  Partial<Pick<Disbursement, "payeeAccountMasked" | "payeeAccountSource" | "payeeBankChangedAt" | "vendorBankChangePending">>;

export interface PayeeAccountSummary {
  holder: string;
  bankLine: string;
  masked: string | null;
  sourceLabel: string;
  /** 照名冊（roster）＝灰；手動輸入＝橘。 */
  manual: boolean;
  /** 「此廠商收款帳戶於 YYYY/MM/DD 變更過」或 null。 */
  changedText: string | null;
  /** 「此廠商收款帳戶變更待覆核…」或 null。 */
  pendingText: string | null;
}

export function maskAccountTail(account: string | null | undefined): string | null {
  const raw = (account ?? "").trim();
  if (!raw) return null;
  const lead = (raw.match(/^[\d\s\-－‐–—]+/)?.[0] ?? "").replace(/\D/g, "");
  const digits = lead || raw.replace(/\D/g, "");
  return `****${digits.slice(-4)}`;
}

/** ISO 時間 → 台北日期 YYYY/MM/DD。 */
export function taipeiDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10).replace(/-/g, "/");
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "/");
}

export function payeeAccountSummary(d: PayeeAccountFields): PayeeAccountSummary {
  const manual = (d.payeeAccountSource ?? (d.payeeKind === "vendor" && d.vendorId ? "roster" : "manual")) === "manual";
  return {
    holder: d.payeeName,
    bankLine: formatBankLine(d.payeeBankName, d.payeeBankCode),
    masked: d.payeeAccountMasked !== undefined ? d.payeeAccountMasked : maskAccountTail(d.payeeBankAccount),
    sourceLabel: manual ? "手動輸入（非登錄廠商）" : "照名冊",
    manual,
    changedText: d.payeeBankChangedAt ? `此廠商收款帳戶於 ${taipeiDate(d.payeeBankChangedAt)} 變更過` : null,
    pendingText: d.vendorBankChangePending ? "此廠商收款帳戶變更待覆核中，覆核完成前不能核准或付款" : null,
  };
}
