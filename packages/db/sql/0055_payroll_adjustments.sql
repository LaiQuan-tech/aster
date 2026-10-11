-- 2026-10-11 薪資一次性加減項（前期更正）：已匯款月份不改原薪資單，於下月補發或扣回。
-- 前提：已套到 0064（sql/0054）。可重跑。
CREATE TABLE IF NOT EXISTS public.payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  period text NOT NULL,
  label text NOT NULL,
  amount numeric(12,2) NOT NULL,
  taxable boolean NOT NULL DEFAULT true,
  related_period text,
  note text,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS payroll_adjustments_tenant_period_idx ON public.payroll_adjustments (tenant_id, period);
CREATE INDEX IF NOT EXISTS payroll_adjustments_tenant_emp_idx ON public.payroll_adjustments (tenant_id, employee_id);
DO $$ BEGIN
  ALTER TABLE public.payroll_adjustments ADD CONSTRAINT payroll_adjustments_period_chk CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.payroll_adjustments ADD CONSTRAINT payroll_adjustments_related_period_chk CHECK (related_period IS NULL OR related_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.payroll_adjustments ADD CONSTRAINT payroll_adjustments_amount_chk CHECK (amount <> 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.payroll_adjustments ADD CONSTRAINT payroll_adjustments_label_chk CHECK (char_length(btrim(label)) BETWEEN 1 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- API 走 service role；RLS 開啟不給 policy＝前端直連一律擋。
ALTER TABLE public.payroll_adjustments ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.payroll_adjustments;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION audit_row();
