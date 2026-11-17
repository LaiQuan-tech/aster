-- 2026-11-17 「調薪完成」改成單一 DB 函式（本檔 ＝ migrations/0115；接 sql/0104）。
--
-- 驗收：原本 API 分多步（改狀態 → 改薪資結構 → 寫歷程），中途失敗會留下半套狀態。改成同一交易：
--   1. 鎖 salary_raises 列（FOR UPDATE，限本租戶＋本員工，status 必須 pending）
--   2. 鎖 salary_structures 列，取完成當下的舊值寫進 prev_* 快照
--   3. 更新 salary_structures（新本薪、新勞健保投保；勞退／時薪有給才改）
--   4. 本薪有變寫 salary_adjustments、投保有變寫 insured_salary_changes（生效日＝調薪生效日）
--   5. salary_raises → completed（completed_period／completed_at／completed_by_emp_id／prev_*；new_* 只補原本空著的，不覆寫）
--   6. 寫 audit_logs
-- 任何一步失敗整筆回滾。誰能做（HR／platform_admin）、完成月份是否已到生效月由 API 判斷；這裡保證交易與不變式。
-- 錯誤（RAISE 訊息即錯誤碼）：salary_raise_not_found（P0002）、salary_raise_not_pending（55000）、
--   invalid_completed_period（22023）、insured_required（22023）、salary_structure_missing（P0002）。
-- SECURITY DEFINER、search_path 固定、只給 service_role。純 DDL、可重跑；不動任何資料列。
CREATE OR REPLACE FUNCTION public.complete_salary_raise(
  p_tenant_id uuid,
  p_employee_id uuid,
  p_raise_id uuid,
  p_actor_emp_id uuid,
  p_completed_period text,
  p_labor integer,
  p_health integer,
  p_pension integer,
  p_hourly numeric,
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
  v_prev_pension integer;
  v_next_pension integer;
  v_adj_id uuid;
  v_ins_id uuid;
BEGIN
  IF p_completed_period IS NULL OR p_completed_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'invalid_completed_period' USING ERRCODE = '22023';
  END IF;
  IF p_labor IS NULL OR p_health IS NULL OR p_labor < 0 OR p_health < 0 THEN
    RAISE EXCEPTION 'insured_required' USING ERRCODE = '22023';
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
  IF p_completed_period < r.start_period THEN
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

  UPDATE public.salary_structures
     SET base_salary = r.new_base_salary,
         labor_insured_salary = p_labor,
         health_insured_salary = p_health,
         pension_wage = v_next_pension,
         hourly_wage = coalesce(p_hourly, s.hourly_wage)
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
         prev_labor_insured_salary = round(s.labor_insured_salary)::integer,
         prev_health_insured_salary = round(s.health_insured_salary)::integer,
         prev_pension_wage = v_prev_pension,
         new_labor_insured_salary = coalesce(r.new_labor_insured_salary, p_labor),
         new_health_insured_salary = coalesce(r.new_health_insured_salary, p_health),
         new_pension_wage = coalesce(r.new_pension_wage, p_pension),
         updated_at = v_now
   WHERE id = r.id;

  INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (
    p_tenant_id, 'salary_structures', s.id, 'UPDATE',
    jsonb_build_object('base_salary', s.base_salary, 'labor_insured_salary', s.labor_insured_salary,
      'health_insured_salary', s.health_insured_salary, 'pension_wage', v_prev_pension, 'hourly_wage', s.hourly_wage),
    jsonb_build_object('base_salary', r.new_base_salary, 'labor_insured_salary', p_labor, 'health_insured_salary', p_health,
      'pension_wage', v_next_pension, 'hourly_wage', coalesce(p_hourly, s.hourly_wage),
      'salary_raise_id', r.id, 'completed_period', p_completed_period),
    current_user, p_actor_emp_id,
    'complete_salary_raise 調薪完成（調薪中 ' || r.start_period || ' 起，' || p_completed_period || ' 起套用新本薪／新投保）'
  );

  RETURN jsonb_build_object(
    'id', r.id, 'status', 'completed', 'completed_period', p_completed_period, 'completed_at', v_now,
    'salary_adjustment_id', v_adj_id, 'insured_change_id', v_ins_id
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

NOTIFY pgrst, 'reload schema';
