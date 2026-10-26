-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-28-客戶統編允許重複.sql ＝ migration 0078 ＝ sql/0068）。全部唯讀 select。
-- =====================================================================

-- ── 1. 唯一索引已移除 ────────────────────────────────────────────────
-- 預期 0 rows
select indexname from pg_indexes where schemaname = 'public' and tablename = 'clients' and indexname = 'clients_tenant_tax_id_uq';

-- ── 2. 一般索引在、條件相同、不是 unique ─────────────────────────────
-- 預期 1 row：CREATE INDEX clients_tenant_tax_id_idx ON public.clients USING btree (tenant_id, tax_id) WHERE ((tax_id IS NOT NULL) AND (deleted_at IS NULL))
select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'clients' and indexname = 'clients_tenant_tax_id_idx';

-- ── 3. clients 上已沒有任何含 tax_id 的唯一索引 ──────────────────────
-- 預期 0 rows
select indexname from pg_indexes where schemaname = 'public' and tablename = 'clients' and indexdef ilike '%unique%' and indexdef ilike '%tax_id%';

-- ── 4. 目前同租戶重複統編的組數（套用後才可能 > 0）──────────────────────
select tenant_id, tax_id, count(*) from public.clients where tax_id is not null and deleted_at is null group by 1, 2 having count(*) > 1 order by 3 desc;
