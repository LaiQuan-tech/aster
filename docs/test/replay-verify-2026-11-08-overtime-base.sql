-- db:replay 專用：套用 0087 後，種子那筆既有津貼 overtime_base = true、其他欄位不變。
SELECT (overtime_base = true AND amount = 3000 AND name = '既有津貼') AS ok, '既有津貼列預設計入加班基數、原值不變' AS item
  FROM public.employee_fixed_allowances WHERE id = '55555555-5555-4555-8555-555555555555';
