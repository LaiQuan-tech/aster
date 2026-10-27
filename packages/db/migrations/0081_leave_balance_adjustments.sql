-- 2026-10-29 假別時數手動調整歷程：HR／老闆在員工假別內頁增減時數，每次一筆。
-- 調整本身直接加減在 leave_balances.entitled（既有讀點自動反映）；本表只記「誰、何時、增減多少、為什麼」。
-- 前提：已套到 0080（sql/0070）。可重跑（IF NOT EXISTS／duplicate_object）。
-- API 在表未套用前：內頁照常顯示（歷程顯示「尚未啟用」），POST 調整回 409 migration_required、不動餘額。
CREATE TABLE IF NOT EXISTS public.leave_balance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  leave_type_id uuid NOT NULL REFERENCES public.leave_types(id),
  balance_id uuid REFERENCES public.leave_balances(id) ON DELETE SET NULL,
  delta_hours numeric(8,2) NOT NULL,
  entitled_before numeric(8,2) NOT NULL,
  entitled_after numeric(8,2) NOT NULL,
  reason text NOT NULL,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leave_balance_adjustments_tenant_emp_idx
  ON public.leave_balance_adjustments (tenant_id, employee_id, created_at DESC);
DO $$ BEGIN
  ALTER TABLE public.leave_balance_adjustments ADD CONSTRAINT leave_balance_adjustments_delta_chk CHECK (delta_hours <> 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.leave_balance_adjustments ADD CONSTRAINT leave_balance_adjustments_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- API 走 service role；RLS 開啟不給 policy＝前端直連一律擋。
ALTER TABLE public.leave_balance_adjustments ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.leave_balance_adjustments;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.leave_balance_adjustments
  FOR EACH ROW EXECUTE FUNCTION audit_row();
