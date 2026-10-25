-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-25-員工所屬公司.sql ＝ migration 0072 ＝ sql/0062）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-25-員工所屬公司.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- 每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 1. 欄位在、型別 uuid、可為 NULL、沒有預設值 ─────────────────────────
-- 預期 1 row：employees | company_id | uuid | YES | (null)
select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'company_id';

-- ── 2. 外鍵指到 companies(id)、刪除時 SET NULL ─────────────────────────
-- 預期 1 row：confdeltype = n（n＝SET NULL），參照表 companies
select con.conname, con.confrelid::regclass as ref_table, con.confdeltype from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey) where con.conrelid = 'public.employees'::regclass and con.contype = 'f' and a.attname = 'company_id';

-- ── 3. 索引 ──────────────────────────────────────────────────────────
-- 預期 1 row：employees_tenant_company_idx，定義含 (tenant_id, company_id)
select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'employees' and indexname = 'employees_tenant_company_idx';

-- ── 4. 沒有新增任何寫入 policy（0066／0067 的「寫入只經 API」維持）──────────
-- 預期 0 rows
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'employees' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');

-- ── 5. 沒有跨租戶的指派（員工的公司必須屬於同租戶）─────────────────────────
-- 預期 0 rows
select e.id, e.tenant_id, c.tenant_id as company_tenant_id from public.employees e join public.companies c on c.id = e.company_id where c.tenant_id <> e.tenant_id;

-- ── 6. 各租戶指派狀況（第 2 段自動指派的結果）──────────────────────────────
-- 預期：companies = 1 的租戶 unassigned = 0；companies ≥ 2 的租戶 assigned 為 0（之後由 HR 在後台指派，數字會增加屬正常）
select t.id as tenant_id, (select count(*) from public.companies c where c.tenant_id = t.id) as companies, count(e.id) filter (where e.company_id is not null) as assigned, count(e.id) filter (where e.company_id is null) as unassigned from public.tenants t left join public.employees e on e.tenant_id = t.id group by t.id order by t.id;
