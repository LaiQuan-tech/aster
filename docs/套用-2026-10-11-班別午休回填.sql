-- =====================================================================
-- 亞斯特 — 2026-10-11 正式租戶（0507ad78）班別午休回填（shifts.break_start）
--
-- 背景：業主 10/11 確認午休就是 12:00–13:00，「做滿 8 小時」不含午休（09:00–18:00 剛好 8 小時、
-- 加班 0）。程式的午休規則（@hr/rules lunch-window.ts，前後端同一條）：
--   1. break_start 有值 → [break_start, break_start + break_minutes)
--   2. 沒值，且班別涵蓋 12:00（上班早於 12:00、且 12:00 + 休息不晚於下班）→ [12:00, 12:00 + break_minutes)
--   3. 其他 → 舊推算（工作時數中點起算）；引擎對這類班別維持舊行為（工時固定扣休息分鐘、
--      遲到早退照字面），只有「已核准請假的時段不算遲到早退」會用到推算窗。
--   沒排班的日子不看這張表：用規則參數 attendance.defaultLunch（省略＝12:00 起 60 分）。
--
-- 本檔決定（逐班別）：
--   • 日班 09:00–18:00 休 60 → 設 '12:00'（業主確認）。不設也會由規則 2 得到 12:00–13:00；明設是把
--     業主確認的午休釘在資料上，之後規則或班別時段調整都不會跑掉，班別頁也會顯示「午休 12:00–13:00」
--     而不是「（涵蓋 12:00，預設）」。
--   • 晚到班 10:00–19:00 休 60 → 設 '12:00'【可選，與不設等價】：涵蓋 12:00，規則 2 本來就是
--     12:00–13:00；業主說全公司午休 12:00–13:00，一併明設。不想動可以整段 [2] 拿掉，結算結果相同。
--   • 午班 14:00–22:00 → 不設：不涵蓋 12:00，業主沒說午班的休息／晚餐實際時段。設了會讓引擎對這個班
--     從「固定扣 break_minutes」改成「扣在班區間與該時段的重疊」（只做半天的日子工時會變），屬行為
--     改變，等業主告知（例如晚餐 18:00）再設。
--   • 其他班別一律不動（[0] 會全部列出來，含它們落在哪一條規則）。
--
-- 前提：已套 docs/套用-2026-10-11-會議A批欄位.sql（shifts.break_start＋格式 CHECK）。
-- 套用方式：SQL Editor 或 Supabase Management API query 端點（單一交易）。
-- 冪等：只改 break_start IS NULL 的列，重跑第二次 0 列。
-- 套用後：API 部署完成後再觸發 9、10 月重算（見交接說明：POST /attendance-sheets/generate）。
-- 9、10 月幾乎沒有排班，重算數字主要來自「沒排班＝預設午休 12:00–13:00」，與這份回填無關；
-- 回填影響的是之後排了日班／晚到班的日子（以及班別頁的顯示）。
-- ⚠️ 重算前先跟業主確認：例假日／國定假日「沒排班的加班」要不要也扣 12:00–13:00？目前程式依規格
--   一律扣（休息日 10:23–18:07 加班 450 → 390 分）；6 月 Excel 例假日沒扣。若業主說不扣，程式要先改
--   （settlement 非工作日不套預設午休）再重算。
-- =====================================================================

-- [0] 預覽（先跑）：所有班別與它落在哪一條午休規則（rule 欄）
WITH s AS (
  SELECT id, name, start_time, end_time, break_minutes, break_start, created_at,
         split_part(start_time::text, ':', 1)::int * 60 + split_part(start_time::text, ':', 2)::int AS st,
         split_part(end_time::text, ':', 1)::int * 60 + split_part(end_time::text, ':', 2)::int AS et0
  FROM public.shifts
  WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'
), n AS (
  SELECT *, CASE WHEN et0 <= st THEN et0 + 1440 ELSE et0 END AS et FROM s
)
SELECT id, name, start_time, end_time, break_minutes, break_start,
       CASE
         WHEN break_minutes <= 0 THEN '無午休'
         WHEN break_start IS NOT NULL THEN '規則1 明設 ' || break_start
         WHEN (st < 720 AND 720 + break_minutes <= et) OR (2160 + break_minutes <= et) THEN '規則2 涵蓋 12:00 → 12:00 起'
         ELSE '規則3 舊推算（中點）'
       END AS rule
FROM n
ORDER BY created_at;

BEGIN;

-- [1] 日班 09:00–18:00 休 60 → 午休 12:00（業主確認）
UPDATE public.shifts
   SET break_start = '12:00'
 WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'
   AND break_start IS NULL
   AND left(start_time::text, 5) = '09:00'
   AND left(end_time::text, 5) = '18:00'
   AND break_minutes = 60
RETURNING id, name, start_time, end_time, break_minutes, break_start;

-- [2]【可選】晚到班 10:00–19:00 休 60 → 午休 12:00（與不設等價，見檔頭）
UPDATE public.shifts
   SET break_start = '12:00'
 WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'
   AND break_start IS NULL
   AND left(start_time::text, 5) = '10:00'
   AND left(end_time::text, 5) = '19:00'
   AND break_minutes = 60
RETURNING id, name, start_time, end_time, break_minutes, break_start;

COMMIT;

-- [3] 驗證：日班／晚到班 break_start = '12:00'；午班與其他班別維持 NULL
-- SELECT name, start_time, end_time, break_minutes, break_start
--   FROM public.shifts WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c' ORDER BY created_at;
-- 還原（若要撤回；注意：會連之後在班別頁手動設成 12:00 的這兩種班別一起清掉）：
-- UPDATE public.shifts SET break_start = NULL
--  WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c' AND break_start = '12:00'
--    AND (left(start_time::text,5), left(end_time::text,5)) IN (('09:00','18:00'), ('10:00','19:00'));
