-- 2026-10-11 發薪後鎖定：period_closes 補「重新開放」紀錄欄位（status 'closed'＝鎖定、'reopened'＝已解鎖）。
-- 解鎖只限老闆與老闆指定的人（features.payroll.periodUnlockEmpIds），必填理由；誰、何時、為何都留存。
-- 前提：已套到 0063（sql/0053）。可重跑。
ALTER TABLE public.period_closes ADD COLUMN IF NOT EXISTS reopened_at timestamptz;
ALTER TABLE public.period_closes ADD COLUMN IF NOT EXISTS reopened_by_emp_id uuid;
ALTER TABLE public.period_closes ADD COLUMN IF NOT EXISTS reopen_reason text;
