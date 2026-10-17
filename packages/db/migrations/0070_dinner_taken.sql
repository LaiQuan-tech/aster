-- 2026-10-17 晚餐勾選（一例一休第三段）：規則 overtime.mealBreak.mode='opt_in' 時，只有「當天有用公司晚餐」才扣晚餐分鐘。
--   punch_records.dinner_taken   員工打「下班卡」時勾的「今天有用公司晚餐」（true／false；沒問到＝NULL）。
--   attendance_days.dinner_taken HR／員工在出勤月表手動設定的值（true／false）；NULL＝沒手動設定＝看打卡。
-- 結算（settleAttendance）的當日值：attendance_days.dinner_taken 非 NULL → 用它（月表手動值優先）；
--   否則當天（依配對歸屬的工作日）任一張下班卡 true → true、有 false 沒 true → false、都 NULL → 未填＝不扣。
--   結算 upsert 不帶 dinner_taken 欄位，所以重算不會洗掉月表手動值；當日最終值另記在 attendance_days.anomaly.dinnerTaken 供顯示。
-- 寫入一律經 API（service role）；讀取 policy 不動（新欄位隨既有列級讀取 policy 可讀）；audit trigger 整列 to_jsonb，自動入稽核。
-- 前提：已套到 0069（sql/0059）。可重跑（ADD COLUMN IF NOT EXISTS）。
ALTER TABLE public.punch_records ADD COLUMN IF NOT EXISTS dinner_taken boolean;
ALTER TABLE public.attendance_days ADD COLUMN IF NOT EXISTS dinner_taken boolean;
COMMENT ON COLUMN public.punch_records.dinner_taken IS '下班卡勾選「今天有用公司晚餐」；NULL＝沒問到（2026-10-17）';
COMMENT ON COLUMN public.attendance_days.dinner_taken IS '出勤月表手動設定的晚餐（優先於打卡勾選）；NULL＝沒手動設定（2026-10-17）';
