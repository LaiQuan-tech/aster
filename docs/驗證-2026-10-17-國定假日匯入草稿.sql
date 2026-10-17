-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-17-國定假日匯入草稿.sql ＝ migration 0071 ＝ sql/0061）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-17-國定假日匯入草稿.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- 每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. 表與欄位 ─────────────────────────────────────────────────────
-- 預期 13 rows：id, tenant_id, year, source, fetched_at, payload, diff, status, created_by_emp_id, approved_by_emp_id, approved_at, created_at, updated_at
select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'calendar_import_drafts' order by ordinal_position;

-- ── 2. CHECK 約束 ───────────────────────────────────────────────────
-- 預期 4 rows：calendar_import_drafts_approved_chk、_source_chk（dgpa／ntpc）、_status_chk（draft／approved／superseded）、_year_chk
select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.calendar_import_drafts'::regclass and contype = 'c' order by conname;

-- ── 3. 索引（含每租戶每年最多一筆 draft／approved 的 partial unique）────
-- 預期 4 rows：calendar_import_drafts_pkey、_tenant_year_idx、_one_draft_uq（WHERE status = 'draft'）、_one_approved_uq（WHERE status = 'approved'）
select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'calendar_import_drafts' order by indexname;

-- ── 4. RLS 開啟、沒有任何 policy（前端直連一律擋，API 走 service role）──
-- 預期 1 row：relrowsecurity = true；policies = 0
select c.relrowsecurity, (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'calendar_import_drafts') as policies from pg_class c where c.oid = 'public.calendar_import_drafts'::regclass;

-- ── 5. 稽核 trigger ─────────────────────────────────────────────────
-- 預期 1 row：audit_all
select tgname from pg_trigger where tgrelid = 'public.calendar_import_drafts'::regclass and not tgisinternal;

-- ── 6. 目前草稿（剛套用時）────────────────────────────────────────────
-- 預期 0 rows（草稿由 API／排程建立）
select tenant_id, year, source, status, approved_at from public.calendar_import_drafts order by tenant_id, year, created_at;
