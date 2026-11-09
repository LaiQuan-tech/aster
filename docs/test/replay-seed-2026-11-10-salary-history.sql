-- db:replay 種子（2026-11-10 薪資投保歷程）：套 0088 之前先放一筆既有調薪紀錄，驗證 ADD COLUMN 不改既有資料。假資料。
INSERT INTO public.tenants (id, name) VALUES ('11111111-1111-4111-8111-111111111111', '重放用租戶');
INSERT INTO public.employees (id, tenant_id, name) VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '重放用員工');
INSERT INTO public.salary_adjustments (tenant_id, employee_id, effective_date, new_salary, reason)
  VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '2025-03-26', 33000, '重放種子');
