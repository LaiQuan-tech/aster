set transaction read only;
-- 預期 1 row：target_summary、text、YES；且 RLS 仍開（relrowsecurity = true）
select c.column_name, c.data_type, c.is_nullable,
       (select relrowsecurity from pg_class where oid = 'public.mcp_pending_actions'::regclass) as relrowsecurity,
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'mcp_pending_actions') as columns
from information_schema.columns c
where c.table_schema = 'public' and c.table_name = 'mcp_pending_actions' and c.column_name = 'target_summary';
