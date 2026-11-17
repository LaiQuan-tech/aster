-- 2026-11-17 廠商收款帳戶變更雙人覆核＋核准人看得到收款帳號（本檔 ＝ sql/0093；接 0102 ＝ sql/0092）。
--
-- 業主決定（2026-11-17）：
-- 1. vendors.bank_changed_at：名冊收款帳戶（代碼／銀行名／帳號／戶名）最後一次變更時間。由 API 改帳戶（直接改或覆核核准）寫入；
--    核准放款的畫面據此顯示「此廠商收款帳戶於 YYYY/MM/DD 變更過」（30 天內）。既有列為 NULL（不回填）。
-- 2. vendor_bank_change_requests：廠商仍有未付款項時，名冊改帳戶不直接生效，改建一筆「帳戶變更待覆核」；
--    由在職的老闆／HR／platform_admin（且不是申請人本人）核准後才套用到 vendors。同一廠商同時只能有一筆 pending。
-- 3. decide_vendor_bank_change()：核准／退回／取消的唯一入口（API 以 service role 呼叫），同一交易內：
--    鎖申請列與廠商列 → 檢查狀態、申請人不得核准自己的申請、核准時廠商仍無未匯款放款單、
--    廠商現值仍等於申請時的舊值（否則 stale）→ 套用＋寫稽核。
--
-- 只由 API（service role）存取：RLS 開、不給 policy、revoke anon／authenticated；函式 revoke PUBLIC／anon／authenticated，只給 service_role。
-- 純新增、可重跑（IF NOT EXISTS／duplicate_object／CREATE OR REPLACE）；不動任何既有資料列。

ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS bank_changed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.vendor_bank_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  vendor_id uuid NOT NULL REFERENCES public.vendors(id),
  requested_by_emp_id uuid REFERENCES public.employees(id),
  old_bank_code text,
  old_bank_name text,
  old_bank_account text,
  old_account_holder text,
  new_bank_code text,
  new_bank_name text,
  new_bank_account text,
  new_account_holder text,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  decided_by_emp_id uuid REFERENCES public.employees(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.vendor_bank_change_requests ADD CONSTRAINT vendor_bank_change_requests_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.vendor_bank_change_requests ADD CONSTRAINT vendor_bank_change_requests_text_chk
    CHECK ((reason IS NULL OR char_length(reason) <= 500) AND (decision_note IS NULL OR char_length(decision_note) <= 500));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 同一廠商同時只能有一筆待覆核。
CREATE UNIQUE INDEX IF NOT EXISTS vendor_bank_change_requests_one_pending_uq
  ON public.vendor_bank_change_requests (tenant_id, vendor_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS vendor_bank_change_requests_tenant_status_idx
  ON public.vendor_bank_change_requests (tenant_id, status, created_at DESC);

ALTER TABLE public.vendor_bank_change_requests ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON TABLE public.vendor_bank_change_requests FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT ALL ON TABLE public.vendor_bank_change_requests TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
-- 留痕：比照 vendors（sql/0025）掛 audit_all（audit_row() 不存在的環境略過）。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'audit_row') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS audit_all ON public.vendor_bank_change_requests';
    EXECUTE 'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.vendor_bank_change_requests FOR EACH ROW EXECUTE FUNCTION public.audit_row()';
  END IF;
END $$;

-- p_action：'approve' | 'reject' | 'cancel'。誰能做（覆核者／申請人）由 API 判斷；這裡只保證交易與不變式。
-- 錯誤（RAISE 訊息即錯誤碼）：vendor_bank_change_not_found（P0002）、vendor_bank_change_not_pending（55000）、
-- vendor_bank_change_self_review（42501）、vendor_not_found（P0002）、vendor_has_open_disbursements（55000）、
-- vendor_bank_change_stale（40001）、invalid_action（22023）。
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
    -- 未匯款的放款單仍硬擋（同名冊直接改帳戶的規則）。
    IF EXISTS (
      SELECT 1 FROM public.disbursements
       WHERE tenant_id = p_tenant_id AND vendor_id = r.vendor_id AND status IN ('draft', 'pending_approval', 'approved')
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
