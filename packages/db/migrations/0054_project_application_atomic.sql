CREATE OR REPLACE FUNCTION public.create_project_application_atomic(
  p_tenant_id uuid,
  p_created_by_emp_id uuid,
  p_project jsonb,
  p_primary_contract jsonb,
  p_billings jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_project_id uuid;
  v_code text;
BEGIN
  IF jsonb_typeof(p_project) IS DISTINCT FROM 'object'
     OR btrim(coalesce(p_project->>'name', '')) = '' THEN
    RAISE EXCEPTION 'invalid_project';
  END IF;
  IF p_project ? 'tenant_id' AND (p_project->>'tenant_id')::uuid <> p_tenant_id THEN
    RAISE EXCEPTION 'tenant_mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM employees WHERE tenant_id = p_tenant_id AND id = p_created_by_emp_id
  ) THEN
    RAISE EXCEPTION 'invalid_creator';
  END IF;
  IF p_primary_contract IS NOT NULL
     AND (jsonb_typeof(p_primary_contract) IS DISTINCT FROM 'object'
          OR (p_primary_contract->>'amount')::numeric < 0) THEN
    RAISE EXCEPTION 'invalid_primary_contract';
  END IF;
  IF jsonb_typeof(coalesce(p_billings, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_billings';
  END IF;

  INSERT INTO projects (
    tenant_id, name, code, fiscal_year, description, dept_id, lead_emp_id,
    share_mode, bonus_pool, starts_on, ends_on, opened_on, status, client_id,
    parent_project_id, kind, site_address, site_area_m2, design_scope,
    invoice_type, payment_method, closing_day, payment_day, other_expenses, engineers
  ) VALUES (
    p_tenant_id,
    p_project->>'name',
    p_project->>'code',
    nullif(p_project->>'fiscal_year', '')::integer,
    p_project->>'description',
    nullif(p_project->>'dept_id', '')::uuid,
    nullif(p_project->>'lead_emp_id', '')::uuid,
    coalesce(p_project->>'share_mode', 'pool_pct'),
    nullif(p_project->>'bonus_pool', '')::numeric,
    nullif(p_project->>'starts_on', '')::date,
    nullif(p_project->>'ends_on', '')::date,
    nullif(p_project->>'opened_on', '')::date,
    coalesce(p_project->>'status', 'active'),
    nullif(p_project->>'client_id', '')::uuid,
    nullif(p_project->>'parent_project_id', '')::uuid,
    coalesce(p_project->>'kind', 'main'),
    p_project->>'site_address',
    nullif(p_project->>'site_area_m2', '')::numeric,
    coalesce(p_project->'design_scope', '[]'::jsonb),
    p_project->>'invoice_type',
    p_project->>'payment_method',
    p_project->>'closing_day',
    p_project->>'payment_day',
    coalesce(nullif(p_project->>'other_expenses', '')::numeric, 0),
    coalesce(p_project->'engineers', '{}'::jsonb)
  )
  RETURNING id, code INTO v_project_id, v_code;

  IF p_primary_contract IS NOT NULL THEN
    INSERT INTO contracts (
      tenant_id, project_id, doc_type, our_role, title, counterparty, amount,
      is_primary, signed_on, copies, stamp_duty_required, stamp_duty_rate,
      stamp_duty_amount, created_by_emp_id
    ) VALUES (
      p_tenant_id, v_project_id, 'contract', 'contractor',
      coalesce(nullif(btrim(p_primary_contract->>'title'), ''), '主合約'),
      p_primary_contract->>'counterparty',
      nullif(p_primary_contract->>'amount', '')::numeric,
      true,
      nullif(p_primary_contract->>'signed_on', '')::date,
      coalesce(nullif(p_primary_contract->>'copies', '')::integer, 1),
      'auto',
      nullif(p_primary_contract->>'stamp_duty_rate', '')::numeric,
      nullif(p_primary_contract->>'stamp_duty_amount', '')::numeric,
      p_created_by_emp_id
    );
  END IF;

  INSERT INTO project_billings (
    tenant_id, project_id, installment_no, kind, percentage, milestone,
    planned_on, calculated_amount, residue_applied, override_amount,
    override_reason, note, created_by_emp_id
  )
  SELECT
    p_tenant_id,
    v_project_id,
    (billing->>'installment_no')::integer,
    coalesce(billing->>'kind', 'installment'),
    nullif(billing->>'percentage', '')::numeric,
    billing->>'milestone',
    nullif(billing->>'planned_on', '')::date,
    nullif(billing->>'calculated_amount', '')::numeric,
    coalesce(nullif(billing->>'residue_applied', '')::numeric, 0),
    nullif(billing->>'override_amount', '')::numeric,
    billing->>'override_reason',
    billing->>'note',
    p_created_by_emp_id
  FROM jsonb_array_elements(coalesce(p_billings, '[]'::jsonb)) AS billing;

  RETURN jsonb_build_object('id', v_project_id, 'code', v_code);
END;
$$;

REVOKE ALL ON FUNCTION public.create_project_application_atomic(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_project_application_atomic(uuid, uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;
