set transaction read only;
-- =====================================================================
-- 預支單一申請單唯一（docs/套用-2026-10-27-預支單一申請單唯一.sql ＝ migration 0079 ＝ sql/0069）。
-- 全部唯讀。套用前跑第 1 段（必須 0 rows 才能套）；套用後跑全部。
-- （在 SQL editor 裡若 `set transaction read only` 需要交易，整份包 begin; … rollback; 執行。）
-- =====================================================================

-- ── 1. 同一張申請單有多筆預支（套用前必須 0 rows）────────────────────
select a.request_id, count(*) as n,
       array_agg(a.id order by a.created_at) as advance_ids,
       array_agg(a.status order by a.created_at) as statuses,
       array_agg(a.amount order by a.created_at) as amounts
from public.advances a
where a.request_id is not null
group by a.request_id
having count(*) > 1
order by n desc;

-- ── 2. 唯一索引在、是 unique、條件正確 ───────────────────────────────
-- 預期 1 row：CREATE UNIQUE INDEX advances_request_id_uq ON public.advances USING btree (request_id) WHERE (request_id IS NOT NULL)
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'advances' and indexname = 'advances_request_id_uq';

-- ── 3. 索引有效（不是建到一半失敗的 invalid 索引）─────────────────────
-- 預期 1 row：indisunique = true、indisvalid = true
select c.relname, i.indisunique, i.indisvalid
from pg_index i join pg_class c on c.oid = i.indexrelid
where c.relname = 'advances_request_id_uq';
