-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-14 P1+P3 增量 docs/套用-2026-09-14-P1P3.sql
-- 的 [1]～[12]）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-14-P1P3.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [2] attendance_sheets 表已建立 ───────────────────────────────
-- 預期 1 row
select tablename from pg_tables where schemaname='public' and tablename='attendance_sheets';

-- ── 2. [2] attendance_sheets 欄位齊全 ───────────────────────────────
-- 預期 24 rows
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='attendance_sheets'
 order by ordinal_position;

-- ── 3. [4] attendance_sheets 的 unique index／一般 index 都在 ────────
-- 預期 2 rows：attendance_sheets_tenant_employee_period_uq、
-- attendance_sheets_tenant_period_status_idx
select indexname from pg_indexes
 where schemaname='public' and tablename='attendance_sheets'
   and indexname in ('attendance_sheets_tenant_employee_period_uq',
                      'attendance_sheets_tenant_period_status_idx');

-- ── 4. [3] attendance_sheets 的 FK 都在（tenant_id、employee_id）────
-- 預期 2 rows
select conname from pg_constraint
 where conrelid='public.attendance_sheets'::regclass and contype='f';

-- ── 5. [11] attendance_sheets 的 CHECK 都在（period、status）───────
-- 預期 2 rows：attendance_sheets_period_chk、attendance_sheets_status_chk
select conname from pg_constraint
 where conrelid='public.attendance_sheets'::regclass and contype='c'
   and conname in ('attendance_sheets_period_chk','attendance_sheets_status_chk');

-- ── 6. [11] attendance_sheets 已開 RLS 且沒有任何 policy ────────────
-- 預期 1 row：rls_enabled=true, policy_count=0
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename='attendance_sheets') as policy_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='attendance_sheets';

-- ── 7. [11] attendance_sheets 三個 trigger 都在 ─────────────────────
-- 預期 3 rows：no_hard_delete、audit_all、set_updated_at
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='attendance_sheets'
 order by tgname;

-- ── 8. [1] attendance_sheet_days 表已建立 ───────────────────────────
-- 預期 1 row
select tablename from pg_tables where schemaname='public' and tablename='attendance_sheet_days';

-- ── 9. [1] attendance_sheet_days 欄位齊全 ───────────────────────────
-- 預期 29 rows
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='attendance_sheet_days'
 order by ordinal_position;

-- ── 10. [4] attendance_sheet_days 的 unique index／一般 index 都在 ──
-- 預期 2 rows
select indexname from pg_indexes
 where schemaname='public' and tablename='attendance_sheet_days'
   and indexname in ('attendance_sheet_days_sheet_work_date_uq',
                      'attendance_sheet_days_tenant_sheet_idx');

-- ── 11. [3] attendance_sheet_days 的 FK 都在，且 sheet_id 為 restrict ──
-- 預期 3 rows；sheet_id 那筆 confdeltype='r'（restrict）
select conname, confdeltype from pg_constraint
 where conrelid='public.attendance_sheet_days'::regclass and contype='f'
 order by conname;

-- ── 12. [11] attendance_sheet_days 的 CHECK 在（override）──────────
-- 預期 1 row：attendance_sheet_days_override_chk
select conname from pg_constraint
 where conrelid='public.attendance_sheet_days'::regclass and contype='c'
   and conname='attendance_sheet_days_override_chk';

-- ── 13. [11] attendance_sheet_days 已開 RLS 且沒有任何 policy ───────
-- 預期 1 row：rls_enabled=true, policy_count=0
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename='attendance_sheet_days') as policy_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='attendance_sheet_days';

-- ── 14. [11] attendance_sheet_days 三個 trigger 都在 ────────────────
-- 預期 3 rows：no_hard_delete、audit_all、set_updated_at
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='attendance_sheet_days'
 order by tgname;

-- ── 15. [5] punch_records 補打卡冪等的 partial unique index 已加 ────
-- 預期 1 row
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='punch_records'
   and indexname='punch_records_request_dedupe_uidx';

-- ── 16. [11] set_updated_at 函式已建立 ──────────────────────────────
-- 預期 1 row
select proname from pg_proc where pronamespace='public'::regnamespace and proname='set_updated_at';

-- ── 17. [6] clients 表已建立＋欄位齊全 ──────────────────────────────
-- 預期 19 rows
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='clients'
 order by ordinal_position;

-- ── 18. [9] clients 的 index 都在（一般 index + partial unique）────
-- 預期 2 rows
select indexname from pg_indexes
 where schemaname='public' and tablename='clients'
   and indexname in ('clients_tenant_name_idx','clients_tenant_tax_id_uq');

-- ── 19. [12] clients 已開 RLS，trigger 只有 audit_all（不掛禁刪）───
-- 預期：rls_enabled=true；trigger 僅 1 筆 audit_all
select c.relrowsecurity as rls_enabled from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='clients';
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='clients';

-- ── 20. [12] clients 的 CHECK 都在（invoice_type、payment_method）──
-- 預期 2 rows
select conname from pg_constraint
 where conrelid='public.clients'::regclass and contype='c'
   and conname in ('clients_invoice_type_chk','clients_payment_method_chk');

-- ── 21. [6] companies 表已建立＋欄位齊全＋unique index ──────────────
-- 預期欄位 10 rows；index 1 row（companies_tenant_name_uq）
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='companies'
 order by ordinal_position;
select indexname from pg_indexes
 where schemaname='public' and tablename='companies' and indexname='companies_tenant_name_uq';

-- ── 22. [12] companies 已開 RLS，trigger 只有 audit_all（不掛禁刪）──
-- 預期：rls_enabled=true；trigger 僅 1 筆 audit_all
select c.relrowsecurity as rls_enabled from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='companies';
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='companies';

-- ── 23. [6] project_subcontracts 表已建立＋欄位齊全＋index ──────────
-- 預期欄位 23 rows；index 1 row
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='project_subcontracts'
 order by ordinal_position;
select indexname from pg_indexes
 where schemaname='public' and tablename='project_subcontracts'
   and indexname='project_subcontracts_tenant_project_idx';

-- ── 24. [12] project_subcontracts 已開 RLS，禁刪＋稽核都在（金額表）──
-- 預期：rls_enabled=true；trigger 2 rows：no_hard_delete、audit_all
select c.relrowsecurity as rls_enabled from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='project_subcontracts';
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='project_subcontracts' order by tgname;

-- ── 25. [12]+[8] project_subcontracts 的 CHECK 與 FK 都在 ───────────
-- 預期 CHECK 2 rows（kind、order_type）；FK 4 rows（tenant/project/vendor/contract）
select conname from pg_constraint
 where conrelid='public.project_subcontracts'::regclass and contype='c'
   and conname in ('project_subcontracts_kind_chk','project_subcontracts_order_type_chk');
select conname from pg_constraint
 where conrelid='public.project_subcontracts'::regclass and contype='f';

-- ── 26. [6] project_subcontract_payments 表已建立＋欄位齊全＋index ──
-- 預期欄位 18 rows；index 1 row
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='project_subcontract_payments'
 order by ordinal_position;
select indexname from pg_indexes
 where schemaname='public' and tablename='project_subcontract_payments'
   and indexname='project_subcontract_payments_subcontract_installment_uq';

-- ── 27. [12] project_subcontract_payments 已開 RLS，禁刪＋稽核都在 ──
-- 預期：rls_enabled=true；trigger 2 rows
select c.relrowsecurity as rls_enabled from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='project_subcontract_payments';
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='project_subcontract_payments' order by tgname;

-- ── 28. [12] project_subcontract_payments 的 CHECK 都在 ─────────────
-- 預期 2 rows：override_chk、paid_chk
select conname from pg_constraint
 where conrelid='public.project_subcontract_payments'::regclass and contype='c'
   and conname in ('project_subcontract_payments_override_chk',
                    'project_subcontract_payments_paid_chk');

-- ── 29. [7]+[10] contracts.client_id 已加且 FK 在 ───────────────────
-- 預期欄位 1 row（uuid、可空）；FK 1 row
select data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='contracts' and column_name='client_id';
select conname from pg_constraint
 where conrelid='public.contracts'::regclass and contype='f'
   and conname='contracts_client_id_clients_id_fk';

-- ── 30. [7] project_billings 五個新欄位都在＋[12] CHECK 都在 ────────
-- 預期欄位 5 rows；CHECK 2 rows（kind_chk、received_chk）
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='project_billings'
   and column_name in ('invoice_no','invoiced_on','received_on','received_amount','kind')
 order by column_name;
select conname from pg_constraint
 where conrelid='public.project_billings'::regclass and contype='c'
   and conname in ('project_billings_kind_chk','project_billings_received_chk');

-- ── 31. project_billings 既有 trigger 不受影響（0023 掛的 audit_all／
-- no_hard_delete 仍在，本增量沒有動它）──────────────────────────────
-- 預期 2 rows
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='project_billings' order by tgname;

-- ── 32. [7] project_settings 五個新欄位都在＋[12] CHECK 在 ──────────
-- 預期欄位 5 rows；CHECK 1 row
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='project_settings'
   and column_name in ('code_prefix','code_year_style','code_seq_digits','vat_rate','disciplines')
 order by column_name;
select conname from pg_constraint
 where conrelid='public.project_settings'::regclass and contype='c'
   and conname='project_settings_code_year_style_chk';

-- ── 33. [7] projects 十三個新欄位都在＋[12] CHECK 在＋[10] FK 在 ────
-- 預期欄位 13 rows；CHECK 1 row；FK 1 row（client_id）
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='projects'
   and column_name in ('client_id','parent_project_id','kind','reserved_at','site_address',
                        'site_area_m2','design_scope','invoice_type','payment_method',
                        'closing_day','payment_day','other_expenses','engineers')
 order by column_name;
select conname from pg_constraint
 where conrelid='public.projects'::regclass and contype='c' and conname='projects_kind_chk';
select conname from pg_constraint
 where conrelid='public.projects'::regclass and contype='f'
   and conname='projects_client_id_clients_id_fk';
