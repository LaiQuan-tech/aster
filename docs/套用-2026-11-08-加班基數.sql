-- 2026-11-08 加班費時薪基數含固定津貼（migration 0087 ＝ sql/0077）。
-- 前提：已套 0086（sql/0076，docs/套用-2026-11-08-薪資津貼勞退.sql）。純新增、冪等、包在交易內。
-- 既有津貼列的 overtime_base 一律 true（＝計入加班費基數；HR 可在員工薪資資料的固定津貼逐筆取消）。
-- 套用前就部署的 API 會探測欄位：沒有這欄時一律視為 true、不會 500。
-- 套用後跑 docs/驗證-2026-11-08-加班基數.sql。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --base-file docs/套用-2026-11-08-薪資津貼勞退.sql
--   --seed docs/test/replay-seed-2026-11-08-overtime-base.sql docs/套用-2026-11-08-加班基數.sql
--   --verify docs/驗證-2026-11-08-加班基數.sql --verify docs/test/replay-verify-2026-11-08-overtime-base.sql`
--   在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

ALTER TABLE public.employee_fixed_allowances ADD COLUMN IF NOT EXISTS overtime_base boolean NOT NULL DEFAULT true;

-- ── 還原（會丟掉 HR 設定的「不計入」）──
-- ALTER TABLE public.employee_fixed_allowances DROP COLUMN IF EXISTS overtime_base;

COMMIT;
