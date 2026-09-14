-- =====================================================================
-- 0026  tenant_calendar_days：RLS + 合法值防呆（亞斯特 P0 出勤基礎建設）
--
-- 欄位本身由 drizzle migration 0038 建立。本檔放 drizzle 管不了的兩件事，
-- 比照 sql/0021（CHECK）與 sql/0024（API 專用表 RLS）的既有做法。
--
-- ── RLS：比照 0024，ENABLE 但不給 policy ──────────────────────────────
-- 前端從不直接讀表（apps/web 沒有任何 .from()），所有讀寫都經 API 的
-- service_role（bypass RLS）。這張表沒有比照 punch_records／leave_types
-- 開放 policy，是因為它目前只有後台（HR）維護行事曆，员工端不需要直讀；
-- 日後若要讓 ESS 直接查詢當天是否放假，再依 0002 的模式補 policy。
--
-- ── 不掛禁刪／稽核 trigger（比照 sql/0018/0019 的排除邏輯）────────────
-- 行事曆是可重建的參考資料（政府公告、公司規則），改錯直接改回正確值即可，
-- 不像金流/合約需要留下「誰在何時改了什麼」的稽核軌跡。
--
-- ── day_type 合法值防呆 ────────────────────────────────────────────
-- 與 sql/0021 的 projects_status_chk 同一套理由：這裡沒有既有資料要轉換
-- （全新表），CHECK 可以直接加，不需要像 0021 那樣等資料轉換先跑完。
-- 值集合對齊 worktime 引擎的 DayType（packages/rules），刻意寫死不做成
-- 設定表：一旦可自訂，引擎的結算邏輯要跟著可設定，不在 P0 範圍。
--
-- 冪等，可重複執行。
-- =====================================================================

ALTER TABLE public.tenant_calendar_days ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
ALTER TABLE public.tenant_calendar_days ADD CONSTRAINT tenant_calendar_days_day_type_chk
  CHECK (day_type IN ('workday', 'rest_day', 'fixed_holiday'));

-- ── 驗證：見 docs/驗證-2026-09-14-P0.sql ────────────────────────────

-- ── 還原 ────────────────────────────────────────────────────────────
-- ALTER TABLE public.tenant_calendar_days DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
