-- db:replay 專用（配合 replay-seed-2026-11-08-salary-pension.sql）：套用 0086 後，種子那筆既有薪資資料原值不變、新欄位為預設值。
-- 只用在重放（正式庫的驗證檔可重跑，不檢查既有列的值）。
SELECT (base_salary = 40000 AND labor_insured_salary = 40100 AND pension_voluntary_rate = 0.03
        AND pension_wage IS NULL AND pension_new_system = true) AS ok,
       '種子既有列：原欄位不變、pension_wage NULL、pension_new_system true' AS item
  FROM public.salary_structures WHERE employee_id = '22222222-2222-4222-8222-222222222222';
