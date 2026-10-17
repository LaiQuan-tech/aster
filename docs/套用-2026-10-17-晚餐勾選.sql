-- =====================================================================
-- 2026-10-17 晚餐勾選（migration 0070 ＝ sql/0060）
--
-- 前提：已套到 0069（sql/0059，docs/套用-2026-10-17-一例一休日別.sql）。整份可重跑（冪等）。
-- 套用後跑 docs/驗證-2026-10-17-晚餐勾選.sql。
-- 順序：先套本檔、再部署 API。API 對兩個欄位都先探測（lib/schema-compat columnsExist）：沒套時打卡照常寫、
--   結算當作沒勾（opt_in 規則＝不扣晚餐），月表的「晚餐」切換回 503 dinner_not_migrated。
-- 規則：overtime.mealBreak.mode='opt_in'（系統預設、新租戶）時只有當天有用公司晚餐才扣 deductMinutes（預設 60）；
--   已存過規則的租戶仍是原本的 mode（沒帶 mode＝auto，照舊自動扣），要改在後台「規則」頁的加班參數卡。
-- =====================================================================

-- punch_records.dinner_taken：員工打「下班卡」時勾的「今天有用公司晚餐」（true／false；沒問到＝NULL）。
-- attendance_days.dinner_taken：HR／員工在出勤月表手動設定的晚餐；NULL＝沒手動設定＝看下班卡。
-- 結算當日值：月表手動值優先 → 否則當天（依配對歸屬的工作日）任一張下班卡 true → true、有 false 沒 true → false、
--   都 NULL → 未填＝不扣。結算 upsert 不帶 dinner_taken（重算不會洗掉月表手動值），最終值另記在
--   attendance_days.anomaly.dinnerTaken／dinnerSource 供月表顯示。
-- 寫入一律經 API（service role）；讀取 policy 不動；audit trigger 整列 to_jsonb，新欄位自動入稽核。
ALTER TABLE public.punch_records ADD COLUMN IF NOT EXISTS dinner_taken boolean;
ALTER TABLE public.attendance_days ADD COLUMN IF NOT EXISTS dinner_taken boolean;
COMMENT ON COLUMN public.punch_records.dinner_taken IS '下班卡勾選「今天有用公司晚餐」；NULL＝沒問到（2026-10-17）';
COMMENT ON COLUMN public.attendance_days.dinner_taken IS '出勤月表手動設定的晚餐（優先於打卡勾選）；NULL＝沒手動設定（2026-10-17）';

-- ── 還原 ────────────────────────────────────────────────────────────
-- 先部署回不讀這兩欄的 API（或確認已部署的 API 會探測欄位），再：
-- ALTER TABLE public.attendance_days DROP COLUMN IF EXISTS dinner_taken;
-- ALTER TABLE public.punch_records DROP COLUMN IF EXISTS dinner_taken;
