/**
 * AI 連接（MCP，2026-11-02）的前端 API：OAuth 同意頁＋「設定 → AI 連接」的個人金鑰／已授權應用。
 * 對應 apps/api routes/mcp-oauth.ts（/oauth/authorize/describe|decision）與 routes/mcp-keys.ts（/me/mcp/*）。
 */
import { apiFetch } from "./api-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** MCP 端點網址（給使用者貼到 claude.ai／ChatGPT／Claude Code）。 */
export function mcpServerUrl(): string {
  return `${API_URL.replace(/\/+$/, "")}/mcp`;
}

export interface ConsentInfo {
  clientName: string;
  redirectHost: string;
  scope: string;
  expiresAt: string;
}

export function describeConsent(req: string): Promise<ConsentInfo> {
  return apiFetch<ConsentInfo>(`/oauth/authorize/describe?req=${encodeURIComponent(req)}`);
}

export function decideConsent(req: string, approve: boolean): Promise<{ redirect_to: string }> {
  return apiFetch<{ redirect_to: string }>("/oauth/authorize/decision", {
    method: "POST",
    body: JSON.stringify({ req, approve }),
  });
}

export interface PersonalKey {
  id: string;
  name: string;
  prefix: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface AuthorizedApp {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPersonalKeys(): Promise<PersonalKey[]> {
  return (await apiFetch<{ keys: PersonalKey[] }>("/me/mcp/keys")).keys;
}

export function createPersonalKey(name: string, expiresInDays: number): Promise<PersonalKey & { token: string }> {
  return apiFetch<PersonalKey & { token: string }>("/me/mcp/keys", {
    method: "POST",
    body: JSON.stringify({ name, expiresInDays }),
  });
}

export function revokePersonalKey(id: string): Promise<unknown> {
  return apiFetch(`/me/mcp/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listAuthorizedApps(): Promise<AuthorizedApp[]> {
  return (await apiFetch<{ grants: AuthorizedApp[] }>("/me/mcp/grants")).grants;
}

export function revokeAuthorizedApp(id: string): Promise<unknown> {
  return apiFetch(`/me/mcp/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 登入後要回到的站內路徑：只接受 `/` 開頭、不是 `//`（避免開放轉址）。 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return null;
  return next;
}
