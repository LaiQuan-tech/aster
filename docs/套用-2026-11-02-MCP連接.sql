-- =====================================================================
-- 2026-11-02 MCP 連接（migration 0082 ＝ sql/0072）
--
-- 內容：5 張新表 public.mcp_oauth_clients、mcp_grants、mcp_tokens、mcp_oauth_codes、mcp_confirmations。
-- 目的：讓管理員在 claude.ai／Claude 桌面版／ChatGPT／Claude Code 以「自己的身分」用 AI 操作系統
--       （OAuth 2.1＋PKCE、動態用戶端註冊、個人存取金鑰、危險操作二段確認）。
--
-- 前提：已套到 0081（sql/0071）。整份可重跑（冪等），包在 BEGIN／COMMIT 交易裡（一錯全回滾）。
-- 只新增表、不動既有資料；只由 API（service role）存取：RLS 開啟不給 policy，並 REVOKE anon／authenticated。
-- 順序：先套本檔再部署 API（API 未設 MCP_TOKEN_SECRET 時 MCP 端點一律 503，不影響既有功能）。
-- 套用後跑 docs/驗證-2026-11-02-MCP連接.sql。
-- =====================================================================
BEGIN;

-- 2026-11-02 MCP 連接（AI 以使用者本人身分操作系統）：OAuth 2.1 用戶端／授權碼／授權／token、危險操作確認碼。
-- 所有 token、授權碼、金鑰、確認碼只存 HMAC-SHA256 雜湊（金鑰＝API 環境變數 MCP_TOKEN_SECRET），明文不落 DB。
-- 前提：已套到 0081（sql/0071）。可重跑（IF NOT EXISTS／duplicate_object）。
-- 只由 API（service role）存取：RLS 開啟、不給 policy，並撤銷 anon／authenticated 的所有權限。
-- 不掛 audit_all trigger（token 表高頻寫入、且不該把雜湊寫進稽核）；授權／金鑰的產生與撤銷由 API 寫應用層稽核。

-- 1. OAuth 用戶端（RFC 7591 動態註冊；claude.ai、ChatGPT、Claude Code…）
CREATE TABLE IF NOT EXISTS public.mcp_oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  client_secret_hash text,
  client_name text NOT NULL,
  redirect_uris text[] NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
DO $$ BEGIN
  ALTER TABLE public.mcp_oauth_clients ADD CONSTRAINT mcp_oauth_clients_auth_method_chk
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. 授權（一次 OAuth 同意＝一列；一把個人金鑰＝一列）。撤銷＝revoked_at，底下 token 全部失效。
CREATE TABLE IF NOT EXISTS public.mcp_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid NOT NULL,
  employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  kind text NOT NULL,
  client_id text,
  client_name text NOT NULL,
  scope text,
  resource text,
  token_prefix text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
DO $$ BEGIN
  ALTER TABLE public.mcp_grants ADD CONSTRAINT mcp_grants_kind_chk CHECK (kind IN ('oauth', 'pat'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS mcp_grants_tenant_user_idx ON public.mcp_grants (tenant_id, user_id, kind, created_at DESC);

-- 3. token（access 1 小時、refresh 30 天輪替、pat 個人金鑰）
CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES public.mcp_grants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  expires_at timestamptz,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.mcp_tokens ADD CONSTRAINT mcp_tokens_kind_chk CHECK (kind IN ('access', 'refresh', 'pat'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS mcp_tokens_grant_idx ON public.mcp_tokens (grant_id);

-- 4. 授權碼（5 分鐘、一次性、綁 PKCE challenge 與 redirect_uri）
CREATE TABLE IF NOT EXISTS public.mcp_oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid NOT NULL,
  employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scope text,
  resource text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  grant_id uuid REFERENCES public.mcp_grants(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 5. 危險操作確認碼（5 分鐘、一次性、綁 user＋grant＋參數雜湊）
CREATE TABLE IF NOT EXISTS public.mcp_confirmations (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES public.mcp_grants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  args_hash text NOT NULL,
  summary text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_confirmations_expires_idx ON public.mcp_confirmations (expires_at);

-- RLS 開啟、不給 policy；撤銷前端角色的所有權限（只由 service role 存取）。
ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_oauth_clients, public.mcp_grants, public.mcp_tokens, public.mcp_oauth_codes, public.mcp_confirmations FROM anon, authenticated;

COMMIT;
