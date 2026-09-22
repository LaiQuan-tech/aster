-- replay-on-pglite 用的最小資料（2026-09-22 多級簽核）：一個租戶、兩位員工、兩個部門——
-- A 設了 manager_emp_id（backfill 應補成 ARRAY[manager]）、B 沒設主管（陣列應維持空）。
-- seed 在套用前（base = migration 0048）執行，manager_emp_ids 欄位還不存在，所以
-- 「已編排多主管的列不被覆蓋」這條由驗證檔第 3 條（mismatched_first）與第二次重放
-- （backfill 只碰 cardinality = 0 的列）涵蓋。employees.dept_id 與
-- departments.manager_emp_id 互相引用，先插員工再插部門。
insert into public.tenants (id, name, status)
values ('00000000-0000-0000-0000-000000000001', '重放測試租戶', 'active');

insert into public.employees (id, tenant_id, name, emp_no, role, status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', '重放主管一', 'R-001', 'manager', 'active'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001', '重放主管二', 'R-002', 'manager', 'active');

insert into public.departments (id, tenant_id, name, manager_emp_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001', '部門 A（舊制單主管）', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000001', '部門 B（無主管）', null);
