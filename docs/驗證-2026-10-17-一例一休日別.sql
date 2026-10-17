-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-17-一例一休日別.sql ＝ migration 0069 ＝ sql/0059 ＋ 2026 行事曆修正）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-17-一例一休日別.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- 每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. CHECK 已含 regular_leave ─────────────────────────────────────
-- 預期 1 row：tenant_calendar_days_day_type_chk | CHECK ((day_type = ANY (ARRAY['workday'::text, 'rest_day'::text, 'regular_leave'::text, 'fixed_holiday'::text])))
select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.tenant_calendar_days'::regclass and conname = 'tenant_calendar_days_day_type_chk';

-- ── 2. 2026 週末國定假日本日不再是 fixed_holiday（系統產生／匯入的列）────
-- 預期 0 rows
select tenant_id, date, day_type, label, source from public.tenant_calendar_days where date in (date '2026-02-28', date '2026-04-04', date '2026-04-05', date '2026-10-10', date '2026-10-25') and day_type = 'fixed_holiday' and source in ('generated', 'import') order by tenant_id, date;

-- ── 3. 補假日仍是 fixed_holiday ─────────────────────────────────────
-- 預期：每個有產生過 2026 行事曆的租戶各 5 rows（2/27、4/3、4/6、10/9、10/26）皆 fixed_holiday（HR 手動改過的除外，見第 4 條）
select tenant_id, date, day_type, source from public.tenant_calendar_days where date in (date '2026-02-27', date '2026-04-03', date '2026-04-06', date '2026-10-09', date '2026-10-26') order by tenant_id, date;

-- ── 4. HR 手動改過、這次沒動的週末／週末國定假日列（請人工確認是否也要改）──
-- 預期：通常 0 rows；有列就是 HR 在後台手動設定過的，套用檔刻意不動
select tenant_id, date, extract(dow from date)::int as dow, day_type, label from public.tenant_calendar_days where source = 'manual' and date between date '2026-01-01' and date '2026-12-31' and (extract(dow from date)::int in (0, 6) or date in (date '2026-02-28', date '2026-04-04', date '2026-04-05', date '2026-10-10', date '2026-10-25')) order by tenant_id, date;

-- ── 5. 預設週休的租戶：2026 週日不再有系統產生的 rest_day ──────────────
-- 預期 0 rows（租戶 features.attendance 有自訂例假日的不在此列）
select c.tenant_id, count(*) as sunday_rest_days from public.tenant_calendar_days c join public.tenants t on t.id = c.tenant_id where c.date between date '2026-01-01' and date '2026-12-31' and extract(dow from c.date)::int = 0 and c.day_type = 'rest_day' and c.source <> 'manual' and t.features -> 'attendance' -> 'regularLeaveWeekday' is null group by c.tenant_id;

-- ── 6. 每個租戶 2026 各日別的列數（目視）───────────────────────────────
-- 預期（預設週休、整年產生過、沒有手動改）：regular_leave 52、rest_day 52、fixed_holiday 16
select tenant_id, day_type, count(*) from public.tenant_calendar_days where date between date '2026-01-01' and date '2026-12-31' group by tenant_id, day_type order by tenant_id, day_type;
