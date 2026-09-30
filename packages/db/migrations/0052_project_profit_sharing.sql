ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "bonus_rate_pct" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "project_share_adjustments" ADD COLUMN IF NOT EXISTS "change_set_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_share_adjustments_change_set_idx" ON "project_share_adjustments" ("change_set_id");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_bonus_rate_pct_check"
    CHECK ("bonus_rate_pct" IS NULL OR ("bonus_rate_pct" >= 0 AND "bonus_rate_pct" <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.apply_project_share_revision(
  p_tenant_id uuid,
  p_project_id uuid,
  p_changed_by_emp_id uuid,
  p_bonus_rate_pct numeric,
  p_members jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_project projects%ROWTYPE;
  v_current project_members%ROWTYPE;
  v_member jsonb;
  v_employee_id uuid;
  v_member_id uuid;
  v_role text;
  v_share_pct numeric;
  v_change_set_id uuid := gen_random_uuid();
BEGIN
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'reason_required'; END IF;
  IF p_bonus_rate_pct IS NOT NULL AND (p_bonus_rate_pct < 0 OR p_bonus_rate_pct > 100) THEN
    RAISE EXCEPTION 'invalid_bonus_rate';
  END IF;
  IF jsonb_typeof(p_members) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_member'; END IF;

  SELECT * INTO v_project FROM projects
   WHERE tenant_id = p_tenant_id AND id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM employees WHERE tenant_id = p_tenant_id AND id = p_changed_by_emp_id) THEN
    RAISE EXCEPTION 'invalid_employee';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_members) m
    GROUP BY m->>'employeeId' HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'duplicate_employee'; END IF;
  IF coalesce((SELECT sum((m->>'sharePct')::numeric) FROM jsonb_array_elements(p_members) m), 0) > 100 THEN
    RAISE EXCEPTION 'share_pct_exceeds_100';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_members) m
    WHERE coalesce(m->>'roleInProject', '') NOT IN ('manager','lead','support','member')
       OR (m->>'sharePct')::numeric < 0 OR (m->>'sharePct')::numeric > 100
  ) THEN RAISE EXCEPTION 'invalid_role'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_members) m
    WHERE NOT EXISTS (
      SELECT 1 FROM employees e WHERE e.tenant_id = p_tenant_id AND e.id = (m->>'employeeId')::uuid
    )
  ) THEN RAISE EXCEPTION 'invalid_employee'; END IF;

  IF v_project.bonus_rate_pct IS DISTINCT FROM p_bonus_rate_pct THEN
    INSERT INTO project_share_adjustments
      (tenant_id, project_id, employee_id, change_set_id, field, old_value, new_value, reason, changed_by_emp_id)
    VALUES
      (p_tenant_id, p_project_id, NULL, v_change_set_id, 'bonus_rate', v_project.bonus_rate_pct,
       p_bonus_rate_pct, btrim(p_reason), p_changed_by_emp_id);
    UPDATE projects SET bonus_rate_pct = p_bonus_rate_pct
     WHERE tenant_id = p_tenant_id AND id = p_project_id;
  END IF;

  FOR v_current IN
    SELECT * FROM project_members WHERE tenant_id = p_tenant_id AND project_id = p_project_id FOR UPDATE
  LOOP
    SELECT m INTO v_member FROM jsonb_array_elements(p_members) m
     WHERE m->>'employeeId' = v_current.employee_id::text LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO project_share_adjustments
        (tenant_id, project_id, employee_id, change_set_id, field, old_value, new_value, reason, changed_by_emp_id)
      VALUES
        (p_tenant_id, p_project_id, v_current.employee_id, v_change_set_id, 'member_remove',
         v_current.share_pct, NULL, btrim(p_reason), p_changed_by_emp_id);
      DELETE FROM project_members WHERE id = v_current.id;
    ELSE
      v_member_id := nullif(v_member->>'memberId', '')::uuid;
      IF v_member_id IS NOT NULL AND v_member_id <> v_current.id THEN RAISE EXCEPTION 'invalid_member'; END IF;
      v_role := v_member->>'roleInProject';
      v_share_pct := (v_member->>'sharePct')::numeric;
      IF v_current.role_in_project IS DISTINCT FROM v_role THEN
        INSERT INTO project_share_adjustments
          (tenant_id, project_id, employee_id, change_set_id, field, old_value, new_value, reason, changed_by_emp_id)
        VALUES
          (p_tenant_id, p_project_id, v_current.employee_id, v_change_set_id, 'role',
           CASE v_current.role_in_project WHEN 'manager' THEN 1 WHEN 'lead' THEN 2 WHEN 'member' THEN 3 WHEN 'support' THEN 4 END,
           CASE v_role WHEN 'manager' THEN 1 WHEN 'lead' THEN 2 WHEN 'member' THEN 3 WHEN 'support' THEN 4 END,
           btrim(p_reason), p_changed_by_emp_id);
      END IF;
      IF v_current.share_pct IS DISTINCT FROM v_share_pct THEN
        INSERT INTO project_share_adjustments
          (tenant_id, project_id, employee_id, change_set_id, field, old_value, new_value, reason, changed_by_emp_id)
        VALUES
          (p_tenant_id, p_project_id, v_current.employee_id, v_change_set_id, 'pct',
           v_current.share_pct, v_share_pct, btrim(p_reason), p_changed_by_emp_id);
      END IF;
      UPDATE project_members SET role_in_project = v_role, share_pct = v_share_pct WHERE id = v_current.id;
    END IF;
  END LOOP;

  FOR v_member IN SELECT m FROM jsonb_array_elements(p_members) m LOOP
    v_employee_id := (v_member->>'employeeId')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM project_members WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND employee_id = v_employee_id
    ) THEN
      IF nullif(v_member->>'memberId', '') IS NOT NULL THEN RAISE EXCEPTION 'invalid_member'; END IF;
      v_role := v_member->>'roleInProject';
      v_share_pct := (v_member->>'sharePct')::numeric;
      INSERT INTO project_members (tenant_id, project_id, employee_id, role_in_project, share_pct)
      VALUES (p_tenant_id, p_project_id, v_employee_id, v_role, v_share_pct);
      INSERT INTO project_share_adjustments
        (tenant_id, project_id, employee_id, change_set_id, field, old_value, new_value, reason, changed_by_emp_id)
      VALUES
        (p_tenant_id, p_project_id, v_employee_id, v_change_set_id, 'member_add', NULL,
         v_share_pct, btrim(p_reason), p_changed_by_emp_id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'changeSetId', v_change_set_id,
    'bonusRatePct', p_bonus_rate_pct,
    'memberCount', jsonb_array_length(p_members)
  );
END;
$$;
