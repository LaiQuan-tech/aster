-- 2026-11-17 健保眷屬人數「直接輸入」（本檔 ＝ sql/0098；接 0107 ＝ sql/0097）。
--
-- 業主：員工資料頁「健保眷屬投保資料」要能直接 key 眷屬人數，不必逐筆建眷屬明細。
-- employees.nhi_dependents_override：NULL＝沒填，沿用明細（nhi_dependents 中 insured=true 的筆數）；
-- 有值（0–10）＝以此為準。健保自付額的眷口法定上限 3 口仍由計算引擎（@hr/rules nhiEmployeePremium）裁切，
-- 這裡存的是實際眷屬人數，不先裁切。
-- 寫入只經 API（service_role，HR 權限）並寫 audit_logs。純 DDL、可重跑；不動任何資料列。

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS nhi_dependents_override smallint;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'employees_nhi_dependents_override_range'
       AND conrelid = 'public.employees'::regclass
  ) THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_nhi_dependents_override_range
      CHECK (nhi_dependents_override IS NULL OR nhi_dependents_override BETWEEN 0 AND 10);
  END IF;
END $$;

COMMENT ON COLUMN public.employees.nhi_dependents_override IS
  '健保眷屬人數（直接輸入，0–10）。NULL＝沿用 nhi_dependents 中投保中的筆數。計費上限 3 口由計算引擎裁切。';
