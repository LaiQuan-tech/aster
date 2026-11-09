-- db:replay 專用（配合 replay-seed-2026-11-10-salary-history.sql）：套用 0088 後，種子那筆既有調薪紀錄原值不變、prev_salary 為 NULL。
SELECT (effective_date = '2025-03-26' AND new_salary = 33000 AND reason = '重放種子' AND prev_salary IS NULL) AS ok,
       '種子既有調薪紀錄：原欄位不變、prev_salary NULL' AS item
  FROM public.salary_adjustments WHERE employee_id = '22222222-2222-4222-8222-222222222222';
