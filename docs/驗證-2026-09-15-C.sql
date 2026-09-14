-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-15 C 批次增量 docs/套用-2026-09-15-C.sql
-- 的 [1]～[25]，另加 3 條交叉確認）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-15-C.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [1] attendance_sheet_snapshots 表已建（欄位數與關鍵欄位型別）───
-- 預期 11 rows（每欄一列），seq/rule_config_version 為 integer，
-- snapshot 為 jsonb not null
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='attendance_sheet_snapshots'
 order by ordinal_position;

-- ── 2. [2] period_closes 表已建（欄位數與關鍵欄位型別）─────────────
-- 預期 12 rows；status text not null default 'closed'
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='period_closes'
 order by ordinal_position;

-- ── 3. [3] rule_configs.effective_from 已加（date、not null、
-- 預設 '1900-01-01'）──────────────────────────────────────────────
-- 預期 1 row
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='rule_configs'
   and column_name='effective_from';

-- ── 4. [4] salary_adjustments.changed_by_emp_id 已加（uuid、可空）───
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='salary_adjustments'
   and column_name='changed_by_emp_id';

-- ── 5. [5] salary_structures.agreed_hours_per_week 已加
-- （numeric(5,2)、可空）─────────────────────────────────────────────
-- 預期 1 row：numeric_precision=5, numeric_scale=2, is_nullable=YES
select column_name, data_type, numeric_precision, numeric_scale, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='salary_structures'
   and column_name='agreed_hours_per_week';

-- ── 6. [6] salary_structures.agreed_days_per_week 已加
-- （numeric(3,1)、可空）─────────────────────────────────────────────
-- 預期 1 row：numeric_precision=3, numeric_scale=1, is_nullable=YES
select column_name, data_type, numeric_precision, numeric_scale, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='salary_structures'
   and column_name='agreed_days_per_week';

-- ── 7. [7] period_closes 的 FK 在（→ tenants）────────────────────────
-- 預期 1 row：period_closes_tenant_id_tenants_id_fk
select conname from pg_constraint
 where conrelid='public.period_closes'::regclass and contype='f'
   and conname='period_closes_tenant_id_tenants_id_fk';

-- ── 8. [8] period_closes 的 FK 在（→ employees）──────────────────────
-- 預期 1 row：period_closes_closed_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.period_closes'::regclass and contype='f'
   and conname='period_closes_closed_by_emp_id_employees_id_fk';

-- ── 9. [9] attendance_sheet_snapshots 的 FK 在（→ attendance_sheets）─
-- 預期 1 row：attendance_sheet_snapshots_sheet_id_attendance_sheets_id_fk
select conname from pg_constraint
 where conrelid='public.attendance_sheet_snapshots'::regclass and contype='f'
   and conname='attendance_sheet_snapshots_sheet_id_attendance_sheets_id_fk';

-- ── 10. [10] attendance_sheet_snapshots 的 FK 在（→ employees，
-- employee_id）───────────────────────────────────────────────────────
-- 預期 1 row：attendance_sheet_snapshots_employee_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.attendance_sheet_snapshots'::regclass and contype='f'
   and conname='attendance_sheet_snapshots_employee_id_employees_id_fk';

-- ── 11. [11] attendance_sheet_snapshots 的 FK 在（→ employees，
-- taken_by_emp_id）───────────────────────────────────────────────────
-- 預期 1 row：attendance_sheet_snapshots_taken_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.attendance_sheet_snapshots'::regclass and contype='f'
   and conname='attendance_sheet_snapshots_taken_by_emp_id_employees_id_fk';

-- ── 12. [12] salary_adjustments 新欄位的 FK 在（→ employees）─────────
-- 預期 1 row：salary_adjustments_changed_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.salary_adjustments'::regclass and contype='f'
   and conname='salary_adjustments_changed_by_emp_id_employees_id_fk';

-- ── 13. [13] period_closes_tenant_period_uq 在（unique）──────────────
-- 預期 1 row：indexdef 帶 UNIQUE 與 (tenant_id, period)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='period_closes'
   and indexname='period_closes_tenant_period_uq';

-- ── 14. [14] attendance_sheet_snapshots_tenant_sheet_seq_uq 在
-- （unique）───────────────────────────────────────────────────────────
-- 預期 1 row：indexdef 帶 UNIQUE 與 (tenant_id, sheet_id, seq)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='attendance_sheet_snapshots'
   and indexname='attendance_sheet_snapshots_tenant_sheet_seq_uq';

-- ── 15. [15] attendance_sheet_snapshots_tenant_employee_period_idx 在
-- （非 unique）────────────────────────────────────────────────────────
-- 預期 1 row：indexdef 帶 (tenant_id, employee_id, period)、無 UNIQUE
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='attendance_sheet_snapshots'
   and indexname='attendance_sheet_snapshots_tenant_employee_period_idx';

-- ── 16. [16] audit_row() 新版已生效：函式原始碼含新的 header key ─────
-- 預期 1 row：has_actor_header=true, has_ctx_header=true
select
  prosrc like '%x-actor-emp-id%' as has_actor_header,
  prosrc like '%x-actor-route%'  as has_ctx_header
  from pg_proc
 where proname='audit_row' and pronamespace='public'::regnamespace;

-- ── 17. [17] 8 個既有表已補掛 audit_all ──────────────────────────────
-- 預期 8 rows（每表一列，tgname 皆為 audit_all）
select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and t.tgname='audit_all'
   and c.relname in ('employee_profiles','departments','tenants','shifts',
                      'schedules','tenant_calendar_days','approval_flows',
                      'expense_settings')
 order by 1;

-- ── 18. [18] onboardings 已掛 audit_mutations（不是 audit_all）───────
-- 預期 1 row：tgname=audit_mutations
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='onboardings';

-- ── 19. [19] rule_configs.effective_from backfill 完成 ───────────────
-- 預期 count=0（沒有列還停在哨兵值 1900-01-01）
select count(*) from public.rule_configs where effective_from = '1900-01-01';

-- ── 20. [20] salary_structures_method_chk 在（含 'hourly'）───────────
-- 預期 1 row：CHECK 定義含 'monthly'::text, 'by_attendance_days'::text,
-- 'hourly'::text
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.salary_structures'::regclass and contype='c'
   and conname='salary_structures_method_chk';

-- ── 20b. 佐證 [20] 是安全的新增：既有列的 method 只會落在新集合內 ────
-- 預期：不會出現 monthly／by_attendance_days／hourly 以外的值
select method, count(*) from public.salary_structures
 group by 1 order by 1;

-- ── 21. [21] period_closes／attendance_sheet_snapshots 已 ENABLE RLS ─
-- 預期 2 rows：relrowsecurity 皆為 true
select relname, relrowsecurity from pg_class
 where relnamespace='public'::regnamespace
   and relname in ('period_closes','attendance_sheet_snapshots')
 order by 1;

-- ── 22. [22] period_closes 已掛 no_hard_delete／audit_all／
-- set_updated_at 三個 trigger ──────────────────────────────────────
-- 預期 3 rows：audit_all, no_hard_delete, set_updated_at
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='period_closes'
 order by 1;

-- ── 23. [23] period_closes_status_chk 在 ─────────────────────────────
-- 預期 1 row：CHECK 定義含 'closed'::text, 'reopened'::text
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.period_closes'::regclass and contype='c'
   and conname='period_closes_status_chk';

-- ── 24. [24] attendance_sheet_snapshots 只掛 no_hard_delete
-- （刻意不掛 audit_all，理由見 sql/0033 檔頭 [E]）────────────────────
-- 預期恰好 1 row：no_hard_delete
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='attendance_sheet_snapshots'
 order by 1;

-- ── 25. [25] storage bucket tenant-snapshots／request-attachments
-- 已建（皆 private）。request-attachments 是正式庫既有缺口的補紀錄
-- （2026-09-15 發現從未建立，假單附件上傳一直 Bucket not found，已在
-- 正式庫手動補建，此處確認 repo 重建也建得出來）──────────────────────
-- 預期 2 rows：public 皆為 false
select id, name, public from storage.buckets
 where id in ('tenant-snapshots', 'request-attachments')
 order by 1;

-- ── 25b. 座標同上、依 coordinator 指定的精簡查詢再核一次 ─────────────
-- 預期 2 rows：public 皆為 false
select id, public from storage.buckets where id in ('request-attachments','tenant-snapshots');

-- ── 26. 交叉確認：salary_adjustments 的 audit_all 仍在（0019 原始清單
-- 掛的，本批次只加欄位、未動 trigger，這裡只是確認狀態沒被誤動）───────
-- 預期 1 row：audit_all
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='salary_adjustments' and t.tgname='audit_all';

-- ── 27. 交叉確認：employees（0031 掛的）與 leave_types（0032 掛的）
-- 各自仍只有一個 audit_all，沒有因本批次重複掛 ─────────────────────
-- 預期 2 rows（employees、leave_types 各一），trigger_count 皆為 1
select c.relname, count(*) as trigger_count
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and t.tgname='audit_all'
   and c.relname in ('employees','leave_types')
 group by 1 order by 1;

-- ── 28. 交叉確認：確認本批次沒有漏掉或多掛——public 下掛 audit_all／
-- audit_mutations 的表總數，供人工比對數量是否符合預期成長 ───────────
select tgname, count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and t.tgname in ('audit_all','audit_mutations')
   and c.relnamespace='public'::regnamespace
 group by 1 order by 1;
