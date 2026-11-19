-- 2026-11-19 季獎金批次發放時的每期款獎金防線（本檔 ＝ sql/0110 ＝ migration 0120；接 0119 ＝ sql/0109）。
--
-- 0119 之後 API payRun 是「先查別批有沒有發過 → 再把批次改 paid」，兩批同時發放可能都查到「沒發過」而重複發同一期；
-- 核准後到發放那一刻之間若有人改了每期分潤，批次會以舊金額發出、該期隨即鎖定，差額永遠帶不進來。
-- 這支 BEFORE UPDATE 觸發器在 bonus_runs 由非 paid 變 paid（一般批次）時、同一交易內：
--   1. 依期別 id 排序取 advisory lock（鍵同 set_billing_bonus_shares_batch：'billing_shares:'||billing_id）——
--      與同一期的分潤寫入、另一批的發放互相排隊；
--   2. 本批帶入的任一（期別、員工）在其他 paid、未刪批次的淨額 ≠ 0 → RAISE BL409（已在別批發放）；
--   3. 本批凍結的金額／發獎金日與目前的每期分潤不一致（核准後被改過）→ RAISE BL409（請重算）。
-- 觸發器函式是 VOLATILE（每個查詢重取快照）：拿到鎖之後看得到剛提交的另一批發放。
-- 沖銷批次（kind='reversal'）不檢查（負數列本來就是對已發的抵銷）。
-- 前提：已套 0119（sql/0109）。只有 DDL（函式＋觸發器），不動任何資料列；可重跑。
CREATE OR REPLACE FUNCTION public.bonus_runs_billing_pay_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bad integer;
BEGIN
  IF NEW.kind = 'reversal' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('billing_shares:' || x.billing_id::text))
     FROM (SELECT DISTINCT i.billing_id FROM public.bonus_run_billing_items i WHERE i.run_id = NEW.id ORDER BY 1) AS x;

  SELECT count(*) INTO v_bad
    FROM public.bonus_run_billing_items i
   WHERE i.run_id = NEW.id
     AND EXISTS (
       SELECT 1
         FROM public.bonus_run_billing_items o
         JOIN public.bonus_runs r ON r.id = o.run_id AND r.status = 'paid' AND r.deleted_at IS NULL
        WHERE o.tenant_id = i.tenant_id AND o.billing_id = i.billing_id AND o.employee_id = i.employee_id AND o.run_id <> NEW.id
       HAVING sum(o.amount) <> 0
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'bonus_runs: billing bonus already paid in another run' USING ERRCODE = 'BL409';
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.bonus_run_billing_items i
   WHERE i.run_id = NEW.id
     AND (
       i.amount IS DISTINCT FROM (SELECT s.amount FROM public.project_billing_shares s
                                   WHERE s.tenant_id = i.tenant_id AND s.billing_id = i.billing_id AND s.employee_id = i.employee_id)
       OR i.bonus_paid_on IS DISTINCT FROM (SELECT d.bonus_paid_on FROM public.project_billing_bonus_dates d
                                             WHERE d.tenant_id = i.tenant_id AND d.billing_id = i.billing_id)
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'bonus_runs: billing bonus changed since approval' USING ERRCODE = 'BL409';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bonus_runs_billing_pay_guard() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.bonus_runs_billing_pay_guard() FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS bonus_runs_billing_pay_guard ON public.bonus_runs;
CREATE TRIGGER bonus_runs_billing_pay_guard
  BEFORE UPDATE OF status ON public.bonus_runs
  FOR EACH ROW
  WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.bonus_runs_billing_pay_guard();
