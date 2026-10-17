-- =====================================================================
-- 2026-10-17 一例一休日別（migration 0069 ＝ sql/0059）＋ 修正 2026 行事曆
--
-- 前提：已套到 0068（sql/0058）。整份可重跑（冪等）：第二次執行不會再改任何一列。
-- 套用後跑 docs/驗證-2026-10-17-一例一休日別.sql。
-- 順序：先套本檔、再部署 API（舊 API 讀到 regular_leave 會當作沒有列、退回週六日＝休息日，
-- 不會壞；新 API 的 PUT /calendar/days 寫 regular_leave 需要 A 段的 CHECK 先在）。
-- =====================================================================

-- ── A. tenant_calendar_days.day_type 加入 'regular_leave'（例假）─────────────────
--   勞基法第 36 條：每七日中一日例假、一日休息日，兩者出勤的法律效果不同，日別要分開記。
--   值集合對齊 @hr/rules 的 DayType。attendance_days／attendance_sheet_days 的 day_type 沒有 CHECK，不用改。
--   例假／休息日是星期幾：tenants.features.attendance.regularLeaveWeekday／restDayWeekday（預設 0＝週日／6＝週六）、
--   employees.features.regularLeaveWeekday／restDayWeekday（個人覆寫）——都是 jsonb，不需 DDL。
ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
ALTER TABLE public.tenant_calendar_days ADD CONSTRAINT tenant_calendar_days_day_type_chk
  CHECK (day_type IN ('workday', 'rest_day', 'regular_leave', 'fixed_holiday'));

-- ── B. 修正 2026 行事曆（所有租戶；只動系統產生／匯入的列，HR 手動 source='manual' 的不動）──────────
--   1) 落在週末的國定假日本日（2/28 六、4/4 六、4/5 日、10/10 六、10/25 日）原本被標成 fixed_holiday，
--      但補假日（2/27、4/3、4/6、10/9、10/26）已經是 fixed_holiday——同一個節日算了兩天假，且週末出勤會被
--      當成國定假日計薪。改回週末性質：例假日 → regular_leave、休息日 → rest_day，label 註記節日名稱。
--   2) 既有 2026 的週末列：例假日那天（預設週日）的 rest_day → regular_leave（以前沒有例假這個值）。
--   例假／休息日依租戶 features.attendance 設定（沒設＝週日例假、週六休息日），與 API services/day-type.ts
--   的 tenantWeekendPolicy 同一套推導。HR 手動改過的列列在驗證檔第 4 條，請人工確認。
WITH raw AS (
  SELECT t.id AS tenant_id,
    CASE WHEN jsonb_typeof(t.features -> 'attendance' -> 'regularLeaveWeekday') = 'number'
          AND (t.features -> 'attendance' ->> 'regularLeaveWeekday') IN ('0', '1', '2', '3', '4', '5', '6')
         THEN (t.features -> 'attendance' ->> 'regularLeaveWeekday')::int END AS reg_raw,
    CASE WHEN jsonb_typeof(t.features -> 'attendance' -> 'restDayWeekday') = 'number'
          AND (t.features -> 'attendance' ->> 'restDayWeekday') IN ('0', '1', '2', '3', '4', '5', '6')
         THEN (t.features -> 'attendance' ->> 'restDayWeekday')::int END AS rest_raw
  FROM public.tenants t
), pol AS (
  SELECT tenant_id,
    COALESCE(reg_raw, 0) AS reg,
    CASE
      WHEN rest_raw IS NOT NULL AND rest_raw <> COALESCE(reg_raw, 0) THEN rest_raw
      WHEN COALESCE(reg_raw, 0) = 0 THEN 6
      WHEN COALESCE(reg_raw, 0) = 6 THEN 0
      ELSE (COALESCE(reg_raw, 0) + 6) % 7
    END AS rest
  FROM raw
), target AS (
  SELECT c.id,
    CASE WHEN extract(dow FROM c.date)::int = p.reg THEN 'regular_leave' ELSE 'rest_day' END AS new_type,
    c.day_type AS old_type,
    c.label AS old_label
  FROM public.tenant_calendar_days c
  JOIN pol p ON p.tenant_id = c.tenant_id
  WHERE c.date BETWEEN DATE '2026-01-01' AND DATE '2026-12-31'
    AND c.source IN ('generated', 'import')
    AND extract(dow FROM c.date)::int IN (p.reg, p.rest)
)
UPDATE public.tenant_calendar_days c
SET day_type = t.new_type,
    source = 'generated',
    label = CASE
      WHEN t.old_type = 'fixed_holiday' AND t.old_label IS NOT NULL
        THEN t.old_label || '（適逢' || CASE WHEN t.new_type = 'regular_leave' THEN '例假' ELSE '休息日' END || '，不另標國定假日）'
      ELSE t.old_label
    END
FROM target t
WHERE c.id = t.id
  AND (
    (t.old_type = 'fixed_holiday' AND c.date IN (DATE '2026-02-28', DATE '2026-04-04', DATE '2026-04-05', DATE '2026-10-10', DATE '2026-10-25'))
    OR (t.old_type IN ('rest_day', 'regular_leave') AND t.old_type <> t.new_type)
  );

-- ── 還原 ────────────────────────────────────────────────────────────
-- B 段沒有自動還原（舊值是錯的）；必要時在後台行事曆頁重新「產生 2026」或手動改。
-- A 段：先把 regular_leave 的列改回 rest_day，才能把 CHECK 改回三值：
-- UPDATE public.tenant_calendar_days SET day_type = 'rest_day' WHERE day_type = 'regular_leave';
-- ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
-- ALTER TABLE public.tenant_calendar_days ADD CONSTRAINT tenant_calendar_days_day_type_chk
--   CHECK (day_type IN ('workday', 'rest_day', 'fixed_holiday'));
