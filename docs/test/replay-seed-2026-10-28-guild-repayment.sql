-- pglite replay 用的假資料（docs/套用-2026-10-28-專案審迄還款.sql）：一個租戶、一個專案，套用後新欄位應為 NULL。
-- ⚠️ 識別碼、名稱都是明顯的假值（repo 是公開的）。
insert into public.tenants (id, name, status) values
  ('f0000000-0000-4000-8000-0000000000b1', '測試租戶審迄', 'active');
insert into public.projects (id, tenant_id, name, code) values
  ('f4000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000b1', '測試專案甲', 'T-115-901');
