-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-27-客供商欄位.sql ＝ migration 0076 ＝ sql/0066）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-27-客供商欄位.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- =====================================================================

-- ── 1. vendors 新欄位在、型別正確 ─────────────────────────────────────
-- 預期 6 rows：code text YES、fax text YES、payment_terms text YES、roster_kind text NO（預設 'supplier'::text）、seq integer YES、sub_category text YES
select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'vendors' and column_name in ('roster_kind', 'seq', 'sub_category', 'code', 'fax', 'payment_terms') order by column_name;

-- ── 2. clients 新欄位在、可空 ────────────────────────────────────────
-- 預期 3 rows：code text YES、region text YES、seq integer YES
select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name in ('seq', 'region', 'code') order by column_name;

-- ── 3. 名冊類別 CHECK ────────────────────────────────────────────────
-- 預期 1 row：vendors_roster_kind_chk，定義含 supplier／engineer／review_unit
select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.vendors'::regclass and conname = 'vendors_roster_kind_chk';

-- ── 4. backfill：名冊類別 × 類別前綴 ─────────────────────────────────
-- 預期（剛套完、資料搬遷前）：「技師／…」全為 engineer、「送審單位／…」全為 review_unit、其他全為 supplier（正式租戶 10/12 匯入：技師 10、送審 3）
select roster_kind, case when category like '技師／%' then '技師／…' when category like '送審單位／%' or category like '送審相關單位／%' then '送審單位／…' else '其他' end as category_prefix, count(*) from public.vendors where deleted_at is null group by 1, 2 order by 1, 2;

-- ── 5. 沒有新增直接寫入 policy（寫入一律經 API）─────────────────────────
-- 預期：與套用前相同的 policy 清單（本檔不動 policy）
select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename in ('vendors', 'clients') order by tablename, policyname;
