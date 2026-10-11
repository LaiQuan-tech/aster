-- 2026-10-11 遲到說明（彈性上班時窗後才打上班卡須填理由；直屬主管與老闆看得到，老闆決定是否影響全勤）。
-- 前提：已套到 0060（sql/0050）。可重跑。
CREATE TABLE IF NOT EXISTS public.late_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  work_date date NOT NULL,
  punch_record_id uuid,
  punch_at timestamptz NOT NULL,
  late_minutes integer NOT NULL,
  reason text NOT NULL,
  attendance_decision text,
  decided_by_emp_id uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS late_reports_tenant_emp_date_uq ON public.late_reports (tenant_id, employee_id, work_date);
CREATE INDEX IF NOT EXISTS late_reports_tenant_date_idx ON public.late_reports (tenant_id, work_date);
DO $$ BEGIN
  ALTER TABLE public.late_reports ADD CONSTRAINT late_reports_minutes_chk CHECK (late_minutes >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.late_reports ADD CONSTRAINT late_reports_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.late_reports ADD CONSTRAINT late_reports_decision_chk
    CHECK (attendance_decision IS NULL OR attendance_decision IN ('affects', 'exempt'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.late_reports ADD CONSTRAINT late_reports_decided_chk
    CHECK ((attendance_decision IS NULL) = (decided_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- API 走 service role；RLS 開啟不給 policy＝前端直連一律擋。
ALTER TABLE public.late_reports ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.late_reports;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.late_reports
  FOR EACH ROW EXECUTE FUNCTION audit_row();
