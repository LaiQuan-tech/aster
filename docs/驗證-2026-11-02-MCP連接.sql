set transaction read only;
-- =====================================================================
-- MCP 連接（docs/套用-2026-11-02-MCP連接.sql ＝ migration 0082 ＝ sql/0072）。
-- 全部唯讀。套用後跑。
-- （在 SQL editor 裡若 `set transaction read only` 需要交易，整份包 begin; … rollback; 執行。）
-- =====================================================================

-- ── 1. 5 張表都在（預期 5 rows）────────────────────────────────────
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('mcp_oauth_clients', 'mcp_grants', 'mcp_tokens', 'mcp_oauth_codes', 'mcp_confirmations')
order by table_name;

-- ── 2. RLS 已開、沒有 policy（預期 5 rows，relrowsecurity 全 true、policies 全 0）─
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('mcp_oauth_clients', 'mcp_grants', 'mcp_tokens', 'mcp_oauth_codes', 'mcp_confirmations')
order by c.relname;

-- ── 3. anon／authenticated 沒有任何表權限（預期 0 rows）──────────────
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('mcp_oauth_clients', 'mcp_grants', 'mcp_tokens', 'mcp_oauth_codes', 'mcp_confirmations');

-- ── 4. 檢查約束（預期 3 rows：auth_method_chk、kind_chk ×2）────────────
select conrelid::regclass as tbl, conname
from pg_constraint
where contype = 'c'
  and conrelid in ('public.mcp_oauth_clients'::regclass, 'public.mcp_grants'::regclass, 'public.mcp_tokens'::regclass)
order by conname;

-- ── 5. 欄位數（預期 mcp_oauth_clients 9、mcp_grants 14、mcp_tokens 7、mcp_oauth_codes 13、mcp_confirmations 9）─
select table_name, count(*) as columns
from information_schema.columns
where table_schema = 'public'
  and table_name in ('mcp_oauth_clients', 'mcp_grants', 'mcp_tokens', 'mcp_oauth_codes', 'mcp_confirmations')
group by table_name
order by table_name;

-- ── 6. 目前有效授權概況（套用後有人連接才有資料；只看筆數，不看內容）──
select kind, count(*) filter (where revoked_at is null) as active, count(*) as total
from public.mcp_grants
group by kind;
