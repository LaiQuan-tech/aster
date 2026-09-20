-- =====================================================================
-- 0036  獎金批次紅字沖銷（配合 migration 0048：bonus_runs.kind／reverses_run_id）
--
-- paid 批次是凍結快照（sql/0034 forbid_paid_bonus_mutation），「發錯了」不改原批，
-- 開一批 kind='reversal'：每列金額取負、paid_before 接在原批之後、發放後
-- loadPaidBefore 的加總自動歸零，下一季重算等於原批沒發生過。
-- 這裡補三道 DB 層防線：
--   • kind 合法值
--   • reversal 必有 reverses_run_id、regular 必無（一致性）
--   • reverses_run_id 指向同租戶的 bonus_runs（FK；不 cascade——原批不可刪）
-- 「只能沖銷最新一批 paid」「原批必須是 paid regular」是應用層規則
-- （services/bonus-run-store.ts createReversalRun），DB 不重複驗。
-- 冪等，可重複執行。
-- =====================================================================

ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_kind_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_kind_chk
  CHECK (kind IN ('regular', 'reversal'));

ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_reversal_consistency_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_reversal_consistency_chk
  CHECK ((kind = 'reversal') = (reverses_run_id IS NOT NULL));

DO $$ BEGIN
  ALTER TABLE public.bonus_runs
    ADD CONSTRAINT bonus_runs_reverses_run_id_fk
    FOREIGN KEY (reverses_run_id) REFERENCES public.bonus_runs(id);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

COMMENT ON COLUMN public.bonus_runs.kind IS
  'regular＝季批次；reversal＝紅字沖銷批次（金額取負，發放後使被沖銷批次在累計口徑上歸零）。';
COMMENT ON COLUMN public.bonus_runs.reverses_run_id IS
  'kind=reversal 時指向被沖銷的 paid regular 批次；一批只能被有效沖銷一次（bonus_runs_reverses_uq）。';
