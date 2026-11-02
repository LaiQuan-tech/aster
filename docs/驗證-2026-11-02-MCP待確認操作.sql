set transaction read only;
-- MCP 待確認操作（docs/套用-2026-11-02-MCP待確認操作.sql ＝ migration 0083 ＝ sql/0073）。全部唯讀。
-- 預期 1 row：relrowsecurity = true、policies = 0、anon_auth_grants = 0、columns = 17、status_chk = 1
select c.relrowsecurity,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'mcp_pending_actions') as policies,
       (select count(*) from information_schema.role_table_grants g
         where g.table_schema = 'public' and g.table_name = 'mcp_pending_actions' and g.grantee in ('anon', 'authenticated')) as anon_auth_grants,
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'mcp_pending_actions') as columns,
       (select count(*) from pg_constraint where conrelid = 'public.mcp_pending_actions'::regclass and conname = 'mcp_pending_actions_status_chk') as status_chk
from pg_class c
where c.oid = 'public.mcp_pending_actions'::regclass;
