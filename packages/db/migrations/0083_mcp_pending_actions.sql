-- 2026-11-02 MCP 連接・最高風險操作的「待使用者確認」（資安驗收 M4）。
-- AI 對薪資計算／定案／寄送、期間鎖定重開、放款／作廢、獎金核准／發放／沖回、角色權限帳號、規則與簽核流程、
-- 新增租戶、所有刪除這類操作，第一次呼叫只建立一筆待確認操作；使用者本人在後台 /mcp/confirm/<id> 登入確認後，
-- 由 API 以他的身分（重新檢查權限）執行並把結果存在這裡。10 分鐘到期、只能決定一次。
-- 前提：已套到 0082（sql/0072）。可重跑。只由 API（service role）存取：RLS 開、無 policy、REVOKE anon／authenticated。
CREATE TABLE IF NOT EXISTS public.mcp_pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid NOT NULL,
  employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  grant_id uuid REFERENCES public.mcp_grants(id) ON DELETE SET NULL,
  client_name text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  query jsonb,
  body jsonb,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result_status integer,
  result text,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.mcp_pending_actions ADD CONSTRAINT mcp_pending_actions_status_chk
    CHECK (status IN ('pending', 'executing', 'done', 'failed', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS mcp_pending_actions_tenant_user_idx ON public.mcp_pending_actions (tenant_id, user_id, created_at DESC);

ALTER TABLE public.mcp_pending_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_pending_actions FROM anon, authenticated;
