-- 2026-10-13 員工個人設定：個人預設班別、個人功能開關、在家上班打卡。
--   employees.default_shift_id  個人預設班別（工作日沒有 schedules 列時用它判遲到／應下班／缺卡；NULL＝依公司規則＝彈性上班）。
--                               班別被刪 → 自動清成 NULL（回到公司規則），不擋刪班別。
--   employees.features          個人功能開關 jsonb（目前只用 {"wfhPunch": true}＝員工端可勾「在家上班」打卡）。
--   punch_records.wfh           這筆打卡是在家上班（月表該日標「在家工作」，工時照打卡算）。
-- 寫入一律經 API（service role，不受 RLS／欄位權限影響；0066／0067 已收掉 HR 直連寫入，這裡不加任何寫入 policy）。
-- 讀取 policy 不動：新欄位隨既有的列級讀取 policy 一起可讀。audit trigger 是整列 to_jsonb，新欄位自動入稽核。
-- 前提：已套到 0067（sql/0057）。可重跑（ADD COLUMN IF NOT EXISTS／CHECK 重複即略過）。
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS default_shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL;
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE public.employees ADD CONSTRAINT employees_features_object_chk CHECK (jsonb_typeof(features) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS employees_default_shift_idx ON public.employees (default_shift_id) WHERE default_shift_id IS NOT NULL;
ALTER TABLE public.punch_records
  ADD COLUMN IF NOT EXISTS wfh boolean NOT NULL DEFAULT false;
