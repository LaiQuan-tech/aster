-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-17-晚餐勾選.sql ＝ migration 0070 ＝ sql/0060）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-17-晚餐勾選.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- 每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. 兩個欄位都在、型別 boolean、可為 NULL、沒有預設值 ──────────────────
-- 預期 2 rows：attendance_days | dinner_taken | boolean | YES | (null)；punch_records | dinner_taken | boolean | YES | (null)
select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and column_name = 'dinner_taken' and table_name in ('attendance_days', 'punch_records') order by table_name;

-- ── 2. 欄位註解 ─────────────────────────────────────────────────────
-- 預期 2 rows，各有一段中文說明
select c.relname as table_name, col_description(c.oid, a.attnum) as comment from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and a.attname = 'dinner_taken' and c.relname in ('attendance_days', 'punch_records') order by c.relname;

-- ── 3. 剛套完時沒有任何值（之後由 API 寫入）──────────────────────────────
-- 預期 1 row：0 | 0（套完一段時間後再跑，數字會隨員工勾選增加，屬正常）
select (select count(*) from public.punch_records where dinner_taken is not null) as punch_flags, (select count(*) from public.attendance_days where dinner_taken is not null) as manual_flags;

-- ── 4. 各租戶目前的晚餐扣除模式（決定要不要問晚餐）────────────────────────
-- 預期：每個有存規則的租戶一列；mode 為 null 或 auto ＝ 照舊自動扣（不會出現勾選框），opt_in ＝ 有勾才扣
select tenant_id, version, config -> 'overtime' -> 'mealBreak' ->> 'mode' as meal_mode, config -> 'overtime' -> 'mealBreak' as meal_break from public.rule_configs where active order by tenant_id, version desc;
