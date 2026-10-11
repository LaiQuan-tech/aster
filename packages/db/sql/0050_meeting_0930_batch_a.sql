-- 2026-10-11 0930 會議 A 批：合約內容、廠商簡稱、打卡 IP、班別午休開始時間。
-- 前提：已套到 0059（sql/0049）。全部可重跑。
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS content_note text;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS short_name text;
ALTER TABLE public.punch_records ADD COLUMN IF NOT EXISTS ip_address text;
-- 午休開始（HH:MM）。空值＝班別涵蓋 12:00 就用 12:00，否則沿用舊推算（API 端處理）。
ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS break_start text;
DO $$ BEGIN
  ALTER TABLE public.shifts ADD CONSTRAINT shifts_break_start_fmt_chk
    CHECK (break_start IS NULL OR break_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
