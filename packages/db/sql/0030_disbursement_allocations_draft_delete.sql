-- 0030  放款分攤：草稿可以刪分攤列
--
-- sql/0029 把 disbursement_allocations 掛了通用 no_hard_delete，但草稿（status='draft'）
-- 的分攤本來就允許整批覆蓋（減少列數）；已匯款／作廢的分攤才是證據。
-- 改用專用 trigger：母單非 draft 才擋。冪等。

CREATE OR REPLACE FUNCTION public.forbid_delete_unless_draft_disbursement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM public.disbursements WHERE id = OLD.disbursement_id;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'hard delete forbidden on disbursement_allocations (disbursement % is %)', OLD.disbursement_id, parent_status
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursement_allocations;
DROP TRIGGER IF EXISTS no_hard_delete_unless_draft ON public.disbursement_allocations;
CREATE TRIGGER no_hard_delete_unless_draft
  BEFORE DELETE ON public.disbursement_allocations
  FOR EACH ROW EXECUTE FUNCTION public.forbid_delete_unless_draft_disbursement();
