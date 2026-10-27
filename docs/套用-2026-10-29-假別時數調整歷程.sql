-- =====================================================================
-- 2026-10-29 假別時數手動調整歷程（migration 0081 ＝ sql/0071）
--
-- 內容：新表 public.leave_balance_adjustments（每次手動增減一筆：增減時數、調整前後本期給假、原因、操作者）。
-- 目的：業主要求「點進員工內頁可手動增減假的時數」，且要留下調整歷程。
--       調整本身加減在 leave_balances.entitled；本表是歷程／稽核。
--
-- 前提：已套到 0080（sql/0070）。整份可重跑（冪等），包在 BEGIN／COMMIT 交易裡（一錯全回滾）。
-- 只新增表、不動既有資料與 policy；寫入一律經 API（service role），RLS 開啟不給 policy。
-- 順序：先部署 API 或先套本檔皆可。未套用前 API 的調整端點回 409 migration_required（不會動到餘額）。
-- 套用後跑 docs/驗證-2026-10-29-假別時數調整歷程.sql。
-- =====================================================================

BEGIN;

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

COMMIT;

-- ── 還原（確定不要這個功能時才跑；會刪掉調整歷程，餘額桶上已加減的時數不會回復）──
-- BEGIN;
-- DROP TABLE IF EXISTS public.leave_balance_adjustments;
-- COMMIT;
