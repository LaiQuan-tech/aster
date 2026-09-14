-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-15 D 批次增量 docs/套用-2026-09-15-D.sql
-- 的 [1]～[20]，另加 2 條交叉確認）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-15-D.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
--
-- ⚠️ 這裡只驗「結構」（欄位／FK／index／RLS／trigger 掛了沒／CHECK 定義／
-- 函式存在）。「trigger 真的有擋下操作」這種行為面驗證，走 PGlite replay
-- 的暫時 seed（見 D 批次交接紀錄），不放在這份可重複執行的結構驗證檔裡。
-- =====================================================================

-- ── 1. [1] bonus_run_items 表已建（欄位數與關鍵欄位型別）─────────────
-- 預期 18 rows；overpaid 為 boolean not null，received_total／
-- entitled_cumulative／paid_before／amount 皆 numeric not null
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='bonus_run_items'
 order by ordinal_position;

-- ── 2. [2] bonus_runs 表已建（欄位數與關鍵欄位型別）───────────────────
-- 預期 16 rows；status text not null default 'draft'，
-- totals jsonb not null default '{}'
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='bonus_runs'
 order by ordinal_position;

-- ── 3. [3] bonus_run_items 的 FK 在（→ bonus_runs）───────────────────
-- 預期 1 row：bonus_run_items_run_id_bonus_runs_id_fk
select conname from pg_constraint
 where conrelid='public.bonus_run_items'::regclass and contype='f'
   and conname='bonus_run_items_run_id_bonus_runs_id_fk';

-- ── 4. [4] bonus_run_items 的 FK 在（→ projects）─────────────────────
-- 預期 1 row：bonus_run_items_project_id_projects_id_fk
select conname from pg_constraint
 where conrelid='public.bonus_run_items'::regclass and contype='f'
   and conname='bonus_run_items_project_id_projects_id_fk';

-- ── 5. [5] bonus_run_items 的 FK 在（→ employees，employee_id）───────
-- 預期 1 row：bonus_run_items_employee_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.bonus_run_items'::regclass and contype='f'
   and conname='bonus_run_items_employee_id_employees_id_fk';

-- ── 6. [6] bonus_runs 的 FK 在（→ tenants）───────────────────────────
-- 預期 1 row：bonus_runs_tenant_id_tenants_id_fk
select conname from pg_constraint
 where conrelid='public.bonus_runs'::regclass and contype='f'
   and conname='bonus_runs_tenant_id_tenants_id_fk';

-- ── 7. [7] bonus_runs 的 FK 在（→ employees，created_by_emp_id）──────
-- 預期 1 row：bonus_runs_created_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.bonus_runs'::regclass and contype='f'
   and conname='bonus_runs_created_by_emp_id_employees_id_fk';

-- ── 8. [8] bonus_runs 的 FK 在（→ employees，paid_by_emp_id）─────────
-- 預期 1 row：bonus_runs_paid_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.bonus_runs'::regclass and contype='f'
   and conname='bonus_runs_paid_by_emp_id_employees_id_fk';

-- ── 9. [9] bonus_runs 的 FK 在（→ employees，deleted_by_emp_id）──────
-- 預期 1 row：bonus_runs_deleted_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.bonus_runs'::regclass and contype='f'
   and conname='bonus_runs_deleted_by_emp_id_employees_id_fk';

-- ── 10. [10] bonus_run_items_run_project_employee_uq 在（unique）─────
-- 預期 1 row：indexdef 帶 UNIQUE 與 (run_id, project_id, employee_id)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='bonus_run_items'
   and indexname='bonus_run_items_run_project_employee_uq';

-- ── 11. [11] bonus_run_items_tenant_employee_idx 在（非 unique）──────
-- 預期 1 row：indexdef 帶 (tenant_id, employee_id)、無 UNIQUE
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='bonus_run_items'
   and indexname='bonus_run_items_tenant_employee_idx';

-- ── 12. [12] bonus_run_items_tenant_project_idx 在（非 unique）───────
-- 預期 1 row：indexdef 帶 (tenant_id, project_id)、無 UNIQUE
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='bonus_run_items'
   and indexname='bonus_run_items_tenant_project_idx';

-- ── 13. [13] bonus_runs_tenant_label_uq 在（partial unique）──────────
-- 預期 1 row：indexdef 帶 UNIQUE、(tenant_id, label)、
-- WHERE (deleted_at IS NULL)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='bonus_runs'
   and indexname='bonus_runs_tenant_label_uq';

-- ── 14. [14] bonus_runs_tenant_status_idx 在（非 unique）─────────────
-- 預期 1 row：indexdef 帶 (tenant_id, status)、無 UNIQUE
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='bonus_runs'
   and indexname='bonus_runs_tenant_status_idx';

-- ── 15. [15] bonus_runs／bonus_run_items 已 ENABLE RLS ───────────────
-- 預期 2 rows：relrowsecurity 皆為 true
select relname, relrowsecurity from pg_class
 where relnamespace='public'::regnamespace
   and relname in ('bonus_runs','bonus_run_items')
 order by 1;

-- ── 16. [16]+[20] bonus_runs 已掛 4 個 trigger ───────────────────────
-- 預期 4 rows：audit_all, forbid_paid_bonus_mutation, no_hard_delete,
-- set_updated_at
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='bonus_runs'
 order by 1;

-- ── 17. [17]+[20] bonus_run_items 已掛 3 個 trigger ──────────────────
-- 預期 3 rows：audit_all, forbid_paid_bonus_mutation, no_hard_delete
-- （無 set_updated_at：本表無 updated_at 欄位）
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='bonus_run_items'
 order by 1;

-- ── 18. [18] bonus_runs_status_chk 在 ────────────────────────────────
-- 預期 1 row：CHECK 定義含 'draft'::text, 'paid'::text
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.bonus_runs'::regclass and contype='c'
   and conname='bonus_runs_status_chk';

-- ── 19. [19] bonus_runs_paid_requires_paid_on_chk 在 ─────────────────
-- 預期 1 row：CHECK 定義含 status <> 'paid'::text OR paid_on IS NOT NULL
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.bonus_runs'::regclass and contype='c'
   and conname='bonus_runs_paid_requires_paid_on_chk';

-- ── 20a. [20] forbid_paid_bonus_mutation() 函式存在 ──────────────────
-- 預期 1 row：函式原始碼含 TG_TABLE_NAME 分流與 is_disposable_tenant
select
  prosrc like '%TG_TABLE_NAME%'        as branches_by_table,
  prosrc like '%is_disposable_tenant%' as has_escape_hatch
  from pg_proc
 where proname='forbid_paid_bonus_mutation' and pronamespace='public'::regnamespace;

-- ── 20b. [20] 兩表的 trigger 定義皆為 BEFORE UPDATE OR DELETE ────────
-- 預期 2 rows，triggerdef 皆含 BEFORE 與 UPDATE OR DELETE
select c.relname, pg_get_triggerdef(t.oid) as def
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and t.tgname='forbid_paid_bonus_mutation'
 order by 1;

-- ── 21. 交叉確認：兩張新表皆有 tenant_id 欄位可供 RLS／索引使用 ───────
-- 預期 2 rows；bonus_run_items.tenant_id 故意無 FK（見 schema 註解），
-- bonus_runs.tenant_id 有 FK（已在第 6 條驗過），這裡只確認欄位本身都在
select table_name, column_name, is_nullable from information_schema.columns
 where table_schema='public' and column_name='tenant_id'
   and table_name in ('bonus_runs','bonus_run_items')
 order by 1;

-- ── 22. 交叉確認：本批次沒有動到既有表——disbursements／period_closes
-- 等既有表的 trigger 數量不受影響（僅供人工比對，抓「順手改到別的表」）──
select c.relname, count(*) as trigger_count
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal
   and c.relname in ('disbursements','disbursement_allocations','period_closes')
 group by 1 order by 1;
