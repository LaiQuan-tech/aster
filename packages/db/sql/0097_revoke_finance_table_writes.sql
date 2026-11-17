-- 2026-11-17 金流／薪資表收回 anon／authenticated 的寫入類表權限（本檔 ＝ migrations/0107；接 sql/0096）。
--
-- 比照 0106（vendors／disbursements）：這些表都開了 RLS，API 一律以 service_role 存取；但表權限仍給 anon／authenticated
-- INSERT／UPDATE／DELETE／TRUNCATE 等（TRUNCATE 不受 RLS 管）。收回寫入類權限，SELECT 保留（RLS policy 照舊決定可讀列）。
-- 套用前已確認 repo 內前端只用 anon key 做 Auth 與 Storage 簽名上傳、worker 不用 anon key、API RPC 一律 service_role。
-- 每張表各自 DO 區塊，表不存在就跳過。純 DDL、可重跑；不動任何資料列。

DO $$ BEGIN
  IF to_regclass('public.disbursement_allocations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.disbursement_allocations FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.disbursement_approval_steps') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.disbursement_approval_steps FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.disbursement_attachments') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.disbursement_attachments FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.project_subcontract_payments') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.project_subcontract_payments FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.project_subcontracts') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.project_subcontracts FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.companies') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.companies FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.payroll_adjustments') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.payroll_adjustments FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.employee_fixed_allowances') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.employee_fixed_allowances FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.bonus_runs') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.bonus_runs FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.festival_bonuses') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.festival_bonuses FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.payslips') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.payslips FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.salary_adjustments') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.salary_adjustments FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  IF to_regclass('public.vendor_bank_change_requests') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.vendor_bank_change_requests FROM anon, authenticated;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
