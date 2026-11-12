-- 2026-11-12 刪除打錯（key 錯）的專案（migration 0095 ＝ sql/0085）：projects 軟刪除欄位＋序號唯一索引改 partial。
-- 前提：已套 0094（sql/0084，docs/套用-2026-11-12-專案序號手動.sql）。
-- 只有 DDL（ADD COLUMN IF NOT EXISTS／FK 存在才略過／DROP INDEX IF EXISTS 後以 WHERE deleted_at IS NULL 重建）、
--   冪等、包在交易內；不動任何資料列。重建索引期間短暫鎖 projects（13～15 列，瞬間完成）。
-- 套用後跑 docs/驗證-2026-11-12-刪除專案.sql（正式庫只跑第 1 段唯讀檢查）。
-- 必須「先套 DDL、再推程式」：新版 API 的專案查詢都帶 deleted_at is null，欄位不存在會 500。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --base-file docs/套用-2026-11-08-薪資津貼勞退.sql
--   --base-file docs/套用-2026-11-08-加班基數.sql --base-file docs/套用-2026-11-10-薪資投保歷程.sql
--   --base-file docs/套用-2026-11-10-副委託事務所與發票.sql --base-file docs/套用-2026-11-10-申請單版本.sql
--   --base-file docs/套用-2026-11-11-每期獎金分潤.sql --base-file docs/套用-2026-11-11-每期獎金分潤-修正.sql
--   --base-file docs/套用-2026-11-11-每期獎金分潤-修正2.sql --base-file docs/套用-2026-11-12-專案序號手動.sql
--   docs/套用-2026-11-12-刪除專案.sql --verify docs/驗證-2026-11-12-刪除專案.sql` 在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS deleted_by_emp_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_deleted_by_emp_id_employees_id_fk') THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_deleted_by_emp_id_employees_id_fk
      FOREIGN KEY (deleted_by_emp_id) REFERENCES public.employees(id) ON DELETE SET NULL;
  END IF;
END $$;
DROP INDEX IF EXISTS public.projects_tenant_code_uq;
CREATE UNIQUE INDEX projects_tenant_code_uq ON public.projects (tenant_id, code) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS public.projects_tenant_code_ci_uq;
CREATE UNIQUE INDEX projects_tenant_code_ci_uq ON public.projects (tenant_id, lower(code)) WHERE deleted_at IS NULL;

COMMIT;
