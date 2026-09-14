-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-14 P0 增量 docs/套用-2026-09-14-P0.sql 的 [1]～[6]）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-14-P0.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [1] tenants.timezone 已加、型別與預設值正確 ──────────────────
-- 預期 1 row：data_type=text, is_nullable=NO, column_default 含 'Asia/Taipei'
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='tenants' and column_name='timezone';

-- ── 2. [2] tenant_calendar_days 表已建立 ────────────────────────────
-- 預期 1 row（tablename=tenant_calendar_days）
select tablename from pg_tables
 where schemaname='public' and tablename='tenant_calendar_days';

-- ── 3. [2] tenant_calendar_days 欄位齊全 ────────────────────────────
-- 預期 7 rows：id / tenant_id / date / day_type / label / source / created_at
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='tenant_calendar_days'
 order by ordinal_position;

-- ── 4. [2]+[6] tenant_calendar_days 的 unique index／FK／CHECK 三者都在 ──
-- 預期 3 rows：unique_index / foreign_key / check_constraint 各一
select 'unique_index' as kind, indexname as name
  from pg_indexes
 where schemaname='public' and tablename='tenant_calendar_days'
   and indexname='tenant_calendar_days_tenant_date_uq'
union all
select 'foreign_key', conname
  from pg_constraint
 where conrelid='public.tenant_calendar_days'::regclass and contype='f'
union all
select 'check_constraint', conname
  from pg_constraint
 where conrelid='public.tenant_calendar_days'::regclass and contype='c';

-- ── 5. [6] tenant_calendar_days 已開 RLS 且沒有任何 policy ──────────
-- 預期 1 row：rls_enabled=true, policy_count=0（比照 0024：全擋，不開放）
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename='tenant_calendar_days') as policy_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname='public' and c.relname='tenant_calendar_days';

-- ── 6. [3] leave_types.deduct_rate 已加，numeric(3,2)、可空 ─────────
-- 預期 1 row：data_type=numeric, numeric_precision=3, numeric_scale=2, is_nullable=YES
select column_name, data_type, numeric_precision, numeric_scale, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='leave_types' and column_name='deduct_rate';

-- ── 7. [4] punch_records.request_id 已加、可空、且刻意不設 FK ───────
-- 預期 1 row：data_type=uuid, is_nullable=YES, fk_count=0
select c.data_type, c.is_nullable,
       (select count(*) from pg_constraint
          where conrelid='public.punch_records'::regclass and contype='f'
            and conname like '%request_id%') as fk_count
  from information_schema.columns c
 where c.table_schema='public' and c.table_name='punch_records' and c.column_name='request_id';

-- ── 8. [5] attendance_days 四個新欄位都在，預設值正確 ───────────────
-- 預期 4 rows：leave_minutes(integer,0) / leave_breakdown(jsonb,'{}') /
-- outing_minutes(integer,0) / early_leave_minutes(integer,0)，is_nullable 皆 NO
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema='public' and table_name='attendance_days'
   and column_name in ('leave_minutes','leave_breakdown','outing_minutes','early_leave_minutes')
 order by column_name;

-- ── 9. 既有表 RLS 不受影響（punch_records／attendance_days／leave_types）──
-- 預期 3 rows，全部 relrowsecurity=true（本增量沒有改動它們的 RLS 開關）
select relname, relrowsecurity
  from pg_class
 where relnamespace='public'::regnamespace
   and relname in ('punch_records','attendance_days','leave_types')
 order by relname;
