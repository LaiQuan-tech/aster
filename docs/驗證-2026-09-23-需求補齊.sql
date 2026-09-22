-- =====================================================================
-- 套用後驗證（涵蓋 docs/套用-2026-09-23-需求補齊.sql 的 [0] migration 0050、
-- [1] sql/0040、[2] sql/0041）
--
-- 用 `npm run db:apply -- docs/驗證-2026-09-23-需求補齊.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀
-- select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [0] 六張新表都在、RLS 都開 ───────────────────────────────────────
-- 預期 6 rows，rls_enabled 皆 true
select c.relname as table_name, c.relrowsecurity as rls_enabled
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
   and c.relname in ('overtime_settlements', 'festival_bonuses', 'birthday_gifts',
                     'duty_rosters', 'employee_profile_change_requests', 'disbursement_approval_steps')
 order by 1;

-- ── 2. [1B] 六張新表的 trigger 掛齊 ────────────────────────────────────
-- 預期 6 rows：
--   birthday_gifts                   | audit_all, no_hard_delete, set_updated_at
--   disbursement_approval_steps      | audit_all, no_hard_delete
--   duty_rosters                     | audit_all
--   employee_profile_change_requests | audit_all, no_hard_delete, set_updated_at
--   festival_bonuses                 | audit_all, forbid_paid_row_mutation, no_hard_delete, set_updated_at
--   overtime_settlements             | audit_all, forbid_paid_row_mutation, no_hard_delete, set_updated_at
select c.relname as table_name,
       string_agg(t.tgname, ', ' order by t.tgname) as triggers
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal
   and c.relnamespace = 'public'::regnamespace
   and c.relname in ('overtime_settlements', 'festival_bonuses', 'birthday_gifts',
                     'duty_rosters', 'employee_profile_change_requests', 'disbursement_approval_steps')
 group by c.relname
 order by 1;

-- ── 3. [1C] forbid_paid_row_mutation() 存在且掛在兩張表 ─────────────────
-- 預期 1 row：fn_exists = true、attached_tables = 2
select exists(select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'forbid_paid_row_mutation') as fn_exists,
       (select count(*) from pg_trigger where tgname = 'forbid_paid_row_mutation' and not tgisinternal) as attached_tables;

-- ── 4. [1D] 新表 CHECK 都在 ───────────────────────────────────────────
-- 預期 12 rows（overtime_settlements ×5、festival_bonuses ×4、duty_rosters ×1、
--   employee_profile_change_requests ×1、disbursement_approval_steps ×1）
select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where contype = 'c'
   and conrelid::regclass::text in ('overtime_settlements', 'festival_bonuses', 'birthday_gifts',
                                    'duty_rosters', 'employee_profile_change_requests', 'disbursement_approval_steps')
 order by 1, 2;

-- ── 5. [0][1E] leave_balances：新唯一鍵在、舊的不在、無 NULL 期間、year 同步 ──
-- 預期 1 row：new_uq = true、old_uq = false、null_period = 0、year_mismatch = 0、
--   total = 目前餘額列數
select exists(select 1 from pg_indexes where schemaname = 'public' and indexname = 'leave_balances_tenant_emp_type_period_uq') as new_uq,
       exists(select 1 from pg_indexes where schemaname = 'public' and indexname = 'leave_balances_tenant_emp_type_year_uq')   as old_uq,
       (select count(*) from public.leave_balances where period_start is null or period_end is null) as null_period,
       (select count(*) from public.leave_balances where year <> extract(year from period_start)::int) as year_mismatch,
       (select count(*) from public.leave_balances) as total;

-- ── 6. [1E] leave_balances 四個新欄位 NOT NULL／預設正確、兩條 CHECK 在 ──
-- 預期 6 rows：period_start／period_end NO、source NO 'manual'、note YES；
--   leave_balances_period_chk、leave_balances_source_chk 各 1
select 'column' as kind, column_name as name, is_nullable as nullable, column_default as detail
  from information_schema.columns
 where table_schema = 'public' and table_name = 'leave_balances'
   and column_name in ('period_start', 'period_end', 'source', 'note')
union all
select 'check', conname, null, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'public.leave_balances'::regclass and contype = 'c'
 order by 1, 2;

-- ── 7. [1F] disbursements_status_chk 含五值；簽核五欄都在 ───────────────
-- 預期 1 row：definition 含 'draft', 'pending_approval', 'approved', 'paid', 'void'；new_cols = 5
select pg_get_constraintdef(oid) as definition,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'disbursements'
           and column_name in ('current_step', 'approval_round', 'submitted_at', 'submitted_by_emp_id', 'approved_at')) as new_cols
  from pg_constraint
 where conrelid = 'public.disbursements'::regclass and conname = 'disbursements_status_chk';

-- ── 8. [1F] 既有放款單狀態分布（套用前後應一致；只是確認沒被改到）───────
-- 預期：各狀態筆數與套用前記下的數字相同
select status, count(*) from public.disbursements group by 1 order by 1;

-- ── 9. [1G] is_project_lead() 已是新版（含 'manager'） ───────────────────
-- 預期 1 row：uses_manager = true、security_definer = true、anon_can／authenticated_can／service_role_can = true
select prosrc like '%''manager''%' as uses_manager,
       prosecdef as security_definer,
       has_function_privilege('anon',          'public.is_project_lead(uuid)', 'EXECUTE') as anon_can,
       has_function_privilege('authenticated', 'public.is_project_lead(uuid)', 'EXECUTE') as authenticated_can,
       has_function_privilege('service_role',  'public.is_project_lead(uuid)', 'EXECUTE') as service_role_can
  from pg_proc
 where pronamespace = 'public'::regnamespace and proname = 'is_project_lead';

-- ── 10. [1H] projects.engineers 沒有舊 key 了 ─────────────────────────
-- 預期 1 row：with_old_keys = 0；with_new_keys = 套用前含舊 key 的案數（以上）
select count(*) filter (where engineers ?| array['electrical', 'hvac', 'fire']) as with_old_keys,
       count(*) filter (where engineers ?| array['電機', '空調', '消防'])        as with_new_keys,
       count(*)                                                                  as total_projects
  from public.projects;

-- ── 11. [1H] 新舊混用案保留中文 key 的值（重放 seed 的 P-002）──────────
-- 正式庫沒有這筆會是 0 rows；重放時預期 1 row：engineers = {"汙水":…, "電機":{"name":"新值"}}（無 "electrical"）
select code, engineers from public.projects where code = 'P-002';

-- ── 12. [1I] bucket birthday-photos 存在且 private ─────────────────────
-- 預期 1 row：public = false
select id, public from storage.buckets where id = 'birthday-photos';

-- ── 13. [2] 稽核缺口（計畫 §3.1.3 的查詢）：只剩刻意跳過的表 ───────────
-- 預期 rows ⊆ {attendance_sheet_snapshots, audit_logs, knowledge_chunks, notifications,
--   personal_notes, rate_limits, user_preferences}（沒有其他表）
select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id')
   and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname in ('audit_all', 'audit_mutations'))
 order by 1;

-- ── 14. [2C] 四張證據表都有 no_hard_delete；schedules／tenant_calendar_days 是 audit_mutations ──
-- 預期 6 rows：announcement_acknowledgements／announcement_signature_sheets／announcement_versions／
--   company_pages → no_hard_delete；schedules／tenant_calendar_days → audit_mutations
select c.relname as table_name, t.tgname
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal
   and ((c.relname in ('announcement_versions', 'announcement_acknowledgements', 'announcement_signature_sheets', 'company_pages')
         and t.tgname = 'no_hard_delete')
     or (c.relname in ('schedules', 'tenant_calendar_days') and t.tgname = 'audit_mutations'))
 order by 1, 2;

-- ── 15. purge_test_tenant() 會掃到六張新表（它動態查有 tenant_id 的表）────
-- 預期 1 row：new_tables_with_tenant_id = 6
select count(*) as new_tables_with_tenant_id
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
 where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
   and c.table_name in ('overtime_settlements', 'festival_bonuses', 'birthday_gifts',
                        'duty_rosters', 'employee_profile_change_requests', 'disbursement_approval_steps');

-- ── 16. [0] 其餘新欄位都在 ───────────────────────────────────────────
-- 預期 9 rows
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (
     ('leave_requests', 'beyond_cap'), ('leave_requests', 'beyond_cap_detail'),
     ('payslips', 'sent_at'), ('payslips', 'sent_to'),
     ('project_settings', 'default_share_pct_by_role'),
     ('project_subcontract_payments', 'accepted_on'),
     ('project_subcontract_payments', 'accepted_by_emp_id'),
     ('project_subcontract_payments', 'acceptance_note'),
     ('overtime_settlements', 'sheet_id'))
 order by 1, 2;

-- ── 17. [1J] COMMENT 都在 ───────────────────────────────────────────
-- 預期 6 rows（六張新表），comment 皆非 null
select c.relname as table_name, left(obj_description(c.oid, 'pg_class'), 40) as comment_head
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('overtime_settlements', 'festival_bonuses', 'birthday_gifts',
                     'duty_rosters', 'employee_profile_change_requests', 'disbursement_approval_steps')
 order by 1;
