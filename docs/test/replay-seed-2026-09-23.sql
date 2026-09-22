-- replay-on-pglite 用的最小資料（2026-09-23 需求補齊）。seed 在套用前執行
-- （base = migration 0049 + sql/0039 + docs/套用-2026-09-22-多級簽核.sql），所以只能
-- 用舊欄位。要讓 sql/0040 的三段資料轉換有東西可轉：
--   [E] leave_balances 曆年列 → backfill period_start/period_end（2025、2026 各一列，
--       同一人同假別兩年，驗新唯一鍵 (tenant, emp, type, period_start) 不互撞）
--   [H] projects.engineers 舊 key：一案全舊 key、一案新舊混（'electrical' 與 '電機'
--       並存，應保留中文 key 的值）、一案只有中文 key（不該被動到）
--   [F] disbursements：draft 與 paid 各一筆（狀態 CHECK 換新後舊值仍合法）
-- 另放一位 role='accountant' 員工與 role_in_project='manager' 成員，驗 employees.role
-- 無 CHECK、project_members.role_in_project 無 CHECK（皆由 API 決定值域）。
insert into public.tenants (id, name, status)
values ('00000000-0000-0000-0000-000000000001', '重放測試租戶', 'active');

insert into public.employees (id, tenant_id, name, emp_no, role, status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', '重放員工一', 'R-001', 'employee',   'active'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001', '重放會計',   'R-002', 'accountant', 'active'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000000000001', '重放老闆',   'R-003', 'hr_admin',   'active');

insert into public.leave_types (id, tenant_id, code, name, paid) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000001', 'annual', '特休', true);

-- 曆年制餘額桶（小時）：2025 用了 16h、2026 用了 8h
insert into public.leave_balances (tenant_id, employee_id, leave_type_id, year, entitled, used) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 2025, 80, 16),
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 2026, 112, 8);

insert into public.projects (id, tenant_id, name, code, status, engineers) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', '舊 key 案',   'P-001', 'active',
   '{"electrical": {"name": "甲技師"}, "hvac": {"name": "乙技師"}, "fire": null}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', '新舊混用案', 'P-002', 'active',
   '{"electrical": {"name": "舊值"}, "電機": {"name": "新值"}, "汙水": {"name": "丙技師"}}'::jsonb),
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000001', '純中文案',   'P-003', 'active',
   '{"消防": {"name": "丁技師"}}'::jsonb);

insert into public.project_members (tenant_id, project_id, employee_id, role_in_project, share_pct) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 'manager', 30);

insert into public.companies (id, tenant_id, name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', '重放付款公司');

insert into public.disbursements (id, tenant_id, disbursement_no, status, payee_kind, payee_name, paying_company_id, method, amount, paid_on) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'D-115-001', 'draft', 'other', '重放印刷廠', '00000000-0000-0000-0000-0000000000c1', 'transfer', 12000, null),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'D-115-002', 'paid',  'other', '重放快遞',   '00000000-0000-0000-0000-0000000000c1', 'transfer', 800, '2026-09-01');
