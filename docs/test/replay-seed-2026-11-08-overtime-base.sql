-- db:replay 種子（2026-11-08 加班基數）：0086 已套（--base-file）、0087 之前先放一筆既有固定津貼，驗證套用後既有列預設計入。假資料。
INSERT INTO public.tenants (id, name) VALUES ('33333333-3333-4333-8333-333333333333', '重放用租戶');
INSERT INTO public.employees (id, tenant_id, name) VALUES ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '重放用員工');
INSERT INTO public.employee_fixed_allowances (id, tenant_id, employee_id, name, amount, effective_from)
  VALUES ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '既有津貼', 3000, '2030-01-01');
