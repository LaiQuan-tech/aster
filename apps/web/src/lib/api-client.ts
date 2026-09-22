/**
 * Thin fetch wrapper for talking to the @hr/api service.
 *
 * Base URL comes from NEXT_PUBLIC_API_URL (defaults to local dev API).
 * Automatically attaches `Authorization: Bearer <token>` using the current
 * Supabase browser session, so callers don't have to thread the token through.
 */
import { getSupabaseBrowser } from "./supabase-browser";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * apiFetch 丟出的錯誤：message 是 `[status] code`，code／detail 是 API 回的 { error, message }。
 * `body` 是整包回應 JSON（解析失敗時是 `{ message: statusText }`），給需要額外欄位的呼叫端用——
 * 例如放款的 409 `acceptance_required` 會附 `installmentNo`，錯誤訊息才寫得出是哪一期沒驗收。
 */
export type ApiError = Error & { status?: number; code?: string; detail?: string; body?: unknown };

/**
 * Resolve the auth token from the live Supabase session (browser only).
 * Returns null when there is no session (caller goes out unauthenticated and
 * the API answers 401, which the UI turns into a redirect to /login).
 */
async function getAuthToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const supabase = getSupabaseBrowser();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Core fetcher: prepends the API base URL, attaches the bearer token, sets a
 * JSON content-type and throws on any non-2xx response (message taken from the
 * API's { error } / { message } body when present).
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...fetchOptions } = options;
  const authToken = token ?? (await getAuthToken());

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...((fetchOptions.headers as Record<string, string>) ?? {}),
  };

  const res = await fetch(`${API_URL}${path}`, { ...fetchOptions, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    const message = body.error ?? body.message ?? res.statusText;
    const err = new Error(`[${res.status}] ${message}`) as ApiError;
    err.status = res.status;
    // 訊息維持 `[status] code` 不變（既有呼叫端靠這個字串判斷）；另外把錯誤碼與 API 的
    // 補充說明（例如 invalid_header 缺哪個欄）掛在物件上，讓需要細節的呼叫端拿得到。
    if (typeof body.error === "string") err.code = body.error;
    if (typeof body.message === "string" && body.message !== message) err.detail = body.message;
    err.body = body;
    throw err;
  }

  // 204 / empty bodies → undefined.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// Back-compat alias for existing callers.
export const apiClient = apiFetch;

/**
 * Download an authenticated file (e.g. CSV export): fetches with the bearer
 * token and triggers a browser download. Throws on non-2xx.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const token = await (async () => {
    const supabase = getSupabaseBrowser();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  })();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`下載失敗 (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
