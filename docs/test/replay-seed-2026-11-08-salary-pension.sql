-- db:replay 種子（2026-11-08 薪資津貼勞退）：套 0086 之前先放一筆既有薪資資料，驗證 ADD COLUMN 不改既有資料。假資料。
INSERT INTO public.tenants (id, name) VALUES ('11111111-1111-4111-8111-111111111111', '重放用租戶');
INSERT INTO public.employees (id, tenant_id, name) VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '重放用員工');
INSERT INTO public.salary_structures (tenant_id, employee_id, method, base_salary, labor_insured_salary, health_insured_salary, pension_voluntary_rate)
  VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'monthly', 40000, 40100, 40100, 0.03);
