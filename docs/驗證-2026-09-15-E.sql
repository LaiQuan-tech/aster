-- =====================================================================
-- 套用後驗證（涵蓋 2026-09-15 E 批次增量 docs/套用-2026-09-15-E.sql
-- 的 [1]，另加 1 條套用前的前置檢查與 1 條交叉確認）
--
-- 用 `npm run db:apply -- ... docs/驗證-2026-09-15-E.sql` 會把每一條的
-- 結果都印出來。用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。
-- 全部都是唯讀 select，跑幾次都沒關係。每條上方註解寫「預期結果」。
-- =====================================================================

-- ── 0. 前置檢查（套用前後都可跑）：重複的 (tenant_id, version) 計數應為 0 ──
-- 預期 1 row：duplicate_groups = 0、duplicate_rows = 0
-- （套用前若 >0：CREATE UNIQUE INDEX 會失敗，先人工處理重複列再套。）
select
  count(*)                    as duplicate_groups,
  coalesce(sum(cnt), 0)       as duplicate_rows
from (
  select tenant_id, version, count(*) as cnt
    from public.rule_configs
   group by tenant_id, version
  having count(*) > 1
) d;

-- ── 0b. 若第 0 條不是 0，這條列出是哪幾組（正常情況回 0 rows）────────────
-- 預期 0 rows
select tenant_id, version, count(*) as cnt,
       array_agg(id order by created_at) as ids,
       array_agg(active order by created_at) as actives
  from public.rule_configs
 group by tenant_id, version
having count(*) > 1
 order by tenant_id, version;

-- ── 1. [1] rule_configs_tenant_version_uq 在（unique）─────────────────
-- 預期 1 row：indexdef 帶 UNIQUE 與 (tenant_id, version)，即
-- CREATE UNIQUE INDEX rule_configs_tenant_version_uq ON public.rule_configs USING btree (tenant_id, version)
select indexname, indexdef from pg_indexes
 where schemaname='public' and tablename='rule_configs'
   and indexname='rule_configs_tenant_version_uq';

-- ── 2. 交叉確認：pg_index 標記為 unique、非 partial、索引有效 ──────────
-- 預期 1 row：indisunique = true、indisvalid = true、indpred_is_null = true
select i.indisunique, i.indisvalid, (i.indpred is null) as indpred_is_null
  from pg_class c
  join pg_index i on i.indexrelid = c.oid
 where c.relname = 'rule_configs_tenant_version_uq';
