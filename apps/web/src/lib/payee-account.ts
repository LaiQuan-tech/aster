import { formatBankLine } from "./remittance";
import type { Disbursement } from "./disbursements-api";

/**
 * 核准放款畫面的「收款帳戶」摘要（2026-11-17 業主決定＋驗收修正）：帳戶戶名（真正戶名，不是收款名稱）、銀行名稱／代碼、
 * 帳號只露末 4 碼、帳戶來源（照名冊／手動輸入），名冊帳戶 30 天內變更或確認過 → 黃色警示；帳戶未確認／待覆核 → 黃色警示；
 * 收款名稱與戶名不同 → 提醒核對。純函式，有單元測試。
 * 帳號一律優先用後端遮好的 payeeAccountMasked；舊 API 沒帶時才從手上有的完整帳號自己遮（財務頁面）。
 */
export type PayeeAccountFields = Pick<Disbursement, "payeeName" | "payeeBankName" | "payeeBankCode" | "payeeBankAccount" | "payeeKind" | "vendorId"> &
  Partial<Pick<Disbursement, "payeeAccountMasked" | "payeeAccountSource" | "payeeBankChangedAt" | "vendorBankChangePending" | "payeeAccountHolder" | "vendorBankVerified">>;

export interface PayeeAccountSummary {
  /** 帳戶戶名（後端 payeeAccountHolder；沒有才退回收款名稱）。 */
  holder: string;
  /** 收款名稱與帳戶戶名不同 → 提醒文字。 */
  holderMismatchText: string | null;
  bankLine: string;
  masked: string | null;
  sourceLabel: string;
  /** 照名冊（roster）＝灰；手動輸入＝橘。 */
  manual: boolean;
  /** 「此廠商收款帳戶於 YYYY/MM/DD 變更或確認過」或 null。 */
  changedText: string | null;
  /** 待覆核或未確認的警示，或 null。 */
  pendingText: string | null;
}

/** 快照「帳號 戶名」的帳號段：知道戶名且以「 戶名」結尾就去掉戶名，否則取第一個空白前那一段（戶名開頭數字不算進帳號）。 */
export function accountSegment(account: string | null | undefined, holder?: string | null): string {
  const raw = (account ?? "").trim();
  if (!raw) return "";
  const h = (holder ?? "").trim();
  if (h && raw.length > h.length && raw.endsWith(h) && /\s/.test(raw.charAt(raw.length - h.length - 1))) {
    return raw.slice(0, raw.length - h.length).trim();
  }
  return raw.split(/\s+/)[0] ?? "";
}

export function maskAccountTail(account: string | null | undefined, holder?: string | null): string | null {
  const seg = accountSegment(account, holder);
  if (!seg) return null;
  return `****${seg.replace(/\D/g, "").slice(-4)}`;
}

/** ISO 時間 → 台北日期 YYYY/MM/DD。 */
export function taipeiDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10).replace(/-/g, "/");
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "/");
}

const normName = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export function payeeAccountSummary(d: PayeeAccountFields): PayeeAccountSummary {
  const manual = (d.payeeAccountSource ?? (d.payeeKind === "vendor" && d.vendorId ? "roster" : "manual")) === "manual";
  const holder = (d.payeeAccountHolder ?? "").trim() || d.payeeName;
  const mismatch = !!d.payeeAccountHolder?.trim() && normName(d.payeeAccountHolder) !== normName(d.payeeName ?? "");
  return {
    holder,
    holderMismatchText: mismatch ? `收款名稱「${d.payeeName}」與帳戶戶名「${holder}」不同，請核對` : null,
    bankLine: formatBankLine(d.payeeBankName, d.payeeBankCode),
    masked: d.payeeAccountMasked !== undefined ? d.payeeAccountMasked : maskAccountTail(d.payeeBankAccount, d.payeeAccountHolder),
    sourceLabel: manual ? "手動輸入（非登錄廠商）" : "照名冊",
    manual,
    changedText: d.payeeBankChangedAt ? `此廠商收款帳戶於 ${taipeiDate(d.payeeBankChangedAt)} 變更或確認過` : null,
    pendingText: d.vendorBankChangePending
      ? "此廠商收款帳戶變更待覆核中，覆核完成前不能核准或付款"
      : d.vendorBankVerified === false
        ? "此廠商收款帳戶尚未經老闆／HR 確認，確認前不能核准或付款"
        : null,
  };
}
