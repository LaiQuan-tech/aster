/**
 * 打卡首頁「這次打卡」的輔助（2026-10-26）——純函式，不碰 React；單元測試在 __tests__/punch-attempt.test.ts。
 *
 * ① 打卡冪等的請求 id（`clientRequestId`）：每次打卡一個，POST /punch 帶上；同員工已有同一個 id 的打卡，API 回原本
 *    那筆（200，不新增；apps/api/src/routes/punch.ts）。送出逾時／斷線（結果不明）後再按同一種卡就沿用同一個 id，
 *    那次其實已寫進去（或還在路上）也只會有一張。只在 ATTEMPT_REUSE_MS 內沿用（跟 API 的去重視窗一致），成功或
 *    確定沒寫（4xx）就清掉——不能拿舊 id 去打隔天的卡（唯一索引會把它當成重送，回舊的那張）。
 * ② 遲到理由按「取消」＝上班卡沒有寫入：記住「今天取消過」，首頁顯示持續橫幅，直到今天有上班卡（或待核准的
 *    上班補卡）、或換日。存 localStorage（per-viewer 便利記憶，PWA 重開也還在），讀寫都包 try/catch。
 */
import type { StorageLike } from "./wfh-punch";

export type AttemptType = "in" | "out";

/** 一次還沒有確定結果的打卡：請求 id、種類、第一次送出的時間（ms）。 */
export interface PunchAttempt {
  id: string;
  type: AttemptType;
  at: number;
}

/** 結果不明的打卡多久內再按同一種卡沿用同一個 id（與 API PUNCH_IDEMPOTENCY_WINDOW_MS 相同）。 */
export const ATTEMPT_REUSE_MS = 10 * 60_000;

/** 送出逾時（結果不明）後鎖鈕多久：讓背景重抓先回來，避免馬上再按。 */
export const UNCERTAIN_LOCK_MS = 5_000;

/** 結果不明、這次又拿不到最新紀錄時的提示（不送出）。 */
export const UNCERTAIN_NOT_VERIFIED_NOTICE = "上次打卡結果不明，正在確認是否已打上，請稍後再按一次";

/** 產生請求 id：有 crypto.randomUUID 就用，否則用時間＋亂數（只要不撞號即可）。 */
export function newClientRequestId(rand: () => number = Math.random): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    /* 退回下面的作法 */
  }
  const r = () => Math.floor(rand() * 0x100000000).toString(16).padStart(8, "0");
  return `p${Date.now().toString(16)}-${r()}${r()}-${r()}`;
}

/**
 * 這次要送的打卡用哪個請求 id：上一次結果不明（`prev` 還在）、同一種卡、ATTEMPT_REUSE_MS 內 → 沿用；
 * 否則產生新的。回傳要記住的那次打卡（呼叫端存起來，成功或確定沒寫入時清掉）。
 */
export function attemptFor(
  prev: PunchAttempt | null,
  type: AttemptType,
  now: number,
  gen: () => string = () => newClientRequestId(),
): PunchAttempt {
  if (prev && prev.type === type && now - prev.at >= 0 && now - prev.at < ATTEMPT_REUSE_MS) return prev;
  return { id: gen(), type, at: now };
}

/**
 * 這個錯誤之後打卡結果是否不明（請求可能已寫進去）：逾時、斷線（TypeError）、5xx → true；
 * 4xx（伺服器明確拒絕、沒寫）→ false。
 */
export function isUncertainPunchError(err: unknown, isTimeout: (e: unknown) => boolean): boolean {
  if (isTimeout(err)) return true;
  if (err instanceof TypeError) return true;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 500;
}

/**
 * 結果不明時按下打卡：拿到最新紀錄才放行（`latest` 非 null）；拿不到 → 不送（呼叫端顯示 UNCERTAIN_NOT_VERIFIED_NOTICE
 * 並重抓）。結果確定時一律放行。
 */
export function uncertainBlocksPunch(uncertain: boolean, latest: unknown): boolean {
  return uncertain && (latest === null || latest === undefined);
}

/* ------------------------------------------------ 遲到理由取消的橫幅 --- */

const LATE_CANCEL_KEY = "ess.lateCancelledIn";

/** 橫幅文案。 */
export const LATE_CANCEL_BANNER = "上班卡尚未打成功（未填遲到原因），請再按一次上班打卡";

/** 記住今天（`day`＝YYYY-MM-DD）取消過遲到理由（上班卡沒寫入）。 */
export function markLateCancelled(storage: StorageLike | null, day: string): void {
  if (!storage) return;
  try {
    storage.setItem(LATE_CANCEL_KEY, day);
  } catch {
    /* 存不了就只在這次畫面有效 */
  }
}

/** 上班卡打成功（或換日）→ 清掉。 */
export function clearLateCancelled(storage: StorageLike | null): void {
  if (!storage) return;
  try {
    storage.removeItem(LATE_CANCEL_KEY);
  } catch {
    /* ignore */
  }
}

/** 讀出記住的日期；沒有或讀不到 → null。 */
export function readLateCancelled(storage: StorageLike | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(LATE_CANCEL_KEY);
  } catch {
    return null;
  }
}

/**
 * 要不要顯示「上班卡尚未打成功」橫幅：記住的日期是今天、而且今天還沒有上班卡（真的或待核准的上班補卡）、
 * 畫面也不是上班中（例如跨日上班中）。`firstInAt` 用 summarizeWithPendingFixPunch 的值（含待核准的補卡）。
 */
export function showLateCancelBanner(
  cancelledDay: string | null,
  today: string,
  summary: { phase: string; firstInAt: string | null },
): boolean {
  return !!cancelledDay && cancelledDay === today && !summary.firstInAt && summary.phase !== "working";
}
