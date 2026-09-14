-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-15 A 批次增量 docs/套用-2026-09-15-A.sql
-- 的 [1]～[9]）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-15-A.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [1] employees.must_change_password 已加（boolean、not null、
-- 預設 false）──────────────────────────────────────────────────────
-- 預期 1 row
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='employees'
   and column_name='must_change_password';

-- ── 2. [2] employees_user_id_uq partial unique index 在 ────────────
-- 預期 1 row：indexdef 帶 WHERE (user_id IS NOT NULL)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='employees'
   and indexname='employees_user_id_uq';

-- ── 3. [2] 既有資料沒有重複 user_id（partial unique index 才套得上；
-- 這條直接檢查資料本身，不是檢查 index 定義）─────────────────────────
-- 預期 0 rows
select user_id, count(*) from public.employees
 where user_id is not null
 group by 1
having count(*) > 1;

-- ── 4. [3] approval_flows.mode 已加（text、not null、預設 'list'）──
-- 預期 1 row
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='approval_flows'
   and column_name='mode';

-- ── 5. [7] approval_flows_mode_chk 在 ───────────────────────────────
-- 預期 1 row：CHECK ((mode = ANY (ARRAY['manager'::text, 'list'::text])))
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.approval_flows'::regclass and contype='c'
   and conname='approval_flows_mode_chk';

-- ── 6. [4] approval_steps.acted_by_emp_id 已加（uuid、可空）─────────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='approval_steps'
   and column_name='acted_by_emp_id';

-- ── 7. [5] approval_steps 新欄位的 FK 在（→ employees）──────────────
-- 預期 1 row：approval_steps_acted_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.approval_steps'::regclass and contype='f'
   and conname='approval_steps_acted_by_emp_id_employees_id_fk';

-- ── 8. [6] projects.opened_on 已加（date、可空）─────────────────────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='projects'
   and column_name='opened_on';

-- ── 9. [9] backfill 後沒有遺漏——所有既有專案 opened_on 都有值 ────────
-- 預期 1 row：count=0
select count(*) from public.projects where opened_on is null;

-- ── 10. [8] employees 已掛 audit_all 稽核 trigger ────────────────────
-- 預期 1 row：audit_all
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='employees' and t.tgname='audit_all';
