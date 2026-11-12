-- 2026-11-12 刪除打錯（key 錯）的專案：軟刪除＋序號釋放（＝ sql/0085）。
--   projects 新增 deleted_at（timestamptz）、deleted_by_emp_id（uuid → employees，ON DELETE SET NULL；命名沿用
--   project_billings／contracts 的 deleted_by_emp_id 慣例）。API 一律排除 deleted_at 非空的列（DELETE /projects/:id）。
--   兩個序號唯一索引改為只對「未刪除」的列生效（partial index WHERE deleted_at IS NULL），刪掉的錯誤序號可以重新使用：
--     projects_tenant_code_uq     (tenant_id, code)
--     projects_tenant_code_ci_uq  (tenant_id, lower(code))
--   兩個索引都是單純 unique index（不是 constraint、沒有 ON CONFLICT 依賴；2026-11-12 唯讀檢查）。
--   audit_all 觸發器已掛在 projects 上：軟刪除是 UPDATE，會自動寫 audit_logs。
-- 不動任何資料列；可重跑（IF NOT EXISTS／DROP INDEX IF EXISTS 後重建）。
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
