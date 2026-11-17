import { formatBankLine } from "./remittance";
import type { Disbursement } from "./disbursements-api";

/**
 * 核准放款畫面的「收款帳戶」摘要（2026-11-17 業主決定＋驗收修正）：帳戶戶名（真正戶名，不是收款名稱）、銀行名稱／代碼、
 * 帳號只露末 4 碼、帳戶來源（照名冊／手動輸入），名冊帳戶 30 天內變更或確認過 → 黃色警示；帳戶未確認／待覆核 → 黃色警示；
 * 收款名稱與戶名不同 → 提醒核對。純函式，有單元測試。
 * 帳號一律優先用後端遮好的 payeeAccountMasked；舊 API 沒帶時才從手上有的完整帳號自己遮（財務頁面）。
 */
export type PayeeAccountFields = Pick<Disbursement, "payeeName" | "payeeBankName" | "payeeBankCode" | "payeeBankAccount" | "payeeKind" | "vendorId"> &
  Partial<Pick<Disbursement, "payeeAccountMasked" | "payeeAccountSource" | "payeeBankChangedAt" | "vendorBankChangePending" | "payeeAccountHolder" | "vendorBankVerified" | "payeeRebindWarning" | "method">>;

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
  /** 驗收 S2：手動收款分攤到曾解除／改綁名冊廠商的副委託 → 紅框文字，或 null。 */
  rebindText: string | null;
}

const ACCOUNT_TOKEN = /^[\d\-－‐–—]+$/;

/**
 * 快照「帳號 戶名」拆成帳號段與戶名段（與 API services/vendor-bank-change.ts splitAccountSnapshot 同一套，驗收 A／F2）：
 * 知道戶名且以「空白＋戶名」結尾 → 精確去掉戶名；否則帳號段＝開頭連續的「純數字／連字號」token（帳號可含空白，
 * 最後一段純數字不當戶名），第一個含其他字元的 token 起是戶名（「0001234567890 104人力銀行」的 104 不算帳號）。
 */
export function splitAccountSnapshot(account: string | null | undefined, holder?: string | null): { account: string; holder: string | null } {
  const raw = (account ?? "").trim();
  if (!raw) return { account: "", holder: null };
  const h = (holder ?? "").trim();
  if (h && raw.length > h.length && raw.endsWith(h) && /\s/.test(raw.charAt(raw.length - h.length - 1))) {
    return { account: raw.slice(0, raw.length - h.length).trim(), holder: h };
  }
  const tokens = raw.split(/\s+/);
  let n = 0;
  while (n < tokens.length && ACCOUNT_TOKEN.test(tokens[n]!)) n++;
  if (n === 0) n = 1;
  const rest = tokens.slice(n).join(" ");
  return { account: tokens.slice(0, n).join(" "), holder: rest || null };
}

export function accountSegment(account: string | null | undefined, holder?: string | null): string {
  return splitAccountSnapshot(account, holder).account;
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
      : d.vendorBankVerified === false && !(d.method && d.method !== "transfer" && !d.payeeBankAccount && !d.payeeAccountMasked)
        ? "此廠商收款帳戶尚未經老闆／平台管理員確認，確認前不能核准或付款"
        : null,
    rebindText: d.payeeRebindWarning?.message ?? null,
  };
}

/**
 * 名冊列表／內頁的收款帳戶狀態（F7）：變更覆核中＞已確認＞待確認（有帳號或有申請但未核准）；沒查到狀態或沒帳號回 null。
 */
export function vendorBankStatus(v: { bankVerified?: boolean; bankChangePending?: boolean; bankAccount?: string | null }): { label: string; tone: "amber" | "green" | "gray" } | null {
  if (v.bankChangePending) return { label: "帳戶變更覆核中", tone: "amber" };
  if (v.bankVerified === true) return { label: "帳戶已確認", tone: "green" };
  if (v.bankVerified === false && (v.bankAccount ?? "").trim()) return { label: "帳戶待確認", tone: "amber" };
  return null;
}
