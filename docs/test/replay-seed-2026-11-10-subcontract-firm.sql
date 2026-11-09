-- db:replay 種子（2026-11-10 副委託事務所與發票）：套 0089 之前先放一筆既有技師副委託，驗證 CHECK 重建與 ADD COLUMN 不改既有資料。假資料。
INSERT INTO public.tenants (id, name) VALUES ('11111111-1111-4111-8111-111111111111', '重放用租戶');
INSERT INTO public.projects (id, tenant_id, name) VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '重放用專案');
INSERT INTO public.project_subcontracts (id, tenant_id, project_id, kind, vendor_name, amount)
  VALUES ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', 'technician', '重放用技師', 30000);
