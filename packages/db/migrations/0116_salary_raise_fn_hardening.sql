-- 2026-11-17 調薪中第三輪驗收（本檔 ＝ sql/0106；接 0115 ＝ sql/0105）。
--
--   1. salary_raises.prev_hourly_wage：調薪完成時的舊時薪快照（完成後重算「起始月之前」的月份要整組還原舊值：
--      本薪、時薪、勞健保、勞退；API services/salary-raises.ts）。
--   2. complete_salary_raise 重建（簽名改變 → 先 DROP 舊版）：
--      • 完成月份上界：start_period ≤ 完成月 ≤ 租戶當月（tenants.timezone）；租戶當月 < 起始月 → raise_not_effective_yet
--      • 時薪改在鎖內算：月薪制明示時薪若是舊本薪 ÷ 除數（四捨五入到 0–4 位小數任一相等）→ 改成新本薪 ÷ 除數；否則議定時薪不動
--      • 實際套用的投保值寫回 new_*（與薪資結構一致）；舊時薪寫 prev_hourly_wage
--      • p_actor_emp_id 必須屬於同租戶
--   3. start_salary_raise：開始調薪中改成 DB 函式——同員工 advisory lock 後檢查（已有調薪中、與已完成調薪重疊、月薪制、本薪）＋insert＋稽核。
-- 錯誤（RAISE 訊息即錯誤碼）：salary_raise_not_found（P0002）、salary_raise_not_pending（55000）、raise_not_effective_yet（55000）、
--   invalid_completed_period（22023）、insured_required（22023）、salary_structure_missing（P0002）、actor_not_in_tenant（42501）、
--   raise_already_pending（23505）、raise_overlaps_completed（55000）、monthly_only（22023）、base_salary_missing（55000）、same_base_salary（22023）。
-- SECURITY DEFINER、search_path 固定、只給 service_role。可重跑；不動任何資料列。
ALTER TABLE public.salary_raises ADD COLUMN IF NOT EXISTS prev_hourly_wage numeric;

-- 月薪制明示時薪是不是「本薪 ÷ 除數」的換算值（完全相等，或四捨五入到 0–4 位任一相等）。內部用。
CREATE OR REPLACE FUNCTION public.salary_hourly_is_derived(p_hourly numeric, p_base numeric, p_divisor numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_hourly IS NOT NULL AND p_hourly > 0 AND p_base IS NOT NULL AND p_base > 0 AND p_divisor IS NOT NULL AND p_divisor > 0
     AND (p_base / p_divisor = p_hourly
          OR EXISTS (SELECT 1 FROM generate_series(0, 4) k WHERE round(p_base / p_divisor, k) = p_hourly));
$$;
REVOKE ALL ON FUNCTION public.salary_hourly_is_derived(numeric, numeric, numeric) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.salary_hourly_is_derived(numeric, numeric, numeric) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.salary_hourly_is_derived(numeric, numeric, numeric) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP FUNCTION IF EXISTS public.complete_salary_raise(uuid, uuid, uuid, uuid, text, integer, integer, integer, numeric, text, text);

CREATE OR REPLACE FUNCTION public.complete_salary_raise(
  p_tenant_id uuid,
  p_employee_id uuid,
  p_raise_id uuid,
  p_actor_emp_id uuid,
  p_completed_period text,
  p_labor integer,
  p_health integer,
  p_pension integer,
  p_divisor numeric,
  p_reason text,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r public.salary_raises%ROWTYPE;
  s public.salary_structures%ROWTYPE;
  v_now timestamptz := now();
  v_current text;
  v_prev_pension integer;
  v_next_pension integer;
  v_hourly numeric;
  v_hourly_kept boolean := false;
  v_adj_id uuid;
  v_ins_id uuid;
BEGIN
  IF p_completed_period IS NULL OR p_completed_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'invalid_completed_period' USING ERRCODE = '22023';
  END IF;
  IF p_labor IS NULL OR p_health IS NULL OR p_labor < 0 OR p_health < 0 THEN
    RAISE EXCEPTION 'insured_required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_emp_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employees WHERE id = p_actor_emp_id AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'actor_not_in_tenant' USING ERRCODE = '42501';
  END IF;
  SELECT to_char(v_now AT TIME ZONE coalesce(nullif(t.timezone, ''), 'Asia/Taipei'), 'YYYY-MM') INTO v_current
    FROM public.tenants t WHERE t.id = p_tenant_id;
  IF v_current IS NULL THEN
    v_current := to_char(v_now AT TIME ZONE 'Asia/Taipei', 'YYYY-MM');
  END IF;

  SELECT * INTO r FROM public.salary_raises
   WHERE id = p_raise_id AND tenant_id = p_tenant_id AND employee_id = p_employee_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary_raise_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'salary_raise_not_pending' USING ERRCODE = '55000';
  END IF;
  IF v_current < r.start_period THEN
    RAISE EXCEPTION 'raise_not_effective_yet' USING ERRCODE = '55000';
  END IF;
  IF p_completed_period < r.start_period OR p_completed_period > v_current THEN
    RAISE EXCEPTION 'invalid_completed_period' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO s FROM public.salary_structures
   WHERE tenant_id = p_tenant_id AND employee_id = p_employee_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary_structure_missing' USING ERRCODE = 'P0002';
  END IF;

  v_prev_pension := s.pension_wage;
  v_next_pension := coalesce(p_pension, s.pension_wage);
  -- 時薪（鎖內）：月薪制明示時薪是舊本薪的換算值 → 新本薪 ÷ 除數；議定時薪不動；沒明示 → 不動。
  v_hourly := s.hourly_wage;
  IF coalesce(s.method, 'monthly') = 'monthly' AND s.hourly_wage IS NOT NULL AND s.hourly_wage > 0 THEN
    IF public.salary_hourly_is_derived(s.hourly_wage, s.base_salary, coalesce(nullif(p_divisor, 0), 240)) THEN
      v_hourly := round(r.new_base_salary / coalesce(nullif(p_divisor, 0), 240), 4);
    ELSE
      v_hourly_kept := true;
    END IF;
  END IF;

  UPDATE public.salary_structures
     SET base_salary = r.new_base_salary,
         labor_insured_salary = p_labor,
         health_insured_salary = p_health,
         pension_wage = v_next_pension,
         hourly_wage = v_hourly
   WHERE id = s.id;

  IF s.base_salary IS DISTINCT FROM r.new_base_salary THEN
    INSERT INTO public.salary_adjustments (tenant_id, employee_id, effective_date, new_salary, prev_salary, reason, changed_by_emp_id)
    VALUES (p_tenant_id, p_employee_id, r.effective_on, r.new_base_salary, s.base_salary, nullif(btrim(coalesce(p_reason, '')), ''), p_actor_emp_id)
    RETURNING id INTO v_adj_id;
  END IF;

  IF s.labor_insured_salary IS DISTINCT FROM p_labor::numeric
     OR s.health_insured_salary IS DISTINCT FROM p_health::numeric
     OR v_prev_pension IS DISTINCT FROM v_next_pension THEN
    INSERT INTO public.insured_salary_changes (
      tenant_id, employee_id, effective_on,
      labor_insured_salary, health_insured_salary, pension_wage,
      prev_labor_insured_salary, prev_health_insured_salary, prev_pension_wage,
      note, created_by_emp_id
    ) VALUES (
      p_tenant_id, p_employee_id, r.effective_on,
      p_labor, p_health, v_next_pension,
      round(s.labor_insured_salary)::integer, round(s.health_insured_salary)::integer, v_prev_pension,
      nullif(btrim(coalesce(p_note, '')), ''), p_actor_emp_id
    ) RETURNING id INTO v_ins_id;
  END IF;

  UPDATE public.salary_raises
     SET status = 'completed',
         completed_period = p_completed_period,
         completed_at = v_now,
         completed_by_emp_id = p_actor_emp_id,
         prev_base_salary = s.base_salary,
         prev_hourly_wage = s.hourly_wage,
         prev_labor_insured_salary = round(s.labor_insured_salary)::integer,
         prev_health_insured_salary = round(s.health_insured_salary)::integer,
         prev_pension_wage = v_prev_pension,
         new_labor_insured_salary = p_labor,
         new_health_insured_salary = p_health,
         new_pension_wage = CASE WHEN p_pension IS NOT NULL THEN p_pension ELSE r.new_pension_wage END,
         updated_at = v_now
   WHERE id = r.id;

  INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (
    p_tenant_id, 'salary_structures', s.id, 'UPDATE',
    jsonb_build_object('base_salary', s.base_salary, 'labor_insured_salary', s.labor_insured_salary,
      'health_insured_salary', s.health_insured_salary, 'pension_wage', v_prev_pension, 'hourly_wage', s.hourly_wage),
    jsonb_build_object('base_salary', r.new_base_salary, 'labor_insured_salary', p_labor, 'health_insured_salary', p_health,
      'pension_wage', v_next_pension, 'hourly_wage', v_hourly,
      'salary_raise_id', r.id, 'completed_period', p_completed_period),
    current_user, p_actor_emp_id,
    'complete_salary_raise 調薪完成（調薪中 ' || r.start_period || ' 起，' || p_completed_period || ' 起套用新本薪／新投保）'
  );

  RETURN jsonb_build_object(
    'id', r.id, 'status', 'completed', 'completed_period', p_completed_period, 'completed_at', v_now,
    'salary_adjustment_id', v_adj_id, 'insured_change_id', v_ins_id,
    'hourly_kept', v_hourly_kept, 'hourly_wage', v_hourly
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_salary_raise(uuid, uuid, uuid, uuid, text, integer, integer, integer, numeric, text, text) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.complete_salary_raise(uuid, uuid, uuid, uuid, text, integer, integer, integer, numeric, text, text) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.complete_salary_raise(uuid, uuid, uuid, uuid, text, integer, integer, integer, numeric, text, text) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.start_salary_raise(
  p_tenant_id uuid,
  p_employee_id uuid,
  p_actor_emp_id uuid,
  p_effective_on date,
  p_new_base numeric,
  p_new_labor integer,
  p_new_health integer,
  p_new_pension integer,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.salary_structures%ROWTYPE;
  v_start text := to_char(p_effective_on, 'YYYY-MM');
  v_last_done text;
  v_id uuid;
BEGIN
  IF p_actor_emp_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employees WHERE id = p_actor_emp_id AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'actor_not_in_tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee_id AND tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- 同員工序列化：檢查與 insert 之間不會有另一筆插進來。
  PERFORM pg_advisory_xact_lock(hashtextextended('salary_raise:' || p_tenant_id::text || ':' || p_employee_id::text, 0));

  SELECT * INTO s FROM public.salary_structures
   WHERE tenant_id = p_tenant_id AND employee_id = p_employee_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary_structure_missing' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(s.method, 'monthly') <> 'monthly' THEN
    RAISE EXCEPTION 'monthly_only' USING ERRCODE = '22023';
  END IF;
  IF s.base_salary IS NULL OR s.base_salary <= 0 THEN
    RAISE EXCEPTION 'base_salary_missing' USING ERRCODE = '55000';
  END IF;
  IF p_new_base IS NULL OR p_new_base <= 0 OR round(p_new_base, 2) = round(s.base_salary, 2) THEN
    RAISE EXCEPTION 'same_base_salary' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.salary_raises WHERE tenant_id = p_tenant_id AND employee_id = p_employee_id AND status = 'pending') THEN
    RAISE EXCEPTION 'raise_already_pending' USING ERRCODE = '23505';
  END IF;
  SELECT max(completed_period) INTO v_last_done FROM public.salary_raises
   WHERE tenant_id = p_tenant_id AND employee_id = p_employee_id AND status = 'completed';
  IF v_last_done IS NOT NULL AND v_start < v_last_done THEN
    RAISE EXCEPTION 'raise_overlaps_completed' USING ERRCODE = '55000', DETAIL = v_last_done;
  END IF;

  INSERT INTO public.salary_raises (
    tenant_id, employee_id, status, effective_on, start_period,
    new_base_salary, new_labor_insured_salary, new_health_insured_salary, new_pension_wage,
    prev_base_salary, prev_hourly_wage, prev_labor_insured_salary, prev_health_insured_salary, prev_pension_wage,
    note, created_by_emp_id
  ) VALUES (
    p_tenant_id, p_employee_id, 'pending', p_effective_on, v_start,
    p_new_base, p_new_labor, p_new_health, p_new_pension,
    s.base_salary, s.hourly_wage, round(s.labor_insured_salary)::integer, round(s.health_insured_salary)::integer, s.pension_wage,
    nullif(btrim(coalesce(p_note, '')), ''), p_actor_emp_id
  ) RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (
    p_tenant_id, 'salary_raises', v_id, 'INSERT', NULL,
    jsonb_build_object('employee_id', p_employee_id, 'status', 'pending', 'effective_on', p_effective_on, 'start_period', v_start,
      'new_base_salary', p_new_base, 'prev_base_salary', s.base_salary,
      'new_labor_insured_salary', p_new_labor, 'new_health_insured_salary', p_new_health, 'new_pension_wage', p_new_pension),
    current_user, p_actor_emp_id,
    'start_salary_raise 標記調薪中'
  );

  RETURN jsonb_build_object('id', v_id, 'status', 'pending', 'start_period', v_start);
END;
$$;

REVOKE ALL ON FUNCTION public.start_salary_raise(uuid, uuid, uuid, date, numeric, integer, integer, integer, text) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.start_salary_raise(uuid, uuid, uuid, date, numeric, integer, integer, integer, text) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.start_salary_raise(uuid, uuid, uuid, date, numeric, integer, integer, integer, text) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
