-- 2026-10-11 集團總覽：客戶／廠商可標記「關係企業」，集團合計時剔除姊妹公司之間的往來。
-- 前提：已套到 0061（sql/0051）。可重跑。
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_affiliate boolean NOT NULL DEFAULT false;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS is_affiliate boolean NOT NULL DEFAULT false;
