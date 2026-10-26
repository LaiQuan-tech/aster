-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-28-專案審迄還款.sql ＝ migration 0077 ＝ sql/0067）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-28-專案審迄還款.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- =====================================================================

-- ── 1. 新欄位在、可空、型別 text ─────────────────────────────────────
-- 預期 1 row：guild_repayment_note text YES
select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'guild_repayment_note';

-- ── 2. 長度 CHECK ────────────────────────────────────────────────────
-- 預期 1 row：projects_guild_repayment_note_len_chk，定義含 char_length(guild_repayment_note) <= 200
select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.projects'::regclass and conname = 'projects_guild_repayment_note_len_chk';

-- ── 3. 既有專案都是 NULL（本檔不回填）────────────────────────────────
-- 預期 1 row：filled = 0（剛套完時）
select count(*) filter (where guild_repayment_note is not null) as filled, count(*) as total from public.projects;

-- ── 4. projects 沒有新增直接寫入 policy（寫入一律經 API）─────────────────
-- 預期：與套用前相同的 policy 清單（本檔不動 policy）
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'projects' order by policyname;
