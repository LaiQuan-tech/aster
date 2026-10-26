-- =====================================================================
-- 2026-10-26 打卡冪等（migration 0074 ＝ sql/0064）
--
-- 前提：已套到 0072（sql/0062，docs/套用-2026-10-25-員工所屬公司.sql）；
--   若 0073（sql/0063，獎金執行簽核）已存在，請先套 0073 再套本檔。整份可重跑（冪等）。
-- 順序不強制：API 先探測欄位（lib/schema-compat columnsExist）；沒套時 POST /punch 不去重、照常寫入。
-- 用途：員工端打卡逾時（手機鎖螢幕、網路卡住）後重送，同一次打卡不會寫成兩張卡。
-- 驗證：
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='punch_records' AND column_name='client_request_id';  -- 1 列
--   SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='punch_records_client_request_uq';  -- 1 列
-- =====================================================================

ALTER TABLE public.punch_records ADD COLUMN IF NOT EXISTS client_request_id text;
COMMENT ON COLUMN public.punch_records.client_request_id IS '員工端打卡的請求 id（逾時重送沿用同一個；同員工同 id 只會有一筆）；NULL＝舊資料／HR 補登（2026-10-26）';
CREATE UNIQUE INDEX IF NOT EXISTS punch_records_client_request_uq
  ON public.punch_records (tenant_id, employee_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- ── 還原 ────────────────────────────────────────────────────────────
-- API 會探測欄位，直接移除即可（移除後打卡照常、只是不去重）：
-- DROP INDEX IF EXISTS public.punch_records_client_request_uq;
-- ALTER TABLE public.punch_records DROP COLUMN IF EXISTS client_request_id;
