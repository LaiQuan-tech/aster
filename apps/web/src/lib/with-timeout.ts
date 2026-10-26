/**
 * 等一個 Promise 最多 `ms` 毫秒（2026-10-26，打卡首頁）：逾時就 reject `PromiseTimeoutError`，原本的 Promise
 * 照跑（結果丟掉）。
 *
 * 為什麼需要：`apiFetch` 沒有逾時，而且先等 Supabase 的 `getSession()`（可能卡在換 token）。手機 PWA 送出請求後
 * 立刻鎖螢幕／切到背景，請求可能永遠不結束——首頁的「載入中…」「打卡中…」就一直停著、按鈕 disabled，回到前景
 * 的對齊又因為「載入中／送出中」而跳過，只能把 App 整個關掉重開。包一層逾時，按鈕一定會回來。
 */
export class PromiseTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(ms: number, label?: string) {
    super(`${label ?? "request"} timed out after ${ms}ms`);
    this.name = "PromiseTimeoutError";
    this.timeoutMs = ms;
  }
}

export function isPromiseTimeout(err: unknown): err is PromiseTimeoutError {
  return err instanceof PromiseTimeoutError;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PromiseTimeoutError(ms, label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
