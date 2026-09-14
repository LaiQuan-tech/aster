-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-15 B 批次增量 docs/套用-2026-09-15-B.sql
-- 的 [1]～[14]，另加 1 條交叉確認）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-15-B.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [1] clients.category 已加（text、可空）──────────────────────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='clients'
   and column_name='category';

-- ── 2. [2] disbursements.payee_bank_code 已加（text、可空）─────────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='disbursements'
   and column_name='payee_bank_code';

-- ── 3. [3] disbursements.has_invoice 已加（boolean、not null、
-- 預設 false）──────────────────────────────────────────────────────
-- 預期 1 row
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='disbursements'
   and column_name='has_invoice';

-- ── 4. [4] disbursements.invoice_no 已加（text、可空）───────────────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='disbursements'
   and column_name='invoice_no';

-- ── 5. [5] leave_requests.settled_at 已加（timestamptz、可空）───────
-- 預期 1 row：data_type=timestamp with time zone、is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='leave_requests'
   and column_name='settled_at';

-- ── 6. [6] leave_requests.settled_by_emp_id 已加（uuid、可空）───────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='leave_requests'
   and column_name='settled_by_emp_id';

-- ── 7. [7] leave_requests.settled_period 已加（text、可空）──────────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='leave_requests'
   and column_name='settled_period';

-- ── 8. [8] leave_requests 新欄位的 FK 在（→ employees）──────────────
-- 預期 1 row：leave_requests_settled_by_emp_id_employees_id_fk
select conname from pg_constraint
 where conrelid='public.leave_requests'::regclass and contype='f'
   and conname='leave_requests_settled_by_emp_id_employees_id_fk';

-- ── 9. [9] leave_requests_tenant_settled_period_idx 在 ──────────────
-- 預期 1 row：indexdef 帶 (tenant_id, settled_period)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='leave_requests'
   and indexname='leave_requests_tenant_settled_period_idx';

-- ── 10. [10] leave_types.requires_attachment 已加（boolean、
-- not null、預設 false）─────────────────────────────────────────────
-- 預期 1 row
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='leave_types'
   and column_name='requires_attachment';

-- ── 11. [11] projects.archive_reason 已加（text、可空）──────────────
-- 預期 1 row：is_nullable=YES
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='projects'
   and column_name='archive_reason';

-- ── 12. [12] clients_category_chk 在 ─────────────────────────────────
-- 預期 1 row：CHECK ((category IS NULL) OR (category = ANY (ARRAY[...])))
-- 五個值：'architect','engineer','owner','gov','other'
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.clients'::regclass and contype='c'
   and conname='clients_category_chk';

-- ── 13. [13] contracts_our_role_chk 已放寬含 'both' ─────────────────
-- 預期 1 row：CHECK 定義含 'contractor'::text, 'client'::text, 'both'::text
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.contracts'::regclass and contype='c'
   and conname='contracts_our_role_chk';

-- ── 13b. 佐證 [13] 是安全的放寬：既有列只會是 contractor／client
-- （CHECK 早已只允許這兩者，此處直接看資料分佈二次確認）───────────────
-- 預期：不會出現 contractor／client 以外的值
select our_role, count(*) from public.contracts
 group by 1 order by 1;

-- ── 14. [14] leave_types 已掛 audit_all 稽核 trigger ─────────────────
-- 預期 1 row：audit_all
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='leave_types' and t.tgname='audit_all';

-- ── 15. 交叉確認：clients 的 audit_all 稽核 trigger 仍在（sql/0028 掛
-- 的，非本批次新增，本批次未動它，這裡只是確認狀態沒被誤動）──────────
-- 預期 1 row：audit_all
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='clients' and t.tgname='audit_all';
