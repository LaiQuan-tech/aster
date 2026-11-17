-- 2026-11-17 廠商收款帳戶「需經第二人確認才能收款」（本檔 ＝ sql/0094；接 0103 ＝ sql/0093）。
--
-- 驗收（H1／H2）發現「有未付才覆核」可被繞過（先把期款標已付再改帳號；或新建廠商帶帳號再把副委託改綁過去），
-- 改成：名冊任何銀行欄位寫入（新建帶帳號、第一次補、改帳戶）一律建 vendor_bank_change_requests 待覆核，
-- 由老闆／HR／platform_admin（非申請人）核准後才寫入名冊並設 bank_verified_at／bank_verified_by。
-- 放款收款對象為登錄廠商時，送審／核准／付款／直接建成已匯款都要求 bank_verified_at 不為空（API 409 vendor_bank_unverified）。
--
-- 1. vendors.bank_verified_at／bank_verified_by（第二人確認時間／確認人）。
-- 2. 回填（只在本欄位第一次建立時跑一次，重跑不會再把之後新建、未確認的帳號標成已確認）：
--    目前名冊上已有帳號（bank_account 非空白）的廠商 → bank_verified_at = now()、bank_verified_by = NULL
--    （視為既有已確認；業主 2026-11-17 決定）。只動這一欄，不改其他資料。
-- 3. decide_vendor_bank_change：核准時一併寫 bank_verified_at／by；未匯款放款單只擋送簽中／已核准（不擋草稿）。
--    簽名不變（CREATE OR REPLACE）。
-- 前提：已套 0103（sql/0093）。可重跑。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'bank_verified_at'
  ) THEN
    ALTER TABLE public.vendors ADD COLUMN bank_verified_at timestamptz;
    UPDATE public.vendors
       SET bank_verified_at = now()
     WHERE bank_account IS NOT NULL AND btrim(bank_account) <> '';
  END IF;
END $$;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS bank_verified_by uuid REFERENCES public.employees(id);

CREATE OR REPLACE FUNCTION public.decide_vendor_bank_change(
  p_tenant_id uuid,
  p_request_id uuid,
  p_actor_emp_id uuid,
  p_action text,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r public.vendor_bank_change_requests%ROWTYPE;
  v public.vendors%ROWTYPE;
  v_now timestamptz := now();
  v_status text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_action NOT IN ('approve', 'reject', 'cancel') THEN
    RAISE EXCEPTION 'invalid_action' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.vendor_bank_change_requests
   WHERE id = p_request_id AND tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor_bank_change_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'vendor_bank_change_not_pending' USING ERRCODE = '55000';
  END IF;

  IF p_action = 'approve' THEN
    IF p_actor_emp_id IS NULL OR (r.requested_by_emp_id IS NOT NULL AND r.requested_by_emp_id = p_actor_emp_id) THEN
      RAISE EXCEPTION 'vendor_bank_change_self_review' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v FROM public.vendors
     WHERE id = r.vendor_id AND tenant_id = p_tenant_id AND deleted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'vendor_not_found' USING ERRCODE = 'P0002';
    END IF;
    -- 送簽中／已核准的放款單仍硬擋（草稿不擋：送審時既有防線會要求重新帶入名冊帳戶）。
    IF EXISTS (
      SELECT 1 FROM public.disbursements
       WHERE tenant_id = p_tenant_id AND vendor_id = r.vendor_id AND status IN ('pending_approval', 'approved')
    ) THEN
      RAISE EXCEPTION 'vendor_has_open_disbursements' USING ERRCODE = '55000';
    END IF;
    -- 樂觀檢查：申請之後名冊帳戶被別的途徑改過 → stale（請重新申請）。
    IF v.bank_code IS DISTINCT FROM r.old_bank_code
       OR v.bank_name IS DISTINCT FROM r.old_bank_name
       OR v.bank_account IS DISTINCT FROM r.old_bank_account
       OR v.account_holder IS DISTINCT FROM r.old_account_holder THEN
      RAISE EXCEPTION 'vendor_bank_change_stale' USING ERRCODE = '40001';
    END IF;
    UPDATE public.vendors
       SET bank_code = r.new_bank_code,
           bank_name = r.new_bank_name,
           bank_account = r.new_bank_account,
           account_holder = r.new_account_holder,
           bank_changed_at = v_now,
           bank_verified_at = v_now,
           bank_verified_by = p_actor_emp_id,
           updated_at = v_now
     WHERE id = v.id AND tenant_id = p_tenant_id;
    v_status := 'approved';
  ELSIF p_action = 'reject' THEN
    v_status := 'rejected';
  ELSE
    v_status := 'cancelled';
  END IF;

  UPDATE public.vendor_bank_change_requests
     SET status = v_status,
         decided_by_emp_id = p_actor_emp_id,
         decided_at = v_now,
         decision_note = v_note,
         updated_at = v_now
   WHERE id = r.id;

  INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (
    p_tenant_id, 'vendor_bank_change_requests', r.id, 'UPDATE',
    jsonb_build_object(
      'status', r.status, 'vendor_id', r.vendor_id, 'requested_by_emp_id', r.requested_by_emp_id, 'reason', r.reason,
      'bank_code', r.old_bank_code, 'bank_name', r.old_bank_name, 'bank_account', r.old_bank_account, 'account_holder', r.old_account_holder
    ),
    jsonb_build_object(
      'status', v_status, 'vendor_id', r.vendor_id, 'decided_by_emp_id', p_actor_emp_id, 'decision_note', v_note,
      'bank_code', r.new_bank_code, 'bank_name', r.new_bank_name, 'bank_account', r.new_bank_account, 'account_holder', r.new_account_holder,
      'applied', v_status = 'approved'
    ),
    current_user, p_actor_emp_id,
    'decide_vendor_bank_change 廠商收款帳戶變更覆核（' || p_action || '）'
  );

  RETURN jsonb_build_object('id', r.id, 'vendor_id', r.vendor_id, 'status', v_status, 'decided_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.decide_vendor_bank_change(uuid, uuid, uuid, text, text) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.decide_vendor_bank_change(uuid, uuid, uuid, text, text) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.decide_vendor_bank_change(uuid, uuid, uuid, text, text) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
