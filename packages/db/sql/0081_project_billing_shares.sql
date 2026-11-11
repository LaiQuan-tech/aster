-- 2026-11-11 專案申請單「每期款獎金分潤」：付款階段每一期可設定「誰分多少」（多人、每人填金額）＋該期的「發獎金日」。
--   這是**按期另外發**的紀錄，獨立於季獎金（bonus_runs：專案分潤% × 累計入帳，季發）；不寫入月結薪資、也不進季獎金批次。
--   project_billing_shares：一期一人一列（unique(billing_id, employee_id)）；amount ≥ 0（元，未稅口徑同期別金額）。
--   project_billing_bonus_dates：一期一列的發獎金日（billing_id 為 PK）。**不放在 project_billings 上**：
--     project_billings 掛 audit_all，整列（含新欄位）會進稽核，沒有利潤權限的 HR 從稽核看得到；期別也會進申請單版本快照。
--   set_billing_bonus_shares()：寫入的唯一入口（API 以 service role 呼叫）。同一交易內：檢查期別屬於該租戶該專案且未刪、
--     員工屬於該租戶、金額 ≥ 0 不重複 → 整批換掉該期的分潤列＋發獎金日 → 寫一筆**不含金額與人名**的稽核摘要。
--     「分潤合計 ≤ 該期金額」由 API 檢查（期別有效金額要依合約試算，見 apps/api routes/billing-shares.ts）。
--   稽核：分潤金額屬集團財務（同利潤），兩張表**不掛 audit_all**；摘要只記 project_id、billing_id、人數、有無發獎金日、操作者。
-- 前提：已套到 0090（sql/0080）。純新增、可重跑（IF NOT EXISTS／duplicate_object／CREATE OR REPLACE）；不動任何既有表或資料。
-- 只由 API（service role）存取：RLS 開、不給 policy、revoke anon／authenticated；函式 revoke PUBLIC／anon／authenticated，只給 service_role。
CREATE TABLE IF NOT EXISTS public.project_billing_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  billing_id uuid NOT NULL REFERENCES public.project_billings(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  amount numeric NOT NULL,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_billing_shares_billing_emp_uq
  ON public.project_billing_shares (billing_id, employee_id);
CREATE INDEX IF NOT EXISTS project_billing_shares_tenant_project_idx
  ON public.project_billing_shares (tenant_id, project_id);
DO $$ BEGIN
  ALTER TABLE public.project_billing_shares ADD CONSTRAINT project_billing_shares_amount_chk CHECK (amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.project_billing_shares ADD CONSTRAINT project_billing_shares_note_chk
    CHECK (note IS NULL OR char_length(note) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.project_billing_bonus_dates (
  billing_id uuid PRIMARY KEY REFERENCES public.project_billings(id),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  bonus_paid_on date NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_billing_bonus_dates_tenant_project_idx
  ON public.project_billing_bonus_dates (tenant_id, project_id);

ALTER TABLE public.project_billing_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_billing_bonus_dates ENABLE ROW LEVEL SECURITY;
-- 不掛 audit_all（見檔頭「稽核」）；DROP 讓先前若掛過的環境也一致。
DROP TRIGGER IF EXISTS audit_all ON public.project_billing_shares;
DROP TRIGGER IF EXISTS audit_all ON public.project_billing_bonus_dates;
DO $$ BEGIN
  REVOKE ALL ON TABLE public.project_billing_shares FROM anon, authenticated;
  REVOKE ALL ON TABLE public.project_billing_bonus_dates FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT ALL ON TABLE public.project_billing_shares TO service_role;
  GRANT ALL ON TABLE public.project_billing_bonus_dates TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- p_shares：[{"employee_id": uuid, "amount": number, "note": text|null}, …]（空陣列＝清掉該期分潤）；p_bonus_paid_on NULL＝清掉發獎金日。
-- 回傳寫入後的人數。錯誤碼：P0002 期別不存在／不屬此租戶此專案／已刪；22023 參數不合法（員工不屬此租戶、金額負數或非數字、重複員工）。
CREATE OR REPLACE FUNCTION public.set_billing_bonus_shares(
  p_tenant_id uuid,
  p_project_id uuid,
  p_billing_id uuid,
  p_bonus_paid_on date,
  p_shares jsonb,
  p_actor_emp_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer;
  v_bad integer;
BEGIN
  IF p_shares IS NULL OR jsonb_typeof(p_shares) <> 'array' THEN
    RAISE EXCEPTION 'set_billing_bonus_shares: shares must be an array' USING ERRCODE = '22023';
  END IF;
  -- 同一期的分潤寫入排隊（交易結束自動釋放）。
  PERFORM pg_advisory_xact_lock(hashtext('billing_shares:' || p_billing_id::text));
  IF NOT EXISTS (
    SELECT 1 FROM public.project_billings
     WHERE id = p_billing_id AND tenant_id = p_tenant_id AND project_id = p_project_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'set_billing_bonus_shares: billing not found' USING ERRCODE = 'P0002';
  END IF;

  -- 每一列：employee_id 是 uuid、amount 是 ≥ 0 的數字。
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_shares) AS s(v)
   WHERE CASE
           WHEN jsonb_typeof(s.v) IS DISTINCT FROM 'object' THEN true
           WHEN jsonb_typeof(s.v -> 'amount') IS DISTINCT FROM 'number' THEN true
           WHEN (s.v ->> 'amount')::numeric < 0 THEN true
           WHEN (s.v ->> 'employee_id') IS NULL THEN true
           ELSE (s.v ->> 'employee_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         END;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares: invalid share row' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) - count(DISTINCT (s.v ->> 'employee_id')::uuid) INTO v_bad FROM jsonb_array_elements(p_shares) AS s(v);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares: duplicate employee' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_shares) AS s(v)
   WHERE NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = (s.v ->> 'employee_id')::uuid AND e.tenant_id = p_tenant_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares: employee not in tenant' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.project_billing_shares WHERE tenant_id = p_tenant_id AND billing_id = p_billing_id;
  INSERT INTO public.project_billing_shares (tenant_id, project_id, billing_id, employee_id, amount, note, created_by, created_at, updated_at)
  SELECT p_tenant_id, p_project_id, p_billing_id, (s.v ->> 'employee_id')::uuid, (s.v ->> 'amount')::numeric,
         nullif(btrim(coalesce(s.v ->> 'note', '')), ''), p_actor_emp_id, v_now, v_now
    FROM jsonb_array_elements(p_shares) AS s(v);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_bonus_paid_on IS NULL THEN
    DELETE FROM public.project_billing_bonus_dates WHERE tenant_id = p_tenant_id AND billing_id = p_billing_id;
  ELSE
    INSERT INTO public.project_billing_bonus_dates (billing_id, tenant_id, project_id, bonus_paid_on, created_by, created_at, updated_at)
    VALUES (p_billing_id, p_tenant_id, p_project_id, p_bonus_paid_on, p_actor_emp_id, v_now, v_now)
    ON CONFLICT (billing_id) DO UPDATE SET bonus_paid_on = EXCLUDED.bonus_paid_on, updated_at = v_now;
  END IF;

  -- 稽核摘要：不含金額、人名、日期（分潤屬集團財務，HR 看得到稽核）。
  INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (p_tenant_id, 'project_billing_shares', p_billing_id, 'UPDATE', NULL,
          jsonb_build_object('project_id', p_project_id, 'billing_id', p_billing_id, 'people', v_count,
                             'has_bonus_paid_on', p_bonus_paid_on IS NOT NULL),
          current_user, p_actor_emp_id, 'set_billing_bonus_shares');
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
