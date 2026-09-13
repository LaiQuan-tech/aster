-- =====================================================================
-- 0023  project_billings 納入禁刪與稽核（模組四第 4 條）
--
-- 分期請款是金流表：`billed_on` / `billed_amount` 記的是已經送出去的
-- 請款。實體刪除一筆已請款的期別，等於讓那筆應收憑空消失，而對帳時
-- 只會看到「合計對不起來」卻查不出哪裡少了。
--
-- 比照 sql/0018 / sql/0019 / sql/0022 的既有做法。
--
-- 套用方式：Supabase SQL Editor。
-- 冪等：DROP IF EXISTS + CREATE，可重複執行。
-- 前提：sql/0018 的 forbid_hard_delete() 與 sql/0019 的 audit_row() 已存在。
-- =====================================================================

DROP TRIGGER IF EXISTS no_hard_delete ON public.project_billings;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.project_billings
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.project_billings;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.project_billings
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── 合法值防呆 ──────────────────────────────────────────────────────
ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_pct_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_pct_chk
  CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100));

-- 人工覆寫必須有理由：偏離期程的金額是談出來的，要留得下痕跡。
ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_override_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_override_chk
  CHECK (override_amount IS NULL OR override_reason IS NOT NULL);

-- 已請款就必須有金額：billed_on 有值而 billed_amount 為空，
-- 對帳時會變成一筆看不見金額的應收。
ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_billed_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_billed_chk
  CHECK (billed_on IS NULL OR billed_amount IS NOT NULL);

-- ── 還原 ────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.project_billings;
-- DROP TRIGGER IF EXISTS audit_all      ON public.project_billings;
-- ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_pct_chk;
-- ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_override_chk;
-- ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_billed_chk;
