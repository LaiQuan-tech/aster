-- 2026-11-12 專案序號可手動調整（migration 0094 ＝ sql/0084）：同租戶序號大小寫不敏感唯一索引。
-- 前提：已套到 0093（sql/0083）。套用前先跑唯讀檢查確認無重複：
--   select tenant_id, lower(code), count(*) from projects where code is not null group by 1, 2 having count(*) > 1;  -- 應 0 列
-- 只有 DDL（CREATE UNIQUE INDEX IF NOT EXISTS）、冪等、包在交易內；不動任何資料列。
-- 套用後跑 docs/驗證-2026-11-12-專案序號手動.sql（正式庫只跑第 1 段唯讀檢查）。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --base-file …（同 2026-11-11 修正2 的 base，再加
--   --base-file docs/套用-2026-11-11-每期獎金分潤-修正2.sql） docs/套用-2026-11-12-專案序號手動.sql
--   --verify docs/驗證-2026-11-12-專案序號手動.sql` 在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS projects_tenant_code_ci_uq ON public.projects (tenant_id, lower(code));

COMMIT;
