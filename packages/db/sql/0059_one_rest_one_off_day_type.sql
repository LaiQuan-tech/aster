-- 2026-10-17 一例一休日別：tenant_calendar_days.day_type 加入 'regular_leave'（例假）。
--   勞基法第 36 條：每七日中一日例假、一日休息日，兩者出勤的法律效果不同，日別要分開記。
--   值集合對齊 @hr/rules 的 DayType（workday | rest_day | regular_leave | fixed_holiday）。
--   attendance_days.day_type／attendance_sheet_days.day_type 沒有 CHECK（text），不用改。
--   例假／休息日是星期幾放在 tenants.features.attendance.regularLeaveWeekday／restDayWeekday 與
--   employees.features.regularLeaveWeekday／restDayWeekday（jsonb，不需 DDL）。
-- 前提：已套到 0068（sql/0058）。可重跑（DROP CONSTRAINT IF EXISTS 後重建）。
ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
ALTER TABLE public.tenant_calendar_days ADD CONSTRAINT tenant_calendar_days_day_type_chk
  CHECK (day_type IN ('workday', 'rest_day', 'regular_leave', 'fixed_holiday'));
