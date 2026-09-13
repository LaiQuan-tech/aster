-- =====================================================================
-- 套用後驗證（涵蓋 09-12 增量 v2 的 [1]～[7] 與 09-13 增量的 [8]）
--
-- 用 `npm run db:apply -- docs/驗證-2026-09-13-套用後.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 三條都是唯讀 select，跑幾次都沒關係。
-- =====================================================================

-- ── 1. 結構：每一格都要等於括號裡的預期值 ────────────────────────────
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name in ('advances','expense_settings'))
                                                               as "新表(預期2)",
  (select count(*) from information_schema.columns
    where table_schema='public' and (
      (table_name='leave_requests' and column_name in
        ('trip_scope','estimated_cost','advance_requested','trip_report'))
      or (table_name='expense_categories' and column_name='requires_trip_approval')
      or (table_name='expense_claims' and column_name in ('trip_request_id','advance_id'))))
                                                               as "新欄位(預期7)",
  (select count(*) from pg_trigger t
     join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal and c.relname='advances')
                                                               as "advances trigger(預期2)",
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='projects' and column_name='fiscal_year')
                                                               as "projects.fiscal_year(預期1)",
  (select count(*) from pg_indexes
    where schemaname='public' and indexname='projects_tenant_code_uq')
                                                               as "編號唯一索引(預期1)",
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='projects' and column_name in
      ('status_reason','status_effective_on','status_changed_at',
       'status_changed_by_emp_id','archived_at'))
                                                               as "案情欄位(預期5)",
  (select count(*) from public.projects where status='archived')
                                                               as "殘留舊狀態(預期0)",
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='project_settings')
                                                               as "project_settings(預期1)",
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='projects' and column_name='unarchived_at')
                                                               as "unarchived_at(預期1)",
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='contracts')    as "contracts(預期1)",
  (select count(*) from pg_trigger t
     join pg_class c on c.oid=t.tgrelid
     join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal and c.relname='contracts')
                                                               as "contracts trigger(預期2)",
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='project_billings')
                                                               as "project_billings(預期1)",
  (select count(*) from pg_indexes
    where schemaname='public' and indexname='project_billings_no_uq'
      and indexdef like '%WHERE%')                             as "partial index(預期1)",
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='salary_structures'
      and column_name='pension_voluntary_rate')                as "勞退自提率欄位(預期1)";

-- ── 2. 步驟 4 的人工補件清單：[4] 把舊的 archived 一律猜成 closed，這些要人看 ──
select id, code, name, status, status_reason
  from public.projects
 where status_reason like '由舊制%'
 order by code;

-- ── 3. 有沒有殘留先前那版增量建出的 trip_advances（有就看 v2 檔末「補救」）──
select count(*) as "trip_advances 殘留(預期0：表不存在或無資料)"
  from information_schema.tables
 where table_schema='public' and table_name='trip_advances';
