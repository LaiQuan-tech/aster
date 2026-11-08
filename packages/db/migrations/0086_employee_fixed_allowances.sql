-- 2026-11-08 員工固定津貼＋勞退月提繳工資：
--   1. employee_fixed_allowances：每位員工可設多筆每月固定津貼（名稱、月金額、是否計入投保、課稅方式、生效起迄日），
--      薪資執行（POST /payroll/run）自動帶入當月有效的津貼。
--   2. salary_structures 加兩欄：pension_wage（勞退月提繳工資，選填；NULL＝依分級表自動算）、
--      pension_new_system（是否適用勞退新制，預設 true；false → 雇主提撥與自提都 0）。
--   雇主提撥率、勞退月提繳分級表、伙食費免稅額放在規則參數（rule_configs.config.pension／allowance），不需改表。
-- 前提：已套到 0085（sql/0075）。純新增、可重跑（IF NOT EXISTS／duplicate_object）；不動既有表與資料。
-- 只由 API（service role）存取：RLS 開、不給 policy；掛 audit_all。刪除走 deleted_at 軟刪。
CREATE TABLE IF NOT EXISTS public.employee_fixed_allowances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  name text NOT NULL,                              -- 例：職務加給、伙食津貼
  amount integer NOT NULL,                         -- 月金額（整數元）
  insurable boolean NOT NULL DEFAULT true,         -- 是否計入投保薪資（經常性給與）；只用於提示，不自動改級距
  tax_type text NOT NULL DEFAULT 'taxable',        -- taxable 應稅 / meal_exempt 伙食費（每月合計 2,400 內免稅）
  effective_from date NOT NULL,                    -- 生效起日（含）
  effective_to date,                               -- 生效迄日（含）；NULL＝無迄日
  note text,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS employee_fixed_allowances_tenant_emp_idx
  ON public.employee_fixed_allowances (tenant_id, employee_id);
DO $$ BEGIN
  ALTER TABLE public.employee_fixed_allowances ADD CONSTRAINT employee_fixed_allowances_amount_chk CHECK (amount >= 0 AND amount <= 9999999);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.employee_fixed_allowances ADD CONSTRAINT employee_fixed_allowances_tax_type_chk CHECK (tax_type IN ('taxable', 'meal_exempt'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.employee_fixed_allowances ADD CONSTRAINT employee_fixed_allowances_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 50);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.employee_fixed_allowances ADD CONSTRAINT employee_fixed_allowances_dates_chk CHECK (effective_to IS NULL OR effective_to >= effective_from);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.employee_fixed_allowances ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.employee_fixed_allowances;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.employee_fixed_allowances
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- 勞退月提繳工資／適用勞退新制（既有表只加欄、不改既有資料：pension_wage 一律 NULL＝自動算、pension_new_system 一律 true）
ALTER TABLE public.salary_structures ADD COLUMN IF NOT EXISTS pension_wage integer;
ALTER TABLE public.salary_structures ADD COLUMN IF NOT EXISTS pension_new_system boolean NOT NULL DEFAULT true;
DO $$ BEGIN
  ALTER TABLE public.salary_structures ADD CONSTRAINT salary_structures_pension_wage_chk CHECK (pension_wage IS NULL OR (pension_wage > 0 AND pension_wage <= 9999999));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
