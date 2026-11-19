-- 2026-11-19 每期款獎金帶入列的寫入防線（本檔 ＝ sql/0111 ＝ migration 0121；接 0120 ＝ sql/0110）。
--
-- 驗收追加：
--   1. bonus_run_billing_items 加 BEFORE INSERT OR UPDATE 觸發器：以 NEW.run_id 查母批次，status='paid' 即擋
--      （ERRCODE restrict_violation／23001，同 forbid_paid_bonus_mutation；test／demo 租戶 is_disposable_tenant 放行）。
--      0119 掛的 forbid_paid_bonus_mutation 只看 OLD（UPDATE／DELETE 已發的列）；這支補上「新增到已發批次」與
--      「UPDATE 把 run_id 改指向已發批次」。
--   2. replace_bonus_run_billing_items()：整批換掉某批次的帶入列改走 DB 函式——同一交易內先刪後插（全成全敗），
--      鎖順序同發放（bonus_runs_billing_pay_guard：先鎖批次列、再依期別 id 排序取 'billing_shares:'||billing_id
--      advisory lock，含舊列與新列的期別），與同一期的分潤寫入、另一批的發放互相排隊。批次不存在／已刪／不屬此租戶
--      → P0002；已發 → 23001。只給 service_role、security definer、search_path 固定。
-- 前提：已套 0120（sql/0110）。只有 DDL，不動任何資料列；可重跑。

CREATE OR REPLACE FUNCTION public.bonus_run_billing_items_paid_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_tenant uuid;
BEGIN
  SELECT r.status, r.tenant_id INTO v_status, v_tenant FROM public.bonus_runs r WHERE r.id = NEW.run_id;
  IF v_status IS DISTINCT FROM 'paid' THEN
    RETURN NEW;
  END IF;
  IF public.is_disposable_tenant(v_tenant) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'bonus_run_billing_items 所屬批次已發放（paid），不可 %——發放批次是凍結快照（見 migration 0121）。', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.bonus_run_billing_items_paid_guard() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.bonus_run_billing_items_paid_guard() FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS bonus_run_billing_items_paid_guard ON public.bonus_run_billing_items;
CREATE TRIGGER bonus_run_billing_items_paid_guard
  BEFORE INSERT OR UPDATE ON public.bonus_run_billing_items
  FOR EACH ROW EXECUTE FUNCTION public.bonus_run_billing_items_paid_guard();

-- p_items：[{"billing_id","project_id","employee_id","amount": number,"bonus_paid_on": "YYYY-MM-DD"|null,"snapshot": object|null}, …]
-- （空陣列＝清掉該批全部帶入列）。回傳寫入列數。
CREATE OR REPLACE FUNCTION public.replace_bonus_run_billing_items(
  p_tenant_id uuid,
  p_run_id uuid,
  p_items jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_count integer;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'replace_bonus_run_billing_items: items must be an array' USING ERRCODE = '22023';
  END IF;
  -- 鎖順序同發放：先鎖批次列，再取期別 advisory lock。
  SELECT r.status INTO v_status
    FROM public.bonus_runs r
   WHERE r.id = p_run_id AND r.tenant_id = p_tenant_id AND r.deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'replace_bonus_run_billing_items: run not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'paid' AND NOT public.is_disposable_tenant(p_tenant_id) THEN
    RAISE EXCEPTION 'replace_bonus_run_billing_items: run already paid' USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('billing_shares:' || x.id::text))
     FROM (
       SELECT b.billing_id AS id FROM public.bonus_run_billing_items b WHERE b.run_id = p_run_id
       UNION
       SELECT (i.v ->> 'billing_id')::uuid FROM jsonb_array_elements(p_items) AS i(v)
       ORDER BY 1
     ) AS x;

  DELETE FROM public.bonus_run_billing_items WHERE tenant_id = p_tenant_id AND run_id = p_run_id;
  INSERT INTO public.bonus_run_billing_items (tenant_id, run_id, project_id, billing_id, employee_id, amount, bonus_paid_on, snapshot)
  SELECT p_tenant_id, p_run_id, (i.v ->> 'project_id')::uuid, (i.v ->> 'billing_id')::uuid, (i.v ->> 'employee_id')::uuid,
         (i.v ->> 'amount')::numeric,
         CASE WHEN jsonb_typeof(i.v -> 'bonus_paid_on') = 'string' THEN (i.v ->> 'bonus_paid_on')::date END,
         CASE WHEN jsonb_typeof(i.v -> 'snapshot') = 'object' THEN i.v -> 'snapshot' END
    FROM jsonb_array_elements(p_items) AS i(v);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_bonus_run_billing_items(uuid, uuid, jsonb) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.replace_bonus_run_billing_items(uuid, uuid, jsonb) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.replace_bonus_run_billing_items(uuid, uuid, jsonb) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
