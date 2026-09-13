-- replay-on-pglite 用的最小資料：一個租戶、一個舊制「已封存」的專案（讓 09-12 v2 的 [4]
-- 資料轉換有東西可轉）、一筆 rule_configs（讓 trigger 實測 D 有東西可 update）。
insert into public.tenants (id, name, status)
values ('00000000-0000-0000-0000-000000000001', '重放測試租戶', 'active');

insert into public.projects (id, tenant_id, name, code, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', '舊制封存案', 'P-001', 'archived'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', '進行中案',   'P-002', 'active');

insert into public.rule_configs (tenant_id, config)
values ('00000000-0000-0000-0000-000000000001', '{}'::jsonb);
