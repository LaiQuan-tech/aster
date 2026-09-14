-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-14 放款專區增量 docs/套用-2026-09-14-放款.sql
-- 的 [1]～[11]）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-14-放款.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. [1] disbursement_allocations 表已建立 ────────────────────────
-- 預期 1 row
select tablename from pg_tables where schemaname='public' and tablename='disbursement_allocations';

-- ── 2. [1] disbursement_allocations 欄位齊全 ────────────────────────
-- 預期 10 rows
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='disbursement_allocations'
 order by ordinal_position;

-- ── 3. [6] disbursement_allocations 的 index 在 ─────────────────────
-- 預期 1 row：disbursement_allocations_tenant_payment_idx
select indexname from pg_indexes
 where schemaname='public' and tablename='disbursement_allocations'
   and indexname='disbursement_allocations_tenant_payment_idx';

-- ── 4. [5] disbursement_allocations 的 FK 都在 ──────────────────────
-- 預期 5 rows：tenant_id／disbursement_id／project_id／subcontract_id／
-- subcontract_payment_id
select conname from pg_constraint
 where conrelid='public.disbursement_allocations'::regclass and contype='f'
 order by conname;

-- ── 5. [10] disbursement_allocations 的 CHECK 在 ────────────────────
-- 預期 1 row：disbursement_allocations_amount_chk
select conname from pg_constraint
 where conrelid='public.disbursement_allocations'::regclass and contype='c'
   and conname='disbursement_allocations_amount_chk';

-- ── 6. [8][9] disbursement_allocations 已開 RLS，trigger 為禁刪＋稽核
-- （無 set_updated_at——此表沒有 updated_at 欄位）───────────────────
-- 預期：rls_enabled=true, policy_count=0；trigger 2 rows
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename='disbursement_allocations') as policy_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='disbursement_allocations';
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='disbursement_allocations' order by tgname;

-- ── 7. [2] disbursement_attachments 表已建立 ────────────────────────
-- 預期 1 row
select tablename from pg_tables where schemaname='public' and tablename='disbursement_attachments';

-- ── 8. [2] disbursement_attachments 欄位齊全 ────────────────────────
-- 預期 9 rows
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='disbursement_attachments'
 order by ordinal_position;

-- ── 9. [5] disbursement_attachments 的 FK 都在 ──────────────────────
-- 預期 2 rows：tenant_id／disbursement_id
select conname from pg_constraint
 where conrelid='public.disbursement_attachments'::regclass and contype='f'
 order by conname;

-- ── 10. [8][9] disbursement_attachments 已開 RLS，trigger 只有
-- audit_all（不禁刪——附件可由使用者刪除重傳）──────────────────────
-- 預期：rls_enabled=true, policy_count=0；trigger 僅 1 筆 audit_all
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename='disbursement_attachments') as policy_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='disbursement_attachments';
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='disbursement_attachments';

-- ── 11. [3] disbursements 表已建立 ───────────────────────────────────
-- 預期 1 row
select tablename from pg_tables where schemaname='public' and tablename='disbursements';

-- ── 12. [3] disbursements 欄位齊全 ───────────────────────────────────
-- 預期 25 rows
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='disbursements'
 order by ordinal_position;

-- ── 13. [6] disbursements 的 unique index／一般 index 都在 ───────────
-- 預期 4 rows：disbursements_tenant_disbursement_no_uq、
-- disbursements_tenant_paid_on_idx、disbursements_tenant_vendor_idx、
-- disbursements_tenant_status_idx
select indexname from pg_indexes
 where schemaname='public' and tablename='disbursements'
   and indexname in ('disbursements_tenant_disbursement_no_uq',
                      'disbursements_tenant_paid_on_idx',
                      'disbursements_tenant_vendor_idx',
                      'disbursements_tenant_status_idx');

-- ── 14. [5] disbursements 的 FK 都在 ─────────────────────────────────
-- 預期 4 rows：tenant_id／vendor_id／paying_company_id／
-- receipt_issuer_company_id
select conname from pg_constraint
 where conrelid='public.disbursements'::regclass and contype='f'
 order by conname;

-- ── 15. [8][9] disbursements 已開 RLS，禁刪＋稽核＋updated_at 三個
-- trigger 都在（金額表，比照 project_subcontracts）───────────────────
-- 預期：rls_enabled=true, policy_count=0；trigger 3 rows
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname='public' and p.tablename='disbursements') as policy_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='disbursements';
select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
 where not t.tgisinternal and c.relname='disbursements' order by tgname;

-- ── 16. [10] disbursements 的 CHECK 都在 ─────────────────────────────
-- 預期 6 rows：status_chk、paid_chk、void_chk、amount_chk、payee_chk、
-- method_chk
select conname from pg_constraint
 where conrelid='public.disbursements'::regclass and contype='c'
   and conname in ('disbursements_status_chk','disbursements_paid_chk',
                    'disbursements_void_chk','disbursements_amount_chk',
                    'disbursements_payee_chk','disbursements_method_chk')
 order by conname;

-- ── 17. [4] vendors 四個新欄位（收款帳戶）都在 ───────────────────────
-- 預期 4 rows：account_holder、bank_account、bank_code、bank_name，
-- 皆 nullable、無 default
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='vendors'
   and column_name in ('bank_name','bank_code','bank_account','account_holder')
 order by column_name;

-- ── 18. [4][7] project_subcontract_payments.disbursement_id 已加且
-- FK 在（連動寫入用；null＝尚未經放款專區處理）───────────────────────
-- 預期欄位 1 row（uuid、可空）；FK 1 row
select data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='project_subcontract_payments'
   and column_name='disbursement_id';
select conname from pg_constraint
 where conrelid='public.project_subcontract_payments'::regclass and contype='f'
   and conname='project_subcontract_payments_disbursement_id_disbursements_id_fk';

-- ── 19. [11] storage bucket disbursement-vouchers 已建立且為 private ──
-- 預期 1 row：public=false
select id, name, public from storage.buckets where id='disbursement-vouchers';
