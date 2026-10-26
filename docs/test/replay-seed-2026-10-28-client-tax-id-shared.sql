-- pglite replay 用的假資料（docs/套用-2026-10-28-客戶統編允許重複.sql）：套用前一筆有統編的客戶；
-- 驗證檔第 4 條在套用後應能看到（若另外插入同統編）重複組。⚠️ 識別碼、名稱、統編都是明顯的假值。
insert into public.tenants (id, name, status) values ('f0000000-0000-4000-8000-0000000000b1', '測試租戶統編', 'active');
insert into public.clients (id, tenant_id, name, tax_id) values
  ('f4000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000b1', '測試客戶甲', '12345675');
