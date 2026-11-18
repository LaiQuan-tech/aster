-- 2026-11-18 專案編號（本檔 ＝ sql/0107；接 0116 ＝ sql/0106）。
--
-- 業主：新建專案申請單「要再多一個專案編號」。projects.code 是系統的「專案序號」（如 AT-115-004，唯一、
-- 可由系統產生）；本欄是另一個可自由輸入的「專案編號」（業主／客戶或內部另一套編號）。
--
-- 1. projects.project_no text null：選填、不設唯一、最長 100 字（CHECK；API 端另外去頭尾空白、空字串存 null）。
-- 2. create_project_application_atomic：INSERT 多帶 project_no（p_project->>'project_no'，去空白、空字串＝null）；
--    其餘與 sql/0091（migrations/0101）一字不差（簽名與 RETURNS 不變，可 CREATE OR REPLACE）。
--
-- 只有 DDL，不動任何既有資料列。可重跑。

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS project_no text;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_project_no_len_chk') THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_project_no_len_chk CHECK (project_no IS NULL OR char_length(project_no) <= 100);
  END IF;
END
$chk$;

CREATE OR REPLACE FUNCTION public.create_project_application_atomic(
  p_tenant_id uuid,
  p_created_by_emp_id uuid,
  p_project jsonb,
  p_primary_contract jsonb,
  p_billings jsonb,
  p_subcontracts jsonb
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
  IF nullif(p_project->>'dept_id', '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM departments
       WHERE tenant_id = p_tenant_id
         AND id = (p_project->>'dept_id')::uuid
     ) THEN
    RAISE EXCEPTION 'invalid_department';
  END IF;
  IF nullif(p_project->>'lead_emp_id', '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM employees
       WHERE tenant_id = p_tenant_id
         AND id = (p_project->>'lead_emp_id')::uuid
     ) THEN
    RAISE EXCEPTION 'invalid_lead_employee';
  END IF;
  IF nullif(p_project->>'company_id', '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM companies
       WHERE tenant_id = p_tenant_id
         AND id = (p_project->>'company_id')::uuid
     ) THEN
    RAISE EXCEPTION 'invalid_company';
  END IF;
  IF jsonb_typeof(coalesce(p_project->'engineers', '{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_engineers';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(coalesce(p_project->'engineers', '{}'::jsonb)) AS engineer_entry(discipline, engineer)
    WHERE jsonb_typeof(engineer) = 'object'
      AND nullif(engineer->>'vendorId', '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM vendors
        WHERE tenant_id = p_tenant_id
          AND id = (engineer->>'vendorId')::uuid
          AND deleted_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'invalid_vendor';
  END IF;
  IF p_primary_contract IS NOT NULL
     AND (jsonb_typeof(p_primary_contract) IS DISTINCT FROM 'object'
          OR (p_primary_contract->>'amount')::numeric < 0) THEN
    RAISE EXCEPTION 'invalid_primary_contract';
  END IF;
  IF jsonb_typeof(coalesce(p_billings, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_billings';
  END IF;
  IF jsonb_typeof(coalesce(p_subcontracts, '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_subcontracts';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(coalesce(p_subcontracts, '[]'::jsonb)) AS subcontract
    WHERE nullif(subcontract->>'vendor_id', '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM vendors
        WHERE tenant_id = p_tenant_id
          AND id = (subcontract->>'vendor_id')::uuid
          AND deleted_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'invalid_vendor';
  END IF;

  INSERT INTO projects (
    tenant_id, name, code, fiscal_year, description, dept_id, lead_emp_id,
    share_mode, bonus_pool, starts_on, ends_on, opened_on, status, client_id,
    parent_project_id, kind, site_address, site_area_m2, design_scope,
    invoice_type, payment_method, closing_day, payment_day, other_expenses, engineers,
    company_id, share_pct_by_role, project_no
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
    coalesce(p_project->'engineers', '{}'::jsonb),
    nullif(p_project->>'company_id', '')::uuid,
    CASE WHEN jsonb_typeof(p_project->'share_pct_by_role') = 'object' THEN p_project->'share_pct_by_role' ELSE NULL END,
    nullif(btrim(coalesce(p_project->>'project_no', '')), '')
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

  INSERT INTO project_subcontracts (
    tenant_id, project_id, kind, discipline, vendor_id, vendor_name, contact,
    item, amount, billing_basis, order_type, withholding_rate,
    withholding_threshold, sort_order, note, created_by_emp_id
  )
  SELECT
    p_tenant_id,
    v_project_id,
    coalesce(subcontract->>'kind', 'subcontract'),
    subcontract->>'discipline',
    nullif(subcontract->>'vendor_id', '')::uuid,
    subcontract->>'vendor_name',
    subcontract->>'contact',
    subcontract->>'item',
    coalesce(nullif(subcontract->>'amount', '')::numeric, 0),
    subcontract->>'billing_basis',
    subcontract->>'order_type',
    coalesce(nullif(subcontract->>'withholding_rate', '')::numeric, 0),
    coalesce(nullif(subcontract->>'withholding_threshold', '')::integer, 20000),
    coalesce(nullif(subcontract->>'sort_order', '')::integer, 0),
    subcontract->>'note',
    p_created_by_emp_id
  FROM jsonb_array_elements(coalesce(p_subcontracts, '[]'::jsonb)) AS subcontract;

  RETURN jsonb_build_object('id', v_project_id, 'code', v_code);
END;
$$;

REVOKE ALL ON FUNCTION public.create_project_application_atomic(uuid, uuid, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_project_application_atomic(uuid, uuid, jsonb, jsonb, jsonb, jsonb) TO authenticated, service_role;
