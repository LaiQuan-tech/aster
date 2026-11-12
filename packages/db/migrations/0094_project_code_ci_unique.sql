-- 2026-11-12 專案序號可手動調整（PATCH /projects/:id/code）：同租戶序號「大小寫不敏感」不可重複。
--   新增 unique index projects_tenant_code_ci_uq ON projects (tenant_id, lower(code))。
--   原本的 projects_tenant_code_uq（大小寫敏感）保留不動。code 為 null 的列不受限制（與 Postgres 唯一索引一致）。
--   API 撞到此索引（23505）一律回 409 project_no_taken「此序號已被其他專案使用」。
-- 前提：正式庫既有序號大小寫不敏感無重複（2026-11-12 唯讀檢查：13 筆、0 組重複）。
-- 不動任何資料列；可重跑（IF NOT EXISTS）。
CREATE UNIQUE INDEX IF NOT EXISTS projects_tenant_code_ci_uq ON public.projects (tenant_id, lower(code));
