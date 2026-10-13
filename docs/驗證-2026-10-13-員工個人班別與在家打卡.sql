-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-13-員工個人班別與在家打卡.sql ＝ migration 0068 ＝ sql/0058）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-13-員工個人班別與在家打卡.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select，跑幾次都沒關係。
-- 每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. 三個新欄位都在、型別／預設／NOT NULL 正確 ─────────────────────
-- 預期 3 rows：
--   employees     | default_shift_id | uuid    | YES | (null)
--   employees     | features         | jsonb   | NO  | '{}'::jsonb
--   punch_records | wfh              | boolean | NO  | false
select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and ((table_name = 'employees' and column_name in ('default_shift_id', 'features')) or (table_name = 'punch_records' and column_name = 'wfh')) order by table_name, column_name;

-- ── 2. default_shift_id 的外鍵指向 shifts、刪班別時 SET NULL ─────────
-- 預期 1 row：employees_default_shift_id_shifts_id_fk（或 employees_default_shift_id_fkey）| shifts | n（n＝SET NULL）
select con.conname, con.confrelid::regclass as ref_table, con.confdeltype from pg_constraint con where con.conrelid = 'public.employees'::regclass and con.contype = 'f' and exists (select 1 from pg_attribute a where a.attrelid = con.conrelid and a.attnum = any (con.conkey) and a.attname = 'default_shift_id');

-- ── 3. features 只能是 object 的 CHECK 在 ─────────────────────────────
-- 預期 1 row：employees_features_object_chk
select conname from pg_constraint where conrelid = 'public.employees'::regclass and conname = 'employees_features_object_chk';

-- ── 4. 部分索引在 ─────────────────────────────────────────────────────
-- 預期 1 row：employees_default_shift_idx
select indexname from pg_indexes where schemaname = 'public' and tablename = 'employees' and indexname = 'employees_default_shift_idx';

-- ── 5. 既有資料沒被動到：沒有人有預設班別、沒有人開通功能、所有既有打卡 wfh=false ──
-- 預期 1 row：with_shift = 0、with_features = 0、wfh_punches = 0
select (select count(*) from public.employees where default_shift_id is not null) as with_shift, (select count(*) from public.employees where features <> '{}'::jsonb) as with_features, (select count(*) from public.punch_records where wfh) as wfh_punches;

-- ── 6. 沒有新增任何「HR 直連寫入」policy（0066／0067 的收斂維持）─────
-- 預期 0 rows
select tablename, policyname, cmd from pg_policies where schemaname = 'public' and tablename in ('employees', 'punch_records') and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
