-- =====================================================================
-- 2026-10-17 一例一休日別（migration 0069 ＝ sql/0059）＋ 修正 2026 行事曆
--
-- 前提：已套到 0068（sql/0058）。整份可重跑（冪等）：第二次執行不會再改任何一列。
-- 套用後跑 docs/驗證-2026-10-17-一例一休日別.sql。
--
-- ⚠️ 部署順序（2026-10-17 驗收修正 S3）：**先部署新版（前端＋API），再套本檔**。
--   • 舊前端的行事曆頁（admin/calendar）只認得 workday／rest_day／fixed_holiday，B 段把週日改成
--     regular_leave 之後，舊前端打開行事曆會壞——所以本檔不能在新前端上線前套。
--   • 新前端在本檔未套前可正常運作：行事曆 API 回的仍是舊值（rest_day），新前端照樣顯示；只有 HR 在格子上
--     點到「例假」存檔會被 CHECK 擋（要等 A 段），套完即可。
--   • 新 API 在本檔未套前也安全：讀到 rest_day 的列照列上的值算（週日仍是休息日，金額與改版前相同）；
--     沒有列的日子（例：2027）依週休設定推導成例假。PUT regular_leave 要等 A 段。
--   • 兩個 Vercel 專案（apps/web、apps/api）push main 會同時部署；push、確認兩邊都上線後再套本檔。
--   套完後：開放中的月份要「重新結算＋重算月表」週日才會變成例假（結算時才寫 attendance_days.day_type）。
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
--   3) **已結算月份不動**（2026-10-17 驗收修正 B2）：period_closes 該租戶該月 status='closed' 的日子跳過——
--      與 API 核准國定假日草稿的 skipClosedPeriods（services/period-lock.ts findClosedPeriods）同一條判斷，
--      已發薪的月份日別不變，薪資單才對得起來。被排除的月份列在驗證檔第 7 條；要改得先在後台重新開放該月。
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
    -- 已結算月份不動（同 period-lock.findClosedPeriods：period_closes.status = 'closed'）
    AND NOT EXISTS (
      SELECT 1 FROM public.period_closes pc
      WHERE pc.tenant_id = c.tenant_id
        AND pc.period = to_char(c.date, 'YYYY-MM')
        AND pc.status = 'closed'
    )
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

-- ── 還原（回滾）────────────────────────────────────────────────────────
-- 2026-10-17 驗收修正 S2。**回滾 API／前端之前**先跑下面 R1（舊 API 不認得 regular_leave：attendance_days／
-- 月表的 regular_leave 會被舊程式當成平日 workday——週日出勤變成「平日加班」、還會被算早退），舊前端的行事曆頁
-- 也會壞。R1–R3 是一組，照順序整段貼上執行（全部冪等）。
--
-- R1. 例假 → 休息日（行事曆、結算結果、月表三張表）
-- UPDATE public.tenant_calendar_days SET day_type = 'rest_day' WHERE day_type = 'regular_leave';
-- UPDATE public.attendance_days       SET day_type = 'rest_day' WHERE day_type = 'regular_leave';
-- UPDATE public.attendance_sheet_days SET day_type = 'rest_day' WHERE day_type = 'regular_leave';
--
-- R2. A 段：CHECK 改回三值（R1 之後才改得動）
-- ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
-- ALTER TABLE public.tenant_calendar_days ADD CONSTRAINT tenant_calendar_days_day_type_chk
--   CHECK (day_type IN ('workday', 'rest_day', 'fixed_holiday'));
--
-- R3. 受影響月份（回滾前先記下來）：R1 只改日別，加班分鐘／月表金額還是例假算法（做 1 給 8 的保底分鐘），
--     **必須重算**：每個列出的未結算月份在後台「重新結算＋重算月表」；已結算（period_closes closed）的月份
--     要先重新開放才能重算，或維持原數字（已發薪）並用下月加減項更正。
-- SELECT DISTINCT tenant_id, to_char(work_date, 'YYYY-MM') AS period FROM public.attendance_days
--   WHERE day_type = 'regular_leave' ORDER BY 1, 2;   -- ← 在 R1 之前跑
--     **已核准月表的快照也要處理**：approved／locked 的月表，薪資執行讀的是快照 attendance_sheets.snapshot
--     的 payrollDays（核准當下凍結），R1 改不到它——快照裡含 regular_leave 的月表要「退回 → 重算 → 再核准」，
--     薪資才會照休息日算（locked 的要先重新開放該月）。下面列出這些月表（同樣在 R1 之前跑）：
-- SELECT tenant_id, employee_id, period, status FROM public.attendance_sheets
--   WHERE status IN ('approved', 'locked')
--     AND jsonb_path_exists(snapshot, '$.payrollDays[*] ? (@.dayType == "regular_leave")')
--   ORDER BY 1, 3, 2;
--
-- B 段的週末國定假日本日修正沒有自動還原（舊值是錯的，同一節日算兩天假）；必要時在後台行事曆頁手動改。
