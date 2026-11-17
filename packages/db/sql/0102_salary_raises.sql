-- 2026-11-17 員工薪資「調薪中」狀態（本檔 ＝ migrations/0112；接 sql/0101）。
--
-- 業主：調薪後政府端投保薪資調整流程未完成前，薪資照「新本薪」發，但勞保／健保（與勞退提繳工資）仍照舊級距扣。
--   • status='pending'（調薪中）：start_period（生效日所在月份）起的每個月份，計薪時
--       本俸＝new_base_salary、請假／加班時薪＝新本薪 ÷ 240；勞健保／勞退＝salary_structures 目前（舊）值；
--       出勤統計表「薪資」欄顯示舊本薪，另列「含調薪差額 ＋X 元」；薪資單另列「調薪差額」。
--     salary_structures 在調薪中期間**不改**（取消＝直接回到舊薪資）。
--   • 按「調薪完成」→ status='completed'、completed_period＝完成月份：salary_structures 改成新本薪／新投保，
--     prev_* 存完成當下的舊值；start_period ≤ 月份 < completed_period 的重算仍照「調薪中」口徑（舊投保＝prev_*）。
--   • 按「取消調薪中」→ status='cancelled'：任何月份都不套用。
--   已定案（finalized）薪資單不重算，不追溯。
-- 同一員工同時最多一筆 pending（partial unique index）。
-- 只由 API（service role，HR／platform_admin）存取：RLS 開、不給 policy、revoke anon/authenticated；掛 audit_all。
-- 純新增、可重跑；不動任何既有資料列。
CREATE TABLE IF NOT EXISTS public.salary_raises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  status text NOT NULL DEFAULT 'pending',
  effective_on date NOT NULL,                       -- 調薪生效日
  start_period text NOT NULL,                       -- 調薪中起始月份 'YYYY-MM'（生效日所在月）
  new_base_salary numeric NOT NULL,                 -- 新本薪
  new_labor_insured_salary integer,                 -- 新勞保投保薪資（政府流程完成後套用；NULL＝完成時再填）
  new_health_insured_salary integer,                -- 新健保投保金額
  new_pension_wage integer,                         -- 新勞退月提繳工資（NULL＝完成時不改）
  prev_base_salary numeric,                         -- 舊值快照（建立時；完成時以完成當下覆寫）
  prev_labor_insured_salary integer,
  prev_health_insured_salary integer,
  prev_pension_wage integer,
  note text,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_period text,                            -- 調薪完成月份 'YYYY-MM'（該月起全部新）
  completed_at timestamptz,
  completed_by_emp_id uuid,
  cancelled_at timestamptz,
  cancelled_by_emp_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.salary_raises ADD CONSTRAINT salary_raises_status_chk
    CHECK (status IN ('pending', 'completed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.salary_raises ADD CONSTRAINT salary_raises_periods_chk CHECK (
    start_period ~ '^\d{4}-(0[1-9]|1[0-2])$'
    AND (completed_period IS NULL OR (completed_period ~ '^\d{4}-(0[1-9]|1[0-2])$' AND completed_period >= start_period))
    AND (status <> 'completed' OR completed_period IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.salary_raises ADD CONSTRAINT salary_raises_amounts_chk CHECK (
    new_base_salary > 0 AND new_base_salary <= 9999999
    AND (prev_base_salary IS NULL OR prev_base_salary BETWEEN 0 AND 9999999)
    AND (new_labor_insured_salary IS NULL OR new_labor_insured_salary BETWEEN 0 AND 9999999)
    AND (new_health_insured_salary IS NULL OR new_health_insured_salary BETWEEN 0 AND 9999999)
    AND (new_pension_wage IS NULL OR new_pension_wage BETWEEN 0 AND 9999999)
    AND (prev_labor_insured_salary IS NULL OR prev_labor_insured_salary BETWEEN 0 AND 9999999)
    AND (prev_health_insured_salary IS NULL OR prev_health_insured_salary BETWEEN 0 AND 9999999)
    AND (prev_pension_wage IS NULL OR prev_pension_wage BETWEEN 0 AND 9999999)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.salary_raises ADD CONSTRAINT salary_raises_note_chk CHECK (note IS NULL OR char_length(note) <= 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS salary_raises_one_pending_idx
  ON public.salary_raises (tenant_id, employee_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS salary_raises_tenant_emp_idx
  ON public.salary_raises (tenant_id, employee_id, start_period);

ALTER TABLE public.salary_raises ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON TABLE public.salary_raises FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT ALL ON TABLE public.salary_raises TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'audit_row') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS audit_all ON public.salary_raises';
    EXECUTE 'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.salary_raises FOR EACH ROW EXECUTE FUNCTION public.audit_row()';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
