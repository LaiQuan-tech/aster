-- 2026-11-08 加班費時薪基數含固定津貼：每筆固定津貼加「計入加班費基數」旗標（預設 true；既有列一律 true）。
-- 月薪制的加班類給付（加班費、夜間加給）時薪 = (本薪 + 當月有效且計入的固定津貼) ÷ 240；請假扣款基數不變。
-- 前提：已套到 0086（sql/0076）。純新增、可重跑（ADD COLUMN IF NOT EXISTS）；不改既有資料以外的任何東西。
ALTER TABLE public.employee_fixed_allowances ADD COLUMN IF NOT EXISTS overtime_base boolean NOT NULL DEFAULT true;
