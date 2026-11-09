-- 2026-11-10 員工薪資分頁「調薪歷程」＋「勞健保調整歷程」（migration 0088 ＝ sql/0078）。只是紀錄，不影響任何薪資計算。
-- 前提：已套 0087（sql/0077，docs/套用-2026-11-08-加班基數.sql）。純新增、冪等、包在交易內；不動既有資料
--   （salary_adjustments 只 ADD COLUMN IF NOT EXISTS prev_salary，既有列一律 NULL＝原本薪未知）。
-- 套用前就部署的 API 會降級：沒有 prev_salary 就不帶、沒有 insured_salary_changes 表時列表回空、薪資照存、補登投保回 503。
-- 套用後跑 docs/驗證-2026-11-10-薪資投保歷程.sql。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --base-file docs/套用-2026-11-08-薪資津貼勞退.sql
--   --base-file docs/套用-2026-11-08-加班基數.sql --seed docs/test/replay-seed-2026-11-10-salary-history.sql
--   docs/套用-2026-11-10-薪資投保歷程.sql --verify docs/驗證-2026-11-10-薪資投保歷程.sql
--   --verify docs/test/replay-verify-2026-11-10-salary-history.sql` 在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

-- 2026-11-10 員工薪資分頁「調薪歷程」＋「勞健保調整歷程」（只是紀錄，不參與任何薪資計算）：
--   1. salary_adjustments（既有調薪紀錄表，0014）加 prev_salary：調薪前本薪（選填；舊資料／批次匯入為 NULL）。
--      員工薪資分頁存檔時本薪有變 → API 寫一筆（生效日、原本薪、新本薪、原因、changed_by_emp_id）。
--      注意：批次調薪／補登都「只寫紀錄」，不會改 salary_structures.base_salary（與既有行為相同）。
--   2. insured_salary_changes：勞保投保薪資／健保投保薪資／勞退月提繳工資的調整紀錄（各存調整前 prev_* 與調整後），
--      含生效日、備註、登錄人；存薪資資料時三項任一有變自動寫一筆，也可補登歷史。NULL＝未設定（勞退＝依分級表自動算）。
-- 前提：已套到 0087（sql/0077）。純新增、可重跑（IF NOT EXISTS／duplicate_object）；不動既有表的資料。
-- 只由 API（service role）存取：RLS 開、不給 policy；掛 audit_all。刪除走 deleted_at 軟刪（限 HR）。
ALTER TABLE public.salary_adjustments ADD COLUMN IF NOT EXISTS prev_salary numeric;

CREATE TABLE IF NOT EXISTS public.insured_salary_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  effective_on date NOT NULL,                      -- 生效日
  labor_insured_salary integer,                    -- 調整後勞保投保薪資
  health_insured_salary integer,                   -- 調整後健保投保薪資
  pension_wage integer,                            -- 調整後勞退月提繳工資（NULL＝依分級表自動算）
  prev_labor_insured_salary integer,               -- 調整前
  prev_health_insured_salary integer,
  prev_pension_wage integer,
  note text,                                       -- 原因／備註
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS insured_salary_changes_tenant_emp_idx
  ON public.insured_salary_changes (tenant_id, employee_id, effective_on);
DO $$ BEGIN
  ALTER TABLE public.insured_salary_changes ADD CONSTRAINT insured_salary_changes_amounts_chk CHECK (
    (labor_insured_salary IS NULL OR labor_insured_salary BETWEEN 0 AND 9999999)
    AND (health_insured_salary IS NULL OR health_insured_salary BETWEEN 0 AND 9999999)
    AND (pension_wage IS NULL OR pension_wage BETWEEN 0 AND 9999999)
    AND (prev_labor_insured_salary IS NULL OR prev_labor_insured_salary BETWEEN 0 AND 9999999)
    AND (prev_health_insured_salary IS NULL OR prev_health_insured_salary BETWEEN 0 AND 9999999)
    AND (prev_pension_wage IS NULL OR prev_pension_wage BETWEEN 0 AND 9999999)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.insured_salary_changes ADD CONSTRAINT insured_salary_changes_note_chk CHECK (note IS NULL OR char_length(note) <= 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.insured_salary_changes ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.insured_salary_changes;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.insured_salary_changes
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── 還原（會丟掉所有投保調整歷程與調薪紀錄的原本薪）──
-- DROP TABLE IF EXISTS public.insured_salary_changes;
-- ALTER TABLE public.salary_adjustments DROP COLUMN IF EXISTS prev_salary;

COMMIT;
